import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import { ensureIndexes } from "../indexes.js";
import {
  backfillLegacyUserPhones,
  findActivePhoneConflictUserIds,
  hasActivePhoneConflict,
  PHONE_CONFLICT_COLLECTION,
  reconcilePhoneConflictsAfterUserChange,
} from "../phoneBackfill.js";
import { normalizePhoneToE164 } from "../phone.js";

const mongoUri = process.env.TEST_MONGODB_URI;

function errorCode(reason: unknown): unknown {
  if (typeof reason !== "object" || reason === null || !("code" in reason)) {
    return undefined;
  }
  return reason.code;
}

test(
  "phone backfill preserves duplicates and unique indexes prevent races",
  { skip: mongoUri ? false : "TEST_MONGODB_URI is not defined" },
  async () => {
    const client = new MongoClient(mongoUri!);
    const database = client.db(
      `opengym_phone_${randomUUID().replaceAll("-", "")}`,
    );
    const users = database.collection("user");
    const conflicts = database.collection<{
      _id: string;
      active: boolean;
      users: Array<{ userId: string; phone: string }>;
      firstDetectedAt: Date;
    }>(PHONE_CONFLICT_COLLECTION);
    const uniqueId = new ObjectId();
    const duplicateAId = new ObjectId();
    const duplicateBId = new ObjectId();
    const invalidId = new ObjectId();
    const seedId = new ObjectId();

    try {
      await client.connect();
      await users.insertMany([
        {
          _id: uniqueId,
          email: "unique@example.com",
          phone: "0530 123 45 67",
          phoneE164: "+905551111111",
        },
        {
          _id: duplicateAId,
          email: "duplicate-a@example.com",
          phone: "5321234567",
          phoneE164: "+905321234567",
        },
        {
          _id: duplicateBId,
          email: "duplicate-b@example.com",
          phone: "+90 532 123 45 67",
          phoneE164: "+905321234567",
        },
        { _id: invalidId, email: "invalid@example.com", phone: "bozuk" },
        { _id: seedId, email: "admin@opengym.local", phone: "-" },
      ]);

      await backfillLegacyUserPhones(database);

      const unique = await users.findOne({ _id: uniqueId });
      assert.equal(unique?.phone, "+905301234567");
      assert.equal(unique?.phoneE164, "+905301234567");

      const duplicateA = await users.findOne({ _id: duplicateAId });
      const duplicateB = await users.findOne({ _id: duplicateBId });
      assert.equal(duplicateA?.phone, "5321234567");
      assert.equal(duplicateA?.phoneE164, undefined);
      assert.equal(duplicateB?.phone, "+90 532 123 45 67");
      assert.equal(duplicateB?.phoneE164, undefined);
      assert.equal(
        (await users.findOne({ _id: invalidId }))?.phoneE164,
        undefined,
      );
      assert.equal(
        (await users.findOne({ _id: seedId }))?.phoneE164,
        undefined,
      );

      const conflictPhone = "+905321234567";
      assert.equal(await hasActivePhoneConflict(conflictPhone, database), true);
      const conflict = await conflicts.findOne({ _id: conflictPhone });
      assert.ok(conflict);
      assert.equal(conflict.active, true);
      assert.deepEqual(
        conflict.users.map((user: { userId: string }) => user.userId),
        [duplicateAId.toString(), duplicateBId.toString()].sort(),
      );
      assert.ok(conflict.firstDetectedAt instanceof Date);
      assert.deepEqual(
        (await findActivePhoneConflictUserIds(conflictPhone, database)).map(
          (userId) => userId.toString(),
        ),
        [duplicateAId.toString(), duplicateBId.toString()].sort(),
      );

      await ensureIndexes(database);
      const phoneIndex = (await users.indexes()).find(
        (index) => index.name === "user_phone_e164_unique",
      );
      assert.equal(phoneIndex?.unique, true);
      assert.deepEqual(phoneIndex?.partialFilterExpression, {
        phoneE164: { $type: "string" },
      });

      const firstDetectedAt = conflict.firstDetectedAt;
      await backfillLegacyUserPhones(database);
      assert.equal(
        (
          await conflicts.findOne({ _id: conflictPhone })
        )?.firstDetectedAt?.getTime(),
        firstDetectedAt.getTime(),
      );
      assert.equal(
        (await users.findOne({ _id: duplicateAId }))?.phoneE164,
        undefined,
      );
      assert.equal(
        (await users.findOne({ _id: duplicateBId }))?.phoneE164,
        undefined,
      );

      await users.deleteOne({ _id: duplicateBId });
      await reconcilePhoneConflictsAfterUserChange(
        duplicateBId.toString(),
        database,
      );
      assert.equal(
        (await users.findOne({ _id: duplicateAId }))?.phoneE164,
        conflictPhone,
      );
      assert.equal(await conflicts.findOne({ _id: conflictPhone }), null);
      assert.equal(
        await hasActivePhoneConflict(conflictPhone, database),
        false,
      );

      const concurrentPhoneA = normalizePhoneToE164("0540 123 45 67");
      const concurrentPhoneB = normalizePhoneToE164("+90 540 123 45 67");
      assert.equal(concurrentPhoneA, concurrentPhoneB);
      const inserts = await Promise.allSettled([
        users.insertOne({
          phone: concurrentPhoneA,
          phoneE164: concurrentPhoneA,
        }),
        users.insertOne({
          phone: concurrentPhoneB,
          phoneE164: concurrentPhoneB,
        }),
      ]);
      assert.equal(
        inserts.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const rejected = inserts.find((result) => result.status === "rejected");
      assert.ok(rejected && rejected.status === "rejected");
      assert.equal(errorCode(rejected.reason), 11000);
    } finally {
      await database.dropDatabase().catch(() => undefined);
      await client.close();
    }
  },
);
