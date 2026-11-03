import { db } from "./db.js";
import type { SessionUser } from "./middleware.js";

/**
 * Appends an audit record. `gymId` scopes the action to one gym; leave it out
 * (null) for chain-level actions such as gym CRUD or chain settings.
 */
export async function logAudit(
  actor: Pick<SessionUser, "id" | "email">,
  action: string,
  targetId?: string,
  details?: Record<string, unknown>,
  gymId?: string | null,
): Promise<void> {
  await db.collection("audit_logs").insertOne({
    actorId: actor.id,
    actorEmail: actor.email,
    action,
    targetId: targetId ?? null,
    details: details ?? null,
    gymId: gymId ?? null,
    at: new Date(),
  });
}

/**
 * Appends one audit record per gym, so each gym's admins see the action in
 * their own audit list. Duplicate and null entries are skipped; when no real
 * gym is left (an empty list, or only nulls) a single chain-level row
 * (`gymId: null`) is written instead.
 */
export async function logAuditPerGym(
  actor: Pick<SessionUser, "id" | "email">,
  action: string,
  targetId: string | undefined,
  details: Record<string, unknown> | undefined,
  gymIds: readonly (string | null)[],
): Promise<void> {
  const unique = [...new Set(gymIds.filter((id) => id !== null))];
  if (unique.length === 0) {
    await logAudit(actor, action, targetId, details, null);
    return;
  }
  for (const gymId of unique) {
    await logAudit(actor, action, targetId, details, gymId);
  }
}
