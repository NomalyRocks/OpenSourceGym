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

/**
 * `owner` is chain-wide; `admin` and `staff` are scoped to the gyms in their
 * `gymIds`; `member` accounts are chain-wide and carry no gym scope.
 */
export type Role = "owner" | "admin" | "staff" | "member";

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  role: Role;
  /** Gyms an admin/staff account is scoped to; empty for owner and member */
  gymIds: string[];
  emailVerified: boolean;
  /** Whether MFA (two-factor authentication) is enabled — Phase 5 */
  twoFactorEnabled: boolean;
  profilePhotoUrl: string | null;
  createdAt: string;
}

/** Membership state of a member, derived from their subscription periods. */
/**
 * `frozen` wins over `active` and `expired`: the member has an open freeze, so
 * their periods are paused (a period's nominal end may pass during the freeze
 * and is credited back when it ends).
 */
export type SubscriptionStatus = "active" | "frozen" | "expired" | "none";

/** One row of the admin user directory. */
export interface UserDirectoryRow extends PublicUser {
  subscriptionStatus: SubscriptionStatus;
  /**
   * End of the current period when `active`, end of the latest past period
   * when `expired`, the nominal end of the latest started period when `frozen`
   * (moves later once the freeze ends), null when `none`.
   */
  subscriptionEndsAt: string | null;
  /** Gyms of the member's currently active subscription periods; empty when none */
  subscriptionGymIds: string[];
  /**
   * Where the user currently counts as inside (same autoExitHours expiry as the
   * occupancy figure). null when outside, or when that gym is outside a
   * non-owner caller's scope.
   */
  presence: MemberPresence | null;
}

/** Offset page (1-based) used by the admin user directory table. */
export interface UserDirectoryPage {
  total: number;
  page: number;
  pageSize: number;
  items: UserDirectoryRow[];
}

export interface MyProfile {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** Gyms an admin/staff account is scoped to; empty for owner and member */
  gymIds: string[];
  mustChangePassword: boolean;
  twoFactorEnabled: boolean;
  profilePhotoUrl: string | null;
  /** Member-entered age used to prefill the mobile calorie calculator */
  age: number | null;
  /** Member-entered height (cm) used to prefill the mobile calorie calculator */
  heightCm: number | null;
  /** Member-entered weight (kg) used to prefill the mobile calorie calculator */
  weightKg: number | null;
  /** Set while the member is banned; the mobile app shows a ban screen instead of its tabs */
  ban: MemberBan | null;
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
  /** Gyms the member may enter during this period */
  gymIds: string[];
  createdBy: string;
  createdAt: string;
}

export type SubscriptionMonths = 1 | 3 | 6 | 12;

export interface CreateSubscriptionRequest {
  userId: string;
  months: SubscriptionMonths;
  /** Non-empty; every id must be an active gym the caller has access to */
  gymIds: string[];
  note?: string;
}

/**
 * PUT /api/admin/subscriptions/:id/gyms — replaces the gyms of a current or
 * future period without changing its dates. Non-owners may only add or remove
 * gyms in their own scope; gyms outside it stay on the period.
 */
export interface SetSubscriptionGymsRequest {
  gymIds: string[];
}

/**
 * DELETE /api/admin/subscriptions/:id — cancels a period that has not started
 * yet. Every later period of the same member moves earlier by the cancelled
 * period's duration so no gap is left; `shifted` lists them with their new dates.
 */
export interface CancelSubscriptionResponse {
  ok: true;
  shifted: Subscription[];
}

export interface MySubscription {
  /**
   * Whether a period covers now. While frozen, computed as if the freeze ended
   * now, so a frozen member sees the membership they would resume with.
   */
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  /**
   * Days until `endsAt`, rounded up. While frozen, computed as if the freeze ended
   * now: the value stays put during the freeze and only shrinks after the
   * freeze reaches its `maxDays` cap.
   */
  remainingDays: number;
  /** Gyms the active period allows (empty when not active) */
  gymIds: string[];
  /** Same gyms with display names and each gym's own entitlement window */
  gyms: MySubscriptionGym[];
  /** Set while the membership is frozen; the next entry scan ends the freeze */
  freeze: { startedAt: string } | null;
  /** What the member may do from the app (POST/DELETE /api/me/freeze) */
  freezeAllowance: MyFreezeAllowance;
}

/**
 * Self-service freeze state for the member app. `canFreeze` is false when the
 * chain disabled freezing or member self-service, the yearly limit is used up,
 * there is no running period, or the member is already frozen.
 */
export interface MyFreezeAllowance {
  canFreeze: boolean;
  usedInLastYear: number;
  maxPerYear: number;
  maxDays: number;
}

/**
 * A gym on the member's current membership. `startsAt`/`endsAt`/`remainingDays`
 * cover only the contiguous periods that include this gym, so they can differ
 * per gym; while frozen they are previewed as if the freeze ended now, like the
 * chain-level fields on {@link MySubscription}.
 */
export interface MySubscriptionGym extends GymRef {
  startsAt: string;
  endsAt: string;
  remainingDays: number;
}

/** Minimal gym reference embedded in member-facing payloads */
export interface GymRef {
  id: string;
  name: string;
  active: boolean;
}

/** Geofence centre and radius of a gym */
export interface GymLocation {
  lat: number;
  lng: number;
  radiusM: number;
}

/** One gym of the chain (`/api/admin/gyms*`) */
export interface Gym {
  id: string;
  name: string;
  location: GymLocation | null;
  capacity: number | null;
  /** Maximum time (hours) a member is considered "inside" without an exit turnstile */
  autoExitHours: number;
  sharing: SharingConfig;
  reminders: ReminderConfig;
  /** Gyms are deactivated, never deleted; an inactive gym refuses every entry scan */
  active: boolean;
  createdAt: string;
}

/** POST /api/admin/gyms (owner) */
export interface GymCreateInput {
  name: string;
  location?: GymLocation | null;
  capacity?: number | null;
  autoExitHours?: number;
}

/**
 * PUT /api/admin/gyms/:gymId (owner) — partial. Deactivation is
 * `active: false`; gyms are never deleted.
 */
export interface GymUpdateInput {
  name?: string;
  active?: boolean;
}

/**
 * Gym-specific settings. `GET /api/admin/gyms/:gymId/settings` returns the full
 * `Gym` (a superset); `PUT` (owner, or admin of the gym) takes this shape, with
 * `sharing` and `reminders` left unchanged when omitted.
 */
export interface GymSettings {
  location: GymLocation | null;
  capacity: number | null;
  autoExitHours: number;
  sharing?: SharingConfig;
  reminders?: ReminderConfig;
}

/** Chain-wide settings singleton (`settings._id: "chain"`), owner only */
export interface ChainSettings {
  chainName: string;
  /** Legal documents published by the operator — one data controller for the whole chain */
  legal: LegalConfig;
  /** Subscription freeze rules; omitted on PUT leaves them unchanged */
  freeze: FreezeConfig;
}

/** Chain-wide subscription freeze rules (owner-editable, `settings._id: "chain"`) */
export interface FreezeConfig {
  enabled: boolean;
  /** Members may freeze/resume from the app themselves (default true) */
  memberSelfService: boolean;
  /** Freezes a member may start in any rolling 365-day window (0-12, default 4) */
  maxPerYear: number;
  /**
   * Longest freeze credited back to the member, in days (1-180, default 30).
   * A freeze still open after this is ended by the reaper and credits exactly
   * this many days.
   */
  maxDays: number;
}

/** A member ban (chain-wide). Entry scans are refused; exit scans never are. */
export interface MemberBan {
  reason: string;
  bannedAt: string;
}

/** POST /api/admin/users/:id/ban (owner/admin) — members only; re-banning updates the reason */
export interface BanMemberRequest {
  /** 3-500 characters, shown to the member on the mobile ban screen */
  reason: string;
}

/** Freeze state of a member, as shown in the panel */
export interface MemberFreezeState {
  /** Open freeze, or null */
  active: { startedAt: string; maxDays: number; startedBy: string } | null;
  /** Freezes started in the last 365 days */
  usedInLastYear: number;
  /** Copy of the chain FreezeConfig, so the panel can explain a refusal */
  config: FreezeConfig;
}

/**
 * GET /api/admin/users/:id (owner/admin/staff) — everything the member drawer
 * needs in one call, e.g. when opened from the Entries page.
 */
export interface MemberDetail {
  user: UserDirectoryRow;
  ban: (MemberBan & { bannedBy: string }) | null;
  freeze: MemberFreezeState;
  /** Pending deletion request, if any */
  pendingDeletion: {
    id: string;
    requestedAt: string;
    /** null when the member requested it from the app */
    requestedBy: { id: string; name: string } | null;
  } | null;
}

/**
 * POST /api/admin/users/:id/deletion-request (owner/admin/staff) — opens a
 * deletion request on a member's behalf; only an owner can approve it.
 */
export interface CreateMemberDeletionRequest {
  /** Optional, up to 500 characters; shown to the owner on the Data Requests page */
  reason?: string;
}

/** PUT /api/admin/users/:id/gyms (owner) — replaces an admin/staff account's gym scope */
export interface SetUserGymsRequest {
  gymIds: string[];
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
  /** Gym the action was scoped to; null for chain-level actions (gym CRUD, chain settings…) */
  gymId: string | null;
}

// ---- Phase 4 (revised): Static turnstile QR + Device Gateway ----
// Flow: the member scans the static QR attached to the turnstile with their phone;
// the server verifies the member and sends the device an "open" command over WS.

/**
 * Reasons for rejecting a scan request (`entry_events.reason`, and the error
 * body `code`). The access decisions answer HTTP 403; `RATE_LIMITED` answers
 * 429, which is why the status is not part of this contract.
 */
export type GateRejectCode =
  | "INVALID_QR"
  | "UNKNOWN_DEVICE"
  | "DEVICE_OFFLINE"
  | "NO_ACTIVE_SUBSCRIPTION"
  /** The member has an active subscription, but not for the gym this device belongs to */
  | "NOT_ALLOWED_AT_GYM"
  /** The gym this device belongs to has been deactivated (entry only) */
  | "GYM_INACTIVE"
  | "LOCATION_REQUIRED"
  | "OUT_OF_RANGE"
  | "MOCK_LOCATION"
  | "SHARING_BLOCKED"
  /** Anti-passback: the member is counted inside and must scan out before entering again */
  | "ALREADY_INSIDE"
  /**
   * Anti-passback: the member entered moments ago and the re-entry cooldown has
   * not lapsed. Distinct from ALREADY_INSIDE — they may well be standing
   * outside, and telling them to "use the exit turnstile" would be nonsense.
   */
  | "ENTRY_COOLDOWN"
  /**
   * An exit scan from someone with no record of having come in. Refusing this is
   * safe precisely because we have no evidence they are in the building.
   */
  | "NOT_INSIDE"
  /**
   * The operator has not configured the gym location, and location verification
   * is mandatory. Distinct from LOCATION_REQUIRED because the member can do
   * nothing about it — the clients must point them at reception instead of at
   * their own location permission.
   */
  | "GYM_LOCATION_UNSET"
  /**
   * The scan was throttled: either the per-member gate-scan window, or the
   * duplicate-scan lock that keeps two turnstiles from opening on one scan.
   *
   * Part of this union — and therefore of the `entry_events` log — because a
   * refusal that leaves no record is not reviewable, and a burst of throttled
   * attempts is the signature the log most needs to show.
   */
  | "RATE_LIMITED"
  /** The member is banned (entry only; see MemberBan) */
  | "BANNED";

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
  | "GYM_NOT_FOUND"
  /** gymIds missing, empty or malformed */
  | "INVALID_GYMS"
  /** The subscription period has already ended and can no longer be changed */
  | "SUBSCRIPTION_ENDED"
  | "SUBSCRIPTION_NOT_FOUND"
  /** The period has already started and can no longer be cancelled */
  | "SUBSCRIPTION_STARTED"
  /** The path's gym (or a gym in gymIds) is outside the caller's gym scope */
  | "GYM_OUT_OF_SCOPE"
  /** Demoting the only remaining owner is refused */
  | "LAST_OWNER"
  /** Promoting a banned member is refused until the ban is lifted */
  | "MEMBER_BANNED"
  /** Promoting a member with an open freeze is refused until it ends */
  | "MEMBER_FROZEN"
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
  | "PHONE_ALREADY_EXISTS"
  /** Ban/freeze/deletion-on-behalf target is not a member account */
  | "MEMBER_ONLY"
  | "INVALID_BAN_REASON"
  | "NOT_BANNED"
  | "FREEZE_DISABLED"
  /** maxPerYear freezes already started in the last 365 days */
  | "FREEZE_LIMIT_REACHED"
  | "ALREADY_FROZEN"
  | "NOT_FROZEN"
  /** Freezing needs a period that is running right now */
  | "NO_ACTIVE_PERIOD"
  | "INVALID_FREEZE_SETTINGS";

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
  /** True when this entry scan ended the member's freeze */
  unfrozen?: boolean;
}

/** Turnstile direction: "in" for entry (occupancy +1), "out" for exit (occupancy -1, subscription check skipped) */
export type DeviceDirection = "in" | "out";

export interface Device {
  id: string;
  gymId: string;
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
  gymId: string;
  name: string;
  direction: DeviceDirection;
  token: string;
  qrContent: string;
}

export interface EntryEvent {
  id: string;
  gymId: string | null;
  deviceId: string;
  deviceName: string;
  userId: string | null;
  memberName: string | null;
  allowed: boolean;
  reason: GateRejectCode | null;
  at: string;
  /**
   * Metres between the scanning phone and the configured gym location, when
   * both were known at scan time. Recorded so that management can review a
   * disputed or suspicious scan after the fact: without it, a scan that the
   * geofence let through leaves no trace of where it came from.
   */
  distanceM: number | null;
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

/** Current occupancy of one gym (US-4) */
export interface OccupancyResponse {
  gymId: string;
  gymName: string;
  /** Number of members inside (entry turnstile count, excluding entries expired by autoExitHours) */
  inside: number;
  capacity: number | null;
  /** inside/capacity ratio (0-1); null when capacity is unset */
  ratio: number | null;
}

/**
 * GET /api/me/occupancy — occupancy of every active gym the caller may enter:
 * the gyms on a member's active subscription, or an admin/staff account's
 * gyms (owner: all active gyms).
 */
export interface MyOccupancyResponse {
  gyms: OccupancyResponse[];
}

/** A member counted inside a gym right now */
export interface MemberPresence {
  gymId: string;
  gymName: string;
  /** Entry turnstile time (ISO); the panel derives "minutes inside" from it */
  enteredAt: string;
}

/** GET /api/me/presence — the member's own "am I inside" state */
export interface MyPresence {
  /**
   * Where the member currently counts as inside (same autoExitHours cutoff as
   * the occupancy figure); null when outside.
   */
  inside: MemberPresence | null;
  /** Most recent allowed entry scan at any gym; null when there is none */
  lastEntry: { gymId: string; gymName: string; at: string } | null;
}

/**
 * GET /api/me/gyms/:gymId/busy-hours — typical entry traffic per hour for
 * today's weekday, averaged over recent same-weekday days.
 */
export interface MyBusyHours {
  gymId: string;
  /** IANA time zone the hour buckets are cut in */
  timeZone: string;
  /** Weekday the profile describes (today in `timeZone`), 0 = Sunday */
  weekday: number;
  /** How many past same-weekday days were averaged (0 when there is no history) */
  sampleDays: number;
  /**
   * Always 24 rows, hour 0..23: average allowed entry scans in that hour. An
   * hour with fewer than 3 entries across all sample days reports 0 (privacy).
   */
  hours: { hour: number; avgEntries: number }[];
}

/** One row of GET /api/admin/gyms/:gymId/inside */
export interface InsideMember {
  userId: string;
  name: string;
  profilePhotoUrl: string | null;
  enteredAt: string;
}

/**
 * GET /api/admin/gyms/:gymId/inside (owner/admin/staff, gym-scoped) — members
 * counted inside the gym right now, longest-staying first. Its length equals
 * OccupancyResponse.inside.
 */
export interface GymInsideResponse {
  gymId: string;
  members: InsideMember[];
}

/** Admin panel overview KPIs (per gym) */
export interface AdminStats {
  /** Number of unique members with an active subscription, frozen members excluded */
  activeMembers: number;
  /** Number of unique members with an open membership freeze */
  frozenMembers: number;
  /** Number of unique members whose subscriptions expire within the next 7 days, frozen members excluded */
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
  /** Staff member who opened it on the member's behalf; null when the member did */
  requestedBy: { id: string; name: string } | null;
  /** Optional note from requestedBy */
  reason: string | null;
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
  /** Number of unique members with an active subscription, frozen members excluded (independent of the range) */
  activeMembers: number;
  /** Number of unique members with an open membership freeze (independent of the range) */
  frozenMembers: number;
  /** Number of members registered within the range */
  newMembers: number;
  /** Number of subscriptions created within the range */
  newSubscriptions: number;
  /**
   * Number of members whose subscription expired within the range and who did
   * not renew by the end of the range (their latest subscription ended in this range).
   */
  lapsedMembers: number;
  /** Number of members whose subscriptions expire within the next 7 days, frozen members excluded (independent of the range) */
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

/** One gym's row in the owner's chain summary */
export interface ChainGymSummary {
  gymId: string;
  gymName: string;
  active: boolean;
  /** Frozen members excluded */
  activeMembers: number;
  frozenMembers: number;
  /** Frozen members excluded */
  renewalsDue: number;
  /** Members currently counted inside */
  inside: number;
  entries: ReportSummary["entries"];
}

/** GET /api/admin/reports/chain/summary (owner) */
export interface ChainSummary {
  range: ReportRange;
  timeZone: string;
  /** Unique members with an active subscription anywhere in the chain, frozen members excluded */
  activeMembers: number;
  /** Unique members with an open membership freeze anywhere in the chain */
  frozenMembers: number;
  gyms: ChainGymSummary[];
}

/** CSV export datasets */
export type ExportDataset = "members" | "subscriptions" | "entries";
