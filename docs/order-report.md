# Comprehensive order report (2026-11-10)

Reports › Order Report now gives management the whole of one purchase order on one page: the order, the supplier's
profile and account, every item, China receiving, shipping, customs, transport and warehouse, the payment ledger,
supplier deposits, the landed cost breakdown and a timeline with who recorded what and when. Everything is read from
the existing records; nothing is stored, estimated or converted. The additions below are **additive**: RPT-O1 and
RPT-O2 keep every field they had (docs/phase2-contracts.md section 4 and 8.R), so older frontends keep working.

## Money rules (unchanged, now spelt out on the page)

- **Item amounts** are `quantity × rate_cny` of the PO line, the rate saved when the order was placed. Editing the
  master item price (docs/item-price.md) never changes them.
- **Paid, balance, deposits paid, due** count payments to the supplier only (`orders/money.ts`). Payments to shipping
  agents are sea freight: reported apart (`agentPaidCny`, `agentPaidInr`) and in the landed cost, never in the
  supplier's paid or balance.
- **Supplier deposits** (migration 0008) are account-level money with no link to any order. The report lists the
  supplier's deposits and their transactions beside the order, under the supplier's account, and never counts them as
  order payments. "Deposit utilised for this PO" therefore cannot be derived from the records; the order's own
  "Deposit" payments (kind Deposit) are the PO-level deposits.
- **Landed cost** is `loadLandedCosts`, unchanged: supplier payments in INR at each payment's own rate, sea freight
  (agent payments, 0 when every carrier is CNF), the allocated share of each carrier's clearing and trip costs, over the
  stocked pieces. An order with any missing part is an estimate (`final: false`, `waitingFor`), never shown as final.
- Amounts in different currencies are never added; the supplier's account totals are one entry per currency.

## RPT-O1 `GET /orders/:po/report` additions

- `order`: `supplier` carries the whole profile (`code, contactPerson, phone, email, country, city, state, postalCode,
  address, paymentTerms, taxNumber, notes, currency, status`); `createdAt`, `updatedAt` (ISO timestamps), `createdBy`
  (user name or null), `products` (distinct lines); `totals[].pending` = max(0, ordered − received) per unit.
- `lines[]`: `itemId`, `pending`. There is no item code, description or per-line note in the data model (items have a
  name, a unit and a default price): the page shows a dash for them.
- `payments`: `agentPaidCny`, `agentPaidInr`; each payment carries `recordedAt` and `recordedBy` (null when unknown).
- `supplierAccount` (`payments` View, else null): `{ orders, openOrders, purchaseValue, paid, balance:
  { currency, amount }[], deposits: { summary (as GET /deposits summarises: currency, direction, amount, settled,
  pending), list: { id, direction, currency, amount, settled, pending, status, openedOn, reference, notes,
  transactions: { id, paidOn, amount, mode, reference, notes }[] }[] } }` — every order of the supplier, not this one.
- `receipts` (`receiving` View, else null): each China receipt `{ id, receivedOn, office, receivedBy, bundles,
  deliveryNote, shortRemark, recordedAt, lines: { item, unit, quantity }[] }`, oldest first.
- `logistics[]`: `etaEstimated`, `recordedAt`, `recordedBy`; `clearing` adds `goodsValueInr` (information only, not a
  cost), `recordedAt/By`, `updatedAt/By`; `transport` adds `driverPhone, loadedFrom, loadedBy, receivedBy,
  shortRemark, recordedAt/By, updatedAt/By`.
- `warehouse[]`: `recordedAt/By`, `updatedAt/By`.
- A container's `clearing` / `transport` is `null` both when none is recorded and when the user's access to that
  stage is below View; with today's matrix every role that may view containers may view both stages, so the page
  reads the null as "none recorded".
- `timeline[]`: `at` (when the record was written: its creation, or its last change for cleared / unloaded / stocked)
  and `by` (the user who wrote it), null where the record keeps neither (a container's sailing date, the derived
  closure).

## RPT-O2 `GET /reports/orders` additions

- Query: `supplier` (a case-insensitive part of the name), `stage` (1–6, the shipment status: 3 in a container, 4 in
  clearing, 5 on the road, 6 in the warehouse), `currency` (CNY, USD, INR). Malformed values are 400 as before.
- Rows: `supplier.code`, `lineCount`, `quantities: { unit, quantity }[]` (ordered quantity per unit over every line).
- Filter echo: `supplierName`, `stage`, `currency`.

## Frontend

- `/reports/orders`: the filters above (PO, supplier name, supplier, order dates, status, stage, currency, warehouse,
  payment status), the columns PO, order date, supplier (name and code), items, total quantity, currency, PO value,
  paid, balance, stage, status and "Detailed report"; Excel, PDF and CSV of the list.
- `/reports/orders/[po]`: the comprehensive report with a section navigation (Overview, Supplier, Items, China
  processing, Shipping, Customs, Warehouse, Payments, Deposits, Landed cost, Timeline, Documents), breadcrumb Reports
  › Order Report › PO, "Back to Order Reports", and Excel (one sheet per section), PDF (every section, page numbers)
  and CSV. The order's Report tab (`/orders/[po]/report`) renders the same report inside the order's frame. The
  Landed cost section lists the engine's figures as components with their standing: recorded, partly paid (the goods
  while a balance is outstanding), missing (clearing or transport not yet allocated), not applicable (sea freight on
  CNF terms) or not recorded in this system; the "Deposits paid on this PO" and "Sea freight paid" tables hold paid
  rows only, due rows stay in the ledger.

## Not in the records (shown as such, never invented)

- Documents and attachments: nothing stores files. The Documents section says so.
- Item code, item description, per-line notes; supplier confirmation and production status; container type, booking
  date, insurance and shipping charges other than agent payments; GST on clearings (customs duty, other duties, agent
  and port charges are the recorded charges); payment refunds, reversals and credits (payments are paid or due);
  deposit allocation to an order.
- The China receipt's user is the recorded receiver; order creation, payments and containers keep their author only
  when the record was written with one (older rows have none).

Tests: `reports/order-reports.test.ts` (a closed multi-item order with partial payments, a split order with an
uncleared second container, a pending unpaid order, an order with no cost, a USD order with two receipts and two
deposits, a supplier-level deposit; sections per role; every filter). No migration.
