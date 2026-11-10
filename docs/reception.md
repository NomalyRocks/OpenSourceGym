# Reception gate open

Reception can open a turnstile when a person's phone, internet connection or GPS
is unavailable. The panel's member drawer shows **Open turnstile** for owners,
admins and staff in the currently selected gym. The confirmation dialog shows the
person's photo and name, a device selector, the passage direction and a required
reason. Offline devices are disabled. Bidirectional devices require a direction
selection; single-direction devices show their fixed direction.

## Routes and authorization

- `GET /api/admin/gyms/:gymId/gate-devices` returns `GateDeviceSummary[]` with
  `id`, `name`, `direction` (`in`, `out` or `both`) and `online`. The query and
  response omit QR contents, device tokens and token hashes.
- `POST /api/admin/gyms/:gymId/gate-open` accepts
  `{ userId, deviceId, direction: "in" | "out", reason }`. Both IDs must be valid
  ObjectIds (any letter casing is accepted and immediately normalized to lowercase) and the trimmed reason must contain 3–200 characters. The device
  must belong to the gym (`404 DEVICE_NOT_FOUND` otherwise), and must support the
  direction (`400 INVALID_DIRECTION` otherwise). An unknown target returns
  `404 USER_NOT_FOUND`.

Both routes use `requireGymAccess("owner", "admin", "staff")`, including the
per-request database re-read. Owners can act at every gym; admins and staff can
act only at their assigned gyms. Members cannot call either route. The regular
`devices` routes remain owner/admin-only because their QR contents are gate
credentials.

The target can have any role, so reception can also pass a colleague. The
passing person's role and gym scope determine the subscription exemption;
the reception actor's privileges do not grant the target an exemption.

## Passage controls

QR and reception share the passage pipeline in `features/gate/pass.ts`.
Reception skips QR verification, geofencing (including `GYM_LOCATION_UNSET`),
mock-location detection and phone-location history. It retains these controls:

- Entry refuses bans, inactive gyms and sharing blocks.
- Entry requires an active subscription that includes the gym unless the
  passing person is the owner, or an admin/staff member assigned to that gym.
- Frozen membership credit is settled and evaluated with a dry run. A refused
  attempt leaves the freeze open; only a successful entry ends it.
- Entry retains strict anti-passback when a reachable exit device exists and
  the per-person, per-gym entry cooldown in every topology.
- Exit retains the inside-record or cross-gym auto-exit-marker check, without
  checking bans, gym activity, subscriptions, sharing blocks or location.
- The shared per-person passage lease prevents simultaneous openings. Offline
  failures release the lease and entry cooldown so a retry can succeed.

Successful openings send the same relay command and return `GateScanResponse`.
Refusals retain the QR codes and HTTP statuses, including `429 RATE_LIMITED`.
Occupancy, cross-gym auto-exits and impossible-travel sharing signals follow the
same path for both sources. Occupancy or freeze-credit failures after opening
do not report a refusal for a turnstile that already opened.

## Rate limit and records

Every authorized, gym-scoped reception request, including malformed requests and
refusals, counts toward **30 requests per actor per 10 minutes**. The counter is
`og:gate-open:<actorId>`, with atomic increment and a fixed expiry; the 31st
request returns `429 RATE_LIMITED` and is recorded. An atomic Redis helper keeps
this counter separate from existing QR passage leases at the same legacy key,
moving a live lease to `og:lock:gate-open:<userId>` when necessary. Reception and
QR continue to share one effective passage lease per person.

Each scoped reception attempt synchronously writes an `entry_events` row with
`source: "reception"`, `actorId`, `actorName`, the trimmed free-text `staffReason`,
and a rejection `reason` (`GateRejectCode | null`, null on success). The request
body still names the staff explanation `reason`; it is mapped to `staffReason`
when recorded. Validation errors that are not gate rejection codes leave the
event's `reason` null. No separate `code` field is stored on entry events.
Each attempt also calls `logAudit` with the gym, target and
`{ deviceId, direction, staffReason, code }`, using `gate-opened-by-staff` or
`gate-open-refused`. Audit `details.code` contains the rejection or validation
code, or null on success. Invalid requests retain only validated input fields.
Authentication and gym-scope failures stop in the standard authorization
middleware before a passage attempt is accepted.

QR events carry `source: "qr"` and null actor fields and `staffReason`.
The rejection `reason` retains its original meaning on every event, including
reception and legacy QR rows without `source`. The entry-event list returns
`staffReason: null` for rows without that field. The optional
`source=qr|reception` filter treats missing source as QR. The panel shows source
and actor, with `staffReason` in the source cell's tooltip and the rejection
label read from `reason`. The entries CSV includes separate `reason` (rejection
code), `source`, `actor` and `staffReason` columns.

## KVKK erasure

Reception and deletion approval share `og:lock:gate-lifecycle:<userId>` through
`withGateUserLifecycleLock`. It has a one-second acquisition wait and a renewable
ten-second lease; it is released as soon as the operation finishes. Both paths
acquire it before any subscription lock. This separate outer lock avoids
reacquiring the subscription lock during the gate's freeze settlement or unfreeze.
Reception re-reads the target while holding the lifecycle lock and awaits both
the entry-event insert and final audit before releasing it. Deletion keeps the
same lock through its erasure and audit sweeps. A missing or anonymised target
returns `404 USER_NOT_FOUND`; a lock timeout returns `503 SUBSCRIPTION_BUSY`.
Those refusals omit target identity and staff text from their logs. Other
refusals, including rate limits and malformed requests carrying a valid target
ID, follow the same lifecycle serialization. QR event queueing is unchanged.

Deletion-request approval nulls reception entry-event `staffReason` before
removing the member identity from retained event rows. It also unsets
`details.staffReason` on that member's `gate-opened-by-staff` and
`gate-open-refused` audit rows. Rejection codes in event `reason` and audit
`details.code` remain. Statistical history, outcomes, actors and timestamps stay
reviewable without retaining free-text explanations about the deleted member.

## Member invites — not implemented yet

## Member invites

Staff can use **Invite member** on the Users page for the selected gym when a
member has not registered in the app. No account exists until the member opens
the emailed link, reads the operator's legal documents, personally accepts both
the data processing notice and privacy policy, and sets a password. Staff cannot
provide consent on the member's behalf. Acceptance does not grant a subscription.

Gym-scoped routes under `/api/admin/gyms/:gymId/invites` require
`requireGymAccess("owner", "admin", "staff")`:

- `POST /` creates an invite with email, first name, last name and required
  phone, normalized with the same rules as signup. Existing accounts and pending
  invitations conflict. Each actor may make 20 creation requests per hour.
- `GET /` lists unexpired pending invitations belonging to that gym.
- `POST /:id/resend` rotates the token and renews the seven-day lifetime. The
  previous link immediately stops working. At most five resends are allowed,
  with at least 60 seconds between sends (including the original send).
- `DELETE /:id` cancels and deletes the invite. The panel asks for confirmation.
  Invites belonging to another gym return 404.

Links use `${PUBLIC_WEB_URL}/invite#token=...`. The fragment keeps the bearer token
out of URL request logs and Referer headers; the page removes it from the address
bar after reading it. `PUBLIC_WEB_URL` defaults to `http://localhost:5173` in
non-production environments and is mandatory in production. Requests carry tokens
in JSON bodies; do not enable request-body logging on these endpoints.

The public `POST /api/invites/lookup` and `POST /api/invites/accept` endpoints
share a limit of 20 requests per IP per ten minutes. Unknown and expired tokens
return the identical `INVITE_INVALID` response. Acceptance checks `legalVersion`
against the current settings; `LEGAL_VERSION_CHANGED` requires reloading the
published documents and obtaining both consents again. As with ordinary
registration, unset document URLs leave consent labels without links; operators
publish their documents in chain settings.

Acceptance atomically claims the pending invite in MongoDB, calls
BetterAuth's signup API (including its consent and phone hooks), then marks the
new user's email verified through BetterAuth's internal adapter. The email link
proves mailbox possession, so this server-only path suppresses the signup OTP
hook. Normal registration still sends OTP. No session is issued: the member
signs in with the OpenGym mobile app. Both consent timestamps and
`legalVersionAccepted` are stamped for invite and normal signup alike. The invite
is deleted only after account creation and verification succeed; failures leave
it pending. Reused or concurrent duplicate acceptance cannot create another
account.
Cancellation and resend return `409 INVITE_ACCEPTING` while the claim is fresh;
claims older than two minutes may be reclaimed, and failed acceptance clears only
its own claim.

For KVKK data minimization, `member_invites` stores only the normalized contact
information, gym, creator, timestamps, resend count and SHA-256 token hash before
consent. The raw token is never stored. The TTL index on `expiresAt` automatically
deletes unaccepted invites after seven days (physical deletion follows MongoDB's
TTL monitor schedule); API expiry checks reject them immediately at expiry.
Accepted and cancelled invites are deleted immediately. Invite audit rows retain
only IDs and gym scope, never the invite's email, name or phone, so unconsented
contact details do not survive in the audit log. Email delivery and development
console mail output follow the existing mailer behavior.
