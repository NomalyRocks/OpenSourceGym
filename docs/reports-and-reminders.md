# Reports, Renewal Reminders, and CSV Export

This document is for the gym owner and the person operating the OpenGym server
to use reports, renewal reminders, and data exports safely.

## Report endpoints

The report endpoints are available to both the `admin` and `staff` roles:

- `GET /api/admin/reports/summary`
- `GET /api/admin/reports/entry-trend`

Both endpoints accept optional `from` and `to` query parameters. Send dates in
ISO 8601 format; for example,
`?from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.999Z`. The boundaries
are inclusive. If `to` is omitted, the request time is used; if `from` is
omitted, 30 days before `to` is used. `from` cannot be after `to`, and the range
cannot exceed 366 days; otherwise, the API returns `400 INVALID_REPORT_RANGE`.

### Summary report

`GET /api/admin/reports/summary` returns the following fields:

| Field                    | Meaning                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `range.from`, `range.to` | ISO timestamps for the range applied by the API.                                                                                                                                                                                                                                                              |
| `timeZone`               | IANA time zone used for daily report buckets.                                                                                                                                                                                                                                                                 |
| `activeMembers`          | Number of unique members with an active subscription at the time of the request, frozen members excluded; independent of the selected range.                                                                                                                                                                  |
| `frozenMembers`          | Number of unique members with an open membership freeze, counted at the gyms of their active periods (or of their latest started period when the nominal end passed during the freeze); independent of the selected range.                                                                                    |
| `newMembers`             | Number of users created within the range whose role is `member`.                                                                                                                                                                                                                                              |
| `newSubscriptions`       | Number of subscription records created within the range.                                                                                                                                                                                                                                                      |
| `lapsedMembers`          | Number of unique members whose latest subscription ended within the range and who did not renew with a later subscription. A member with a subscription that ends later is not included even if an older package ended within the range. A member with an open freeze is paused, not lapsed, and is excluded. |
| `renewalsDue`            | Number of unique members whose latest subscription will end within the next 7 days from the request time, frozen members excluded; independent of the selected range.                                                                                                                                         |
| `entries.total`          | All entry attempts within the range.                                                                                                                                                                                                                                                                          |
| `entries.allowed`        | Allowed entries within the range.                                                                                                                                                                                                                                                                             |
| `entries.denied`         | Denied entries within the range.                                                                                                                                                                                                                                                                              |
| `entries.uniqueMembers`  | Number of unique members associated with at least one entry event within the range.                                                                                                                                                                                                                           |

### Daily entry trend

The `range` and `timeZone` fields in the
`GET /api/admin/reports/entry-trend` response have the meanings above. `points`
contains one record for each local day in the range; days with no entries are
also returned with zeros.

| `points[]` field | Meaning                                             |
| ---------------- | --------------------------------------------------- |
| `date`           | Day in the gym's time zone, in `YYYY-MM-DD` format. |
| `total`          | All entry attempts on that day.                     |
| `allowed`        | Allowed entries on that day.                        |
| `denied`         | Denied entries on that day.                         |

## Lost members

All routes in this section are scoped to `/api/admin/gyms/:gymId/reports`.
Owners can access every gym; admins and staff can access only their assigned gyms.
The panel's **Lost members** page has **Not visiting** and **Not renewed** tabs,
and each member row opens the shared member drawer.

- `GET /inactive-members?days=14&page=1&limit=50`: members with a period covering
  now at this gym who last visited more than `days` days ago or never visited.
  Open freezes and expired memberships are excluded. A visit is an allowed
  `direction: "in"` event at this gym with a non-null user id; refused scans,
  exits, anonymised events, and visits at another gym do not count. `days` is an
  integer from 1 to 365, default 14; invalid values return `400 INVALID_REQUEST`.
  Never-visited members sort first, then oldest last visits. Rows include
  `userId`, `name`, `email`, `phone`, `lastEntryAt`, `daysSinceLastEntry`, and
  `periodEndsAt` (the latest end among currently active periods). The two visit
  fields are null for members who never visited.
- `GET /lapsed-members?page=1&limit=50`: uses exactly the summary's
  `lapsedMembers` definition. The member's maximum period end **at this gym**
  must fall in the inclusive `from`/`to` range, with no later period at this gym;
  open freezes are excluded. Optional `from` and `to` have the summary's defaults
  (last 30 days through now) and 366-day range bound. Renewals at other gyms do
  not affect this gym's result. Rows include `userId`, `name`, `email`, `phone`,
  `endedAt`, and `lastEntryAt`; most recently ended first. The full `total`
  equals summary `lapsedMembers` for the same gym, range, and database state.

Both lists return `{ items, nextCursor, total }`, reusing the report cursor
contract. Use `cursor` to continue or `page` (1-based) to select a numbered page;
these parameters cannot be combined. `limit` defaults to 50 and accepts 1–100.
Time ties use the user id for stable pagination. The panel uses cursor paging
and fixes its 30-day lapsed range while paging.

Owner/admin only: `GET /export?dataset=inactive&days=14` and
`GET /export?dataset=lapsed&from=...&to=...` download the complete matching
lists, including a `gymId` column. Inactive export is a current snapshot;
`days` selects its threshold. Lapsed export uses the summary range. Both reuse
the existing `data-exported` audit action with `gymId`, `dataset`, the applied
range, and (for inactive) `days`. Staff can view the lists but cannot export.

## REPORTS_TIME_ZONE

`REPORTS_TIME_ZONE` determines the day boundaries in the daily entry trend. As
a result, an entry near midnight is grouped by the gym's local calendar day
rather than by the UTC day. The default is `Europe/Istanbul`.

The value must be a valid IANA time zone, such as `Europe/Istanbul`. An invalid
value is a configuration error, and the API exits during startup. Restart the
API process after changing the variable.

## Renewal reminders

Members with an open freeze are skipped everywhere: they are not listed as renewals due, the hourly sweep sends them no reminder, and a manual `POST /renewals/:userId/remind` answers `404 NO_UPCOMING_RENEWAL`. Their period is paused, so its nominal end date is not a real deadline. Once the freeze ends and the periods are shifted, they are handled normally again.

`reminders.enabled` in the gym settings defaults to `false`. This safe default
prevents a new installation or an existing installation being upgraded from
sending bulk email to members without explicit administrator approval.

Before enabling reminders, `SMTP_HOST` must be configured for actual email
delivery. In production, delivery fails if this variable is missing. In
development, the email is not delivered and is written to the API console.

`reminders.daysBefore` determines how many days before a subscription ends an
automatic reminder is sent. The default thresholds are `[7, 1]`. The setting
accepts 1–5 integers from `0` to `90`; `0` represents the day the subscription
ends. If multiple thresholds apply in one sweep, the narrowest threshold,
closest to the remaining number of days, is used.

The API runs an hourly sweep and evaluates only each member's latest
subscription. At most one automatic email is sent for the same subscription
and threshold. The partial unique MongoDB index named
`renewal_reminders_threshold_unique` guarantees this. If delivery fails, the
reminder record is rolled back and can be retried in the next sweep.

Upcoming renewals can be listed with `GET /api/admin/reports/renewals`.
A manual reminder to a single member is sent through
`POST /api/admin/reports/renewals/:userId/remind`. Both operations are
available to the `admin` and `staff` roles.

A second reminder is not sent until 24 hours have passed since the last
delivery, automatic or manual, for the same subscription. For a manual attempt,
the API returns `429` with the reason `recently-reminded`; the hourly sweep
silently skips that member (`cooledDown`). When the cooldown expires, the
threshold is evaluated again, so the skipped reminder is not lost.

## CSV export

Only the `admin` role can download CSV from this endpoint:

`GET /api/admin/reports/export?dataset=members|subscriptions|entries&from&to`

`from` and `to` use the same defaults and 366-day upper bound as the reports.
`members` exports users by `createdAt`, `subscriptions` exports subscriptions by
`createdAt`, and `entries` exports entries by `at` within the selected range.

Each download is written to the `audit_logs` collection with the `data-exported`
action, along with the dataset and the applied `from` and `to` values. CSV files
contain bulk personal data. Under your data protection laws, download them only
for business purposes, restrict access, and do not retain them longer than necessary.

The file begins with a UTF-8 BOM so non-ASCII characters open correctly in
Excel. To prevent formula injection, cell values beginning with `=`, `+`, `-`,
or `@` are neutralized as text by prefixing them with a single quote.

## Troubleshooting

If a reminder email is not delivered, check the following in order:

1. Is `reminders.enabled` enabled in the gym settings?
2. Does `reminders.daysBefore` contain valid, non-empty thresholds?
3. Is `SMTP_HOST` defined, and can the API server reach the SMTP server?
4. Has the member's latest subscription not yet expired, and is it within the configured threshold window?
5. Has an automatic email already been sent for the same subscription and threshold?
6. Have 24 hours passed since the last automatic or manual reminder? (If not,
   both manual delivery and the sweep skip it.)
7. Does the API log contain `renewal reminder delivery failed` or an SMTP error?

After correcting the reminder setting or SMTP environment variables, restart
the API for an SMTP change. Automatic delivery will be retried during the next
hourly sweep.
