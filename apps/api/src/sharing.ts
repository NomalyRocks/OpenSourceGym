import { ObjectId } from "mongodb";
import type { SharingConfig, SharingSignalKind } from "@opengym/shared";
import {
  db,
  findGymSettings,
  sessionCollection,
  userCollection,
} from "./db.js";
import { redis } from "./redis.js";
import { logAudit } from "./audit.js";
import { revokeUserSessions } from "./sessions.js";

// Faz 6 — Hesap paylaşımı tespiti: varsayılan ayarlar (settings.sharing ile
// ezilebilir). Bu modül sharing.ts, sessions.ts, audit.ts ve db/redis
// dışında hiçbir şey import ETMEMELİDİR — auth.ts'in databaseHooks'undan
// çağrılır, auth.ts'e geri import döngüsü oluşturmamalı.
export const SHARING_DEFAULTS: SharingConfig = {
  memberMaxSessions: 2,
  staffMaxSessions: 5,
  signalThreshold: 3,
  signalWindowHours: 24,
  qrBlockHours: 24,
};

export const QR_BLOCK_KEY = (userId: string): string => `og:qr-block:${userId}`;
export const QR_LOC_KEY = (userId: string): string => `og:qr-loc:${userId}`;

// settings._id: "gym" tekil belgesindeki opsiyonel "sharing" alt nesnesi,
// varsayılanların üzerine sığ (shallow) olarak birleştirilir
export async function getSharingConfig(): Promise<SharingConfig> {
  const doc = await findGymSettings();
  return { ...SHARING_DEFAULTS, ...(doc?.sharing ?? {}) };
}

export async function isQrBlocked(userId: string): Promise<boolean> {
  return (await redis.exists(QR_BLOCK_KEY(userId))) === 1;
}

// audit_logs süresiz saklanır (sharing_signals ise 30 gün TTL'lidir) — konum
// gibi hassas alanlar audit'e değil, yalnızca TTL'li sinyal kaydına yazılır
const AUDIT_OMIT_META_KEYS = new Set(["lat", "lng"]);

function redactMetaForAudit(
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  if (!meta) return {};
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!AUDIT_OMIT_META_KEYS.has(key)) redacted[key] = value;
  }
  return redacted;
}

// Bir hesap paylaşımı şüphesi sinyalini kaydeder; tespit sinyallerinin hiçbiri
// isteği asla başarısız kılmamalıdır — bu yüzden tüm gövde try/catch içindedir
export async function recordSharingSignal(
  actor: { id: string; email: string },
  kind: SharingSignalKind,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.collection("sharing_signals").insertOne({
      userId: new ObjectId(actor.id),
      kind,
      meta: meta ?? null,
      at: new Date(),
    });
    await logAudit(actor, "sharing-signal", actor.id, {
      kind,
      ...redactMetaForAudit(meta),
    });

    // Eskalasyon: pencere içinde eşik sayıda sinyal birikince QR üretimi
    // otomatik olarak engellenir ve tüm oturumlar iptal edilir
    const cfg = await getSharingConfig();
    const since = new Date(Date.now() - cfg.signalWindowHours * 3600_000);
    const signalCount = await db.collection("sharing_signals").countDocuments({
      userId: new ObjectId(actor.id),
      at: { $gte: since },
    });
    if (signalCount >= cfg.signalThreshold) {
      const acquired = await redis.set(QR_BLOCK_KEY(actor.id), "1", {
        condition: "NX",
        expiration: { type: "EX", value: cfg.qrBlockHours * 3600 },
      });
      // Yalnızca engel bu çağrıyla İLK KEZ kurulduysa (NX başarılıysa)
      // oturumlar iptal edilir ve olay denetim kaydına yazılır — aksi halde
      // aynı pencere içindeki her yeni sinyal tekrar tekrar tetiklenir
      if (acquired === "OK") {
        await revokeUserSessions(actor.id);
        await logAudit(actor, "account-sharing-blocked", actor.id, {
          signalCount,
          windowHours: cfg.signalWindowHours,
          blockHours: cfg.qrBlockHours,
        });
      }
    }
  } catch (err) {
    console.error("recordSharingSignal başarısız oldu:", err);
  }
}

// Oturum oluşturma sonrası (session.create.after) çağrılır: eşzamanlı oturum
// üst sınırını uygular (en eski oturum sessizce atılır) ve parmak izi
// (fingerprint) churn'ünü tespit eder. Bir auth hook'undan çağrıldığı için
// ASLA fırlatmamalıdır (throw), aksi halde girişi bozar.
export async function enforceSessionPolicy(session: {
  userId: string;
}): Promise<void> {
  try {
    const cfg = await getSharingConfig();
    const userDoc = await userCollection().findOne({
      _id: new ObjectId(session.userId),
    });
    if (!userDoc) return;
    const role = userDoc.role ?? "member";
    const cap =
      role === "member" ? cfg.memberMaxSessions : cfg.staffMaxSessions;

    const sessions = await sessionCollection()
      .find({ userId: new ObjectId(session.userId) })
      .sort({ createdAt: -1 })
      .toArray();

    // Churn kontrolü ÖNCE yapılır (eviction'dan önce), böylece az sonra
    // atılacak oturumlar da parmak izi sayımına dahil olur. Eşik role göre
    // ayarlanan oturum sınırına (cap) görecelidir — sabit bir sayı personel/
    // admin (cap 5) için meşru çoklu cihaz kullanımını yanlış pozitif
    // işaretlerdi (üye cap'i 2 için sabit 3 uygundu, personel için değildi)
    const distinctFingerprints = new Set(
      sessions
        .map((s) => s.deviceFingerprint)
        .filter((fp): fp is string => typeof fp === "string" && fp.length > 0),
    );
    if (distinctFingerprints.size > cap) {
      const churnKey = `og:fp-churn:${session.userId}`;
      const acquired = await redis.set(churnKey, "1", {
        condition: "NX",
        expiration: { type: "EX", value: 3600 },
      });
      if (acquired === "OK") {
        await recordSharingSignal(
          { id: session.userId, email: userDoc.email },
          "fingerprint-churn",
          { distinctFingerprints: distinctFingerprints.size },
        );
      }
    }

    // Eviction: kapasiteyi aşan fazlalık en eski oturumlardır (sessions
    // createdAt'e göre azalan sıralı, cap indeksinden itibaren kalanlar)
    if (sessions.length > cap) {
      const excess = sessions.slice(cap);
      const excessIds = excess.map((s) => s._id);
      for (const doc of excess) {
        if (doc.token) {
          await redis.del(doc.token).catch(console.error);
        }
      }
      await sessionCollection().deleteMany({ _id: { $in: excessIds } });

      // "active-sessions-<userId>" listesi hayatta kalan oturumlarla YENİDEN
      // YAZILIR, silinmez: BetterAuth'un kendi oturum yönetimi (listSessions,
      // deleteUserSessions, revokeSessionsOnPasswordReset) bu listeyi referans
      // alır — listeyi tamamen silmek hayatta kalan oturumların Redis
      // kayıtlarını BetterAuth için görünmez (öksüz) bırakır. Girdi biçimi
      // BetterAuth internal-adapter'ıyla birebir aynıdır:
      // [{token, expiresAt(ms)}], expiresAt'e göre artan sıralı, anahtar
      // TTL'i en geç dolan oturuma göre
      const now = Date.now();
      const survivors = sessions
        .slice(0, cap)
        .map((doc) => ({
          token: doc.token ?? "",
          expiresAt:
            doc.expiresAt instanceof Date ? doc.expiresAt.getTime() : 0,
        }))
        .filter((entry) => entry.token && entry.expiresAt > now)
        .sort((a, b) => a.expiresAt - b.expiresAt);
      const listKey = `active-sessions-${session.userId}`;
      if (survivors.length > 0) {
        const lastSurvivor = survivors[survivors.length - 1]!;
        const ttlSeconds = Math.floor((lastSurvivor.expiresAt - now) / 1000);
        await redis
          .set(listKey, JSON.stringify(survivors), {
            expiration: { type: "EX", value: ttlSeconds },
          })
          .catch(console.error);
      } else {
        await redis.del(listKey).catch(console.error);
      }
    }
  } catch (err) {
    console.error("enforceSessionPolicy başarısız oldu:", err);
  }
}
