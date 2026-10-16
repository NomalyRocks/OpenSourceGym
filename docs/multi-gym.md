# Multi-gym (chain) support — design

Status: **design, not implemented** (ROADMAP Faz 11). Supersedes the PRD
non-goal "single-tenant, one gym per install".

## Goal

One OpenGym install serves a chain of gyms: one server, one database, one
member account per person. Every gym has its own location, capacity, turnstile
devices and settings. A member may enter only the gyms listed on their active
subscription.

## Decisions

| Topic           | Decision                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Deployment      | Single server + single MongoDB; gyms separated by `gymId`. No per-gym databases.                                          |
| Existing data   | None kept. The database is wiped; only schemas change. No startup repair or migration code.                               |
| Roles           | `user.role` = `owner \| admin \| staff \| member`. `owner` is chain-wide. Admin/staff carry `gymIds` (their scope).       |
| Member accounts | Chain-wide. Staff/admin can search **all** members, so a freshly registered member can get a first subscription anywhere. |
| Subscriptions   | Each period carries `gymIds` — the gyms the member may enter during that period.                                          |
| Gym settings    | Location, capacity, `autoExitHours`, devices, sharing and reminder settings are per gym.                                  |
| Scoped routes   | Gym-scoped admin routes live under `/api/admin/gyms/:gymId/...`; the gym is never inferred from a header.                 |

## Data model

### New: `gyms`

```ts
{
  _id: ObjectId,
  name: string,
  location: { lat: number, lng: number, radiusM: number } | null,
  capacity: number | null,
  autoExitHours: number,
  sharing: { ... },     // moved from settings
  reminders: { ... },   // moved from settings
  active: boolean,      // gyms are deactivated, never deleted (entry history keeps its gymId)
  createdBy: string,
  createdAt: Date,
}
```

An inactive gym refuses every **entry** scan (`GYM_INACTIVE`); exit scans are
still never refused.

### `settings` (singleton, `_id: "gym"` → `_id: "chain"`)

Keeps chain-wide values only: chain display name and `legal` (chain-wide, see resolved question
1). Everything gym-specific moves to `gyms`.

### Changed collections

| Collection                                                    | Change                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `user`                                                        | `role` gains `owner`; new `gymIds: string[]` (empty for owner and member)        |
| `subscriptions`                                               | new `gymIds: ObjectId[]`, required, non-empty, every id must be an active gym    |
| `devices`                                                     | new `gymId`; `qrContent` stays per device, so a scanned QR resolves device → gym |
| `entry_events`                                                | new `gymId`                                                                      |
| `device_status_log`                                           | new `gymId`                                                                      |
| `sharing_signals`                                             | new `gymId`                                                                      |
| `renewal_reminders`                                           | unchanged — reminders are per member and per subscription, not per gym           |
| `audit_logs`                                                  | new optional `gymId` (null for chain-level actions such as gym CRUD)             |
| `weight_history`, `deletion_requests`, BetterAuth collections | unchanged                                                                        |

Indexes: every `gymId`-carrying collection gets `gymId` as the leading key of
the indexes its gym-scoped queries use (`entry_events: { gymId, at }`, etc.).

### Redis

- Occupancy: `og:inside` → `og:inside:<gymId>`.
- A member is inside **at most one gym**. An entry at gym B while the member is
  recorded inside gym A closes the A record (auto-exit, logged on the
  `entry_events` row) — see resolved question 2.
- Anti-passback state and exit-device reachability are per gym.

## Authorization

`requireRole(...)` is replaced on gym-scoped routes by
`requireGymAccess(...roles)`:

1. Same session check and **Mongo re-read on every request** as today
   (`mustChangePassword` gate preserved).
2. Read `:gymId` from the path; 404 if the gym does not exist.
3. `owner` passes for every gym. `admin`/`staff` pass only if `gymId` is in
   their re-read `gymIds`.

Chain-level routes (gym CRUD, assigning staff to gyms, chain settings, chain
summary report) are `owner`-only and keep `requireRole("owner")`. Every one of
those mutations calls `logAudit`.

`/api/admin/devices*` stays admin-only (never staff) and becomes
`/api/admin/gyms/:gymId/devices*` — `qrContent` is still the gate credential.

## Gate scan (`POST /api/me/gate-scan`)

1. Throttle (unchanged, runs before QR parsing; still logged as `RATE_LIMITED`).
2. Resolve QR → device → `gymId`. Unknown device: refuse as today.
3. Entry only:
   - gym must be active;
   - geofence against **that gym's** location (`GYM_LOCATION_UNSET` if null);
   - active subscription whose `gymIds` contains this gym (`NOT_ALLOWED_AT_GYM`
     when the member has an active subscription but not for this gym — distinct
     from "no active subscription" so the app can explain it);
   - sharing detection and anti-passback scoped to this gym.
4. Exit: never refused for location, sharing or subscription reasons (unchanged).
5. Write `entry_events` with `gymId`; update `og:inside:<gymId>`.

## Clients

**Web panel**

- Gym switcher in the shell; the selected gym is part of the URL
  (`/gyms/:gymId/...`), so links and reloads keep the scope.
- Owner-only: gym management page (create, edit, deactivate), staff-to-gym
  assignment, "All gyms" summary.
- Subscription form gets a multi-select of active gyms.
- Member search is chain-wide; entries/reports are filtered to the selected gym.

**Mobile**

- Occupancy is shown for each gym on the member's active subscription.
- Scan flow unchanged (the gym comes from the device). New refusal copy for
  `NOT_ALLOWED_AT_GYM` and `GYM_INACTIVE`.
- Subscription card lists the gyms the member may enter.

## Seed

First boot seeds the chain `owner` (`admin@opengym.local`, password rules as
today via `resolveInitialAdminPassword()`, `mustChangePassword: true`) and
**no gym**. Until the owner creates the first gym, member scans fail with an
unknown-device refusal because no device can exist yet.

## Resolved questions (2026-10-16)

1. **Legal documents are chain-wide.** `legal` stays in the `settings`
   singleton (`_id: "chain"`); one data controller. Revisit only if gyms become
   franchises with separate controllers.
2. **Entering gym B while inside gym A:** the A record is closed (auto-exit,
   noted on the B `entry_events` row) **and** a sharing signal is recorded when
   the implied travel speed between A's and B's locations exceeds 120 km/h
   (distance between gym locations / time since the A entry). No signal when
   either gym location is unknown.
3. **Staff entry without a subscription: yes.** `owner` (every active gym) and
   `admin`/`staff` (gyms in their `gymIds`) pass the subscription check through
   the normal QR flow. Geofence, gym-active check and anti-passback still apply.

## API contract (Faz 11)

Binding for `apps/api`, `apps/web` and `apps/mobile`. Type names live in
`@opengym/shared`.

### Chain-level routes (`requireRole`, no `:gymId`)

| Method + path                            | Roles                       | Notes                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/gyms`                    | owner, admin, staff         | `Gym[]`. Owner: every gym. Admin/staff: only gyms in their `gymIds`. Inactive gyms included (`active` flag).                                                                                        |
| `POST /api/admin/gyms`                   | owner                       | Body `GymCreateInput` → `Gym`. `logAudit`.                                                                                                                                                          |
| `PUT /api/admin/gyms/:gymId`             | owner                       | Body `GymUpdateInput` (partial; includes `active` — deactivation is `active: false`, no delete) → `Gym`. `logAudit`.                                                                                |
| `PUT /api/admin/users/:id/gyms`          | owner                       | Body `{ gymIds: string[] }` — staff/admin scope. Rejected for owner/member targets. `logAudit`.                                                                                                     |
| `POST /api/admin/users/:id/role`         | owner                       | Role assignment is owner-only now (`owner` assignable). MFA step-up rule unchanged. Demoting the last owner is refused.                                                                             |
| `GET /api/admin/users`                   | owner, admin, staff         | Chain-wide member search, unchanged query. User rows carry `gymIds`.                                                                                                                                |
| `POST /api/admin/subscriptions`          | owner, admin, staff         | Body gains `gymIds: string[]` (min 1, active gyms only). Out of scope → 403 `GYM_OUT_OF_SCOPE`; unknown → 404 `GYM_NOT_FOUND`; inactive → 400 `GYM_INACTIVE`; empty/malformed → 400 `INVALID_GYMS`. |
| `GET /api/admin/users/:id/subscriptions` | owner, admin, staff         | Chain-wide; each `Subscription` carries `gymIds`.                                                                                                                                                   |
| `GET/PUT /api/admin/settings`            | GET owner, admin; PUT owner | `ChainSettings` (chain name + `legal`). Gym-specific values are gone from here.                                                                                                                     |
| `GET /api/admin/audit`                   | owner, admin                | Owner: all, optional `?gymId=`. Admin: rows whose `gymId` is in scope (chain-level rows hidden).                                                                                                    |
| `GET /api/admin/reports/chain/summary`   | owner                       | `ChainSummary`: `?from=&to=` (default 30 days, max 366); per-gym active members, renewals due, inside, entries in range.                                                                            |
| `/api/admin/deletion-requests*`          | owner                       |                                                                                                                                                                                                     |
| `initial-password`                       | unchanged                   |                                                                                                                                                                                                     |

### Gym-scoped routes (`requireGymAccess`, prefix `/api/admin/gyms/:gymId`)

| Suffix                                                                                                                              | Roles                      | Notes                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /stats`                                                                                                                        | owner, admin, staff        | Former `/api/admin/stats`, scoped to the gym.                                                                   |
| `GET /entry-events`                                                                                                                 | owner, admin, staff        | Former `/api/admin/entry-events`.                                                                               |
| `GET /occupancy`                                                                                                                    | owner, admin, staff        | Panel occupancy for this gym (panel no longer uses `/api/me/occupancy`).                                        |
| `GET/PUT /settings`                                                                                                                 | GET all; PUT owner, admin  | `GymSettings`: location, capacity, `autoExitHours`, sharing, reminders.                                         |
| `GET /reports/summary`, `/reports/entry-trend`, `/reports/renewals`, `POST /reports/renewals/:userId/remind`, `GET /reports/export` | owner, admin, staff        | Former `/api/admin/reports/*`. Renewals = subscriptions whose `gymIds` include the gym. CSV gains a gym column. |
| `GET /devices`, `POST /devices`, `DELETE /devices/:id`                                                                              | owner, admin (never staff) | Former `/api/admin/devices*`.                                                                                   |

`requireGymAccess` errors: `GYM_NOT_FOUND` (404, owner only), `GYM_OUT_OF_SCOPE` (403 — also returned to a non-owner for an unknown gym, so gym ids cannot be probed).

### Member routes

- `GET /api/me/profile` adds `gymIds` (staff scope; empty for owner/member).
- `GET /api/me/subscription` → `MySubscription` with `gymIds` and
  `gyms: GymRef[]` (`{ id, name, active }`) for display.
- `GET /api/me/occupancy` → one entry per gym on the active subscription (staff:
  per gym in scope; owner: every active gym).

### New codes

- `GateRejectCode`: `NOT_ALLOWED_AT_GYM`, `GYM_INACTIVE`.
- `ApiErrorCode`: `GYM_NOT_FOUND`, `GYM_OUT_OF_SCOPE`, `GYM_INACTIVE` (subscription
  with an inactive gym), `INVALID_GYMS`, `LAST_OWNER` (409, demoting the last owner).
