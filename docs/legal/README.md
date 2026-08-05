# Legal documents

OpenGym ships **no legal text**. The product is self-hosted and single-tenant,
so the operator running the gym is the data controller and is the only party
that can decide which regime applies (KVKK in Türkiye, GDPR/UK GDPR in Europe,
CCPA/CPRA in California, PIPEDA in Canada, LGPD in Brazil, …). The application
only stores **where** your documents live and **which version** is current.

Nothing in this directory is legal advice. The `*.example.md` files are
skeletons with `{{PLACEHOLDER}}` markers; have a qualified lawyer in your
jurisdiction review the result before publishing it.

## What the product does

| Concern                | Where it lives                                                     |
| ---------------------- | ------------------------------------------------------------------ |
| Document URLs, version | `settings._id: "gym"` → `legal` block, edited in the admin panel   |
| Public read            | `GET /api/legal` — no auth, returns URLs + version only            |
| Signup consent         | `dataProcessingAccepted` + `privacyAccepted`, both required        |
| Consent timestamps     | `dataProcessingAcceptedAt`, `privacyAcceptedAt` (server-stamped)   |
| Erasure request flow   | member requests → admin approves → account and related data purged |

Consent field names are deliberately regime-neutral: `dataProcessingAccepted`
covers whatever notice your jurisdiction calls for (aydınlatma metni, privacy
notice, information notice), `privacyAccepted` covers the privacy policy /
terms you publish alongside it.

## Setup

1. Draft your two documents. Start from the examples here or from your own
   counsel's text.
2. Publish them at stable public URLs (your gym website, a static bucket, a
   docs host). They must be reachable **without a login** — the mobile signup
   screen is unauthenticated.
3. Admin panel → Settings → "Hukuki belgeler": paste both URLs and set the
   version.
4. Verify: `curl https://<your-api>/api/legal` returns your URLs.

If a URL is left empty the consent checkbox is still shown and still required —
it just renders without a link. Signup never breaks on an unconfigured gym.

## Updating a document

Bump `legal.version` whenever the substance changes. The change is written to
`audit_logs` under `settings-updated`, which is the record you fall back on if
a member later disputes what they agreed to. Consent version is not yet stored
per member and members are not re-prompted on a bump — that flow is not
implemented.

## Erasure requests

The deletion request flow is regime-independent and always available:
`POST /api/me/deletion-request` (member) → admin approves or rejects from the
panel. Approval permanently deletes the account, subscriptions, sessions, MFA
enrollment, health metrics, sharing signals and the profile photo, and
anonymizes turnstile entry records. Audit actions:
`account-deletion-requested|cancelled|approved|rejected`.

Statutory response deadlines differ by regime (KVKK: 30 days, GDPR: one month,
extendable). OpenGym does not enforce a deadline — set your own internal SLA
for reviewing pending requests.
