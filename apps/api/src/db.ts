import { MongoClient, MongoServerError, ObjectId } from "mongodb";
import type { Collection, Db, WithId } from "mongodb";
import type {
  GymSettings,
  ReminderConfig,
  Role,
  SharingConfig,
} from "@opengym/shared";
import { env } from "./env.js";

export const mongoClient = new MongoClient(env.mongodbUri);
export const db = mongoClient.db();

/**
 * Mongo'nun atomik benzersizlik ihlali (E11000) hatası mı.
 * "Önce oku sonra yaz" desenlerinde yarışı yakalayan tek güvenilir sinyal budur.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

/** Yol/gövde parametresinden gelen kimliği güvenle ObjectId'ye çevirir. */
export function toObjectId(value: string): ObjectId | null {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

// Koleksiyon şemaları: sürücü tipli erişim sağlasın diye burada tanımlanır.
// Belgeler BetterAuth ve uygulama kodu tarafından birlikte yazıldığından,
// yalnızca her kayıtta bulunması garanti alanlar zorunlu işaretlenir.

/** BetterAuth "user" belgesi + auth.ts'te tanımlı ek alanlar */
export interface UserDocument {
  _id: ObjectId;
  email: string;
  name: string;
  emailVerified?: boolean;
  firstName?: string;
  lastName?: string;
  /** Görünen telefon; normalize edilmiş kayıtlarda phoneE164 ile aynıdır */
  phone?: string;
  /** Dahili benzersiz telefon kimliği — yalnızca tekilleştirilmiş kayıtlarda bulunur */
  phoneE164?: string;
  role?: Role;
  mustChangePassword?: boolean;
  twoFactorEnabled?: boolean;
  profilePhotoKey?: string;
  profilePhotoUpdatedAt?: Date;
  createdAt?: Date;
  /** Mobil kalori hesaplayıcının otomatik doldurması için üyenin kendi girdiği yaş/boy/kilo */
  age?: number;
  heightCm?: number;
  weightKg?: number;
}

export function userCollection(database: Db = db): Collection<UserDocument> {
  return database.collection<UserDocument>("user");
}

/** BetterAuth oturum belgesi (session.storeSessionInDatabase: true) */
export interface SessionDocument {
  _id: ObjectId;
  userId: ObjectId;
  token?: string;
  expiresAt?: Date;
  createdAt?: Date;
  /** Faz 6: girişte damgalanan cihaz parmak izi */
  deviceFingerprint?: string;
}

export function sessionCollection(
  database: Db = db,
): Collection<SessionDocument> {
  return database.collection<SessionDocument>("session");
}

/** Salon ayarları tekil belgesinin sabit kimliği */
export const GYM_SETTINGS_ID = "gym";

export interface GymSettingsDocument {
  _id: typeof GYM_SETTINGS_ID;
  gymName?: string;
  location?: GymSettings["location"];
  capacity?: number | null;
  autoExitHours?: number;
  sharing?: Partial<SharingConfig>;
  reminders?: Partial<ReminderConfig>;
}

export function gymSettingsCollection(
  database: Db = db,
): Collection<GymSettingsDocument> {
  return database.collection<GymSettingsDocument>("settings");
}

/** settings._id: "gym" tekil belgesini okur (yoksa null). */
export function findGymSettings(
  database: Db = db,
): Promise<WithId<GymSettingsDocument> | null> {
  return gymSettingsCollection(database).findOne({ _id: GYM_SETTINGS_ID });
}

/** Üyenin `weightKg` alanı her değiştiğinde eklenen tarihli anlık görüntü */
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
