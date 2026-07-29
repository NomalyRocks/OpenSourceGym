import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import { ensureIndexes } from "../indexes.js";

const mongoUri = process.env.TEST_MONGODB_URI;

function errorCode(reason: unknown): unknown {
  if (typeof reason !== "object" || reason === null || !("code" in reason)) {
    return undefined;
  }
  return reason.code;
}

function createPendingDeletionRequest(
  userId: ObjectId,
  requestedAt: Date = new Date(),
): {
  _id: ObjectId;
  userId: ObjectId;
  email: string;
  name: string;
  requestedAt: Date;
  status: "pending" | "approved" | "rejected";
  resolvedAt: null;
  resolvedBy: unknown;
} {
  return {
    _id: new ObjectId(),
    userId,
    email: "test@example.com",
    name: "Test User",
    requestedAt,
    status: "pending" as const,
    resolvedAt: null,
    resolvedBy: undefined,
  };
}

test(
  "KVKK silme talebi: kısmi benzersiz indeks eşzamanlı mükerrer talebi engeller",
  { skip: mongoUri ? false : "TEST_MONGODB_URI tanımlı değil" },
  async () => {
    const client = new MongoClient(mongoUri!);
    const database = client.db(
      `opengym_deletion_${randomUUID().replaceAll("-", "")}`,
    );
    const deletionRequests = database.collection("deletion_requests");

    try {
      await client.connect();
      await ensureIndexes(database);

      const userId = new ObjectId();
      const concurrentRequests = await Promise.allSettled([
        deletionRequests.insertOne(createPendingDeletionRequest(userId)),
        deletionRequests.insertOne(createPendingDeletionRequest(userId)),
      ]);

      assert.equal(
        concurrentRequests.filter((result) => result.status === "fulfilled")
          .length,
        1,
      );
      const rejected = concurrentRequests.find(
        (result) => result.status === "rejected",
      );
      assert.ok(rejected && rejected.status === "rejected");
      assert.equal(errorCode(rejected.reason), 11000);

      const count = await deletionRequests.countDocuments({ userId });
      assert.equal(count, 1);

      // İndeks kısmi olmalı: sonuçlanmış talepler kullanıcı başına birden çok
      // kez birikebilmeli, yalnızca "pending" olanlar tekil olmalı.
      await deletionRequests.updateOne(
        { userId },
        { $set: { status: "rejected" } },
      );
      await deletionRequests.insertOne(
        createPendingDeletionRequest(userId, new Date("2026-01-03T10:00:00Z")),
      );
      await deletionRequests.insertOne({
        ...createPendingDeletionRequest(
          userId,
          new Date("2026-01-03T10:00:00Z"),
        ),
        status: "approved",
      });
      assert.equal(await deletionRequests.countDocuments({ userId }), 3);

      await deletionRequests.insertOne(
        createPendingDeletionRequest(
          new ObjectId(),
          new Date("2026-01-03T10:00:00Z"),
        ),
      );
      const finalCount = await deletionRequests.countDocuments({
        status: "pending",
      });
      assert.equal(finalCount, 2);
    } finally {
      await database.dropDatabase().catch(() => undefined);
      await client.close();
    }
  },
);

test(
  "KVKK silme talebi: indeks kurulmadan önceki mükerrerler en eskisi kalacak şekilde temizlenir",
  { skip: mongoUri ? false : "TEST_MONGODB_URI tanımlı değil" },
  async () => {
    const client = new MongoClient(mongoUri!);
    const database = client.db(
      `opengym_deletion_${randomUUID().replaceAll("-", "")}`,
    );
    const deletionRequests = database.collection("deletion_requests");

    try {
      await client.connect();

      const userId = new ObjectId();
      const date1 = new Date("2026-01-01T00:00:00.000Z");
      const date2 = new Date("2026-01-02T00:00:00.000Z");
      const date3 = new Date("2026-01-03T00:00:00.000Z");

      await deletionRequests.insertMany([
        createPendingDeletionRequest(userId, date3),
        createPendingDeletionRequest(userId, date1),
        createPendingDeletionRequest(userId, date2),
      ]);

      await ensureIndexes(database);

      const countAfterFirst = await deletionRequests.countDocuments({ userId });
      assert.equal(countAfterFirst, 1);

      const remaining = await deletionRequests.findOne({ userId });
      assert.ok(remaining);
      assert.equal(remaining!.requestedAt.getTime(), date1.getTime());

      await ensureIndexes(database);

      const countAfterSecond = await deletionRequests.countDocuments({
        userId,
      });
      assert.equal(countAfterSecond, 1);
    } finally {
      await database.dropDatabase().catch(() => undefined);
      await client.close();
    }
  },
);
