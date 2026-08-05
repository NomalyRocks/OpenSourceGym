import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { emailOTP, twoFactor } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { MongoServerError } from "mongodb";
import { db, userCollection } from "./db.js";
import { redis } from "./redis.js";
import { sendMail } from "./mailer.js";
import { env } from "./env.js";
import { enforceSessionPolicy } from "./sharing.js";
import { revokeUserSessions } from "./sessions.js";
import {
  isInitialAdminSeedInput,
  INITIAL_ADMIN_PHONE,
} from "./initialAdmin.js";
import {
  hasActivePhoneConflict,
  reconcilePhoneConflictsAfterUserChange,
} from "./phoneBackfill.js";
import {
  INVALID_PHONE_MESSAGE,
  InvalidPhoneNumberError,
  normalizePhoneToE164,
  PHONE_ALREADY_EXISTS_CODE,
  PHONE_ALREADY_EXISTS_MESSAGE,
} from "./phone.js";
import {
  assertValidBodyMetricsUpdate,
  InvalidBodyMetricError,
} from "./bodyMetrics.js";

/** Converts a body-metric validation error into a BetterAuth 400 response. */
function assertBodyMetricsOrBadRequest(input: {
  age?: unknown;
  heightCm?: unknown;
  weightKg?: unknown;
}): void {
  try {
    assertValidBodyMetricsUpdate(input);
  } catch (err) {
    if (err instanceof InvalidBodyMetricError) {
      throw new APIError("BAD_REQUEST", { message: err.message });
    }
    throw err;
  }
}

function normalizePhoneForApi(value: unknown): string {
  try {
    return normalizePhoneToE164(value);
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) {
      throw new APIError("BAD_REQUEST", {
        code: "INVALID_PHONE_NUMBER",
        message: INVALID_PHONE_MESSAGE,
      });
    }
    throw error;
  }
}

const DEV_TEST_EMAIL_DOMAIN = "@test.com";
const DEV_TEST_OTP = "111111";

function isDevTestEmail(email: string): boolean {
  return (
    env.nodeEnv === "development" &&
    email.toLowerCase().endsWith(DEV_TEST_EMAIL_DOMAIN)
  );
}

function bypassableRateLimit(window: number, max: number) {
  return async (request: Request) => {
    if (env.nodeEnv === "development") {
      try {
        const body = await request.clone().json();
        if (typeof body?.email === "string" && isDevTestEmail(body.email)) {
          return false as const;
        }
      } catch {
        // Non-JSON or empty body—apply the normal rule
      }
    }
    return { window, max };
  };
}

function duplicatePhoneError(): APIError {
  return new APIError("BAD_REQUEST", {
    code: PHONE_ALREADY_EXISTS_CODE,
    message: PHONE_ALREADY_EXISTS_MESSAGE,
  });
}

function isPhoneIdentityDuplicateKey(error: unknown): boolean {
  return (
    error instanceof MongoServerError &&
    error.code === 11000 &&
    (error.keyPattern?.phoneE164 === 1 ||
      error.message.includes("user_phone_e164_unique"))
  );
}

// The hook precheck produces a user-friendly error; this adapter wrapper converts
// Mongo's atomic E11000 result to the same PHONE_ALREADY_EXISTS contract when
// two writes pass the precheck concurrently.
const baseDatabaseAdapter = mongodbAdapter(db);
const databaseAdapter: typeof baseDatabaseAdapter = (options) => {
  const adapter = baseDatabaseAdapter(options);
  return {
    ...adapter,
    async create(input) {
      try {
        return await adapter.create(input);
      } catch (error) {
        if (input.model === "user" && isPhoneIdentityDuplicateKey(error)) {
          throw duplicatePhoneError();
        }
        throw error;
      }
    },
    async update(input) {
      try {
        return await adapter.update(input);
      } catch (error) {
        if (input.model === "user" && isPhoneIdentityDuplicateKey(error)) {
          throw duplicatePhoneError();
        }
        throw error;
      }
    },
  };
};

async function assertPhoneAvailable(phoneE164: string): Promise<void> {
  const [existingUser, activeConflict] = await Promise.all([
    userCollection().findOne({ phoneE164 }, { projection: { _id: 1 } }),
    hasActivePhoneConflict(phoneE164),
  ]);
  if (existingUser || activeConflict) throw duplicatePhoneError();
}

export const auth = betterAuth({
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  // "opengym://" is the mobile app's deep-link scheme (@better-auth/expo).
  // "exp://" is development-only: Expo Go sends an exp://<lan-ip>:8081 origin.
  trustedOrigins: [
    ...env.trustedOrigins,
    "opengym://",
    ...(env.nodeEnv !== "production" ? ["exp://"] : []),
  ],
  database: databaseAdapter,

  secondaryStorage: {
    get: (key) => redis.get(key),
    set: async (key, value, ttl) => {
      if (ttl) {
        await redis.set(key, value, {
          expiration: { type: "EX", value: ttl },
        });
      } else {
        await redis.set(key, value);
      }
    },
    delete: async (key) => {
      await redis.del(key);
    },
  },

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    revokeSessionsOnPasswordReset: true,
    // BetterAuth's own revokeSessionsOnPasswordReset only deletes tokens in the
    // Redis "active-sessions-<userId>" list. Phase 6 enforceSessionPolicy
    // eviction (sharing.ts) deletes that list completely without rewriting
    // surviving sessions, so surviving Redis session blobs are never deleted
    // for users whose list is already empty, and findSession accepts them as
    // valid without consulting Mongo. revokeUserSessions() reads tokens from
    // Mongo (the source of truth), so it does not depend on that list. It does
    // not touch mustChangePassword—it was added only for session revocation.
    // BetterAuth runs this hook AFTER writing the password hash to Mongo but
    // BEFORE its own revokeSessionsOnPasswordReset fallback (internalAdapter.
    // deleteUserSessions). If revokeUserSessions() throws here, the entire route
    // aborts: the user is told the password did not change even though the hash
    // was updated, and BetterAuth's fallback session revocation never runs.
    // Therefore, swallow and only log the error so the request succeeds and the
    // fallback can run and clear the sessions.
    onPasswordReset: async ({ user }) => {
      try {
        await revokeUserSessions(user.id);
      } catch (err) {
        console.error("onPasswordReset: revokeUserSessions failed", err);
      }
    },
  },

  user: {
    additionalFields: {
      firstName: { type: "string", required: true },
      lastName: { type: "string", required: true },
      phone: { type: "string", required: true },
      phoneE164: {
        type: "string",
        required: false,
        input: false,
        returned: false,
      },
      role: {
        type: "string",
        required: false,
        defaultValue: "member",
        input: false,
      },
      mustChangePassword: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
      // Region-neutral consents: text varies with the operator's applicable law
      // (KVKK, GDPR, CCPA...), so the field names are neutral.
      dataProcessingAccepted: { type: "boolean", required: true },
      privacyAccepted: { type: "boolean", required: true },
      dataProcessingAcceptedAt: { type: "date", required: false, input: false },
      privacyAcceptedAt: { type: "date", required: false, input: false },
      // Member-provided age, height, and weight for mobile calorie calculator
      // defaults. `input: false`: BetterAuth's generic `update-user` and `sign-up`
      // endpoints cannot write them because those endpoints pass only through
      // session middleware; `requireRole`'s mustChangePassword check and Mongo
      // reread do not run (see AGENTS.md). The only write path is
      // PATCH /api/me/body-metrics.
      age: { type: "number", required: false, input: false },
      heightCm: { type: "number", required: false, input: false },
      weightKg: { type: "number", required: false, input: false },
    },
  },

  session: {
    // With secondaryStorage (Redis), session documents are NOT WRITTEN to Mongo
    // by default and live only in Redis. Phase 6 concurrent-session limits and
    // device-fingerprint churn detection query Mongo's "session" collection, so
    // this is enabled explicitly; reads still use Redis (no performance loss)
    storeSessionInDatabase: true,
    additionalFields: {
      deviceFingerprint: { type: "string", required: false, input: false },
    },
  },

  // The previous mobile client sends `kvkkAccepted`. Because BetterAuth checks
  // required additional fields before the database hook, move this value to the
  // neutral field at the request stage during rollout. The legacy field is not
  // defined in the schema, so it is neither written to Mongo nor returned.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (
        ctx.path === "/sign-up/email" &&
        ctx.body.dataProcessingAccepted === undefined &&
        ctx.body.kvkkAccepted === true
      ) {
        ctx.body.dataProcessingAccepted = true;
      }
    }),
  },

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const candidate = user as typeof user & {
            email?: string;
            phone?: unknown;
            dataProcessingAccepted?: boolean;
            privacyAccepted?: boolean;
            age?: unknown;
            heightCm?: unknown;
            weightKg?: unknown;
          };
          if (!candidate.dataProcessingAccepted || !candidate.privacyAccepted) {
            throw new APIError("BAD_REQUEST", {
              message:
                "Data processing notice and privacy policy consent are required.",
            });
          }
          // `input: false` already removes these fields from the registration
          // body; validation remains here so an out-of-range value cannot be
          // silently persisted if the fields become writable later.
          assertBodyMetricsOrBadRequest(candidate);
          const isInitialAdminSeed = isInitialAdminSeedInput(
            candidate.email,
            candidate.phone,
          );
          const phoneE164 = isInitialAdminSeed
            ? null
            : normalizePhoneForApi(candidate.phone);
          if (phoneE164) await assertPhoneAvailable(phoneE164);

          const now = new Date();
          return {
            data: {
              ...user,
              ...(phoneE164
                ? { phone: phoneE164, phoneE164 }
                : { phone: INITIAL_ADMIN_PHONE }),
              role: "member",
              dataProcessingAcceptedAt: now,
              privacyAcceptedAt: now,
            },
          };
        },
      },
      update: {
        before: async (user) => {
          const candidate = user as typeof user & {
            phone?: unknown;
            age?: unknown;
            heightCm?: unknown;
            weightKg?: unknown;
          };
          assertBodyMetricsOrBadRequest(candidate);

          if (!Object.prototype.hasOwnProperty.call(user, "phone")) return;

          const phoneE164 = normalizePhoneForApi(candidate.phone);
          if (await hasActivePhoneConflict(phoneE164)) {
            throw duplicatePhoneError();
          }
          return { data: { ...user, phone: phoneE164, phoneE164 } };
        },
        after: async (user) => {
          const updated = user as typeof user & { id?: unknown };
          if (typeof updated.id === "string") {
            await reconcilePhoneConflictsAfterUserChange(updated.id);
          }
        },
      },
    },
    // Phase 6—account-sharing detection: stamps the device fingerprint onto the
    // session at sign-in and applies the concurrent-session limit and fingerprint
    // churn detection after session creation
    session: {
      create: {
        before: async (session, ctx) => {
          const candidate = session as typeof session & {
            deviceFingerprint?: string;
          };
          const fp =
            ctx?.headers?.get?.("x-device-fingerprint") ??
            ctx?.request?.headers?.get?.("x-device-fingerprint") ??
            null;
          if (fp && /^[a-f0-9]{64}$/.test(fp)) {
            return { data: { ...candidate, deviceFingerprint: fp } };
          }
        },
        after: async (session) => {
          try {
            await enforceSessionPolicy(
              session as unknown as { userId: string },
            );
          } catch (err) {
            console.error("session policy enforcement failed:", err);
          }
        },
      },
    },
  },

  plugins: [
    expo(),
    emailOTP({
      sendVerificationOnSignUp: true,
      otpLength: 6,
      expiresIn: 600,
      storeOTP: "hashed",
      resendStrategy: "rotate",
      generateOTP({ email }) {
        return isDevTestEmail(email) ? DEV_TEST_OTP : undefined;
      },
      async sendVerificationOTP({ email, otp, type }) {
        if (isDevTestEmail(email)) {
          console.log(
            `[mail:dev-test] to=${email} type=${type} otp=${otp} (SMTP skipped, @test.com)`,
          );
          return;
        }
        const subjects: Record<string, string> = {
          "email-verification": "OpenGym e-posta doğrulama kodunuz",
          "sign-in": "OpenGym giriş kodunuz",
          "forget-password": "OpenGym şifre sıfırlama kodunuz",
        };
        await sendMail({
          to: email,
          subject: subjects[type] ?? "OpenGym doğrulama kodunuz",
          text: `Doğrulama kodunuz: ${otp}\nKod 10 dakika geçerlidir.`,
        });
      },
    }),
    // Phase 5—US-3: MFA for sensitive admin operations (role assignment). The
    // Mongo adapter creates the "twoFactor" collection without a migration
    twoFactor({
      issuer: "OpenGym",
      otpOptions: {
        storeOTP: "hashed",
        async sendOTP({ user, otp }) {
          await sendMail({
            to: user.email,
            subject: "OpenGym güvenlik kodunuz",
            text: `Güvenlik kodunuz: ${otp}\nKod 3 dakika geçerlidir.`,
          });
        },
      },
    }),
  ],

  rateLimit: {
    enabled: true,
    storage: "secondary-storage",
    window: 60,
    max: 60,
    customRules: {
      "/sign-up/email": bypassableRateLimit(60, 3),
      "/sign-in/email": bypassableRateLimit(60, 5),
      "/email-otp/send-verification-otp": bypassableRateLimit(60, 3),
      "/email-otp/verify-email": bypassableRateLimit(60, 5),
      "/email-otp/request-password-reset": bypassableRateLimit(60, 3),
      "/email-otp/reset-password": bypassableRateLimit(60, 5),
      "/two-factor/send-otp": { window: 60, max: 3 },
      "/two-factor/verify-totp": { window: 60, max: 5 },
      "/two-factor/verify-otp": { window: 60, max: 5 },
    },
  },
});
