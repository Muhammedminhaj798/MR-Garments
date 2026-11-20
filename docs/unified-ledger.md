# Unified supplier ledger (migration 0017)

Approved plan: `D:\SDEC\MR Garments\docs\unified-supplier-ledger-plan.md` (Revision 2). This file is the **API contract**
the backend implements and the frontend consumes. Where an older doc (supplier-advance.md, phase2-contracts.md section
3, contracts.md) says otherwise, this file wins.

## Model

- One account per **(supplier, currency)**. Its balance = the sum of its postings in `supplier_ledger_entries`.
  **Positive: money available with the supplier. Zero: settled. Negative: payable to the supplier.** Currencies are
  never added together or converted.
- Postings (signed `amount`):

  | `entryType` | sign | written by | key |
  | --- | --- | --- | --- |
  | `payment` | + | PAY-2 (supplier), backfill (legacy supplier payments, legacy advance receipts) | `payment:<paymentId>` / `advance:<advanceEntryId>` |
  | `payment_void` | − | PAY-3 void | `payment:<paymentId>:void` |
  | `order_debit` | − value | ORD-3, backfill | `order:<orderId>:debit` |
  | `order_adjustment` | ± | ORD-5 when the lines change the value | `order:<orderId>:adj:<n>` |
  | `order_cancel` | + | ORD-6 before the delete | `order:<orderId>:cancel` |
  | `adjustment` | ± | LED-3 (Management) | `adjustment:<client uuid>` |

- `origin` is `backfill` or `app`. The journal is append-only (database trigger). The only change allowed is the
  orders foreign key setting `order_id` to null when ORD-6 deletes an order.
- Documents:
  - `payments` holds every payment: orderless supplier payments (`supplier_id` + `currency`, `kind = 'Payment'`),
    legacy order-linked supplier payments (order kept as a memo) and shipping-agent payments (order-linked, never
    posted).
  - Payments are never deleted, only **voided** (`voided_at`, `voided_by`, `void_reason`).
- **Archive, read-only:** `supplier_advance_entries` (receipts are posted by link; allocation, reversal, excess and
  excess_return rows are never posted) and `supplier_deposits` + transactions.
- **Order value** = round(Σ ordered quantity × line rate, 2), unchanged. Receiving never posts anything.
- Every posting goes through `postLedgerEntry` (`src/modules/ledger/ledger.ts`). It takes a per-account advisory lock,
  so the before/after balances it returns are exact.
- **Exchange rates.** A posting copies its source's rate as it is: order snapshot for debits, adjustments and
  cancels; payment or receipt rate for credits and voids. **NULL stays NULL**, and INR shows as not set. A new
  non-INR payment or adjustment needs a rate; INR stores 1.

### Write-state guard

- `ledger_state` holds one row, `maintenance` or `live`. Migration 0017 creates it as `maintenance`.
- While `maintenance`, every financial write answers **503 `ledger_maintenance`** "Payments and order money are paused
  for maintenance. Try again later.":
  - PAY-2, PAY-3;
  - LED-3;
  - ORD-3;
  - ORD-5 when `lines` are sent;
  - ORD-6.
- Reads keep working. The check (`assertLedgerLive(tx)`) runs inside the write's transaction.
- Only `scripts/ledger-reconcile.ts --open "note" --database <name>` sets `live`, and only when every invariant
  passes.
- Test reset (`resetData`) and the e2e start (`scripts/start-e2e.ts`) set it to `live` on their fresh databases.

### Held accounts (D4, D18)

- `supplier_ledger_holds` (supplier, currency, reason) is written by the backfill's explicit list: **SUP-010 CNY**.
- A held account has no postings. It counts in no total, KPI or projection.
- Every new financial write into a held account answers **409 `account_held`** "This supplier's account is pending
  review.":
  - an order for that supplier in that currency;
  - a payment of either payee on such an order;
  - an orderless payment;
  - an adjustment;
  - a void;
  - an ORD-5 line change;
  - an ORD-6 delete.
- In reads, a held account and its orders carry `held: true` and null figures.

### Excluded receipts (owner decision, 2026-11-20)

- `DEFAULT_RECEIPT_EXCLUSIONS` (`src/modules/ledger/backfill.ts`) lists single legacy advance receipts the owner ruled
  invalid. The backfill never posts them; their `supplier_advance_entries` rows stay unchanged. The archive (ADV-1, the
  supplier ledger's "Legacy advance history" tab and its download) still lists them, marked "Excluded from ledger" with
  the reason. Everything else in their account is posted as usual.

  | Receipt (advance entry id) | Account | Amount | Entered (UTC) | Reason |
  |---|---|---|---|---|
  | `f2b7966a-0937-485b-94a6-e6a536bfeedc` | SUP-004 USD | 25,000 CASH | 2026-11-19 14:34:51 | duplicate of `547ef798…` (14:03:06, genuine, posted) |
  | `6ab149cc-bd00-4ef9-90f3-dc6bac5ccb47` | SUP-009 CNY | 1,212 Cash | 2026-11-20 04:54:34 | test entry |

- Backfill `--apply` is refused while a listed id is unknown, is not a receipt, or has money applied from it (an
  allocation); the dry run reports each problem.
- Reconciliation (the script and LED-4) leaves the listed receipts out of the "receipts" check and adds the
  "excluded-receipts" check: no listed receipt has a posting.
- A new invalid receipt needs a code change to this list and the owner's confirmation; never delete or edit the legacy row.

### FIFO settlement projection (read-only, never stored)

- Per account, the pool is payments − voids ± adjustments.
- Live orders are settled **oldest first**: `order_date`, then the order's `created_at`, then id.
- `settled` = what the pool covers of the order (never negative).
- `outstanding` = value − settled (never negative).
- `paymentStatus`: `unpaid` (settled 0), `partly`, or `paid` (settled = value, or value 0).
- A void empties its own payment.
- **Negative adjustments: newest credits first (LIFO), approved by the owner on 2026-11-20.**
  - At its own date, a negative adjustment takes from the newest credits that exist then (payments and positive
    adjustments, newest `entry_date`, then the latest recorded). Credits dated after it are untouched.
  - Each credit keeps its own currency and its rate snapshot; nothing is converted or re-rated. An adjustment only
    ever touches credits of its own account (supplier and currency).
  - When it is larger than every credit left, the shortfall is a deficit that the next credits fill first.
  - Nothing is stored: the projection recomputes it on every read. Orders are then settled oldest first (FIFO) from
    what remains, so `settledCny`, the slices and goods INR (`settledInr`, landed cost) follow the credits that are
    really left.
  - Example (`src/modules/ledger/lifo.test.ts`): credits A ¥100 @10 (1 Oct), B ¥100 @11 (5 Oct), C ¥100 @12 (9 Oct)
    and an order of ¥120.
    - A −¥150 adjustment (10 Oct) empties C and half of B. The order settles A ¥100 @10 + B ¥20 @11 = ₹1,220, and the
      balance is +¥30.
    - At −¥300 nothing is left: the order is unpaid and the balance is −¥120.
    - Dated 6 Oct instead, the −¥150 takes B and then ¥50 of A; C (9 Oct) is untouched.
- Goods INR (`settledInr`) = Σ slices, each at its own credit's rate. It is null when any slice has no rate.
- An order whose debit is not posted yet has null figures (`posted: false`, not shown in responses).

## Shared response fields

**SettlementFields** (on every order row that carries money, and only with payments View where today's figures need it):

```ts
held: boolean
settledCny: number | null        // FIFO-settled, in the order's currency
outstandingCny: number | null    // never negative
paymentStatus: "unpaid" | "partly" | "paid" | null
settledInr: number | null        // goods INR: slices at their own rates
```

**MilestoneFields** (Deposit Required, D11). Met when settled ≥ required. Never a balance:

```ts
depositRequiredCny: number | null
depositSettledCny: number | null   // = settledCny
depositPendingCny: number | null   // max(0, required − settled)
depositStatus: "none" | "unmet" | "partly" | "met" | null   // null while held / not posted
```

**LedgerAccount**:

```ts
{ supplierId, currency, held,
  creditsCny, debitsCny, balanceCny,         // signed balance; null while held
  paidInr, paidInrComplete,                  // payments − voids at their rates
  outstandingCny, openOrders, lastPaymentOn }
```

**LedgerEntry** (LED-1 `entries`, RPT-5D/RPT-O1 statement):

```ts
{ id, entryType, currency, amount, exchangeRate, amountInr /* null without rate */, entryDate, origin,
  orderId, po /* current PO, or the stored one for a deleted order; null on payments/adjustments */,
  paymentId, advanceEntryId, reversesId, notes /* adjustment reason, void reason */,
  balanceBefore, balanceAfter /* adjustments only */, runningBalance /* account balance right after, by date order */,
  recordedAt /* ISO */, recordedBy /* user name */,
  payment: null | { kind, payeeRole, mode, reference, notes, memoPo /* legacy order */, voided, voidedAt, voidedBy, voidReason },
  advance: null | { mode, reference, notes } }
```

**SettlementSlice** (ORD-4 / RPT-O1 / landed cost): the credits that settled the order, oldest first.

```ts
{ entryId, entryType: "payment" | "adjustment", paymentId, advanceEntryId, entryDate, amount, exchangeRate, amountInr,
  mode, reference, memoPo /* legacy order the payment named */ }
```

**PaymentRow** (PAY-1, ORD-4, RPT-O1, RPT-5D, PAY-2/3 responses):

```ts
{ id, orderId: string | null, po: string | null, supplierId, supplier, currency, kind: "Deposit" | "Balance" | "Payment",
  payee, payeeRole: "supplier" | "agent", amountCny, status: "paid" | "due", paidOn, dueDate, rateInr,
  amountInr /* null while due */, mode, reference, notes, recordedAt,
  voided: boolean, voidedAt: string | null, voidedBy: string | null /* name */, voidReason: string,
  held: boolean /* the payment's account is held (D4): listed, counted in no total */ }
```

Voided payments and a held account's payments are listed (flagged), and **every total leaves them out**: paid, agent paid, sea freight, due windows
and exports.

## Endpoints

### New

| Id | Route | Access | Response |
| --- | --- | --- | --- |
| LED-1 | `GET /suppliers/:supplierId/ledger` | payments View | `{ supplier: {id, code, name, currency, exchangeRate, status}, accounts: LedgerAccount[], currencyOptions: string[], entries: LedgerEntry[] (newest first), orders: [{ id, po, orderDate, stage, currency, exchangeRate, valueCny, ...SettlementFields, ...MilestoneFields }] (oldest first), held: [{ currency, reason, orders[], payments[], advanceEntries[] }] }` |
| LED-2 | `GET /supplier-ledger` | payments View | `{ accounts: [LedgerAccount & { supplier, code, status }] (name, then currency), totals: [{ currency, accounts, balanceCny, payableCny, availableCny, outstandingCny }] (held left out), suppliers: [{id, name, status}] }` |
| LED-3 | `POST /suppliers/:supplierId/ledger/adjustments` (one request per key at a time; a key already posted replays before any other check; `balanceBefore`/`balanceAfter` are the account's at the moment recorded, the entry's `runningBalance` is null here — LED-1 gives the date-order running balance) | payments **Full** | body `{ currency, amount /* signed, ≠ 0, 2 dp */, entryDate /* ≤ today */, rateInr? /* required non-INR, none or 1 for INR */, reason, idempotencyKey /* uuid */ }` (strict: other keys 400) → 201 `{ entry: LedgerEntry, balanceBefore, balanceAfter }`; same key + same details → 200 same; same key + other details → 409 `idempotency_conflict`; 409 `account_held`; 422 fields; 503 |
| LED-4 | `GET /supplier-ledger/reconciliation` | admin Full | `{ ok, checks: [{ id, title, ok, problems[] }] }` |

`currencyOptions` (D10) is the supplier's current currency plus every currency with a non-zero balance, never a held
one, ordered CNY, USD, INR, then the rest.

### Payments

- **PAY-2 `POST /payments`.** Payments Enter. Guard. One of two bodies:
  - **Supplier** (the unified Record payment):
    - Body: `{ supplierId, amount, currency?, paidOn, rateInr?, mode, reference?, notes?, clientRequestId /* uuid */ }`.
    - Rules:
      - the currency defaults to the supplier's; it must be in `currencyOptions` (else 422 `currency`);
      - rate: none or 1 for INR, required otherwise (422 `rateInr`);
      - `paidOn` is not in the future;
      - a held account answers 409 `account_held`.
    - Writes a `payments` row (`order_id` null, `supplier_id`, `currency`, `kind 'Payment'`, `payee` = supplier name,
      `payee_role 'supplier'`) and its `payment` posting.
    - Response: 201 `{ payment: PaymentRow, ledger: { supplierId, currency, balanceBefore, balanceAfter } }`.
    - A repeated `clientRequestId` with the same details returns 200 with the same body. With other details it is
      409 `idempotency_conflict`.
  - **Shipping agent** (sea freight, unchanged except the key):
    - Body: `{ orderId, payeeRole: "agent", agentId, kind, amountCny, paidOn, rateInr?, mode, reference?, notes?, clientRequestId }`.
    - Response: 201 `{ payment: PaymentRow }`.
    - Never posted. Held order account answers 409.
  - An order-linked **supplier** body (`orderId` with `payeeRole: "supplier"`) answers **422** with
    `payeeRole: "Supplier payments are now recorded against the supplier. Reload the page."`.
- **PAY-3 `DELETE /payments/:id`.** Payments Full. Guard. JSON body `{ reason }`.
  - Voids the payment. The row stays, with `voided_at`, `voided_by` and the reason. A posted payment also gets one
    `payment_void`.
  - Response: 200 `{ payment: PaymentRow, ledger: { supplierId, currency, balanceBefore, balanceAfter } | null }`.
  - Errors:
    - an already voided payment: 409 `already_voided`, nothing written;
    - a blank reason: 422 `reason`;
    - a held account: 409 `account_held`;
    - an unknown id: 404.
  - There are no cross-order effects.
- **PAY-1 `GET /payments`.** Payments View. `{ orders, payments, accounts, totals }`:
  - `orders`: `{ orderId, po, supplierId, supplier, currency, supplierRate, orderValueCny, ...SettlementFields, ...MilestoneFields, agentPaidCny, agentPaidInr, paidInr, nextDue }` (newest first);
  - `payments`: PaymentRow[], including orderless and voided rows, latest date first;
  - `accounts` and `totals`: as LED-2.
  - `paidInr` = settledInr + agentPaidInr, null when settledInr is null.

### Orders

- **ORD-1 `GET /orders`** rows:
  - removed: `paidCny`, `paidInr`, `supplierPaidCny`, `supplierPaidInr`, `advanceCny`, `advanceInr`, `depositPaidCny`;
  - added: SettlementFields, MilestoneFields, `agentPaidCny`, `agentPaidInr`, `paidInr` (same rule as PAY-1).
  Without payments View the money fields are null, as today's sections.
- **ORD-2 `GET /orders/options`** `suppliers[]`: `advanceAvailable` is removed; added `held: boolean` (the supplier's
  current-currency account is held) and `ledgerBalance: [{ currency, balanceCny }]` (non-held accounts; **null without
  payments View**, as are ORD-3's `ledger` and ORD-5's `ledger`).
- **ORD-3 `POST /orders`.** Guard. A held supplier-currency answers 409 `account_held`.
  - `deposits[]` takes **agent payees only**. A supplier payee answers 422 `deposits`: "Record supplier payments with
    Record payment."
  - Posts the order's debit in the same transaction.
  - Response: `{ order: { id, po }, ledger: { supplierId, currency, debitCny, balanceBefore, balanceAfter } }`.
- **ORD-4 `GET /orders/:po`.** Removed: `paidCny`, `paidInr`, `supplierPaidCny`, `supplierPaidInr`, `advanceCny`,
  `advanceInr`, `excessCny`, `excessInr`, `advanceStatus`, `balanceCny`, `advanceEntries`, `advanceAvailableCny`,
  `depositPaidCny`. Added:
  - SettlementFields and MilestoneFields;
  - `agentPaidCny`, `agentPaidInr`, `paidInr`;
  - `slices: SettlementSlice[] | null`;
  - `supplierAccount: LedgerAccount | null` (the order's currency);
  - `payments: PaymentRow[] | null` (order-linked rows: legacy supplier memo rows plus agent rows; null without
    payments View).
- **ORD-5 `PATCH /orders/:po`.**
  - The `belowPaid` refusal is **removed**.
  - When `lines` are sent: guard, held check, then one `order_adjustment` for the value change (nothing when
    unchanged).
  - Response `{ order, ledger?: { supplierId, currency, changeCny, balanceBefore, balanceAfter } }` (`ledger` only when
    lines were sent).
  - Date, terms, PO and deposit-required edits post nothing.
- **ORD-6 `DELETE /orders/:po`.** Guard; held answers 409. Existing refusals stay: payments of any kind (voided
  included), receipts, containers, warehouse lines. Posts `order_cancel`, then deletes. Returns 204.

### Archive and retired

- **ADV-1 `GET /suppliers/:supplierId/advances`.** Payments View. Read-only archive:
  `{ supplier: {id, name, currency}, entries: [{ id, kind, amount, currency, exchangeRate, amountInr, entryDate, po, paymentId, advanceId, mode, reference, notes, recordedAt, recordedBy, exclusionReason }] }`,
  oldest first. No summary and no open orders. `exclusionReason` is the reason of a receipt on the owner's exclusion
  list (`DEFAULT_RECEIPT_EXCLUSIONS`, never posted), null on every other entry.
- **ADV-5 `GET /supplier-advances/suppliers`** (the Record payment supplier list). Payments Enter. Active suppliers by
  `lower(name)`: `{ suppliers: [{ id, name, currency, exchangeRate, held, currencyOptions: string[], balances: [{ currency, balanceCny }] }] }`.
- **ADV-2, ADV-3, ADV-4, SD-2, SD-3, SD-4, SD-5** answer **410** `{ error: { code: "gone", message } }`:
  - ADV-*: "Supplier advances are recorded as supplier payments in the supplier ledger now."
  - SD-*: "Supplier deposits are a read-only archive now."
- **DEP-1 `GET /deposits`.**
  - `{ milestones, orderDeposits, supplierDeposits, suppliers }`.
  - `milestones`: orders with a Deposit Required:
    `{ orderId, po, orderDate, supplierId, supplier, currency, ...MilestoneFields, held }`, newest first.
  - `orderDeposits`: legacy order-linked Deposit payments as PaymentRow, archive.
  - `supplierDeposits`: the archive, as today.
  - `advances` and `orderObligations` are removed.
- **SD-1 `GET /suppliers/:supplierId/deposits`**: archive, as today without `advance`.

### Reports and other reads

- **RPT-5 `GET /reports/payments-per-supplier`:**
  - `suppliers[]`: `{ supplierId, supplier, currency, held, orders: string[] /* open POs */, orderValueCny, settledCny, outstandingCny /* open orders */, creditsCny, balanceCny /* ledger, signed */, paidInr }`;
  - `totals` (CNY only) and `totalsByCurrency[]`: `{ currency, orders, orderValueCny, settledCny, outstandingCny, balanceCny, payableCny, availableCny, paidInr }`, held left out;
  - `dueNext30*` (non-void due rows) and `finishedPos` are unchanged.
- **RPT-5D `GET /reports/payments-per-supplier/:supplierId`:**
  - `summary.byCurrency[]`: `{ currency, held, orders, orderValueCny, settledCny, outstandingCny, creditsCny, balanceCny, paidInr }`;
  - `advance` is replaced by `ledger: { accounts: LedgerAccount[], entries: LedgerEntry[] }`;
  - the `payments` page holds the supplier's payments as PaymentRow, orderless included, voided flagged;
  - `orders` page rows carry SettlementFields instead of `paidCny`, `advanceCny` and `balanceCny`.
- **summary `GET /reports/summary`:** `payments` adds `payableByCurrency: [{ currency, amount }]` (Σ negative ledger
  balances, positive amounts, held left out).
- **RPT-O2 `GET /reports/orders`:**
  - rows: removed `paidCny`, `advanceCny`, `advanceInr`, `balanceCny`; added SettlementFields, MilestoneFields,
    `agentPaidInr`, `paidInr`;
  - the `paymentStatus` filter uses the projection (unpaid, partly, paid; held and unposted orders match no status);
  - `summary.byCurrency[]`: `{ currency, orderValueCny, settledCny, outstandingCny }`;
  - `summary.paidInr` = Σ row `paidInr`.
- **RPT-O1 `GET /orders/:po/report`:**
  - `payments`: `{ list: PaymentRow[], ...SettlementFields, slices, agentPaidCny, agentPaidInr, dueCny, ...MilestoneFields }`.
    Removed: `paidCny`, `paidInr`, `advance*`, `excess*`, `balanceCny`, `depositsPaidCny`, `advanceEntries`.
  - `supplierAccount`: `{ orders, openOrders, purchaseValue, settled, outstanding /* byCurrency lists */, accounts: LedgerAccount[], entries: LedgerEntry[], deposits: { summary, list } /* archive */ }`.
- **Landed cost** (`loadLandedCosts`, LC `GET /landed-cost`, RPT-6):
  - goods INR = the order's `settledInr` (slices at their rates);
  - `goodsPayments` = the slices, so the list and the total agree;
  - `waitingFor: "supplier payment"` while outstanding > 0 or the order has no settlement;
  - sea freight = non-void agent payments.
- **SUP-1 `GET /suppliers/summary`:** `unpaid` = Σ payable (negative) ledger balances per currency, held left out.
  Due windows read non-void due rows.
- **SUP-2 / MD-1 `GET /suppliers`:** `balance` per currency = the signed ledger balance; held accounts are left out of
  it and listed in `heldCurrencies: string[]`.
- **WH-2:**
  - `previousOutstanding[]`: per supplier, `byCurrency` Σ outstanding (projection) of its other orders dated before
    the trip (> 0 only, held left out), plus `ledgerBalance: [{ currency, balanceCny }]`;
  - `cost.goodsInr` comes from the projection.
- **REC-2 `GET /receipts/options`:** `depositsPaidCny` is replaced by `outstandingCny` (projection; null without
  payments View or without a settlement).
- **Notifications:** an orderless `payment-recorded` links to `/supplier-ledger/<supplierId>`.
- **Guards:**
  - supplier delete also counts ledger entries and supplier payments;
  - USR-5 counts `supplier_ledger_entries.created_by` and `payments.voided_by`.

## Scripts

- **`scripts/ledger-backfill.ts`.** `[--preflight] [--apply --database <name>]`.
  - A dry run by default. Idempotent.
  - Holds SUP-010 CNY and leaves out the excluded receipts (`DEFAULT_RECEIPT_EXCLUSIONS`).
- **`scripts/ledger-reconcile.ts`.** `[--write-baseline f] [--baseline f] [--compare-legacy --expect PO…] [--open "note" | --close "reason"] [--database <name>]`.
  - `--open` is refused unless `--baseline` and `--compare-legacy` are given and every check passes.
  - The checks include the exclusion list (every DEFAULT_HOLDS entry must name a supplier and be held) and "no supplier
    deposit exists" (D8: they are never posted, so any one needs an owner decision).
- **Backfill `--apply`** is refused while any hold on the list names no supplier, or any excluded receipt is unresolved.
- **If reconciliation reports order drift** (an old-backend line edit or delete between the migration and the new
  backend): stop, keep the guard in maintenance, and investigate. No application write exists yet, so the rehearsed
  rollback is still allowed.
- **`scripts/ledger-rollback-check.ts`.** `--baseline f`. Runs the pre-rollback checklist: exit 0 only before any
  application write.
- **`scripts/rollback/0017-down.sql`.** The rehearsed down migration. It refuses by itself once the application has
  written.
