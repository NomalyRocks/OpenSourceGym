import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ObjectId } from "mongodb";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;
const DAY = 86_400_000;

test(
  "logMemberAudit writes one audit row per gym of the member's periods, gymId set",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async () => {
    const databaseName = `opengym_memberaudit_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(redisUri!);
    isolatedRedisUrl.pathname = "/10";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "member-audit-integration-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;

    const [{ db, mongoClient }, { logMemberAudit }, { logAuditPerGym }] =
      await Promise.all([
        import("../db.js"),
        import("../memberScope.js"),
        import("../audit.js"),
      ]);

    try {
      await mongoClient.connect();
      const now = Date.now();
      const gymA = new ObjectId();
      const gymB = new ObjectId();
      const gymPast = new ObjectId();
      const member = new ObjectId();
      const loner = new ObjectId();
      await db.collection("subscriptions").insertMany([
        {
          userId: member,
          gymIds: [gymPast],
          startsAt: new Date(now - 30 * DAY),
          endsAt: new Date(now - 10 * DAY),
        },
        {
          userId: member,
          gymIds: [gymA],
          startsAt: new Date(now - DAY),
          endsAt: new Date(now + DAY),
        },
        {
          userId: member,
          gymIds: [gymB],
          startsAt: new Date(now + DAY),
          endsAt: new Date(now + 2 * DAY),
        },
      ] as never);
      const actor = { id: member.toHexString(), email: "m@example.com" };

      await logMemberAudit(actor, "subscription-frozen", member, {
        selfService: true,
      });
      const rows = await db
        .collection("audit_logs")
        .find({ action: "subscription-frozen" })
        .toArray();
      assert.deepEqual(rows.map((r) => r.gymId).sort(), [
        gymA.toHexString(),
        gymB.toHexString(),
      ]);
      assert.ok(rows.every((r) => r.targetId === member.toHexString()));

      await logMemberAudit(actor, "subscription-unfrozen", loner);
      const chainRows = await db
        .collection("audit_logs")
        .find({ action: "subscription-unfrozen" })
        .toArray();
      assert.equal(chainRows.length, 1);
      assert.equal(chainRows[0]?.gymId, null);

      // An admin acting through a past period's gym also gets a row for it,
      // and a gym already covered is not written twice.
      const gymsOf = async (action: string) =>
        (await db.collection("audit_logs").find({ action }).toArray())
          .map((r) => r.gymId)
          .sort();
      await logMemberAudit(
        { ...actor, role: "admin", gymIds: [gymPast.toHexString()] },
        "member-banned",
        member,
      );
      assert.deepEqual(
        await gymsOf("member-banned"),
        [gymA, gymB, gymPast].map((g) => g.toHexString()).sort(),
      );
      await logMemberAudit(
        { ...actor, role: "staff", gymIds: [gymA.toHexString()] },
        "member-unbanned",
        member,
      );
      assert.deepEqual(
        await gymsOf("member-unbanned"),
        [gymA, gymB].map((g) => g.toHexString()).sort(),
      );

      await logAuditPerGym(actor, "per-gym", "t", undefined, ["a", "a", null]);
      assert.deepEqual(await gymsOf("per-gym"), ["a"]);
      await logAuditPerGym(actor, "per-gym-none", "t", undefined, [null]);
      assert.deepEqual(await gymsOf("per-gym-none"), [null]);
    } finally {
      await db.dropDatabase().catch(() => undefined);
      await mongoClient.close();
    }
  },
);
