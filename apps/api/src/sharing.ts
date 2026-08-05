import { ObjectId } from "mongodb";
import type { SharingConfig, SharingSignalKind } from "@opengym/shared";
import {
  db,
  findGymSettings,
  sessionCollection,
  userCollection,
} from "./db.js";
import { redis } from "./redis.js";
import { logAudit } from "./audit.js";
import { revokeUserSessions } from "./sessions.js";

// Phase 6—account-sharing detection defaults (overridable by settings.sharing).
// This module MUST NOT import anything beyond sharing.ts, sessions.ts, audit.ts,
// and db/redis—it is called from auth.ts databaseHooks and must not create an
// import cycle back to auth.ts.
export const SHARING_DEFAULTS: SharingConfig = {
  memberMaxSessions: 2,
  staffMaxSessions: 5,
  signalThreshold: 3,
  signalWindowHours: 24,
  qrBlockHours: 24,
};

export const QR_BLOCK_KEY = (userId: string): string => `og:qr-block:${userId}`;
export const QR_LOC_KEY = (userId: string): string => `og:qr-loc:${userId}`;
export const FP_CHURN_KEY = (userId: string): string => `og:fp-churn:${userId}`;

// The optional "sharing" object in the singleton settings._id: "gym" document
// is shallow-merged over the defaults
export async function getSharingConfig(): Promise<SharingConfig> {
  const doc = await findGymSettings();
  return { ...SHARING_DEFAULTS, ...(doc?.sharing ?? {}) };
}

export async function isQrBlocked(userId: string): Promise<boolean> {
  return (await redis.exists(QR_BLOCK_KEY(userId))) === 1;
}

// audit_logs are retained indefinitely (sharing_signals have a 30-day TTL)—
// sensitive fields such as location go only to the TTL signal record, not audit
const AUDIT_OMIT_META_KEYS = new Set(["lat", "lng"]);

function redactMetaForAudit(
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  if (!meta) return {};
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!AUDIT_OMIT_META_KEYS.has(key)) redacted[key] = value;
  }
  return redacted;
}

// Records a suspected account-sharing signal; detection signals must never fail
// the request, so the entire body is wrapped in try/catch
export async function recordSharingSignal(
  actor: { id: string; email: string },
  kind: SharingSignalKind,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.collection("sharing_signals").insertOne({
      userId: new ObjectId(actor.id),
      kind,
      meta: meta ?? null,
      at: new Date(),
    });
    await logAudit(actor, "sharing-signal", actor.id, {
      kind,
      ...redactMetaForAudit(meta),
    });

    // Escalation: once the threshold number of signals accumulates in the window,
    // QR generation is blocked automatically and all sessions are revoked
    const cfg = await getSharingConfig();
    const since = new Date(Date.now() - cfg.signalWindowHours * 3600_000);
    const signalCount = await db.collection("sharing_signals").countDocuments({
      userId: new ObjectId(actor.id),
      at: { $gte: since },
    });
    if (signalCount >= cfg.signalThreshold) {
      const acquired = await redis.set(QR_BLOCK_KEY(actor.id), "1", {
        condition: "NX",
        expiration: { type: "EX", value: cfg.qrBlockHours * 3600 },
      });
      // Revoke sessions and audit the event only if this call established the
      // block for the FIRST TIME (NX succeeded); otherwise every new signal in
      // the same window would trigger it repeatedly
      if (acquired === "OK") {
        await revokeUserSessions(actor.id);
        await logAudit(actor, "account-sharing-blocked", actor.id, {
          signalCount,
          windowHours: cfg.signalWindowHours,
          blockHours: cfg.qrBlockHours,
        });
      }
    }
  } catch (err) {
    console.error("recordSharingSignal failed:", err);
  }
}

// Called after session creation (session.create.after): enforces the concurrent
// session cap (silently evicting the oldest session) and detects fingerprint
// churn. Because it runs from an auth hook, it must NEVER throw or it breaks sign-in.
export async function enforceSessionPolicy(session: {
  userId: string;
}): Promise<void> {
  try {
    const cfg = await getSharingConfig();
    const userDoc = await userCollection().findOne({
      _id: new ObjectId(session.userId),
    });
    if (!userDoc) return;
    const role = userDoc.role ?? "member";
    const cap =
      role === "member" ? cfg.memberMaxSessions : cfg.staffMaxSessions;

    const sessions = await sessionCollection()
      .find({ userId: new ObjectId(session.userId) })
      .sort({ createdAt: -1 })
      .toArray();

    // Check churn FIRST (before eviction) so soon-to-be-evicted sessions count
    // toward fingerprints. The threshold is relative to the role-based session
    // cap—a fixed number would flag legitimate multi-device use by staff/admins
    // (cap 5) as a false positive; a fixed 3 suited members with cap 2, not staff
    const distinctFingerprints = new Set(
      sessions
        .map((s) => s.deviceFingerprint)
        .filter((fp): fp is string => typeof fp === "string" && fp.length > 0),
    );
    if (distinctFingerprints.size > cap) {
      const churnKey = FP_CHURN_KEY(session.userId);
      const acquired = await redis.set(churnKey, "1", {
        condition: "NX",
        expiration: { type: "EX", value: 3600 },
      });
      if (acquired === "OK") {
        await recordSharingSignal(
          { id: session.userId, email: userDoc.email },
          "fingerprint-churn",
          { distinctFingerprints: distinctFingerprints.size },
        );
      }
    }

    // Eviction: excess sessions over capacity are the oldest ones (sessions are
    // sorted by createdAt descending, and those from the cap index onward remain)
    if (sessions.length > cap) {
      const excess = sessions.slice(cap);
      const excessIds = excess.map((s) => s._id);
      for (const doc of excess) {
        if (doc.token) {
          await redis.del(doc.token).catch(console.error);
        }
      }
      await sessionCollection().deleteMany({ _id: { $in: excessIds } });

      // REWRITE the "active-sessions-<userId>" list with surviving sessions; do
      // not delete it. BetterAuth's session management (listSessions,
      // deleteUserSessions, revokeSessionsOnPasswordReset) references this list,
      // and deleting it makes surviving Redis session records invisible (orphaned)
      // to BetterAuth. The input shape exactly matches BetterAuth's internal adapter:
      // [{token, expiresAt(ms)}], sorted by expiresAt ascending, with key TTL
      // based on the latest-expiring session
      const now = Date.now();
      const survivors = sessions
        .slice(0, cap)
        .map((doc) => ({
          token: doc.token ?? "",
          expiresAt:
            doc.expiresAt instanceof Date ? doc.expiresAt.getTime() : 0,
        }))
        .filter((entry) => entry.token && entry.expiresAt > now)
        .sort((a, b) => a.expiresAt - b.expiresAt);
      const listKey = `active-sessions-${session.userId}`;
      if (survivors.length > 0) {
        const lastSurvivor = survivors[survivors.length - 1]!;
        const ttlSeconds = Math.floor((lastSurvivor.expiresAt - now) / 1000);
        await redis
          .set(listKey, JSON.stringify(survivors), {
            expiration: { type: "EX", value: ttlSeconds },
          })
          .catch(console.error);
      } else {
        await redis.del(listKey).catch(console.error);
      }
    }
  } catch (err) {
    console.error("enforceSessionPolicy failed:", err);
  }
}
