import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ObjectId } from "mongodb";
import type {
  ApiErrorResponse,
  InactiveMemberRow,
  LapsedMemberRow,
  LostMembersPage,
} from "@opengym/shared";

const mongoUri = process.env.TEST_MONGODB_URI;
const redisUri = process.env.TEST_REDIS_URL;
const DAY = 86_400_000;

test(
  "lost-member reports: visits, renewals, pagination, exports and gym scope",
  {
    skip:
      mongoUri && redisUri
        ? false
        : "TEST_MONGODB_URI and TEST_REDIS_URL are not defined",
  },
  async (t) => {
    const databaseName = `opengym_lost_${randomUUID().replaceAll("-", "")}`;
    const isolatedRedisUrl = new URL(process.env.TEST_REDIS_URL!);
    isolatedRedisUrl.pathname = "/0";
    process.env.MONGODB_URI = `${mongoUri!}/${databaseName}`;
    process.env.REDIS_URL = isolatedRedisUrl.toString();
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET =
      "lost-members-integration-test-secret-at-least-32-characters";
    delete process.env.SMTP_HOST;

    const [
      { default: express },
      { createServer },
      { auth },
      { db, mongoClient },
      { connectRedis, redis },
      { gymReportsRouter },
      reports,
      lost,
    ] = await Promise.all([
      import("express"),
      import("node:http"),
      import("../../src/auth/auth.js"),
      import("../../src/core/db.js"),
      import("../../src/core/redis.js"),
      import("../../src/features/reports/router.js"),
      import("../../src/features/reports/reports.js"),
      import("../../src/features/reports/lostMembers.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use("/api/admin/gyms/:gymId/reports", gymReportsRouter);
    const server = createServer(app);
    let base = "";
    let counter = 0;
    async function actor(role: "owner" | "admin" | "staff", gymIds: string[]) {
      counter++;
      const email = `actor${counter}@example.com`;
      const signup = await auth.api.signUpEmail({
        body: {
          email,
          password: "test-password-1234",
          name: "Report Tester",
          firstName: "Report",
          lastName: "Tester",
          phone: `530000000${counter}`,
          dataProcessingAccepted: true,
          privacyAccepted: true,
        },
      });
      await db
        .collection("user")
        .updateOne(
          { _id: new ObjectId(signup.user.id) },
          { $set: { role, gymIds, emailVerified: true } },
        );
      const signedIn = await auth.api.signInEmail({
        body: { email, password: "test-password-1234" },
        returnHeaders: true,
      });
      const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      return cookie;
    }
    async function get<T>(cookie: string, path: string) {
      const response = await fetch(`${base}${path}`, { headers: { cookie } });
      return { status: response.status, body: (await response.json()) as T };
    }
    try {
      await mongoClient.connect();
      await connectRedis();
      await redis.flushDb();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/gyms`;
      const now = new Date();
      const at = (days: number) => new Date(now.getTime() + days * DAY);
      const gymA = new ObjectId();
      const gymB = new ObjectId();
      const A = gymA.toHexString();
      const B = gymB.toHexString();
      await db.collection("gyms").insertMany([
        {
          _id: gymA,
          name: "Gym A",
          active: true,
          autoExitHours: 4,
          createdAt: now,
        },
        {
          _id: gymB,
          name: "Gym B",
          active: true,
          autoExitHours: 4,
          createdAt: now,
        },
      ]);
      const owner = await actor("owner", []);
      const admin = await actor("admin", [A]);
      const staff = await actor("staff", [A]);
      const otherStaff = await actor("staff", [B]);
      async function period(
        userId: ObjectId,
        end: number,
        gym = gymA,
        start = -90,
      ) {
        await db.collection("subscriptions").insertOne({
          userId,
          gymIds: [gym],
          startsAt: at(start),
          endsAt: at(end),
          createdAt: at(-90),
          createdBy: "test",
          note: null,
        });
      }
      async function member(name: string, end = 30) {
        const id = new ObjectId();
        await db.collection("user").insertOne({
          _id: id,
          name: `${name} Tester`,
          firstName: name,
          lastName: "Tester",
          email: `${name.toLowerCase()}@example.com`,
          phone: "5551234567",
          role: "member",
          createdAt: at(-100),
        });
        await period(id, end);
        return id;
      }
      async function visit(
        userId: ObjectId | null,
        day: number,
        extra: Record<string, unknown> = {},
      ) {
        await db.collection("entry_events").insertOne({
          gymId: A,
          userId: userId?.toHexString() ?? null,
          allowed: true,
          direction: "in",
          at: at(day),
          ...extra,
        });
      }
      async function freeze(userId: ObjectId) {
        await db.collection("subscription_freezes").insertOne({
          userId,
          endedAt: null,
          startedAt: at(-1),
          maxDays: 30,
          startedBy: "test",
        });
      }
      const recent = await member("Recent");
      const old = await member("Old");
      const oldTie = await member("OldTie");
      const never = await member("Never");
      const refused = await member("Refused");
      const elsewhere = await member("Elsewhere");
      const exitOnly = await member("ExitOnly");
      const frozen = await member("Frozen");
      const expired = await member("Expired", -4);
      const renewed = await member("Renewed", -3);
      const frozenExpired = await member("FrozenExpired", -1);
      const olderLapsed = await member("OlderLapsed", -10);
      await member("OutsideRange", -40);
      await freeze(frozen);
      await freeze(frozenExpired);
      await period(renewed, 40, gymA, 10); // A scheduled renewal also excludes a member.
      await period(old, 40); // Overlapping periods must not duplicate the member.
      await visit(recent, -1);
      await visit(old, -40);
      await visit(oldTie, -40);
      await visit(old, -1, { allowed: false });
      await visit(refused, -1, { allowed: false });
      await visit(elsewhere, -1, { gymId: B });
      await visit(exitOnly, -1, { direction: "out" });
      await visit(null, -1);
      await visit(expired, -20);
      await visit(expired, -1, { allowed: false });
      const range = { from: at(-30), to: now };
      const rangeQuery = new URLSearchParams({
        from: range.from.toISOString(),
        to: now.toISOString(),
      });
      const path = (suffix: string) => `/${A}/reports/${suffix}`;
      const inactiveParams = { gymId: A, days: 14, now, limit: 100 };

      await t.test(
        "inactive: active old visits and never visited only, with never visited first",
        async () => {
          const page = await lost.listInactiveMembers(inactiveParams, db);
          assert.deepEqual(
            page.items.map((row) => row.userId),
            [never, refused, elsewhere, exitOnly, old, oldTie].map((id) =>
              id.toHexString(),
            ),
          );
          assert.equal(page.total, 6);
          assert.equal(page.items[0]!.lastEntryAt, null);
          assert.equal(page.items[0]!.daysSinceLastEntry, null);
          const oldRow = page.items.find(
            (row) => row.userId === old.toHexString(),
          )!;
          assert.equal(oldRow.lastEntryAt, at(-40).toISOString());
          assert.equal(oldRow.daysSinceLastEntry, 40);
          assert.equal(oldRow.periodEndsAt, at(40).toISOString());
          assert.equal(oldRow.name, "Old Tester");
          assert.equal(
            (
              await lost.listInactiveMembers(
                { ...inactiveParams, days: 60 },
                db,
              )
            ).total,
            4,
          );
          assert.equal(
            (
              await get<LostMembersPage<InactiveMemberRow>>(
                staff,
                path("inactive-members"),
              )
            ).status,
            200,
          );
        },
      );
      await t.test(
        "inactive: exact day cutoff and active-period boundaries",
        async () => {
          await visit(recent, -14);
          // Recent already has a later visit; use a dedicated boundary member.
          const boundary = await member("Boundary", 0);
          await visit(boundary, -14);
          assert.ok(
            !(await lost.listInactiveMembers(inactiveParams, db)).items.some(
              (row) => row.userId === boundary.toHexString(),
            ),
          );
          const later = await lost.listInactiveMembers(
            { ...inactiveParams, now: new Date(now.getTime() + 1) },
            db,
          );
          assert.ok(
            !later.items.some((row) => row.userId === boundary.toHexString()),
            "expired at the new instant",
          );
          await period(boundary, 1);
          assert.ok(
            (
              await lost.listInactiveMembers(
                { ...inactiveParams, now: new Date(now.getTime() + 1) },
                db,
              )
            ).items.some((row) => row.userId === boundary.toHexString()),
            "older than threshold by one millisecond",
          );
          await db.collection("subscriptions").deleteMany({ userId: boundary });
        },
      );
      await t.test(
        "pagination crosses never/dated rows and timestamp ties without repeats; total is not page size",
        async () => {
          const expected = (
            await lost.listInactiveMembers(inactiveParams, db)
          ).items.map((row) => row.userId);
          const ids: string[] = [];
          let cursor: string | undefined;
          do {
            const page = await lost.listInactiveMembers(
              { ...inactiveParams, limit: 1, cursor },
              db,
            );
            assert.equal(page.total, 6);
            ids.push(...page.items.map((row) => row.userId));
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          assert.deepEqual(ids, expected);
          const numbered = await get<LostMembersPage<InactiveMemberRow>>(
            owner,
            path("inactive-members?page=2&limit=2"),
          );
          assert.deepEqual(
            numbered.body.items.map((row) => row.userId),
            expected.slice(2, 4),
          );
          assert.equal(numbered.body.total, 6);
        },
      );
      await t.test(
        "lapsed total equals summary; later periods and open freezes are excluded",
        async () => {
          const summary = await reports.buildReportSummary(range, A, db, now);
          const page = await lost.listLapsedMembers(
            { ...range, gymId: A, limit: 1 },
            db,
          );
          assert.equal(page.total, summary.lapsedMembers);
          assert.equal(page.total, 2);
          assert.equal(page.items[0]!.userId, expired.toHexString());
          assert.equal(page.items[0]!.endedAt, at(-4).toISOString());
          assert.equal(page.items[0]!.lastEntryAt, at(-20).toISOString());
          assert.ok(page.nextCursor);
          const next = await lost.listLapsedMembers(
            { ...range, gymId: A, limit: 1, cursor: page.nextCursor },
            db,
          );
          assert.equal(next.items[0]!.userId, olderLapsed.toHexString());
          assert.equal(next.items[0]!.lastEntryAt, null);
          assert.equal(next.total, 2);
          assert.equal(next.nextCursor, null);
          // A renewal at a different gym does not renew this gym's membership.
          await period(expired, 30, gymB);
          const http = await get<LostMembersPage<LapsedMemberRow>>(
            staff,
            path(`lapsed-members?${rangeQuery}`),
          );
          assert.equal(http.status, 200);
          assert.equal(http.body.total, summary.lapsedMembers);
        },
      );
      await t.test(
        "invalid days, pagination and ranges return report validation errors",
        async () => {
          for (const days of ["0", "366", "1.5", "abc", ""]) {
            const result = await get<ApiErrorResponse>(
              owner,
              path(`inactive-members?days=${days}`),
            );
            assert.equal(result.status, 400);
            assert.equal(result.body.code, "INVALID_REQUEST");
          }
          for (const route of ["inactive-members", "lapsed-members"]) {
            const result = await get<ApiErrorResponse>(
              owner,
              path(`${route}?cursor=invalid`),
            );
            assert.equal(result.status, 400);
            assert.equal(result.body.code, "INVALID_REQUEST");
          }
          assert.equal(
            (
              await get<ApiErrorResponse>(
                owner,
                path("lapsed-members?from=invalid"),
              )
            ).body.code,
            "INVALID_REPORT_RANGE",
          );
        },
      );
      await t.test(
        "gym scope is enforced and staff cannot export either dataset",
        async () => {
          for (const route of ["inactive-members", "lapsed-members"]) {
            const denied = await get<ApiErrorResponse>(otherStaff, path(route));
            assert.equal(denied.status, 403);
            assert.equal(denied.body.code, "GYM_OUT_OF_SCOPE");
          }
          for (const dataset of ["inactive", "lapsed"]) {
            assert.equal(
              (
                await get<ApiErrorResponse>(
                  staff,
                  path(`export?dataset=${dataset}`),
                )
              ).status,
              403,
            );
          }
        },
      );
      await t.test(
        "CSV matches list thresholds and ranges, includes gym and is audited",
        async () => {
          for (const cookie of [owner, admin]) {
            for (const dataset of ["inactive", "lapsed"]) {
              const response = await fetch(
                `${base}${path(`export?dataset=${dataset}&days=60&${rangeQuery}`)}`,
                { headers: { cookie } },
              );
              assert.equal(response.status, 200);
              assert.match(response.headers.get("content-type")!, /text\/csv/);
              const lines = (await response.text()).trim().split(/\r?\n/);
              assert.match(lines[0]!, /^gymId,userId,name,email,phone,/);
              assert.equal(lines.length - 1, dataset === "inactive" ? 4 : 2);
              assert.ok(
                lines.slice(1).every((line) => line.startsWith(`${A},`)),
              );
              assert.ok(
                !lines.some((line) => line.includes("Old Tester")),
                "inactive honours days=60",
              );
            }
          }
          const audits = await db
            .collection("audit_logs")
            .find({ action: "data-exported", gymId: A })
            .toArray();
          assert.equal(audits.length, 4);
          assert.deepEqual(
            audits.map((row) => row.details.dataset),
            ["inactive", "lapsed", "inactive", "lapsed"],
          );
          assert.equal(audits[0]!.details.days, 60);
          assert.equal(audits[1]!.details.from, range.from.toISOString());
        },
      );
    } finally {
      await db.dropDatabase().catch(() => undefined);
      await redis.flushDb().catch(() => undefined);
      server.close();
      await redis.quit().catch(() => undefined);
      await mongoClient.close();
    }
  },
);
