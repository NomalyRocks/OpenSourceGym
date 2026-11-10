# Package catalog and payment records

Records money taken **at the gym**: a priced package catalog, sales of
membership periods (catalog package or a custom day count), partial payments,
the outstanding balance, a daily cash report and a debtors list. There is no
online payment collection, and a debt never blocks entry.

Types live in `packages/shared`; this page is the behavioural contract.

## Money

- Every amount is an integer in **minor units** (`priceMinor`, `amountMinor`,
  kuruş for TRY). No floats anywhere, in the API or in the clients.
- The chain currency is `settings.currency` (ISO 4217, one of `TRY`, `USD`,
  `EUR`, `GBP`; default `TRY`), owner-editable through `PUT /api/admin/settings`.
  All four use two minor digits.
- Each sale and each payment stores the currency it was made in, so changing
  the chain currency only affects new sales. A payment's currency must equal
  its period's sale currency.
- Bounds: `0 ≤ priceMinor ≤ 100_000_000_00`; `amountMinor ≥ 1`.

## Package catalog (`packages`)

```ts
{
  _id: ObjectId,
  name: string,                       // 1..80 chars
  duration: { unit: "month" | "day", value: number }, // month 1..24, day 1..366
  priceMinor: number | null,          // null = price not set yet
  active: boolean,
  legacyMonths?: 1 | 3 | 6 | 12,      // set only on the seeded classics
  createdAt, createdBy, updatedAt, updatedBy
}
```

- Chain-wide. Create/update/deactivate are **owner-only**
  (`GET/POST /api/admin/packages`, `PATCH /api/admin/packages/:id`). Every staff
  role can list active packages for the sale modal; `GET ...?all=true` also
  lists inactive ones and is owner-only (`403 FORBIDDEN` otherwise). The catalog
  is small and owner-curated, so the list is not paged. The response is
  `PackageListResponse`: `{ packages: Package[], currency: CurrencyCode }`,
  including the chain currency for staff who cannot read chain settings.
- Packages are never deleted. Deactivating hides a package from new sales; past
  sales keep their snapshot.
- A price change writes a `package-updated` audit row with the old and new
  price.
- **Classic packages.** A one-time idempotent repair (`repairs/`, marker
  `seed-legacy-month-packages`) upserts four packages keyed by `legacyMonths`
  (unique partial index), named `1 Aylık`, `3 Aylık`, `6 Aylık`, `12 Aylık`,
  with `priceMinor: null`. The upsert key makes it race-safe without a lock.
  These Turkish names are seeded data the owner can rename, the same carve-out
  as the seeded admin display name.

## Selling a period

`POST /api/admin/subscriptions` replaces `months` with one of two shapes:

```ts
// catalog sale: owner/admin/staff
{ userId, gymIds, packageId, priceMinor?, expectedPriceMinor?, expectedCurrency, expectedDuration, nextPaymentDue?, note?, requestId }
// custom grant: owner/admin only
{ userId, gymIds, custom: { days, priceMinor, label? }, expectedCurrency, expectedDuration, nextPaymentDue?, note?, requestId }
```

- **Staff sells at the catalog price.** `priceMinor` (a per-sale override) and
  `custom` are owner/admin only (`403 PRICE_OVERRIDE_FORBIDDEN`). An override
  writes the list price and the sale price to the `subscription-created` audit
  row.
- A catalog package with `priceMinor: null` cannot be sold without an override
  (`409 PACKAGE_PRICE_UNSET`), so staff cannot sell the classics until the
  owner prices them. Inactive package: `409 PACKAGE_INACTIVE`.
- Without an override, optional `expectedPriceMinor` must match the current
  catalog price, including zero; a different or cleared price returns
  `409 PACKAGE_PRICE_CHANGED` without creating a period. Replays still return
  the existing period even if the catalog price changed later.
- Every sale must include the confirmed `expectedCurrency` and
  `expectedDuration: { unit, value }`. A currency or duration mismatch also
  returns `409 PACKAGE_PRICE_CHANGED`, including custom grants and price
  overrides. The web client refreshes the catalog and requires confirmation again.
- Duration: month packages keep today's clamped calendar-month arithmetic
  (generalised from `1|3|6|12` to `1..24`); day packages and custom grants add
  `days × 24 h`. Periods still stack after the member's latest period.
- The period gets a `sale` snapshot:

  ```ts
  sale: {
    packageId: ObjectId | null,       // null for a custom grant
    packageName: string,              // snapshot (custom: label or "<days> days")
    duration: { unit, value },
    listPriceMinor: number | null,    // catalog price at sale time
    priceMinor: number,               // what the member owes
    currency: string,
    nextPaymentDue: Date | null,      // optional promise date for the remainder
  }
  ```

  Periods created before this feature have no `sale`: they show no price, no
  balance, and cannot take payments.

- `nextPaymentDue` can be changed later by owner/admin
  (`PATCH /api/admin/subscriptions/:id/sale`, audited).
- **Double submit.** `requestId` is a client-generated UUID with a unique
  partial index on `subscriptions` (only where the field exists). A repeat with
  the same id returns the existing period (`200`, same body, no second audit
  row) instead of creating a second one, even if the package was deactivated or
  repriced in between. An id already used for another member's period is
  `409 REQUEST_ID_CONFLICT`.
- Replays are resolved before checking gym availability. Owners, or callers
  with at least one gym on the existing period in scope, receive the original
  success even after gym deactivation. Inaccessible periods follow normal
  create validation and never return an existing period's details.

## Payments (`payments`)

```ts
{
  _id: ObjectId,
  subscriptionId: ObjectId,
  userId: string | null,              // null after account deletion
  gymId: string,                      // hex, the gym where the money was taken
  amountMinor: number,
  currency: string,
  method: "cash" | "card" | "transfer" | "other",
  paidAt: Date,                       // server time of recording
  note: string | null,                // ≤ 200 chars
  recordedBy: string,                 // staff user id
  packageName: string,                // snapshot, survives period deletion
  requestId: string,                  // client UUID, unique
  void: null | { at: Date, by: string, reason: string | null }
}
```

- **Append-only.** Payments are never deleted or edited. The only mutation is a
  void.
- `GET /api/admin/subscriptions/:id/payments` lists a period's payments (voided
  ones marked, newest first, at most 200), owner/admin/staff, only for periods
  with a gym in the caller's scope (`403 GYM_OUT_OF_SCOPE` otherwise).
- `POST /api/admin/subscriptions/:id/payments`
  `{ amountMinor, method, gymId, note?, requestId }`, owner/admin/staff. A
  period without a `sale` is `409 SUBSCRIPTION_UNPRICED`; a `gymId` not on the
  period is `409 PAYMENT_GYM_NOT_ON_PERIOD`. The response is the payment with the
  period's new `paidMinor`/`balanceMinor`.
  `gymId` must be in the caller's scope **and** on the period's `gymIds`. The
  period must have a `sale`.
- Runs under the per-user subscription lock (`og:lock:subscription:<userId>`),
  the same lock cancel and freeze take. Inside it the balance is recomputed
  from the payments collection; `amountMinor > balance` is
  `409 PAYMENT_EXCEEDS_BALANCE`. A repeated `requestId` returns the existing
  payment. Together these mean a double click or two concurrent requests can
  never overpay.
- **Void:** `POST /api/admin/payments/:id/void { reason }`, owner/admin, the
  payment's gym must be in scope, reason 3..200 chars, once only
  (`409 PAYMENT_ALREADY_VOIDED`). A voided payment no longer counts toward the
  balance or the cash totals; it stays visible, marked as voided. The void and
  its audit write run under the per-user subscription lock, shared with account
  deletion. An erased member (`userId: null` or missing user) returns
  `404 PAYMENT_NOT_FOUND`; lock contention returns `503 SUBSCRIPTION_BUSY`.
- Audit: `payment-recorded` and `payment-voided`, with `gymId` = the payment's
  gym.
- The source of truth for a balance is the payments collection:
  `balance = sale.priceMinor − Σ amountMinor of non-voided payments`. There is
  no stored counter to drift (standalone Mongo has no multi-document
  transactions).

## Rules tying payments to periods

- **A debt never blocks entry.** The gate does not read `sale` or `payments`.
  The panel shows a warning instead (member drawer, debtors list).
- **Cancelling a scheduled period that has non-voided payments** is refused
  with `409 SUBSCRIPTION_HAS_PAYMENTS`, checked inside the cancel lock. Void
  the payments first (refund the money in person); then cancel.
- Freeze credit and cancel repacking move period dates; payments reference the
  period by `_id` only, so they are unaffected.

## Reports

All day boundaries are local days in `REPORTS_TIME_ZONE`, turned into a UTC
range by a DST-safe helper next to `localDayLabel`.

- **Daily cash report**: `GET /api/admin/gyms/:gymId/reports/cash?day=YYYY-MM-DD`
  (owner/admin; `day` defaults to today in `REPORTS_TIME_ZONE`, an invalid one
  is `400 INVALID_DAY`). Non-voided payments recorded at that gym that day:
  total, totals by method, totals by staff, and the payment list; payments from
  that day that were voided are listed separately. Totals are returned as one
  entry per currency (`totals[]`, normally a single one), because a changed chain
  currency must never be added to the old one. Totals cover all matching
  non-voided payments. The combined `payments` and `voided` row list is capped
  at 5,000; `truncated: true` indicates that more rows exist.
- **CSV**: a `payments` dataset in the existing export route (`from`/`to`, gym
  column, void columns), audited as `data-exported` like the others.
- **Debtors**: `GET /api/admin/gyms/:gymId/reports/debtors` (owner/admin/staff,
  paged). Periods listing this gym that have a `sale` and a positive balance.
  Overdue first (`nextPaymentDue` in the past), then by due date (undated
  last), then larger balance first; the opaque keyset cursor carries all three
  keys. Frozen and expired periods with a balance are included.
- **Overview revenue card**: today's cash total for the gym, owner/admin only.
  Replaces the blurred mock card and its out-of-scope comment. Staff do not
  see the card.

## Audit

`package-created`, `package-updated` (before/after, so a price change records
old and new), `subscription-created` (package, list price, sale price),
`subscription-sale-updated` (promise date), `payment-recorded`,
`payment-voided` and `data-exported`. Payment rows carry the payment's `gymId`;
a repeated request writes none. On account deletion the free-text void reason
is also removed from `payment-voided` audit rows.

## Visibility

- `sale`, balance and payments on `GET /api/admin/users/:id/subscriptions` and
  in the member drawer are shown to a non-owner only for periods with a gym in
  their scope. Other periods return `sale: null`.
- The period list includes the latest 50 plus every older period with a positive
  balance visible to the caller, without duplicates, in the same descending
  end/creation/id order. Older debt stays available for recording payments.
- Members see their own package name, balance and next due date on
  `GET /api/me/subscription` (mobile subscription card) as `billing`. It is null
  when the member never had a priced period; the balance spans every priced
  period (past ones included) in the currency of the earliest one that still
  owes money. They never see who recorded a payment.

## Account deletion

On approval, together with the existing erasure, the member's payments are
anonymised: `userId → null`, `note → null`, `void.reason → null`. Amount,
currency, method, gym, date, recorder and package snapshot stay, so past cash
reports keep adding up. The periods themselves are still hard-deleted.

Keeping anonymised payment rows is the default because the gym may have a legal
duty to keep financial records. The operator must confirm this against their
own jurisdiction.

## Known limits

- A sale's `requestId` is only as durable as the period: after a scheduled
  period is cancelled, replaying its original create request creates a new
  period. Clients generate a fresh `requestId` per sale dialog, so this needs
  a deliberate resubmit.
- Audit rows are written after the business write, as everywhere else in the
  API, so a failed audit write is not retried on replay.
