import { Router } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type {
  AdminStats,
  ApiErrorCode,
  DeletionRequest,
  EntryEvent,
  GymSettings,
  PublicUser,
} from "@opengym/shared";
import { auth } from "../auth.js";
import { sendApiError } from "../apiError.js";
import {
  db,
  findGymSettings,
  gymSettingsCollection,
  toObjectId,
  userCollection,
  GYM_SETTINGS_ID,
  type GymSettingsDocument,
  type UserDocument,
} from "../db.js";
import { redis } from "../redis.js";
import { logAudit } from "../audit.js";
import { authed, requireRole } from "../middleware.js";
import { markOutside } from "../occupancy.js";
import { revokeUserSessions } from "../sessions.js";
import {
  buildProfilePhotoUrl,
  deleteUserProfilePhotoForAccountDeletion,
} from "../profilePhoto.js";
import { SHARING_DEFAULTS } from "../sharing.js";
import {
  createSequentialSubscription,
  listUserSubscriptions,
  SubscriptionLockTimeoutError,
} from "../subscriptions.js";
import { tryNormalizePhoneToE164 } from "../phone.js";
import {
  buildUserSearchFilter,
  parseUserSearchQuery,
  USER_SEARCH_LIMIT,
} from "../userSearch.js";
import {
  findActivePhoneConflictUserIds,
  reconcilePhoneConflictsAfterUserChange,
} from "../phoneBackfill.js";

export const adminRouter: Router = Router();

function toPublicUser(doc: UserDocument): PublicUser {
  return {
    id: doc._id.toString(),
    name: doc.name ?? "",
    email: doc.email ?? "",
    firstName: doc.firstName ?? "",
    lastName: doc.lastName ?? "",
    phone:
      doc.phoneE164 ?? tryNormalizePhoneToE164(doc.phone) ?? doc.phone ?? "",
    role: doc.role ?? "member",
    emailVerified: doc.emailVerified ?? false,
    twoFactorEnabled: doc.twoFactorEnabled ?? false,
    profilePhotoUrl: buildProfilePhotoUrl(
      doc.profilePhotoKey,
      doc.profilePhotoUpdatedAt,
    ),
    createdAt: doc.createdAt?.toISOString() ?? "",
  };
}

const initialPasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

// US-2: ilk giriş sonrası zorunlu şifre değişimi
adminRouter.post(
  "/initial-password",
  requireRole("admin", "staff", "member"),
  authed(async (req, res) => {
    const parsed = initialPasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(
        res,
        400,
        "PASSWORD_TOO_SHORT",
        "Yeni şifre en az 8 karakter olmalıdır.",
      );
      return;
    }
    const { currentPassword, newPassword } = parsed.data;
    try {
      await auth.api.changePassword({
        headers: fromNodeHeaders(req.headers),
        body: { currentPassword, newPassword, revokeOtherSessions: false },
      });
    } catch {
      sendApiError(
        res,
        400,
        "CURRENT_PASSWORD_INVALID",
        "Mevcut şifre hatalı.",
      );
      return;
    }
    await userCollection().updateOne(
      { _id: new ObjectId(req.user.id) },
      { $set: { mustChangePassword: false } },
    );
    await logAudit(req.user, "initial-password-changed");
    res.json({ ok: true });
  }),
);

// US-3: telefon, e-posta, ad veya soyad ile üye arama (personel + admin)
adminRouter.get("/users", requireRole("admin", "staff"), async (req, res) => {
  const query = parseUserSearchQuery(req.query.q);
  if (!query) {
    sendApiError(
      res,
      400,
      "SEARCH_QUERY_TOO_SHORT",
      "Arama için en az iki karakter girin.",
    );
    return;
  }
  const phoneE164 = tryNormalizePhoneToE164(query);
  const conflictUserIds = phoneE164
    ? await findActivePhoneConflictUserIds(phoneE164)
    : [];
  const docs = await userCollection()
    .find(buildUserSearchFilter(query, conflictUserIds))
    .limit(USER_SEARCH_LIMIT)
    .toArray();
  res.json(docs.map(toPublicUser));
});

const roleSchema = z.object({ role: z.enum(["admin", "staff", "member"]) });

const mfaSchema = z.object({
  mfaCode: z.string().min(1),
  mfaMethod: z.enum(["totp", "otp"]),
});

// US-3: rol atama (yalnızca admin) — çağıranın MFA'sı etkinse ek doğrulama gerekir
adminRouter.post(
  "/users/:id/role",
  requireRole("admin"),
  authed(async (req, res) => {
    const idParam = String(req.params.id ?? "");
    const targetId = toObjectId(idParam);
    const parsedRole = roleSchema.safeParse(req.body ?? {});
    if (!targetId || !parsedRole.success) {
      sendApiError(
        res,
        400,
        "INVALID_USER_OR_ROLE",
        "Geçersiz kullanıcı veya rol.",
      );
      return;
    }
    const { role } = parsedRole.data;
    // ObjectId.equals ile karşılaştır: ham string eşitliği kanonik olmayan
    // hex (ör. büyük harf) girdisinde kendi rolünü değiştirme korumasını atlatır
    if (targetId.equals(req.user.id)) {
      sendApiError(
        res,
        400,
        "SELF_ROLE_CHANGE",
        "Kendi rolünüzü değiştiremezsiniz.",
      );
      return;
    }

    // MFA etkin adminler için rol atama, TOTP veya OTP ile ek doğrulama gerektirir
    let mfaVerified = false;
    if (req.user.twoFactorEnabled) {
      const parsedMfa = mfaSchema.safeParse(req.body);
      if (!parsedMfa.success) {
        sendApiError(
          res,
          403,
          "MFA_REQUIRED",
          "Bu işlem için MFA doğrulaması gerekli.",
        );
        return;
      }
      const { mfaCode, mfaMethod } = parsedMfa.data;

      // Kaba kuvvet kilidi: BetterAuth'un HTTP hız sınırı doğrudan auth.api.*
      // çağrılarını KAPSAMAZ — deneme sayacı burada tutulur (15 dk / 5 hatalı kod)
      const mfaFailKey = `og:mfa-fail:${req.user.id}`;
      const failCount = Number((await redis.get(mfaFailKey)) ?? 0);
      if (failCount >= 5) {
        sendApiError(
          res,
          429,
          "MFA_LOCKED",
          "Çok fazla hatalı kod denemesi. 15 dakika sonra tekrar deneyin.",
        );
        return;
      }

      try {
        const headers = fromNodeHeaders(req.headers);
        if (mfaMethod === "totp") {
          await auth.api.verifyTOTP({ body: { code: mfaCode }, headers });
        } else {
          await auth.api.verifyTwoFactorOTP({
            body: { code: mfaCode },
            headers,
          });
        }
        mfaVerified = true;
        await redis.del(mfaFailKey);
      } catch {
        const fails = await redis.incr(mfaFailKey);
        if (fails === 1) {
          await redis.expire(mfaFailKey, 900);
        }
        sendApiError(
          res,
          403,
          "MFA_INVALID",
          "Doğrulama kodu geçersiz veya süresi dolmuş.",
        );
        return;
      }
    }

    const result = await userCollection().findOneAndUpdate(
      { _id: targetId },
      { $set: { role } },
    );
    if (!result) {
      sendApiError(res, 404, "USER_NOT_FOUND", "Kullanıcı bulunamadı.");
      return;
    }
    await logAudit(req.user, "role-assigned", idParam, {
      previousRole: result.role ?? "member",
      newRole: role,
      mfaVerified,
    });
    res.json({ ok: true });
  }),
);

const createSubscriptionSchema = z
  .object({
    userId: z.string(),
    months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

// US-6: abonelik tanımlama/uzatma (personel + admin)
adminRouter.post(
  "/subscriptions",
  requireRole("admin", "staff"),
  authed(async (req, res) => {
    const parsed = createSubscriptionSchema.safeParse(req.body ?? {});
    const targetId = parsed.success ? toObjectId(parsed.data.userId) : null;
    if (!parsed.success || !targetId) {
      sendApiError(
        res,
        400,
        "INVALID_SUBSCRIPTION",
        "Geçerli kullanıcı ve abonelik paketi girin.",
      );
      return;
    }
    const target = await userCollection().findOne({ _id: targetId });
    if (!target) {
      sendApiError(res, 404, "USER_NOT_FOUND", "Kullanıcı bulunamadı.");
      return;
    }
    try {
      const created = await createSequentialSubscription({
        userId: targetId,
        months: parsed.data.months,
        note: parsed.data.note || null,
        createdBy: req.user.id,
      });
      await logAudit(req.user, "subscription-created", parsed.data.userId, {
        months: parsed.data.months,
        startsAt: created.startsAt.toISOString(),
        endsAt: created.endsAt.toISOString(),
        subscriptionId: created.id.toHexString(),
      });
      res.json({
        ok: true,
        id: created.id.toHexString(),
        startsAt: created.startsAt.toISOString(),
        endsAt: created.endsAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof SubscriptionLockTimeoutError) {
        sendApiError(
          res,
          503,
          "SUBSCRIPTION_BUSY",
          "Abonelik işlemi sürüyor. Lütfen tekrar deneyin.",
        );
        return;
      }
      throw error;
    }
  }),
);

adminRouter.get(
  "/users/:id/subscriptions",
  requireRole("admin", "staff"),
  async (req, res) => {
    const targetId = toObjectId(String(req.params.id ?? ""));
    if (!targetId) {
      sendApiError(res, 400, "INVALID_USER", "Geçersiz kullanıcı.");
      return;
    }
    const docs = await listUserSubscriptions(targetId);
    res.json(
      docs.map((d) => ({
        id: d._id.toString(),
        userId: d.userId.toString(),
        startsAt: d.startsAt.toISOString(),
        endsAt: d.endsAt.toISOString(),
        note: d.note ?? undefined,
        createdBy: d.createdBy,
        createdAt: d.createdAt.toISOString(),
      })),
    );
  },
);

// Kurulum sihirbazı: salon ayarları (yalnızca admin)
adminRouter.get("/settings", requireRole("admin"), async (_req, res) => {
  const doc = await findGymSettings();
  const settings: GymSettings = {
    gymName: doc?.gymName ?? "",
    location: doc?.location ?? null,
    capacity: doc?.capacity ?? null,
    autoExitHours: doc?.autoExitHours ?? 4,
    sharing: { ...SHARING_DEFAULTS, ...(doc?.sharing ?? {}) },
  };
  res.json(settings);
});

const sharingSchema = z.object({
  memberMaxSessions: z.number().int().min(1).max(10),
  staffMaxSessions: z.number().int().min(1).max(20),
  signalThreshold: z.number().int().min(1).max(20),
  signalWindowHours: z.number().int().min(1).max(168),
  qrBlockHours: z.number().int().min(1).max(168),
});

// Kurulum sihirbazı sayısal alanları form girdisi olarak (string) de gönderebilir;
// coerce eski elle yazılmış Number() dönüşümüyle aynı davranışı korur.
const gymSettingsSchema = z.object({
  gymName: z.string().trim().min(1),
  location: z
    .object({
      lat: z.coerce.number().finite(),
      lng: z.coerce.number().finite(),
      radiusM: z.coerce.number().finite().positive(),
    })
    .nullish(),
  capacity: z.coerce.number().finite().positive().nullish(),
  autoExitHours: z.coerce.number().int().min(1).max(48).nullish(),
  // Faz 6: paylaşım tespiti ayarları yalnızca istek gövdesinde mevcutsa
  // güncellenir — mevcut ayarlanmış değerleri sessizce ezmemesi kritiktir
  sharing: sharingSchema.optional(),
});

// İstemciler mesajı değil code'u yorumlar; her alan kendi kararlı kodunu korur
const SETTINGS_FIELD_ERRORS: Record<string, [ApiErrorCode, string]> = {
  gymName: ["GYM_NAME_REQUIRED", "Salon adı zorunludur."],
  location: ["INVALID_LOCATION", "Geçersiz konum bilgisi."],
  capacity: ["INVALID_CAPACITY", "Geçersiz kapasite."],
  autoExitHours: ["INVALID_AUTO_EXIT", "Geçersiz otomatik çıkış süresi."],
  sharing: ["INVALID_SHARING_SETTINGS", "Geçersiz paylaşım tespiti ayarları."],
};

adminRouter.put(
  "/settings",
  requireRole("admin"),
  authed(async (req, res) => {
    const parsed = gymSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? "");
      const [code, message] = SETTINGS_FIELD_ERRORS[field] ?? [
        "GYM_NAME_REQUIRED",
        "Salon adı zorunludur.",
      ];
      sendApiError(res, 400, code, message);
      return;
    }
    const { gymName, location, capacity, autoExitHours, sharing } = parsed.data;

    const setDoc: Partial<Omit<GymSettingsDocument, "_id">> = {
      gymName,
      location: location ?? null,
      capacity: capacity ?? null,
      autoExitHours: autoExitHours ?? 4,
    };
    if (sharing !== undefined) {
      setDoc.sharing = sharing;
    }

    await gymSettingsCollection().updateOne(
      { _id: GYM_SETTINGS_ID },
      { $set: setDoc },
      { upsert: true },
    );
    await logAudit(req.user, "settings-updated", undefined, {
      gymName,
      autoExitHours: setDoc.autoExitHours,
      ...(sharing !== undefined ? { sharing } : {}),
    });
    res.json({ ok: true });
  }),
);

// Genel bakış paneli KPI'ları (personel + admin)
adminRouter.get("/stats", requireRole("admin", "staff"), async (_req, res) => {
  const now = new Date();
  const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const subs = db.collection("subscriptions");
  const [activeMembers, renewalsDue] = await Promise.all([
    subs.distinct("userId", { startsAt: { $lte: now }, endsAt: { $gte: now } }),
    subs.distinct("userId", {
      startsAt: { $lte: now },
      endsAt: { $gte: now, $lte: in7d },
    }),
  ]);
  const body: AdminStats = {
    activeMembers: activeMembers.length,
    renewalsDue: renewalsDue.length,
  };
  res.json(body);
});

// Audit log görüntüleme (yalnızca admin)
adminRouter.get("/audit", requireRole("admin"), async (_req, res) => {
  const docs = await db
    .collection("audit_logs")
    .find({})
    .sort({ at: -1 })
    .limit(100)
    .toArray();
  res.json(
    docs.map((d) => ({
      id: d._id.toString(),
      actorId: d.actorId,
      actorEmail: d.actorEmail,
      action: d.action,
      targetId: d.targetId ?? undefined,
      details: d.details ?? undefined,
      at: d.at.toISOString(),
    })),
  );
});

// Faz 4: turnike geçiş olayları (izin/red) — personel + admin
adminRouter.get(
  "/entry-events",
  requireRole("admin", "staff"),
  async (_req, res) => {
    const docs = await db
      .collection("entry_events")
      .find({})
      .sort({ at: -1 })
      .limit(100)
      .toArray();
    const body: EntryEvent[] = docs.map((d) => ({
      id: d._id.toString(),
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      userId: d.userId ?? null,
      memberName: d.memberName ?? null,
      allowed: d.allowed,
      reason: d.reason ?? null,
      at: d.at.toISOString(),
    }));
    res.json(body);
  },
);

// Faz 5 — KVKK: bekleyen hesap silme talepleri listesi (yalnızca admin)
adminRouter.get(
  "/deletion-requests",
  requireRole("admin"),
  async (_req, res) => {
    const docs = await db
      .collection("deletion_requests")
      .find({})
      .sort({ requestedAt: -1 })
      .limit(100)
      .toArray();
    const body: DeletionRequest[] = docs.map((d) => ({
      id: d._id.toString(),
      userId: (d.userId as ObjectId).toString(),
      email: d.email ?? "",
      name: d.name ?? "",
      requestedAt: d.requestedAt.toISOString(),
      status: d.status,
      resolvedAt: d.resolvedAt ? new Date(d.resolvedAt).toISOString() : null,
      resolvedBy: d.resolvedBy ?? null,
    }));
    res.json(body);
  },
);

// KVKK: silme talebini onaylar — üyeyi ve tüm ilişkili verilerini kalıcı olarak siler
adminRouter.post(
  "/deletion-requests/:id/approve",
  requireRole("admin"),
  authed(async (req, res) => {
    const requestId = toObjectId(String(req.params.id ?? ""));
    if (!requestId) {
      sendApiError(
        res,
        404,
        "DELETION_REQUEST_NOT_FOUND",
        "Silme talebi bulunamadı.",
      );
      return;
    }
    // TOCTOU koruması: talebi pending→approved atomik olarak sahiplen. İki
    // admin aynı anda onaylarsa yalnızca biri eşleşir; diğeri 409 alır
    // (mükerrer denetim kaydı ve işlem tekrarı önlenir).
    const claimed = await db.collection("deletion_requests").findOneAndUpdate(
      { _id: requestId, status: "pending" },
      {
        $set: {
          status: "approved",
          resolvedAt: new Date(),
          resolvedBy: req.user.id,
        },
      },
      { returnDocument: "after" },
    );
    if (!claimed) {
      const existing = await db
        .collection("deletion_requests")
        .findOne({ _id: requestId }, { projection: { _id: 1 } });
      sendApiError(
        res,
        existing ? 409 : 404,
        existing ? "DELETION_REQUEST_RESOLVED" : "DELETION_REQUEST_NOT_FOUND",
        existing
          ? "Silme talebi zaten sonuçlandırılmış."
          : "Silme talebi bulunamadı.",
      );
      return;
    }
    const targetId = claimed.userId as ObjectId;
    const targetIdStr = targetId.toString();

    // Kullanıcının tüm oturumları (Redis + Mongo) iptal edilir; uygulama
    // rotaları zaten middleware'in Mongo re-read'iyle 401'e düşer
    await revokeUserSessions(targetIdStr);

    try {
      await deleteUserProfilePhotoForAccountDeletion(targetIdStr);
    } catch (error) {
      console.error("KVKK profil fotoğrafı silinemedi", error);
      // Temizlik başarısız: talebi pending'e geri al ki yönetici yeniden
      // deneyebilsin (fail-closed — kullanıcı verisi henüz silinmedi)
      await db.collection("deletion_requests").updateOne(
        { _id: requestId },
        {
          $set: { status: "pending" },
          $unset: { resolvedAt: "", resolvedBy: "" },
        },
      );
      sendApiError(
        res,
        503,
        "DELETION_CLEANUP_FAILED",
        "Profil fotoğrafı depolama alanından silinemedi. Lütfen tekrar deneyin.",
      );
      return;
    }

    await userCollection().deleteOne({ _id: targetId });
    await db.collection("account").deleteMany({ userId: targetId });
    await db.collection("subscriptions").deleteMany({ userId: targetId });
    await db.collection("twoFactor").deleteMany({ userId: targetId });
    await markOutside(targetIdStr);
    // Geçmiş turnike kayıtları istatistik için tutulur, ancak kişisel veri
    // (KVKK) taşımamalıdır
    await db
      .collection("entry_events")
      .updateMany(
        { userId: targetIdStr },
        { $set: { userId: null, memberName: null } },
      );
    // Audit kayıtlarında da silinen üyenin e-postası kalmamalı (unutulma hakkı);
    // eylem geçmişi actorId üzerinden anonim olarak korunur
    await db
      .collection("audit_logs")
      .updateMany({ actorId: targetIdStr }, { $set: { actorEmail: null } });

    // Kullanıcının TÜM talepleri (önceki reddedilenler dahil) PII taşımamalı.
    // Bu talebin status/resolvedAt/resolvedBy alanları başta atomik olarak
    // sahiplenilirken zaten yazıldı; burada yalnızca PII temizlenir.
    await db
      .collection("deletion_requests")
      .updateMany({ userId: targetId }, { $set: { email: null, name: null } });

    // Mükerrer telefon çatışma kayıtlarından silinen kullanıcının PII'sini
    // kaldırır; tek hesap kaldıysa onu E.164'e taşıyıp çatışma kaydını siler.
    await reconcilePhoneConflictsAfterUserChange(targetIdStr);

    await logAudit(req.user, "kvkk-deletion-approved", targetIdStr);
    res.json({ ok: true });
  }),
);

// KVKK: silme talebini reddeder
adminRouter.post(
  "/deletion-requests/:id/reject",
  requireRole("admin"),
  authed(async (req, res) => {
    const requestId = toObjectId(String(req.params.id ?? ""));
    if (!requestId) {
      sendApiError(
        res,
        404,
        "DELETION_REQUEST_NOT_FOUND",
        "Silme talebi bulunamadı.",
      );
      return;
    }
    const request = await db
      .collection("deletion_requests")
      .findOne({ _id: requestId });
    if (!request) {
      sendApiError(
        res,
        404,
        "DELETION_REQUEST_NOT_FOUND",
        "Silme talebi bulunamadı.",
      );
      return;
    }
    if (request.status !== "pending") {
      sendApiError(
        res,
        409,
        "DELETION_REQUEST_RESOLVED",
        "Silme talebi zaten sonuçlandırılmış.",
      );
      return;
    }
    await db.collection("deletion_requests").updateOne(
      { _id: requestId },
      {
        $set: {
          status: "rejected",
          resolvedAt: new Date(),
          resolvedBy: req.user.id,
        },
      },
    );
    await logAudit(
      req.user,
      "kvkk-deletion-rejected",
      (request.userId as ObjectId).toString(),
    );
    res.json({ ok: true });
  }),
);
