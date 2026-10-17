import { MongoClient, MongoServerError, ObjectId } from "mongodb";
import type { Collection, Db, WithId } from "mongodb";
import type {
  GymLocation,
  LegalConfig,
  ReminderConfig,
  Role,
  SharingConfig,
} from "@opengym/shared";
import { env } from "./env.js";

export const mongoClient = new MongoClient(env.mongodbUri);
export const db = mongoClient.db();

/**
 * Whether this is Mongo's atomic uniqueness violation (E11000).
 * This is the only reliable signal for catching races in read-then-write patterns.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

/** Safely converts an ID from a path or body parameter into an ObjectId. */
export function toObjectId(value: string): ObjectId | null {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

// Collection schemas are defined here to provide typed driver access.
// Because documents are written by both BetterAuth and application code, only
// fields guaranteed to exist on every record are marked as required.

/** BetterAuth "user" document plus the extra fields defined in auth.ts */
export interface UserDocument {
  _id: ObjectId;
  email: string;
  name: string;
  emailVerified?: boolean;
  firstName?: string;
  lastName?: string;
  /** Displayed phone number; matches phoneE164 in normalized records */
  phone?: string;
  /** Internal unique phone identity—present only in deduplicated records */
  phoneE164?: string;
  role?: Role;
  /** Gym scope of admin/staff accounts (hex ObjectId strings); empty for owner and member */
  gymIds?: string[];
  mustChangePassword?: boolean;
  twoFactorEnabled?: boolean;
  profilePhotoKey?: string;
  profilePhotoUpdatedAt?: Date;
  createdAt?: Date;
  /** Member-provided age, height, and weight for mobile calorie calculator defaults */
  age?: number;
  heightCm?: number;
  weightKg?: number;
}

export function userCollection(database: Db = db): Collection<UserDocument> {
  return database.collection<UserDocument>("user");
}

/** BetterAuth session document (session.storeSessionInDatabase: true) */
export interface SessionDocument {
  _id: ObjectId;
  userId: ObjectId;
  token?: string;
  expiresAt?: Date;
  createdAt?: Date;
  /** Phase 6: device fingerprint stamped at sign-in */
  deviceFingerprint?: string;
}

export function sessionCollection(
  database: Db = db,
): Collection<SessionDocument> {
  return database.collection<SessionDocument>("session");
}

/** Fixed ID of the singleton chain-wide settings document */
export const CHAIN_SETTINGS_ID = "chain";

export interface ChainSettingsDocument {
  _id: typeof CHAIN_SETTINGS_ID;
  chainName?: string;
  legal?: Partial<LegalConfig>;
}

export function chainSettingsCollection(
  database: Db = db,
): Collection<ChainSettingsDocument> {
  return database.collection<ChainSettingsDocument>("settings");
}

/** Reads the singleton settings._id: "chain" document (or null if absent). */
export function findChainSettings(
  database: Db = db,
): Promise<WithId<ChainSettingsDocument> | null> {
  return chainSettingsCollection(database).findOne({ _id: CHAIN_SETTINGS_ID });
}

/** One gym of the chain. Gyms are deactivated, never deleted. */
export interface GymDocument {
  _id: ObjectId;
  name: string;
  location: GymLocation | null;
  capacity: number | null;
  autoExitHours: number;
  sharing?: Partial<SharingConfig>;
  reminders?: Partial<ReminderConfig>;
  active: boolean;
  createdBy: string;
  createdAt: Date;
}

export function gymCollection(database: Db = db): Collection<GymDocument> {
  return database.collection<GymDocument>("gyms");
}

/** Timestamped snapshot added whenever the member's `weightKg` changes */
export interface WeightHistoryDocument {
  _id?: ObjectId;
  userId: string;
  weightKg: number;
  at: Date;
}

export function weightHistoryCollection(
  database: Db = db,
): Collection<WeightHistoryDocument> {
  return database.collection<WeightHistoryDocument>("weight_history");
}
