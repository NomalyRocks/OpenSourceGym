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

| Field                    | Meaning                                                                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `range.from`, `range.to` | ISO timestamps for the range applied by the API.                                                                                                                                                                                         |
| `timeZone`               | IANA time zone used for daily report buckets.                                                                                                                                                                                            |
| `activeMembers`          | Number of unique members with an active subscription at the time of the request; independent of the selected range.                                                                                                                      |
| `newMembers`             | Number of users created within the range whose role is `member`.                                                                                                                                                                         |
| `newSubscriptions`       | Number of subscription records created within the range.                                                                                                                                                                                 |
| `lapsedMembers`          | Number of unique members whose latest subscription ended within the range and who did not renew with a later subscription. A member with a subscription that ends later is not included even if an older package ended within the range. |
| `renewalsDue`            | Number of unique members whose latest subscription will end within the next 7 days from the request time; independent of the selected range.                                                                                             |
| `entries.total`          | All entry attempts within the range.                                                                                                                                                                                                     |
| `entries.allowed`        | Allowed entries within the range.                                                                                                                                                                                                        |
| `entries.denied`         | Denied entries within the range.                                                                                                                                                                                                         |
| `entries.uniqueMembers`  | Number of unique members associated with at least one entry event within the range.                                                                                                                                                      |

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

## REPORTS_TIME_ZONE

`REPORTS_TIME_ZONE` determines the day boundaries in the daily entry trend. As
a result, an entry near midnight is grouped by the gym's local calendar day
rather than by the UTC day. The default is `Europe/Istanbul`.

The value must be a valid IANA time zone, such as `Europe/Istanbul`. An invalid
value is a configuration error, and the API exits during startup. Restart the
API process after changing the variable.

## Renewal reminders

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
