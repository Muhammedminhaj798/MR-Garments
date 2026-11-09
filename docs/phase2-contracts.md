# Phase 2 contracts: order closure, pending/closed lists, deposits, supplier deposits, per-order reports, exports

Decided by the coordinator on 2026-11-09 from the inspection of both repositories (backend `feature/units-po` 539f354,
frontend `feature/units-po` b55e107, which carry Units and free-format PO numbers, migration 0007). Everything below is
built on `feature/phase-2` in both repositories. Agents read this before writing; a change to a shared contract goes
through the coordinator.

Conventions as before: dates `YYYY-MM-DD`; money `numeric(14,2)` as JSON numbers; order-currency amounts keep their
`...Cny` names and come with the order's `currency`; INR is converted per payment at its own `rateInr` and never
guessed; amounts in different currencies are never added together (`byCurrency` lists). Errors: the one body
`{ error: { code, message, fields? } }` (400 malformed, 401, 403, 404 `not_found`, 409 named codes, 422
`validation_failed` with `fields`). Permissions: `requirePermission(capability, level)` from `permissions/matrix.ts`.

## 1. Order lifecycle: pending, closed (features D and E)

The stages stay 1-6 (migration 0003 check). Nothing new is stored; both states are read live.

| State | Rule | Where |
| --- | --- | --- |
| **Pending** | `stage = 1`: no China receipt yet. REC-3 moves 1 -> 2 on the first receipt, so an order leaves Pending the moment receiving starts. | `orderPending` in `src/modules/orders/closure.ts` |
| **Closed** | `stage = 6` **and** every container carrying any of the order's goods has a **stocked** warehouse receipt. | `orderClosed`, `orderClosedOn` in `closure.ts` |

Why this closure rule and not another: stage 6 is set by WH-3 `complete: true` for every order with goods in that
container (`moveOrdersToStage`), so an order split over two containers reaches stage 6 when the first is stocked. The
landed-cost rule already in force (`costs/landed-cost.ts` `waitingFor`) treats such an order as still "waiting for
warehouse" until every carrier is stocked. Closure reuses exactly that condition. Reaching China receiving, loading,
clearing or transport never closes an order. Short receipts (received < ordered) do not block closure: the short part
was never shipped. Excess (received > ordered) is kept as received; short is `max(0, ordered - received)` everywhere.

Known limitation (existing behaviour, reported, not changed): goods received in China but not loaded before the
order's first container is cleared can no longer be loaded (CON-2 offers lines of stage 2-3 orders only). Such an order
still closes when its containers are stocked. Reopening: only WH-4 (delete a stocked receipt, Management) reopens an
order, by `settleStages`; it is logged on the server. No other reopen flow exists or is added.

Closed orders are read-only as before: ORD-5 refuses stage 6 (`order_locked`); payments may still be recorded (PAY-2 is
allowed at any stage, as before).

### 1.1 ORD-1 `GET /orders` and ORD-4 `GET /orders/:po`: new fields (done, foundation)

```
stocked: number          // main line's quantity on stocked warehouse receipts
closed: boolean
closedOn: string | null  // latest received_on of the stocked receipts holding the order's goods; null while open
```

Frontend: `OrderListItem` and `OrderDetail` carry them (`lib/api/types.ts`). Lists: **All** = every order (as today),
**Pending** = `stage === 1`, **Closed** = `closed`. Status label for a closed order: "Closed" (tone success); a stage-6
order that is not closed keeps "Received".

## 2. Migration 0008 `drizzle/0008_deposits.sql` (done, foundation; NOT applied to production)

Additive only; no existing row changes.

- `payments` + `reference text not null default ''`, `notes text not null default ''`.
- `supplier_deposits` (id, supplier_id -> suppliers (no cascade), direction `give`|`receive`, amount > 0, currency
  CNY|USD|INR, opened_on, reference, notes, created_at, updated_at, created_by). Index on supplier_id.
- `supplier_deposit_transactions` (id, deposit_id -> supplier_deposits **on delete cascade**, paid_on, amount > 0,
  mode, reference, notes, created_at, updated_at, created_by). Index on deposit_id.

Schema: `src/db/schema/deposits.ts` (`supplierDeposits`, `supplierDepositTransactions`, `DEPOSIT_DIRECTIONS`).
Settled, pending and status of a supplier deposit are **summed live** from its transactions, never stored.
Over-settlement is refused in the write transaction with the deposit row locked (`for update`).

Backward compatibility: an older frontend sends no `reference`/`notes` (both default to ""), and ignores the new
response fields. Release order stays backend first.

### 2.1 Payments: `reference` and `notes` (done, foundation)

- ORD-3 `deposits[]` and PAY-2 accept optional `reference` (trimmed, <= 100, 422 `referenceTooLong` message "Use 100
  characters or fewer for the reference.") and `notes` (trimmed, <= 1,000, "Use 1,000 characters or fewer for the
  notes."). Left out: "".
- PAY-1 `payments[]` and ORD-4 `payments[]` return `reference` and `notes`.

## 3. Deposits page and supplier deposits (features F and G) — Agent D

### 3.1 Vocabulary

- **Order deposit**: a `payments` row with `kind = 'Deposit'` (what ORD-3 and PAY-2 record). Paid (`status = 'paid'`)
  or due (`status = 'due'`; the schema allows it, no endpoint creates one today). **Pending deposits** = due ones.
  There is no "deposit required" figure on an order in this system; one is not invented (reported as a limitation).
- **Supplier deposit**: a `supplier_deposits` row. `give`: the company owes the supplier; `receive`: the supplier owes
  the company. `settled` = sum of its transactions; `pending` = amount - settled; `status` = `open` (nothing settled),
  `partly settled`, `settled` (pending = 0). The two directions are **never netted**; a supplier's summary shows six
  figures per currency (to give, given, pending to give; to receive, received, pending to receive).
- Supplier deposits are **not** order payments: order paid/balance, landed cost, Payments per supplier, the dashboard
  and the Deposits & Payments page read `payments` only and do not change. No double counting is possible because the
  two live in different tables.

### 3.2 Endpoints (backend `src/modules/deposits/`, registered in `src/modules/index.ts`)

All amounts in the deposit's currency; `amountInr` only where a rate exists.

| Id | Endpoint | Permission | Notes |
| --- | --- | --- | --- |
| DEP-1 | `GET /deposits` | `payments` View | Everything the Deposits page shows; filtering is on the client (as Orders). |
| SD-1 | `GET /suppliers/:supplierId/deposits` | `payments` View | One supplier's statement. 404 for an unknown or malformed id. |
| SD-2 | `POST /suppliers/:supplierId/deposits` | `payments` Enter | Opens a supplier deposit. 201 `{ deposit }`. |
| SD-3 | `POST /supplier-deposits/:id/transactions` | `payments` Enter | Records a payment (give) or receipt (receive). 201 `{ transaction }`. 422 on `amount` when it exceeds pending: "Only <pending> left to settle." |
| SD-4 | `DELETE /supplier-deposit-transactions/:id` | `payments` Full | 204. Log line as PAY-3. |
| SD-5 | `DELETE /supplier-deposits/:id` | `payments` Full | 204 when it has no transactions; 409 `in_use` "This deposit has N transactions, so it can't be deleted." otherwise. |

Supplier delete (`master-data/suppliers.routes.ts` `deleteRoute` uses): add `{ what: "deposit", table: supplierDeposits }`
so a supplier with deposits is refused (409 `in_use`), like one with orders.

DEP-1 response:

```ts
{
  orderDeposits: {
    id: string; orderId: string; po: string; supplierId: string; supplier: string; currency: Currency;
    amountCny: number; status: "paid" | "due"; paidOn: string | null; dueDate: string | null;
    rateInr: number | null; amountInr: number | null;   // round2(amountCny * rateInr) when paid
    mode: string | null; reference: string; notes: string;
  }[];                                                   // kind = 'Deposit' only, latest date first
  supplierDeposits: SupplierDepositRow[];                // newest first
  suppliers: { id: string; name: string }[];             // active + any with deposits, for the filter
}
type SupplierDepositRow = {
  id: string; supplierId: string; supplier: string; direction: "give" | "receive"; currency: Currency;
  amount: number; settled: number; pending: number; status: "open" | "partly settled" | "settled";
  openedOn: string; reference: string; notes: string; transactions: number;   // count
};
```

SD-1 response:

```ts
{
  supplier: { id, name, contactPerson, phone, city, currency, status };
  summary: { currency: Currency; direction: "give" | "receive"; amount: number; settled: number; pending: number }[];
  deposits: (SupplierDepositRow & { transactions: { id: string; paidOn: string; amount: number; mode: string; reference: string; notes: string }[] })[];
}
```

SD-2 body: `{ direction, amount (0.01 .. 999,999,999,999), currency? (default: the supplier's), openedOn (not after
today in India), reference? (<= 100), notes? (<= 1000) }`. SD-3 body: `{ paidOn (not after today), amount, mode (1..100),
reference?, notes? }`. Messages are proposed wording; record the final ones in section 8.

### 3.3 Frontend (Agent D)

- Nav "Deposits" -> `/deposits` (added, foundation; capability `payments`). Pages: `/deposits` (All), `/deposits/pending`,
  `/deposits/paid`, `/deposits/suppliers` (per-supplier summary table), `/deposits/suppliers/[supplierId]` (statement:
  summary cards, deposits with their transactions, "+ New deposit", "Record payment/receipt" per deposit, Delete for
  Management). RouteTabs as the calendar does. Overview cards: Total deposits, Total paid, Total pending, Count, each
  per currency (`formatMoneyList`). Filters: supplier, PO, date range, status, currency, kind (order / supplier give /
  supplier receive). Exports (Excel, PDF) of the filtered rows through `ExportActions`.
- Record payment dialog (`features/payments/record-payment-*.ts(x)`): optional Reference and Notes fields -> PAY-2.
- Settings > Suppliers: a "Deposits" row action linking to the statement.
- Types in a new `src/lib/api/deposits-types.ts`.

## 4. Per-order report and order reports (feature C, H) — Agent R

### 4.1 RPT-O1 `GET /orders/:po/report` (`ordersView` View; sections null as ORD-4 does when a capability is below View)

Sections the frontend renders and exports (one Excel sheet each): **Overview** (order, supplier, dates, stage, closed,
closedOn, currency, order value, per-unit totals of ordered/received/stocked), **Items** (per line: item, unit,
ordered, received, excess = max(0, received - ordered), short = max(0, ordered - received), loaded, stocked, rate,
value), **Payments** (`payments` View: paid to supplier, paid INR, balance, deposits paid, due; each payment with
reference/notes/amountInr), **Logistics** (`containers` View: each container carrying the order with this order's
lines; its clearing (`clearing` View) with dates and the four charges and their total; its trip (`transport` View) with
dates, vehicle, LR, freight + handling), **Warehouse** (`warehouse` View: each stocked or draft receipt holding the
order's goods: warehouse, date, received by, status, this order's pieces per team), **Landed cost** (`landedCost` View:
`loadLandedCosts` figures for the order, unchanged), **Timeline** (dated steps from the records: created, each deposit,
each receipt, loaded, sailed, arrived (clearing arrivedOn), cleared, trip loaded, unloaded, stocked, closed; only dates
that exist, never invented). Container-level clearing/transport costs are the container's totals; the order's allocated
share is the landed-cost section (no second allocation rule).

### 4.2 RPT-O2 `GET /reports/orders` (`reports` View)

Query (all optional, 400 when malformed): `po` (substring, case-insensitive), `supplierId`, `from`, `to` (order date),
`status` = `pending` | `active` | `closed`, `warehouseId` (orders with a stocked receipt at that location),
`paymentStatus` = `unpaid` | `partly` | `paid` (supplier payments against order value). Rows: the ORD-1 figures plus
`closed`, `closedOn`, `stocked`, `balanceCny`, `paymentStatus`, `landedCostInr | null`, `perPieceInr | null`;
`summary` (orders, byCurrency order value/paid/balance, paidInr, landedCostInr); `filter` echo; `options`
(suppliers, warehouses). Frontend: `/reports/orders` (hub card "Order reports"), filters in the URL, per-row
"Report" link to `/orders/[po]/report`, Excel/PDF of the filtered list (multiple-order report) with a summary table.

### 4.3 Frontend order report page

`/orders/[po]/report`: a new order-detail tab "Report" (`order-detail-frame.tsx` TABS) rendering every section the user
may see, with "Export Excel" (sheets: Order Summary, Items, Payments, Logistics, Warehouse, Landed Cost, Timeline) and
"Export PDF". Types in `lib/api/reports-types.ts`.

## 5. Orders tabs (feature D) — Agent O (frontend only)

`/orders` keeps today's list, chips and counts. New `/orders/pending` and `/orders/closed` share a RouteTabs bar
(All orders · Pending · Closed) rendered by the orders screen. Pending columns: PO, Supplier, Order date, Expected
delivery, Ordered qty, Pending qty (= ordered - received, never below 0), Order value, Deposit/payment status
(paid/partly/unpaid from paidCny vs orderValueCny), Current stage. Closed columns: PO, Supplier, Order value, Ordered
qty, Warehouse received qty (`stocked`), Total payments (paidCny), Balance, Closed date. Both searchable (PO, item,
supplier), filter by supplier and date range; Closed rows link to the order (its tabs give receiving and payment
history) and to `/orders/<po>/report`. Excel/PDF of the current filtered rows on all three tabs. `order-status.ts`:
closed -> "Closed".

## 6. Exports (feature H) — shared, foundation

`features/reports/report-files.ts`: `ReportFile { title, filename, filters, sections }`, `Section { title?, sheet?,
columns, rows, total? }`, `downloadReport(file, "xlsx" | "pdf" | "csv")`, `ExportActions({ file | () => file, formats?,
size? })`. Excel: one worksheet per `sheet`, title block on each, bold headings, number/date formats, column widths,
filter arrows on the first table of each sheet. PDF: A4 landscape, title/filters/generated line, headings, header row
repeated per page, page numbers. Build the `ReportFile` from the rows the page shows after its filters, so totals match
the screen and the page's permission guards the export. No new dependency.

## 7. Files and owners

| Owner | Backend | Frontend |
| --- | --- | --- |
| Coordinator (frozen) | schema, migrations, `orders.routes.ts`, `order-detail.routes.ts`, `payments.routes.ts`, `closure.ts`, harness, `index.ts` registration lines for R | `lib/api/types.ts`, `config/navigation.ts`, `features/reports/{report-files,xlsx,pdf,csv}.ts`, `report-actions.tsx`, `types/domain.ts` |
| Agent O | — | `features/orders/**`, `app/(app)/orders/page.tsx`, `app/(app)/orders/{pending,closed}/**` |
| Agent R | `modules/reports/**` (new files + `reports.routes.ts`) | `features/reports/**` (new files, `reports-hub.tsx`), `app/(app)/reports/orders/**`, `app/(app)/orders/[po]/report/**`, `features/order-detail/shared/order-detail-frame.tsx`, `lib/api/reports-types.ts` |
| Agent D | `modules/deposits/**`, `modules/index.ts` (register), `master-data/suppliers.routes.ts` (deleteRoute uses) | `features/deposits/**`, `app/(app)/deposits/**`, `features/payments/record-payment-*`, `features/settings/suppliers-screen.tsx`, `lib/api/deposits-types.ts` |

A need to change a frozen file is reported to the coordinator in the agent's final report, with the exact change.

## 8. Response shapes recorded by the owners

(Agents append the final shapes and messages of their endpoints here.)

### 8.D Deposits (Agent D, `src/modules/deposits/deposits.routes.ts`)

Final shapes are as section 3.2 gives them, with these details:

- **DEP-1** `GET /deposits` -> `{ orderDeposits, supplierDeposits, suppliers }`. `orderDeposits`: `payments` rows of kind
  Deposit, latest `coalesce(paidOn, dueDate)` first (then creation, then id), each with `supplierId` and `supplier` (the
  order's supplier), `payee` and `payeeRole` (`"supplier" | "agent"`: who was actually paid, as ORD-3 records it), and
  `amountInr = round(amountCny * rateInr, 2)` when paid, else null. `supplierDeposits`: newest first (`openedOn`, then
  creation). `suppliers`: active ones plus any inactive one with an order deposit or a supplier deposit, by name.
- **`SupplierDepositRow`**: `settled` = sum of the deposit's transactions (SQL `coalesce(sum(amount), 0)`), `pending` =
  `round2(amount - settled)`, `status` = `open` when settled is 0, `settled` when pending is 0, else `partly settled`;
  `transactions` is the count. Amounts are in the deposit's `currency`; nothing is converted to INR (no rate exists).
- **SD-1** `GET /suppliers/:supplierId/deposits` -> `{ supplier, summary, deposits }`. `summary`: one line per
  (currency, direction) that has a deposit, CNY/USD/INR then give/receive, each `{ currency, direction, amount, settled,
  pending }`; give and receive are never netted (a supplier with both gets two lines). `deposits[].transactions`: newest
  first (`paidOn`, then creation), each `{ id, paidOn, amount, mode, reference, notes }`. 404 `not_found` "Supplier not
  found." for an unknown or malformed id.
- **SD-2** `POST /suppliers/:supplierId/deposits`: body `{ direction, amount, currency?, openedOn, reference?, notes? }`,
  201 `{ deposit: SupplierDepositRow }`. Any known supplier, active or not (a deposit to get back from a supplier no longer
  used is still a record); unknown or malformed supplier: 404 "Supplier not found." (a path id, as PATCH /suppliers/:id).
  `currency` left out: the supplier's. Runs in one transaction with the supplier row share-locked, so a concurrent
  supplier delete waits and then counts the deposit.
- **SD-3** `POST /supplier-deposits/:id/transactions`: body `{ paidOn, amount, mode, reference?, notes? }`, 201
  `{ transaction: { id, paidOn, amount, mode, reference, notes }, deposit: SupplierDepositRow }` (the refreshed figures).
  The deposit row is locked `for update` for the check and the insert. 404 "Deposit not found."
- **SD-4** `DELETE /supplier-deposit-transactions/:id`: 204; 404 "Transaction not found." The deposit row is locked first,
  so a settlement and a delete on the same deposit serialise. Log line as PAY-3's.
- **SD-5** `DELETE /supplier-deposits/:id`: 204 when it has no transactions; 409 `in_use` "This deposit has N
  transaction(s), so it can't be deleted."; 404 "Deposit not found."
- Supplier delete: `{ what: "deposit", table: supplierDeposits }` added to the `deleteRoute` uses, so "This supplier is
  used by 1 order and 1 deposit, so it can't be deleted. Deactivate it instead."

Messages (`MESSAGES` in deposits.routes.ts; 422 `validation_failed` under the field, every problem at once):

| Field | Message |
| --- | --- |
| direction | Choose Give or Receive. |
| amount (0.01 .. 999,999,999,999, 2 decimals) | Enter an amount above 0. |
| amount (SD-3, more than pending) | Only ¥1,234.50 left to settle. (pending in the deposit's currency: ¥, $ or ₹, Indian grouping, 2 decimals unless whole) |
| currency | Choose CNY, USD or INR. |
| openedOn (missing or malformed) | Enter the date the deposit was agreed. |
| paidOn (missing or malformed) | Enter the date of the payment or receipt. |
| openedOn / paidOn after today in India | The date can't be in the future. |
| mode | Enter the payment mode. / Use 100 characters or fewer for the mode. |
| reference (<= 100) | Use 100 characters or fewer for the reference. |
| notes (<= 1,000) | Use 1,000 characters or fewer for the notes. |
