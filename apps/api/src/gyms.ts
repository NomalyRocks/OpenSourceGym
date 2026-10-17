import { ObjectId, type WithId } from "mongodb";
import type {
  Gym,
  GymRef,
  ReminderConfig,
  Role,
  SharingConfig,
} from "@opengym/shared";
import { gymCollection, toObjectId, type GymDocument } from "./db.js";
import { SHARING_DEFAULTS } from "./sharing.js";

export const DEFAULT_AUTO_EXIT_HOURS = 4;

export const REMINDER_DEFAULTS: ReminderConfig = {
  // Starts disabled: a gym must not send bulk email to members until the
  // operator explicitly enables it.
  enabled: false,
  daysBefore: [7, 1],
};

export type GymDoc = WithId<GymDocument>;

/** Accounts whose scope is the whole chain rather than a list of gyms. */
export function isChainWide(role: Role): boolean {
  return role === "owner";
}

/**
 * Whether the account may act inside the gym. Owner passes for every gym;
 * admin and staff only for gyms in their (freshly re-read) `gymIds`.
 */
export function canAccessGym(
  user: { role: Role; gymIds: readonly string[] },
  gymId: string,
): boolean {
  if (user.role === "owner") return true;
  if (user.role === "admin" || user.role === "staff") {
    return user.gymIds.includes(gymId);
  }
  return false;
}

export function findGym(gymId: string): Promise<GymDoc | null> {
  const oid = toObjectId(gymId);
  if (!oid) return Promise.resolve(null);
  return gymCollection().findOne({ _id: oid });
}

export function sharingConfigOf(gym: GymDocument | null): SharingConfig {
  return { ...SHARING_DEFAULTS, ...(gym?.sharing ?? {}) };
}

export function reminderConfigOf(gym: GymDocument | null): ReminderConfig {
  return { ...REMINDER_DEFAULTS, ...(gym?.reminders ?? {}) };
}

export function toGym(doc: GymDoc): Gym {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    location: doc.location ?? null,
    capacity: doc.capacity ?? null,
    autoExitHours: doc.autoExitHours ?? DEFAULT_AUTO_EXIT_HOURS,
    sharing: sharingConfigOf(doc),
    reminders: reminderConfigOf(doc),
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
  };
}

export function toGymRef(doc: GymDoc): GymRef {
  return { id: doc._id.toHexString(), name: doc.name, active: doc.active };
}

/** Every gym of the chain, oldest first. */
export function listAllGyms(): Promise<GymDoc[]> {
  return gymCollection().find({}).sort({ createdAt: 1, _id: 1 }).toArray();
}

export function listActiveGyms(): Promise<GymDoc[]> {
  return gymCollection()
    .find({ active: true })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
}

export function findGymsByIds(ids: readonly string[]): Promise<GymDoc[]> {
  const oids = ids
    .map((id) => toObjectId(id))
    .filter((id): id is ObjectId => id !== null);
  if (oids.length === 0) return Promise.resolve([]);
  return gymCollection()
    .find({ _id: { $in: oids } })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
}

/** Gyms the account administers: all for owner, its `gymIds` for admin/staff. */
export function listGymsFor(user: {
  role: Role;
  gymIds: readonly string[];
}): Promise<GymDoc[]> {
  if (user.role === "owner") return listAllGyms();
  return findGymsByIds(user.gymIds);
}

export type GymIdsCheck =
  | { ok: true; ids: ObjectId[] }
  | {
      ok: false;
      reason: "invalid" | "not-found" | "inactive" | "out-of-scope";
    };

/**
 * Validates a `gymIds` list for a subscription: non-empty, unique, every id an
 * existing ACTIVE gym, and (for admin/staff) inside the caller's scope.
 */
export async function validateSubscriptionGymIds(
  raw: readonly string[],
  caller: { role: Role; gymIds: readonly string[] },
): Promise<GymIdsCheck> {
  const unique = [...new Set(raw.map((id) => id.toLowerCase()))];
  if (unique.length === 0) return { ok: false, reason: "invalid" };
  const oids: ObjectId[] = [];
  for (const id of unique) {
    const oid = toObjectId(id);
    if (!oid || oid.toHexString() !== id) {
      return { ok: false, reason: "invalid" };
    }
    oids.push(oid);
  }
  if (!unique.every((id) => canAccessGym(caller, id))) {
    return { ok: false, reason: "out-of-scope" };
  }
  const found = await gymCollection()
    .find({ _id: { $in: oids } })
    .toArray();
  if (found.length !== oids.length) return { ok: false, reason: "not-found" };
  if (found.some((gym) => !gym.active)) {
    return { ok: false, reason: "inactive" };
  }
  return { ok: true, ids: oids };
}
