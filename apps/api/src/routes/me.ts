import express, { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type {
  GateRejectCode,
  GateScanResponse,
  MyBodyMetrics,
  MyDeletionRequest,
  MyEntriesResponse,
  MySubscription,
  MyWeightHistoryResponse,
  OccupancyResponse,
  ProfilePhotoResponse,
} from "@opengym/shared";
import {
  db,
  findGymSettings,
  isDuplicateKeyError,
  userCollection,
} from "../db.js";
import {
  AGE_RANGE,
  buildBodyMetricsUpdate,
  HEIGHT_CM_RANGE,
  WEIGHT_KG_RANGE,
} from "../bodyMetrics.js";
import { env } from "../env.js";
import {
  DAY_LABEL_PATTERN,
  dayLabelSpan,
  entryQueryWindow,
  MAX_ENTRY_RANGE_DAYS,
  toEntryDays,
} from "../entryDays.js";
import {
  listWeightHistory,
  recordWeightHistoryIfChanged,
} from "../weightHistory.js";
import { sendApiError } from "../apiError.js";
import { acquireLock, redis, releaseLock } from "../redis.js";
import { authed, requireRole, type AuthedRequest } from "../middleware.js";
import { distanceMeters } from "../geo.js";
import { verifyGateQr } from "../gateQr.js";
import {
  getSubscriptionSummary,
  hasActiveSubscription,
} from "../subscriptions.js";
import { openDevice } from "../gateway.js";
import { getOccupancy, markInside, markOutside } from "../occupancy.js";
import { enqueueEntryEvent } from "../eventQueue.js";
import { logAudit } from "../audit.js";
import { isQrBlocked, recordSharingSignal, QR_LOC_KEY } from "../sharing.js";
import {
  ProfilePhotoBusyError,
  ProfilePhotoConfigError,
  ProfilePhotoInputError,
  ProfilePhotoRateLimitError,
  removeUserProfilePhoto,
  storeUserProfilePhoto,
} from "../profilePhoto.js";

export const meRouter: Router = Router();

// Oturumdaki kullanıcının güncel profili (rol/bayrak DB'den taze okunur)
meRouter.get(
  "/profile",
  requireRole("admin", "staff", "member"),
  authed((req, res) => {
    res.json(req.user);
  }),
);

// Üyenin kendi profil fotoğrafı: API görseli normalize edip R2'ye yazar.
meRouter.put(
  "/profile-photo",
  requireRole("member"),
  express.raw({ type: "*/*", limit: "10mb" }),
  authed(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      sendApiError(
        res,
        400,
        "PROFILE_PHOTO_MISSING",
        "Fotoğraf verisi gönderilmedi.",
      );
      return;
    }
    try {
      const profilePhotoUrl = await storeUserProfilePhoto(
        req.user.id,
        req.body,
        req.header("content-type") ?? "",
      );
      await logAudit(req.user, "profile-photo-updated", req.user.id);
      const body: ProfilePhotoResponse = { profilePhotoUrl };
      res.json(body);
    } catch (error) {
      if (error instanceof ProfilePhotoInputError) {
        sendApiError(res, 400, "PROFILE_PHOTO_INVALID", error.message);
        return;
      }
      if (error instanceof ProfilePhotoBusyError) {
        sendApiError(res, 409, "PROFILE_PHOTO_BUSY", error.message);
        return;
      }
      if (error instanceof ProfilePhotoRateLimitError) {
        sendApiError(res, 429, "PROFILE_PHOTO_RATE_LIMITED", error.message);
        return;
      }
      if (error instanceof ProfilePhotoConfigError) {
        sendApiError(res, 503, "PROFILE_PHOTO_UNAVAILABLE", error.message);
        return;
      }
      console.error("Profil fotoğrafı yüklenemedi", error);
      sendApiError(
        res,
        503,
        "PROFILE_PHOTO_UNAVAILABLE",
        "Profil fotoğrafı yüklenemedi. Lütfen tekrar deneyin.",
      );
    }
  }),
);

meRouter.delete(
  "/profile-photo",
  requireRole("member"),
  authed(async (req, res) => {
    try {
      await removeUserProfilePhoto(req.user.id);
      await logAudit(req.user, "profile-photo-removed", req.user.id);
      const body: ProfilePhotoResponse = { profilePhotoUrl: null };
      res.json(body);
    } catch (error) {
      if (error instanceof ProfilePhotoBusyError) {
        sendApiError(res, 409, "PROFILE_PHOTO_BUSY", error.message);
        return;
      }
      if (error instanceof ProfilePhotoConfigError) {
        sendApiError(res, 503, "PROFILE_PHOTO_UNAVAILABLE", error.message);
        return;
      }
      console.error("Profil fotoğrafı kaldırılamadı", error);
      sendApiError(
        res,
        503,
        "PROFILE_PHOTO_UNAVAILABLE",
        "Profil fotoğrafı kaldırılamadı. Lütfen tekrar deneyin.",
      );
    }
  }),
);

// US-4: üyenin kendi abonelik durumu (mobil ana ekran)
meRouter.get(
  "/subscription",
  requireRole("admin", "staff", "member"),
  authed(async (req, res) => {
    const body: MySubscription = await getSubscriptionSummary(req.user.id);
    res.json(body);
  }),
);

const myEntriesQuerySchema = z.object({
  from: z.string().regex(DAY_LABEL_PATTERN),
  to: z.string().regex(DAY_LABEL_PATTERN),
});

/**
 * Mobil takvimin geliş katmanı: üyenin KENDİ geçiş günleri.
 *
 * Yalnızca izin verilen ve giriş yönündeki taramalar sayılır — çıkış turnikesi
 * taraması aynı güne ikinci bir geliş gibi yazılırdı. Yön artık taranan anda
 * `entry_events.direction` olarak kalıcı yazılır (cihaz sonradan silinse de
 * geçmiş kayıt doğru sınıflandırılmış kalır). Bu alan eklenmeden ÖNCE yazılmış
 * eski kayıtlarda `direction` yoktur; onlar için tek seferlik geriye dönük
 * uyum olarak hâlâ mevcut cihazların kimlik listesine bakılır.
 */
meRouter.get(
  "/entries",
  requireRole("admin", "staff", "member"),
  authed(async (req, res) => {
    const query = myEntriesQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(res, 400, "INVALID_REQUEST", "Geçersiz tarih aralığı.");
      return;
    }
    const { from, to } = query.data;
    const span = dayLabelSpan(from, to);
    if (!Number.isFinite(span) || span < 0 || span > MAX_ENTRY_RANGE_DAYS) {
      sendApiError(res, 400, "INVALID_REQUEST", "Geçersiz tarih aralığı.");
      return;
    }

    const timeZone = env.reportsTimeZone;
    const { start, end } = entryQueryWindow(from, to);

    const outDevices = await db
      .collection("devices")
      .find({ direction: "out" }, { projection: { _id: 1 } })
      .toArray();
    const outDeviceIds = outDevices.map((device) => device._id.toString());

    const rows = await db
      .collection("entry_events")
      .aggregate<{ _id: string; entries: number }>([
        {
          $match: {
            userId: req.user.id,
            allowed: true,
            at: { $gte: start, $lte: end },
            $or: [
              // Yön kalıcı yazılmış (güncel kayıt) — cihaz silinmiş olsa da geçerli.
              { direction: "in" },
              // Eski kayıt: yön yok, mevcut cihaz kimlik listesine bakılır.
              {
                direction: { $exists: false },
                ...(outDeviceIds.length > 0
                  ? { deviceId: { $nin: outDeviceIds } }
                  : {}),
              },
            ],
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                date: "$at",
                format: "%Y-%m-%d",
                timezone: timeZone,
              },
            },
            entries: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const body: MyEntriesResponse = {
      days: toEntryDays(rows, from, to),
      timeZone,
    };
    res.json(body);
  }),
);

// Mobil takvimin kilo katmanı: weightKg her değiştiğinde eklenen geçmiş.
meRouter.get(
  "/weight-history",
  requireRole("admin", "staff", "member"),
  authed(async (req, res) => {
    const entries = await listWeightHistory(req.user.id);
    const body: MyWeightHistoryResponse = {
      entries: entries.map((entry) => ({
        weightKg: entry.weightKg,
        at: entry.at.toISOString(),
      })),
    };
    res.json(body);
  }),
);

// Üyenin kendi yaş/boy/kilosu. BetterAuth'un `update-user` ucu yerine burada
// duruyor: yazma yolu `requireRole` üzerinden geçmeli ki kullanıcı her istekte
// Mongo'dan yeniden okunsun ve `mustChangePassword` bekleyen hesaplar
// yazamasın (bkz. AGENTS.md, auth.ts additionalFields `input: false`).
const bodyMetricsSchema = z
  .object({
    age: z.number().int().min(AGE_RANGE.min).max(AGE_RANGE.max).nullable(),
    heightCm: z
      .number()
      .min(HEIGHT_CM_RANGE.min)
      .max(HEIGHT_CM_RANGE.max)
      .nullable(),
    weightKg: z
      .number()
      .min(WEIGHT_KG_RANGE.min)
      .max(WEIGHT_KG_RANGE.max)
      .nullable(),
  })
  .partial();

const BODY_METRICS_RATE_LIMIT = 10;
const BODY_METRICS_RATE_WINDOW_SECONDS = 60;
const BODY_METRICS_LOCK_TTL_MS = 5000;

/** Kilo geçmişi her değişimde büyür; yazma ucu kullanıcı başına sınırlanır. */
async function isBodyMetricsRateLimited(userId: string): Promise<boolean> {
  const key = `og:rl:body-metrics:${userId}`;
  const count = await redis.incr(key);
  await redis.expire(key, BODY_METRICS_RATE_WINDOW_SECONDS, "NX");
  return count > BODY_METRICS_RATE_LIMIT;
}

meRouter.patch(
  "/body-metrics",
  requireRole("admin", "staff", "member"),
  authed(async (req, res) => {
    const parsed = bodyMetricsSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Body metrics are missing or out of the accepted range.",
      );
      return;
    }

    // Boşluk denetimi şemadan sonra: zod `{ age: undefined }` gövdesini
    // geçirebilir ve geriye boş bir güncelleme kalır — updateOne boş belgeyle
    // hata fırlatır. Kararı üretilen güncelleme belgesine göre veriyoruz.
    const { set, unset } = buildBodyMetricsUpdate(parsed.data);
    if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "At least one body metric field must be provided.",
      );
      return;
    }

    if (await isBodyMetricsRateLimited(req.user.id)) {
      sendApiError(
        res,
        429,
        "RATE_LIMITED",
        "Too many body metric updates. Please wait a minute.",
      );
      return;
    }

    // Kilit, profil yazımı ile kilo geçmişi eklemesini tek parça yapar:
    // aynı üyenin eşzamanlı iki isteği araya girip geçmişi profildekiyle
    // çelişen bir sırayla büyütemesin.
    const lockKey = `og:lock:body-metrics:${req.user.id}`;
    const lockToken = randomUUID();
    if (!(await acquireLock(lockKey, lockToken, BODY_METRICS_LOCK_TTL_MS))) {
      sendApiError(
        res,
        429,
        "RATE_LIMITED",
        "Another body metrics update is in progress. Please retry.",
      );
      return;
    }

    try {
      const result = await userCollection().updateOne(
        { _id: new ObjectId(req.user.id) },
        {
          ...(Object.keys(set).length > 0 ? { $set: set } : {}),
          ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
        },
      );
      // Hesap silme onayı bu istekle yarışmış olabilir. Eşleşen belge yoksa
      // kullanıcı artık yok; geçmişe kayıt eklemek silinen sağlık verisini
      // yeniden yaratırdı.
      if (result.matchedCount !== 1) {
        sendApiError(res, 401, "AUTH_REQUIRED", "Account is no longer active.");
        return;
      }

      // Kilo geçmişi yalnızca gerçek bir değer yazıldığında büyür; temizleme
      // (null) geçmişe kayıt eklemez.
      if (typeof set.weightKg === "number") {
        await recordWeightHistoryIfChanged(req.user.id, set.weightKg);
      }

      // Yanıt, yalnızca bu istekte yazılanları değil güncel tam durumu döner:
      // istemci tek alan gönderdiğinde diğerlerini "temizlenmiş" sanmasın.
      const doc = await userCollection().findOne(
        { _id: new ObjectId(req.user.id) },
        { projection: { age: 1, heightCm: 1, weightKg: 1 } },
      );
      // Sağlık verisi yazımı denetlenebilir olmalı (çoğu mevzuatta özel nitelikli
      // veri). Yalnızca alan adları yazılır — audit_logs süresiz saklanır,
      // değerlerin oraya kopyalanması silme hakkını delerdi.
      await logAudit(req.user, "body-metrics-updated", req.user.id, {
        fields: [...Object.keys(set), ...Object.keys(unset)],
      });

      const body: MyBodyMetrics = {
        age: typeof doc?.age === "number" ? doc.age : null,
        heightCm: typeof doc?.heightCm === "number" ? doc.heightCm : null,
        weightKg: typeof doc?.weightKg === "number" ? doc.weightKg : null,
      };
      res.json(body);
    } finally {
      await releaseLock(lockKey, lockToken);
    }
  }),
);

const gateScanSchema = z.object({
  qr: z.string().min(1).max(200),
  lat: z.number().optional(),
  lng: z.number().optional(),
  /** Android: expo-location sahte konum (mock location) tespiti — Faz 6 */
  mocked: z.boolean().optional(),
});

const GATE_SCAN_RATE_LIMIT = 30;
const GATE_SCAN_RATE_WINDOW_SECONDS = 60;
const GATE_OPEN_LOCK_TTL_MS = 3_000;
const GATE_OPEN_MS = 500;
const LOCATION_HISTORY_TTL_SECONDS = 120;
const LOCATION_DRIFT_WINDOW_MS = 120_000;
const LOCATION_DRIFT_THRESHOLD_M = 1000;

const GEOFENCE_MESSAGES: Record<"LOCATION_REQUIRED" | "OUT_OF_RANGE", string> =
  {
    LOCATION_REQUIRED:
      "Konum bilgisi alınamadı. Konum servisini açıp tekrar deneyin.",
    OUT_OF_RANGE:
      "Salon konumunda görünmüyorsunuz. Geçiş yalnızca salonda yapılabilir.",
  };

/** Basit hız sınırı: kullanıcı başına dakikada 30 tarama isteği. */
async function isGateScanRateLimited(userId: string): Promise<boolean> {
  const key = `og:rl:gate-scan:${userId}`;
  const count = await redis.incr(key);
  // NX: TTL yalnızca yoksa yazılır; incr/expire arasında çökme olursa sonraki
  // istek TTL'i onarır (aksi halde anahtar süresiz kalıp kullanıcıyı kilitler)
  await redis.expire(key, GATE_SCAN_RATE_WINDOW_SECONDS, "NX");
  return count > GATE_SCAN_RATE_LIMIT;
}

/**
 * İsteği yapan cihazın kimliği. Ham oturum token'ı hiçbir zaman sinyal/audit
 * kaydına yazılmaz — parmak izi header'ı yoksa (ör. iOS, web) token'ın
 * SHA-256 hash'i cihaz kimliği yerine geçer (geri döndürülemez, tek yönlü).
 */
function resolveDeviceFingerprint(req: AuthedRequest): string | null {
  const headerFp = req.header("x-device-fingerprint");
  if (headerFp && /^[a-f0-9]{64}$/.test(headerFp)) return headerFp;
  return req.sessionToken
    ? createHash("sha256").update(req.sessionToken).digest("hex")
    : null;
}

/**
 * Faz 6: iki farklı cihazdan kısa aralıkla, birbirinden uzak konumlarda tarama
 * istekleri gelmesi hesap paylaşımı şüphesi olarak kaydedilir (istek
 * reddedilmez — yalnızca sinyal olarak işlenir).
 */
async function recordLocationDrift(
  req: AuthedRequest,
  lat: number,
  lng: number,
): Promise<void> {
  const fingerprintId = resolveDeviceFingerprint(req);
  const locKey = QR_LOC_KEY(req.user.id);
  const prevRaw = await redis.get(locKey);
  if (prevRaw && fingerprintId) {
    const prev = JSON.parse(prevRaw) as {
      d: string | null;
      lat: number;
      lng: number;
      at: number;
    };
    if (
      prev.d &&
      prev.d !== fingerprintId &&
      Date.now() - prev.at < LOCATION_DRIFT_WINDOW_MS
    ) {
      const distanceM = distanceMeters(prev.lat, prev.lng, lat, lng);
      if (distanceM > LOCATION_DRIFT_THRESHOLD_M) {
        await recordSharingSignal(req.user, "location-inconsistency", {
          distanceM,
          deviceId: fingerprintId,
          prevDeviceId: prev.d,
        });
      }
    }
  }
  await redis.set(
    locKey,
    JSON.stringify({ d: fingerprintId, lat, lng, at: Date.now() }),
    { expiration: { type: "EX", value: LOCATION_HISTORY_TTL_SECONDS } },
  );
}

/** Salon konumu tanımlıysa mesafe kontrolü; geçerse null döner. */
async function checkGymGeofence(
  lat: number | undefined,
  lng: number | undefined,
): Promise<"LOCATION_REQUIRED" | "OUT_OF_RANGE" | null> {
  const settings = await findGymSettings();
  const location = settings?.location;
  // Operatör konum doğrulamayı yapılandırmamışsa mesafe kontrolü atlanır
  if (!location) return null;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return "LOCATION_REQUIRED";
  }
  const distance = distanceMeters(lat, lng, location.lat, location.lng);
  return distance > location.radiusM ? "OUT_OF_RANGE" : null;
}

// US-7: üyenin turnikeye yapıştırılmış statik QR'ı okutup geçiş talep etmesi
meRouter.post(
  "/gate-scan",
  requireRole("admin", "staff", "member"),
  authed(async (req, res) => {
    const parsed = gateScanSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, 400, "INVALID_REQUEST", "Geçersiz istek.");
      return;
    }
    const { qr, lat, lng, mocked } = parsed.data;

    if (await isGateScanRateLimited(req.user.id)) {
      sendApiError(
        res,
        429,
        "RATE_LIMITED",
        "Çok fazla istek. Lütfen biraz bekleyin.",
      );
      return;
    }

    const verified = verifyGateQr(qr);
    if (!verified.ok) {
      // Cihaz çözülemedi — olay yine de denetim izine boş cihazla yazılır
      enqueueEntryEvent({
        deviceId: "",
        deviceName: "",
        userId: req.user.id,
        memberName: req.user.name,
        allowed: false,
        reason: "INVALID_QR",
        at: new Date(),
        direction: "in",
      });
      sendApiError(
        res,
        403,
        "INVALID_QR",
        "Geçersiz QR kodu. Turnikedeki kodu tekrar okutun.",
      );
      return;
    }
    const { deviceId } = verified;

    // Cihaz, sonraki tüm ret kayıtlarında adıyla görünebilsin diye reddetme
    // kontrollerinden önce okunur
    const device = await db
      .collection("devices")
      .findOne({ _id: new ObjectId(deviceId) });
    const deviceName = device ? (device.name as string) : "";
    const direction = (device?.direction as "in" | "out" | undefined) ?? "in";

    // Her ret hem yanıtı hem entry_events denetim kaydını üretir
    const deny = (reason: GateRejectCode, message: string): void => {
      enqueueEntryEvent({
        deviceId,
        deviceName,
        userId: req.user.id,
        memberName: req.user.name,
        allowed: false,
        reason,
        at: new Date(),
        direction,
      });
      sendApiError(res, 403, reason, message);
    };

    if (!device) {
      deny(
        "UNKNOWN_DEVICE",
        "Bu turnike artık kayıtlı değil. Resepsiyona başvurun.",
      );
      return;
    }

    // Faz 6: eskalasyon eşiğini aşan hesaplarda geçiş geçici olarak kapalıdır
    if (await isQrBlocked(req.user.id)) {
      deny(
        "SHARING_BLOCKED",
        "Hesabınızda olağan dışı kullanım tespit edildi. Geçiş geçici olarak kapatıldı. Lütfen resepsiyona başvurun.",
      );
      return;
    }

    // Faz 6: expo-location "mocked" bayrağı true ise sahte konum uygulaması
    // tespit edilmiştir — geçiş reddedilir. Bu kontrol salon konumu
    // yapılandırılmamış olsa bile çalışır ve konum geçmişi (QR_LOC_KEY)
    // yazılmadan ÖNCE yapılır: sahte koordinatlar konum tutarsızlığı
    // sinyalini beslememeli
    if (mocked === true) {
      await recordSharingSignal(req.user, "mock-location", { lat, lng });
      deny(
        "MOCK_LOCATION",
        "Sahte konum tespit edildi. Konum taklit uygulamalarını kapatıp tekrar deneyin.",
      );
      return;
    }

    // Çıkışta abonelik aranmaz — süresi bitmiş üye de dışarı çıkabilmeli
    if (direction === "in" && !(await hasActiveSubscription(req.user.id))) {
      deny(
        "NO_ACTIVE_SUBSCRIPTION",
        "Aktif aboneliğiniz yok. Salon resepsiyonuna başvurun.",
      );
      return;
    }

    if (typeof lat === "number" && typeof lng === "number") {
      await recordLocationDrift(req, lat, lng);
    }

    const geofenceReject = await checkGymGeofence(lat, lng);
    if (geofenceReject) {
      deny(geofenceReject, GEOFENCE_MESSAGES[geofenceReject]);
      return;
    }

    // Kısa süreli çift tarama kilidi: aynı üye+cihaz için ard arda taramalar
    const lockKey = `og:gate-open:${req.user.id}:${deviceId}`;
    const lockToken = randomUUID();
    if (!(await acquireLock(lockKey, lockToken, GATE_OPEN_LOCK_TTL_MS))) {
      sendApiError(
        res,
        429,
        "RATE_LIMITED",
        "Çok fazla istek. Lütfen biraz bekleyin.",
      );
      return;
    }

    if (!openDevice(deviceId, GATE_OPEN_MS)) {
      // Kapı açılmadı — kilit tutulmasın ki üye bağlantı gelince hemen
      // yeniden deneyebilsin
      await releaseLock(lockKey, lockToken);
      deny(
        "DEVICE_OFFLINE",
        "Turnike bağlantısı yok. Lütfen resepsiyona başvurun.",
      );
      return;
    }

    if (direction === "out") {
      await markOutside(req.user.id);
    } else {
      await markInside(req.user.id);
    }
    enqueueEntryEvent({
      deviceId,
      deviceName,
      userId: req.user.id,
      memberName: req.user.name,
      allowed: true,
      reason: null,
      at: new Date(),
      direction,
    });

    const body: GateScanResponse = {
      ok: true,
      deviceName,
      direction,
      openMs: GATE_OPEN_MS,
    };
    res.json(body);
  }),
);

// Faz 5 — US-4: anlık salon doluluğu
meRouter.get(
  "/occupancy",
  requireRole("admin", "staff", "member"),
  async (_req, res) => {
    const inside = await getOccupancy();
    const settings = await findGymSettings();
    const capacity = settings?.capacity ?? null;
    const body: OccupancyResponse = {
      inside,
      capacity,
      ratio: capacity ? Math.round((inside / capacity) * 100) / 100 : null,
    };
    res.json(body);
  },
);

// Faz 5 — Veri koruma: üyenin kendi hesap silme talebi durumu
meRouter.get(
  "/deletion-request",
  requireRole("admin", "staff", "member"),
  authed(async (req, res) => {
    const latest = await db
      .collection("deletion_requests")
      .find({ userId: new ObjectId(req.user.id) })
      .sort({ requestedAt: -1 })
      .limit(1)
      .next();
    const body: MyDeletionRequest = latest
      ? {
          status:
            latest.status === "pending"
              ? "pending"
              : latest.status === "rejected"
                ? "rejected"
                : "none",
          requestedAt: latest.requestedAt
            ? new Date(latest.requestedAt).toISOString()
            : null,
        }
      : { status: "none", requestedAt: null };
    res.json(body);
  }),
);

// Veri koruma: hesap silme talebi oluşturma — yalnızca üye rolü kendi hesabı için talep açabilir
meRouter.post(
  "/deletion-request",
  requireRole("admin", "staff", "member"),
  authed(async (req, res) => {
    if (req.user.role !== "member") {
      sendApiError(
        res,
        403,
        "DELETION_MEMBER_ONLY",
        "Only member accounts can create a deletion request.",
      );
      return;
    }
    const userId = new ObjectId(req.user.id);
    // Tekilliği garanti eden şey bu kontrol değil, deletion_requests üzerindeki
    // partial unique index'tir: "önce oku sonra yaz" atomik olmadığından
    // eşzamanlı iki istek aynı üyeye iki bekleyen talep açabilirdi. Buradaki
    // ön kontrol yalnızca yaygın durumda daha ucuz bir yol.
    const existingPending = await db
      .collection("deletion_requests")
      .findOne({ userId, status: "pending" });
    if (existingPending) {
      sendApiError(
        res,
        409,
        "DELETION_ALREADY_PENDING",
        "You already have a pending deletion request.",
      );
      return;
    }
    try {
      await db.collection("deletion_requests").insertOne({
        userId,
        email: req.user.email,
        name: req.user.name,
        requestedAt: new Date(),
        status: "pending",
        resolvedAt: null,
        resolvedBy: null,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        sendApiError(
          res,
          409,
          "DELETION_ALREADY_PENDING",
          "You already have a pending deletion request.",
        );
        return;
      }
      throw err;
    }
    await logAudit(req.user, "account-deletion-requested");
    res.json({ ok: true });
  }),
);

// Veri koruma: bekleyen silme talebini geri çekme
meRouter.delete(
  "/deletion-request",
  requireRole("admin", "staff", "member"),
  authed(async (req, res) => {
    const result = await db.collection("deletion_requests").deleteOne({
      userId: new ObjectId(req.user.id),
      status: "pending",
    });
    if (result.deletedCount === 0) {
      sendApiError(
        res,
        404,
        "DELETION_NOT_PENDING",
        "Bekleyen bir silme talebi bulunamadı.",
      );
      return;
    }
    await logAudit(req.user, "account-deletion-cancelled");
    res.json({ ok: true });
  }),
);
