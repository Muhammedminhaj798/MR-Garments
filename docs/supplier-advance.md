# Supplier advance account (migration 0014)

Money the client has already paid a supplier before any order exists is recorded as an **advance**. New orders for that
supplier use it automatically. MR Garments only records it; nothing moves money.

## Owner decisions (2026-11-17)

- There is no "cancel order" concept. **Deleting an order (ORD-6) is the cancellation**: its advance is returned first.
  ORD-6's existing refusals stay (an order with payments, receipts, container or warehouse lines is not deleted).
- The advance applied to an order **counts toward the deposit the supplier asked for** (`deposit_required_cny`).
- An advance carries a **typed INR rate** (the form prefills the supplier's saved rate), like a payment; INR suppliers
  take none (stored as 1).

## Data: `supplier_advance_entries` (append-only ledger)

| kind | meaning | links |
| --- | --- | --- |
| `receipt` | advance paid to the supplier (amount, paid-on date, mode, reference, notes, typed rate) | none |
| `allocation` | part of one receipt applied to one order | `advance_id` = receipt, `order_id`, `po_number` |
| `reversal` | part of one allocation given back to its receipt | `advance_id` = receipt, `reversal_of` = allocation, `order_id`, `po_number` |

- `amount numeric(14,2) > 0`, `currency` = the supplier's at the time, `exchange_rate numeric(12,4) > 0` (1 for INR).
  Allocations and reversals copy the rate of the receipt they draw from, so INR applied = INR paid.
- `order_id` is `ON DELETE SET NULL`; `po_number` keeps the PO, so a deleted order's history stays readable.
- Nothing is stored or updated in place. Available = receipts − allocations + reversals, **per supplier and currency**.
  An order's advance = its allocations − their reversals.
- A shape check enforces which links each kind has. Migration 0014 is purely additive (one new table).

## Allocation (`settleAdvance`, `src/modules/advances/advances.ts`)

One function brings an order's applied advance to its target inside the caller's transaction:

- **target** (`SettleMode`), with owed = order value − paid direct supplier payments:
  - `settle` (ORD-3, ORD-5, ADV-4): min(owed, applied + available in the order's currency);
  - `cap` (PAY-2): min(owed, applied), so it never draws, only gives back what direct payments now cover;
  - `release` (ORD-6): 0.
- More is drawn **oldest receipt first** (paid-on, then recorded), one allocation per receipt; less gives back the
  **newest allocations first**, one reversal per allocation (partial amounts allowed).
- Arithmetic in integer cents. At the target nothing is written, so a retry or repeat never applies or returns twice.
- Concurrency: every write to one supplier's account takes `pg_advisory_xact_lock(hashtext('supplier-advance'),
  hashtext(supplier_id))` after any row lock the caller holds (an existing order's row is locked `FOR UPDATE` first by
  ORD-5, ORD-6, PAY-2 and ADV-4). Every read that sets the target runs after that lock, so two orders, edits, payments
  or applies can never draw the same money, and supplier payments plus advance never pass the order value.

Called by:

| Route | When | Result |
| --- | --- | --- |
| ORD-3 `POST /orders` | always, after lines and ORD-3 deposits are written, same transaction | response gains `advance` |
| ORD-5 `PATCH /orders/:po` | when `lines` are sent (the total may change) | response gains `advance`; a date-only edit answers as before |
| ORD-6 `DELETE /orders/:po` | after the refusal checks, before the delete | reversals for everything applied; server log line |
| PAY-2 `POST /payments` | supplier payments only, after the payment, same transaction (`cap`) | response gains `advance`; agent payments answer as before |
| ADV-4 `POST /orders/:po/advance` | when a user applies an advance recorded after the order existed | `{ advance }`; a repeat writes nothing (`changeCny` 0) |

`advance` = `{ appliedCny, changeCny, availableCny, balanceCny, status }`; `status` is `none` (nothing applied),
`full` (applied and nothing left to pay) or `partial`. Insufficient advance never blocks an order.
A direct supplier payment (PAY-2) gives back the advance it now covers (newest allocation first), never draws more.
Deleting a payment (PAY-3) does not draw advance by itself: ADV-4 applies it. The supplier cannot change on ORD-5, so no
supplier reallocation exists.

## Endpoints

| Id | Route | Access | Notes |
| --- | --- | --- | --- |
| ADV-1 | `GET /suppliers/:supplierId/advances` | payments View | `{ supplier, summary[], entries[], openOrders[] }`; entries newest first with `balance` (available in that currency right after the entry); `openOrders` = the supplier's orders still owing (balance > 0), oldest first, `{ po, orderDate, currency, orderValueCny, paidCny, advanceCny, balanceCny }` |
| ADV-2 | `POST /suppliers/:supplierId/advances` | payments Enter | `{ amount, paidOn, rateInr?, mode, reference?, notes?, currency? }`; currency must be the supplier's (422); no order; 201 with the new entry and the account |
| ADV-3 | `DELETE /supplier-advances/:id` | payments Full | only a receipt nothing was drawn from (409 `in_use`); allocations/reversals 409 `order_entry`; server log line |
| ADV-4 | `POST /orders/:po/advance` | payments Enter | applies the available advance to an existing order (`settle`); 404 unknown PO |

Also: DEP-1 gains `advances` (per supplier and currency) and lists suppliers with an advance account; its obligations
gain `advanceCny`. SD-1 gains `advance` (the account). ORD-2 suppliers gain `advanceAvailable`. ORD-4 gains
`advanceAvailableCny` (the supplier's available advance in the order's currency; null without payments View). Suppliers with advance
records are not deleted (409, deactivate instead). USR-5 counts `supplier_advance_entries.created_by`.

## Money rules (no double counting)

- `orderMoney.advanceCny` / `advanceInr` (money.ts) are the only definition of "advance applied". It is never a
  `payments` row, so every payment total (paid, paid INR, payment lists, dashboard "paid") is unchanged.
- **Balance to supplier** = order value − supplier payments − advance applied (`balanceOf`), everywhere: ORD-1 (FE
  helper), ORD-4, PAY-1, 13.5 payments per supplier, supplier detail (RPT-5D), order reports (RPT-O1/O2), supplier
  insights, warehouse previous outstanding.
- **Payment status** (RPT-O2, FE lists) treats supplier payments + advance together.
- **Deposit paid** (`depositPaidCny`) = paid supplier deposits + advance applied (owner decision).
- **Landed cost** goods INR adds the advance applied at each receipt's rate; the "supplier payment" wait counts it.
- Supplier deposits (0008) and their settlements are untouched and never read or write the advance ledger.

## Known limits

- An advance recorded after an order exists is applied to it only when a user asks (ADV-4: the order's Payments tab or
  the Supplier advance tab's open orders); new orders still draw automatically.
- After a supplier's currency changes, its old-currency advance stays available but only orders in that currency
  could use it; new orders use advances in the new currency. Never converted.
- No manual adjustment entries (refund of an advance by the supplier): delete an unused receipt, or add a new receipt.
