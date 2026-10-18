# OpenGym

Self-hosted gym automation for a single gym or a chain of gyms under one business: member self-registration, subscription tracking, QR turnstile entry (static QR on turnstile, mobile-scanned), staff/role management. Product docs are Turkish: `PRD.md` (requirements and non-goals) and `ROADMAP.md` (phase checklists). Current state: Faz 0–6 (MVP, v1.1 hardening + occupancy, v2.0 sharing detection) and Faz 7–9 (profile photos, TR/EN localization, member tools with calorie calculator) complete; Faz 11 (multi-gym / chain, `docs/multi-gym.md`) and Faz 12 (member controls: subscription confirm/cancel, ban, freeze, deletion on behalf — `docs/member-controls.md`) implemented (API, web, mobile); device/emulator smoke tests pending. Open leftovers are tracked as unchecked items in `ROADMAP.md`.

**Non-goals** (from PRD): online payments, multi-tenant (unrelated businesses sharing one install — a chain of gyms under one business is supported, see `docs/multi-gym.md`), class booking/training/diet features. PRD "Ek A" (experimental path-obfuscation/custom cipher layer) is archived — never implement it.

## Workspace

pnpm 11 + Turborepo monorepo, Node >= 22.

| Package           | Path              | What it is                                                 |
| ----------------- | ----------------- | ---------------------------------------------------------- |
| `@opengym/api`    | `apps/api`        | Express 5 REST API + BetterAuth server (ESM)               |
| `@opengym/web`    | `apps/web`        | Admin/staff panel — React 19 + Vite 7 + react-router 7 SPA |
| `@opengym/mobile` | `apps/mobile`     | Member app — Expo SDK 57 / React Native 0.86               |
| `@opengym/shared` | `packages/shared` | Hand-written shared TS types only (no runtime code)        |

## Commands

```bash
pnpm install
pnpm dev          # turbo: api (tsx watch, :3000) + web (vite, :5173); mobile has no dev script
pnpm build        # turbo: shared first (^build), then api + web; mobile skipped (no build script)
pnpm lint         # single flat eslint config at repo root
pnpm test         # Node built-in test runner (API tests run through tsx)
pnpm typecheck
pnpm format       # prettier --write .

pnpm --filter @opengym/api dev        # one workspace
pnpm --filter @opengym/mobile start   # Expo dev server (also: android / ios)

docker compose up                     # infra: mongo + redis (API runs on host via pnpm dev)

# demo data (refuses any database whose name does not end in -demo; wipes it first)
MONGODB_URI=mongodb://127.0.0.1:27018/opengym-ui-demo REDIS_URL=redis://127.0.0.1:6380/7 SMTP_HOST= pnpm --filter @opengym/api seed:demo
```

- API needs Mongo and Redis running. In development, Docker provides only Mongo and Redis; the API always runs on the host. Env: copy `.env.example` to `.env`; with SMTP unset, OTP emails print to the api console. Production uses a separate `.env.production.example` (see `docker-compose.prod.yml`) — never merge the two profiles into one file, because both `docker compose` and Node's `--env-file` take the last value of a duplicated key.
- `@opengym/shared` is consumed from its compiled `dist/`. Turbo's `^build` handles ordering, but after editing shared types run `pnpm --filter @opengym/shared build` so app typechecks see the change.
- API tests use Node's built-in test runner through `tsx`. CI (`.github/workflows/ci.yml`) runs format → lint → typecheck → test → build on Node 22. `pnpm format:check` is the same check locally; `.prettierignore` keeps it off `pnpm-lock.yaml` and build output, so `pnpm format` is safe to run.
- Integration tests (`apps/api/src/integration/*.mongo-redis.test.ts`) skip unless `TEST_MONGODB_URI` and `TEST_REDIS_URL` are set. Pass the Mongo URI **without** a database path (`mongodb://127.0.0.1:27018`) — the signup test appends its own isolated database name to it.

## Architecture

### Auth (BetterAuth — `apps/api/src/auth.ts`)

- Email+password with required email verification via 6-digit OTP (`emailOTP` plugin); `expo()` plugin for the mobile deep-link scheme `opengym://`.
- Mongo adapter + Redis secondary storage (sessions) + Redis-backed rate limiting with per-route rules (signup, signin, OTP send/verify).
- Custom user fields: `firstName`, `lastName`, normalized public `phone`, internal/non-returned `phoneE164`, `role` (`owner|admin|staff|member`, `input: false`), `gymIds` (admin/staff gym scope; empty for owner and member), `mustChangePassword`, data processing and privacy consent flags (`dataProcessingAccepted`, `privacyAccepted` + timestamps). The `user.create.before` hook rejects signup without both consents, normalizes/uniquifies phones, and stamps consent timestamps.
- The BetterAuth catch-all is mounted **before** `express.json()` in `apps/api/src/index.ts` — moving it after breaks auth request bodies.
- First boot seeds the chain `owner` `admin@opengym.local` (and no gym) with `mustChangePassword: true` (`apps/api/src/seed.ts`). The password comes from `resolveInitialAdminPassword()` (`apps/api/src/initialAdmin.ts`): `admin1234` in development, and in production the operator-supplied `INITIAL_ADMIN_PASSWORD` — there is no production default, so an unset value fails startup, and the value is never logged.

### Authorization (`apps/api/src/middleware.ts`)

`requireRole(...roles)` validates the session, then **re-reads the user from Mongo on every request** so role changes and `mustChangePassword` are never stale behind the Redis session cache. Users with `mustChangePassword` are blocked from everything except `POST /api/admin/initial-password` and `GET /api/me/profile`. Gym-scoped routes use `requireGymAccess(...roles)` instead: same re-read, then `:gymId` from the path — `owner` passes for every gym, `admin`/`staff` only for gyms in their re-read `gymIds`. A non-owner gets `GYM_OUT_OF_SCOPE` (403) even for an unknown gym, so gym ids cannot be probed. New protected routes must use one of these middlewares and preserve the re-read pattern. Owner-only: gym CRUD, staff-to-gym assignment, role assignment (the last owner cannot be demoted — `LAST_OWNER`, serialized by the `og:lock:owner-role` Redis lock), chain settings PUT, deletion-request approval.

Member controls (ban, freeze, deletion on behalf; `apps/api/src/memberScope.ts`) add a second scope rule on top of the role check: a non-owner may act on a member only if one of the member's subscription periods (past ones included) lists a gym in the caller's scope; a member with no periods is owner-only. Their audit rows are written once per affected gym so each gym's admin sees them.

### Data (native MongoDB driver — no ORM or schema-migration framework)

`apps/api/src/db.ts` exposes the `db` handle. Collections:

One-time startup data repairs are idempotent and marker-controlled; they are
not schema migrations.

- `user` — BetterAuth-managed, extended with the custom fields above, plus `ban: { reason, bannedAt, bannedBy } | null` written by our code (not a BetterAuth field)
- `account`, `session`, `verification` — BetterAuth-owned, never written by our code directly
- `gyms` — one doc per gym: name, `location`, `capacity`, `autoExitHours`, sharing and reminder settings, `active`. Gyms are deactivated, never deleted (history keeps its `gymId`); an inactive gym refuses every entry scan (`GYM_INACTIVE`).
- `subscriptions` — membership periods `{ userId, gymIds, startsAt, endsAt, note, createdBy, createdAt }`; `gymIds` are the gyms the member may enter during that period; `freezeCredits` lists the freezes already credited to it (idempotency marker)
- `subscription_freezes` — membership freezes `{ userId, startedAt, startedBy, maxDays, endedAt, endReason, creditedMs, … }`; at most one open per member (unique partial index). Ending one credits `min(elapsed, maxDays)` and repacks the member's later periods; the plan is stored on the freeze first and applied idempotently, and any unsettled credit is finished under the per-user subscription lock before every create/cancel/freeze (`apps/api/src/freezeCredit.ts`). An hourly reaper (`startFreezeReaper`) caps open freezes at `maxDays`
- `phone_identity_conflicts` — unresolved legacy duplicate phones; resolved records are deleted
- `migration_markers` — idempotent one-time data repair markers
- `entry_events` — turnstile scan log; carries `distanceM`, the metres between the scanning phone and the gym, so a disputed scan can be reviewed later (null on older records and when either position was unknown). **Every refusal is logged, throttled ones included** (`RATE_LIMITED`) — a burst of refusals that leaves no record is the case the log exists for. The rate-limit row alone carries no device or distance: the throttle deliberately runs before the QR is parsed.
- `devices` — turnstile devices; token sha256 hash + per-device static `qrContent` (see API surface)
- `device_status_log` — device connect/disconnect events backing the 24 h uptime figure on the panel's Devices page
- `sharing_signals` — account-sharing detection signals with a 30-day TTL (`apps/api/src/sharing.ts`)
- `deletion_requests` — member account-deletion request workflow (`/api/me/deletion-request` + admin approve/reject)
- `renewal_reminders` — bookkeeping of already-sent renewal reminder e-mails, used to dedupe within the reminder window (`apps/api/src/renewals.ts`)
- `weight_history` — member weight entries behind the body-metrics/calorie features; `{ userId, at }` index and a per-member cap enforced at write time
- `settings` — chain-wide singleton, `_id: "chain"`: chain name and `legal: { dataProcessingUrl: string | null, privacyUrl: string | null, version: number }` and `freeze: { enabled, memberSelfService, maxPerYear, maxDays }` — the product ships no legal text, only the operator's document URLs and version; managed via `GET/PUT /api/admin/settings` and read publicly through `GET /api/legal` (see `docs/legal/README.md`).
- `audit_logs` — written via `logAudit()` (`apps/api/src/audit.ts`); **every sensitive admin mutation must call it**, with `gymId` for gym-scoped actions (null for chain-level ones)

`entry_events`, `devices`, `device_status_log` and `sharing_signals` carry `gymId`, and their gym-scoped indexes lead with it.

Profile photos live in a public R2 bucket with no signature and no expiry, so the object key is the only access control: `profilePhotoObjectKey()` mints a **fresh** key on every upload and the previous object is deleted after the DB write commits. Never reuse a key — the `?v=` suffix is a cache-buster, not access control, and the bare key keeps resolving.

### API surface

- `/api/auth/*` — BetterAuth
- `/api/admin/*` (`apps/api/src/routes/admin.ts`) — chain-level: chain-wide unified user search (`q`: phone/e-mail/name), paged user directory `GET /users/directory` (role/2FA/subscription-status/gym filters, backs the panel's Users page), sequential subscriptions (`gymIds` must be active and in the caller's scope), owner-only role assignment and `PUT /users/:id/gyms`, chain settings, audit list (`?gymId=`; admins see only their gyms' rows), owner-only deletion-request approve/reject (approval also erases free-text reasons on the request and on that member's ban/deletion audit rows), `DELETE /subscriptions/:id` (cancel a period that has not started; later periods move earlier)
- `/api/admin/users/:id*` member controls (`apps/api/src/routes/memberControls.ts`, mounted after `adminRouter`) — `GET /users/:id` (`MemberDetail`, backs the panel's shared member drawer), `POST/DELETE /users/:id/ban` (owner/admin), `POST/DELETE /users/:id/freeze` and `POST /users/:id/deletion-request` (owner/admin/staff); all member-only and scoped as described under Authorization
- `/api/admin/gyms*` (`apps/api/src/routes/gyms.ts`) — gym list (scoped for non-owners) and owner-only create/update/deactivate; under `/api/admin/gyms/:gymId/` the gym-scoped `stats`, `entry-events`, `occupancy` and `settings`
- `/api/admin/gyms/:gymId/devices*` (`apps/api/src/routes/devices.ts`) — **owner/admin only, never staff**: every row carries `qrContent`, and that string _is_ the gate credential — anyone holding it can present it to `/api/me/gate-scan`.
- `/api/admin/gyms/:gymId/reports/*` (`apps/api/src/routes/reports.ts`) — gym-scoped summary report, daily entry trend, renewals-due list plus `POST /renewals/:userId/remind`, and CSV export (owner/admin, with a gym column); owner-only chain summary at `GET /api/admin/reports/chain/summary` (see `docs/reports-and-reminders.md`; `REPORTS_TIME_ZONE` decides where day buckets are cut)
- `/api/me/*` (`apps/api/src/routes/me.ts`) — own profile (`GET/PUT /profile`, photo `DELETE /profile-photo`), subscription, entry history (`GET /entries`), weight history, `PATCH /body-metrics`, occupancy, deletion request (`GET/POST/DELETE`), self-service freeze (`POST/DELETE /freeze`, when the chain allows it), and `POST /gate-scan`. The geofence there is **mandatory**: the gym is resolved from the scanned device; an unconfigured gym `location` rejects the scan with `GYM_LOCATION_UNSET` rather than skipping the check, because the printed turnstile QR is public and location is the only thing tying a scan to the building. Entry scans also run anti-passback — strict when a _reachable_ exit device exists, otherwise a per-member cooldown. Occupancy records (`og:inside`, Redis) have two lifetimes: `autoExitHours` ends **counting**, and retention — `max(24h, autoExitHours)`, never shorter than the counting window — ends the record. An hourly reaper (`startOccupancyReaper`) prunes them, so the hash does not depend on the panel being opened. Entry also requires an active subscription whose `gymIds` include the gym (`NOT_ALLOWED_AT_GYM` otherwise); owner, and admin/staff at their own gyms, skip the subscription check but not the geofence. A member is inside at most one gym: entering gym B closes the gym A record (`og:inside:<gymId>`), records a sharing signal when the implied travel speed exceeds 120 km/h, and leaves a single-use `og:autoexited:<gymId>:<userId>` marker so the exit at A is still allowed. A banned member's entry is refused with `BANNED`. A frozen member's entry is checked against a dry run of the freeze credit, and the freeze is ended only after the gate actually opened — a refused scan never unfreezes (`GateScanResponse.unfrozen`). Every one of these controls applies to **entry only**: an exit scan is never refused for location, sharing or subscription reasons, because trapping a member inside a building is worse than the abuse being prevented.
- `GET /api/legal` — public legal document URLs (data processing and privacy)
- `GET /health` — liveness (process answers); `GET /health/ready` — readiness (Mongo and Redis reachable)

Request bodies are validated with zod. An OpenAPI 3.1 document plus Swagger UI exist purely as a development testing aid (`/api/openapi.json`, `/api/docs`): they mount whenever `NODE_ENV` is not `"production"` and are never registered in production — there is no opt-in flag (see `docs/openapi.md`). There is still no codegen: clients use hand-rolled `api<T>()` fetch wrappers and share response types via `@opengym/shared`.

### Clients

- **web**: cookie session (`credentials: "include"`), Vite dev proxy `/api → localhost:3000`. `src/App.tsx` gates by role (members are told to use the mobile app) and forces the ChangePassword screen when `mustChangePassword` is set. The member drawer (`src/components/MemberDrawer.tsx`) is shared by the Users and Entries pages; money-affecting or destructive actions (granting/cancelling periods, ban, freeze, deletion requests) always go through a confirm modal.
- **mobile**: better-auth expo client with SecureStore; its `api()` wrapper sends `Cookie: authClient.getCookie()` manually. Pre-auth screens swap inside a manual state machine in `App.tsx` (`login | register | verify | forgot | resetCode | reset`); the signed-in state is a ban screen when `MyProfile.ban` is set, otherwise a five-tab shell (home/calendar/scan/tools/profile) with pushed full-screen overlays (notifications/settings). No navigation library. A null-rendering session keep-alive at the app root holds one stable subscription to the better-auth session store so discarded concurrent renders cannot re-trigger its fetch during startup (React 19 LogBox "concurrent rendering" warning).

## Conventions & gotchas

- `api` and `shared` are ESM (`"type": "module"`) — relative imports need `.js` extensions. `web` uses bundler resolution (no extensions). `mobile` is not ESM.
- **Everything written in code is English**: identifiers, comments, JSDoc, log and thrown-error text, test titles, i18n keys, and infra docs. Product docs (`PRD.md`, `ROADMAP.md`) stay Turkish.
- Turkish user-facing copy lives in exactly one place per client: the `tr` map in `apps/web/src/i18n/resources.ts` and `apps/mobile/src/i18n/resources.ts`. Translation keys are the English source strings; `t("Overview")` renders "Genel Bakış" under `tr` and falls back to the key itself under `en`. Never hardcode a Turkish literal in a component — add a key to the `tr` map instead.
- The API has no i18n layer, so the little user-facing copy it owns stays Turkish and is deliberately excluded from the English rule: OTP/security e-mail subjects and bodies in `apps/api/src/auth.ts`, renewal reminder e-mails in `apps/api/src/renewals.ts`, and the seeded admin display name in `apps/api/src/seed.ts`. The same carve-out covers the default turnstile display names in `agents/sim/fleet.mjs`, which show up in the admin panel. Everything else in `apps/api` — including `sendApiError` messages, which clients never display because they map on the `code` — is English.
- TS strict + `noUncheckedIndexedAccess` via `tsconfig.base.json`. `mobile` does not extend the base (it extends `expo/tsconfig.base`) and pins its own newer TypeScript.
- Dev infra host ports are non-default to avoid collisions: Mongo `127.0.0.1:27018`, Redis `127.0.0.1:6380` (inside compose network the defaults 27017/6379 apply).
- Expo work: consult the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ — see `apps/mobile/AGENTS.md`.
- After completing a roadmap item, tick its checkbox in `ROADMAP.md`.
