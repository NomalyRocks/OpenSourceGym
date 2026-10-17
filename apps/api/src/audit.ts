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
