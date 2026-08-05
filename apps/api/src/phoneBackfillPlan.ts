import { tryNormalizePhoneToE164 } from "./phone.js";

export interface LegacyPhoneRecord {
  userId: string;
  phone?: unknown;
  phoneE164?: unknown;
  exempt?: boolean;
}

export interface LegacyPhoneAssignment {
  userId: string;
  phoneE164: string;
}

export interface LegacyPhoneConflict {
  phoneE164: string;
  users: Array<{ userId: string }>;
}

export interface LegacyPhoneBackfillPlan {
  assignments: LegacyPhoneAssignment[];
  conflicts: LegacyPhoneConflict[];
  invalidUserIds: string[];
}

/**
 * Pure function: separates legacy phone documents into unique assignments,
 * duplicate groups that must remain untouched, and invalid inputs.
 */
export function planLegacyPhoneBackfill(
  records: readonly LegacyPhoneRecord[],
): LegacyPhoneBackfillPlan {
  const groups = new Map<
    string,
    Array<LegacyPhoneRecord & { normalized: string }>
  >();
  const invalidUserIds: string[] = [];

  for (const record of records) {
    if (record.exempt) continue;

    const normalizedPhone = tryNormalizePhoneToE164(record.phone);
    // The displayed phone number is authoritative. If a legacy or partial
    // phoneE164 value is malformed or differs, the unique-assignment step can
    // safely replace it.
    if (!normalizedPhone) {
      invalidUserIds.push(record.userId);
      continue;
    }

    const group = groups.get(normalizedPhone) ?? [];
    group.push({ ...record, normalized: normalizedPhone });
    groups.set(normalizedPhone, group);
  }

  const assignments: LegacyPhoneAssignment[] = [];
  const conflicts: LegacyPhoneConflict[] = [];

  for (const [phoneE164, group] of [...groups].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (group.length > 1) {
      conflicts.push({
        phoneE164,
        users: group
          .map((record) => ({ userId: record.userId }))
          .sort((a, b) => a.userId.localeCompare(b.userId)),
      });
      continue;
    }

    const record = group[0];
    if (
      record &&
      (record.phone !== phoneE164 || record.phoneE164 !== phoneE164)
    ) {
      assignments.push({ userId: record.userId, phoneE164 });
    }
  }

  return {
    assignments,
    conflicts,
    invalidUserIds: invalidUserIds.sort(),
  };
}
