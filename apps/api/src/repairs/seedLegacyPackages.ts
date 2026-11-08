import type { Db } from "mongodb";
import { db } from "../core/db.js";

/**
 * Seeds the four classic 1/3/6/12 month packages once, unpriced. Each is
 * upserted on `legacyMonths` (a unique partial index), so concurrent starts
 * cannot create a second copy and no lock is needed. `$setOnInsert` means an
 * owner's later rename or price is never overwritten. The marker only skips the
 * four upserts on later starts.
 */
const MARKER_ID = "seed-legacy-month-packages";
const SEED_ACTOR = "system";

const CLASSICS = [
  { months: 1, name: "1 Aylık" },
  { months: 3, name: "3 Aylık" },
  { months: 6, name: "6 Aylık" },
  { months: 12, name: "12 Aylık" },
] as const;

interface PackageSeedMarker {
  _id: string;
  completedAt: Date;
  insertedCount: number;
}

export interface PackageSeedReport {
  skipped: boolean;
  insertedCount: number;
}

export async function seedLegacyMonthPackages(
  database: Db = db,
): Promise<PackageSeedReport> {
  const markers = database.collection<PackageSeedMarker>("migration_markers");
  const existing = await markers.findOne({ _id: MARKER_ID });
  if (existing) return { skipped: true, insertedCount: existing.insertedCount };

  const packages = database.collection("packages");
  const now = new Date();
  let insertedCount = 0;
  for (const classic of CLASSICS) {
    const result = await packages.updateOne(
      { legacyMonths: classic.months },
      {
        $setOnInsert: {
          name: classic.name,
          duration: { unit: "month", value: classic.months },
          priceMinor: null,
          active: true,
          legacyMonths: classic.months,
          createdAt: now,
          createdBy: SEED_ACTOR,
          updatedAt: now,
          updatedBy: SEED_ACTOR,
        },
      },
      { upsert: true },
    );
    if (result.upsertedCount > 0) insertedCount += 1;
  }
  await markers.updateOne(
    { _id: MARKER_ID },
    { $set: { completedAt: new Date(), insertedCount } },
    { upsert: true },
  );
  return { skipped: false, insertedCount };
}
