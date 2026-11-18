# Order container terms (migration 0015)

Container terms (FOB or CNF, `TERMS` in `src/db/schema/orders.ts`) are chosen on the order. A container takes the
terms of the orders loaded into it; nobody types them on the Containers tab any more.

## Data

- `orders.terms` text, null or `FOB`/`CNF` (`orders_terms_check`). Null only for orders from before 0015 that no
  container settles.
- `containers.terms` is unchanged and still required: it is the container's terms, written once by CON-3 from its
  orders, and every cost, clearing, transport, warehouse and report query keeps reading it. Containers hold no order
  terms of their own, and an order's terms can't change once a container holds it, so the two never disagree.
- 0015 backfill: an order already in containers takes their terms when they all agree; one never loaded, or loaded
  into containers with different terms (possible before 0015), stays null. Nothing else is rewritten.

## API

| Route | Change |
| --- | --- |
| ORD-1 `GET /orders`, ORD-4 `GET /orders/:po` | each order gains `terms` (`FOB`, `CNF` or null) |
| ORD-3 `POST /orders` | optional `terms` (`FOB`/`CNF`; 422 `terms` "Choose the container terms: FOB or CNF."); left out, null |
| ORD-5 `PATCH /orders/:po` | optional `terms`, at stages 1-5; 422 `terms` "This order is already loaded in a container, so its container terms can't change." once a container line holds the order, unless its terms were null (an older order sets them once). The response's `order` gains `terms`. |
| CON-2 `GET /containers/options` | each line gains its order's `terms` |
| CON-3 `POST /containers` | `terms` optional. The container's terms are its orders' (read under their row locks). Orders with different terms: 422 `lines` "PO-1 is FOB and PO-2 is CNF: one container holds orders with the same container terms." (never merged). `terms` sent and different from the orders': 422 `terms` "These orders are FOB, so the container is FOB.". An order without terms: 422 `lines` "Set the container terms on PO-1 (Edit order) before loading it." unless `terms` is sent, which that order then takes. |

Clients that still send the terms they chose (an older frontend) keep working when they match the orders.

## One container, many orders

A container has one terms value, and landed cost applies it to every order in it (sea freight is paid to the agent on
FOB orders). So a container only holds orders with the same terms: CON-3 refuses a mix with the message above instead
of picking one. An order split across containers keeps one terms value in all of them.

## Release order and rollback

- Order: migration 0015, then the backend, then the frontend. 0015 is additive: the backend before it never reads
  `orders.terms`, so it keeps working after the migration. The new frontend needs the new backend: on an older one it
  would send `terms` (ORD-3, ORD-5: 400 unknown key) and see no order terms on Load container (every load blocked).
- 0015 runs in one transaction (drizzle): add the nullable column (no default, so no table rewrite), add the check (every
  existing row is NULL, so it passes), then the backfill UPDATE on the loaded orders. Locks are held for milliseconds.
  Nothing else is written: containers, payments, deposits, advances and every other table are untouched.
- Rolling back the code: frontend first, then the backend (an older backend refuses the new frontend's `terms`). The
  column can stay: older code ignores it.
- Rolling back the schema (only if needed, after the code): `ALTER TABLE orders DROP CONSTRAINT orders_terms_check;
  ALTER TABLE orders DROP COLUMN terms;` and delete 0015's row from `drizzle.__drizzle_migrations` (its `created_at` is
  0015's journal `when`). Terms chosen on orders since the release are then lost; containers keep their own terms.
