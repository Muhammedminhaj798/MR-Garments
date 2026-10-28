# Wave 3 contracts: Settings CRUD, Clearing, Transport, Warehouse, Landed Cost, Reports

Written 2026-10-28 by the integration lead (Agent 7). Everything in `docs/contracts.md` and
`docs/live-screens-contracts.md` still applies: Node 22, `/api/v1`, JSON only, the one error body, strict Zod bodies
through `parse()`, the same-site check, `requirePermission`, dates `YYYY-MM-DD`, "today" in India
(`Asia/Kolkata`), CNY money with 2 decimals, `rateInr` = INR per CNY. INR amounts in this wave are numbers with
2 decimals. Lists are arrays.

**Rule status.** Rules marked **(default)** were chosen by the lead from the reference screens and the existing
model. They are not owner-approved yet and are listed in the final report for the project owner.

## 1. Migration 0004 (foundation, coordinator-owned)

`src/db/schema/stages.ts`, `drizzle/0004_clearing_transport_warehouse.sql`. Applied to test and agent databases
only (tests reset them). **Never applied to `mr_garments_dev` without the owner's approval.**

| Table | Columns (all `not null` unless marked null) |
| --- | --- |
| `clearings` | `id`, `container_id` (unique, FK containers, cascade), `clearing_agent_id` (FK), `arrived_on`, `handed_on` null, `bill_of_entry` default '', `duty_paid_on` null, `cleared_on` null, `goods_value_inr` null, `customs_duty_inr`, `other_duties_inr`, `agent_charges_inr`, `port_charges_inr` (default 0, >= 0), `status` (`in_clearing` \| `cleared`, default `in_clearing`), timestamps, `created_by`, `updated_by` |
| `transports` | `id`, `container_id` (unique, FK containers, cascade), `transport_company_id` (FK), `destination_id` (FK locations), `lr_number`, `vehicle_number`, `driver_name` default '', `driver_phone`, `bundles_loaded` (>= 0), `loaded_on`, `loaded_from` default '', `loaded_by` default '', `unloaded_on` null, `bundles_received` null (>= 0), `received_by` default '', `short_remark` default '', `freight_inr`, `handling_inr` (default 0, >= 0), `status` (`on_road` \| `unloaded`, default `on_road`), timestamps, `created_by`, `updated_by` |
| `warehouse_receipts` | `id`, `transport_id` (unique, FK transports, cascade), `location_id` (FK locations), `received_on`, `received_by`, `bundles_received` (>= 0), `status` (`draft` \| `stocked`, default `draft`), timestamps, `created_by`, `updated_by` |
| `warehouse_receipt_lines` | `receipt_id` (FK, cascade), `order_line_id` (FK order_lines, cascade), `team_id` (FK teams), `quantity` (>= 0); PK (`receipt_id`, `order_line_id`, `team_id`) |

Database checks: `clearings.status = 'cleared'` needs `cleared_on` and `duty_paid_on`; `transports.status =
'unloaded'` needs `unloaded_on` and `bundles_received`. The test harness truncates the new tables with the rest.
`handling_inr` is the transport form's "Loading and unloading" charge. `created_by` and `updated_by` hold the
signed-in user's id (no foreign key, as in 0003).

**(default) One clearing, one road trip and one warehouse receipt per container.** Splitting a container over several
trucks is not supported in this version.

## 2. Order stages and the lifecycle

Supplier -> receiving (REC-3, 1->2) -> container (CON-3, 2->3; CON-5 loading -> sea -> arrived) -> clearing ->
transport -> warehouse. Each write below moves every order with goods in that container forward, in the same
transaction, and never backward: `update orders set stage = N where id in (...) and stage < N`.

| Event | Precondition (else 409, message below) | Orders move to |
| --- | --- | --- |
| First save of a container's clearing (CLR-3) | container `status = 'arrived'` (`container_not_arrived` "This container hasn't arrived at the port yet.") | 4 In clearing |
| Clearing marked cleared (CLR-3 `complete: true`) | clearing not already cleared | (stays 4) |
| First save of a container's road trip (TRN-3) | its clearing is `cleared` (`not_cleared` "This container hasn't been cleared yet.") | 5 On the road |
| Trip marked unloaded (TRN-3 `complete: true`) | trip not already unloaded | (stays 5) |
| Warehouse receipt stocked (WH-3 `complete: true`) | its trip is `unloaded` (`not_unloaded` "These goods haven't been unloaded yet.") | 6 Received |

- The move is `moveOrdersToStage(tx, containerId, stage)` in `src/modules/stages-shared.ts` (foundation).
- **(default)** An order's stage is the furthest step any of its goods have reached (the rule CON-3 already uses).
- A cleared clearing, an unloaded trip and a stocked receipt are final: any later write is 409 `record_closed`
  "This record is complete and can't be changed." Corrections are not supported in this version **(default)**.
- Rows are locked (`for update`) inside the transaction, so two simultaneous "complete" calls can't both succeed.

## 3. Permissions

| Module | Read | Write |
| --- | --- | --- |
| Settings (all seven tabs) | `admin` Full | `admin` Full (Management only, B6) |
| Clearing (India) | `clearing` >= View | `clearing` >= Enter |
| Transport | `transport` >= View | `transport` >= Enter |
| Warehouse | `warehouse` >= View | `warehouse` >= Enter |
| Landed cost | `landedCost` >= View | - |
| Reports | `reports` >= View | - |

Cost figures (INR per piece, landed cost) in Warehouse responses are included only when the user has
`landedCost` >= View; otherwise the cost fields are `null` (the warehouse list says "shown to management only").

## 4. Settings: create, edit, deactivate (Agents 1-4)

Same rules for all seven tabs:

- `POST /<path>`: strict body, 201 `{ <key>: Row }` with the full list row (counts included). New rows are Active.
- `PATCH /<path>/:id`: strict body, at least one key (else 400 `bad_request`); the POST fields that are editable plus
  `status` (`Active` | `Inactive`). 200 `{ <key>: Row }`. A malformed or unknown id is 404 `not_found`
  "<Noun> not found.".
- Name: trimmed, required, at most 200 characters. Duplicates are case-insensitive (the existing unique indexes on
  `lower(name)` decide, so two simultaneous adds can't both win): 409 `name_exists` with `fields.name`
  "A <noun> with this name already exists.". Empty: 422 `fields.name` "Enter the <noun> name.".
- Other text fields: trimmed, optional, at most 200 characters (address and notes 1000). Too long: 422
  `fields.<field>` "Use 200 characters or fewer." ("Use 1000 characters or fewer." for address and notes).
- **No delete.** Records are referenced by orders, containers and users; "Deactivate" is `PATCH { status: "Inactive" }`.
  Inactive records drop out of every option list (they already select `status = 'Active'`) and stay on existing
  records. The frontend asks for confirmation before deactivating.
- Lists keep their current shapes; the counts that were fixed at 0 become real:

| Tab | Path, key | Editable fields | Real counts |
| --- | --- | --- | --- |
| 1 Suppliers (A1) | `/suppliers`, `supplier` | name, city, contactPerson, phone, address, notes (currency stays CNY) | `openOrders`: this supplier's orders with `stage < 6` |
| 2 Shipping agents (A1) | `/shipping-agents`, `shippingAgent` | name, contactPerson, phone, officeCity | `activeContainers`: this agent's containers with status `loading` or `sea` |
| 3 Clearing agents (A2) | `/clearing-agents`, `clearingAgent` | name, contactPerson, phone, port | `containersCleared`: this agent's clearings with status `cleared` |
| 4 Transport companies (A2) | `/transport-companies`, `transportCompany` | name, contactPerson, phone | `tripsSoFar`: this company's trips (any status) |
| 5 Offices & warehouses (A3) | `/locations`, `location` | POST: name, type, address; PATCH: name, address, status | `staff` as today |
| 6 Teams (A3) | `/teams`, `team` | name | stock from stocked warehouse receipts, see 6.3 |
| 7 Item list (A4) | `/items`, `item` | name, countedIn, perBundle / bundleLabel | `usedInOrders`: distinct PO numbers with a line of this item, PO order |

- Locations: `type` is `China office` | `India office` | `Warehouse`; the server sets `country` (China office ->
  China, otherwise India). **(default)** The type can't change after creation (PATCH doesn't accept it), because
  receipts, users and trips rely on it.
- Items: `countedIn` is `Pieces` | `Metres`; exactly one of `perBundle` (whole number 1-100000) and `bundleLabel`
  (text) is set, the other `null` (422 `fields.perBundle` "Enter the pieces per bundle or a bundle label."). **(default)**
  `countedIn` can't change once the item is on an order: 409 `item_in_use` "This item is on an order, so its unit
  can't change.".
- Frontend (foundation): build each tab's dialogs on `features/settings/settings-dialog.tsx`: `useSettingsDialog(path)`
  (`open` "add" | "edit" | null, `id`, `close`, `saved(message)`), `SettingsDialog`, `SettingsDialogFooter`,
  `setApiErrors(error, setError)` and `ConfirmDialog` (deactivation). The add action links to `addHref(path)`
  (`?dialog=add`); Edit already links to `editHref(path, id)` (`?dialog=edit&id=<id>`). Body and response types are
  in `src/lib/api/types.ts` (`Create<Entity>Body`, `Update<Entity>Body`, `<Entity>Response`).

## 5. Clearing, Transport, Warehouse (Agent 5)

Agent 5 owns the response and body shapes and records them in section 8 before finishing. Required endpoints:

| Id | Method and path | Purpose |
| --- | --- | --- |
| CLR-1 | `GET /clearings` | Clearing list (26): KPIs + one row per arrived container (waiting, in clearing, cleared) + agent filter options |
| CLR-2 | `GET /clearings/:containerId` | Clearing form (25): container, its saved clearing or null, goods (PO, item, bundles, qty, unit), terms, supplier(s), active clearing agents with contact/phone |
| CLR-3 | `PUT /clearings/:containerId` | Save draft (`complete: false`) or "Mark cleared, hand to transport" (`complete: true`) |
| TRN-1 | `GET /transports` | Transport list (28): one row per trip + containers ready for transport (cleared, no trip yet) |
| TRN-2 | `GET /transports/:containerId` | Transport form (27): container, clearing (cleared on, agent), saved trip or null, goods, active transport companies, active warehouses |
| TRN-3 | `PUT /transports/:containerId` | Save draft (loading details) or "Save and mark unloaded" (`complete: true`) |
| WH-1 | `GET /warehouse-receipts` | Warehouse list (30): one row per order per stocked receipt + trips ready to receive |
| WH-2 | `GET /warehouse-receipts/:transportId` | Receive goods (29): trip (vehicle, LR, container, bundles loaded), saved receipt or null, lines (order line, PO, item, unit, quantity in the container), active teams, active warehouses, cost so far (or null, section 3) |
| WH-3 | `PUT /warehouse-receipts/:transportId` | Save draft or "Save and add to stock" (`complete: true`) |

Rules:
- **Clearing:** `clearingAgentId` active; `arrivedOn` required, not after today, not before the container's
  `loadedOn`; `handedOn`, `dutyPaidOn`, `clearedOn` not after today and not before `arrivedOn`; `clearedOn` not
  before `dutyPaidOn`; amounts 0 to 999,999,999,999.99. `complete: true` also needs `billOfEntry`, `dutyPaidOn` and
  `clearedOn`. Agent contact and phone come from the clearing agent master (read-only on the form). The total
  clearing cost is the sum of the four charges; `goodsValueInr` is information only.
- **Transport:** company active; destination an active `Warehouse`; `lrNumber`, `vehicleNumber`, `driverPhone`
  required; `bundlesLoaded` > 0; `loadedOn` not before the clearing's `clearedOn`, not after today. `complete: true`
  needs `unloadedOn` (not before `loadedOn`, not after today), `bundlesReceived` (0 to `bundlesLoaded`) and
  `receivedBy`; when `bundlesReceived < bundlesLoaded`, `shortRemark` is required: 422 `fields.shortRemark` "Add a
  remark about the short bundles." (screen 27's hint). Charges: freight, loading and unloading (INR).
- **Warehouse:** location an active `Warehouse`; `receivedOn` not before the trip's `unloadedOn`, not after today;
  `receivedBy` required; `bundlesReceived` >= 0; splits are whole numbers >= 0 for active teams and only for order
  lines in that container; per line the split total can't exceed the container quantity (422 `fields.lines`).
  **(default)** `complete: true` needs at least one piece assigned; unassigned pieces are allowed (they count as not
  received) and the form shows how many are left unassigned.
- Draft saves need only what the database needs (clearing: agent and `arrivedOn`; trip: everything except the
  unloading fields; receipt: location, date, received by, bundles).

## 6. Landed cost (foundation function, Agent 6 endpoint)

### 6.1 The shared function

`src/modules/costs/landed-cost.ts` (foundation, coordinator-owned; Agents 3, 5 and 6 call it and never copy it):
`loadLandedCosts(db, orderIds?: string[]): Promise<Map<string, OrderLandedCost>>`.

```ts
type OrderLandedCost = {
  orderId: string;
  goodsInr: number;          // paid payments to the supplier, each at its own rateInr
  seaFreightInr: number;     // paid payments to an agent (FOB sea freight); 0 for CNF
  clearingInr: number | null;   // allocated clearing charges; null until a container of this order has a clearing
  transportInr: number | null;  // allocated freight + handling; null until a container of this order has a trip
  totalInr: number;          // goods + sea freight + (clearing ?? 0) + (transport ?? 0)
  stockedPieces: number;     // quantity given to teams on stocked receipts
  perPieceInr: number | null;   // totalInr / stockedPieces, null while nothing is stocked
  final: boolean;
  waitingFor: "supplier payment" | "duty" | "transport" | "warehouse" | null; // first missing part, null when final
};
```

`db` may be a transaction. Every order asked for is in the map (every order when `orderIds` is omitted), with or
without costs. The figures come from the pure `computeLandedCosts(facts)`; every amount, `perPieceInr` included, is
rounded to 2 decimals.

### 6.2 Rules (default)

- **Allocation:** a container's clearing total and trip cost are shared between the orders in it by goods value
  (sum of `quantity * rateCny` of each order's lines in that container); by quantity when the container's value is 0.
  Rounded to 2 decimals per share.
- **Final** when the order's balance is 0 or less, the order is at stage 6, and every container carrying it has a
  cleared clearing, an unloaded trip and a stocked receipt. Otherwise it is an estimate, and `waitingFor` names the
  first missing part in the order supplier payment, duty, transport, warehouse. An order with no container yet
  waits for duty once the supplier is paid.
- **Balance** here is the order value less its paid **supplier** payments: agent payments are sea freight, not goods.
  (PAY-1's `balanceCny` subtracts agent payments too.)
- **CNF:** sea freight is 0 when every container carrying the order is CNF, and agent payments on such an order are
  left out. Before the order is in a container, agent payments count.
- **Per piece** is an order average: one cost per unit for every line of the order (per-item cost is a later step).
- Metres and pieces are added together in `stockedPieces` (an order is normally one unit).

### 6.3 Teams stock (Agent 3)

Per team, over stocked receipt lines: `piecesInStock` = sum of quantity; `landedCostOfStockInr` = sum of
`quantity * perPieceInr` of the line's order (orders with `perPieceInr` null add 0); `averagePerPieceInr` =
`landedCostOfStockInr / piecesInStock`, or `null` when no pieces. Stock never goes down in this version (there is
no sales module).

### 6.4 Endpoints (Agent 6)

`GET /landed-cost` (landedCost >= View): one row per order that has any cost so far, with the
`OrderLandedCost` figures plus PO, item (main line), quantity, terms (CNF/FOB of its containers), supplier, the teams
split, and the goods payments (date, kind, CNY, rate, INR). Agent 6 records the shape in section 8.

## 7. Reports (Agent 6)

`GET /reports/<name>` (reports >= View), server-side aggregation over the persisted tables, optional filters
`from`, `to` (dates) and `supplierId` where the report uses them (bad values 400). Names: `order-status`,
`deliveries-per-day`, `ordered-vs-received`, `containers-timeline`, `payments-per-supplier`,
`landed-cost-by-month`, plus `summary` for the hub's stat strips. Export: CSV built in the browser from the same
data (no new dependency); Excel/PDF only if feasible with what is installed, otherwise the existing D5 toast. The
hub's "recent downloads" list has no table behind it: show the empty state, don't store downloads.

## 8. Response shapes recorded by the owners

Each owner appends its endpoint shapes here (Agent 5: CLR, TRN, WH; Agent 6: landed cost, reports) in the same
style as `live-screens-contracts.md`. Frontend types live in the owner's own file (section 9).

## 9. Files and owners

Each agent owns a vertical slice: its backend routes and tests, and its frontend feature, queries, types and e2e.
Shared files change only through Agent 7.

| Owner | Backend (`MR-Garments-Backend-New`) | Frontend (`MR-Garments-frontend`) |
| --- | --- | --- |
| A7 integration lead | `src/db/**`, `drizzle/**`, `src/modules/index.ts`, `src/modules/stages-shared.ts`, `src/modules/master-data/list-query.ts`, `src/modules/costs/**`, `src/test/**`, `docs/**` (except section 8) | `src/lib/**`, `src/components/**`, `src/config/**`, `src/types/**`, `src/features/settings/settings-list.tsx`, `settings-dialog.tsx`, `settings-logic.ts`, `docs/**`, configs, existing e2e specs |
| A1 Suppliers, Shipping agents | `master-data/suppliers.*`, `master-data/shipping-agents.*` | `features/settings/suppliers-*`, `shipping-agents-*`, `add-supplier-dialog*`, `e2e/wave3-a1.spec.ts` |
| A2 Clearing agents, Transport companies | `master-data/clearing-agents.*`, `master-data/transport-companies.*` | `features/settings/clearing-agents-*`, `transport-companies-*`, `e2e/wave3-a2.spec.ts` |
| A3 Offices & warehouses, Teams | `master-data/locations.*`, `master-data/teams.*` | `features/settings/offices-*`, `teams-*`, `e2e/wave3-a3.spec.ts` |
| A4 Item list | `master-data/items.*` | `features/settings/items-*`, `e2e/wave3-a4.spec.ts` |
| A5 Clearing, Transport, Warehouse | `src/modules/stages/**` | `features/clearing/**`, `features/transport/**`, `features/warehouse/**`, `app/(app)/{clearing,transport,warehouse}/**`, `src/lib/api/stages-types.ts`, `e2e/wave3-a5.spec.ts` |
| A6 Landed cost, Reports | `src/modules/reports/**` | `features/landed-cost/**`, `features/reports/**`, `app/(app)/{landed-cost,reports}/**`, `src/lib/api/reports-types.ts`, `e2e/wave3-a6.spec.ts` |

Settings row types stay in `src/lib/api/types.ts`; the foundation adds every Settings body type there, so A1-A4
don't edit it. A1-A4 put their tab's types, if any, in their own files.

## 10. Databases and tests

| Agent | Database (`.env.test` in its backend worktree) | Lock |
| --- | --- | --- |
| A1-A5 | `mr_garments_a1` .. `mr_garments_a5` | none: the database is the agent's own |
| A6, A7 | `mr_garments_test` | `/d/Temp/claude/mrg-test-db.lock` (below) |

A test run resets that database. Never run tests, `db:reset` or `db:migrate` against `mr_garments_dev`. Never open,
print or copy `.env*` files. Run Node 22 directly (npm writes logs to the nearly full C: drive):

```bash
PATH=/d/SDEC/tools/node-22:$PATH
node node_modules/vitest/vitest.mjs run src/modules/<yours>        # backend tests
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit     # backend typecheck
node node_modules/eslint/bin/eslint.js .                           # backend lint
```

A6 and A7 wrap backend test runs in the lock:
`LOCK=/d/Temp/claude/mrg-test-db.lock; until mkdir "$LOCK" 2>/dev/null; do sleep 3; done; <run>; status=$?; rmdir "$LOCK"`.

Frontend (Node 20 on PATH): `npm run lint`, `npm run typecheck`, `npx vitest run src/features/<yours>`. **No
`next build` and no Playwright in A1-A6**: the machine runs out of memory and browsers stall. A7 runs the browser tests
once, at integration.
