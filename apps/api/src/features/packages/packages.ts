import type { Db, ObjectId } from "mongodb";
import type {
  Package,
  PackageDuration,
  SubscriptionMonths,
} from "@opengym/shared";
import { db, toObjectId } from "../../core/db.js";

export interface PackageFields {
  name: string;
  duration: PackageDuration;
  /** Null until the owner has set a price */
  priceMinor: number | null;
  active: boolean;
  /** Set only on the seeded classics; unique where present */
  legacyMonths?: SubscriptionMonths;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export type PackageDocument = PackageFields & { _id: ObjectId };

export function packageCollection(database: Db = db) {
  return database.collection<PackageFields>("packages");
}

export function toPackage(doc: PackageDocument): Package {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    duration: doc.duration,
    priceMinor: doc.priceMinor,
    active: doc.active,
    legacyMonths: doc.legacyMonths ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function findPackage(id: string): Promise<PackageDocument | null> {
  const oid = toObjectId(id);
  if (!oid) return Promise.resolve(null);
  return packageCollection().findOne({ _id: oid });
}

/** Catalog listing; the catalog is small and owner-curated, so it is not paged. */
export function listPackages(activeOnly: boolean): Promise<PackageDocument[]> {
  return packageCollection()
    .find(activeOnly ? { active: true } : {})
    .sort({ createdAt: 1, _id: 1 })
    .limit(500)
    .toArray();
}
