import type { ObjectId } from "mongodb";
import type { Role } from "@opengym/shared";
import { logAudit } from "./audit.js";
import { canAccessGym } from "./gyms.js";
import type { SessionUser } from "./middleware.js";
import { subscriptionCollection } from "./subscriptions.js";

/**
 * Gym scope of member controls (ban, freeze, deletion on behalf).
 *
 * Members are chain-wide, so there is no gym in the path. Instead a non-owner
 * may act on a member only if they have access to at least one gym that appears
 * on ANY of the member's subscription periods, past ones included, so a member
 * whose subscription expired can still be handled by their home gym. A member
 * with no periods at all belongs to nobody's gym: the owner only.
 */

/** Every gym on any of the member's periods, as hex strings. */
export async function listMemberGymIds(userId: ObjectId): Promise<string[]> {
  const ids = await subscriptionCollection().distinct("gymIds", { userId });
  return [...new Set(ids.map((id) => id.toHexString()))];
}

export function canManageMember(
  user: { role: Role; gymIds: readonly string[] },
  memberGymIds: readonly string[],
): boolean {
  if (user.role === "owner") return true;
  return memberGymIds.some((gymId) => canAccessGym(user, gymId));
}

/**
 * Gyms whose admins should see an action on this member in their audit list:
 * the gyms of the current and future periods, or of the latest period when none
 * is current or upcoming. `[null]` (a chain-level row) when there are no
 * periods.
 */
export async function listMemberAuditGymIds(
  userId: ObjectId,
  now = new Date(),
): Promise<(string | null)[]> {
  const collection = subscriptionCollection();
  let periods = await collection
    .find({ userId, endsAt: { $gte: now } }, { projection: { gymIds: 1 } })
    .toArray();
  if (periods.length === 0) {
    periods = await collection
      .find({ userId }, { projection: { gymIds: 1 } })
      .sort({ endsAt: -1, _id: -1 })
      .limit(1)
      .toArray();
  }
  const gymIds = new Set<string>();
  for (const period of periods) {
    for (const gymId of period.gymIds ?? []) gymIds.add(gymId.toHexString());
  }
  return gymIds.size > 0 ? [...gymIds] : [null];
}

/** Writes one audit row per gym of the member (see {@link listMemberAuditGymIds}). */
export async function logMemberAudit(
  actor: Pick<SessionUser, "id" | "email">,
  action: string,
  memberId: ObjectId,
  details?: Record<string, unknown>,
): Promise<void> {
  for (const gymId of await listMemberAuditGymIds(memberId)) {
    await logAudit(actor, action, memberId.toHexString(), details, gymId);
  }
}
