# OpenGym API Surface

Source of truth: checked source under `apps/api/src` and shared types under `packages/shared/src/index.ts`. BetterAuth internals are external library code and `node_modules` is not present in this workspace, so BetterAuth request/response schemas below are limited to what is configured locally; exact BetterAuth library contracts are marked TODO inline.

Sections follow the mount order in `apps/api/src/index.ts`: BetterAuth catch-all, `express.json()`, the development-only OpenAPI router, `/api/admin/gyms`, `/api/admin/reports`, `/api/admin`, member controls (`/api/admin/users/:id*`), `/api/me`, then `GET /api/legal`, `GET /health` and `GET /health/ready`. Order matters: the more specific `/api/admin/gyms` and `/api/admin/reports` prefixes are mounted before the broad `adminRouter`, and `memberControlsRouter` is mounted after it so that `GET /api/admin/users/directory` is not swallowed by `GET /api/admin/users/:id`.

## Table of Contents

- [Auth Model](#auth-model)
- [Error Shapes and Codes](#error-shapes-and-codes)
- [BetterAuth Router (`/api/auth/*`)](#betterauth-router-apiauth)
- [OpenAPI Router (`/api/openapi.json`, `/api/docs`)](#openapi-router-apiopenapijson-apidocs)
- [Admin Gyms Router (`/api/admin/gyms`)](#admin-gyms-router-apiadmingyms)
- [Chain Reports Router (`/api/admin/reports`)](#chain-reports-router-apiadminreports)
- [Admin Router (`/api/admin`)](#admin-router-apiadmin)
- [Member Controls Router (`/api/admin/users/:id`)](#member-controls-router-apiadminusersid)
- [Me Router (`/api/me`)](#me-router-apime)
- [Legal Documents (`/api/legal`)](#legal-documents-apilegal)
- [Health](#health)
- [Device Gateway (`/api/device-gateway`)](#device-gateway-apidevice-gateway)

## Auth Model

- BetterAuth is mounted at `app.all("/api/auth/{*splat}", toNodeHandler(auth))` before `express.json()` at `apps/api/src/index.ts`.
- Sessions are cookie-based. The mobile client uses BetterAuth Expo support and sends the Cookie header manually; server-side session lookup reads request headers via `fromNodeHeaders(req.headers)`.
- Roles are `owner | admin | staff | member` (`packages/shared/src/index.ts`). `owner` is the chain owner and passes every gym scope; `admin` and `staff` are scoped to the gyms in their `gymIds` (always `[]` for `owner` and `member`, even if a stale value is stored). Only the owner assigns roles and gym scope.
- Protected REST routes use `requireRole(...roles)` (`apps/api/src/core/middleware.ts`). It fetches the BetterAuth session, then re-reads the user from Mongo on every request so role, `gymIds`, `ban` and `mustChangePassword` changes are fresh even when the Redis session cache exists.
- Gym-scoped routes (`/api/admin/gyms/:gymId/...`) use `requireGymAccess(...roles)` instead. It performs the same session re-read and role/password gates, then reads `:gymId` from the path: `owner` passes for every existing gym; `admin`/`staff` only for gyms in their re-read `gymIds`. A non-owner gets `403 GYM_OUT_OF_SCOPE` even for an unknown gym (gym ids cannot be probed); only the owner can see `404 GYM_NOT_FOUND`. The gym is never inferred from a header.
- Member controls (`/api/admin/users/:id/ban|freeze|deletion-request`) add a second scope rule on top of the role check, implemented in `apps/api/src/features/members/memberScope.ts`: a non-owner may act on a member only if at least one gym on any of the member's subscription periods (past ones included) is in the caller's `gymIds`; a member with no periods is owner-only. The failure is `403 GYM_OUT_OF_SCOPE "This member has no subscription at any of your gyms."`. Their audit rows are written once per affected gym.
- Common `requireRole` / `requireGymAccess` errors: `401 { code: "AUTH_REQUIRED", message: "Authentication required." }`, `403 { code: "FORBIDDEN", message: "You are not authorized to perform this action." }`, `403 { code: "PASSWORD_CHANGE_REQUIRED", message: "You must change your password before continuing." }`. `requireGymAccess` adds `403 GYM_OUT_OF_SCOPE "This gym is outside your scope."` and `404 GYM_NOT_FOUND "Gym not found."`.
- `mustChangePassword` gate applies to every `requireRole` / `requireGymAccess` route except router-local paths `"/initial-password"` and `"/profile"` (`apps/api/src/core/middleware.ts`). Because `req.path` is router-local, this exempts `POST /api/admin/initial-password` and `GET /api/me/profile`.
- Shorthand used below: "common `requireRole`" means the three errors above; "common `requireGymAccess`" means those three plus `GYM_OUT_OF_SCOPE` and `GYM_NOT_FOUND`; "terminal errors" means the Express error handler outputs listed under Error Shapes and Codes.

## Error Shapes and Codes

Application errors use `ApiErrorResponse` (`packages/shared/src/index.ts`):

```ts
{
  code: ApiErrorCode;
  message: string;
}
```

`sendApiError()` writes that body with the supplied status (`apps/api/src/core/apiError.ts`). The terminal Express error handler also emits:

- `400 INVALID_REQUEST "Invalid request body."` for JSON parse failure (`apps/api/src/index.ts`)
- `413 PAYLOAD_TOO_LARGE "Photo must be at most 10 MB."` for oversized `/api/me/profile-photo` bodies (`apps/api/src/index.ts`)
- `500 INTERNAL_ERROR "An unexpected error occurred. Please try again."` for unhandled errors (`apps/api/src/index.ts`)

Clients map on `code`; messages are English text for logs and API consumers. `ApiErrorCode` values from shared types (`packages/shared/src/index.ts`): the gate refusal codes (`GateRejectCode`) `INVALID_QR`, `UNKNOWN_DEVICE`, `DEVICE_OFFLINE`, `NO_ACTIVE_SUBSCRIPTION`, `NOT_ALLOWED_AT_GYM`, `GYM_INACTIVE`, `LOCATION_REQUIRED`, `OUT_OF_RANGE`, `MOCK_LOCATION`, `SHARING_BLOCKED`, `ALREADY_INSIDE`, `ENTRY_COOLDOWN`, `NOT_INSIDE`, `GYM_LOCATION_UNSET`, `RATE_LIMITED`, `BANNED`; plus `AUTH_REQUIRED`, `FORBIDDEN`, `PASSWORD_CHANGE_REQUIRED`, `INTERNAL_ERROR`, `PAYLOAD_TOO_LARGE`, `PROFILE_PHOTO_MISSING`, `PROFILE_PHOTO_INVALID`, `PROFILE_PHOTO_BUSY`, `PROFILE_PHOTO_RATE_LIMITED`, `PROFILE_PHOTO_UNAVAILABLE`, `INVALID_REQUEST`, `DELETION_MEMBER_ONLY`, `DELETION_ALREADY_PENDING`, `DELETION_NOT_PENDING`, `INVALID_DEVICE_NAME`, `DEVICE_NOT_FOUND`, `PASSWORD_TOO_SHORT`, `CURRENT_PASSWORD_INVALID`, `SEARCH_QUERY_TOO_SHORT`, `INVALID_USER_OR_ROLE`, `SELF_ROLE_CHANGE`, `MFA_REQUIRED`, `MFA_LOCKED`, `MFA_INVALID`, `USER_NOT_FOUND`, `INVALID_SUBSCRIPTION`, `SUBSCRIPTION_BUSY`, `INVALID_USER`, `GYM_NAME_REQUIRED`, `GYM_NOT_FOUND`, `INVALID_GYMS`, `SUBSCRIPTION_ENDED`, `SUBSCRIPTION_NOT_FOUND`, `SUBSCRIPTION_STARTED`, `GYM_OUT_OF_SCOPE`, `LAST_OWNER`, `MEMBER_BANNED`, `MEMBER_FROZEN`, `INVALID_LOCATION`, `INVALID_CAPACITY`, `INVALID_AUTO_EXIT`, `INVALID_SHARING_SETTINGS`, `INVALID_REMINDER_SETTINGS`, `INVALID_LEGAL_SETTINGS`, `INVALID_REPORT_RANGE`, `REMINDER_RECENTLY_SENT`, `NO_UPCOMING_RENEWAL`, `DELETION_REQUEST_NOT_FOUND`, `DELETION_REQUEST_RESOLVED`, `DELETION_CLEANUP_FAILED`, `INVALID_PHONE_NUMBER`, `PHONE_ALREADY_EXISTS`, `MEMBER_ONLY`, `INVALID_BAN_REASON`, `NOT_BANNED`, `FREEZE_DISABLED`, `FREEZE_LIMIT_REACHED`, `ALREADY_FROZEN`, `NOT_FROZEN`, `NO_ACTIVE_PERIOD`, `INVALID_FREEZE_SETTINGS`, `INVALID_CURRENCY`, `PACKAGE_NOT_FOUND`, `INVALID_PACKAGE`, `PRICE_OVERRIDE_FORBIDDEN`, `PACKAGE_PRICE_UNSET`, `PACKAGE_INACTIVE`, `REQUEST_ID_CONFLICT`, `INVALID_PAYMENT`, `SUBSCRIPTION_UNPRICED`, `PAYMENT_GYM_NOT_ON_PERIOD`, `PAYMENT_EXCEEDS_BALANCE`, `PAYMENT_NOT_FOUND`, `PAYMENT_ALREADY_VOIDED`, `SUBSCRIPTION_HAS_PAYMENTS`, `INVALID_DAY`.

BetterAuth errors are generated by BetterAuth. Local hooks add `INVALID_PHONE_NUMBER`, `PHONE_ALREADY_EXISTS`, and the message `"Data processing notice and privacy policy consent are required."` during signup (`apps/api/src/auth/auth.ts`). TODO: unverified - exact BetterAuth HTTP error body shape/status mapping is in external library code not present in this workspace.

## BetterAuth Router (`/api/auth/*`)

Mount source: `apps/api/src/index.ts`. Auth config source: `apps/api/src/auth/auth.ts`.

Global BetterAuth rate limit: enabled, Redis secondary storage, default `60` requests per `60` seconds (`apps/api/src/auth/auth.ts`). Custom rules:

- `/sign-up/email`: `3/60s`, bypassed in development for `@test.com`.
- `/sign-in/email`: `5/60s`, bypassed in development for `@test.com`.
- `/email-otp/send-verification-otp`: `3/60s`, bypassed in development for `@test.com`.
- `/email-otp/verify-email`: `5/60s`, bypassed in development for `@test.com`.
- `/email-otp/request-password-reset`: `3/60s`, bypassed in development for `@test.com`.
- `/email-otp/reset-password`: `5/60s`, bypassed in development for `@test.com`.
- `/two-factor/send-otp`: `3/60s`.
- `/two-factor/verify-totp`: `5/60s`.
- `/two-factor/verify-otp`: `5/60s`.

Configured BetterAuth features: email/password auth (`apps/api/src/auth/auth.ts`), email verification required, email OTP plugin (`apps/api/src/auth/auth.ts`), Expo plugin (`apps/api/src/auth/auth.ts`), two-factor plugin (`apps/api/src/auth/auth.ts`). Locally configured user signup input fields: `firstName: string`, `lastName: string`, `phone: string`, `dataProcessingAccepted: boolean`, `privacyAccepted: boolean`; `role`, `mustChangePassword`, `phoneE164`, consent timestamps are not input fields (`apps/api/src/auth/auth.ts`).

### `POST /api/auth/sign-up/email`

- Source: BetterAuth generated route configured at `apps/api/src/auth/auth.ts`; mounted by `apps/api/src/index.ts`.
- Auth: public.
- Body: TODO: unverified - BetterAuth email signup body, plus local required additional fields `firstName`, `lastName`, `phone`, `dataProcessingAccepted`, `privacyAccepted`; password min length `8`. Local signup hook requires both consent booleans and normalizes phone to E.164.
- Success: TODO: unverified - BetterAuth signup response. Email verification OTP is sent on signup (`sendVerificationOnSignUp: true`).
- Errors: BetterAuth validation errors; local `400 INVALID_PHONE_NUMBER`, `400 PHONE_ALREADY_EXISTS`; consent missing message quoted above.
- Rate limit: `3/60s`, development `@test.com` bypass.
- Audit-logged: no.

### `POST /api/auth/sign-in/email`

- Source: BetterAuth generated route configured at `apps/api/src/auth/auth.ts`; mounted by `apps/api/src/index.ts`.
- Auth: public.
- Body: TODO: unverified - BetterAuth email/password signin body. `x-device-fingerprint` header may be recorded if it is 64 lowercase hex characters (`apps/api/src/auth/auth.ts`).
- Success: TODO: unverified - BetterAuth signin/session response and cookie.
- Errors: BetterAuth errors; session policy enforcement logs but does not fail signin (`apps/api/src/auth/auth.ts`).
- Rate limit: `5/60s`, development `@test.com` bypass.
- Audit-logged: no.

### `POST /api/auth/sign-out`

- Source: TODO: unverified - BetterAuth email/password/session generated route; mounted by `apps/api/src/index.ts`.
- Auth: session required by BetterAuth.
- Body: TODO: unverified.
- Success/errors: TODO: unverified - BetterAuth contract.
- Rate limit: default `60/60s`.
- Audit-logged: no.

### `GET /api/auth/get-session`

- Source: TODO: unverified - BetterAuth session generated route; mounted by `apps/api/src/index.ts`.
- Auth: optional/session-aware BetterAuth route.
- Query/body: TODO: unverified.
- Success/errors: TODO: unverified - BetterAuth contract.
- Rate limit: default `60/60s`.
- Audit-logged: no.

### `POST /api/auth/change-password`

- Source: BetterAuth generated route used by local initial-password handler at `apps/api/src/features/members/router.ts`; mounted by `apps/api/src/index.ts`.
- Auth: session required by BetterAuth.
- Body: TODO: unverified - local caller passes `{ currentPassword: string; newPassword: string; revokeOtherSessions: boolean }`.
- Success/errors: TODO: unverified - BetterAuth contract.
- Rate limit: default `60/60s`.
- Audit-logged: no.

### `POST /api/auth/email-otp/send-verification-otp`

- Source: emailOTP plugin configured at `apps/api/src/auth/auth.ts`; mounted by `apps/api/src/index.ts`.
- Auth: public/session-aware per BetterAuth plugin. TODO: unverified.
- Body/success/errors: TODO: unverified - BetterAuth emailOTP contract. OTP length is `6`, expiry `600` seconds, stored hashed, resend rotates OTP (`apps/api/src/auth/auth.ts`).
- Rate limit: `3/60s`, development `@test.com` bypass.
- Audit-logged: no.

### `POST /api/auth/email-otp/verify-email`

- Source: emailOTP plugin configured at `apps/api/src/auth/auth.ts`; mounted by `apps/api/src/index.ts`.
- Auth: public/session-aware per BetterAuth plugin. TODO: unverified.
- Body/success/errors: TODO: unverified - BetterAuth emailOTP contract.
- Rate limit: `5/60s`, development `@test.com` bypass.
- Audit-logged: no.

### `POST /api/auth/email-otp/request-password-reset`

- Source: emailOTP plugin configured at `apps/api/src/auth/auth.ts`; mounted by `apps/api/src/index.ts`.
- Auth: public.
- Body/success/errors: TODO: unverified - BetterAuth emailOTP contract.
- Rate limit: `3/60s`, development `@test.com` bypass.
- Audit-logged: no.

### `POST /api/auth/email-otp/reset-password`

- Source: emailOTP plugin configured at `apps/api/src/auth/auth.ts`; mounted by `apps/api/src/index.ts`.
- Auth: public with OTP token/code per plugin. TODO: unverified.
- Body/success/errors: TODO: unverified - BetterAuth emailOTP contract. Password reset revokes sessions (`apps/api/src/auth/auth.ts`) and also calls `revokeUserSessions()` best-effort (`apps/api/src/auth/auth.ts`).
- Rate limit: `5/60s`, development `@test.com` bypass.
- Audit-logged: no.

### `POST /api/auth/two-factor/send-otp`

- Source: twoFactor plugin configured at `apps/api/src/auth/auth.ts`; mounted by `apps/api/src/index.ts`.
- Auth: session required by BetterAuth. TODO: unverified.
- Body/success/errors: TODO: unverified - BetterAuth twoFactor contract. Email OTP subject/text configured at `apps/api/src/auth/auth.ts`.
- Rate limit: `3/60s`.
- Audit-logged: no.

### `POST /api/auth/two-factor/verify-totp`

- Source: twoFactor plugin configured at `apps/api/src/auth/auth.ts`; also called by admin role assignment at `apps/api/src/features/members/router.ts`.
- Auth: session required by BetterAuth.
- Body: TODO: unverified - local caller passes `{ code: string }`.
- Success/errors: TODO: unverified - BetterAuth twoFactor contract.
- Rate limit: `5/60s` for HTTP route. Note: local `auth.api.verifyTOTP()` calls inside `POST /api/admin/users/:id/role` are additionally protected by a custom Redis lockout after `5` failed attempts in `15` minutes.
- Audit-logged: no.

### `POST /api/auth/two-factor/verify-otp`

- Source: twoFactor plugin configured at `apps/api/src/auth/auth.ts`; also called by admin role assignment at `apps/api/src/features/members/router.ts`.
- Auth: session required by BetterAuth.
- Body: TODO: unverified - local caller passes `{ code: string }`.
- Success/errors: TODO: unverified - BetterAuth twoFactor contract.
- Rate limit: `5/60s` for HTTP route. Same custom admin role-assignment lockout note as above.
- Audit-logged: no.

### Other BetterAuth-generated endpoints

TODO: unverified - BetterAuth may expose additional enabled email/password, session, account, or two-factor management routes from the configured plugins. The mounted catch-all accepts any `/api/auth/*` path and delegates routing to BetterAuth; exact route inventory cannot be proven from local source without the installed BetterAuth package.

## OpenAPI Router (`/api/openapi.json`, `/api/docs`)

Source: `apps/api/src/openapi/router.ts`, mounted at `/api` by `apps/api/src/index.ts`. A development testing aid only (`docs/openapi.md`): the two routes below exist only when `NODE_ENV` is not `"production"`; in production nothing is registered and there is no opt-in flag.

### `GET /api/openapi.json`

- Auth: public (development only).
- Success: `200` JSON OpenAPI 3.1 document.

### `GET /api/docs` (and sub-paths)

- Auth: public (development only).
- Success: Swagger UI (static assets served by `swagger-ui-express`), pointed at `/api/openapi.json`.

## Admin Gyms Router (`/api/admin/gyms`)

Source: `apps/api/src/features/gyms/router.ts`. Gym create/update are owner-only; everything under `/:gymId/...` uses `requireGymAccess` (see Auth Model). Gyms are deactivated, never deleted. The devices router and the per-gym reports router are mounted under `/:gymId/devices` and `/:gymId/reports` (sections below).

### `GET /api/admin/gyms/`

- Source: `apps/api/src/features/gyms/router.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies. The owner gets every gym; admin/staff get only the gyms in their `gymIds` (`listGymsFor`).
- Params/body: none.
- Success: `200` JSON, `Gym[]` (`packages/shared/src/index.ts`): each `{ id; name; location: { lat; lng; radiusM } | null; capacity: number | null; autoExitHours; sharing; reminders; active; createdAt }`.
- Errors: common `requireRole`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `POST /api/admin/gyms/`

- Source: `apps/api/src/features/gyms/router.ts`
- Auth: `requireRole("owner")`; `mustChangePassword` gate applies.
- Body: `GymCreateInput`: `{ name: string trim 1-100; location?: { lat: -90..90; lng: -180..180; radiusM?: int } | null; capacity?: positive number | null; autoExitHours?: int 1-48 | null }`. `radiusM` is an integer 100-5000 (default 400), constants in `apps/api/src/lib/geo.ts`. Missing `autoExitHours` defaults to `4`; missing `location`/`capacity` are stored as `null`.
- Success: `201` JSON, `Gym` of the created gym (active).
- Errors: common `requireRole`; `400 INVALID_LOCATION "Invalid location information."`; `400 INVALID_CAPACITY "Invalid capacity."`; `400 INVALID_AUTO_EXIT "Invalid automatic exit duration."`; `400 GYM_NAME_REQUIRED "Gym name is required."` (any other validation failure, including a bad `name`); terminal errors. The error code is chosen from the first failing field.
- Rate limit: none.
- Audit-logged: yes, `gym-created` (target and `gymId` = new gym id; details `{ name }`).

### `GET /api/admin/gyms/:gymId`

- Source: `apps/api/src/features/gyms/router.ts`
- Auth: `requireGymAccess("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id.
- Success: `200` JSON, `Gym`.
- Errors: common `requireGymAccess`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `PUT /api/admin/gyms/:gymId`

- Source: `apps/api/src/features/gyms/router.ts`
- Auth: `requireGymAccess("owner")`; `mustChangePassword` gate applies. A non-owner is refused by the role gate (`403 FORBIDDEN`) before the scope check.
- Path params: `gymId: string` gym id.
- Body: `GymUpdateInput`: `{ name?: string trim 1-100; active?: boolean }`; at least one field is required. `active: false` is how a gym is deactivated: an inactive gym refuses every entry scan (`GYM_INACTIVE`).
- Success: `200` JSON, updated `Gym`.
- Errors: common `requireGymAccess`; `400 GYM_NAME_REQUIRED "Gym name is required."` (invalid body or no field supplied); terminal errors.
- Rate limit: none.
- Audit-logged: yes, `gym-renamed` (when the name changed; details `{ previousName, name }`), `gym-deactivated` / `gym-activated` (when `active` changed); all with `gymId`.

### `GET /api/admin/gyms/:gymId/settings`

- Source: `apps/api/src/features/gyms/router.ts`
- Auth: `requireGymAccess("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id.
- Success: `200` JSON, full `Gym` (a superset of `GymSettings`).
- Errors: common `requireGymAccess`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `PUT /api/admin/gyms/:gymId/settings`

- Source: `apps/api/src/features/gyms/router.ts`
- Auth: `requireGymAccess("owner", "admin")`; `mustChangePassword` gate applies (never staff).
- Path params: `gymId: string` gym id.
- Body: `GymSettings`: `{ location?: { lat; lng; radiusM? } | null; capacity?: positive number | null; autoExitHours?: int 1-48 | null; sharing?: { memberMaxSessions: int 1-10; staffMaxSessions: int 1-20; signalThreshold: int 1-20; signalWindowHours: int 1-168; qrBlockHours: int 1-168 }; reminders?: { enabled: boolean; daysBefore: int 0-90 array, 1-5 items } }`. `location`, `capacity` and `autoExitHours` are always written: omitted or `null` stores `null` (`null`, `null`, default `4` respectively), so send the current values to keep them. `sharing` and `reminders` are updated only when present.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireGymAccess`; `400 INVALID_LOCATION`, `INVALID_CAPACITY`, `INVALID_AUTO_EXIT`, `INVALID_SHARING_SETTINGS "Invalid sharing detection settings."`, `INVALID_REMINDER_SETTINGS "Invalid renewal reminder settings."` (code chosen from the first failing field); `400 GYM_NAME_REQUIRED` (fallback for an unrecognized failing field); terminal errors.
- Rate limit: none.
- Audit-logged: yes, `gym-settings-updated` (details: previous and new `location`, `capacity`, `autoExitHours`, plus `sharing` / `reminders` when sent; with `gymId`).

### `GET /api/admin/gyms/:gymId/occupancy`

- Source: `apps/api/src/features/gyms/router.ts`
- Auth: `requireGymAccess("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id.
- Success: `200` JSON, `OccupancyResponse` (`packages/shared/src/index.ts`): `{ gymId; gymName; inside: number; capacity: number | null; ratio: number | null }` (`ratio` rounded to two decimals; `inside` excludes records older than `autoExitHours`).
- Errors: common `requireGymAccess`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `GET /api/admin/gyms/:gymId/inside`

- Source: `apps/api/src/features/gyms/router.ts`
- Auth: `requireGymAccess("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id.
- Success: `200` JSON, `GymInsideResponse` (`packages/shared/src/index.ts`): `{ gymId; members: { userId; name; profilePhotoUrl: string | null; enteredAt }[] }`, members counted inside right now (same cutoff as `occupancy`), longest-staying first.
- Errors: common `requireGymAccess`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `GET /api/admin/gyms/:gymId/stats`

- Source: `apps/api/src/features/gyms/router.ts`
- Auth: `requireGymAccess("owner", "admin", "staff")`; `owner` passes for every gym, `admin`/`staff` only for gyms in their re-read `gymIds`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id.
- Body: none.
- Success: `200` JSON, `AdminStats` (`packages/shared/src/index.ts`): `{ activeMembers: number; frozenMembers: number; renewalsDue: number }` for that gym. Frozen members are excluded from `activeMembers` and `renewalsDue` and counted in `frozenMembers`.
- Errors: common `requireRole` gate errors; `403 GYM_OUT_OF_SCOPE "This gym is outside your scope."` (non-owner, including for an unknown gym); `404 GYM_NOT_FOUND "Gym not found."` (owner only); terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `GET /api/admin/gyms/:gymId/entry-events`

- Source: `apps/api/src/features/gyms/router.ts`
- Auth: `requireGymAccess("owner", "admin", "staff")`; `owner` passes for every gym, `admin`/`staff` only for gyms in their re-read `gymIds`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id.
- Query: `cursor?: string`; `limit?: int 1-100, default 50`; `deviceId?: string max 64`; `userId?: string max 64`; `allowed?: "true" | "false"`; `from?: date`; `to?: date` (inclusive range on `at`). Results are always limited to the path gym.
- Success: `200` JSON, `Page<EntryEvent>` (`packages/shared/src/index.ts`): `{ items: EntryEvent[]; nextCursor: string | null }`, newest first. `EntryEvent` includes `gymId`, `reason` (null when allowed) and `distanceM` (null on older records or when a position was unknown).
- Errors: common `requireRole` gate errors; `403 GYM_OUT_OF_SCOPE "This gym is outside your scope."`; `404 GYM_NOT_FOUND "Gym not found."` (owner only); `400 INVALID_REQUEST "Invalid list query parameters."`; `400 INVALID_REQUEST "Invalid pagination cursor."`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### Gym Devices Router (`/api/admin/gyms/:gymId/devices`)

Source: `apps/api/src/features/devices/router.ts`, mounted by the gyms router at `/:gymId/devices`. **Owner/admin only, never staff**: every device row carries `qrContent`, and that string is the gate credential (anyone holding it can present it to `/api/me/gate-scan`).

#### `POST /api/admin/gyms/:gymId/devices/`

- Source: `apps/api/src/features/devices/router.ts`
- Auth: `requireGymAccess("owner", "admin")`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id.
- Body: `{ name: string trim min 1 max 100; direction?: "in" | "out" | "both" default "in" }`.
- Success: `200` JSON, `DeviceCreated` (`packages/shared/src/index.ts`): `{ id: string; gymId: string; name: string; direction: "in" | "out" | "both"; token: string; qrContent: string; exitQrContent: string | null }`. `token` is shown only in this response; only its SHA-256 hash is stored.
- Errors: common `requireGymAccess`; `400 INVALID_DEVICE_NAME "Invalid device name."`; terminal errors.
- Rate limit: none.
- Audit-logged: yes, `device-created` (details `{ name, direction }`, with `gymId`).

#### `GET /api/admin/gyms/:gymId/devices/`

- Source: `apps/api/src/features/devices/router.ts`
- Auth: `requireGymAccess("owner", "admin")`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id.
- Success: `200` JSON, `Device[]` (`packages/shared/src/index.ts`) of that gym, newest first: each `{ id; gymId; name; direction; online; lastSeenAt; createdAt; uptime24h; qrContent; exitQrContent }`.
- Errors: common `requireGymAccess`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

#### `DELETE /api/admin/gyms/:gymId/devices/:id`

- Source: `apps/api/src/features/devices/router.ts`
- Auth: `requireGymAccess("owner", "admin")`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id; `id: string` Mongo ObjectId of a device of that gym. A device of another gym is not found.
- Success: `200` JSON `{ ok: true }`; a connected device is disconnected from the gateway.
- Errors: common `requireGymAccess`; `404 DEVICE_NOT_FOUND "Device not found."` (malformed id, unknown device, or device in another gym); terminal errors.
- Rate limit: none.
- Audit-logged: yes, `device-deleted` (with `gymId`).

#### Bidirectional turnstiles

A single physical turnstile can be registered with `direction: "both"`. Print both QRs from the Devices page: attach `qrContent` to the entry face and `exitQrContent` to the exit face. Each uses `OGGATE1.<deviceId>.<side>.<sig>`, where `side` is `in` or `out` and the HMAC signs `<deviceId>.<side>`. The QR explicitly selects the direction; the server never infers it from occupancy. A reachable bidirectional device counts as an exit device for strict anti-passback.

Single-direction devices keep the unchanged `OGGATE1.<deviceId>.<sig>` format, signing only `<deviceId>`, and return `exitQrContent: null`. A sided QR on a single-direction device or a legacy QR on a bidirectional device is refused with `INVALID_QR` and logged in `entry_events`. Scan responses and event directions remain `"in" | "out"`; existing entry checks apply only to entry scans. Gateway open commands include `side: "in" | "out"`, which bidirectional agents must honor; a single-direction agent may ignore it. The simulator accepts `"Name:both"` during setup and logs the received side.

### Gym Reports Router (`/api/admin/gyms/:gymId/reports`)

Source: `apps/api/src/features/reports/router.ts` (`gymReportsRouter`), mounted by the gyms router at `/:gymId/reports`. Day buckets are cut in the `REPORTS_TIME_ZONE` zone (`docs/reports-and-reminders.md`). Range queries (`summary`, `entry-trend`, `export`) take `from?: date` and `to?: date`: `to` defaults to now, `from` defaults to `to` minus 30 days, `from` must not be after `to`, and the span may not exceed 366 days.

#### `GET /api/admin/gyms/:gymId/reports/summary`

- Source: `apps/api/src/features/reports/router.ts`
- Auth: `requireGymAccess("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id.
- Query: `from?: date`; `to?: date` (see above).
- Success: `200` JSON, `ReportSummary` (`packages/shared/src/index.ts`): `{ range; timeZone; activeMembers; frozenMembers; newMembers; newSubscriptions; lapsedMembers; renewalsDue; entries: { total; allowed; denied; uniqueMembers } }`.
- Errors: common `requireGymAccess`; `400 INVALID_REPORT_RANGE` (unparseable date, `from` after `to`, or span over 366 days); terminal errors.
- Rate limit: none.
- Audit-logged: no.

#### `GET /api/admin/gyms/:gymId/reports/entry-trend`

- Source: `apps/api/src/features/reports/router.ts`
- Auth: `requireGymAccess("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id.
- Query: `from?: date`; `to?: date`.
- Success: `200` JSON, `EntryTrend`: `{ range; timeZone; points: { date: "YYYY-MM-DD"; total; allowed; denied }[] }`.
- Errors: common `requireGymAccess`; `400 INVALID_REPORT_RANGE`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

#### `GET /api/admin/gyms/:gymId/reports/renewals`

- Source: `apps/api/src/features/reports/router.ts`
- Auth: `requireGymAccess("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id.
- Query: `cursor?: string`; `limit?: int 1-100, default 50`; `withinDays?: int 1-90, default 7`.
- Success: `200` JSON, `Page<RenewalDueMember>`: `{ items: { userId; firstName; lastName; email; phone; endsAt; remainingDays; lastReminderAt: string | null }[]; nextCursor: string | null }`. Frozen members are excluded.
- Errors: common `requireGymAccess`; `400 INVALID_REQUEST "Invalid list query parameters."`; `400 INVALID_REQUEST "Invalid pagination cursor."`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

#### `POST /api/admin/gyms/:gymId/reports/renewals/:userId/remind`

- Source: `apps/api/src/features/reports/router.ts`
- Auth: `requireGymAccess("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `gymId: string` gym id; `userId: string` Mongo ObjectId of the member.
- Body: none.
- Success: `200` JSON, `RenewalReminderResult`: `{ sent: true; sentAt: string }`. Sends a renewal reminder e-mail to the member.
- Errors: common `requireGymAccess`; `400 INVALID_USER "Invalid user id."`; `404 NO_UPCOMING_RENEWAL "This member has no upcoming subscription to remind about."` (no subscription for this gym, the latest one has already ended, or the member is frozen); `429 REMINDER_RECENTLY_SENT "This member was reminded recently. Try again later."` (cooldown, or another send in progress); terminal errors.
- Rate limit: per-subscription cooldown enforced under a lock inside the send helper (`apps/api/src/features/reports/renewals.ts`); no request limiter.
- Audit-logged: yes, `renewal-reminder-sent` (target = member id, details `{ remainingDays }`, with `gymId`).

#### `GET /api/admin/gyms/:gymId/reports/cash`

- Source: `apps/api/src/features/reports/router.ts`, `apps/api/src/features/payments/cashReport.ts`
- Auth: `requireGymAccess("owner", "admin")`; `mustChangePassword` gate applies (staff record payments but do not see the till).
- Query: `day?: YYYY-MM-DD` (a real calendar date; defaults to today in `REPORTS_TIME_ZONE`). The day is cut at local midnight with a DST-safe range (`localDayRange` in `apps/api/src/features/reports/reports.ts`), so it can be 23 or 25 hours long.
- Success: `200` JSON, `CashReport` (`packages/shared/src/index.ts`): `{ day; timeZone; totals: CashTotals[]; payments; voided; truncated: boolean }`. `totals` has one entry per currency (normally one) with `totalMinor`, `count`, `byMethod` and `byStaff` over all non-voided payments recorded at this gym that day; `payments` lists them, `voided` lists that day's payments that were voided since (excluded from `totals`). The combined row list is capped at 5,000; `truncated` is true when more rows exist.
- Errors: common `requireGymAccess`; `400 INVALID_DAY "Day must be a calendar date as YYYY-MM-DD."`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

#### `GET /api/admin/gyms/:gymId/reports/debtors`

- Source: `apps/api/src/features/reports/router.ts`, `apps/api/src/features/payments/debtors.ts`
- Auth: `requireGymAccess("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Query: `limit?: 1-100` (default 50); `cursor?: string`.
- Success: `200` JSON, `Page<DebtorRow>`. Periods listing this gym that have a `sale` with a positive balance, frozen and expired ones included. Order: overdue first (a past `nextPaymentDue`), then by due date (undated last), then larger balance first; the opaque cursor carries all three sort keys.
- Errors: common `requireGymAccess`; `400 INVALID_REQUEST "Invalid list query parameters."`; `400 INVALID_REQUEST "Invalid pagination cursor."`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

#### `GET /api/admin/gyms/:gymId/reports/export`

- Source: `apps/api/src/features/reports/router.ts`
- Auth: `requireGymAccess("owner", "admin")`; `mustChangePassword` gate applies (never staff: the export is bulk personal data).
- Path params: `gymId: string` gym id.
- Query: `dataset: "members" | "subscriptions" | "entries" | "payments"` (required; `payments` lists the gym's payments paid in the range by `paidAt`, voided ones marked in the `voided*` columns); `from?: date`; `to?: date`.
- Success: `200` streamed CSV (`text/csv; charset=utf-8`, UTF-8 BOM, `Content-Disposition: attachment; filename="opengym-<gymId>-<dataset>-<to date>.csv"`, `Cache-Control: no-store`). A failure after streaming has started destroys the connection rather than sending a JSON error.
- Errors: common `requireGymAccess`; `400 INVALID_REQUEST "Invalid export parameters."`; `400 INVALID_REPORT_RANGE`; terminal errors (before streaming starts).
- Rate limit: none.
- Audit-logged: yes, `data-exported` (details `{ dataset, from, to }`, with `gymId`), written before the stream starts.

## Chain Reports Router (`/api/admin/reports`)

Source: `apps/api/src/features/reports/router.ts` (`chainReportsRouter`).

### `GET /api/admin/reports/chain/summary`

- Source: `apps/api/src/features/reports/router.ts`
- Auth: `requireRole("owner")`; `mustChangePassword` gate applies.
- Query: `from?: date`; `to?: date` (same defaults and 366-day limit as the per-gym reports).
- Success: `200` JSON, `ChainSummary` (`packages/shared/src/index.ts`): `{ range; timeZone; activeMembers; frozenMembers; gyms: { gymId; gymName; active; activeMembers; frozenMembers; renewalsDue; inside; entries: { total; allowed; denied; uniqueMembers } }[] }`.
- Errors: common `requireRole`; `400 INVALID_REPORT_RANGE`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

## Admin Router (`/api/admin`)

`adminRouter` (`apps/api/src/features/admin/router.ts`) aggregates, in this order: members, subscriptions, payments, packages, settings, audit and deletion-requests routers. Gym-scoped admin routes live under `/api/admin/gyms/:gymId/...` (above) and member controls under `/api/admin/users/:id*` (below).

### `POST /api/admin/initial-password`

- Source: `apps/api/src/features/members/router.ts`
- Auth: `requireRole("owner", "admin", "staff", "member")`; exempt from `mustChangePassword` gate.
- Body: `{ currentPassword: string; newPassword: string min 8 }`.
- Success: `200` JSON `{ ok: true }`; clears `mustChangePassword`.
- Errors: common `requireRole` except password gate; `400 PASSWORD_TOO_SHORT "New password must be at least 8 characters long."` (any invalid body); `400 CURRENT_PASSWORD_INVALID "Current password is incorrect."`; terminal errors.
- Rate limit: none locally; underlying `auth.api.changePassword()` is an internal call, not BetterAuth HTTP rate limit.
- Audit-logged: yes, `initial-password-changed`.

### `GET /api/admin/users`

- Source: `apps/api/src/features/members/router.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Query: `q: string` trimmed min length 2. Searches phone, email, first/last/name chain-wide (not gym-scoped); result limit `20` (`apps/api/src/features/members/userSearch.ts`).
- Success: `200` JSON, `PublicUser[]` (`packages/shared/src/index.ts`).
- Errors: common `requireRole`; `400 SEARCH_QUERY_TOO_SHORT "Enter at least two characters to search."`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `GET /api/admin/users/directory`

- Source: `apps/api/src/features/members/router.ts` (query schema in `apps/api/src/features/members/userDirectory.ts`). Mounted before member controls' `GET /users/:id`.
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies. Chain-wide like the search endpoint.
- Query: `q?: string` (empty means no search, otherwise min 2 characters after trim); `role?: comma-separated owner|admin|staff|member`; `twoFactor?: "on" | "off"`; `status?: comma-separated active|frozen|expired|none`; `gymId?: 24-hex gym id` (admin/staff scoped to that gym, and members whose current period, or latest started period while frozen, covers it); `sort?: "name" | "createdAt"` default `createdAt`; `dir?: "asc" | "desc"` (default `asc` for `name`, `desc` for `createdAt`); `page?: int >= 1` default 1; `pageSize?: int 1-100` default 25.
- Success: `200` JSON, `UserDirectoryPage` (`packages/shared/src/index.ts`): `{ total; page; pageSize; items: UserDirectoryRow[] }`. Each row is a `PublicUser` plus `subscriptionStatus`, `subscriptionEndsAt`, `subscriptionGymIds` and `presence` (`null` when outside, or when the gym they are inside is outside a non-owner caller's scope).
- Errors: common `requireRole`; `400 INVALID_REQUEST "Invalid user directory query parameters."`; `400 SEARCH_QUERY_TOO_SHORT "Enter at least two characters to search."`; `403 GYM_OUT_OF_SCOPE "This gym is outside your scope."` (`gymId` outside a non-owner's `gymIds`); terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `POST /api/admin/users/:id/role`

- Source: `apps/api/src/features/members/router.ts`
- Auth: `requireRole("owner")`; `mustChangePassword` gate applies.
- Path params: `id: string` Mongo ObjectId.
- Body: `{ role: "owner" | "admin" | "staff" | "member"; mfaCode?: string min 1; mfaMethod?: "totp" | "otp" }`. `mfaCode` and `mfaMethod` are required only when the caller has `twoFactorEnabled`. Changing a user to `member` or `owner` clears their `gymIds`; changing to `admin`/`staff` keeps them (assign scope with `PUT /users/:id/gyms`). Every change is serialized by the `og:lock:owner-role` Redis lock.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; `400 INVALID_USER_OR_ROLE "Invalid user or role."`; `400 SELF_ROLE_CHANGE "You cannot change your own role."`; `403 MFA_REQUIRED "MFA verification is required for this action."`; `429 MFA_LOCKED "Too many invalid code attempts. Try again in 15 minutes."`; `403 MFA_INVALID "The verification code is invalid or has expired."`; `429 RATE_LIMITED "Another role change is in progress. Please retry."` (lock wait timed out); `404 USER_NOT_FOUND "User not found."`; `409 LAST_OWNER "The last owner cannot be demoted."`; `409 MEMBER_BANNED "Unban the member before changing their role."` and `409 MEMBER_FROZEN "End the member's freeze before changing their role."` (a banned or frozen member cannot be promoted); terminal errors.
- Rate limit: custom MFA failure lockout after `5` failures for `15` minutes per owner; no route-wide request limiter.
- Audit-logged: yes, `role-assigned` (details `{ previousRole, newRole, mfaVerified }`; chain-level, no `gymId`).

### `PUT /api/admin/users/:id/gyms`

- Source: `apps/api/src/features/members/router.ts`
- Auth: `requireRole("owner")`; `mustChangePassword` gate applies.
- Path params: `id: string` Mongo ObjectId of an `admin` or `staff` account.
- Body: `{ gymIds: string[] }` (items 1-64 characters, max 200 items, duplicates removed; may be empty). Replaces the account's whole gym scope.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; `400 INVALID_GYMS "Invalid gym list."` (malformed id or body); `404 GYM_NOT_FOUND "One or more gyms do not exist."`; `404 USER_NOT_FOUND "User not found."`; `400 INVALID_USER_OR_ROLE "Only admin and staff accounts have a gym scope."`; terminal errors.
- Rate limit: none.
- Audit-logged: yes, `user-gyms-assigned` (details `{ previousGymIds, newGymIds }`; chain-level, no `gymId`).

### `POST /api/admin/subscriptions`

- Source: `apps/api/src/features/subscriptions/router.ts`, `apps/api/src/features/subscriptions/sale.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Body: strict object, one of two shapes. Both carry `userId: string`, `gymIds: string[]` (items 1-64 characters, max 200), `nextPaymentDue?: ISO date | null`, `note?: string` (trim, max 500) and `requestId: string` (client UUID). Catalog sale: `{ packageId: string; priceMinor?: int; expectedPriceMinor?: int }` (owner/admin/staff; `priceMinor` is an owner/admin-only override; without an override, optional `expectedPriceMinor` must match the current catalog price or the sale is refused). Custom grant: `{ custom: { days: int 1-366; priceMinor: int; label?: string 1-80 } }` (owner/admin only). Prices are integer minor units, `0 <= priceMinor <= 10_000_000_000`. `gymIds` must be non-empty, active, and all inside the caller's scope (owner: any gym). The new period is appended after the member's latest period; month packages use clamped calendar months, day packages and custom grants add `days x 24 h`. The period stores a `sale` snapshot (package name, duration, list price, price, chain currency, `nextPaymentDue`).
- Idempotency: a repeated `requestId` for the same member returns the existing period (`200`, same body, no second period, no second audit row); the lookup also runs under the per-user lock and a unique partial index on `subscriptions.requestId` is the backstop.
- Success: `200` JSON `{ ok: true; id: string; startsAt: string; endsAt: string }`.
- Errors: common `requireRole`; `400 INVALID_SUBSCRIPTION "Enter a valid user and subscription plan."`; `403 PRICE_OVERRIDE_FORBIDDEN` (staff sent `priceMinor` or `custom`); `400 INVALID_GYMS "Select at least one active gym."` (empty or malformed `gymIds`); `403 GYM_OUT_OF_SCOPE "A selected gym is outside your scope."`; `404 GYM_NOT_FOUND "A selected gym does not exist."`; `400 GYM_INACTIVE "A selected gym is inactive."`; `404 USER_NOT_FOUND "User not found."`; `404 PACKAGE_NOT_FOUND`; `409 PACKAGE_INACTIVE`; `409 PACKAGE_PRICE_UNSET` (package has no price and no override); `409 PACKAGE_PRICE_CHANGED` (expected catalog price differs, including a cleared price); `409 REQUEST_ID_CONFLICT` (the id belongs to another member's period); `503 SUBSCRIPTION_BUSY "A subscription operation is in progress. Please try again."`; terminal errors.
- Rate limit: no request limiter; per-user Redis subscription lock waits up to `5s` with `30s` lease (`apps/api/src/features/subscriptions/subscriptions.ts`).
- Audit-logged: yes, `subscription-created`, one row per gym on the period (target = member id; details `{ package, packageId, duration, listPriceMinor, priceMinor, currency, custom, startsAt, endsAt, subscriptionId, gymIds }`, so an override shows both the list and the sale price).

### `PUT /api/admin/subscriptions/:id/gyms`

- Source: `apps/api/src/features/subscriptions/router.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `id: string` Mongo ObjectId of a subscription period.
- Body: strict object `{ gymIds: string[] }` (items 1-64 characters, max 200; must contain at least one gym). Changes which gyms a current or future period covers without touching its dates. A non-owner may only add or remove gyms in their own scope. Newly added gyms must be active and in scope; gyms already on the period are kept even if since deactivated.
- Success: `200` JSON, the updated `Subscription` (`packages/shared/src/index.ts`, with `sale`, `paidMinor`, `balanceMinor`; `sale` is null when the period has no sale or has no gym in a non-owner caller's scope).
- Errors: common `requireRole`; `400 INVALID_GYMS "Select at least one active gym."`; `404 SUBSCRIPTION_NOT_FOUND "Subscription not found."`; `409 SUBSCRIPTION_ENDED "This subscription period has already ended."`; `403 GYM_OUT_OF_SCOPE "A selected gym is outside your scope."` (removing or adding a gym outside the caller's scope); `404 GYM_NOT_FOUND "A selected gym does not exist."`; `400 GYM_INACTIVE "A selected gym is inactive."` (added gym); terminal errors.
- Rate limit: none.
- Audit-logged: yes, `subscription-gyms-updated`, one row per gym added or removed (target = member id; details `{ subscriptionId, before, after }`).

### `DELETE /api/admin/subscriptions/:id`

- Source: `apps/api/src/features/subscriptions/router.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `id: string` Mongo ObjectId of a subscription period.
- Behavior: cancels a period that has not started; the member's later periods move earlier by the cancelled duration so no gap remains. Every gym on the period must be inside the caller's scope.
- Success: `200` JSON, `CancelSubscriptionResponse` (`packages/shared/src/index.ts`): `{ ok: true; shifted: Subscription[] }` (the later periods with their new dates).
- Errors: common `requireRole`; `404 SUBSCRIPTION_NOT_FOUND "Subscription not found."` (also for a malformed id); `409 SUBSCRIPTION_STARTED "This subscription period has already started and cannot be cancelled."`; `409 SUBSCRIPTION_HAS_PAYMENTS` (the period has non-voided payments: void them first; checked under the lock); `403 GYM_OUT_OF_SCOPE "A gym on this subscription is outside your scope."`; `503 SUBSCRIPTION_BUSY`; terminal errors.
- Rate limit: per-user Redis subscription lock as above.
- Audit-logged: yes, `subscription-cancelled`, one row per gym on the cancelled period (target = member id; details include `subscriptionId`, `startsAt`, `endsAt`, `gymIds`, `shifted`).

### `GET /api/admin/users/:id/subscriptions`

- Source: `apps/api/src/features/subscriptions/router.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies. Not gym-scoped; the user id is not checked for existence.
- Path params: `id: string` Mongo ObjectId.
- Success: `200` JSON, `Subscription[]` (`packages/shared/src/index.ts`, each with `gymIds`, `sale`, `paidMinor`, `balanceMinor`), max `50` records, latest `endsAt` first. A non-owner gets `sale: null` (and null amounts) for periods with no gym in their scope.
- Errors: common `requireRole`; `400 INVALID_USER "Invalid user."`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `PATCH /api/admin/subscriptions/:id/sale`

- Source: `apps/api/src/features/payments/router.ts`
- Auth: `requireRole("owner", "admin")`; `mustChangePassword` gate applies. A non-owner needs a gym of the period in scope.
- Body: strict object `{ nextPaymentDue: ISO date | null }` (null clears the promise date). The price and payments are untouched.
- Success: `200` JSON, the updated `Subscription`.
- Errors: common `requireRole`; `400 INVALID_SUBSCRIPTION`; `404 SUBSCRIPTION_NOT_FOUND`; `403 GYM_OUT_OF_SCOPE`; `409 SUBSCRIPTION_UNPRICED` (the period has no sale); terminal errors.
- Rate limit: none.
- Audit-logged: yes, `subscription-sale-updated`, one row per gym on the period (details `{ subscriptionId, before, after }`).

### `GET /api/admin/subscriptions/:id/payments`

- Source: `apps/api/src/features/payments/router.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies. A non-owner needs a gym of the period in scope.
- Success: `200` JSON, `Payment[]` (newest first, voided ones included with `void` set), max `200`.
- Errors: common `requireRole`; `404 SUBSCRIPTION_NOT_FOUND`; `403 GYM_OUT_OF_SCOPE`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `POST /api/admin/subscriptions/:id/payments`

- Source: `apps/api/src/features/payments/router.ts`, `apps/api/src/features/payments/payments.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Body: strict object `{ amountMinor: int >= 1; method: "cash" | "card" | "transfer" | "other"; gymId: string; note?: string (trim, max 200); requestId: string (UUID) }`. `gymId` must be in the caller's scope and on the period's `gymIds`; the period must have a `sale`. The payment takes the sale's currency. Runs under the member's subscription lock; the balance is recomputed from the payments collection inside it.
- Idempotency: a repeated `requestId` returns the existing payment (`200`); two concurrent requests can never overpay.
- Success: `200` JSON, `PaymentResult` `{ payment: Payment; paidMinor; balanceMinor }`.
- Errors: common `requireRole`; `400 INVALID_PAYMENT`; `404 SUBSCRIPTION_NOT_FOUND`; `403 GYM_OUT_OF_SCOPE`; `409 SUBSCRIPTION_UNPRICED`; `409 PAYMENT_GYM_NOT_ON_PERIOD`; `409 PAYMENT_EXCEEDS_BALANCE`; `409 REQUEST_ID_CONFLICT` (the id belongs to another period); `503 SUBSCRIPTION_BUSY`; terminal errors.
- Rate limit: per-user Redis subscription lock as above.
- Audit-logged: yes, `payment-recorded` (target = member id; details `{ paymentId, subscriptionId, amountMinor, currency, method, packageName, balanceMinor }`, with the payment's `gymId`); a replay writes no second row.

### `POST /api/admin/payments/:id/void`

- Source: `apps/api/src/features/payments/router.ts`
- Auth: `requireRole("owner", "admin")`; `mustChangePassword` gate applies. The payment's gym must be in scope.
- Path params: `id: string` Mongo ObjectId of a payment.
- Body: strict object `{ reason: string (trim, 3-200) }`. Once only; a voided payment stays visible but no longer counts toward the balance or the cash totals. The void and audit write run under the member's subscription lock, shared with account deletion. An erased member (`userId: null` or missing user) cannot be voided.
- Success: `200` JSON, `PaymentResult`.
- Errors: common `requireRole`; `400 INVALID_PAYMENT`; `404 PAYMENT_NOT_FOUND` (also for an erased member); `403 GYM_OUT_OF_SCOPE`; `409 PAYMENT_ALREADY_VOIDED`; `503 SUBSCRIPTION_BUSY`; terminal errors.
- Rate limit: per-user Redis subscription lock as above; `void: null` makes the claim atomic.
- Audit-logged: yes, `payment-voided` (target = member id; details `{ paymentId, subscriptionId, amountMinor, currency, reason }`, with the payment's `gymId`; the reason is erased from the audit row on account deletion).

### `GET /api/admin/packages`

- Source: `apps/api/src/features/packages/router.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Query: `all?: "true" | "false"`. Default lists active packages (for the sale modal); `all=true` also lists inactive ones and is owner-only.
- Success: `200` JSON, `PackageListResponse` (`packages/shared/src/index.ts`): `{ packages: Package[]; currency: CurrencyCode }`, packages oldest first; chain currency is available to every staff role. The catalog is small and owner-curated, so it is not paged (capped at `500`).
- Errors: common `requireRole`; `400 INVALID_REQUEST`; `403 FORBIDDEN` (`all=true` by a non-owner); terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `POST /api/admin/packages`

- Source: `apps/api/src/features/packages/router.ts`
- Auth: `requireRole("owner")`; `mustChangePassword` gate applies.
- Body: strict object `{ name: string (trim, 1-80); duration: { unit: "month", value: 1-24 } | { unit: "day", value: 1-366 }; priceMinor: int 0-10_000_000_000 | null }`.
- Success: `201` JSON, the created `Package`.
- Errors: common `requireRole`; `400 INVALID_PACKAGE`; terminal errors.
- Rate limit: none.
- Audit-logged: yes, `package-created` (chain-level; details `{ name, duration, priceMinor }`).

### `PATCH /api/admin/packages/:id`

- Source: `apps/api/src/features/packages/router.ts`
- Auth: `requireRole("owner")`; `mustChangePassword` gate applies.
- Body: strict partial `{ name?; duration?; priceMinor?: int | null; active?: boolean }`, at least one field. Packages are never deleted; `active: false` hides one from new sales. Past sales keep their snapshot.
- Success: `200` JSON, the updated `Package`.
- Errors: common `requireRole`; `400 INVALID_PACKAGE`; `404 PACKAGE_NOT_FOUND`; terminal errors.
- Rate limit: none.
- Audit-logged: yes, `package-updated` (chain-level; details `{ before, after }`, each `{ name, duration, priceMinor, active }`, so a price change records old and new).

### `GET /api/admin/settings`

- Source: `apps/api/src/features/settings/router.ts`
- Auth: `requireRole("owner", "admin")`; `mustChangePassword` gate applies.
- Params/body: none.
- Success: `200` JSON, `ChainSettings` (`packages/shared/src/index.ts`): `{ chainName: string; legal: LegalConfig; freeze: FreezeConfig; currency: "TRY" | "USD" | "EUR" | "GBP" }`. `legal` is the stored value merged over `LEGAL_DEFAULTS`; `freeze` comes from `getFreezeConfig()`; `currency` defaults to `TRY`. Gym-specific settings live under `/api/admin/gyms/:gymId/settings`.
- Errors: common `requireRole`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `PUT /api/admin/settings`

- Source: `apps/api/src/features/settings/router.ts`
- Auth: `requireRole("owner")`; `mustChangePassword` gate applies.
- Body: `{ chainName: string trim min 1; legal?: { dataProcessingUrl: legal document URL | "" | null (empty string and null clear it); privacyUrl: same; version: int coerced min 1 max 1000000 }; freeze?: FreezeConfig; currency?: "TRY" | "USD" | "EUR" | "GBP" }`. Omitted `legal`, `freeze` or `currency` leaves the stored value unchanged; a currency change only affects new sales. `FreezeConfig` is validated by `freezeConfigSchema` (`apps/api/src/features/freeze/freeze.ts`).
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; `400 INVALID_FREEZE_SETTINGS "Invalid subscription freeze settings."` (invalid `freeze`); `400 INVALID_LEGAL_SETTINGS "Invalid legal document settings."` (invalid `legal`); `400 INVALID_CURRENCY` (invalid `currency`); `400 GYM_NAME_REQUIRED "Chain name is required."` (any other validation failure); terminal errors.
- Rate limit: none.
- Audit-logged: yes, `settings-updated` (details: `chainName` plus `legal` / `freeze` / `currency` when sent; chain-level, no `gymId`).

### `GET /api/admin/audit`

- Source: `apps/api/src/features/audit/router.ts`
- Auth: `requireRole("owner", "admin")`; `mustChangePassword` gate applies. An owner sees every row; an admin sees only rows whose `gymId` is in their `gymIds` (chain-level rows are hidden).
- Query: `cursor?: string`; `limit?: int 1-100, default 50`; `action?: string max 64`; `gymId?: string max 64`; `from?: date`; `to?: date` (inclusive range on `at`).
- Success: `200` JSON, `Page<AuditLogEntry>` (`packages/shared/src/index.ts`): `{ items: AuditLogEntry[]; nextCursor: string | null }`, newest first.
- Errors: common `requireRole`; `400 INVALID_REQUEST "Invalid list query parameters."`; `400 INVALID_REQUEST "Invalid pagination cursor."`; `403 GYM_OUT_OF_SCOPE "This gym is outside your scope."` (admin filtering by a gym outside their scope); terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `GET /api/admin/deletion-requests`

- Source: `apps/api/src/features/deletionRequests/router.ts`
- Auth: `requireRole("owner")`; `mustChangePassword` gate applies.
- Query: `cursor?: string`; `limit?: int 1-100, default 50`; `status?: "pending" | "approved" | "rejected"`.
- Success: `200` JSON, `Page<DeletionRequest>` (`packages/shared/src/index.ts`): `{ items: DeletionRequest[]; nextCursor: string | null }`, newest request first.
- Errors: common `requireRole`; `400 INVALID_REQUEST "Invalid list query parameters."`; `400 INVALID_REQUEST "Invalid pagination cursor."`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `POST /api/admin/deletion-requests/:id/approve`

- Source: `apps/api/src/features/deletionRequests/router.ts`
- Auth: `requireRole("owner")`; `mustChangePassword` gate applies.
- Path params: `id: string` Mongo ObjectId for deletion request.
- Behavior: besides the erasure listed in `docs/member-controls.md`, the member's payments are anonymised (`userId`, `note` and `void.reason` become null; amounts, method, gym, date, recorder and package snapshot stay) and the free-text void reason is removed from `payment-voided` audit rows.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; `404 DELETION_REQUEST_NOT_FOUND "Deletion request not found."`; `409 DELETION_REQUEST_RESOLVED "Deletion request has already been resolved."`; `503 DELETION_CLEANUP_FAILED "Profile photo could not be deleted from storage. Please try again."`; terminal errors.
- Rate limit: none.
- Audit-logged: yes, `account-deletion-approved`.

### `POST /api/admin/deletion-requests/:id/reject`

- Source: `apps/api/src/features/deletionRequests/router.ts`
- Auth: `requireRole("owner")`; `mustChangePassword` gate applies.
- Path params: `id: string` Mongo ObjectId for deletion request.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; `404 DELETION_REQUEST_NOT_FOUND "Deletion request not found."`; `409 DELETION_REQUEST_RESOLVED "Deletion request has already been resolved."`; terminal errors.
- Rate limit: none.
- Audit-logged: yes, `account-deletion-rejected`.

## Member Controls Router (`/api/admin/users/:id`)

Source: `apps/api/src/features/members/controlsRouter.ts` (`memberControlsRouter`), mounted at `/api/admin` after `adminRouter` (`docs/member-controls.md`). Except for `GET /users/:id`, the routes are member-only (`400 MEMBER_ONLY "This action applies to member accounts only."` for any other account) and not gym-scoped in the path; a non-owner is scoped through the member's subscription periods (see Auth Model). The target is validated in this order: `400 INVALID_USER "Invalid user."` (malformed id), `404 USER_NOT_FOUND "User not found."`, `400 MEMBER_ONLY`, then `403 GYM_OUT_OF_SCOPE "This member has no subscription at any of your gyms."`. For freeze routes the scope check runs inside the per-user subscription lock instead, so `GYM_OUT_OF_SCOPE` is reported by the freeze service. Audit rows are written once per affected gym (`logMemberAudit`; a single chain-level row when the member has no gym).

### `GET /api/admin/users/:id`

- Source: `apps/api/src/features/members/controlsRouter.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies. Not member-only and not gym-scoped: any user id can be opened (the panel's member drawer is also reached from the Entries page); `presence` in the row is still hidden when outside a non-owner caller's scope.
- Path params: `id: string` Mongo ObjectId.
- Success: `200` JSON, `MemberDetail` (`packages/shared/src/index.ts`): `{ user: UserDirectoryRow; ban: { reason; bannedAt; bannedBy } | null; freeze: MemberFreezeState; pendingDeletion: { id; requestedAt; requestedBy: { id; name } | null } | null }`.
- Errors: common `requireRole`; `400 INVALID_USER "Invalid user."`; `404 USER_NOT_FOUND "User not found."`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `POST /api/admin/users/:id/ban`

- Source: `apps/api/src/features/members/controlsRouter.ts`
- Auth: `requireRole("owner", "admin")`; `mustChangePassword` gate applies.
- Path params: `id: string` Mongo ObjectId of a member.
- Body: strict object `{ reason: string trim 3-500 }` (`BanMemberRequest`). Re-banning an already banned member updates the reason. Entry scans are refused with `BANNED`; exits never are; the session is kept.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; target errors above (`INVALID_USER`, `USER_NOT_FOUND`, `MEMBER_ONLY`, `GYM_OUT_OF_SCOPE`); `400 INVALID_BAN_REASON "Enter a ban reason of 3 to 500 characters."`; terminal errors.
- Rate limit: none.
- Audit-logged: yes, `member-banned` (details `{ reason, previousReason }`, per gym).

### `DELETE /api/admin/users/:id/ban`

- Source: `apps/api/src/features/members/controlsRouter.ts`
- Auth: `requireRole("owner", "admin")`; `mustChangePassword` gate applies.
- Path params: `id: string` Mongo ObjectId of a member.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; target errors above; `409 NOT_BANNED "This member is not banned."`; terminal errors.
- Rate limit: none.
- Audit-logged: yes, `member-unbanned` (details `{ reason }`, per gym).

### `POST /api/admin/users/:id/freeze`

- Source: `apps/api/src/features/members/controlsRouter.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `id: string` Mongo ObjectId of a member.
- Body: none. Freezes the member's running period; the next entry scan, an explicit resume, or the hourly reaper (at `maxDays`) ends it.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; `400 INVALID_USER`, `404 USER_NOT_FOUND`, `400 MEMBER_ONLY`; `403 GYM_OUT_OF_SCOPE "This member has no subscription at any of your gyms."`; `409 FREEZE_DISABLED "Subscription freezing is turned off."`; `409 ALREADY_FROZEN "This membership is already frozen."`; `409 NO_ACTIVE_PERIOD "The member has no subscription period running right now."`; `409 FREEZE_LIMIT_REACHED "The yearly freeze limit has been reached."`; `503 SUBSCRIPTION_BUSY "A subscription operation is in progress. Please try again."`; terminal errors.
- Rate limit: per-user Redis subscription lock.
- Audit-logged: yes, `subscription-frozen` (details `{ freezeId, startedAt, maxDays }`, per gym).

### `DELETE /api/admin/users/:id/freeze`

- Source: `apps/api/src/features/members/controlsRouter.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `id: string` Mongo ObjectId of a member.
- Behavior: ends the open freeze and credits `min(elapsed, maxDays)` to the member's later periods.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; `400 INVALID_USER`, `404 USER_NOT_FOUND`, `400 MEMBER_ONLY`; `403 GYM_OUT_OF_SCOPE`; `409 NOT_FROZEN "This membership is not frozen."`; `503 SUBSCRIPTION_BUSY`; terminal errors.
- Rate limit: per-user Redis subscription lock.
- Audit-logged: yes, `subscription-unfrozen` (details `{ freezeId, startedAt, endedAt, creditedMs, reason: "resumed" }`, per gym).

### `POST /api/admin/users/:id/deletion-request`

- Source: `apps/api/src/features/members/controlsRouter.ts`
- Auth: `requireRole("owner", "admin", "staff")`; `mustChangePassword` gate applies.
- Path params: `id: string` Mongo ObjectId of a member.
- Body: strict object `{ reason?: string trim max 500 }` (`CreateMemberDeletionRequest`). Opens a deletion request on the member's behalf; approval stays owner-only (`POST /api/admin/deletion-requests/:id/approve`).
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; target errors above (`INVALID_USER`, `USER_NOT_FOUND`, `MEMBER_ONLY`, `GYM_OUT_OF_SCOPE`); `400 INVALID_REQUEST "Invalid request."`; `409 DELETION_ALREADY_PENDING "This member already has a pending deletion request."`; terminal errors.
- Rate limit: none.
- Audit-logged: yes, `account-deletion-requested` (details `{ onBehalf: true, reason }`, per gym).

## Me Router (`/api/me`)

`meRouter` (`apps/api/src/features/me/router.ts`) aggregates, in this order: the gate-scan router, then `profileRouter`, `activityRouter`, `bodyRouter`, `freezeRouter` and `deletionRequestRouter`. Unless noted, routes accept every role (`owner | admin | staff | member`) and act on the caller's own account.

### `POST /api/me/gate-scan`

- Source: `apps/api/src/features/gate/router.ts` (checks in `apps/api/src/features/gate/checks.ts`)
- Auth: `requireRole("owner", "admin", "staff", "member")`; `mustChangePassword` gate applies.
- Body: `{ qr: string min 1 max 200; lat?: number; lng?: number; mocked?: boolean }`. The QR resolves to a device and thereby to its gym; the gym is never taken from the client.
- Headers: optional `x-device-fingerprint` must match regex `/^[a-f0-9]{64}$/` to be used; otherwise the session token SHA-256 is the fallback for location-drift detection (`apps/api/src/features/gate/checks.ts`).
- Success: `200` JSON, `GateScanResponse` (`packages/shared/src/index.ts`): `{ ok: true; deviceName: string; direction: "in" | "out"; openMs: number; unfrozen?: true }`, with `openMs` currently `500`. `unfrozen` is present only when this entry scan ended the member's subscription freeze (the freeze is ended only after the turnstile actually opened).
- Errors (checks run in this order; the status is `403` unless noted; the clients map on `code`): `400 INVALID_REQUEST "Invalid request."`; `429 RATE_LIMITED "Too many requests. Please wait a moment."`; `INVALID_QR "Invalid QR code. Scan the code on the gate again."`; `UNKNOWN_DEVICE "This gate is no longer registered. Contact reception."` (also when the device has no resolvable gym); then, for **entry** devices only: `BANNED "Your account is banned. Contact reception."`, `GYM_INACTIVE "This gym is currently closed. Contact reception."`, `SHARING_BLOCKED "Unusual activity was detected on your account. Entry is temporarily blocked. Contact reception."`, `MOCK_LOCATION "Mock location detected. Disable location-spoofing apps and try again."` (an exit with a mocked location is not refused, only recorded as a sharing signal), `NO_ACTIVE_SUBSCRIPTION "You do not have an active subscription. Contact gym reception."` and `NOT_ALLOWED_AT_GYM "Your subscription does not include this gym. Contact gym reception."` (both skipped for the owner and for admin/staff at their own gyms), `LOCATION_REQUIRED "Location information is unavailable. Enable location services and try again."`, `OUT_OF_RANGE "You do not appear to be at the gym. Entry is allowed only on site."`, `GYM_LOCATION_UNSET "Entry is unavailable because the gym location is not configured. Contact reception."` (the geofence is mandatory for everyone, owner and staff included), `ALREADY_INSIDE "You are already inside. Use the exit turnstile before entering again."` (strict anti-passback, only while a reachable exit device exists), `ENTRY_COOLDOWN "You have just entered. Please wait a moment before scanning again."` (60 s per member and gym); for **exit** devices only: `NOT_INSIDE "You are not recorded as having entered the gym. Contact reception."` (no inside record and no auto-exit marker); then for both: `429 RATE_LIMITED "Too many requests. Please wait a moment."` (duplicate-scan lock) and `DEVICE_OFFLINE "The gate is offline. Contact reception."`; common `requireRole`; terminal errors. An exit scan is never refused for location, sharing or subscription reasons.
- Rate limit: per-user `30` gate scans per `60s`; additional per-member open lock TTL `3000ms`.
- Audit-logged: no `logAudit()` call (a freeze ended by the scan writes `subscription-unfrozen`, per gym). Every scan, allowed or refused (throttled ones included), is written to `entry_events` via `enqueueEntryEvent()`; refusals before the QR is resolved carry no device, gym or distance.

### `GET /api/me/profile`

- Source: `apps/api/src/features/me/profileRouter.ts`
- Auth: `requireRole("owner", "admin", "staff", "member")`; exempt from `mustChangePassword` gate.
- Params/body: none.
- Success: `200` JSON, `MyProfile` (`packages/shared/src/index.ts`): `{ id; email; name; role; gymIds; mustChangePassword; twoFactorEnabled; profilePhotoUrl; age; heightCm; weightKg; ban: { reason; bannedAt } | null }`.
- Errors: common `requireRole` except password gate; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `PUT /api/me/profile-photo`

- Source: `apps/api/src/features/me/profileRouter.ts`
- Auth: `requireRole("member")`; `mustChangePassword` gate applies.
- Body: raw binary, any content type accepted by Express raw parser, max `10mb`; processing accepts declared `Content-Type` `image/jpeg`, `image/png`, or `image/webp`; input pixels max `40,000,000`; animated images rejected; output is normalized to 1024x1024 JPEG. Every upload mints a fresh object key and deletes the previous object after the database write.
- Success: `200` JSON, `ProfilePhotoResponse` (`packages/shared/src/index.ts`): `{ profilePhotoUrl: string | null }`.
- Errors: common `requireRole`; `413 PAYLOAD_TOO_LARGE "Photo must be at most 10 MB."`; `400 PROFILE_PHOTO_MISSING "No photo data was provided."`; `400 PROFILE_PHOTO_INVALID` with one of the processing messages from `profilePhoto.ts`; `409 PROFILE_PHOTO_BUSY "Another profile photo operation is in progress."`; `429 PROFILE_PHOTO_RATE_LIMITED "Too many profile photo upload attempts. Please try again later."`; `503 PROFILE_PHOTO_UNAVAILABLE` for R2 config/upload failures; terminal errors.
- Rate limit: `10` uploads per user per `3600s` plus per-user operation lock TTL `30s` (`apps/api/src/features/profilePhoto/profilePhoto.ts`).
- Audit-logged: yes, `profile-photo-updated`.

### `DELETE /api/me/profile-photo`

- Source: `apps/api/src/features/me/profileRouter.ts`
- Auth: `requireRole("member")`; `mustChangePassword` gate applies.
- Params/body: none.
- Success: `200` JSON, `ProfilePhotoResponse`: `{ profilePhotoUrl: null }`.
- Errors: common `requireRole`; `409 PROFILE_PHOTO_BUSY "Another profile photo operation is in progress."`; `503 PROFILE_PHOTO_UNAVAILABLE` for R2 config/delete failures; terminal errors.
- Rate limit: no request-count limiter; per-user operation lock TTL `30s`.
- Audit-logged: yes, `profile-photo-removed`.

### `GET /api/me/subscription`

- Source: `apps/api/src/features/me/activityRouter.ts`
- Auth: `requireRole("owner", "admin", "staff", "member")`; `mustChangePassword` gate applies.
- Params/body: none.
- Success: `200` JSON, `MySubscription` (`packages/shared/src/index.ts`): `{ active: boolean; startsAt: string | null; endsAt: string | null; remainingDays: number; gymIds: string[]; gyms: { id; name; active; startsAt; endsAt; remainingDays }[]; freeze: { startedAt: string } | null; freezeAllowance: { canFreeze; usedInLastYear; maxPerYear; maxDays }; billing: { packageName: string | null; balanceMinor: number; currency; nextPaymentDue: string | null } | null }`. `billing` is null when the member never had a priced period; the balance spans every priced period (past ones included) and never says who recorded a payment. While frozen, the dates and `remainingDays` are previewed as if the freeze ended now.
- Errors: common `requireRole`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `GET /api/me/entries`

- Source: `apps/api/src/features/me/activityRouter.ts`
- Auth: `requireRole("owner", "admin", "staff", "member")`; `mustChangePassword` gate applies.
- Query: `from: string` and `to: string`, both `YYYY-MM-DD` day labels; `from` must not be after `to` and the span may not exceed `92` days.
- Success: `200` JSON, `MyEntriesResponse` (`packages/shared/src/index.ts`): `{ days: { date: "YYYY-MM-DD"; entries: number }[]; timeZone: string }`. Counts only the caller's allowed entry-direction scans, grouped by day in `REPORTS_TIME_ZONE`; days without a visit are omitted.
- Errors: common `requireRole`; `400 INVALID_REQUEST "Invalid date range."`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `GET /api/me/presence`

- Source: `apps/api/src/features/me/activityRouter.ts`
- Auth: `requireRole("owner", "admin", "staff", "member")`; `mustChangePassword` gate applies.
- Params/body: none.
- Success: `200` JSON, `MyPresence` (`packages/shared/src/index.ts`): `{ inside: { gymId; gymName; enteredAt } | null; lastEntry: { gymId; gymName; at } | null }` (`inside` uses the same `autoExitHours` cutoff as occupancy; `lastEntry` is the latest allowed entry scan at any gym).
- Errors: common `requireRole`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `GET /api/me/gyms/:gymId/busy-hours`

- Source: `apps/api/src/features/me/activityRouter.ts`
- Auth: `requireRole("owner", "admin", "staff", "member")`; `mustChangePassword` gate applies. The gym must be one the caller currently has access to through their subscription (the gyms `GET /api/me/subscription` lists, so a frozen member keeps theirs).
- Path params: `gymId: string` gym id.
- Success: `200` JSON, `MyBusyHours` (`packages/shared/src/index.ts`): `{ gymId; timeZone; weekday; sampleDays; hours: { hour: 0-23; avgEntries }[] }` (average allowed entries per hour over the last four same weekdays; an hour with fewer than 3 entries across the sample reports 0). Cached in Redis for 1 hour per gym and day.
- Errors: common `requireRole`; `403 GYM_OUT_OF_SCOPE "This gym is outside your scope."` (unknown, malformed and out-of-subscription ids answer identically); terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `GET /api/me/occupancy`

- Source: `apps/api/src/features/me/activityRouter.ts`
- Auth: `requireRole("owner", "admin", "staff", "member")`; `mustChangePassword` gate applies.
- Params/body: none.
- Success: `200` JSON, `MyOccupancyResponse` (`packages/shared/src/index.ts`): `{ gyms: OccupancyResponse[] }`, each `{ gymId; gymName; inside; capacity: number | null; ratio: number | null }`, for every active gym the caller may enter: the gyms on a member's active subscription, an admin/staff account's own gyms, or every active gym for the owner.
- Errors: common `requireRole`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `GET /api/me/weight-history`

- Source: `apps/api/src/features/me/bodyRouter.ts`
- Auth: `requireRole("owner", "admin", "staff", "member")`; `mustChangePassword` gate applies.
- Params/body: none.
- Success: `200` JSON, `MyWeightHistoryResponse` (`packages/shared/src/index.ts`): `{ entries: { weightKg: number; at: string }[] }`, ascending by time, capped at the latest `500` entries per member.
- Errors: common `requireRole`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `PATCH /api/me/body-metrics`

- Source: `apps/api/src/features/me/bodyRouter.ts`
- Auth: `requireRole("owner", "admin", "staff", "member")`; `mustChangePassword` gate applies.
- Body: `{ age?: int 18-80 | null; heightCm?: number 120-230 | null; weightKg?: number 35-300 | null }`; at least one field is required; an omitted field is unchanged and `null` clears it. A changed weight appends a weight-history entry.
- Success: `200` JSON, `MyBodyMetrics` (`packages/shared/src/index.ts`): `{ age: number | null; heightCm: number | null; weightKg: number | null }`, the complete current state.
- Errors: common `requireRole`; `400 INVALID_REQUEST "Body metrics are missing or out of the accepted range."`; `400 INVALID_REQUEST "At least one body metric field must be provided."`; `429 RATE_LIMITED "Too many body metric updates. Please wait a minute."`; `429 RATE_LIMITED "Another body metrics update is in progress. Please retry."`; `401 AUTH_REQUIRED "Account is no longer active."` (account deleted mid-request); terminal errors.
- Rate limit: `10` updates per user per `60s`, plus a per-user lock (TTL `5s`).
- Audit-logged: yes, `body-metrics-updated` (details: field names only, never values).

### `POST /api/me/freeze`

- Source: `apps/api/src/features/me/freezeRouter.ts`
- Auth: `requireRole("member")`; `mustChangePassword` gate applies.
- Body: none. Self-service freeze of the running period; requires the chain's freeze `enabled` and `memberSelfService` settings.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; `403 BANNED "Your account is banned. Contact reception."`; `409 FREEZE_DISABLED "Subscription freezing is turned off."` (freezing or member self-service is off); `409 ALREADY_FROZEN "This membership is already frozen."`; `409 NO_ACTIVE_PERIOD "You have no subscription period running right now."`; `409 FREEZE_LIMIT_REACHED "The yearly freeze limit has been reached."`; `503 SUBSCRIPTION_BUSY "A subscription operation is in progress. Please try again."`; terminal errors.
- Rate limit: per-user Redis subscription lock.
- Audit-logged: yes, `subscription-frozen` (details include `selfService: true`, per gym).

### `DELETE /api/me/freeze`

- Source: `apps/api/src/features/me/freezeRouter.ts`
- Auth: `requireRole("member")`; `mustChangePassword` gate applies.
- Body: none. Resume is always allowed, even when freezing was switched off or the member is banned.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; `409 NOT_FROZEN "This membership is not frozen."`; `503 SUBSCRIPTION_BUSY`; terminal errors.
- Rate limit: per-user Redis subscription lock.
- Audit-logged: yes, `subscription-unfrozen` (details include `selfService: true`, per gym).

### `GET /api/me/deletion-request`

- Source: `apps/api/src/features/me/deletionRequestRouter.ts`
- Auth: `requireRole("owner", "admin", "staff", "member")`; `mustChangePassword` gate applies.
- Params/body: none.
- Success: `200` JSON, `MyDeletionRequest` (`packages/shared/src/index.ts`): `{ status: "none" | "pending" | "rejected"; requestedAt: string | null }`.
- Errors: common `requireRole`; terminal errors.
- Rate limit: none.
- Audit-logged: no.

### `POST /api/me/deletion-request`

- Source: `apps/api/src/features/me/deletionRequestRouter.ts`
- Auth: `requireRole("owner", "admin", "staff", "member")`; handler additionally requires `req.user.role === "member"`; `mustChangePassword` gate applies.
- Params/body: none.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; `403 DELETION_MEMBER_ONLY "Only member accounts can create a deletion request."`; `409 DELETION_ALREADY_PENDING "You already have a pending deletion request."`; terminal errors.
- Rate limit: none.
- Audit-logged: yes, `account-deletion-requested`.

### `DELETE /api/me/deletion-request`

- Source: `apps/api/src/features/me/deletionRequestRouter.ts`
- Auth: `requireRole("owner", "admin", "staff", "member")`; `mustChangePassword` gate applies.
- Params/body: none.
- Success: `200` JSON `{ ok: true }`.
- Errors: common `requireRole`; `404 DELETION_NOT_PENDING "No pending deletion request was found."`; terminal errors.
- Rate limit: none.
- Audit-logged: yes, `account-deletion-cancelled`.

## Legal Documents (`/api/legal`)

### `GET /api/legal`

- Source: route in `apps/api/src/index.ts`, config resolver in `apps/api/src/features/settings/legal.ts`.
- Auth: public (no session required) — the mobile signup screen renders consent links before a session exists.
- Params/body: none.
- Success: `200` JSON, `LegalConfig`: `{ dataProcessingUrl: string | null; privacyUrl: string | null; version: number }`. URLs come from `settings.legal`; both default to `null` and `version` defaults to `1` when the admin has not configured them. No personal data is returned.
- Errors: terminal `500 INTERNAL_ERROR` only for unexpected failures.
- Rate limit: none.
- Audit-logged: no.

## Health

### `GET /health`

- Source: `apps/api/src/index.ts`
- Auth: public.
- Params/body: none.
- Success: `200` JSON, `HealthResponse` (`packages/shared/src/index.ts`): `{ status: "ok"; service: string; timestamp: string }`. Liveness only: it does not probe dependencies.
- Errors: terminal `500 INTERNAL_ERROR` only for unexpected failures.
- Rate limit: none.
- Audit-logged: no.

### `GET /health/ready`

- Source: `apps/api/src/index.ts`
- Auth: public.
- Params/body: none.
- Success: `200` JSON, `ReadinessResponse` (`packages/shared/src/index.ts`): `{ status: "ok"; service: string; timestamp: string; checks: { mongo; redis; entryEventConsumer } }`, each check `{ status: "up" | "down"; error?: string }`. Mongo and Redis are pinged with a 2 s timeout; `entryEventConsumer` reports whether the turnstile event consumer is running.
- Errors: `503` with the same body shape and `status: "degraded"` when any check is `down`.
- Rate limit: none.
- Audit-logged: no.

## Device Gateway (`/api/device-gateway`)

### `WebSocket /api/device-gateway`

- Source: `apps/api/src/features/devices/gateway.ts`, attached at `apps/api/src/index.ts`.
- Auth: device-gateway auth. Client must send first JSON text frame within `5000ms`: `{ type: "auth"; deviceId: string; token: string }` (`packages/shared/src/index.ts`). `deviceId` must be a valid Mongo ObjectId; token SHA-256 must timing-safe-equal stored `tokenHash`.
- Success server message: `DeviceServerMessage` `{"type":"auth_ok","deviceName":string}` (`packages/shared/src/index.ts`).
- Error server message: `{"type":"auth_error","message":"Device authentication failed."}` then socket close.
- Other server messages after auth: `{"type":"open","openMs":number,"side":"in"|"out"}` when `/api/me/gate-scan` opens the device. `side` is the resolved scan direction; single-direction agents may ignore it.
- Request body/query: none; WebSocket max payload `4096` bytes.
- Rate limit: none; unauthenticated sockets are closed after auth timeout.
- Audit-logged: no.
