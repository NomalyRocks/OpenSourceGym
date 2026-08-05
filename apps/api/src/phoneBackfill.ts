import { ObjectId, type Db } from "mongodb";
import { db } from "./db.js";
import { INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PHONE } from "./initialAdmin.js";
import { maskPhoneE164, tryNormalizePhoneToE164 } from "./phone.js";
import { planLegacyPhoneBackfill } from "./phoneBackfillPlan.js";

export const PHONE_CONFLICT_COLLECTION = "phone_identity_conflicts";

interface StoredUserPhone {
  _id: ObjectId;
  email?: unknown;
  phone?: unknown;
  phoneE164?: unknown;
}

interface PhoneConflictDocument {
  _id: string;
  phoneE164: string;
  active: boolean;
  users: Array<{ userId: string }>;
  firstDetectedAt: Date;
}

/**
 * Migrates unique legacy phone numbers to E.164. Accounts sharing the same
 * normalized number remain unchanged and are recorded as active conflicts, so
 * this legacy data does not block API startup or the partial unique index.
 */
export async function backfillLegacyUserPhones(
  database: Db = db,
): Promise<void> {
  const users = database.collection<StoredUserPhone>("user");
  const storedUsers = await users
    .find({}, { projection: { _id: 1, email: 1, phone: 1, phoneE164: 1 } })
    .toArray();

  const userIds = new Map(
    storedUsers.map((user) => [user._id.toString(), user._id]),
  );
  const plan = planLegacyPhoneBackfill(
    storedUsers.map((user) => ({
      userId: user._id.toString(),
      phone: user.phone,
      phoneE164: user.phoneE164,
      exempt:
        user.email === INITIAL_ADMIN_EMAIL &&
        user.phone === INITIAL_ADMIN_PHONE,
    })),
  );

  // In incomplete legacy runs, internal identities may conflict or differ from
  // the displayed phone. First clear affected internal fields, then write only
  // unique valid assignments while preserving the public phone.
  const phoneIdentityIdsToClear = new Set([
    ...plan.assignments.map((assignment) => assignment.userId),
    ...plan.conflicts.flatMap((conflict) =>
      conflict.users.map((user) => user.userId),
    ),
    ...plan.invalidUserIds,
  ]);
  const objectIdsToClear = [...phoneIdentityIdsToClear]
    .map((userId) => userIds.get(userId))
    .filter((id): id is ObjectId => id !== undefined);
  if (objectIdsToClear.length > 0) {
    await users.updateMany(
      { _id: { $in: objectIdsToClear } },
      { $unset: { phoneE164: "" } },
    );
  }

  if (plan.assignments.length > 0) {
    await users.bulkWrite(
      plan.assignments.flatMap((assignment) => {
        const id = userIds.get(assignment.userId);
        if (!id) return [];
        return [
          {
            updateOne: {
              filter: { _id: id },
              update: {
                $set: {
                  phone: assignment.phoneE164,
                  phoneE164: assignment.phoneE164,
                },
              },
            },
          },
        ];
      }),
      { ordered: false },
    );
  }

  const conflictDocuments = database.collection<PhoneConflictDocument>(
    PHONE_CONFLICT_COLLECTION,
  );
  const activeConflictIds = new Set(
    plan.conflicts.map((conflict) => conflict.phoneE164),
  );
  const previouslyRecorded = await conflictDocuments
    .find({}, { projection: { _id: 1 } })
    .toArray();
  const resolvedIds = previouslyRecorded
    .map((conflict) => conflict._id)
    .filter((id) => !activeConflictIds.has(id));
  const now = new Date();

  if (resolvedIds.length > 0) {
    // When a conflict ends, its record containing phone and user identities is
    // no longer needed and is permanently removed under data-protection duties.
    await conflictDocuments.deleteMany({ _id: { $in: resolvedIds } });
  }

  if (plan.conflicts.length > 0) {
    await conflictDocuments.bulkWrite(
      plan.conflicts.map((conflict) => ({
        updateOne: {
          filter: { _id: conflict.phoneE164 },
          update: {
            $set: {
              phoneE164: conflict.phoneE164,
              active: true,
              users: conflict.users,
            },
            $setOnInsert: { firstDetectedAt: now },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  if (plan.assignments.length > 0) {
    console.log(
      `[phone-backfill] ${plan.assignments.length} unique phone numbers migrated to E.164.`,
    );
  }
  if (plan.conflicts.length > 0) {
    const summaries = plan.conflicts
      .map(
        (conflict) =>
          `${maskPhoneE164(conflict.phoneE164)} (${conflict.users.length} accounts)`,
      )
      .join(", ");
    console.warn(
      `[phone-backfill] ${plan.conflicts.length} duplicate phone conflicts preserved: ${summaries}`,
    );
  }
  if (plan.invalidUserIds.length > 0) {
    console.warn(
      `[phone-backfill] ${plan.invalidUserIds.length} invalid or inconsistent legacy phone numbers left unchanged. User IDs: ${plan.invalidUserIds.join(", ")}`,
    );
  }
}

export async function hasActivePhoneConflict(
  phoneE164: string,
  database: Db = db,
): Promise<boolean> {
  const conflict = await database
    .collection<PhoneConflictDocument>(PHONE_CONFLICT_COLLECTION)
    .findOne({ _id: phoneE164, active: true }, { projection: { _id: 1 } });
  return conflict !== null;
}

export async function findActivePhoneConflictUserIds(
  phoneE164: string,
  database: Db = db,
): Promise<ObjectId[]> {
  const conflict = await database
    .collection<PhoneConflictDocument>(PHONE_CONFLICT_COLLECTION)
    .findOne({ _id: phoneE164, active: true }, { projection: { users: 1 } });

  return (conflict?.users ?? [])
    .map((user) => user.userId)
    .filter((userId) => ObjectId.isValid(userId))
    .map((userId) => new ObjectId(userId));
}

/**
 * Removes a changed or deleted user from legacy conflicts. When one account
 * remains, the conflict is not deleted until that account is normalized and
 * protected by the unique index.
 */
export async function reconcilePhoneConflictsAfterUserChange(
  changedUserId: string,
  database: Db = db,
): Promise<void> {
  const conflicts = database.collection<PhoneConflictDocument>(
    PHONE_CONFLICT_COLLECTION,
  );
  const affected = await conflicts
    .find({ "users.userId": changedUserId })
    .toArray();
  if (affected.length === 0) return;

  const users = database.collection<StoredUserPhone>("user");
  const changedUser = ObjectId.isValid(changedUserId)
    ? await users.findOne({ _id: new ObjectId(changedUserId) })
    : null;
  const changedPhoneE164 = tryNormalizePhoneToE164(changedUser?.phone);

  for (const conflict of affected) {
    if (changedPhoneE164 === conflict.phoneE164) continue;

    const remainingUsers = conflict.users.filter(
      (user) => user.userId !== changedUserId,
    );
    await conflicts.updateOne(
      { _id: conflict._id },
      { $set: { users: remainingUsers } },
    );

    if (remainingUsers.length >= 2) continue;

    const remainingUserId = remainingUsers[0]?.userId;
    if (remainingUserId && ObjectId.isValid(remainingUserId)) {
      const remainingUserObjectId = new ObjectId(remainingUserId);
      const remainingUser = await users.findOne({
        _id: remainingUserObjectId,
      });
      const phoneE164 = tryNormalizePhoneToE164(remainingUser?.phone);
      if (phoneE164) {
        await users.updateOne(
          { _id: remainingUserObjectId },
          { $set: { phone: phoneE164, phoneE164 } },
        );
      }
    }

    await conflicts.deleteOne({ _id: conflict._id });
  }
}
