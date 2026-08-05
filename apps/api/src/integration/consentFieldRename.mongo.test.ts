import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import { renameLegacyConsentFields } from "../consentFieldRename.js";

const mongoUri = process.env.TEST_MONGODB_URI;

test(
  "Consent field migration moves legacy kvkk* fields to neutral names and the second run is a no-op",
  { skip: mongoUri ? false : "TEST_MONGODB_URI is not defined" },
  async () => {
    const client = new MongoClient(mongoUri!);
    const database = client.db(
      `opengym_consent_${randomUUID().replaceAll("-", "")}`,
    );
    const users = database.collection("user");
    const markers = database.collection<{ _id: string; renamedCount: number }>(
      "migration_markers",
    );

    try {
      await client.connect();

      const legacyId = new ObjectId();
      const acceptedAt = new Date("2026-01-02T03:04:05.000Z");
      await users.insertOne({
        _id: legacyId,
        email: "legacy@example.com",
        kvkkAccepted: true,
        kvkkAcceptedAt: acceptedAt,
        privacyAccepted: true,
      });
      // A member saved with the new names must not be affected by the migration.
      const modernId = new ObjectId();
      await users.insertOne({
        _id: modernId,
        email: "modern@example.com",
        dataProcessingAccepted: true,
        dataProcessingAcceptedAt: acceptedAt,
        privacyAccepted: true,
      });

      const first = await renameLegacyConsentFields(database);
      assert.equal(first.skipped, false);
      assert.equal(first.renamedCount, 1);

      const migrated = await users.findOne({ _id: legacyId });
      assert.equal(migrated?.dataProcessingAccepted, true);
      assert.deepEqual(migrated?.dataProcessingAcceptedAt, acceptedAt);
      assert.equal("kvkkAccepted" in (migrated ?? {}), false);
      assert.equal("kvkkAcceptedAt" in (migrated ?? {}), false);

      const untouched = await users.findOne({ _id: modernId });
      assert.equal(untouched?.dataProcessingAccepted, true);

      const marker = await markers.findOne({ _id: "consent-field-rename-v1" });
      assert.equal(marker?.renamedCount, 1);

      // After the marker is written, the second run skips without scanning.
      const second = await renameLegacyConsentFields(database);
      assert.equal(second.skipped, true);
      assert.equal(second.renamedCount, 1);
    } finally {
      await database.dropDatabase().catch(() => undefined);
      await client.close();
    }
  },
);
