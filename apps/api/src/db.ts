import { MongoClient, MongoServerError, ObjectId } from "mongodb";
import type { Collection, Db, WithId } from "mongodb";
import type {
  GymSettings,
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

/** Fixed ID of the singleton gym settings document */
export const GYM_SETTINGS_ID = "gym";

export interface GymSettingsDocument {
  _id: typeof GYM_SETTINGS_ID;
  gymName?: string;
  location?: GymSettings["location"];
  capacity?: number | null;
  autoExitHours?: number;
  sharing?: Partial<SharingConfig>;
  reminders?: Partial<ReminderConfig>;
  legal?: Partial<LegalConfig>;
}

export function gymSettingsCollection(
  database: Db = db,
): Collection<GymSettingsDocument> {
  return database.collection<GymSettingsDocument>("settings");
}

/** Reads the singleton settings._id: "gym" document (or null if absent). */
export function findGymSettings(
  database: Db = db,
): Promise<WithId<GymSettingsDocument> | null> {
  return gymSettingsCollection(database).findOne({ _id: GYM_SETTINGS_ID });
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
