export interface HealthResponse {
  status: "ok";
  service: string;
  timestamp: string;
}

/** Tek bir alt bileşenin readiness sonucu. */
export interface ReadinessCheck {
  status: "up" | "down";
  /** Yalnızca "down" durumunda doldurulur. */
  error?: string;
}

/**
 * /health/ready yanıtı. Liveness'ten (/health) ayrıdır: burada bağımlılıklar
 * gerçekten yoklanır, dolayısıyla süreç ayakta olsa da "down" dönebilir.
 */
export interface ReadinessResponse {
  status: "ok" | "degraded";
  service: string;
  timestamp: string;
  checks: {
    mongo: ReadinessCheck;
    redis: ReadinessCheck;
    entryEventConsumer: ReadinessCheck;
  };
}

/**
 * İmleç (keyset) tabanlı sayfalama zarfı. Offset yerine imleç kullanılır:
 * listeler zamana göre azalan sıradadır ve sürekli yeni kayıt eklenir, offset
 * ile sayfa atlarken kayıt tekrarlanır veya atlanırdı.
 */
export interface Page<T> {
  items: T[];
  /** Sonraki sayfa için `cursor` sorgu parametresine verilir; son sayfada null. */
  nextCursor: string | null;
}

export type Role = "admin" | "staff" | "member";

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  role: Role;
  emailVerified: boolean;
  /** MFA (iki aşamalı doğrulama) etkin mi — Faz 5 */
  twoFactorEnabled: boolean;
  profilePhotoUrl: string | null;
  createdAt: string;
}

export interface MyProfile {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  twoFactorEnabled: boolean;
  profilePhotoUrl: string | null;
}

export interface ProfilePhotoResponse {
  profilePhotoUrl: string | null;
}

export interface Subscription {
  id: string;
  userId: string;
  startsAt: string;
  endsAt: string;
  note?: string;
  createdBy: string;
  createdAt: string;
}

export type SubscriptionMonths = 1 | 3 | 6 | 12;

export interface CreateSubscriptionRequest {
  userId: string;
  months: SubscriptionMonths;
  note?: string;
}

export interface MySubscription {
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  remainingDays: number;
}

export interface GymSettings {
  gymName: string;
  location: {
    lat: number;
    lng: number;
    radiusM: number;
  } | null;
  capacity: number | null;
  /** Çıkış turnikesi yoksa üyenin "içeride" sayılacağı azami süre (saat) — Faz 5 doluluk */
  autoExitHours: number;
  /** Hesap paylaşımı tespiti ayarları — Faz 6 */
  sharing: SharingConfig;
}

export interface AuditLogEntry {
  id: string;
  actorId: string;
  actorEmail: string;
  action: string;
  targetId?: string;
  details?: Record<string, unknown>;
  at: string;
}

// ---- Faz 4 (revize): Statik turnike QR + Device Gateway ----
// Akış: turnikeye yapıştırılmış statik QR üye telefonuyla okutulur; sunucu
// üyeyi doğrular ve cihaza WS üzerinden "open" komutu gönderir.

/** Tarama isteğinin reddedilme nedenleri (HTTP 403 body.code; entry_events.reason) */
export type GateRejectCode =
  | "INVALID_QR"
  | "UNKNOWN_DEVICE"
  | "DEVICE_OFFLINE"
  | "NO_ACTIVE_SUBSCRIPTION"
  | "LOCATION_REQUIRED"
  | "OUT_OF_RANGE"
  | "MOCK_LOCATION"
  | "SHARING_BLOCKED";

/** İstemcilerin sunucu mesajını ayrıştırmadan çevirebildiği kararlı hata kodları. */
export type ApiErrorCode =
  | GateRejectCode
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "PASSWORD_CHANGE_REQUIRED"
  /** Beklenmeyen sunucu hatası — ayrıntı istemciye sızdırılmaz */
  | "INTERNAL_ERROR"
  | "PAYLOAD_TOO_LARGE"
  | "PROFILE_PHOTO_MISSING"
  | "PROFILE_PHOTO_INVALID"
  | "PROFILE_PHOTO_BUSY"
  | "PROFILE_PHOTO_RATE_LIMITED"
  | "PROFILE_PHOTO_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "DELETION_MEMBER_ONLY"
  | "DELETION_ALREADY_PENDING"
  | "DELETION_NOT_PENDING"
  | "INVALID_DEVICE_NAME"
  | "DEVICE_NOT_FOUND"
  | "PASSWORD_TOO_SHORT"
  | "CURRENT_PASSWORD_INVALID"
  | "SEARCH_QUERY_TOO_SHORT"
  | "INVALID_USER_OR_ROLE"
  | "SELF_ROLE_CHANGE"
  | "MFA_REQUIRED"
  | "MFA_LOCKED"
  | "MFA_INVALID"
  | "USER_NOT_FOUND"
  | "INVALID_SUBSCRIPTION"
  | "SUBSCRIPTION_BUSY"
  | "INVALID_USER"
  | "GYM_NAME_REQUIRED"
  | "INVALID_LOCATION"
  | "INVALID_CAPACITY"
  | "INVALID_AUTO_EXIT"
  | "INVALID_SHARING_SETTINGS"
  | "DELETION_REQUEST_NOT_FOUND"
  | "DELETION_REQUEST_RESOLVED"
  | "DELETION_CLEANUP_FAILED"
  | "INVALID_PHONE_NUMBER"
  | "PHONE_ALREADY_EXISTS";

export interface ApiErrorResponse {
  code: ApiErrorCode;
  /** İnsan ve loglar için Türkçe geriye dönük mesaj; UI kararları code ile verilir. */
  message: string;
}

export interface GateScanResponse {
  ok: true;
  deviceName: string;
  direction: DeviceDirection;
  /** Röle tetikleme süresi (ms) — bilgi amaçlı */
  openMs: number;
}

/** Turnike yönü: "in" giriş (doluluk +1), "out" çıkış (doluluk -1, abonelik kontrolü atlanır) */
export type DeviceDirection = "in" | "out";

export interface Device {
  id: string;
  name: string;
  direction: DeviceDirection;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  /** Son 24 saatte çevrimiçi kalma yüzdesi (0-100) — KPI-4 */
  uptime24h: number;
  /** Yazdırılabilir statik QR içeriği (OGGATE1.…) */
  qrContent: string;
}

/** Cihaz oluşturma yanıtı — token yalnızca bu yanıtta bir kez görünür */
export interface DeviceCreated {
  id: string;
  name: string;
  direction: DeviceDirection;
  token: string;
  qrContent: string;
}

export interface EntryEvent {
  id: string;
  deviceId: string;
  deviceName: string;
  userId: string | null;
  memberName: string | null;
  allowed: boolean;
  reason: GateRejectCode | null;
  at: string;
}

// Device Gateway WS protokolü (JSON text frame, cihaz ↔ sunucu)
// Cihaz artık "dumb client": yalnızca kimlik doğrular ve open komutu dinler
export type DeviceClientMessage = {
  type: "auth";
  deviceId: string;
  token: string;
};

export type DeviceServerMessage =
  | { type: "auth_ok"; deviceName: string }
  | { type: "auth_error"; message: string }
  | {
      type: "open";
      /** Röle tetikleme süresi (ms) — cihaz bu süre kadar açar */
      openMs: number;
    };

// ---- Faz 5: MFA / Doluluk / KVKK ----

/** Hassas işlem (rol atama) MFA doğrulama yöntemi */
export type MfaMethod = "totp" | "otp";

/** Anlık salon doluluğu (US-4) */
export interface OccupancyResponse {
  /** İçerideki üye sayısı (giriş turnikesi sayacı, autoExitHours ile eskiyenler düşülür) */
  inside: number;
  capacity: number | null;
  /** inside/capacity oranı (0-1); kapasite tanımsızsa null */
  ratio: number | null;
}

/** Yönetim paneli genel bakış KPI'ları */
export interface AdminStats {
  /** Şu an aktif aboneliği olan benzersiz üye sayısı */
  activeMembers: number;
  /** Aboneliği önümüzdeki 7 gün içinde sona erecek benzersiz üye sayısı */
  renewalsDue: number;
}

/** KVKK hesap silme talebi (panel listesi) */
export interface DeletionRequest {
  id: string;
  userId: string;
  email: string;
  name: string;
  requestedAt: string;
  status: "pending" | "approved" | "rejected";
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/** Üyenin kendi silme talebi durumu (mobil) */
export interface MyDeletionRequest {
  status: "none" | "pending" | "rejected";
  requestedAt: string | null;
}

// ---- Faz 6: Hesap Paylaşımı Tespiti / Anti-Debug / Anti-Spoof ----

/** Hesap paylaşımı şüphesi sinyal türleri */
export type SharingSignalKind =
  "fingerprint-churn" | "location-inconsistency" | "mock-location";

/** Hesap paylaşımı tespiti eşik/pencere ayarları (salon ayarlarında düzenlenebilir) */
export interface SharingConfig {
  /** Üye rolü için eşzamanlı oturum üst sınırı */
  memberMaxSessions: number;
  /** Personel/admin rolü için eşzamanlı oturum üst sınırı */
  staffMaxSessions: number;
  /** Bu sayıda sinyal birikince otomatik engelleme tetiklenir */
  signalThreshold: number;
  /** Sinyallerin sayıldığı zaman penceresi (saat) */
  signalWindowHours: number;
  /** Otomatik QR engelinin süresi (saat) */
  qrBlockHours: number;
}
