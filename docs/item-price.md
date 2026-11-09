# Item price (replaces pieces per bundle and bundle label)

Settings > Item list no longer asks for "Pieces per bundle" or a "Bundle label". Each item has an optional **Item
price**: the default rate per unit that New order fills into a line when the item is chosen (the user may change it;
an item without a price leaves the rate empty, so a previous item's rate never stays).

## Contract

- MD-19 `GET /items` rows: `{ id, name, countedIn, price, usedInOrders, status }`; `price` is a number with at most
  2 decimals, from 0 to 99,999,999.99 (what ORD-3 accepts as a rate), or `null`. The price has no currency of its
  own: it is the number New order puts in the rate box, which is in the order's currency (the supplier's by default).
  A price of 0 is kept and listed as 0.00, but New order treats it like no price (a rate must be above 0).
- `POST /items` `{ name, countedIn, price? }` and `PATCH /items/:id` (`price: null` clears it). A negative price,
  more than 2 decimals or text is 422 `fields.price` "Enter a price of 0 or more with at most 2 decimals.";
  `perBundle` / `bundleLabel` are unknown keys now (400).
- ORD-2 `GET /orders/options` items carry `price` for the form.
- Order lines keep their own `rateCny`: the price is a default at the moment of ordering. Changing an item's price
  never changes a saved order, Edit order keeps the saved rates, and ORD-3 still takes the rate from the client.

## Migration 0010 `item_price`

Additive and safe before the backend deploys: `items.price numeric(12,2) null` with check `price is null or price
>= 0`, and `items_bundle_check` dropped (new rows carry neither bundle value). The `per_bundle` and `bundle_label`
columns are kept with their data; nothing reads or writes them any more. A follow-up migration drops them once the
release is verified. Existing items start with no price (`null`) and keep every other value.

Order: apply 0010, then deploy the backend, then the frontend. The new backend selects `items.price`, so on the old
schema MD-19, ORD-2 `/orders/options` (the Orders list, New order and Payments load it) and ORD-3 fail until the
migration runs. The old backend runs unchanged on the new schema (it still writes exactly one bundle value). A
frontend deployed before the backend would send `price` to an API that refuses the key (400) and list items with a
dash. Rollback after the backend is live: redeploy the old backend and leave 0010 in place; `items_bundle_check`
cannot be re-added once items exist with neither bundle value, and the old code enforced the rule itself.
