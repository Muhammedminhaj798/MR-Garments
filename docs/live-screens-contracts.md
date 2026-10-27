# Live screens contracts (Orders, Deposits & Payments, Delivery calendar, Receiving, Containers)

Approved 2026-10-27: migration 0003 (`src/db/schema/orders.ts`, `drizzle/0003_orders_receiving_containers.sql`),
applied to `mr_garments_test` only, and the default business rules below. Coordinator-owned: change this file only
through the coordinator. Everything in `docs/contracts.md` still applies (Node 22, `/api/v1`, JSON only, error body,
strict Zod bodies via `parse()`, same-site check, `requirePermission`).

## Conventions

- Dates are `YYYY-MM-DD` strings. "Today" is the date in India (`Asia/Kolkata`).
- Money is CNY (number, 2 decimals). `rateInr` is INR per CNY. INR amounts are `amountCny * rateInr`, rounded to 2 decimals.
- Quantities are whole numbers. `unit` is `"m"` for items counted in Metres and `"pcs"` for Pieces.
- The **main line** of an order is its `position = 0` line: lists show its item, quantity and received quantity.
- `received` for an order line = sum of its `receipt_lines.quantity`. `loaded` = sum of its `container_lines.quantity`.
- Lists return arrays (like the master-data lists), newest first unless stated.
- Payments are **records only**. No endpoint moves money or talks to a payment provider.

## Business rules (approved defaults)

- **PO number:** `PO-` + (highest existing number + 1). The first order is `PO-2050`. Assigned by the server.
- **Order status** (computed by the frontend from the facts below, with today in India):
  stage 4 "In clearing", stage 5 "On the road", stage 6 "Received"; stage 3 with `received < quantity`
  "Short by N <unit>"; otherwise by `deliveryDate`: before today and stage <= 2 "Late N day(s)"; today to 7 days ahead
  "Due today" / "Due in N day(s)"; else "On track".
- **Stages:** a new order is stage 1. The first receipt moves it 1 -> 2. Loading any of its lines into a container
  moves it 2 -> 3. Nothing in this batch moves an order past 3.
- **Receiving:** quantities are >= 0, at least one line > 0, and `received + this receipt <= ordered` per line
  (no over-receipt). Only orders at stage 1 or 2. Offices are active China offices. `receivedBy` is the signed-in user.
- **Loading:** quantity > 0 and `loaded + this container <= received` per line. Only orders at stage 2 or 3.
  New containers are status `loading`. Container numbers are unique, case-insensitive.

## Endpoints

| Id | Method and path | Permission | Owner |
| --- | --- | --- | --- |
| ORD-1 | `GET /orders` | ordersView >= View | BE-orders |
| ORD-2 | `GET /orders/options` | ordersView >= View | BE-orders |
| ORD-3 | `POST /orders` | ordersEdit >= Enter | BE-orders |
| CAL-1 | `GET /deliveries` | calendar >= View | BE-orders |
| PAY-1 | `GET /payments` | payments >= View | BE-orders |
| REC-1 | `GET /receipts` | receiving >= View | BE-stock |
| REC-2 | `GET /receipts/options` | receiving >= Enter | BE-stock |
| REC-3 | `POST /receipts` | receiving >= Enter | BE-stock |
| CON-1 | `GET /containers` | containers >= View | BE-stock |
| CON-2 | `GET /containers/options` | containers >= Enter | BE-stock |
| CON-3 | `POST /containers` | containers >= Enter | BE-stock |

Response and body types are written once, in the frontend's `src/lib/api/types.ts` (section "Live screens"), and the
backend returns exactly those shapes. Summary:

- **ORD-1** `OrderListItem[]` (order date, then PO, newest first): `id, po, orderDate, deliveryDate, stage,
  supplier {id, name}, item, quantity, unit, received` (main line), `orderValueCny` (sum of quantity * rateCny over
  all lines), `paidCny`, `paidInr` (paid payments only).
- **ORD-2** `OrderOptions`: `nextPo`, active `suppliers {id, name, contactPerson, phone, city}[]`, active
  `items {id, name, unit}[]`, active shipping `agents {id, name}[]` (deposit payees). Readable by anyone who can open
  Orders, so Procurement doesn't need Settings access.
- **ORD-3** body `CreateOrderBody`: `supplierId, orderDate, deliveryDate, lines {itemId, quantity, rateCny}[]` (1-50),
  `deposits {payee, payeeRole, amountCny, paidOn, rateInr, mode}[]` (0-10, saved as `Deposit` payments, status `paid`).
  201 `{ order: { id, po } }`. 422 `validation_failed` with fields `supplierId`, `orderDate`, `deliveryDate`
  ("The delivery date can't be before the order date."), `lines`, `deposits`. Inactive or unknown supplier/item: 422 on
  that field. One transaction.
- **CAL-1** `DeliveryItem[]` (due date, oldest first): orders at stage 1-2: `orderId, po, supplier` (name), `item,
  quantity, unit, received, due` (= deliveryDate).
- **PAY-1** `PaymentsResponse`: `orders {orderId, po, supplier, orderValueCny, paidCny, paidInr, balanceCny, nextDue}[]`
  (every order; `nextDue` = earliest `due` payment date or null) and `payments {id, orderId, po, kind, payee,
  payeeRole, amountCny, status, paidOn, dueDate, rateInr, mode}[]`.
- **REC-1** `ReceiptListItem[]` (received date, newest first): `id, receivedOn, orderId, po, supplier, item, office,
  ordered, unit, thisReceipt, totalSoFar, bundles, receivedBy` (user name). Main line figures; `totalSoFar` counts this
  receipt and every earlier one.
- **REC-2** `ReceiptOptions`: active China `offices {id, name}[]` and `orders {orderId, po, supplier, orderValueCny,
  depositsPaidCny, lines {orderLineId, item, unit, ordered, receivedEarlier, unitPriceCny}[]}[]` for orders at stage
  1-2 with something left to receive.
- **REC-3** body `CreateReceiptBody`: `orderId, receivedOn` (not after today), `locationId, bundles, deliveryNote,
  shortRemark, lines {orderLineId, quantity}[]`. 201 `{ receipt: { id } }`. 422 fields `receivedOn`, `locationId`,
  `bundles`, `lines`; 409 `order_not_receivable` when the order is past stage 2.
- **CON-1** `ContainerListItem[]` (created, newest first): `id, number, agent {id, name}, terms, loadedOn, sailedOn,
  eta, etaEstimated, status, bundles` (sum), `orders {po, part}[]` (`part`: some line of that order is not fully loaded
  in this container).
- **CON-2** `ContainerOptions`: active `agents {id, name}[]` and loadable `lines {orderLineId, orderId, po, item, unit,
  received, loaded}[]` (orders at stage 2-3 with `received > loaded`).
- **CON-3** body `CreateContainerBody`: `number, shippingAgentId, terms, portOfLoading, portOfArrival, loadedOn,
  sailedOn` (or null), `eta` (not before loadedOn), `lines {orderLineId, bundles, quantity}[]` (1+). 201
  `{ container: { id } }`. 409 `container_exists` (fields.number); 422 fields `number`, `shippingAgentId`, `terms`,
  `loadedOn`, `eta`, `lines`.

## Files and owners

- Coordinator: `src/db/schema/**`, `drizzle/**`, `src/modules/index.ts`, this file.
- BE-orders: `src/modules/orders/**` (ORD-1..3, CAL-1, PAY-1) and their tests.
- BE-stock: `src/modules/stock/**` (REC-1..3, CON-1..3) and their tests.

## Tests

API tests use the harness (`src/test/harness.ts`) against `mr_garments_test` only (`.env.test`; there is no `.env` in
these worktrees). A test run resets that database, so **only one test run at a time across all worktrees**: wrap every
run in the lock below. Create the rows a test needs inside the test (orders, receipts...), never in a seed.

```bash
LOCK=/d/Temp/claude/mrg-test-db.lock
until mkdir "$LOCK" 2>/dev/null; do sleep 3; done
PATH=/d/SDEC/tools/node-22:$PATH npx vitest run src/modules/<yours>; status=$?
rmdir "$LOCK"; exit $status
```
