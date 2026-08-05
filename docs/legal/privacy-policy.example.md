# {{GYM_NAME}} — Privacy Policy (TEMPLATE)

> **This is a skeleton, not legal advice, and not a finished document.**
> Replace every `{{PLACEHOLDER}}`, delete what does not apply to you, and have
> counsel in your jurisdiction review it before you publish.

This policy explains how {{LEGAL_ENTITY_NAME}} handles your information in the
{{GYM_NAME}} member app and gym management system. It sits alongside the
[data processing notice](./data-processing-notice.example.md), which lists the
specific categories, purposes and legal bases.

## 1. Scope

Applies to the member mobile app, the staff/admin panel, and the turnstile
access system operated at {{LOCATIONS}}.

## 2. Account and authentication

Signing up requires an e-mail address, a phone number, and a password. E-mail
addresses are verified with a one-time code. Passwords are stored only as
salted hashes and are never readable by staff. Sessions are recorded with a
device fingerprint so that concurrent-session limits and shared-account
detection can work; you can see and revoke your sessions from {{WHERE}}.

## 3. Turnstile entry

Entry uses a static QR code posted at the turnstile, scanned with your phone.
At the moment of a scan the app reads your device location to confirm you are
at the gym; the reading is used for that decision and stored with the entry
record. Entry and exit timestamps are used for access control, occupancy
display and dispute resolution.

## 4. Health data

Age, height and weight are optional, entered by you, and used only to compute
calorie and body-composition figures shown to you. Weight changes are kept as a
dated history so the app can show a trend. Staff {{CAN_OR_CANNOT}} see these
values. You can clear them at any time from {{WHERE}}.

## 5. Photos

If you upload a profile photo it is stored at {{STORAGE_PROVIDER}} and served
from {{CDN_DOMAIN}}. Deleting your account deletes the stored photo.

## 6. Cookies and local storage

The staff panel uses a session cookie for authentication. The mobile app stores
the session token in the device's secure storage. No advertising or third-party
analytics trackers are used. {{ADJUST_IF_YOU_ADD_ANALYTICS}}

## 7. Security

{{DESCRIBE_MEASURES}} — for example: transport encryption, role-based access
control, audit logging of sensitive staff actions, multi-factor authentication
for privileged operations, and restricted database access.

## 8. Deleting your account

Request deletion from the member app; a staff member reviews it. On approval
your account, subscriptions, sessions, multi-factor enrollment, health data and
profile photo are permanently deleted and past turnstile records are
anonymized. Records we must keep by law ({{STATUTORY_RECORDS}}) are retained
for {{STATUTORY_PERIOD}}.

## 9. Contact

{{CONTACT_EMAIL}} — {{POSTAL_ADDRESS}}

Version {{VERSION}}, effective {{EFFECTIVE_DATE}}.
