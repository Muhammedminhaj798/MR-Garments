# Phase 2 fixes: what the production-readiness audit asked for

Remediation of the audit findings (2026-11-09), built on `feature/phase-2` as `fix/phase2-audit` in both repositories.
Scope is the audit's list; nothing else was redesigned. Migration **0009** is required (section 5) and has not been
applied anywhere but the local test databases.

## 1. Supplier balance: one calculation everywhere (audit H1, M3, M9, L6)

`src/modules/orders/money.ts` is now the only place the payee rules live. `orderMoney` gives, per order:
`orderValueCny`, `paidCny`/`paidInr` (every paid payment, agents included: what left the company), `supplierPaidCny`/
`supplierPaidInr` (paid to the supplier only), `depositPaidCny` (paid supplier deposits) and `nextDue`. `supplierMoney`
(13.5's names) is the supplier-only subset and is what the reports, the supplier detail and the warehouse outstanding
already used; it is re-exported from `reports.ts` for them.

Changed figures:

| Endpoint | Field | Before | Now |
| --- | --- | --- | --- |
| ORD-4 `GET /orders/:po` | `balanceCny` | order value - every payee | order value - `supplierPaidCny` |
| PAY-1 `GET /payments` orders | `balanceCny` | every payee | supplier only; `supplierPaidCny`, `supplierPaidInr` added |
| ORD-1, ORD-4, PAY-1 | `supplierPaidInr` | - | added |
| ORD-4 payments rows | `amountInr` | computed in the browser | from SQL, `round(amount * rate, 2)`, null while due |
| ORD-5 | "total can't be less than already paid" guard | every payee | supplier only (an agent's freight is not order value) |
| REC-2 `/receipts/options` | `depositsPaidCny` | every payee | supplier only, as the order report's "Of which deposits" |

Unchanged: `paidCny`, `paidInr` (all payees) on ORD-1/ORD-4/PAY-1, the Orders list's "Paid so far (INR)", landed cost
(goods = supplier payments, sea freight = agent payments), RPT-O1, RPT-O2, 13.5 and the supplier detail (already
supplier-only). Agent payments stay recorded and listed on every payments screen; only their labelling changes.

## 2. Deposit required per order (audit H2, "Pending deposits")

A new nullable column `orders.deposit_required_cny` (numeric(14,2), > 0 or null) holds the deposit the supplier asked
for, in the order's currency. Nothing is stored for the pending part:

- `depositPaidCny` = paid payments of kind Deposit to the supplier (agent deposits never count).
- `depositPendingCny` = max(0, required - paid), null without a requirement; never negative, an overpayment stays "paid".
- `depositStatus` = `none` (no requirement) | `due` (nothing paid) | `partly` | `paid`. `depositState()` in `money.ts`
  is the one derivation, used by ORD-1, ORD-4, PAY-1, DEP-1 and RPT-O1.

Writes: ORD-3 takes an optional `depositRequiredCny`; ORD-5 takes `depositRequiredCny` (number, or null to clear) at
stages 1-5 like the delivery date (ordersEdit Enter; a received order's money term may still change; stage 6 is
refused as before). Reads: ORD-1/ORD-4/PAY-1 return `depositRequiredCny`, `depositPaidCny`, `depositPendingCny`,
`depositStatus`; RPT-O1 `payments` returns `depositRequiredCny`, `depositPendingCny`, `depositStatus`; DEP-1 returns
`orderObligations` (one row per order with a requirement: `requiredCny`, `paidCny`, `pendingCny`, `status`,
`lastPaidOn`, `payments`).

Frontend: New order and Edit order take the amount; the order's Payments tab shows required / paid / pending with a
status pill; the Deposits page lists one obligation row per order with a requirement (its deposit payments stay on the
order page, so nothing is counted twice), keeps the individual payments only for orders without a requirement, and the
Pending tab shows obligations with something pending next to pending supplier deposits.

Historical orders have no requirement (`null`, status `none`) and are not shown as pending. Supplier-level deposits are
untouched and still never enter order money.

## 3. Closure needs the order's own pieces (audit H3)

Two guards:

- WH-3 refuses to complete a receipt (422 on `lines`, "<PO>: give at least one of its pieces to a team before
  completing, or save a draft.") when any order whose goods are in the container received zero pieces. A draft may
  still be saved with any split.
- `orderClosed` additionally requires at least one of the order's own pieces on a stocked receipt, so data written
  outside WH-3 can never close an order on another order's pieces.

The multi-container rule (every carrier stocked) is unchanged; received quantities are never capped; short stays
max(0, ...). A stage-6 order with zero own pieces now reads "Received", not "Closed", and stays out of the Closed tab,
Payments per supplier's finished list and the landed-cost "finished" months.

## 4. Medium findings

- Payments per supplier (13.5) "open" = not closed and "finished" = closed; the supplier detail's `openOrders` and the
  order-status report's finished figures follow the same rule (`orderClosed`, joined so drizzle keeps the columns
  qualified).
- Orders list chip "Completed" now means closed and reads "Closed".
- WH-4 (delete a warehouse receipt, Management only) writes a `warehouse-receipt-deleted` notification inside its
  transaction to everyone with warehouse access: container, trip, receipt status and the orders that stepped back. The
  receipt deletion rules are unchanged; this is the audit trail the audit asked for. No separate reopen endpoint: the
  receipt is the closing fact and deleting it is the honest reversal.

## 5. Migration 0009 `drizzle/0009_phase2_fixes.sql`

Additive and safe to apply before the backend deploys:

- `orders` + `deposit_required_cny numeric(14,2) null` with check `is null or > 0`.
- `notifications_kind_check` widened with `warehouse-receipt-deleted` (drop and re-add the check; existing rows pass).

Old backend on the new schema: unaffected (it never reads the column; the wider check accepts its kinds). New backend on
the old schema: ORD-1/ORD-4/PAY-1/ORD-3/DEP-1 500 on the missing column, so **apply 0007, 0008 and 0009 before
deploying**, in one `db:migrate` run (one transaction). Rollback before the backend deploys: drop the column and its
check, restore the previous `notifications_kind_check`; after the backend is in use, roll back code only (the column
holds user-entered requirements).

## 6. Delivery (2026-11-09)

Branches `fix/phase2-audit`, local only, on top of `feature/phase-2` (backend c84656d, frontend 66ffca7). Nothing was
pushed, merged, deployed or migrated outside the local test databases.

| Repo | Commits | Files |
| --- | --- | --- |
| Backend (`MR-Garments-Backend-New-wt/p2-fix`) | bcd7e05 fixes, aa2128d cross-tab test, plus this document's commit | 25 files, +3,520 / -86 (2,936 of the additions are the generated drizzle snapshot) |
| Frontend (`MR-Garments-frontend-wt/p2-fix`) | 6de2750 fixes, 7375135 e2e spec updates | 52 files, +1,000 / -212 |

Checks run on the remediation branches:

| Check | Result |
| --- | --- |
| Backend lint, typecheck | clean |
| Backend `npx vitest run` | 49 files, 944 passed, 2 expected fail (939 before; new: money.test.ts 4, closure.test.ts +1; 2 cross-tab assertions moved to supplier-only) |
| Frontend lint, typecheck | 0 errors (1 pre-existing warning) |
| Frontend `npx vitest run` | 108 files, 786 passed (765 before) |
| Frontend `next build` | compiled |
| Playwright, 17 specs covering payments, orders, order detail, deposits, reports, warehouse, notifications, units/PO | 74 tests: 66 passed on the first run, the 8 failures were legacy specs asserting the old labels and all-payee figures; after updating them those 5 specs pass 30 of 30. The full 234-test suite was not re-run in this phase. |

Reconciliation of one sample order (money.test.ts): order ¥1,000, supplier deposit ¥300 at 12, agent deposit ¥100 at
12, supplier balance ¥200 at 12.5, deposit required ¥1,000. Every endpoint agrees: paid to supplier ¥500 / ₹6,100,
every payee ¥600 / ₹7,300, balance to supplier ¥500, deposit pending ¥700 (partly), landed cost goods ₹6,100 and sea
freight ₹1,200 — on ORD-1, ORD-4, PAY-1, RPT-O1, RPT-O2, Payments per supplier and REC-2.

Not done, by decision: a separate "reopen order" endpoint (the audited WH-4 deletion with its new notification is the
reversal); a per-order deposit due date; the "Pending to pay" card still says "due order deposits and deposits to give".
