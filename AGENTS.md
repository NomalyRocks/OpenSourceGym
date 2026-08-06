# OpenGym

Self-hosted, single-tenant gym automation: member self-registration, subscription tracking, QR turnstile entry (static QR on turnstile, mobile-scanned), staff/role management. Product docs are Turkish: `PRD.md` (requirements and non-goals) and `ROADMAP.md` (phase checklists). Current state: Faz 0–5 (MVP + v1.1: infra, auth, admin panel, mobile app, QR turnstile, MFA, occupancy) complete; Faz 6 (account sharing detection, anti-debugging) complete.

**Non-goals** (from PRD): online payments, multi-tenant/multi-branch, class booking/training/diet features. PRD "Ek A" (experimental path-obfuscation/custom cipher layer) is archived — never implement it.

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
```

- API needs Mongo and Redis running. In development, Docker provides only Mongo and Redis; the API always runs on the host. Env: copy `.env.example` to `.env`; with SMTP unset, OTP emails print to the api console. Production uses a separate `.env.production.example` (see `docker-compose.prod.yml`) — never merge the two profiles into one file, because both `docker compose` and Node's `--env-file` take the last value of a duplicated key.
- `@opengym/shared` is consumed from its compiled `dist/`. Turbo's `^build` handles ordering, but after editing shared types run `pnpm --filter @opengym/shared build` so app typechecks see the change.
- API tests use Node's built-in test runner through `tsx`. CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → build on Node 22.

## Architecture

### Auth (BetterAuth — `apps/api/src/auth.ts`)

- Email+password with required email verification via 6-digit OTP (`emailOTP` plugin); `expo()` plugin for the mobile deep-link scheme `opengym://`.
- Mongo adapter + Redis secondary storage (sessions) + Redis-backed rate limiting with per-route rules (signup, signin, OTP send/verify).
- Custom user fields: `firstName`, `lastName`, normalized public `phone`, internal/non-returned `phoneE164`, `role` (`admin|staff|member`, `input: false`), `mustChangePassword`, data processing and privacy consent flags (`dataProcessingAccepted`, `privacyAccepted` + timestamps). The `user.create.before` hook rejects signup without both consents, normalizes/uniquifies phones, and stamps consent timestamps.
- The BetterAuth catch-all is mounted **before** `express.json()` in `apps/api/src/index.ts` — moving it after breaks auth request bodies.
- First boot seeds `admin@opengym.local` with `mustChangePassword: true` (`apps/api/src/seed.ts`). The password comes from `resolveInitialAdminPassword()` (`apps/api/src/initialAdmin.ts`): `admin1234` in development, and in production the operator-supplied `INITIAL_ADMIN_PASSWORD` — there is no production default, so an unset value fails startup, and the value is never logged.

### Authorization (`apps/api/src/middleware.ts`)

`requireRole(...roles)` validates the session, then **re-reads the user from Mongo on every request** so role changes and `mustChangePassword` are never stale behind the Redis session cache. Users with `mustChangePassword` are blocked from everything except `POST /api/admin/initial-password` and `GET /api/me/profile`. New protected routes must use this middleware and preserve the re-read pattern.

### Data (native MongoDB driver — no ORM or schema-migration framework)

`apps/api/src/db.ts` exposes the `db` handle. Collections:

One-time startup data repairs are idempotent and marker-controlled; they are
not schema migrations.

- `user` — BetterAuth-managed, extended with the custom fields above
- `subscriptions` — membership periods `{ userId, startsAt, endsAt, note, createdBy, createdAt }`
- `phone_identity_conflicts` — unresolved legacy duplicate phones; resolved records are deleted
- `migration_markers` — idempotent one-time data repair markers
- `entry_events` — turnstile scan log; carries `distanceM`, the metres between the scanning phone and the gym, so a disputed scan can be reviewed later (null on older records and when either position was unknown)
- `settings` — singleton gym config doc, `_id: "gym"`. Contains `legal: { dataProcessingUrl: string | null, privacyUrl: string | null, version: number }` — the product ships no legal text, only the operator's document URLs and version; managed via `GET/PUT /api/admin/settings` and read publicly through `GET /api/legal` (see `docs/legal/README.md`).
- `audit_logs` — written via `logAudit()` (`apps/api/src/audit.ts`); **every sensitive admin mutation must call it**

### API surface

- `/api/auth/*` — BetterAuth
- `/api/admin/*` (`apps/api/src/routes/admin.ts`) — staff/admin: unified user search (`q`: phone/e-mail/name), role assignment, sequential subscriptions, settings, audit list
- `/api/me/*` (`apps/api/src/routes/me.ts`) — own profile, subscription, and `POST /gate-scan`. The geofence there is **mandatory**: an unconfigured `settings.location` rejects the scan with `GYM_LOCATION_UNSET` rather than skipping the check, because the printed turnstile QR is public and location is the only thing tying a scan to the building. Entry scans also run anti-passback — strict when an exit device is registered, otherwise a per-member cooldown.
- `GET /api/legal` — public legal document URLs (data processing and privacy)
- `GET /health`

Request bodies are validated with zod. No OpenAPI/codegen: clients use hand-rolled `api<T>()` fetch wrappers and share response types via `@opengym/shared`.

### Clients

- **web**: cookie session (`credentials: "include"`), Vite dev proxy `/api → localhost:3000`. `src/App.tsx` gates by role (members are told to use the mobile app) and forces the ChangePassword screen when `mustChangePassword` is set.
- **mobile**: better-auth expo client with SecureStore; its `api()` wrapper sends `Cookie: authClient.getCookie()` manually. Manual screen state machine in `App.tsx` (`login | register | verify | home`), no navigation library.

## Conventions & gotchas

- `api` and `shared` are ESM (`"type": "module"`) — relative imports need `.js` extensions. `web` uses bundler resolution (no extensions). `mobile` is not ESM.
- **Everything written in code is English**: identifiers, comments, JSDoc, log and thrown-error text, test titles, i18n keys, and infra docs. Product docs (`PRD.md`, `ROADMAP.md`) stay Turkish.
- Turkish user-facing copy lives in exactly one place per client: the `tr` map in `apps/web/src/i18n/resources.ts` and `apps/mobile/src/i18n/resources.ts`. Translation keys are the English source strings; `t("Overview")` renders "Genel Bakış" under `tr` and falls back to the key itself under `en`. Never hardcode a Turkish literal in a component — add a key to the `tr` map instead.
- The API has no i18n layer, so the little user-facing copy it owns stays Turkish and is deliberately excluded from the English rule: OTP/security e-mail subjects and bodies in `apps/api/src/auth.ts`, renewal reminder e-mails in `apps/api/src/renewals.ts`, and the seeded admin display name in `apps/api/src/seed.ts`. The same carve-out covers the default turnstile display names in `agents/sim/fleet.mjs`, which show up in the admin panel. Everything else in `apps/api` — including `sendApiError` messages, which clients never display because they map on the `code` — is English.
- TS strict + `noUncheckedIndexedAccess` via `tsconfig.base.json`. `mobile` does not extend the base (it extends `expo/tsconfig.base`) and pins its own newer TypeScript.
- Dev infra host ports are non-default to avoid collisions: Mongo `127.0.0.1:27018`, Redis `127.0.0.1:6380` (inside compose network the defaults 27017/6379 apply).
- Expo work: consult the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ — see `apps/mobile/AGENTS.md`.
- After completing a roadmap item, tick its checkbox in `ROADMAP.md`.
