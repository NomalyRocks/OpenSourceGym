# Member controls: ban, freeze, deletion on behalf

Staff-side controls over a member account. Types live in `packages/shared`
(`MemberBan`, `FreezeConfig`, `MemberFreezeState`, `MemberDetail`,
`CreateMemberDeletionRequest`); this page is the behavioural contract.

All three apply to **member** accounts only (`MEMBER_ONLY` otherwise).

## Gym scope and audit

Members are chain-wide, so the routes carry no gym. Instead, for ban/unban,
freeze/unfreeze and deletion on behalf, a **non-owner** caller needs
`canAccessGym` for at least one gym on ANY of the member's subscription periods
(past ones included, so an expired member can still be handled by their home
gym); otherwise `403 GYM_OUT_OF_SCOPE`. A member with no periods at all can be
handled by the owner only. The freeze routes run this check under the per-user
subscription lock; the others use a plain read. `GET /api/admin/users/:id`
stays open to every staff role (the Entries drawer needs it), and the
member's own `/api/me/*` routes are not scoped.

Every mutation writes **one audit row per distinct gym** on the member's current
and future periods (or on their latest period when none is current or upcoming),
with that gym as `gymId`, so each gym's admin sees it in their audit list. An
admin or staff actor also gets a row for each of their own gyms on ANY of the
member's periods, since the scope rule above lets them act through a past
period's gym. Same action and details on each row. A member with no periods
gets a single row with `gymId: null` (owner-visible only). Subscription
create/cancel/gym-change rows follow the same per-gym rule (`logAuditPerGym`).
Deleting the member strips the free-text
`reason`/`previousReason` from all of these rows.

## Member detail

`GET /api/admin/users/:id` (owner/admin/staff) returns `MemberDetail`: the
directory row, ban, freeze state and any pending deletion request. The panel's
member drawer loads it, including when opened from the Entries page.

## Ban

- `POST /api/admin/users/:id/ban` `{ reason }` (owner/admin) — stores
  `ban: { reason, bannedAt, bannedBy }` on the user document. Re-banning updates
  the reason. Reason: trimmed, 3-500 chars (`INVALID_BAN_REASON`).
  Audit: `member-banned`.
- `DELETE /api/admin/users/:id/ban` (owner/admin) — clears it (`NOT_BANNED` when
  there is none). Audit: `member-unbanned`.
- Gate: an **entry** scan by a banned member is refused with `BANNED` and logged
  in `entry_events` like every other refusal. Exit scans are never refused.
- Sessions are kept on purpose: the mobile app reads `MyProfile.ban` and
  replaces its tabs with a ban screen (red X, "banned", the reason) that only
  offers sign-out. Other `/api/me/*` routes keep working so the member can still
  file a data deletion request.
- Role change: promoting a banned member to admin/staff/owner is refused with
  `409 MEMBER_BANNED`, and promoting a member with an open freeze with
  `409 MEMBER_FROZEN`. The unban and resume routes accept members only, so the
  promoted account could not be fixed afterwards. Best-effort: a ban or freeze
  written at the same moment as the promotion is not caught.

## Freeze

Chain setting `ChainSettings.freeze` (owner, `PUT /api/admin/settings`):
`enabled` (default true), `memberSelfService` (default true), `maxPerYear`
0-12 (default 4), `maxDays` 1-180 (default 30). Invalid values → `INVALID_FREEZE_SETTINGS`.

Storage: `subscription_freezes`
`{ userId, startedAt, startedBy, maxDays, endedAt: Date|null, endedBy: string|null,
endReason: "resumed"|"gate-scan"|"max-days"|null, creditedMs: number|null,
plan, creditApplied }`.
At most one open freeze per member (unique partial index on `userId` where
`endedAt: null`); `{ userId, startedAt }` index for the yearly count.

- `POST /api/admin/users/:id/freeze` (owner/admin/staff) — refuses with
  `FREEZE_DISABLED`, `ALREADY_FROZEN`, `NO_ACTIVE_PERIOD` (no period with
  `startsAt <= now < endsAt`), or `FREEZE_LIMIT_REACHED` (freezes with
  `startedAt` in the last 365 days ≥ `maxPerYear`). Snapshots `maxDays` onto
  the freeze. Audit: `subscription-frozen`.
- `DELETE /api/admin/users/:id/freeze` (owner/admin/staff) — resumes
  (`NOT_FROZEN` when none). Audit: `subscription-unfrozen`.
- Ending a freeze credits `min(now - startedAt, maxDays)` ms back. Periods with
  `endsAt > startedAt` are repacked in start order: the one running at
  `startedAt` keeps its start and gets `endsAt += credit`; each later period
  keeps its duration and starts at the later of its own start and the previous
  period's new end (so a renewal bought during the freeze does not leave a gap).
  Done under the per-user subscription lock (`og:lock:subscription:<userId>`).
  The freeze is closed first with the plan stored on it, then the plan is
  written with per-period `freezeCredits` markers, so a retry can never credit
  twice. A failed apply never reopens the freeze (`creditApplied: false`); the
  next end/start for the member, the member's next entry scan (before the
  subscription check) and the hourly reaper finish it.
- **Soft unfreeze at the gate:** an entry scan by a frozen member is decided
  against a dry run of the credit (no writes), so it passes the subscription
  check exactly as if the freeze had ended. The freeze really ends
  (`endReason: "gate-scan"`, `GateScanResponse.unfrozen` is `true`) only after
  every refusal has passed and the turnstile opened. A refused scan (ban,
  geofence, wrong gym, anti-passback, offline gate, ...) never unfreezes. If
  ending fails after the gate opened, or the member's lock stays busy for more
  than 1 s, the member still gets in; it is logged and the next entry scan
  ends the freeze. Exit scans never touch the freeze.
- An hourly reaper ends freezes open longer than their `maxDays`
  (`endReason: "max-days"`, credit = exactly `maxDays`). Audit:
  `subscription-unfrozen` with actor `system` and `reason: "max-days"`.
- `MySubscription.freeze` is `{ startedAt }` while frozen, so the mobile home
  screen can say the membership is frozen and that scanning in resumes it.
  While frozen, `active`, `endsAt`, `remainingDays` and `gyms` describe the
  timeline as if the freeze ended now, so days left stay put until the
  `maxDays` cap and a nominal end that passed during the freeze does not read
  as "no membership".

### Member self-service

`FreezeConfig.memberSelfService` (default true) lets members freeze from the
app. `POST /api/me/freeze` and `DELETE /api/me/freeze` (member role only) run
the same checks and the same lock/credit logic as the admin routes, plus:
`FREEZE_DISABLED` when `enabled` or `memberSelfService` is false (resume is
always allowed, so a member is never stuck frozen), and `BANNED` for a banned
member. `startedBy`/`endedBy` is the member's own id. Audit actions are the
same (`subscription-frozen` / `subscription-unfrozen`) with the member as actor.
`MySubscription.freezeAllowance` tells the app whether the button is usable
and how many freezes are left.

## Deletion on behalf

`POST /api/admin/users/:id/deletion-request` `{ reason? }` (owner/admin/staff)
creates a `deletion_requests` row with `requestedBy: { id, name }` and
`reason`. Member-created rows have `requestedBy: null`. Same
`DELETION_ALREADY_PENDING` rule as the member route. Approval stays
owner-only on the existing Data Requests page, which now shows who asked and
why. Audit: `account-deletion-requested`.
