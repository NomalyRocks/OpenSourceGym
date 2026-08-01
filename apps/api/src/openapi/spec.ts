import { z } from "zod";
import {
  createDocument,
  type ZodOpenApiOperationObject,
  type ZodOpenApiRequestBodyObject,
  type ZodOpenApiResponseObject,
} from "zod-openapi";
import {
  adminStatsSchema,
  apiErrorSchema,
  auditLogSchema,
  authErrorSchema,
  createDeviceRequestSchema,
  createSubscriptionRequestSchema,
  createSubscriptionResponseSchema,
  deletionRequestSchema,
  deviceCreatedSchema,
  deviceSchema,
  entryEventSchema,
  gateScanRequestSchema,
  gateScanResponseSchema,
  getSessionResponseSchema,
  gymSettingsRequestSchema,
  gymSettingsSchema,
  healthSchema,
  initialPasswordRequestSchema,
  myDeletionRequestSchema,
  myEntriesSchema,
  myProfileSchema,
  mySubscriptionSchema,
  objectIdSchema,
  occupancySchema,
  okSchema,
  otpSuccessSchema,
  pageSchema,
  profilePhotoResponseSchema,
  publicUserSchema,
  roleRequestSchema,
  sendOtpRequestSchema,
  signInRequestSchema,
  signInResponseSchema,
  signUpRequestSchema,
  signUpResponseSchema,
  subscriptionSchema,
  verifyEmailOtpRequestSchema,
  verifyEmailOtpResponseSchema,
} from "./schemas.js";

const jsonResponse = (
  description: string,
  schema: z.ZodType,
): ZodOpenApiResponseObject => ({
  description,
  content: { "application/json": { schema } },
});

const jsonBody = (schema: z.ZodType): ZodOpenApiRequestBodyObject => ({
  required: true,
  content: { "application/json": { schema } },
});

const authErrorResponse = jsonResponse(
  "Kimlik doğrulama hatası",
  authErrorSchema,
);
const apiErrorResponse = jsonResponse("OpenGym API hatası", apiErrorSchema);

const protectedResponses = (
  success: Record<string, ZodOpenApiResponseObject>,
): Record<string, ZodOpenApiResponseObject> => ({
  ...success,
  "401": jsonResponse("Geçerli oturum bulunamadı", apiErrorSchema),
  "403": jsonResponse("Rol veya zorunlu şifre değişimi engeli", apiErrorSchema),
});

const requiredRole = (
  role: string,
  description: string,
  secured = true,
): Pick<ZodOpenApiOperationObject, "description" | "security"> => ({
  description: `${description}\n\nGerekli rol: ${role}.`,
  ...(secured ? { security: [{ sessionCookie: [] }] } : { security: [] }),
});

const idPathParams = z.object({
  id: objectIdSchema.meta({
    description: "Hedef kaydın MongoDB ObjectId değeri",
  }),
});

const userSearchQuery = z.object({
  q: z.string().trim().min(2).meta({
    description: "Telefon, e-posta, ad veya soyad; en az 2 karakter",
  }),
});

const dayLabelQuerySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .meta({ description: "Salon saat dilimindeki takvim günü (YYYY-MM-DD)" });

const myEntriesQuery = z.object({
  from: dayLabelQuerySchema,
  to: dayLabelQuerySchema.meta({
    description: "Aralığın son günü; from ile arası en çok 92 gün olabilir",
  }),
});

const pageQuerySchema = z.object({
  cursor: z.string().min(1).optional().meta({
    description: "Bir önceki sayfadan dönen opak devam imleci",
  }),
  limit: z.coerce.number().int().min(1).max(100).default(50).meta({
    description: "Sayfa başına kayıt sayısı (varsayılan 50; 1-100)",
  }),
});

const auditQuerySchema = pageQuerySchema.extend({
  action: z.string().min(1).max(64).optional().meta({
    description: "Tam eşleşmeyle filtrelenecek işlem adı (1-64 karakter)",
  }),
  from: z.coerce
    .date()
    .optional()
    .meta({
      description: "Kayıt zamanı için dahil başlangıç tarihi ve saati",
      override: { type: "string", format: "date-time" },
    }),
  to: z.coerce
    .date()
    .optional()
    .meta({
      description: "Kayıt zamanı için dahil bitiş tarihi ve saati",
      override: { type: "string", format: "date-time" },
    }),
});

const entryEventQuerySchema = pageQuerySchema.extend({
  deviceId: z.string().min(1).max(64).optional().meta({
    description: "Filtrelenecek cihaz kimliği (1-64 karakter)",
  }),
  userId: z.string().min(1).max(64).optional().meta({
    description: "Filtrelenecek kullanıcı kimliği (1-64 karakter)",
  }),
  allowed: z.enum(["true", "false"]).optional().meta({
    description: "Geçiş sonucunu izin verilen veya reddedilenlerle sınırlar",
  }),
  from: z.coerce
    .date()
    .optional()
    .meta({
      description: "Geçiş zamanı için dahil başlangıç tarihi ve saati",
      override: { type: "string", format: "date-time" },
    }),
  to: z.coerce
    .date()
    .optional()
    .meta({
      description: "Geçiş zamanı için dahil bitiş tarihi ve saati",
      override: { type: "string", format: "date-time" },
    }),
});

const deletionRequestQuerySchema = pageQuerySchema.extend({
  status: z.enum(["pending", "approved", "rejected"]).optional().meta({
    description: "Talepleri durumuna göre filtreler",
  }),
});

const getSessionQuery = z.object({
  disableCookieCache: z.coerce.boolean().optional(),
  disableRefresh: z.coerce.boolean().optional(),
});

const binaryImageSchema = z.string().meta({
  description: "En fazla 10 MB JPEG, PNG veya WebP görsel verisi",
  override: { type: "string", format: "binary" },
});

export type OpenApiDocument = ReturnType<typeof createDocument>;

export const openApiDocument: OpenApiDocument = createDocument({
  openapi: "3.1.0",
  info: {
    title: "OpenGym REST API",
    version: "0.1.0",
    description:
      "OpenGym yönetim paneli, üye uygulaması ve turnike cihaz yönetimi REST yüzeyi. " +
      " `/api/auth/*` yollarının sahibi BetterAuth'tur; burada etkin yapılandırmanın temsilî istemci uçları belgelenir.",
  },
  servers: [{ url: "/", description: "Bu OpenGym sunucusu" }],
  tags: [
    { name: "admin", description: "Personel ve yönetici işlemleri" },
    { name: "me", description: "Oturumdaki kullanıcının işlemleri" },
    { name: "devices", description: "Turnike cihaz yönetimi" },
    { name: "system", description: "Sağlık ve API belgeleri" },
    {
      name: "auth",
      description: "BetterAuth tarafından sunulan kimlik uçları",
    },
  ],
  components: {
    securitySchemes: {
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "better-auth.session_token",
        description:
          "BetterAuth imzalı oturum çerezi. HTTPS üretim kurulumunda BetterAuth ada `__Secure-` öneki ekleyebilir.",
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["system"],
        operationId: "getHealth",
        summary: "Servis sağlık durumu",
        ...requiredRole("yok", "API işleminin çalıştığını bildirir", false),
        responses: { "200": jsonResponse("Servis sağlıklı", healthSchema) },
      },
    },
    "/api/openapi.json": {
      get: {
        tags: ["system"],
        operationId: "getOpenApiDocument",
        summary: "Ham OpenAPI belgesi",
        ...requiredRole(
          "yok",
          "OpenAPI 3.1 belgesini JSON olarak döndürür; production ortamında ENABLE_API_DOCS=true gerekir",
          false,
        ),
        responses: {
          "200": {
            description: "OpenAPI 3.1 JSON belgesi",
            content: {
              "application/json": {
                schema: z.looseObject({
                  openapi: z.literal("3.1.0"),
                  info: z.object({
                    title: z.string(),
                    version: z.string(),
                  }),
                  paths: z.record(z.string(), z.unknown()),
                }),
              },
            },
          },
        },
      },
    },
    "/api/docs": {
      get: {
        tags: ["system"],
        operationId: "getSwaggerUi",
        summary: "Swagger UI",
        ...requiredRole(
          "yok",
          "Bu belgeyi kullanan Swagger UI'ı açar; production ortamında ENABLE_API_DOCS=true gerekir",
          false,
        ),
        responses: {
          "200": {
            description: "Swagger UI HTML sayfası",
            content: {
              "text/html": {
                schema: z.string(),
              },
            },
          },
          "301": {
            description: "Sonunda eğik çizgi bulunan UI yoluna yönlendirme",
          },
        },
      },
    },
    "/api/auth/sign-up/email": {
      post: {
        tags: ["auth"],
        operationId: "signUpEmail",
        summary: "E-posta ve şifreyle kayıt",
        ...requiredRole(
          "yok",
          "BetterAuth üzerinden üye hesabı oluşturur; KVKK ve gizlilik onayları zorunludur",
          false,
        ),
        requestBody: jsonBody(signUpRequestSchema),
        responses: {
          "200": jsonResponse("Kullanıcı oluşturuldu", signUpResponseSchema),
          "400": authErrorResponse,
          "422": authErrorResponse,
          "429": authErrorResponse,
        },
      },
    },
    "/api/auth/sign-in/email": {
      post: {
        tags: ["auth"],
        operationId: "signInEmail",
        summary: "E-posta ve şifreyle giriş",
        ...requiredRole(
          "yok",
          "BetterAuth oturumu açar ve session çerezini yazar",
          false,
        ),
        requestBody: jsonBody(signInRequestSchema),
        responses: {
          "200": jsonResponse("Oturum açıldı", signInResponseSchema),
          "401": authErrorResponse,
          "403": authErrorResponse,
          "429": authErrorResponse,
        },
      },
    },
    "/api/auth/sign-out": {
      post: {
        tags: ["auth"],
        operationId: "signOut",
        summary: "Oturumu kapat",
        ...requiredRole(
          "oturum açmış kullanıcı (admin | staff | member)",
          "BetterAuth mevcut session çerezini iptal eder",
        ),
        responses: {
          "200": jsonResponse("Oturum kapatıldı", otpSuccessSchema),
          "401": authErrorResponse,
        },
      },
    },
    "/api/auth/email-otp/send-verification-otp": {
      post: {
        tags: ["auth"],
        operationId: "sendEmailVerificationOtp",
        summary: "E-posta OTP kodu gönder",
        ...requiredRole(
          "yok",
          "BetterAuth emailOTP eklentisi belirtilen amaç için altı haneli kod gönderir",
          false,
        ),
        requestBody: jsonBody(sendOtpRequestSchema),
        responses: {
          "200": jsonResponse("Kod gönderim isteği işlendi", otpSuccessSchema),
          "400": authErrorResponse,
          "429": authErrorResponse,
        },
      },
    },
    "/api/auth/email-otp/verify-email": {
      post: {
        tags: ["auth"],
        operationId: "verifyEmailOtp",
        summary: "E-posta OTP kodunu doğrula",
        ...requiredRole(
          "yok",
          "BetterAuth emailOTP eklentisi e-posta doğrulama kodunu tüketir",
          false,
        ),
        requestBody: jsonBody(verifyEmailOtpRequestSchema),
        responses: {
          "200": jsonResponse(
            "E-posta doğrulandı",
            verifyEmailOtpResponseSchema,
          ),
          "400": authErrorResponse,
          "403": authErrorResponse,
          "429": authErrorResponse,
        },
      },
    },
    "/api/auth/get-session": {
      get: {
        tags: ["auth"],
        operationId: "getSession",
        summary: "Mevcut oturumu getir",
        ...requiredRole(
          "yok; session çerezi varsa oturum döner",
          "BetterAuth mevcut oturum ve kullanıcı kaydını veya null döndürür",
          false,
        ),
        requestParams: { query: getSessionQuery },
        security: [{ sessionCookie: [] }, {}],
        responses: {
          "200": jsonResponse("Oturum veya null", getSessionResponseSchema),
        },
      },
    },
    "/api/admin/initial-password": {
      post: {
        tags: ["admin"],
        operationId: "changeInitialPassword",
        summary: "İlk giriş şifresini değiştir",
        ...requiredRole(
          "admin | staff | member",
          "Zorunlu ilk şifre değişimini tamamlar",
        ),
        requestBody: jsonBody(initialPasswordRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Şifre değiştirildi", okSchema),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/users": {
      get: {
        tags: ["admin"],
        operationId: "searchUsers",
        summary: "Kullanıcı ara",
        ...requiredRole(
          "admin | staff",
          "Telefon, e-posta, ad veya soyad ile en fazla 20 kullanıcı döndürür",
        ),
        requestParams: { query: userSearchQuery },
        responses: protectedResponses({
          "200": jsonResponse(
            "Eşleşen kullanıcılar",
            z.array(publicUserSchema),
          ),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/users/{id}/role": {
      post: {
        tags: ["admin"],
        operationId: "assignUserRole",
        summary: "Kullanıcı rolünü değiştir",
        ...requiredRole(
          "admin",
          "Hedef kullanıcıya rol atar; MFA etkin yöneticide mfaCode ve mfaMethod zorunludur",
        ),
        requestParams: { path: idPathParams },
        requestBody: jsonBody(roleRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Rol atandı", okSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "429": apiErrorResponse,
        }),
      },
    },
    "/api/admin/subscriptions": {
      post: {
        tags: ["admin"],
        operationId: "createSubscription",
        summary: "Abonelik oluştur veya uzat",
        ...requiredRole(
          "admin | staff",
          "Üyenin mevcut çizelgesinin sonuna sıralı abonelik ekler",
        ),
        requestBody: jsonBody(createSubscriptionRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse(
            "Abonelik oluşturuldu",
            createSubscriptionResponseSchema,
          ),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
    },
    "/api/admin/users/{id}/subscriptions": {
      get: {
        tags: ["admin"],
        operationId: "listUserSubscriptions",
        summary: "Kullanıcının aboneliklerini listele",
        ...requiredRole(
          "admin | staff",
          "Hedef kullanıcıya ait abonelik dönemlerini döndürür",
        ),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Abonelikler", z.array(subscriptionSchema)),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/settings": {
      get: {
        tags: ["admin"],
        operationId: "getGymSettings",
        summary: "Salon ayarlarını getir",
        ...requiredRole(
          "admin",
          "Salon ve paylaşım tespiti ayarlarını döndürür",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Salon ayarları", gymSettingsSchema),
        }),
      },
      put: {
        tags: ["admin"],
        operationId: "updateGymSettings",
        summary: "Salon ayarlarını güncelle",
        ...requiredRole(
          "admin",
          "Salon, konum, kapasite ve isteğe bağlı paylaşım ayarlarını günceller",
        ),
        requestBody: jsonBody(gymSettingsRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Ayarlar güncellendi", okSchema),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/stats": {
      get: {
        tags: ["admin"],
        operationId: "getAdminStats",
        summary: "Yönetim KPI değerlerini getir",
        ...requiredRole(
          "admin | staff",
          "Aktif üye ve yedi gün içinde yenileme bekleyen üye sayılarını döndürür",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Yönetim istatistikleri", adminStatsSchema),
        }),
      },
    },
    "/api/admin/audit": {
      get: {
        tags: ["admin"],
        operationId: "listAuditLogs",
        summary: "Denetim kayıtlarını listele",
        ...requiredRole(
          "admin",
          "Hassas işlem kayıtlarını en yeniden eskiye imleçli olarak döndürür",
        ),
        requestParams: { query: auditQuerySchema },
        responses: protectedResponses({
          "200": jsonResponse(
            "Denetim kayıtları sayfası",
            pageSchema(auditLogSchema),
          ),
        }),
      },
    },
    "/api/admin/entry-events": {
      get: {
        tags: ["admin"],
        operationId: "listEntryEvents",
        summary: "Turnike geçişlerini listele",
        ...requiredRole(
          "admin | staff",
          "İzin ve ret olaylarını en yeniden eskiye imleçli olarak döndürür",
        ),
        requestParams: { query: entryEventQuerySchema },
        responses: protectedResponses({
          "200": jsonResponse(
            "Geçiş olayları sayfası",
            pageSchema(entryEventSchema),
          ),
        }),
      },
    },
    "/api/admin/deletion-requests": {
      get: {
        tags: ["admin"],
        operationId: "listDeletionRequests",
        summary: "Hesap silme taleplerini listele",
        ...requiredRole(
          "admin",
          "KVKK silme taleplerini en yeniden eskiye imleçli olarak döndürür",
        ),
        requestParams: { query: deletionRequestQuerySchema },
        responses: protectedResponses({
          "200": jsonResponse(
            "Hesap silme talepleri sayfası",
            pageSchema(deletionRequestSchema),
          ),
        }),
      },
    },
    "/api/admin/deletion-requests/{id}/approve": {
      post: {
        tags: ["admin"],
        operationId: "approveDeletionRequest",
        summary: "Hesap silme talebini onayla",
        ...requiredRole(
          "admin",
          "Bekleyen talebi atomik olarak sahiplenir ve kullanıcı verilerini kalıcı siler",
        ),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Talep onaylandı", okSchema),
          "404": apiErrorResponse,
          "409": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
    },
    "/api/admin/deletion-requests/{id}/reject": {
      post: {
        tags: ["admin"],
        operationId: "rejectDeletionRequest",
        summary: "Hesap silme talebini reddet",
        ...requiredRole("admin", "Bekleyen KVKK silme talebini reddeder"),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Talep reddedildi", okSchema),
          "404": apiErrorResponse,
          "409": apiErrorResponse,
        }),
      },
    },
    "/api/admin/devices": {
      get: {
        tags: ["devices"],
        operationId: "listDevices",
        summary: "Turnike cihazlarını listele",
        ...requiredRole(
          "admin | staff",
          "Cihazları çevrimiçi durum ve 24 saatlik uptime ile döndürür",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Cihazlar", z.array(deviceSchema)),
        }),
      },
      post: {
        tags: ["devices"],
        operationId: "createDevice",
        summary: "Turnike cihazı oluştur",
        ...requiredRole(
          "admin",
          "Cihazı kaydeder; düz metin cihaz tokenı yalnızca bu yanıtta görünür",
        ),
        requestBody: jsonBody(createDeviceRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Cihaz oluşturuldu", deviceCreatedSchema),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/devices/{id}": {
      delete: {
        tags: ["devices"],
        operationId: "deleteDevice",
        summary: "Turnike cihazını sil",
        ...requiredRole(
          "admin",
          "Cihaz kaydını ve aktif gateway bağlantısını siler",
        ),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Cihaz silindi", okSchema),
          "404": apiErrorResponse,
        }),
      },
    },
    "/api/me/profile": {
      get: {
        tags: ["me"],
        operationId: "getMyProfile",
        summary: "Güncel profilimi getir",
        ...requiredRole(
          "admin | staff | member",
          "Rol ve güvenlik bayrakları MongoDB'den taze okunmuş profili döndürür",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Güncel profil", myProfileSchema),
        }),
      },
    },
    "/api/me/profile-photo": {
      put: {
        tags: ["me"],
        operationId: "putMyProfilePhoto",
        summary: "Profil fotoğrafımı yükle",
        ...requiredRole(
          "member",
          "Ham görsel gövdesini normalize eder ve profil fotoğrafı olarak saklar",
        ),
        requestBody: {
          required: true,
          content: {
            "image/jpeg": { schema: binaryImageSchema },
            "image/png": { schema: binaryImageSchema },
            "image/webp": { schema: binaryImageSchema },
            "application/octet-stream": { schema: binaryImageSchema },
          },
        },
        responses: protectedResponses({
          "200": jsonResponse(
            "Profil fotoğrafı güncellendi",
            profilePhotoResponseSchema,
          ),
          "400": apiErrorResponse,
          "409": apiErrorResponse,
          "413": apiErrorResponse,
          "429": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
      delete: {
        tags: ["me"],
        operationId: "deleteMyProfilePhoto",
        summary: "Profil fotoğrafımı sil",
        ...requiredRole("member", "Saklanan profil fotoğrafını kaldırır"),
        responses: protectedResponses({
          "200": jsonResponse(
            "Profil fotoğrafı kaldırıldı",
            profilePhotoResponseSchema,
          ),
          "409": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
    },
    "/api/me/subscription": {
      get: {
        tags: ["me"],
        operationId: "getMySubscription",
        summary: "Aboneliğimi getir",
        ...requiredRole(
          "admin | staff | member",
          "Oturumdaki kullanıcının etkin abonelik özetini döndürür",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Abonelik özeti", mySubscriptionSchema),
        }),
      },
    },
    "/api/me/entries": {
      get: {
        tags: ["me"],
        operationId: "getMyEntries",
        summary: "Geliş günlerimi getir",
        ...requiredRole(
          "admin | staff | member",
          "Oturumdaki kullanıcının verilen aralıktaki geliş günlerini salon saat dilimine göre gruplayarak döndürür",
        ),
        requestParams: { query: myEntriesQuery },
        responses: protectedResponses({
          "200": jsonResponse("Geliş günleri", myEntriesSchema),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/me/gate-scan": {
      post: {
        tags: ["me"],
        operationId: "scanGate",
        summary: "Turnike QR geçişi iste",
        ...requiredRole(
          "admin | staff | member",
          "Statik QR, abonelik, konum, paylaşım sinyalleri ve cihaz durumunu doğrulayıp turnikeyi açar",
        ),
        requestBody: jsonBody(gateScanRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Turnike açıldı", gateScanResponseSchema),
          "400": apiErrorResponse,
          "429": apiErrorResponse,
        }),
      },
    },
    "/api/me/occupancy": {
      get: {
        tags: ["me"],
        operationId: "getOccupancy",
        summary: "Salon doluluğunu getir",
        ...requiredRole(
          "admin | staff | member",
          "Anlık içerideki kişi sayısını ve yapılandırılmış kapasite oranını döndürür",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Salon doluluğu", occupancySchema),
        }),
      },
    },
    "/api/me/deletion-request": {
      get: {
        tags: ["me"],
        operationId: "getMyDeletionRequest",
        summary: "Hesap silme talebimi getir",
        ...requiredRole(
          "admin | staff | member",
          "Oturumdaki kullanıcının son silme talebi durumunu döndürür",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Silme talebi durumu", myDeletionRequestSchema),
        }),
      },
      post: {
        tags: ["me"],
        operationId: "createMyDeletionRequest",
        summary: "Hesap silme talebi oluştur",
        ...requiredRole(
          "member (middleware admin | staff | member kabul eder; işlem üye rolünü ayrıca denetler)",
          "Oturumdaki üye için bekleyen KVKK silme talebi oluşturur",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Talep oluşturuldu", okSchema),
          "409": apiErrorResponse,
        }),
      },
      delete: {
        tags: ["me"],
        operationId: "cancelMyDeletionRequest",
        summary: "Hesap silme talebini geri çek",
        ...requiredRole(
          "admin | staff | member",
          "Oturumdaki kullanıcının bekleyen silme talebini kaldırır",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Talep geri çekildi", okSchema),
          "404": apiErrorResponse,
        }),
      },
    },
  },
});
