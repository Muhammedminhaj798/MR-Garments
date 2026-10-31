# Batch 1 backend contracts

Rules every Batch 1 agent follows. The coordinator owns this file and every file marked coordinator-owned.
Business rules come from the approved decision sheet (B1-B9, C5, U36, U37, Q7, Q9, Q11), kept word for word in
`docs/batch1-decisions.md` with the acceptance tests (Part 6), and are never changed here.

## Runtime and commands

Use the portable Node 22 for every backend command: prefix with `PATH=/d/SDEC/tools/node-22:$PATH` (Git Bash) or
`$env:PATH = "D:\SDEC\tools\node-22;" + $env:PATH` (PowerShell). Never run `npm install`; packages are installed once.

| Command | Purpose |
| --- | --- |
| `npm run validate` | lint, typecheck and tests (run before reporting) |
| `npm test` | API tests against **this worktree's own database** (reset at the start of the run) |
| `npm run dev` | API on this worktree's port, using `.env` |
| `npm run db:reset` | Drop, migrate and seed **this worktree's own database** (refuses `mr_garments_dev`) |
| `scripts/start-e2e.ts` | Started by the frontend's browser tests only: resets this worktree's test database, seeds it with `E2E_PASSWORD`, serves the API |

Never open, print or copy `.env*` files, and never run `psql`, `createdb`, `dropdb` or raw SQL against any database.

## API conventions

- Base path `/api/v1`, JSON only. Dates `YYYY-MM-DD`, timestamps ISO 8601, ids UUID, roles exactly as displayed
  (`Management`, `Procurement`, `Accounts`, `China staff`, `India staff`, `Warehouse staff`), statuses `Active`/`Inactive`.
- Requests that change data must send `Content-Type: application/json` (send `{}` when there is no body) and come
  from `APP_ORIGIN`; otherwise 403 `origin_rejected` / 415 (`src/http/same-site.ts`).
- Errors use one body: `{ "error": { "code", "message", "fields"? } }` (`src/http/errors.ts`). Field errors are 422
  `validation_failed` with `fields` keyed by the form's field names; duplicates are 409 with `fields`.
- Validate input only with `parse(schema, req.body)` (`src/http/validate.ts`) and strict Zod objects. Put the approved
  message text (M1-M26) in the schema, so `fields` carries exactly what the user sees.
- Status codes per E1-E14: 400 malformed, 401 signed out, 403 not allowed, 404 not found, 409 duplicate or conflict,
  413 too large, 422 rule broken, 429 too many attempts.

## Endpoint formats fixed in Phase 0

These come from the approved Batch 1 endpoint list. Agents implement them exactly; a change needs the coordinator.

**ME-1 `GET /me`** (coordinator, `src/modules/core/core.routes.ts`) returns
`{ id, name, initials, email, role, office: { id, name, type } | null, accessLabel, shell, landing, stages[], permissions }`.
`landing` is not in the approved field list; it was added and approved on 2026-10-26. It is computed by `landingPath`
(B3, L-b): China staff go to `/home`; India and Warehouse staff go to their first granted stage page, or `/home`
when they have none; everyone else goes to `/`. The frontend uses it after sign-in and for blocked pages (P-b).

**AUTH-1 `POST /auth/login`** (A1): request `{ email, password, keepSignedIn }`. Email is trimmed and lower-cased.
Success is 200 `{ user: Me }` (build it with `toMe(await findCurrentUser(db, id))` from `src/auth/current-user.ts`)
and sets the `mrg.sid` cookie through `establishSession`, which
replaces the session ID; `last_sign_in_at` is set. `keepSignedIn` gives a 30-day cookie; otherwise the cookie ends
with the browser. A wrong password, an unknown email and an inactive user all get the same 401
`invalid_credentials` (M2). Throttling (`signInRateLimit`, B9.1) gives 429 (M3).

**AUTH-2 `POST /auth/logout`** (A1): signed in; 204, ends the session and clears the cookie (`endSession`); 401 when
signed out.

**Password policy (2026-10-29, not yet released).** Nobody sets their own password in the application; there are no
invite, reset or password links and no emails.
- **USR-3 `POST /users`** requires `password`, the user's initial sign-in password, checked against B9.10 (422
  `fields.password`: "Enter a password." / M8 / M9) and stored only as an argon2id hash with `password_changed_at`.
- **USR-4 `PATCH /users/{id}`** accepts an optional `password` with the same checks. For another user it replaces
  the hash, sets `password_changed_at` and signs that user out everywhere. For the caller's own account any `password`
  key, whatever its value, is 403 `password_change_disabled` ("Ask another Management user to set your password."),
  checked before the body, and nothing is saved.
- **AUTH-5 `POST /auth/change-password`** and **AUTH-4 `POST /auth/reset-password`** answer 403
  `password_change_disabled` ("Passwords are set by a Management user.") to everyone, signed in or not. **PRF-2
  `PATCH /profile`** refuses a `password` key with 400 like any other unknown key.
- A user with no password hash (added before this policy; their invite link was only printed in development) can't
  sign in (AUTH-1 401) until Management sets a password on Edit user. Existing hashes are unchanged and keep working.
- The last active Management user can't be demoted or deactivated (USR-4 409 `last_management`, M20, B8.2/B8.3).
- **USR-4** also refuses setting the caller's **own** status to Inactive: 409 `own_account`, `fields.status` = "You
  can't deactivate your own account." (D3, sprint 2026-10-31, proposed wording). Checked after the body, before the
  user is looked up; nothing is saved.
- **USR-5 `DELETE /users/{id}`** (D3, sprint 2026-10-31, proposed wording), `requirePermission("admin", "Full")`:
  removes an account only when it is unused. 204 when removed (grants, password links and the user's own
  notifications go by their cascades; nothing else is deleted); 404 `not_found` for an unknown or malformed id; 409
  `own_account` "You can't remove your own account."; 409 `last_management` (M20) for the last active Management user;
  409 `in_use` "{Name} has {signed in and recorded 1 order and 3 receipts}, so they can't be removed. Deactivate them
  instead." when `last_sign_in_at` is set or any author column names the user. Those columns have no foreign key and
  are listed in `REFERENCES` (`src/modules/users/users.routes.ts`); a test fails if a `*_by` uuid column is missing
  from it. The user row is locked (`for update`) before the checks.
- No response includes `password` or `passwordHash`; failed queries are logged without their parameters.
- Operators can still reset a Management password with `scripts/reset-admin-password.ts` (docs/operator-commands.md).

**Lists.** Every list endpoint returns rows in creation order (`created_at`, then `name`). The seed gives seeded rows
increasing creation times in `master.ts` order, which is the order the references show; new rows come last.

**MD-1 `GET /suppliers?search=&status=`** (A4): array of
`{ id, name, contactPerson, phone, city, address, notes, currency, openOrders, status }`; `openOrders` is 0 in
Batch 1. **MD-2 `POST /suppliers`** (A4): `{ name*, city, contactPerson, phone, currency: "CNY", address, notes }`,
201 `{ supplier }` (Active, 0 open orders); 409 `name_exists` with `fields.name` (M22); 422 for a missing name (M21).

**Read-only master data** (A3 builds them; A4's Settings tabs read them). All are `GET` only, need
`requirePermission("admin", "Full")` (Management only, B6), and return an array. `POST` and `PATCH` on these paths
are not part of Batch 1 and fall through to 404.

| ID | Path | Row |
| --- | --- | --- |
| MD-4 | `/shipping-agents` | `{ id, name, contactPerson, phone, officeCity, activeContainers, status }` (`activeContainers` 0) |
| MD-7 | `/clearing-agents` | `{ id, name, contactPerson, phone, port, containersCleared, status }` (`containersCleared` 0) |
| MD-10 | `/transport-companies` | `{ id, name, contactPerson, phone, tripsSoFar, status }` (`tripsSoFar` 0) |
| MD-13 | `/locations` | `{ id, name, type, country, address, staff: string[], status }`; `staff` is the names of the **active** users at that location, in list order (B6) |
| MD-16 | `/teams` | `{ id, name, piecesInStock, landedCostOfStockInr, averagePerPieceInr, status }`; 0, 0 and `null` in Batch 1 (shown as "–", 5.6) |
| MD-19 | `/items` | `{ id, name, countedIn, perBundle, bundleLabel, usedInOrders: string[], status }`; exactly one of `perBundle` (whole number) and `bundleLabel` is set, the other is `null`; `usedInOrders` is `[]` |

Optional filters on MD-1 and these lists: `status` is `Active` or `Inactive` (omitted: all); `search` keeps rows where
one of the tab's searchable columns contains it, ignoring case and spaces, as the frontend's `filterRecords` does.
Searchable columns: name, contact person and phone (suppliers, agents, transport companies); name, address and staff
(locations); name (teams); name and orders (items). Unknown query keys or another `status` value give 400.

## Orders: edit and delete (sprint 2026-10-31, not released)

ORD-1 to ORD-4 are in `docs/live-screens-contracts.md`. Both routes are in `src/modules/orders/order-detail.routes.ts`;
`:po` that isn't `PO-<digits>`, or an unknown PO, is 404 `not_found` "Order not found.".

| Id | Method and path | Permission | Owner |
| --- | --- | --- | --- |
| ORD-5 | `PATCH /orders/:po` | ordersEdit >= Enter (Management, Procurement) | BE-orders |
| ORD-6 | `DELETE /orders/:po` | admin = Full (Management) | BE-orders |

- **ORD-5** body (strict, at least one key; empty or unknown keys 400): `orderDate?`, `deliveryDate?`,
  `lines? {id?, itemId, quantity, rateCny}[]` (1-50, ORD-3 limits and messages). `lines` replaces the list in array
  order: a line with `id` updates that line, one without is added, a saved line not sent is removed; `position` is
  the array index. 200 `{ order: { id, po, stage, orderDate, deliveryDate } }`. Stage 6: 409 `order_locked` "This
  order has reached the warehouse, so it can't be changed."; stages 2-5 with `orderDate` or `lines`: 409
  `order_locked` "Goods have been received for this order, so only the delivery date can change.". 422 on
  `deliveryDate` for BR-09 (saved values for keys not sent); on `lines` for an inactive or unknown item (a line keeping
  its saved item is not re-checked), an `id` that isn't one of this order's lines (or repeated) ("A line on this order
  changed. Reload the order and try again."), or a total (sum of quantity x rateCny) below the paid payments ("The
  order total can't be less than the ¥1,23,456.78 already paid.", 2 decimals, Indian grouping). One transaction with
  the order row locked `for update`.
- **ORD-6** 204 when deleted with its own lines. 409 `in_use` "This order has {2 payments, 1 receipt and 1
  container}, so it can't be deleted." when it has payments (any status), receipts (its own, or any holding one of
  its lines), containers or warehouse receipts holding one of its lines. The order row and its lines are locked
  `for update` before counting; a foreign-key violation (23503) gives the same 409 ("other records"). Notifications
  are left as they are.

## Authentication and permissions (coordinator-owned)

- Sessions: `src/auth/session.ts` (`establishSession`, `endSession`, `renewSessionId`, `signOutEverywhere`).
- The signed-in user is re-read on every request into `req.user` (`src/auth/current-user.ts`); guard routes with
  `requireUser` or `requirePermission(capability, minimum)`. Never write your own session or permission checks.
- The role matrix, stage grants (Q7), access labels, initials and landing pages: `src/permissions/matrix.ts`.
- Passwords: `src/auth/passwords.ts` (argon2id, `passwordProblems`). Password links were removed with the password
  policy; the `password_tokens` table stays but nothing issues or reads it. Sign-in throttling: `src/auth/rate-limit.ts`.

## Database (coordinator-owned)

Schema: `src/db/schema/` (migrations 0001 core, 0002 master data). Only the coordinator adds migrations, and a merged
migration is never edited. If you need a column or table, report it as a request; do not change the schema.

## Ownership

| Owner | Files |
| --- | --- |
| Coordinator | everything not listed below |
| A1 Auth | `src/modules/auth/login.routes.ts` and new files `src/modules/auth/login.*` |
| A2 Users | `src/modules/users/**` |
| A3 Read-only master data | `src/modules/master-data/readonly.routes.ts` and new files `src/modules/master-data/readonly.*` |
| A4 Suppliers | `src/modules/master-data/suppliers.routes.ts` and new files `src/modules/master-data/suppliers.*` |
| A5 Passwords | `src/modules/auth/password.routes.ts` and new files `src/modules/auth/password.*` |

Tests sit next to the code as `*.test.ts` and use `src/test/harness.ts` (`createTestContext`, `resetData`, `api`,
`signInAs`, `SEEDED`, `TEST_PASSWORD`).
