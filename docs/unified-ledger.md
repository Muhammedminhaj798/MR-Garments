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
  - ORD-5 when `lines` are sent, or a new order date, PO number or deposit required (the cutover baseline's fields),
    with its own message: "Order dates, PO numbers, deposits and items are paused for maintenance. The delivery date
    and container terms can still change." A field sent back unchanged is no change; delivery date and terms edits
    are allowed;
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

- Per account, the pool is payments − voids ± adjustments. Credits (payments and positive adjustments) are lots in
  date order (`entry_date`, then the moment recorded, then id), each in the account's currency at its own rate snapshot.
- Live orders are settled **oldest first**: `order_date`, then the order's `created_at`, then id.
- `settled` = what the pool covers of the order (never negative).
- `outstanding` = value − settled (never negative).
- `paymentStatus`: `unpaid` (settled 0), `partly`, or `paid` (settled = value, or value 0).
- **Negative adjustments (LIFO 2026-11-20; M7 and "oldest obligation first" confirmed by the owner on 2026-11-21).**
  1. **Eligible credits.** A negative adjustment can take a credit only if it is dated on or before the adjustment and
     was recorded before the adjustment was created.
  2. **Worked out as recorded.** The adjustment's take is worked out as of the moment it was recorded: from its
     eligible credits (less what adjustments recorded before it took), the dues of its date as they were then recorded
     (orders, deleted ones included, and earlier shortfalls, dated on or before it, each at its value then) settle the
     oldest first; the adjustment takes what is left free of them, **newest first**. **No credit is taken twice**: an
     adjustment never takes money that settled an order or a shortfall dated on or before it, nor a credit taken by an
     adjustment recorded before it. An order dated after the adjustment is a newer obligation: a backdated adjustment
     (recorded after such an order already had its credits) is older, so it takes them first, and that order waits for
     later credits (oldest obligation first). It may not do so to an order whose landed cost is final: LED-3 refuses
     such an adjustment (422 `entryDate`, nothing written; owner decision 2026-11-21).
  3. **Shortfall.** What the free eligible credits can't cover is a shortfall, payable to the supplier from the
     adjustment's date. The balance is negative from that date (the statement's running balance shows it).
  4. **Oldest obligation first.** Orders and shortfalls are settled together, oldest first: an order by its
     `order_date`, a shortfall by its adjustment's `entry_date`, then the moment recorded, then id. Later credits
     enter in date order and reduce the negative balance through this ordinary settlement: a later credit settles an
     older shortfall before a newer order, and an older order before a newer shortfall.
  5. **Never rewritten.** A credit dated after the adjustment, or recorded after it with an earlier date, never
     changes its take; it settles orders and shortfalls in date order instead. Nor do orders recorded after it, later
     order value changes, later adjustments, or an ORD-6 delete (a deleted order's postings keep its id in their key,
     so the adjustments recorded while it existed still see it). Exceptions: a void (rule 6), and an ORD-5 order-date
     move, because only an order's current date is known (no history is kept).
  6. **Voids.** A void reverses its payment where that payment stands: the payment's credit is its amount less the
     void, so a voided payment is as if it had never been recorded. Every adjustment is recalculated without it, by
     rules 1-5 (still from the credits of its own date, never a later one).
  7. **Currency and rates.** Each account (supplier and currency) settles apart. Each credit keeps its own rate
     snapshot; nothing is converted or re-rated. Balances in the account's currency are the sum of the postings; the
     INR paid is each payment (less its void) at its own rate; goods INR is each settling slice at its credit's rate.
  8. Nothing is stored: the projection (`projectAccount` in `src/modules/ledger/ledger.ts`) recomputes it on every
     read. The account's `outstandingCny` is the orders' outstanding only: while a shortfall is unsettled, the payable
     balance is larger by it.
  - Examples (`src/modules/ledger/lifo.test.ts`): credits A ¥100 @10 (1 Oct), B ¥100 @11 (5 Oct), C ¥100 @12 (9 Oct)
    and an order o1 of ¥120 dated 2 Oct, all recorded on their dates. When an adjustment is recorded on 10 Oct, o1
    has A and ¥20 of B; ¥180 is free (B ¥80, C ¥100).
    - **Enough free credits.** −¥150 on 10 Oct takes C and ¥50 of B. o1 keeps A ¥100 @10 + B ¥20 @11 = ₹1,220; the
      balance is +¥30. A later credit (¥100 @15 on 12 Oct) does not change this: it is left over.
    - **More than the free credits.** −¥300 takes the free ¥180 and is ¥120 short. o1 stays paid (its credits are
      never taken); the balance is −¥120, all of it the shortfall.
    - **Future credits are not taken.** Dated 6 Oct, −¥150 can take only B's free ¥80 (C is dated later): ¥70 short
      from 6 Oct. C then settles the shortfall; the balance is +¥30.
    - **Later credits, oldest obligation first.** −¥350 on 10 Oct is ¥170 short. With an order o2 of ¥80 dated 11 Oct,
      D ¥100 @13 (12 Oct) goes to the shortfall (10 Oct, older than o2): ¥70 still short. E ¥100 @14 (14 Oct) settles
      the shortfall's last ¥70, then ¥30 of o2 at E's rate (₹420); the balance is −¥50, o2's outstanding.
    - **The owner's example.** −¥50 on 2 Oct with no credits: ¥50 short. An order of ¥120 on 3 Oct. C ¥100 on 5 Oct
      settles the 2 Oct shortfall (¥50), then ¥50 of the order. −¥100 on 6 Oct finds nothing free (C is spent) and is
      ¥100 short. Payable ¥170: the 6 Oct shortfall ¥100 and the order's ¥70. A next credit settles the order's ¥70
      first (3 Oct), then the 6 Oct shortfall.
    - **An adjustment recorded later but dated earlier.** A ¥100 on 1 Oct; −¥50 dated 8 Oct takes ¥50 of A. Then −¥80
      dated 4 Oct, recorded on 12 Oct, can take only A's other ¥50: ¥30 short from 4 Oct.
    - **A credit recorded later.** An order of ¥200 (3 Oct) has Z1 ¥100 @11 (6 Oct) and Z2 ¥100 @12 (8 Oct) when −¥100
      is recorded on 10 Oct: ¥100 short. X ¥200 @10 dated 5 Oct, recorded on 15 Oct, never changes that: X settles the
      order, Z1 the shortfall, and Z2 a later order o2 (11 Oct) at ₹1,200.
    - **A void.** With D ¥100 @13 (12 Oct) after −¥150 (10 Oct), voiding C: recalculated without C, the adjustment
      takes B's free ¥80 and is ¥70 short; D settles that. o1 keeps A and ¥20 of B; the balance is +¥30.
    - **A void that leaves nothing free.** With only A and B before the adjustment, voiding B: o1 had all of A, so all
      ¥150 is short. D (12 Oct) settles o1's last ¥20 first (older), then ¥80 of the shortfall; E (14 Oct) its last
      ¥70.
    - **A deleted order.** A ¥100 @10 (1 Oct) and B ¥100 @11 (2 Oct) settle o1 ¥200 (3 Oct) when −¥100 is recorded on
      10 Oct: ¥100 short. Deleting o1 later doesn't change that: the shortfall gets A, and a later order o2 (11 Oct) B.
    - **A backdated adjustment.** A ¥100 (1 Oct) settles o (5 Oct). −¥100 dated 3 Oct, recorded later, is older than o: it
      takes A, and o is unpaid until a later credit (refused if o's landed cost is final).
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
| LED-3 | `POST /suppliers/:supplierId/ledger/adjustments` (one request per key at a time; a key already posted replays before any other check; `balanceBefore`/`balanceAfter` are the account's at the moment recorded, the entry's `runningBalance` is null here — LED-1 gives the date-order running balance) | payments **Full** | body `{ currency, amount /* signed, ≠ 0, 2 dp */, entryDate /* ≤ today */, rateInr? /* required non-INR, none or 1 for INR */, reason, idempotencyKey /* uuid */ }` (strict: other keys 400) → 201 `{ entry: LedgerEntry, balanceBefore, balanceAfter }`; same key + same details → 200 same; same key + other details → 409 `idempotency_conflict`; 409 `account_held`; 422 fields; 422 `entryDate` when it would change the settlement of an order whose landed cost is final ("An adjustment on this date would change the payments that settle <POs>, whose landed cost is already final. Choose a later date.", nothing written; owner decision 2026-11-21, the M8 check of `costs/landed-cost.ts`); 503 |
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
  - Refused with 422 `orderDate` when the order would change the settlement of an order whose landed cost is final
    (M8, below): "This order date comes before <POs>, whose landed cost is already final: the order would take the
    payments that settle it. Choose a later order date." Nothing is written.
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
  - The `belowPaid` refusal is **removed**. Payments never block an edit (owner refinement 2026-11-21): quantity, rate
    (so the order value), order date and PO number stay editable on an order with supplier payments, partly or fully
    paid, at the stages where they are editable at all (order date and items until goods are received; PO number until
    the warehouse). A value change is one `order_adjustment`; the debit, earlier adjustments and every payment and its
    credit are never rewritten (a renumbered order's earlier postings keep the number they were posted under), and the
    FIFO projection re-settles (a total below what was paid leaves the rest available with the supplier).
  - The supplier and the currency are fixed (blocked for safety): the order's postings belong to the account of its
    supplier and currency, and the ledger has no transfer between accounts (a debit key is used once per order, the
    reconciliation expects one debit per order, and the line rates are amounts in the order's currency). `supplierId`
    or `currency` other than the saved ones answer 422 with the reason; the saved ones are no change.
  - When `lines` are sent: guard, held check, then one `order_adjustment` for the value change (nothing when
    unchanged).
  - Response `{ order, ledger?: { supplierId, currency, changeCny, balanceBefore, balanceAfter } }` (`ledger` only when
    lines were sent).
  - Date, terms, PO and deposit-required edits post nothing.
  - A new order date is refused with 422 `orderDate` when it would change the settlement of an order whose landed cost
    is final (M8): "Changing the order date would change the payments that settle <POs>, whose landed cost is already
    final. Keep the saved order date." Nothing is changed.
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
    A held account's order has null `agentPaidCny`, `agentPaidInr` and `dueCny` too (as ORD-4): no money figure at all.
- **RPT-O2 `GET /reports/orders`:** `summary.paidInr` and `summary.landedCostInr` leave a held account's orders out, as
  `summary.byCurrency` does.
    Removed: `paidCny`, `paidInr`, `advance*`, `excess*`, `balanceCny`, `depositsPaidCny`, `advanceEntries`.
  - `supplierAccount`: `{ orders, openOrders, purchaseValue, settled, outstanding /* byCurrency lists */, accounts: LedgerAccount[], entries: LedgerEntry[], deposits: { summary, list } /* archive */ }`.
- **Landed cost** (`loadLandedCosts`, LC `GET /landed-cost`, RPT-6):
  - goods INR = the order's `settledInr` (slices at their rates);
  - `goodsPayments` = the slices, so the list and the total agree;
  - `waitingFor: "supplier payment"` while outstanding > 0 or the order has no settlement;
  - sea freight = non-void agent payments.
  - LC rows carry `held` (the order's account is held): listed, their money in no total.
- **SUP-1 `GET /suppliers/summary`:** `unpaid` = Σ payable (negative) ledger balances per currency, held left out.
  Due windows read non-void due rows. `openPos` counts and totals the same orders: a held account's orders are in
  neither its `count` nor its `value`, and are counted apart in `heldCount` (the card's "pending review" line). MD-1's
  per-supplier `openPos` ("Active POs") follows the same rule, with the held ones in `heldOpenPos`.
- **SUP-2 / MD-1 `GET /suppliers`:** `balance` per currency = the signed ledger balance; held accounts are left out of
  it and listed in `heldCurrencies: string[]`. SUP-2's `value` (per supplier and per month) leaves a held account's
  orders out, as MD-1's `ytdValue` does; its delivery and completion counts still count every order.
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

The release and rollback order is in `docs/operator-commands.md` ("Unified supplier ledger").

- **The approved baseline** (`legacyRecords`, format `supplier-ledger-baseline/2`): every legacy record (orders, order
  lines, payments, advance entries, supplier deposits and their transactions) by id, with its financial fields only.
  - Left out, so harmless work never blocks the cutover: an order's stage, delivery date and terms; a line's item and
    position; modes, references, notes, `created_at`/`updated_at`/`created_by`; the payment columns 0017 added.
  - Written once, in the rehearsal, from the production snapshot restored on this computer (`--write-baseline`). It
    never overwrites a file, and is refused with `NODE_ENV=production` or a database that is not local. The owner
    approves the file by its sha256.
  - Every later step reads it with `--baseline <file> --baseline-sha256 <sha>` (the sha256 is always required) and lists
    each record added, removed or changed since. A file of the older whole-row format, or with another sha256, is refused.
- **`scripts/ledger-backfill.ts`.** `[--preflight] [--baseline f [--baseline-sha256 h]] [--apply --database <name> --baseline f --baseline-sha256 h]`.
  - A dry run by default. Idempotent.
  - Holds SUP-010 CNY and leaves out the excluded receipts (`DEFAULT_RECEIPT_EXCLUSIONS`).
  - `--apply` compares the legacy records with the approved baseline in the same snapshot it posts from (repeatable
    read), and is refused on any difference.
- **`scripts/ledger-reconcile.ts`.**
  - `--write-baseline <new file>` (rehearsal only) and `--check-baseline f --baseline-sha256 h` (read-only, works before
    0017; exit 1 on any difference).
  - Checks: `[--baseline f --baseline-sha256 h] [--compare-legacy --expect <PO>=<legacy settled>:<ledger settled>…]`
    `[--open "note" | --close "reason"] [--database <name>]`.
  - `--expect` names each approved legacy difference with both amounts, to the cent. An unlisted difference, a listed
    one with other amounts, a listed one that does not occur and a PO listed twice all fail; a bare PO is refused.
  - `--open` is refused unless `--baseline`, `--baseline-sha256` and `--compare-legacy` are given and every check passes.
    The checks and the switch to live run in one repeatable-read transaction that first locks the legacy tables, the
    journal and the holds against writes (SHARE, 10 s lock timeout), so nothing can change between them.
  - The checks include the exclusion list (every DEFAULT_HOLDS entry must name a supplier and be held) and "no supplier
    deposit exists" (D8: they are never posted, so any one needs an owner decision).
- **Backfill `--apply`** is refused while any hold on the list names no supplier, any excluded receipt is unresolved,
  or any legacy record differs from the approved baseline.
- **If reconciliation reports order drift or any baseline change** (for example an old-backend edit between the
  migration and the new backend): stop, keep the guard in maintenance and data entry paused, and report to the owner.
  The cutover continues only after a new rehearsal and a new approved baseline. The rollback check refuses too (its
  item 4/5), so a rollback then also needs the owner's decision on that change.
- **`scripts/ledger-rollback-check.ts`.** `--baseline f --baseline-sha256 h`. Runs the pre-rollback checklist: exit 0
  only while the ledger is in maintenance, nothing was written through the new backend (no `app` entry, no orderless,
  voided or keyed payment) and every legacy record still matches the approved baseline.
- **`scripts/rollback/0017-down.sql`.** The rehearsed down migration, run with psql.
  - It sets `ON_ERROR_STOP` itself: a refusal or any error exits non-zero (3) with nothing changed.
  - It locks `ledger_state`, the holds, the journal and `payments` before its guard reads them (lock timeout 10 s).
  - It refuses while `ledger_state` is not `maintenance`, and once the application has written (an `app` entry, an
    orderless, voided or keyed payment).

## Owner decisions on the pre-release audit (2026-11-21)

- **M7. Negative adjustments and voids** (rules confirmed 2026-11-21): "Negative adjustments" in the FIFO projection
  above: eligible credits only, the take worked out as recorded, no credit taken twice, shortfalls payable from their
  date and settled oldest obligation first with the orders, voids recalculated the same way. Tests:
  `src/modules/ledger/lifo.test.ts` (unit tests, and "negative adjustments through the API": the owner's example,
  retries, a repeated void, a credit recorded later, and each currency apart) and `src/modules/ledger/ledger.test.ts`.
- **M8. Final settlements are kept** (approved by the owner on 2026-11-21: the ORD-3 and ORD-5 order-date checks,
  and the LED-3 adjustment check). FIFO settles by `order_date`, so an order created with a past
  date, or moved by an ORD-5 date change, could take money that settles later orders, including orders closed with a
  final landed cost (`costs/landed-cost.ts`: fully settled, cleared, unloaded and stocked). ORD-3 and an ORD-5 date
  change now project the account before and after the write in its transaction, with the account locked
  (`guardFinalSettlements`), and refuse it (422 `orderDate`, nothing written) when any order whose landed cost was
  final would be settled by other credits or other amounts. ORD-5 judges the date move only: with lines in the same
  request, the check runs after the value change is posted. ORD-3 skips the check when no stage-6 order of the account
  is dated after the new one (only those are settled after it, and only stage 6 can be final). Other date changes and
  new orders re-settle by FIFO as before. Every new LED-3 adjustment (either sign, any date) runs the same check and is
  refused (422 `entryDate`, nothing written) when it would change a final order's settlement; a backdated one may
  still change later-dated orders that are not final (owner decision 2026-11-21). Remaining limitations (not covered
  by these checks; known to the owner at the approval):
  - an ORD-5 value increase or an ORD-6 delete of an earlier open order, a void, or a payment recorded with a past
    date (PAY-2) can still move a final order's settlement. A void removes its payment and every adjustment is
    recalculated without it, which can re-price or reopen orders, final ones included;
  - "final" is read from the clearing, transport and warehouse rows without locking them: a write that makes an order
    final while an ORD-3, ORD-5 or LED-3 is between its two projections is not seen by that check (a narrow window);
  - an order may be dated in the future (ORD-3 has no upper bound). A final order dated after today, settled by
    credits dated before it, makes every negative LED-3 adjustment that would take those credits refused, whatever
    its date (an adjustment can't be dated after today), until that order's date is corrected;
  - a held account's orders are never final while held, so ORD-5 date changes on them are not checked; once a hold
    is released, their dates decide FIFO with the rest.
  Tests: `src/modules/ledger/ledger-flows.test.ts` ("final settlements are kept").
