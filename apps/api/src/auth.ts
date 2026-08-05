import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
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

/** Vücut ölçüsü doğrulama hatasını BetterAuth'un 400 yanıtına çevirir. */
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
        // JSON olmayan/boş body — normal kuralı uygula
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

// Hook ön kontrolü kullanıcı dostu hata üretir; bu adapter sarmalayıcısı ise
// iki yazım aynı anda ön kontrolden geçtiğinde Mongo'nun atomik E11000
// sonucunu aynı PHONE_ALREADY_EXISTS sözleşmesine çevirir.
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
  // "opengym://" mobil uygulamanın deep-link scheme'i (@better-auth/expo).
  // "exp://" yalnızca geliştirmede: Expo Go istemcisi exp://<lan-ip>:8081 origin'i gönderir.
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
    // BetterAuth'un kendi revokeSessionsOnPasswordReset'i yalnızca Redis
    // "active-sessions-<userId>" listesindeki token'ları siler; Faz 6'nın
    // enforceSessionPolicy eviction'ı (sharing.ts) o listeyi hayatta kalan
    // oturumları yeniden yazmadan tamamen siler, bu yüzden liste zaten
    // boşalmış kullanıcılarda hayatta kalan Redis oturum blob'ları asla
    // silinmez ve findSession Mongo'ya hiç bakmadan onları geçerli kabul
    // eder. revokeUserSessions() token'ları Mongo'dan (referans doğruluk)
    // okuduğundan bu listeye bağımlı değildir. mustChangePassword'a
    // dokunmaz — yalnızca oturum iptali için eklenmiştir.
    // BetterAuth bu hook'u parola hash'i Mongo'ya yazıldıktan SONRA, kendi
    // revokeSessionsOnPasswordReset fallback'inden (internalAdapter.
    // deleteUserSessions) ÖNCE çalıştırır. revokeUserSessions() burada
    // hata fırlatırsa tüm route iptal olur: kullanıcıya parola değişmedi
    // izlenimi verilir (oysa hash zaten güncellendi) ve BetterAuth'un
    // kendi fallback oturum iptali de hiç çalışmaz. Bu yüzden hatayı
    // yutup yalnızca logluyoruz; böylece istek başarıyla döner ve
    // fallback devreye girip oturumları temizler.
    onPasswordReset: async ({ user }) => {
      try {
        await revokeUserSessions(user.id);
      } catch (err) {
        console.error(
          "onPasswordReset: revokeUserSessions başarısız oldu",
          err,
        );
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
      // Bölge-bağımsız onaylar: metinlerin içeriği operatörün mevzuatına göre
      // değişir (KVKK, GDPR, CCPA...), alan adları bu yüzden nötrdür.
      dataProcessingAccepted: { type: "boolean", required: true },
      privacyAccepted: { type: "boolean", required: true },
      dataProcessingAcceptedAt: { type: "date", required: false, input: false },
      privacyAcceptedAt: { type: "date", required: false, input: false },
      // Mobil kalori hesaplayıcının otomatik doldurabilmesi için üyenin
      // kendi girdiği yaş/boy/kilo. `input: false`: BetterAuth'un genel
      // `update-user` ve `sign-up` uçlarından yazılamazlar, çünkü o uçlar
      // yalnızca oturum middleware'inden geçer; `requireRole`'un
      // mustChangePassword denetimi ve Mongo'dan yeniden okuma davranışı
      // çalışmaz (bkz. AGENTS.md). Tek yazma yolu PATCH /api/me/body-metrics.
      age: { type: "number", required: false, input: false },
      heightCm: { type: "number", required: false, input: false },
      weightKg: { type: "number", required: false, input: false },
    },
  },

  session: {
    // secondaryStorage (Redis) etkinken oturum belgeleri varsayılan olarak
    // Mongo'ya YAZILMAZ (yalnızca Redis'te tutulur). Faz 6'nın eşzamanlı
    // oturum sınırı / cihaz parmak izi churn tespiti Mongo'daki "session"
    // koleksiyonunu sorguladığından bu açıkça etkinleştirilir; okumalar yine
    // de Redis'ten yapılmaya devam eder (performans kaybı yok)
    storeSessionInDatabase: true,
    additionalFields: {
      deviceFingerprint: { type: "string", required: false, input: false },
    },
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
                "Veri işleme bildirimi ve gizlilik sözleşmesi onayları zorunludur.",
            });
          }
          // `input: false` bu alanları kayıt gövdesinden zaten eler; doğrulama
          // yine de burada duruyor ki alanlar ileride yazılabilir yapılırsa
          // aralık dışı bir değer sessizce kalıcı olmasın.
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
    // Faz 6 — hesap paylaşımı tespiti: girişte cihaz parmak izini oturuma
    // damgalar ve oturum oluşturulduktan sonra eşzamanlı oturum sınırı /
    // parmak izi churn tespitini uygular
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
            `[mail:dev-test] to=${email} type=${type} otp=${otp} (SMTP atlandı, @test.com)`,
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
    // Faz 5 — US-3: hassas admin işlemleri (rol atama) için MFA. Mongo adapter
    // "twoFactor" koleksiyonunu göç (migration) gerektirmeden otomatik oluşturur
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
