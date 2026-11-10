# Suppliers page (2026-11-10)

The sidebar's **Suppliers** page (Management › Landed Cost › **Suppliers** › Reports) manages the suppliers the
Settings tab already holds, with a profile per supplier, five KPI cards and two dashboards. Nothing new is stored
about orders or payments: every figure is read from `orders`, `order_lines`, `receipts`, `containers` and `payments`
with the money rules of `orders/money.ts` (supplier payments only; one total per order currency, never added across
currencies). Management only (`admin` Full), as the Settings tab is.

## Supplier profile (migration 0011 `suppliers_profile`)

`suppliers` gains text columns, all `not null default ''`: `code`, `email`, `country`, `state`, `postal_code`,
`payment_terms`, `tax_number`. A unique index on `upper(code)` (where `code <> ''`) makes the code unique in any
letter case. The migration backfills a code for every existing supplier, `SUP-001`, `SUP-002`, … in creation order
(the order the lists show), so every supplier has one from the first page load. Nothing else changes; every order,
payment and deposit keeps its supplier.

Deploy order: 0011, then the backend, then the frontend. The new backend selects the new columns, so on the old
schema MD-1, ORD-2 options stay fine but MD-1 and RPT-5D fail until the migration runs. The old backend runs unchanged
on the new schema (the columns default). Rollback after the backend is live: redeploy the old backend and leave 0011
in place.

## Contract

**MD-1 `GET /suppliers?search=&status=`** rows: `{ id, code, name, contactPerson, phone, email, country, city, state,
postalCode, address, paymentTerms, taxNumber, notes, currency, openOrders, openPos, ytdValue, balance, status }`.
`search` matches name, code, country, contact person and phone (contains, ignoring case and spaces).

- `openOrders`: the supplier's orders with `stage < 6`, as before (the Settings tab's "Open orders").
- `openPos`: the supplier's orders not closed (phase 2 §1): the Suppliers list's "Active POs", the same rule as the
  Open POs card (SUP-1). It differs from `openOrders` only for a stage-6 order whose goods are not all stocked yet.
- `ytdValue`: `{ currency, amount }[]`, the order value of the supplier's orders dated from 1 January of this year
  (India), one entry per order currency present (CNY, USD, INR order). `[]` without such orders.
- `balance`: `{ currency, amount }[]`, order value less payments paid to the supplier over **every** order, finished
  ones too (the supplier detail's "Balance to pay"). `[]` without orders; an entry may be 0 or negative (overpaid).

**MD-2 `POST /suppliers`** body: `{ name*, code?, country, city, state, postalCode, contactPerson, phone, email, address,
paymentTerms, taxNumber, notes, currency? }`. 201 `{ supplier }` (an MD-1 row).

- `code`: trimmed and upper-cased; up to 20 letters, digits or dashes, starting with a letter or digit, else 422
  "Use up to 20 letters, digits or dashes." Left out, the next `SUP-nnn` is assigned (the highest `SUP-<number>` plus
  one, at least three digits), under a transaction lock so two creates never draw the same number. A code another
  supplier has, in any letter case, is 409 `code_exists` with `fields.code` "A supplier with this code already exists."
- `email`: "" or an address of the shape `name@domain.tld`, else 422 "Enter a valid email address." (M14).
- `phone`: "" or free text holding at least five digits ("+86 138 0013 2244", "WeChat 13800132244"), else 422
  "Enter a valid phone number."; older values with letters keep saving.
- The other text fields are trimmed and optional: country, city, state, contactPerson, phone, paymentTerms, taxNumber
  up to 200 (postalCode 50, country 100), address and notes up to 1000.

**PATCH `/suppliers/:id`** takes every MD-2 field plus `status`; `code` may change (same rules; it can't be blanked).
Editing a supplier never touches its orders or payments (they reference the supplier by id; the currency applies to
new orders only, as before). **DELETE `/suppliers/:id`** is unchanged (docs/wave3-contracts.md 4.1): a supplier with
orders or deposits is refused with 409 `in_use` and is deactivated instead, so history is never removed.

**SUP-1 `GET /suppliers/summary`**, the five KPI cards, no filters:

```
{ suppliers: { total, active, inactive },
  openPos: { count, value: MoneyTotal[] },          // orders not closed (phase 2 §1) and their order value
  inTransit: { orders, nextEta: date | null, arrivingNext7 },   // orders at stages 3-5; their containers not yet arrived
  unpaid: { amount: MoneyTotal[], suppliers },      // positive supplier balances only, and how many suppliers owe
  upcomingPayments: { windowDays: 7, count, amount: MoneyTotal[] } }   // due supplier payments, today to today + 6
```

**SUP-2 `GET /suppliers/insights?from&to&supplierId`**, the Supplier Performance and Analytics tabs. `from`/`to`
keep the orders placed in that range (order date), `supplierId` one supplier; a bad query is 400. Delivery is measured
in China: an order is **delivered** on the day of its first receipt (REC-3), **on time** when that day is on or before
its delivery date, **delayed** when delivered after it or not delivered, past due and still at stage 1-2 (the Order
status report's late orders). **Completed** = closed (phase 2 §1). `averageDeliveryDays`: the mean of order date to
first receipt over the delivered orders, rounded, `null` without any.

```
{ filter: { from, to, supplier: name | null },
  suppliers: { total, active },
  summary: Stats,
  bySupplier: ({ supplierId, code, name, country, value: MoneyTotal[], balance: MoneyTotal[] } & Stats)[],   // biggest value first
  top: (same)[],                       // up to 5: best on-time rate among suppliers that delivered, then most completed
  byCountry: { country, suppliers }[], // every supplier, any status; "" when the country was never set
  monthly: { month: "YYYY-MM", value: MoneyTotal[], paid: MoneyTotal[], paidInr }[] }
Stats = { orders, completed, completionRate, delivered, onTime, onTimeRate, delayed, averageDeliveryDays }
```

Rates are whole percentages, `null` when there is nothing to measure (no orders, nothing delivered). `monthly` runs
from `from` (else 11 months before `to`'s month, or this month) to `to` (else today); `value` is the order value of the orders placed in
the month, `paid` / `paidInr` the supplier payments paid in the month (INR at each payment's own rate), in the same
window. `MoneyTotal = { currency, amount }`.

Tests: `master-data/suppliers.test.ts` (profile fields, codes, email) and `master-data/supplier-insights.test.ts`
(money columns, SUP-1, SUP-2).
