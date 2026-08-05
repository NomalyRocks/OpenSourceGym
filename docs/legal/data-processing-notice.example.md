# {{GYM_NAME}} — Data Processing Notice (TEMPLATE)

> **This is a skeleton, not legal advice, and not a finished document.**
> Replace every `{{PLACEHOLDER}}`, delete what does not apply to you, and have
> counsel in your jurisdiction review it before you publish. Your regime may
> require sections that are missing here.

## 1. Who processes your data

{{LEGAL_ENTITY_NAME}}, {{REGISTERED_ADDRESS}}, acting as data controller.
Contact for data protection questions: {{CONTACT_EMAIL}}.
{{OPTIONAL: data protection officer / representative details, if your regime requires one}}

## 2. What we collect

The gym management system stores:

- Identity and contact data: first name, last name, e-mail address, phone number
- Account data: password hash, e-mail verification state, role, session and
  device records, multi-factor enrollment
- Membership data: subscription periods, renewal reminders sent
- Access data: turnstile entry and exit records with timestamps, and the
  location reading taken at the moment of the QR scan
- Optional self-reported health data: age, height, weight and weight history,
  entered by you for the calorie calculator
- Optional profile photo

## 3. Why we process it

| Purpose                                | Basis under {{APPLICABLE_LAW}}      |
| -------------------------------------- | ----------------------------------- |
| Creating and running your membership   | {{CONTRACT_PERFORMANCE}}            |
| Turnstile access control               | {{LEGITIMATE_INTEREST_OR_CONTRACT}} |
| Detecting shared accounts and fraud    | {{LEGITIMATE_INTEREST}}             |
| Health data for the calorie calculator | {{EXPLICIT_CONSENT}}                |
| Statutory bookkeeping and retention    | {{LEGAL_OBLIGATION}}                |

Health data is special-category data in most regimes. It is optional: the app
works without it, and you can clear it at any time.

## 4. Who we share it with

{{LIST_PROCESSORS}} — for example the hosting provider {{HOSTING_PROVIDER}},
the e-mail delivery provider {{SMTP_PROVIDER}}, and the object storage provider
used for profile photos {{STORAGE_PROVIDER}}.
{{IF_APPLICABLE: cross-border transfer mechanism, e.g. explicit consent, standard contractual clauses, adequacy decision}}

We do not sell personal data and do not use it for automated decision-making
with legal effects.

## 5. How long we keep it

{{RETENTION_TABLE_OR_POLICY}} — for example: membership and access records for
{{N}} years after the membership ends, then deleted; health data until you
remove it or your account is deleted.

## 6. Your rights

Under {{APPLICABLE_LAW}} you may request access to your data, correction,
erasure, restriction of processing, objection, and portability, and you may
withdraw consent where processing rests on consent.

Account erasure can be requested from the member app (Profile → delete
account); a staff member reviews and approves it. For other requests contact
{{CONTACT_EMAIL}}. We respond within {{RESPONSE_DEADLINE}}.

You may lodge a complaint with {{SUPERVISORY_AUTHORITY}}.

## 7. Changes

Current version: {{VERSION}}, effective {{EFFECTIVE_DATE}}. Material changes
are announced {{HOW_YOU_ANNOUNCE_CHANGES}}.
