# Supplier currency and exchange rate (migration 0012)

Every supplier has **one** transaction currency (`suppliers.currency`: CNY, USD or INR, the existing list) and an
**exchange rate** to the company's base currency: `suppliers.exchange_rate` is INR per 1 unit of that currency
(1 CNY = ₹12.50 is stored as `12.5`; `numeric(12,4)`, above 0). INR is the base currency, so an INR supplier's rate is
always 1. `suppliers.rate_updated_at` is when the currency or rate was last set through the API.

The rate is **not invented**: suppliers from before 0012 keep `exchange_rate` null ("not set yet") until someone edits
them, except INR suppliers, which the migration backfills with 1. Existing orders, payments and deposits are never
touched by the migration.

## Rules

| Where | Rule |
| --- | --- |
| `POST /suppliers` | `currency` (CNY when left out) and `exchangeRate` (optional; above 0, at most 4 decimals). INR: the rate is set to 1 when left out, anything else is 422 `exchangeRate`. Another currency without a rate stores null. |
| `PATCH /suppliers/:id` | A new `currency` needs its own `exchangeRate` in the same request (422 `exchangeRate` otherwise: a yuan rate means nothing for dollars). INR forces 1. A changed value sets `rateUpdatedAt`; the same values leave it alone. Saved orders and deposits keep their own snapshots. |
| `GET /suppliers` rows | `exchangeRate`, `rateUpdatedAt` (ISO, null while never set) and `hasTransactions` (any order or supplier deposit: the UI then warns that a change applies to new transactions only). |
| `POST /orders` (ORD-3) | The order is in the supplier's currency: `currency` left out is filled in; another one is 422 `currency` ("This supplier's orders are in CNY."). The supplier's rate now is snapshotted as `orders.exchange_rate` (1 for INR; null while the supplier has none). The deposits' `rateInr` rule is checked for that currency. |
| `GET /orders`, `GET /orders/:po`, reports | `exchangeRate`: the order's snapshot, never the supplier's current rate. `GET /orders/options` suppliers and `GET /payments` orders (`supplierRate`) carry the supplier's rate **now**, the default for a new payment. |
| `POST /suppliers/:id/deposits` (SD-2) | The deposit is in the supplier's currency (another is 422 `currency`); `supplier_deposits.exchange_rate` snapshots the supplier's rate now. Rows give `exchangeRate`. |
| `POST /payments` (PAY-2) | Unchanged: the amount is in the order's currency and `rateInr` is the rate of that payment (typed; the frontend offers the supplier's rate now as the default). INR orders take no rate. |
| RPT-O1 `GET /orders/:po/report` | `order.exchangeRate` and `order.orderValueInr` = orderValueCny × exchangeRate rounded to 2 decimals in SQL (as every INR figure is) at the **PO's** rate (null without one); `order.supplier.exchangeRate` / `rateUpdatedAt` are the supplier's now. `supplierAccount.deposits.list[].exchangeRate` is each deposit's snapshot. |
| RPT-O2 `GET /reports/orders` | Rows carry `exchangeRate` and `orderValueInr` the same way. `paidInr` stays the sum of each payment at its own rate. |
| RPT-5D supplier detail | `supplier.exchangeRate`, `supplier.rateUpdatedAt`. |

## What never changes

- A saved order's `exchange_rate`, a payment's `rate_inr`, a deposit's `exchange_rate`: snapshots, read only.
- Landed cost: goods in INR are still the paid supplier payments at their own payment-day rates (`costs/landed-cost.ts`).
  The order's snapshot is for the PO value's INR equivalent on reports, not for costing.
- Supplier balances stay per currency (`byCurrency` lists); a supplier whose currency changed keeps its older orders in
  their currency, so a balance may list two currencies, never added together.
- Shipping-agent payments, clearing and transport costs: their own rules (agent payments are in the order's currency with
  a typed rate; stage costs are INR).

## Checks (0012)

`suppliers_exchange_rate_check` (null or > 0), `suppliers_inr_rate_check` (`currency <> 'INR' or exchange_rate = 1`),
`orders_exchange_rate_check`, `supplier_deposits_exchange_rate_check`. Tests: `master-data/supplier-currency.test.ts`.
