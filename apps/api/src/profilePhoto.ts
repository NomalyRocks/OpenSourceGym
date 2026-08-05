import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ObjectId } from "mongodb";
import sharp from "sharp";
import { userCollection } from "./db.js";
import { env } from "./env.js";
import { acquireLock, redis, releaseLock } from "./redis.js";

const MAX_INPUT_PIXELS = 40_000_000;
const PROFILE_PHOTO_SIZE = 1024;
const PROFILE_PHOTO_LOCK_TTL_MS = 30_000;
// BetterAuth rate limiting covers only /api/auth/*; because image processing
// (sharp, CPU) and R2 PUT (billable class-A operation) are costly, the upload
// endpoint has a separate per-user limit.
const PROFILE_PHOTO_UPLOADS_PER_WINDOW = 10;
const PROFILE_PHOTO_RATE_WINDOW_SECONDS = 3600;

const inputFormats = new Map([
  ["image/jpeg", "jpeg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export class ProfilePhotoInputError extends Error {}
export class ProfilePhotoConfigError extends Error {}
export class ProfilePhotoBusyError extends Error {}
export class ProfilePhotoRateLimitError extends Error {}

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicBaseUrl: string;
}

let r2Client: S3Client | null = null;

function getR2Config(): R2Config {
  const { accountId, accessKeyId, secretAccessKey, bucketName, publicBaseUrl } =
    env.r2;
  if (
    !accountId ||
    !accessKeyId ||
    !secretAccessKey ||
    !bucketName ||
    !publicBaseUrl
  ) {
    throw new ProfilePhotoConfigError(
      "R2 profile photo configuration is incomplete.",
    );
  }
  let parsedPublicUrl: URL;
  try {
    parsedPublicUrl = new URL(publicBaseUrl);
  } catch {
    throw new ProfilePhotoConfigError(
      "R2_PUBLIC_BASE_URL must be a valid URL.",
    );
  }
  if (!["http:", "https:"].includes(parsedPublicUrl.protocol)) {
    throw new ProfilePhotoConfigError(
      "R2_PUBLIC_BASE_URL must use HTTP or HTTPS.",
    );
  }
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicBaseUrl: parsedPublicUrl.toString(),
  };
}

function getR2Client(config: R2Config): S3Client {
  r2Client ??= new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return r2Client;
}

export function assertProductionProfilePhotoConfig(): void {
  if (env.nodeEnv === "production") getR2Config();
}

export function buildProfilePhotoUrl(
  key: unknown,
  updatedAt: unknown,
): string | null {
  if (typeof key !== "string" || !env.r2.publicBaseUrl) return null;
  const base = env.r2.publicBaseUrl.replace(/\/+$/, "");
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const timestamp =
    updatedAt instanceof Date
      ? updatedAt.getTime()
      : typeof updatedAt === "string" || typeof updatedAt === "number"
        ? new Date(updatedAt).getTime()
        : Number.NaN;
  const version = Number.isFinite(timestamp) ? String(timestamp) : "0";
  return `${base}/${encodedKey}?v=${version}`;
}

export async function processProfilePhoto(
  input: Buffer,
  declaredContentType: string,
): Promise<Buffer> {
  const contentType = declaredContentType
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const expectedFormat = contentType
    ? inputFormats.get(contentType)
    : undefined;
  if (!expectedFormat) {
    throw new ProfilePhotoInputError(
      "Only JPEG, PNG, or WebP images can be uploaded.",
    );
  }
  if (input.length === 0) {
    throw new ProfilePhotoInputError("Photo data cannot be empty.");
  }

  try {
    const source = sharp(input, {
      failOn: "warning",
      limitInputPixels: MAX_INPUT_PIXELS,
      animated: false,
    });
    const metadata = await source.metadata();
    if (metadata.format !== expectedFormat) {
      throw new ProfilePhotoInputError(
        "File content does not match the declared image format.",
      );
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new ProfilePhotoInputError("Animated images are not supported.");
    }

    return await source
      .autoOrient()
      .resize(PROFILE_PHOTO_SIZE, PROFILE_PHOTO_SIZE, {
        fit: "cover",
        position: "centre",
      })
      .flatten({ background: "#101211" })
      .jpeg({ quality: 85, progressive: true })
      .toBuffer();
  } catch (error) {
    if (error instanceof ProfilePhotoInputError) throw error;
    throw new ProfilePhotoInputError(
      "Image could not be processed. Select a valid photo.",
    );
  }
}

async function putProfilePhotoObject(key: string, body: Buffer): Promise<void> {
  const config = getR2Config();
  await getR2Client(config).send(
    new PutObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      Body: body,
      ContentType: "image/jpeg",
      CacheControl: "public, max-age=300",
    }),
  );
}

async function deleteProfilePhotoObject(key: string): Promise<void> {
  const config = getR2Config();
  await getR2Client(config).send(
    new DeleteObjectCommand({ Bucket: config.bucketName, Key: key }),
  );
}

async function withProfilePhotoLock<T>(
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `og:lock:profile-photo:${userId}`;
  const token = randomUUID();
  if (!(await acquireLock(key, token, PROFILE_PHOTO_LOCK_TTL_MS))) {
    throw new ProfilePhotoBusyError(
      "Another profile photo operation is in progress.",
    );
  }

  try {
    return await operation();
  } finally {
    await releaseLock(key, token);
  }
}

export async function enforceProfilePhotoRateLimit(
  userId: string,
): Promise<void> {
  const key = `og:rl:profile-photo:${userId}`;
  const count = await redis.incr(key);
  // NX: write the TTL only if absent; if a crash occurs between incr and expire,
  // the next request repairs the key so it does not persist indefinitely.
  await redis.expire(key, PROFILE_PHOTO_RATE_WINDOW_SECONDS, "NX");
  if (count > PROFILE_PHOTO_UPLOADS_PER_WINDOW) {
    throw new ProfilePhotoRateLimitError(
      "Too many photo upload attempts. Please try again later.",
    );
  }
}

export async function storeUserProfilePhoto(
  userId: string,
  input: Buffer,
  contentType: string,
): Promise<string> {
  getR2Config();
  await enforceProfilePhotoRateLimit(userId);
  const processed = await processProfilePhoto(input, contentType);

  return withProfilePhotoLock(userId, async () => {
    const users = userCollection();
    const objectId = new ObjectId(userId);
    const user = await users.findOne(
      { _id: objectId },
      { projection: { profilePhotoKey: 1 } },
    );
    if (!user) throw new Error("User not found.");

    const existingKey = user.profilePhotoKey ?? null;
    const key = existingKey ?? `profile-photos/${userId}/${randomUUID()}.jpg`;
    const updatedAt = new Date();
    await putProfilePhotoObject(key, processed);

    try {
      const result = await users.updateOne(
        { _id: objectId },
        { $set: { profilePhotoKey: key, profilePhotoUpdatedAt: updatedAt } },
      );
      if (result.matchedCount !== 1) throw new Error("User not found.");
    } catch (error) {
      if (!existingKey) {
        try {
          await deleteProfilePhotoObject(key);
        } catch (rollbackError) {
          console.error(
            "New profile photo rollback deletion failed",
            rollbackError,
          );
        }
      }
      throw error;
    }

    return buildProfilePhotoUrl(key, updatedAt)!;
  });
}

export async function removeUserProfilePhoto(userId: string): Promise<void> {
  await withProfilePhotoLock(userId, async () => {
    const users = userCollection();
    const objectId = new ObjectId(userId);
    const user = await users.findOne(
      { _id: objectId },
      { projection: { profilePhotoKey: 1 } },
    );
    if (!user?.profilePhotoKey) return;

    await deleteProfilePhotoObject(user.profilePhotoKey);
    const result = await users.updateOne(
      { _id: objectId },
      { $unset: { profilePhotoKey: "", profilePhotoUpdatedAt: "" } },
    );
    if (result.matchedCount !== 1) throw new Error("User not found.");
  });
}

export async function deleteUserProfilePhotoForAccountDeletion(
  userId: string,
): Promise<void> {
  await withProfilePhotoLock(userId, async () => {
    const user = await userCollection().findOne(
      { _id: new ObjectId(userId) },
      { projection: { profilePhotoKey: 1 } },
    );
    if (user?.profilePhotoKey) {
      await deleteProfilePhotoObject(user.profilePhotoKey);
    }
  });
}
