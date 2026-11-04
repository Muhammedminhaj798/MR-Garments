# Live screens contracts (Orders, Deposits & Payments, Delivery calendar, Receiving, Containers)

Approved 2026-10-27: migration 0003 (`src/db/schema/orders.ts`, `drizzle/0003_orders_receiving_containers.sql`),
applied to `mr_garments_test` only, and the default business rules below. Coordinator-owned: change this file only
through the coordinator. Everything in `docs/contracts.md` still applies (Node 22, `/api/v1`, JSON only, error body,
strict Zod bodies via `parse()`, same-site check, `requirePermission`).

## Conventions

- Dates are `YYYY-MM-DD` strings. "Today" is the date in India (`Asia/Kolkata`).
- Money is in the order's `currency` (`"CNY" | "USD" | "INR"`, migration 0006; number, 2 decimals). The `...Cny` names
  (`rateCny`, `amountCny`, `orderValueCny`, `paidCny`, `balanceCny`, `depositsPaidCny`, `unitPriceCny`) are kept for
  compatibility and mean "in the order's currency"; every row that carries them also carries `currency`. Payments
  (supplier and agent) are in their order's currency. `rateInr` is INR per 1 unit of the order's currency, typed per
  payment; an INR order takes none and it is stored as 1. INR amounts are `amountCny * rateInr`, rounded to 2 decimals
  per payment. Amounts in different currencies are never added together, and no rate is ever guessed.
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
  supplier {id, name}, currency, item, quantity, unit, received` (main line), `orderValueCny` (sum of quantity * rateCny over
  all lines), `paidCny`, `paidInr` (paid payments only).
- **ORD-2** `OrderOptions`: `nextPo`, active `suppliers {id, name, contactPerson, phone, city, currency}[]` (`currency`: the
  new-order default), active
  `items {id, name, unit}[]`, active shipping `agents {id, name}[]` (deposit payees). Readable by anyone who can open
  Orders, so Procurement doesn't need Settings access.
- **ORD-3** body `CreateOrderBody`: `supplierId, currency?` (CNY, USD or INR; CNY when left out, as an older frontend
  shows yuan only; fixed afterwards), `orderDate, deliveryDate, lines {itemId, quantity, rateCny}[]` (1-50),
  `deposits {payee, payeeRole, amountCny, paidOn, rateInr?, mode}[]` (0-10, saved as `Deposit` payments, status `paid`;
  `rateInr` required unless the order is INR, where it must be left out or 1 and is stored as 1; otherwise 422 on
  `deposits`: "Enter the INR rate." / "Leave the rate empty for an INR order.").
  201 `{ order: { id, po } }`. 422 `validation_failed` with fields `supplierId`, `orderDate`, `deliveryDate`
  ("The delivery date can't be before the order date."), `currency` ("Choose CNY, USD or INR."), `lines`, `deposits`. Inactive or unknown supplier/item: 422 on
  that field. One transaction.
- **CAL-1** `DeliveryItem[]` (due date, oldest first): orders at stage 1-2: `orderId, po, supplier` (name), `item,
  quantity, unit, received, due` (= deliveryDate), `fullyReceived` (every line has received >= its quantity; `item`,
  `quantity` and `received` are the main line's). The frontend leaves fully received orders off the calendar.
- **PAY-1** `PaymentsResponse`: `orders {orderId, po, supplier, currency, orderValueCny, paidCny, paidInr, balanceCny,
  nextDue}[]` (every order; `nextDue` = earliest `due` payment date or null) and `payments {id, orderId, po, currency,
  kind, payee, payeeRole, amountCny, status, paidOn, dueDate, rateInr, mode}[]` (`currency` is the order's).
- **REC-1** `ReceiptListItem[]` (received date, newest first): `id, receivedOn, orderId, po, supplier, item, office,
  ordered, unit, thisReceipt, totalSoFar, bundles, receivedBy` (user name). Main line figures; `totalSoFar` counts this
  receipt and every earlier one.
- **REC-2** `ReceiptOptions`: active China `offices {id, name}[]` and `orders {orderId, po, supplier, currency, orderValueCny,
  depositsPaidCny, lines {orderLineId, item, unit, ordered, receivedEarlier, unitPriceCny}[]}[]` for orders at stage
  1-2 with something left to receive. `orderValueCny`, `depositsPaidCny` and `unitPriceCny` are null unless the user
  has payments >= View (QA 2026-10-30: China staff must not see payments; lead-approved, pending management note).
  `currency` is always given: it is not an amount.
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

- **ORD-4** `OrderDetail`: the ORD-1 fields for that order (`currency` included; `supplier` also has `contactPerson, phone, city`), plus
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
  `amountCny` (0.01 to 999,999,999,999, in the order's currency), `paidOn` (date, not after today), `rateInr` (0.0001
  to 99,999,999; required unless the order is INR, where it must be left out or 1 and is stored as 1: "Leave the rate
  empty for an INR order."), `mode`
  (trimmed, 1-100 characters). The server saves `status: "paid"`, the payee name (the order's supplier, or the agent)
  and `createdBy`. Any stage. 201 `{ payment: { id } }`. 422 fields `orderId, kind, payeeRole, agentId, amountCny,
  paidOn, rateInr, mode`. No overpayment check: `balanceCny` may go below 0, as it already can with deposits. No edit or
  delete. Nothing moves money. The payment-recorded notification shows the amount with the order's symbol (¥, $, ₹).
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

## Deleting receipts and containers (2026-11-03)

No migration. So an order's receipts and containers can be removed before ORD-6 deletes the order. Management only.

| Id | Method and path | Permission | Owner |
| --- | --- | --- | --- |
| REC-4 | `DELETE /receipts/:id` | receiving = Full (Management) | BE-stock (`stock.routes.ts`) |
| CON-6 | `DELETE /containers/:id` | containers = Full (Management) | BE-containers (`stock/container-detail.routes.ts`) |
| ORD-4 | `GET /orders/:po` (changed) | ordersView >= View | BE-orders (`order-detail.routes.ts`) |

- **REC-4** 204 when the receipt and its own lines are deleted. One transaction with the order row locked `for update`
  (as REC-3 and CON-3 lock it). Received may never fall below loaded: when, without this receipt, a line's other
  receipts don't cover what is loaded, 409 `in_use` "This receipt can't be deleted: container N already holds 30 pcs
  of Denim jeans from it. Delete that container first." (plural: "containers A and B already hold … Delete those
  containers first."). Malformed, unknown or already deleted id: 404 `not_found` "Receipt not found.".
- **CON-6** 204 when the container and its lines (every order's) are deleted. One transaction: the container row, then
  its orders (id order), locked `for update`. Clearings, trips and warehouse receipts cascade from a container, so each
  refuses the delete instead: 409 `in_use` "Container N has a clearing record (Clearing in India), a transport trip
  (Transport) and a warehouse receipt (Warehouse), so it can't be deleted. Those records can't be removed in the
  app." (only the ones it has). Any container status may be deleted. Malformed, unknown or already deleted id: 404
  `not_found` "Container not found.".
- **Stages after REC-4 and CON-6** (`settleStages` in `src/modules/stages-shared.ts`): each affected order steps back,
  never forward. Still in a container: unchanged. Else a receipt left: 2 (or lower). Else 1.
- Payments, notifications, clearings, trips and warehouse receipts (their team quantities) are never removed by these.
  Each delete writes one server log line: "Receipt <id> of PO-x deleted by user <id>." or "Container N (<id>)
  deleted by user <id>.". There is no audit table (that would need a migration).
- **ORD-4 change**: each `containers` entry adds `orders: string[]`, every PO in the container (this one included),
  in PO order, so the delete confirmation can say whose goods leave with it.

## Deleting clearings and trips (2026-11-03)

No migration. The next links of the chain, so a container's clearing and road trip can be undone before CON-6. Warehouse
receipts (the stock and team quantities) and payments have no delete and stop the chain.

| Id | Method and path | Permission | Owner |
| --- | --- | --- | --- |
| CLR-4 | `DELETE /clearings/:containerId` | clearing = Full (Management) | A5 (`stages/clearing.routes.ts`) |
| TRN-4 | `DELETE /transports/:containerId` | transport = Full (Management) | A5 (`stages/transport.routes.ts`) |
| CLR-1, TRN-1 | `GET /clearings`, `GET /transports` (changed) | unchanged | A5 |

- **CLR-4** 204 when the container's clearing row is deleted, in progress or cleared. One transaction: the container,
  then the clearing, locked `for update` (as CLR-3 and TRN-3 lock them), then the container's orders (id order). A trip
  refuses it: 409 `in_use` "The clearing of container N can't be deleted: transport trip LR-x depends on it. Delete
  that trip first." (with a warehouse receipt: "… transport trip LR-x and its warehouse receipt depend on it.
  Warehouse receipts can't be removed in the app."). No clearing for the container, unknown or malformed id: 404
  `not_found` "Clearing not found.". The container stays `arrived` (waiting for clearing again).
- **TRN-4** 204 when the container's trip row is deleted, on the road or unloaded. One transaction: the container, then
  the trip, locked (WH-3 locks the trip first), then the orders. A warehouse receipt, draft or stocked, refuses it: 409
  `in_use` "Trip LR-x of container N can't be deleted: its warehouse receipt depends on it. Warehouse receipts can't
  be removed in the app.". No trip, unknown or malformed id: 404 `not_found` "Trip not found.". The clearing stays;
  the container is in TRN-1 `ready` again.
- **Stages** (`settleStages`, now for REC-4, CON-6, CLR-4 and TRN-4): each affected order takes the furthest stage its
  remaining records reach, never higher than before: over its containers a stocked warehouse receipt 6, a trip 5, a
  clearing 4, any container 3; else a receipt 2; else 1.
- Landed cost is computed from the records, so a deleted clearing's charges (or a trip's freight and handling) simply
  leave it; payments are per order and never touched. Server log lines: "Clearing of container N (<id>) deleted by
  user <id>." and "Trip LR-x of container N (<id>) deleted by user <id>.".
- **CLR-1 change**: each row adds `trip: {lrNumber, status, warehouseReceipt: "draft" | "stocked" | null} | null`.
  **TRN-1 change**: each trip row adds `warehouseReceipt: "draft" | "stocked" | null`. Both say what would refuse a delete.

## Deleting warehouse receipts (2026-11-04)

No migration. The last link of the chain: with it, every stage record of a container can be undone in order
(warehouse receipt, trip, clearing, container, receipt), then the order (ORD-6, still refused by payments).

| Id | Method and path | Permission | Owner |
| --- | --- | --- | --- |
| WH-4 | `DELETE /warehouse-receipts/:transportId` | warehouse = Full (Management) | A5 (`stages/warehouse.routes.ts`) |
| WH-1 | `GET /warehouse-receipts` (changed) | unchanged | A5 |

- **WH-4** 204 when the trip's warehouse receipt is deleted with its own team lines, draft or stocked. One transaction:
  the trip, then the receipt, locked `for update` (as WH-3 locks them), then the container's orders (id order). No
  receipt for the trip, unknown or malformed id: 404 `not_found` "Warehouse receipt not found.". Nothing refuses it:
  no table records stock movement, dispatch, transfer or sale, so nothing consumes stocked team quantities; landed
  cost, WH-1, reports and the master-data "in use" checks read the receipts live. A stocked receipt is therefore
  reversed by removing it: its pieces leave stock and the team totals, the orders' cost per piece is recomputed
  (null and not final until stocked again), and the orders step back (`settleStages`: 6 -> 5 unless another of their
  containers is stocked). A draft never moved a stage. The trip stays unloaded, waiting to be received again; the
  clearing, payments and notifications are not touched. Server log line: "Warehouse receipt (draft|stocked) of trip
  LR-x (<id>) deleted by user <id>.".
- **WH-1 change**: each stocked row adds `lrNumber` and `bundlesReceived` (the receipt's); each `ready` trip adds
  `draft: {receivedOn, location, bundlesReceived, received, teams: {teamId: pieces}} | null` (its draft's values).

## Deleting deposits and payments (2026-11-04)

No migration. Deposits and payments are one table, `payments`: `kind` Deposit or Balance, `status` paid or due, paid
to the supplier or a shipping agent, in the order's currency with its own `rateInr`. Nothing references a payment.

| Id | Method and path | Permission | Owner |
| --- | --- | --- | --- |
| PAY-3 | `DELETE /payments/:id` | payments = Full (Management) | BE-payments (`payments/payments.routes.ts`) |

- **PAY-3** 204 when the payment row is deleted, any kind or status. One transaction: the payment's order locked `for
  update` (as ORD-5 and ORD-6 lock it), then the payment. Malformed, unknown or already deleted id: 404 `not_found`
  "Payment not found.". Accounts (payments Enter) records payments but can't delete them: 403.
- Nothing refuses it: there is no reconciliation, settlement or allocation in the system, and no figure is stored.
  Every reader sums the remaining payments live, each at its own rate: ORD-1/ORD-4 and PAY-1 `paidCny`, `paidInr`,
  `balanceCny`, `nextDue`; payments-per-supplier and supplier detail (supplier payments only); landed cost `goodsInr`
  (supplier) or `seaFreightInr` (agent); REC-2 `depositsPaidCny`; WH-2 previous supplier outstanding; the dashboard's
  due-in-30-days. ORD-5's "total can't be less than paid" can't be broken by a delete; ORD-6 no longer counts it.
- The order, its other payments and the payment-recorded notification stay. Server log line: "Payment <id> (paid
  Deposit ¥300.00 to Supplier) of PO-x deleted by user <id>.". There is no audit table or soft delete (that would
  need a migration), so the deleted record itself is gone from the database.

## Notifications (NTF-1 to NTF-4, migration 0005)

The binding contract is `D:\SDEC\MR Garments\docs\notifications-contract.md` (lead-owned). Migration 0005
(`src/db/schema/notifications.ts`, `drizzle/0005_notifications.sql`) only adds the `notifications` table; it must be
applied to a database (with a backup) **before** this code runs there, because PAY-2, REC-3, CON-3 and CON-5 write to it.

| Id | Method and path | Permission | Body / response |
| --- | --- | --- | --- |
| NTF-1 | `GET /notifications?limit=&cursor=` | signed in | `limit` 1-50 (default 20), `cursor` = previous `nextCursor`; unknown query key, bad limit or a cursor that isn't one of the caller's notifications: 400 `bad_request`. 200 `{ items, nextCursor, unread }`, newest first (createdAt, then id) |
| NTF-2 | `GET /notifications/unread-count` | signed in | 200 `{ unread }` |
| NTF-3 | `POST /notifications/:id/read` | signed in | 200 `{ notification }`, idempotent (keeps the first read time); someone else's, unknown or malformed id: 404 `not_found` |
| NTF-4 | `POST /notifications/read-all` | signed in | 200 `{ updated }` (rows changed) |

`Notification` = `{ id, kind, title, details: string[], href: string | null, createdAt (ISO), read }`.

Events (`notify()` in `src/modules/notifications/notify.ts`, inside the business transaction; dedupe key
`<kind>:<source id>`, unique per user, `ON CONFLICT DO NOTHING`). Recipients: active users whose effective access
(matrix narrowed by stage grants) to the capability is View or better, minus the actor. Reading follows the reader's
access now (`KIND_CAPABILITY`, `readableKinds`): NTF-1..4 only list, count or mark kinds whose capability the caller
still has, so a user moved out of payments no longer sees payment amounts; the rows stay and show again if access
returns.

| Kind | When | Capability | Title / details | href |
| --- | --- | --- | --- | --- |
| `short-receipt` | REC-3 saved and some order line still has `received < ordered` | receiving | "PO-x received short" / supplier, "Item short by N unit" or "N lines short" | `/orders/PO-x/receiving` with ordersView, else `/receiving` |
| `payment-recorded` | PAY-2 saved a payment | payments | "PO-x payment recorded" / "Kind ¥amount", payee | `/orders/PO-x/payments` with ordersView, else `/payments` |
| `container-loaded` | CON-3 created a container | containers | "Container N loaded" / agent, POs, "ETA d Mon yyyy" | `/containers/:id` |
| `container-sailed` | CON-5 moved it to `sea` | containers | "Container N sailed" / POs, "ETA d Mon yyyy" | `/containers/:id` |
| `container-arrived` | CON-5 moved it to `arrived` | containers | "Container N arrived" / POs, port of arrival | `/containers/:id` |

Date-only CON-5 changes, ORD-3 deposits and refused writes (4xx) notify no one.

## Profile (PRF-1, PRF-2)

The binding contract is `D:\SDEC\MR Garments\docs\profile-contract.md` (lead-owned). No migration. Both routes act on
the signed-in user only (`req.user.id`); no id is read from the path, query or body.

| Id | Method and path | Permission | Body / response |
| --- | --- | --- | --- |
| PRF-1 | `GET /profile` | signed in | 200 `{ profile, options: { languages } }` |
| PRF-2 | `PATCH /profile` | signed in | strict body, any of `name`, `phone`, `language`; only the keys sent change; `updated_by` = caller. 200 `{ profile }`. Any other key (`email`, `role`, `officeId`, `status`, `stages`, `password`, `id`, ...) or an empty body: 400 `bad_request`. 422 `validation_failed` fields: `name` (M13, Users rule), `language` ("Choose a language from the list.", not yet approved) |

`Profile` = `{ name, email, phone ("" when unset), role, office: { id, name } | null, language,
passwordChangedAt (ISO) | null }`. Never the password hash, status, stage grants or audit columns.

## Files and owners

- Coordinator: `src/db/schema/**`, `drizzle/**`, `src/modules/index.ts`, this file.
- BE-orders: `src/modules/orders/**` (ORD-1..4, CAL-1, PAY-1) and their tests.
- BE-payments: `src/modules/payments/**` (PAY-2) and its tests.
- BE-stock: `src/modules/stock/stock.routes.ts` (REC-1..3, CON-1..3), `receipts.test.ts`, `containers.test.ts`.
- BE-containers: `src/modules/stock/container-detail.routes.ts` (CON-4, CON-5) and `container-detail.test.ts`.
- Notifications: `src/modules/notifications/**` (NTF-1..4, `notify()`) and `notifications.test.ts`.
- Profile: `src/modules/profile/**` (PRF-1, PRF-2) and `profile.test.ts`; field rules imported from `users.routes.ts`.

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
