export interface HealthResponse {
  status: "ok";
  service: string;
  timestamp: string;
}

/** Readiness result for a single subcomponent. */
export interface ReadinessCheck {
  status: "up" | "down";
  /** Populated only when the status is "down". */
  error?: string;
}

/**
 * The /health/ready response. Unlike liveness (/health), it actually checks
 * dependencies, so it may return "down" even when the process is running.
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
 * Cursor-based (keyset) pagination envelope. A cursor is used instead of an
 * offset because lists are ordered by descending time and receive new records
 * continuously, so offset pagination could duplicate or skip records.
 */
export interface Page<T> {
  items: T[];
  /** Passed as the `cursor` query parameter for the next page; null on the last page. */
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
  /** Whether MFA (two-factor authentication) is enabled — Phase 5 */
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
  /** Member-entered age used to prefill the mobile calorie calculator */
  age: number | null;
  /** Member-entered height (cm) used to prefill the mobile calorie calculator */
  heightCm: number | null;
  /** Member-entered weight (kg) used to prefill the mobile calorie calculator */
  weightKg: number | null;
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
  /** Maximum time (hours) a member is considered "inside" without an exit turnstile — Phase 5 occupancy */
  autoExitHours: number;
  /** Account-sharing detection settings — Phase 6 */
  sharing: SharingConfig;
  /** Automatic renewal reminders — Phase E */
  reminders: ReminderConfig;
  /** Legal documents published by the operator for their jurisdiction */
  legal: LegalConfig;
}

/**
 * OpenGym contains no legal text: the disclosure/data processing notice and
 * privacy policy are documents prepared and published by the gym operator
 * under their applicable laws (KVKK, GDPR, CCPA, etc.). Only the URLs and
 * version of these documents are stored here.
 */
export interface LegalConfig {
  /** Data processing/disclosure notice URL — the checkbox is shown without a link when unset */
  dataProcessingUrl: string | null;
  /** Privacy policy URL — the checkbox is shown without a link when unset */
  privacyUrl: string | null;
  /** Incremented when the texts change; the version a future re-consent flow will use */
  version: number;
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

// ---- Phase 4 (revised): Static turnstile QR + Device Gateway ----
// Flow: the member scans the static QR attached to the turnstile with their phone;
// the server verifies the member and sends the device an "open" command over WS.

/** Reasons for rejecting a scan request (HTTP 403 body.code; entry_events.reason) */
export type GateRejectCode =
  | "INVALID_QR"
  | "UNKNOWN_DEVICE"
  | "DEVICE_OFFLINE"
  | "NO_ACTIVE_SUBSCRIPTION"
  | "LOCATION_REQUIRED"
  | "OUT_OF_RANGE"
  | "MOCK_LOCATION"
  | "SHARING_BLOCKED";

/** Stable error codes clients can translate without parsing the server message. */
export type ApiErrorCode =
  | GateRejectCode
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "PASSWORD_CHANGE_REQUIRED"
  /** Unexpected server error — details are not exposed to the client */
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
  | "INVALID_REMINDER_SETTINGS"
  | "INVALID_LEGAL_SETTINGS"
  | "INVALID_REPORT_RANGE"
  | "REMINDER_RECENTLY_SENT"
  | "NO_UPCOMING_RENEWAL"
  | "DELETION_REQUEST_NOT_FOUND"
  | "DELETION_REQUEST_RESOLVED"
  | "DELETION_CLEANUP_FAILED"
  | "INVALID_PHONE_NUMBER"
  | "PHONE_ALREADY_EXISTS";

export interface ApiErrorResponse {
  code: ApiErrorCode;
  /** English message for logs and API clients; UI decisions are based on code. */
  message: string;
}

export interface GateScanResponse {
  ok: true;
  deviceName: string;
  direction: DeviceDirection;
  /** Relay activation duration (ms) — informational only */
  openMs: number;
}

/** Turnstile direction: "in" for entry (occupancy +1), "out" for exit (occupancy -1, subscription check skipped) */
export type DeviceDirection = "in" | "out";

export interface Device {
  id: string;
  name: string;
  direction: DeviceDirection;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  /** Percentage of time online in the last 24 hours (0-100) — KPI-4 */
  uptime24h: number;
  /** Printable static QR content (OGGATE1.…) */
  qrContent: string;
}

/** Device creation response — the token appears only once in this response */
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

/** Member's own visit day (mobile calendar) — summary of a single local calendar day */
export interface MyEntryDay {
  /** Calendar day in the gym's time zone, `YYYY-MM-DD` */
  date: string;
  /** Number of visits (inbound entries) on that day; always ≥ 1 */
  entries: number;
}

/** Member's own visit history by day (mobile calendar) */
export interface MyEntriesResponse {
  /** Only days with at least one visit, in ascending date order */
  days: MyEntryDay[];
  /** IANA time zone used to calculate the days (gym time) */
  timeZone: string;
}

/**
 * The member's own age, height, and weight. In the PATCH /api/me/body-metrics
 * body, an omitted field is left unchanged and `null` clears it; the response
 * always returns the complete current state.
 */
export interface MyBodyMetrics {
  age: number | null;
  heightCm: number | null;
  weightKg: number | null;
}

/** A point-in-time value of the member's profile weight (mobile calendar) */
export interface MyWeightEntry {
  weightKg: number;
  /** Time the record was created, ISO 8601 */
  at: string;
}

/** Member's own weight history — appended whenever weightKg changes, ordered by ascending time */
export interface MyWeightHistoryResponse {
  entries: MyWeightEntry[];
}

// Device Gateway WS protocol (JSON text frame, device ↔ server)
// The device is now a "dumb client": it only authenticates and listens for open commands
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
      /** Relay activation duration (ms) — the device opens for this long */
      openMs: number;
    };

// ---- Phase 5: MFA / Occupancy / Data protection ----

/** MFA verification method for a sensitive operation (role assignment) */
export type MfaMethod = "totp" | "otp";

/** Current gym occupancy (US-4) */
export interface OccupancyResponse {
  /** Number of members inside (entry turnstile count, excluding entries expired by autoExitHours) */
  inside: number;
  capacity: number | null;
  /** inside/capacity ratio (0-1); null when capacity is unset */
  ratio: number | null;
}

/** Admin panel overview KPIs */
export interface AdminStats {
  /** Number of unique members with an active subscription */
  activeMembers: number;
  /** Number of unique members whose subscriptions expire within the next 7 days */
  renewalsDue: number;
}

/** Account deletion (data deletion) request (panel list) */
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

/** Status of the member's own deletion request (mobile) */
export interface MyDeletionRequest {
  status: "none" | "pending" | "rejected";
  requestedAt: string | null;
}

// ---- Phase 6: Account-sharing detection / Anti-debug / Anti-spoof ----

/** Signal types for suspected account sharing */
export type SharingSignalKind =
  "fingerprint-churn" | "location-inconsistency" | "mock-location";

/** Account-sharing detection threshold/window settings (editable in gym settings) */
export interface SharingConfig {
  /** Maximum concurrent sessions for the member role */
  memberMaxSessions: number;
  /** Maximum concurrent sessions for the staff/admin roles */
  staffMaxSessions: number;
  /** Automatic blocking is triggered when this many signals accumulate */
  signalThreshold: number;
  /** Time window in which signals are counted (hours) */
  signalWindowHours: number;
  /** Duration of the automatic QR block (hours) */
  qrBlockHours: number;
}

// ---- Phase E: Reporting, renewal reminders, export ----

/** Automatic renewal reminder settings (editable in gym settings) */
export interface ReminderConfig {
  /**
   * No automatic email is sent when disabled. It is disabled by default so an
   * upgraded installation does not email its members without the operator's knowledge.
   */
  enabled: boolean;
  /**
   * A reminder is sent this many days before the subscription expires. Each
   * threshold is triggered once per subscription.
   */
  daysBefore: number[];
}

/** Range covered by the report query (as applied by the server) */
export interface ReportRange {
  from: string;
  to: string;
}

/** Summary of the date-ranged admin report */
export interface ReportSummary {
  range: ReportRange;
  /** IANA time zone used to calculate daily bucket boundaries */
  timeZone: string;
  /** Number of unique members with an active subscription (independent of the range) */
  activeMembers: number;
  /** Number of members registered within the range */
  newMembers: number;
  /** Number of subscriptions created within the range */
  newSubscriptions: number;
  /**
   * Number of members whose subscription expired within the range and who did
   * not renew by the end of the range (their latest subscription ended in this range).
   */
  lapsedMembers: number;
  /** Number of members whose subscriptions expire within the next 7 days (independent of the range) */
  renewalsDue: number;
  entries: {
    total: number;
    allowed: number;
    denied: number;
    /** Number of unique members who passed through at least once within the range */
    uniqueMembers: number;
  };
}

/** Single-day bucket in the entry trend */
export interface EntryTrendPoint {
  /** Bucket day in the gym's time zone (YYYY-MM-DD) */
  date: string;
  total: number;
  allowed: number;
  denied: number;
}

/** Daily entry trend (chart data) */
export interface EntryTrend {
  range: ReportRange;
  timeZone: string;
  points: EntryTrendPoint[];
}

/** Member whose subscription expires soon (renewal list row) */
export interface RenewalDueMember {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /** End date of the member's latest subscription */
  endsAt: string;
  /** Number of full days remaining until expiration (0 if it expires today) */
  remainingDays: number;
  /** Latest reminder sent for this subscription; null if none has been sent */
  lastReminderAt: string | null;
}

/**
 * Result of sending a manual reminder (only in a 200 response).
 * Cases where it cannot be sent use the standard error contract:
 * `REMINDER_RECENTLY_SENT` (429) or `NO_UPCOMING_RENEWAL` (404).
 */
export interface RenewalReminderResult {
  sent: boolean;
  /** Time the reminder was recorded */
  sentAt: string | null;
}

/** CSV export datasets */
export type ExportDataset = "members" | "subscriptions" | "entries";
