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

## Five-tab completion (approved 2026-10-27)

No migration: everything below uses the 0003 tables as they are. Business rules approved by the user: payments
recorded here are payments already made (status `paid`); containers move forward only, `loading` -> `sea` ->
`arrived`; order stages still change only through REC-3 (1 -> 2) and CON-3 (2 -> 3).

| Id | Method and path | Permission | Owner |
| --- | --- | --- | --- |
| ORD-4 | `GET /orders/:po` | ordersView >= View | BE-orders (`order-detail.routes.ts`) |
| PAY-2 | `POST /payments` | payments >= Enter | BE-payments (`payments/payments.routes.ts`) |
| CON-4 | `GET /containers/:id` | containers >= View | BE-containers (`stock/container-detail.routes.ts`) |
| CON-5 | `PATCH /containers/:id` | containers >= Enter | BE-containers (`stock/container-detail.routes.ts`) |
| REC-3 | `POST /receipts` (changed) | receiving >= Enter | BE-stock (`stock.routes.ts`) |

- **ORD-4** `OrderDetail`: the ORD-1 fields for that order (`supplier` also has `contactPerson, phone, city`), plus
  `balanceCny` (as PAY-1), `lines {id, position, item {id, name}, unit, quantity, rateCny, valueCny, received, loaded}[]`
  (position order; `valueCny` = round2(quantity * rateCny)), and three sections, each `null` when the signed-in user
  can't view it (effective access below View):
  - `payments` (payments): `{id, kind, payee, payeeRole, amountCny, status, paidOn, dueDate, rateInr, mode}[]`,
    oldest first by coalesce(paidOn, dueDate), then entry time.
  - `receipts` (receiving): `{id, receivedOn, office, bundles, deliveryNote, shortRemark, receivedBy, lines {orderLineId,
    item, unit, quantity}[]}[]`, oldest first by receivedOn, then entry time. `receivedBy` is the user's name or `""`.
  - `containers` (containers): `{id, number, status, terms, agent {id, name}, loadedOn, sailedOn, eta, lines
    {orderLineId, item, unit, bundles, quantity}[]}[]` (only this order's lines), oldest first by loadedOn, then entry
    time.
  
  `:po` must look like `PO-<digits>`; anything else, or an unknown PO, is 404 `not_found` "Order not found.". Register
  after ORD-2 so `/orders/options` keeps working.
- **PAY-2** body `CreatePaymentBody`: `orderId` (uuid, existing order), `kind` (`Deposit` | `Balance`), `payeeRole`
  (`supplier` | `agent`), `agentId` (uuid of an active shipping agent when `payeeRole` is `agent`, otherwise `null`),
  `amountCny` (0.01 to 999,999,999,999), `paidOn` (date, not after today), `rateInr` (0.0001 to 99,999,999), `mode`
  (trimmed, 1-100 characters). The server saves `status: "paid"`, the payee name (the order's supplier, or the agent)
  and `createdBy`. Any stage. 201 `{ payment: { id } }`. 422 fields `orderId, kind, payeeRole, agentId, amountCny,
  paidOn, rateInr, mode`. No overpayment check: `balanceCny` may go below 0, as it already can with deposits. No edit or
  delete. Nothing moves money.
- **CON-4** `ContainerDetail`: the CON-1 fields plus `portOfLoading, portOfArrival` and `lines {orderLineId, orderId, po,
  item, unit, bundles, quantity}[]` (PO, then item). Malformed or unknown id: 404 `not_found` "Container not found.".
  Register after CON-2.
- **CON-5** body `UpdateContainerBody` (strict, at least one key): `status` (`sea` | `arrived`), `sailedOn` (date),
  `eta` (date). One transaction, the container row locked. Rules:
  - An `arrived` container can't change: 409 `container_arrived` "This container has arrived and can't be changed."
  - `status: "sea"` only from `loading`; `status: "arrived"` only from `sea`. Anything else (including the current
    status, or skipping `sea`): 409 `invalid_status_change` "Containers move from Loading to At sea to Arrived, in
    that order."
  - Moving to `sea` needs a sailing date: `sailedOn` in the body or already saved, else 422 `sailedOn`.
  - `sailedOn`: not before `loadedOn`, not after today. `eta`: not before `loadedOn`, and not before the (new or saved)
    `sailedOn`. 422 on that field.
  - Order stages don't change. 200 `{ container: { id, status, sailedOn, eta } }`.
  - An empty body or an unknown key is 400 `bad_request`; a wrong value shape is 422 on `status`, `sailedOn` or `eta`.
  - The sailing-date rules also apply to a sailing date saved at loading (the load form's ETD) when the container moves
    to `sea` without sending one, so a planned future date must be corrected to the real one.
  - Messages (`DETAIL_MESSAGES` in `container-detail.routes.ts`): "Choose At sea or Arrived.", "Enter the sailing
    date.", "The sailing date can't be before the loading date.", "The sailing date can't be after today.", "The ETA
    can't be before the sailing date.", plus CON-3's "The ETA can't be before the loading date.".
- **REC-3 change**: when, after this receipt, any line of the order still has `received < ordered`, `shortRemark` must
  be non-empty: 422 field `shortRemark` "Add a remark about the short items." (screen 21: "remark required"). Nothing
  else changes. REC-3's 422 fields are therefore `orderId` (unknown order), `receivedOn`, `locationId`, `bundles`,
  `lines` and `shortRemark`.
- **Errors without fields** (409 `order_not_receivable`, `container_arrived`, `invalid_status_change`): the frontend
  shows the API's own message (`handleApiError` in `src/lib/feedback.ts`).

## Files and owners

- Coordinator: `src/db/schema/**`, `drizzle/**`, `src/modules/index.ts`, this file.
- BE-orders: `src/modules/orders/**` (ORD-1..4, CAL-1, PAY-1) and their tests.
- BE-payments: `src/modules/payments/**` (PAY-2) and its tests.
- BE-stock: `src/modules/stock/stock.routes.ts` (REC-1..3, CON-1..3), `receipts.test.ts`, `containers.test.ts`.
- BE-containers: `src/modules/stock/container-detail.routes.ts` (CON-4, CON-5) and `container-detail.test.ts`.

## Tests

API tests use the harness (`src/test/harness.ts`) against `mr_garments_test` only (`.env.test`; there is no `.env` in
these worktrees). A test run resets that database, so **only one test run at a time across all worktrees**: wrap every
run in the lock below. Create the rows a test needs inside the test (orders, receipts...), never in a seed.

```bash
LOCK=/d/Temp/claude/mrg-test-db.lock
until mkdir "$LOCK" 2>/dev/null; do sleep 3; done
/d/SDEC/tools/node-22/node.exe node_modules/vitest/vitest.mjs run src/modules/<yours>; status=$?
rmdir "$LOCK"; exit $status
```

Run Node directly rather than `npx`: npm writes its logs to the C: drive, which is nearly full.
