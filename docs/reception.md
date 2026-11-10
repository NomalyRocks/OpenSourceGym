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
  ObjectIds and the trimmed reason must contain 3–200 characters. The device
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

Deletion-request approval nulls reception entry-event `staffReason` before
removing the member identity from retained event rows. It also unsets
`details.staffReason` on that member's `gate-opened-by-staff` and
`gate-open-refused` audit rows. Rejection codes in event `reason` and audit
`details.code` remain. Statistical history, outcomes, actors and timestamps stay
reviewable without retaining free-text explanations about the deleted member.

## Member invites — not implemented yet
