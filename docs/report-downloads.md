# Page report downloads (2026-11-12)

Every operational and financial page of the frontend has a **Download report** menu (PDF, Excel, CSV). The files are
built in the browser from the same API answers the page renders (no file is stored on the server), filtered by the
page's own filters. Every list endpoint below already returns all of its rows (no server paging), so a download holds
every matching record, not only the visible page of the table. Authorisation is the endpoint's own: a download never
holds data the user's role cannot read on the page.

No migration. The API changes are additive: new fields on existing answers, one new read endpoint and one new query
flag. Older frontends ignore them.

## New endpoint

**ORD-7 `GET /api/v1/order-lines`** (ordersView ≥ View). Every line of every order, in ORD-1's order (order date and PO
newest first), then line position:

```json
{ "orderId": "…", "po": "PO-2051", "currency": "CNY", "position": 0, "item": "Denim jeans", "unit": "pcs",
  "quantity": 120, "rateCny": 12.5, "valueCny": 1500, "received": 0, "stocked": 0 }
```

`rateCny` is the rate saved on the order line (never the item's master price now); `valueCny` = quantity × rate,
rounded in SQL like ORD-1's order value. `received`: the line's China receipts; `stocked`: the line on stocked warehouse
receipts. It has its own path because `/orders/:po` would read "lines" as a PO number. The Orders, Pending and Closed
downloads read it for their "Order items" sheet.

## New fields

| Endpoint | Field | Meaning |
| --- | --- | --- |
| REC-1 `GET /receipts` | `deliveryNote`, `shortRemark` | The receipt's notes as saved by REC-3. |
| | `lines[].ordered`, `lines[].received` | The order line's quantity, and its total over every receipt so far. |
| CON-1 `GET /containers` | `portOfLoading`, `portOfArrival` | As saved by CON-3 ("" when not given). |
| | `orders[].supplier` | The order's supplier name. |
| CLR-1 `GET /clearings` | `goodsValueInr`, `customsDutyInr`, `otherDutiesInr`, `agentChargesInr`, `portChargesInr` | CLR-3's figures; null while the container waits for a clearing. `clearingCostInr` stays their sum (the value of goods for duty is not a cost). |
| TRN-1 `GET /transports` | `freightInr`, `handlingInr` | The two parts of `costInr`. |
| | `destination`, `driverName`, `shortRemark` | The trip's warehouse (name), driver and short remark. |
| | `quantities` | The container's goods, one `{ unit, quantity }` per unit (pieces and metres never added). |
| WH-1 `GET /warehouse-receipts` | `rows[].lines` | `{ orderLineId, item, unit, ordered, quantity }` per order line on the receipt, all teams together. |
| | `rows[].bundlesLoaded`, `rows[].shortRemark` | The trip's bundles loaded and short remark (bundles received is `bundlesReceived`). |
| `GET /landed-cost` | `orders[].orderDate`, `orderValueCny`, `exchangeRate` | The PO date, its value in the order's currency and the rate saved on the order (0012; null for older orders). The landed cost itself is unchanged: goods are still the supplier payments at their own rates (loadLandedCosts). |

## New query flag

**RPT-5D `GET /reports/payments-per-supplier/:supplierId?all=1`**: each list (payments, orders, lines) answers every
matching row in one page; the page parameters are ignored. Any other value of `all` is a 400. The supplier detail's
download uses it so a supplier with more than 10 orders, payments or lines is exported whole.

## What the downloads do not invent

Item codes, item descriptions, opening stock, stock issues or movements, insurance, GST and freight charges per
container are not recorded. The reports leave them out or say so in a note; freight is the shipping-agent payments of
each PO (as the landed cost counts it), never a figure per container.
