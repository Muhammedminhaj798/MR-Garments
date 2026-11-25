# Supplier Full History (Supplier 360°), 2026-11-25

Owner approval of 2026-11-25 (phase 2 of the plan "Supplier Full History"). Read-only: no endpoint writes. One
schema-only migration, 0020 (approved separately on 2026-11-25): indexes on `receipt_lines(order_line_id)` and
`warehouse_receipt_lines(order_line_id)`.
Management only in the first release (`reports` View). Code: `src/modules/supplier-history/`.

## Rules

- Every figure comes from the existing calculations: `loadLedger` (live accounts, FIFO settlement), `buildOrderReports`
  / `supplierOrders` (order value = received × rate, PO value, Dollar Cost from the saved rates, landed-cost parts from
  `loadLandedCosts`), `paymentQuery`. No new formula.
- Live vs history: `accounts` is the ledger now; `totals` are historical sums per currency, never added across
  currencies. A held account's (D4) figures are null and count in no total.
- Payments: "active" = the ledger's payment credits less their voids. A voided payment stays listed (who, when, reason)
  and counts in no total. Agent (sea-freight) payments are never supplier payments.
- `settlesNow`: which orders a credit settles in the live FIFO projection. Derived now, not a stored allocation.
- Never reconstructed: deleted receipts, edits of orders, lines, suppliers and stage records, earlier rates and
  statuses. An event carries only what its source row holds. `actor: null` = not recorded; `origin: "migrated"` = a
  posting written by the 2026-11-23 cutover (its `date` is the original business date, its `recordedAt` the cutover).
- Value changes are typed only by the note prefixes the application writes ("Rate correction:", "Revaluation to
  received quantity"); everything else is "Order value change".

## Endpoints (GET, reports View; malformed query 400; unknown supplier 404)

| Id | Path | Query | Response |
| --- | --- | --- | --- |
| SH-0 | `/suppliers/:id/history/header` | — | `supplier`, `accounts` (live), `holds`: SH-1 without its totals, for every tab's header (so a tab never builds the order report twice) |
| SH-1 | `/suppliers/:id/history` | — | `supplier`, `accounts` (live), `holds`, `totals[]` per currency (`orders, poValue, orderValue, settled, outstanding, paymentsActive, paymentsRecorded, paymentsVoided, adjustments`), `dollarCost`, `landedCostInr`, `activity { first, last }`, `counts` |
| SH-2 | `/suppliers/:id/history/orders` | `from, to, q (PO), status (pending/active/closed), page, all` | `orders` (page of RPT-S1 rows + `protectedAt`), `byCurrency`, `dollarCost` |
| SH-3 | `/suppliers/:id/history/payments` | `from, to, q, status (active/voided), page, all` | `payments` (PaymentRow + `source` payment/advance, `recordedBy`, `migrated`, `ledgerCredit`, `ledgerVoid`, `settlesNow[]`), `totals[]` |
| SH-4 | `/suppliers/:id/history/receipts` | `from, to, q, page, all` | `receipts` (with `lines[]`: item, unit, quantity, `containers[]`, `warehouse[]`) |
| SH-5 | `/suppliers/:id/history/landed-cost` | `from, to, q, status (final/estimate/none), page, all` | `orders` (landedCost parts, `protectedAt`, `containers[]` with their clearing and transport records, `agentPayments[]`), `landedCostInr`, `agentPayments` counts |
| SH-6 | `/suppliers/:id/history/events` | `from, to, q, types (comma list), status (active/voided/held/migrated), page, all` | `events` page, `byType` counts |
| RPT-SH | `/reports/supplier-history` | SH-6's + `supplierId` (optional: every supplier) | SH-6's + `filter` echo, `options { suppliers, types, statuses }` |

Pages hold 25 rows; `all=1` returns every row (the downloads). Events: latest first (business date, then recorded,
then id). Event types: supplier_created, order_placed, order_value_posted, order_value_changed, order_cancelled,
receipt_recorded, payment_recorded, payment_voided, management_adjustment, agent_payment, agent_payment_voided,
container_loaded, clearing_recorded, transport_recorded, warehouse_stocked, landed_cost_final, account_held.

Legacy supplier advances and deposits are shown from their existing archive endpoints (ADV-1, SD-1).

## Limits

- The timeline is built per request from about a dozen set-based queries and filtered in memory; for one supplier this
  is a few hundred rows. A very large all-supplier history would need a SQL union with paging (and an index on
  `orders.supplier_id`), which needs a migration and a separate approval.
- Migration 0020: the order reports (behind SH-1, SH-2, SH-5, RPT-5D, RPT-S1 and the Order Report) sum received and
  stocked quantities per order line, and both lines tables' primary keys lead with `receipt_id`. Measured on a local
  copy with a 600-order synthetic supplier (mains power, p50): Orders tab 710 → 187 ms, Landed cost 729 → 189 ms,
  SH-1 512 → 165 ms, Supplier Order Details (all) 777 → 216 ms, Order reports list 529 → 166 ms.
