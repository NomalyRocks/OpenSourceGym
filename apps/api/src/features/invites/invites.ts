import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ObjectId, type Filter } from "mongodb";
import type { MemberInvite } from "@opengym/shared";
import { db, userCollection } from "../../core/db.js";
import { acquireLock, redis, releaseLock } from "../../core/redis.js";
import { createAuthSecondaryStorage } from "../../auth/authStorage.js";

export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_RESEND_INTERVAL_MS = 60_000;
export const INVITE_RESEND_LIMIT = 5;
export const INVITE_ACCEPTING_TIMEOUT_MS = 2 * 60_000;

export interface MemberInviteDocument {
  _id: ObjectId;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  gymId: string;
  tokenHash: string;
  expiresAt: Date;
  createdBy: string;
  createdAt: Date;
  resentAt: Date | null;
  resendCount: number;
  acceptingAt?: Date | null;
}

export const memberInvites = () =>
  db.collection<MemberInviteDocument>("member_invites");

export function availableInviteClaim(now: Date): Filter<MemberInviteDocument> {
  return {
    $or: [
      { acceptingAt: null },
      { acceptingAt: { $exists: false } },
      {
        acceptingAt: {
          $lt: new Date(now.getTime() - INVITE_ACCEPTING_TIMEOUT_MS),
        },
      },
    ],
  };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

export function inviteResendWaitMs(
  invite: MemberInviteDocument,
  now: Date,
): number {
  return Math.max(
    0,
    INVITE_RESEND_INTERVAL_MS -
      (now.getTime() - (invite.resentAt ?? invite.createdAt).getTime()),
  );
}

export async function toMemberInvite(
  invite: MemberInviteDocument,
): Promise<MemberInvite> {
  const creator = ObjectId.isValid(invite.createdBy)
    ? await userCollection().findOne(
        { _id: new ObjectId(invite.createdBy) },
        { projection: { name: 1 } },
      )
    : null;
  return {
    id: invite._id.toHexString(),
    email: invite.email,
    firstName: invite.firstName,
    lastName: invite.lastName,
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
    createdByName: creator?.name ?? "",
    resendCount: invite.resendCount,
  };
}

const counters = createAuthSecondaryStorage(redis);
export async function isInviteRateLimited(
  key: string,
  windowSeconds: number,
): Promise<boolean> {
  return (await counters.increment!(key, windowSeconds)) > 20;
}

/** Serialize competing admin mutations; acceptance uses an atomic Mongo claim. */
export async function withInviteLock<T>(
  tokenHash: string,
  action: () => Promise<T>,
): Promise<T | null> {
  const key = `og:lock:invite:${tokenHash}`;
  const owner = randomUUID();
  if (!(await acquireLock(key, owner, 60_000))) return null;
  try {
    return await action();
  } finally {
    await releaseLock(key, owner).catch((error: unknown) => {
      console.error("invite lock release failed:", error);
    });
  }
}
