# Batch 1 approved decisions (reference for every agent)

**Status: approved by the user on 2026-10-26.** Every "Recommended" option below, and every "Proposed" value, string
and default, was approved as written (Group A, then Group B: B9 9.1-9.18, U36 E1-E14 and M1-M26, U37 K1-K8, 5.8).
Options that were not recommended are rejected. The Head office city stays deferred (U28): never create, seed or guess
it. Forgot password (AUTH-3) is not part of Batch 1 (5.9 (i)).

Later approved additions: the ME-1 `landing` field and the endpoint formats in `docs/contracts.md`; work allocation F1
(each agent's assignment). The text below is the approved decision sheet, unchanged apart from this header. Where it
says "Proposed" or "proposed", read "approved". File and line references point to the frontend at `ca94b78`.

**Superseded by the password policy of 2026-10-29** (product owner; see `docs/contracts.md`, "Password policy"):
Management types each new user's initial password on Add user and can set a new password for another user on Edit
user; nobody changes or resets their own password in the application, and no links or emails exist. This replaces
B1.0 option (b) with option (c), retires B1.4-B1.9, B1.11 and B1.12, C5 R1 (now R2 plus "set a new password"), B9.11
and B9.12, the link part of B9.16, screen S5 (Change password), the Set password page, AUTH-4 and AUTH-5 (both now
403 `password_change_disabled`), and acceptance tests AT-P1 to AT-P3 and AT-U8 to AT-U10. Still in force: B1.1-B1.3
(seed passwords), B1.10 and B9.9 (argon2id), B9.10 (rules, checked on USR-3 and USR-4), 5.9 (i) (no Forgot password),
and the operator reset command (option (d)).

---

## Part 1. Batch 1 scope and endpoints

### Screens in scope

| # | Screen | Route | Screenshot |
|---|---|---|---|
| S1 | Sign in, sign-out, and the app shell driven by the signed-in user | `/login`, all layouts | 01 ✓, 04 ✓, 39 ✓ |
| S2 | Users list | `/users` | 47 ✓ |
| S3 | Add or edit user | `/users/edit?id=` | 48 ✓ |
| S4 | Settings › Suppliers, with the Add supplier dialog | `/settings/suppliers` | 40 ✓, 53 ✓ |
| S5 | Change password | `/change-password` | 03 ✓ |
| Optional (B6) | Roles tab and six Settings tabs, read-only | `/users/roles`, `/settings/*` | 49 ✓, 41–46 † |
| Conditional (B1 b) | Set password page (new) | `/set-password?token=` | layout reused from 03 ✓ |

**Out of scope:** orders, payments, calendar, receiving, containers, clearing, transport, warehouse, landed cost, reports, dashboard data, profile data, notifications, Forgot password (unless you choose 8.9), and editing suppliers.

### Endpoints (all proposed; none built)

| ID | Method and path | Purpose | Who can call it | Included |
|---|---|---|---|---|
| AUTH-1 | `POST /api/v1/auth/login` | Sign in | Anyone; rate-limited (9.1) | Core |
| AUTH-2 | `POST /api/v1/auth/logout` | Sign out | Signed-in users | Core |
| AUTH-5 | `POST /api/v1/auth/change-password` | Change password | Signed-in users | Core |
| ME-1 | `GET /api/v1/me` | Current user, permissions and stages | Signed-in users | Core |
| USR-1 | `GET /api/v1/users?search=&role=&status=` | Users list | Management only | Core |
| USR-2 | `GET /api/v1/users/{id}` | One user for the edit form | Management only | Core |
| USR-3 | `POST /api/v1/users` | Add user | Management only | Core |
| USR-4 | `PATCH /api/v1/users/{id}` | Save user | Management only | Core |
| ROL-1 | `GET /api/v1/roles` | Role matrix | Management only | Core |
| MD-1 | `GET /api/v1/suppliers?search=&status=` | Suppliers list | Management only | Core |
| MD-2 | `POST /api/v1/suppliers` | Add supplier | Management only | Core |
| MD-4 | `GET /api/v1/shipping-agents?…` | Read-only tab | Management only | Only with B6 (a) |
| MD-7 | `GET /api/v1/clearing-agents?…` | Read-only tab | Management only | Only with B6 (a) |
| MD-10 | `GET /api/v1/transport-companies?…` | Read-only tab | Management only | Only with B6 (a) |
| MD-13 | `GET /api/v1/locations?…` | Read-only tab | Management only | Only with B6 (a) |
| MD-16 | `GET /api/v1/teams?…` | Read-only tab | Management only | Only with B6 (a) |
| MD-19 | `GET /api/v1/items?…` | Read-only tab | Management only | Only with B6 (a) |
| AUTH-4 | `POST /api/v1/auth/reset-password` | Set password from a link | Holder of a valid link | Only with B1 (b) |
| AUTH-3 | `POST /api/v1/auth/forgot-password` | Request a reset link | Anyone | Only with 8.9 "Yes" |
| – | `GET /api/v1/health` | Lets tests check the API and database are up (not a product feature) | Anyone | Infrastructure |

**Totals:** 11 core + 6 (B6) + 1 (B1 b) + 1 (8.9) + 1 health check. That is 20 at most and 12 at least.

### Database tables

**Migration 0001**, needed in every case:
- `citext` (extension for case-insensitive email).
- `locations`, `users`, `user_stage_grants`, `password_tokens`, `session`, `suppliers`.

**Migration 0002**, needed for B6 and for seeding all master data:
- `shipping_agents`, `clearing_agents`, `transport_companies`, `teams`, `items`.

**Seed:**
- **Included:** the master records from `src/mocks/data/master.ts`, the 8 users and their stage grants (B7), and development passwords (B1).
- **Deferred:** no Head office location yet. Suresh, Priya and Anita have no office until the city is given.
- **Not seeded:** no orders, payments or stage records (decision Q11).

---

## Part 2. Decisions B1–B9 and C5

### B1. How users get a first password

**Existing**
- **48 ✓:** the Password field shows the placeholder "Set by user at first sign-in".
- **01 ✓:** "Need access? Ask your manager for an account."
- **02 † (from code):** Forgot password shows "Forgot your password?" / "Enter your email or username. We will send a link to reset your password." (`forgot-password-screen.tsx:23-24`).
- **03 ✓:** the Change password layout.
- **Routes:** none of the 52 routes can set a password from a link.
- **Q9 (decided):** links are written to the development log.

**B1.0, overall approach.** You can choose more than one.

| Option | Security | Business |
|---|---|---|
| (a) Development-only seeded password | Exists only in your local database; never committed or shipped | Testing can start immediately; users added later still can't sign in |
| (b) Set password page reusing 03's layout without "Current password", opened from an invite or reset link | Links are random, expire, are stored hashed and work only once | Completes "add user, then the user signs in"; a new page variant that needs wording approval (8.2) |
| (c) Management types a temporary password on the edit form | Management knows users' passwords; conflicts with 48 and C5 | No new page |
| (d) An operator command sets a password | Needs server access | No UI; development and operations only |

**Recommendation:** (a) + (b).
**Your choice:** any combination of (a), (b), (c), (d).

| Sub-decision | Options | Recommended |
|---|---|---|
| B1.1 Development password form | (i) one shared password you choose, kept in the git-ignored API `.env` as `SEED_DEV_PASSWORD`; (ii) a separate password per user | (i) |
| B1.2 Production guard | (i) the seed refuses to run in production mode if a development password is set; (ii) no guard | (i) |
| B1.3 Re-running the seed | (i) set the development password only on seeded users who have no password yet; (ii) reset every seeded user's password on each run | (i) |
| B1.4 Link format | (i) 32 random bytes as a 43-character code in `http://localhost:3000/set-password?token=…`, with only its SHA-256 hash stored; (ii) a shorter numeric code (easier to guess) | (i) |
| B1.5 Link expiry (also 9.12) | (i) invite 7 days, reset 1 hour; (ii) your values | (i) |
| B1.6 Single use | (i) usable once, checked atomically; a new link cancels the user's older unused links of the same kind; setting the password cancels all their other links and signs them out everywhere; (ii) reusable until expiry | (i) |
| B1.7 When the link is checked | (i) only when the form is submitted; (ii) also when the page opens, which needs an extra endpoint `GET /auth/password-tokens/{token}` | (i) |
| B1.8 After the password is set | (i) go to `/login` with the toast "Password set. You can sign in now."; (ii) sign the user in automatically | (i) |
| B1.9 How you get development links | (i) printed only in the API console, in development, for example `[dev] Invite link for test@mrgarments.com (expires 2026-11-03 10:00 IST): http://localhost:3000/set-password?token=…`; (ii) also returned by the API (the UI to show it isn't designed); (iii) written to a file | (i) |
| B1.10 Password hashing (also 9.9) | (i) argon2id with 19 MiB memory, 2 iterations and 1 thread (the OWASP minimum), with stronger hashes applied automatically at sign-in if the settings are raised later; (ii) bcrypt, cost 12 | (i) |
| B1.11 Inactive user with a valid link | (i) refuse; (ii) accept and reactivate the user | (i) |
| B1.12 Set password page wording | (i) the Proposed strings in 8.2 and Part 3; (ii) your wording | (i) |

**Tests:**
- **Seed:** a production-mode seed refuses and sets no passwords; a re-seed keeps passwords you changed.
- **Single use:** a link works once, and two simultaneous submissions let exactly one succeed.
- **Refusals:** an expired link, a wrong code and an inactive user are all refused.
- **Sessions:** the user's old sessions end.
- **Storage:** no raw link code appears in the database.
- **Browser:** add a user, open the link from the console, set a password, sign in.

**Blocks Batch 1:** yes.

### B2. Sidebar user block

**Existing**
- **Management screens** (04, 05, 16, 40, 47, 48, 49 ✓): "MG" / "Management" / "Full access".
- **Staff** (39 ✓): "CY" / "Chen Yu" / "China office · Entry only". The second line uses the office **type**; on 47 ✓ Chen Yu's office is "Guangzhou office".
- **Code:** `mocks/data/master.ts:101-102`; `components/layout/app-sidebar.tsx:132-140`.

**B2.0 options**

| Option | Security | Business |
|---|---|---|
| (a) As drawn: everyone in the management shell shows "MG · Management · Full access" | Tells Procurement and Accounts users they have full access | Matches the drawn screenshots exactly |
| (b) The person's name; second line is "{office type} · {access label}"; initials from the name | Accurate | The drawn Management text changes |
| (c) The role name for everyone; second line is the access label | Accurate about the role | The staff screenshot (39) changes |

| Sub-decision | Options | Recommended |
|---|---|---|
| B2.1 Second-line label for Procurement and Accounts (Proposed) | (i) the role names "Procurement" and "Accounts"; (ii) your wording | (i) |
| B2.2 Users with no office (Head office deferred) | (i) show the access label only; (ii) leave the second line empty | (i) |
| B2.3 Initials | (i) first letters of the first and last words of the name ("Suresh Menon" → SM; matches "CY" for Chen Yu); (ii) your rule | (i) |

**What (b) shows for each seeded user** (Proposed):

| User | Initials | Name line | Second line |
|---|---|---|---|
| Suresh Menon | SM | Suresh Menon | Full access |
| Priya Nair | PN | Priya Nair | Procurement |
| Anita Joseph | AJ | Anita Joseph | Accounts |
| Wang Fang | WF | Wang Fang | China office · Entry only |
| Chen Yu | CY | Chen Yu | China office · Entry only |
| Li Wei | LW | Li Wei | China office · Entry only |
| Anil Sharma | AS | Anil Sharma | India office · Entry only |
| Joseph M | JM | Joseph M | Warehouse · Entry only |

**Recommendation:** (b) with B2.1 (i), B2.2 (i), B2.3 (i).

**Tests:** a unit test of the initials and label rules; a browser test checking the block for Suresh, Priya and Chen Yu.

**Blocks Batch 1:** yes.

### B3. Landing page, sidebar items and blocked pages

**Existing**
- **Staff sidebar** (39 ✓; `config/navigation.ts:42-45`): "Home", then "YOUR STAGE: Receiving (China)".
- **Management sidebar** (`navigation.ts:7-40`): drawn for Management only.
- **Signing in** always goes to `/` (`login-screen.tsx:17-22`).
- **Not designed:** a "no access" page, or a sidebar for Procurement, Accounts, India staff or Warehouse staff.

**Sub-decisions**

| Sub-decision | Options | Recommended |
|---|---|---|
| B3.1 Landing page after sign-in | L-a: all staff go to `/home`, everyone else to `/`. L-b: China staff to `/home`; India and Warehouse staff to their first granted stage's list; everyone else to `/`. L-c: India and Warehouse staff can't sign in yet | L-b |
| B3.2 Sidebar items | N-a: the full management sidebar for every management-shell role. N-b: hide items the role can't open; staff see "YOUR STAGE" listing their granted stages | N-b |
| B3.3 Opening a page the role can't use | P-a: allow it (still mock data in this batch). P-b: redirect to the user's landing page. P-c: a "no access" page (not designed; needs wording) | P-b |
| B3.4 Staff user with no granted stages | (i) can sign in and sees Home only; (ii) can't sign in | (i) |

**What N-b and L-b produce** (Proposed, derived from 49 ✓):

| Role | Sidebar items | Landing page |
|---|---|---|
| Management | All items, as drawn | `/` |
| Procurement | Dashboard, Orders, Deposits & Payments, Delivery Calendar, plus Receiving (China) under Stages | `/` |
| Accounts | Dashboard, Orders, Deposits & Payments | `/` |
| China staff | Home, plus YOUR STAGE: Receiving (China) and/or Containers, as granted | `/home` |
| India staff | Home, plus YOUR STAGE: Clearing (India) and/or Transport, as granted | First granted stage's list |
| Warehouse staff | Home, plus YOUR STAGE: Warehouse | `/warehouse` |

**Tests:** for each role, check the landing page, the visible sidebar items, and the redirect when opening a blocked page (for example, Chen Yu opening `/payments`).

**Blocks Batch 1:** yes.

### B4. Browser tests once sign-in is required

**Existing**
- **Playwright config:** starts only the frontend (port 3100, one worker).
- **Specs:** all 20 test files open pages without signing in.
- **Screenshot script:** `scripts/visual-diff.mjs` doesn't sign in.
- **Latest run:** 73 of 73 passed this session.

**Sub-decisions**

| Sub-decision | Options | Recommended |
|---|---|---|
| B4.1 Strategy | (a) Real sign-in in tests. You start PostgreSQL first; test setup resets and seeds `mr_garments_test`; Playwright starts the API and the frontend; a setup step signs in once as Suresh and once as Chen Yu and saves both sessions; specs reuse them; sign-in tests start signed out. (b) A setting that bypasses sign-in during tests (a security risk). (c) Test only connected screens (loses regression coverage) | (a) |
| B4.2 Mark the current prototype | (i) create the local annotated tag `prototype-v1` at `ca94b78`; (ii) no tag | (i) |
| B4.3 Push the tag | (i) push now; (ii) later, with separate approval; (iii) never | (ii) |
| B4.4 Where saved test sessions live | (i) `playwright/.auth/`, Playwright's documented location, with one line added to `.gitignore`; (ii) inside the already-ignored `test-results/` (Playwright clears that folder each run, so this is fragile) | (i) |
| B4.5 Screenshot script | (i) add a sign-in option to `visual-diff.mjs`; (ii) leave it unchanged (it can't capture signed-in pages) | (i) |
| B4.6 Test password | (i) read from a test setting (`E2E_PASSWORD`) and seeded only into `mr_garments_test`; (ii) your approach | (i) |

**Which spec files change content under B4.1 (a):**
- **`w3-auth`:** real credentials and error messages.
- **`w3-users`:** seeded data, `?id=` routes, saving.
- **`w3-settings`:** Add supplier persists, duplicate names.
- **`shell`:** sidebar block, per-role sidebar, real sign-out.
- **The other 16 files:** content unchanged; they only gain the saved sign-in.

**Tests:** the full browser suite passes, each saved session is reused, and the signed-out tests really start signed out.

**Blocks Batch 1:** it blocks your acceptance testing, not the backend coding.

### B5. "What this role can do" card on Add/Edit user

**Existing**
- **48 ✓:** the card always shows the China staff card. Its summary reads "China staff can enter receipts and container loading. They cannot see payments, landed cost or reports." Its six rows are: Dashboard No · Orders No · Receiving (China) Enter · Container loading Enter · Payments and cost No · Reports No.
- **Code:** `users/data/queries.ts:30` always returns the China staff card; `edit-user-form.tsx:143-156` renders it.
- **49 ✓:** the Roles tab has 13 rows.

| Sub-decision | Options | Recommended |
|---|---|---|
| B5.1 Rows shown | 1: the six drawn rows for every role (two rows each merge two matrix rows; India and Warehouse staff would show all "No"). 2: all 13 matrix rows for every role. 3: the six drawn rows for China staff, exactly as 48, and all 13 rows for every other role. 4: show the card only for China staff | 3 |
| B5.2 Summary sentence | (i) only China staff has the existing sentence; other roles have none; (ii) you supply text for the other five roles | (i) |

**Tests:** a unit test building the card for all 6 roles; a browser test that changing Role updates the card.

**Blocks Batch 1:** yes (small).

### B6. Roles tab and six Settings tabs, read-only

**Existing**
- **Roles (49 ✓):** the matrix, with the legend "Full = see and change · Enter = add data for that stage only · View = look only. Roles are fixed in this first version." (`users/roles/page.tsx`). It has no actions.
- **The six Settings tabs (41–46 †):** each shows a list, a search box and Active/Inactive/All chips (`settings-list.tsx`).
- **"+ Add" buttons** (`settings-screens.tsx:96,118,140,162,193,219`) and **"Edit {name}"** (`settings-list.tsx:50`) show "… is not included in the current prototype."

**Scope if included (a)**

| Tab | Columns | Endpoint | Values that will differ from the screenshot |
|---|---|---|---|
| Roles | 13 × 6 matrix plus legend | ROL-1 | None |
| Shipping agents | Name, Contact person, Phone, Office city, Active containers, Status | MD-4 | Active containers = 0 |
| Clearing agents | Name, Contact person, Phone, Port, Containers cleared, Status | MD-7 | Containers cleared = 0 |
| Transport companies | Name, Contact person, Phone, Trips so far, Status | MD-10 | Trips so far = 0 |
| Offices & warehouses | Name, Type, Country, Address, Staff, Status | MD-13 | Staff comes from real users (the 3 Head office users are absent) |
| Teams | Team, Pieces in stock, Landed cost of stock, Average per piece, Status | MD-16 | Stock 0, cost ₹0, average per B6.2 |
| Item list | Item, Counted in, Pieces per bundle, Used in orders, Status | MD-19 | Used in orders empty |

The zero and empty values come from later batches' tables.

**How they stay read-only:**
1. **The API has only GET** for these six resources; POST and PATCH return 404, and a test checks this.
2. **Every "+ Add" and "Edit" keeps its "not in prototype" message**, with no frontend change. Supplier "Edit" also stays a toast.
3. **The existing browser test** "undesigned actions show the prototype notice" keeps passing.

| Sub-decision | Options | Recommended |
|---|---|---|
| B6.1 Include | (a) include read-only; (b) exclude, so the tab bars mix real and fictional data | (a) |
| B6.2 Teams "Average per piece" with no stock (Proposed) | (i) "–"; (ii) "₹0.00", which is what the current code would show (`settings-screens.tsx:180`) | (i) |
| B6.3 Offices "Staff" column | (i) active users only; (ii) all users, including inactive | (i) |

**Tests:** each GET returns the seeded rows and its filters work; POST and PATCH return 404; non-Management users get 403; a browser test lists each tab and confirms the toasts are unchanged.

**Blocks Batch 1:** no (optional).

### B7. Starting stage grants for seeded staff

**Existing**
- **48 ✓:** Wang Fang has Receiving and Container loading ticked.
- **39 ✓:** Chen Yu's YOUR STAGE shows Receiving only.
- **History, 14 †:**
  - "Li Wei · China office · Loaded into container" (`order-detail/history/data/fixtures.ts:32`).
  - Anil Sharma recorded the clearing steps (`:24-31`).
  - Joseph M recorded the warehouse receipt (`:16`).
  - "Ravi K", who isn't a user, loaded the transport (`:21`).

| Option | Li Wei | Anil Sharma | Joseph M |
|---|---|---|---|
| (a) All of the role's stages | Receiving + Container loading | Clearing + Transport | Warehouse |
| (b) None until you set them | – | – | – |
| (c) Your own list | ? | ? | ? |

Wang Fang (Receiving + Container loading) and Chen Yu (Receiving) are fixed by the screenshots under every option. Suresh, Priya and Anita get none, because grants apply to staff roles only (Q7).

**Recommendation:** (a).

**Tests:** a seed test checks the grants; ME-1 returns the right stages; the staff sidebar lists them.

**Blocks Batch 1:** yes.

### B8. Role changes, the last Management user, self-changes and sessions

**Existing**
- **None of this is designed.** 48 ✓ has Role and Status selects and stage ticks, with no warnings.
- **49 ✓:** "Settings and users" is Management only.
- **Suresh Menon is the only Management user** (`mocks/data/master.ts:66`).

| Sub-decision | Options | Recommended |
|---|---|---|
| B8.1 Role change while the user has grants the new role can't hold (or the new role isn't a staff role) | (a) reject with 422, naming the stages to untick; (b) remove those grants silently; (c) remove them and list them in the success message | (a) |
| B8.2 The last active Management user | (a) block any change that leaves zero active Management users (role changed away from Management, or set Inactive), with 409, checked in a locked transaction so two simultaneous changes can't both pass; (b) allow it (recovery needs direct database access) | (a) |
| B8.3 A Management user changing themselves | (a) allowed only while another active Management user remains; (b) never allowed; (c) always allowed, subject to B8.2 | (a) |
| B8.4 Effect on someone already signed in | (a) deactivating signs them out at once; role and grant changes take effect on their next request, because permissions are re-read every request; (b) also sign them out on any role change | (a) |

**What the recommended rules mean in practice:**

| Action | Result | Sessions |
|---|---|---|
| China staff → India staff while Receiving is ticked | 422: "untick first" | Unchanged |
| China staff → India staff with ticks changed to Clearing | Saved | Next request uses India staff |
| Suresh (the only Management user) → Procurement or Inactive | 409 | – |
| Another Management user exists, then Suresh → Procurement | Saved | Admin access ends on his next request |
| Any user → Inactive | Saved (unless B8.2 applies) | Signed out at once; can't sign in |
| Inactive → Active | Saved | Can sign in again |

**Tests:** one test per row above; two simultaneous demotions where exactly one succeeds; a deactivated user's next request gets 401.

**Blocks Batch 1:** yes.

### B9. Security defaults

Every row is Proposed, and every row is a choice for you.

| # | Setting | Existing | Proposed | Alternatives | Recommended |
|---|---|---|---|---|---|
| 9.1 | Sign-in throttling | none | 5 failed attempts per email and IP address within 15 minutes, then 429 until the window passes; no account lockout | Per IP only; account lockout; other numbers | Proposed |
| 9.2 | Where attempt counts are kept | – | API memory (one process; resets on restart) during local development; PostgreSQL before production | PostgreSQL now | Proposed |
| 9.3 | Session storage | none | Stored in PostgreSQL; a new random session ID at every sign-in | – | Proposed |
| 9.4 | "Keep me signed in" ticked | Checkbox drawn on 01 ✓; does nothing today | 30 days, extended while in use | Other lengths | Proposed |
| 9.5 | "Keep me signed in" not ticked | – | Cookie ends when the browser closes, and the server ends the session after 12 hours without activity | 8 hours; 24 hours | Proposed |
| 9.6 | Maximum session age | – | No limit beyond 9.4 and 9.5 | A fixed limit, for example 30 days | Proposed |
| 9.7 | Session cookie | – | Named `mrg.sid`; scripts can't read it; sent only on same-site requests (SameSite=Lax); HTTPS-only in production | SameSite=Strict | Proposed |
| 9.8 | Protection against requests from other sites | – | Any request that changes data must be JSON and come from the app's own address | A separate anti-forgery token | Proposed |
| 9.9 | Password storage | – | argon2id: 19 MiB memory, 2 iterations, 1 thread; re-hashed at sign-in if the settings are raised | bcrypt, cost 12 | Proposed |
| 9.10 | Password rules | Drawn on 03 ✓ and checked in the browser (`password-strength.ts:2-15`): "At least 8 characters", "One number", "One capital letter" | The same three rules enforced by the server, plus at most 128 characters; no ban on reusing old passwords; the new password may equal the current one | Add or remove rules | Proposed |
| 9.11 | After a password change | – | Sign out every other session; keep this one, with a new session ID | Sign out everywhere | Proposed |
| 9.12 | Reset and invite links | – | Reset 1 hour, invite 7 days; usable once; stored hashed; a new link cancels older ones; using one signs the user out everywhere | Other lengths | Proposed |
| 9.13 | Sign-in error message | – | The same message for an unknown email, a wrong password and an inactive user | Separate messages, which reveal which emails have accounts | Proposed |
| 9.14 | Forgot password response (only if 8.9 "Yes") | – | Always "accepted" (202), whether or not the email exists | – | Proposed |
| 9.15 | Inactive users | Status column exists on 47 ✓ and 48 ✓ | Can't sign in; signed out at once when made inactive | – | Proposed |
| 9.16 | Logging | – | Passwords, password hashes and session IDs are never logged; link codes are printed only in development (B1.9) | – | Proposed |
| 9.17 | Largest request accepted | – | 100 KB; larger requests get 413 | Another limit | Proposed |
| 9.18 | Browser security headers | – | The standard Helmet defaults on the API | – | Proposed |

**Tests:**
- **Sign-in:** the 6th attempt gets 429.
- **Sessions:** the session ID changes at sign-in; cookie lifetimes match 9.4 and 9.5; idle sessions expire; cookie flags are set.
- **Other sites:** a request from another site gets 403.
- **Passwords:** stored hashes are argon2id; the server enforces each password rule.
- **Password change:** another open session gets 401 after the change.
- **Sign-in errors:** the same 401 for all three failure cases.
- **Logs:** no secrets appear.
- **Size and headers:** a large request gets 413; security headers are present.

**Blocks Batch 1:** these values are needed before the first build; all can be changed later.

### C5. The Password field on the edit-user form

**Existing**
- **48 ✓:** an empty Password field with the placeholder "Set by user at first sign-in".
- **Code:** an editable password input (`users/edit-user-form.tsx:107-109`; `users/data/fixtures.ts:15`).
- **Q9 (decided):** passwords are set through links.

| Option | Security | Business |
|---|---|---|
| R1. The field is read-only and looks identical; the API never accepts a password from Management | Only the user knows their password | No visible change |
| R2. Management may set an initial password | Management knows users' passwords and must pass them on | Contradicts the placeholder |
| R3. Remove the field | – | A design change |

**Recommendation:** R1.

**Tests:** USR-3 and USR-4 refuse a `password` field with 400; a browser test confirms the field can't be typed into.

**Blocks Batch 1:** yes.

---

## Part 3. U36: error behaviour and wording

**Existing**
- **Screenshots:** none of 01, 03, 40, 47, 48 or 53 ✓ shows an error.
- **Add supplier:** the only form that shows a field error is the Add supplier dialog, with "Enter the supplier name." under the field in red and the field outlined (`add-supplier-dialog.tsx:80-81`; `ui/field.tsx:176-231`).
- **Error styling:** text inputs and dropdowns already have a red "invalid" style.
- **Error toasts** are configured but never used (`ui/sonner.tsx`; `app/layout.tsx:26`).
- **The app's error page** shows "Something went wrong" / "This page failed to load." with a "Try again" button (`app/(app)/error.tsx`; `states.tsx:39-61`, whose defaults are "Something went wrong" / "Please try again.").
- **Sign-in screens** have no error page of their own.
- **The edit-user form** isn't a real form, so its required markers do nothing.

**U36.0 overall approach**

| Option | Consequence |
|---|---|
| A. Field problems appear under the field; sign-in problems appear as one line on the form; other failures appear as an error toast; an expired session goes to `/login` | Reuses existing pieces |
| B. A toast for every error | Users can't tell which field is wrong |
| C. An error banner on each form | A new pattern with no design |
| D. Keep today's behaviour (browser checks only) | Server-side failures, such as a duplicate email, are lost |

**Recommendation:** A.

**Error format the API returns (Proposed):** `{ "error": { "code", "message", "fields"?: { "<field>": "<message>" } } }`, with field names matching the form's own fields.

**U36.1 Display rules (Proposed under option A)**

| # | Situation | Status | What the user sees |
|---|---|---|---|
| E1 | A field breaks a rule | 422 with `fields` | A red message under each affected field; the field outlined in red; focus moves to the first problem field; entered values kept; the button works again |
| E2 | Duplicate email or supplier name | 409 with `fields` | As E1, under the duplicated field |
| E3 | Last Management user (B8.2) | 409 with `fields.role` or `fields.status` | Under whichever field was changed |
| E4 | Wrong credentials or inactive user | 401 | One line above the Sign in button; password cleared, email kept |
| E5 | Too many sign-in attempts | 429 | One line above the Sign in button |
| E6 | Session expired during an action | 401 | Sent to `/login`, which shows a message above the form |
| E7 | Session expired when opening a page | 401 | Sent to `/login`, with the same message |
| E8 | Not allowed to do an action | 403 | An error toast |
| E9 | Not allowed to open a page | 403 | Redirected to the user's landing page (B3.3) |
| E10 | Record not found (for example, a removed user's edit link) | 404 | The standard not-found page, as unknown orders already show |
| E11 | Malformed request (a bug in our code) | 400 | An error toast |
| E12 | Server error, API down, or no network, during an action | 5xx or none | An error toast; entered values kept |
| E13 | The same, while a page is loading | 5xx or none | The existing error page with "Try again" |
| E14 | Clicking Save twice | – | Save is disabled while the request runs (no spinner, because none is designed) |

**U36.2 Exact wording**

Each row is your choice: accept the wording or replace it. "Existing" means it is already in the code.

| ID | Where | When | Message | Status |
|---|---|---|---|---|
| M1 | Sign in, above the button | Email or password empty | "Enter your email and password." | Proposed |
| M2 | Sign in, above the button | Wrong credentials or inactive user | "Email or password is incorrect." | Proposed |
| M3 | Sign in, above the button | Too many attempts | "Too many attempts. Try again in 15 minutes." | Proposed |
| M4 | Sign in, above the form | Arrived because the session ended | "Your session has ended. Please sign in again." | Proposed |
| M5 | Change password, under Current password | Current password empty | "Enter your current password." | Proposed |
| M6 | Change password, under Current password | Current password wrong | "Current password is incorrect." | Proposed |
| M7 | Change password or Set password, under New password | New password empty | "Enter a new password." | Proposed |
| M8 | Change password or Set password, under New password | A rule is broken (the drawn rule list still shows which) | "Use at least 8 characters, a number and a capital letter." | Proposed |
| M9 | Change password or Set password, under New password | More than 128 characters | "Use 128 characters or fewer." | Proposed |
| M10 | Change password or Set password, under Confirm new password | Confirmation empty | "Confirm your new password." | Proposed |
| M11 | Change password or Set password, under Confirm new password | Confirmation doesn't match | "New passwords do not match." | Proposed |
| M12 | Set password, above the form | Link invalid, expired or already used | "This link is invalid or has expired. Ask your manager for a new one." | Proposed |
| M13 | Edit user, under Full name | Empty | "Enter the full name." | Proposed |
| M14 | Edit user, under Email | Empty or not an email address | "Enter a valid email address." | Proposed |
| M15 | Edit user, under Email | Already used | "A user with this email already exists." | Proposed |
| M16 | Edit user, under Role | Not chosen | "Choose a role." | Proposed |
| M17 | Edit user, under Office | Not a valid active office | "Choose an office from the list." | Proposed |
| M18 | Edit user, under the stage ticks | A stage outside the role is ticked (Q7 and B8.1) | "{Role} can't enter data for {Stage}. Untick it first." For example: "China staff can't enter data for Clearing (India). Untick it first." | Proposed |
| M19 | Edit user, under the stage ticks | Any stage ticked for a non-staff role | "{Role} doesn't use stage access. Untick all stages first." | Proposed |
| M20 | Edit user, under Role or Status | Last Management user (B8.2) | "At least one active Management user is required." | Proposed |
| M21 | Add supplier, under Supplier name | Empty | "Enter the supplier name." | **Existing** (`settings-logic.ts:24`) |
| M22 | Add supplier, under Supplier name | Name already used (any capitalisation) | "A supplier with this name already exists." | Proposed |
| M23 | Toast | Not allowed (E8) | "You don't have access to do that." | Proposed |
| M24 | Toast | Malformed request, server error or no network (E11, E12) | Title "Something went wrong.", text "Please try again." | Wording **Existing** (`states.tsx:40-41` defaults); its use as a toast is Proposed |
| M25 | Error page | A page fails to load (E13) | "Something went wrong" / "This page failed to load." / button "Try again" | **Existing** (`app/(app)/error.tsx`) |
| M26 | Toast | Sign out fails | "Couldn't sign you out. Please try again." | Proposed |

**Your choice:** U36.0 (A, B, C or D), U36.1 (approve E1–E14), and each of M1–M26 (approve or replace).

**Tests:**
- **API:** one test per message case, checking the status, the error code and the field name.
- **Browser, every form:** the message appears in the right place, entered values are kept, and Save works again.
- **Browser, sessions:** an expired session during an action leads to `/login` with M4.

**Blocks Batch 1:** yes.

---

## Part 4. U37: success behaviour and wording

**Existing**
- **Screenshots:** none of the 16 I opened shows a success state.
- **Code:** Add supplier closes the dialog and the row appears, with no message (`settings-screens.tsx:55,73`; `add-supplier-dialog.tsx:31,50-51`).

**U37.0 overall approach**

| Option | Consequence |
|---|---|
| A. Go to where the result is visible and show a short success toast (the existing toast, using its default position and duration) | Clear confirmation using pieces that already exist |
| B. Go there with no toast | Quieter; easy to miss |
| C. Stay on the form and show an inline message | A new pattern with no design |
| D. Do nothing | Users can't tell whether it saved |

**Recommendation:** A.

**U37.1 Where sign-in goes next**
- (i) Always the landing page (B3.1).
- (ii) Back to the page that redirected to sign-in, limited to this app's own addresses.

**Recommendation:** (i). It has no redirect risk.

**U37.2 Behaviour after each action under option A** (Proposed)

| ID | Action | Goes to | Toast | What updates |
|---|---|---|---|---|
| K1 | Sign in | Landing page (B3.1) | None | Shell, sidebar block and sidebar items from `/me`; last sign-in recorded |
| K2 | Sign out | `/login` | None | Session deleted; Back shows no data |
| K3 | Change password | `/profile` (where the drawn Cancel goes; Profile is still mock data) | "Password changed" | Other sessions signed out; this one kept |
| K4 | Set password (B1 b) | `/login` | "Password set. You can sign in now." | All the user's sessions signed out; the link marked used |
| K5 | Add user | `/users` | "User added" | New user listed as Active; invite link printed to the API console in development |
| K6 | Save user | `/users` | "User saved" | List refreshed; changes apply on that user's next request |
| K7 | Add supplier | Dialog closes (the `?dialog=add-supplier` part of the address is removed) | "Supplier added" | List reloaded; new row visible under Active |
| K8 | Cancel on any form | Where Cancel goes today | None | Nothing saved |

**Your choice:** U37.0, U37.1, and the destination and toast text for each of K1–K8.

**Tests:** a browser test for each action checks where it lands, the toast text, and that the result is still there after reloading the page.

**Blocks Batch 1:** yes.

---

## Part 5. Every proposed string and value

### 5.1 Browser tab titles

The pattern is "{title} · MR Garments" (`app/layout.tsx:17`).

| Page | Title | Status |
|---|---|---|
| `/login` | Sign in · MR Garments | Existing |
| `/change-password` | Change password · MR Garments | Existing |
| `/users` | Users · MR Garments | Existing |
| `/users/edit` | Add or edit user · MR Garments | Existing |
| `/users/roles` | Roles · MR Garments | Existing |
| `/settings/*` | Settings · MR Garments | Existing |
| `/forgot-password` | Forgot password · MR Garments | Existing |
| `/set-password` | **Set password · MR Garments** | **Proposed** |

### 5.2 Page headings, subtitles, fields and buttons

| Page | Item | Text | Status |
|---|---|---|---|
| Sign in | Heading / subtitle | "Sign in" / "Use your MR Garments staff account." | Existing (01 ✓) |
| Sign in | Fields, checkbox, link, button, note | "Email or username", "Password", "Keep me signed in", "Forgot password?", "Sign in", "Need access? Ask your manager for an account." | Existing (01 ✓) |
| Change password | Heading / subtitle | "Change password" / "Choose a new password for your account." | Existing (03 ✓) |
| Change password | Fields, button, link | "Current password", "New password", "Confirm new password", "Save new password", "Cancel" | Existing (03 ✓) |
| Forgot password | Heading / subtitle | "Forgot your password?" / "Enter your email or username. We will send a link to reset your password." | Existing (code; 02 †) |
| **Set password** | Heading / subtitle | **"Set your password" / "Choose a password for your account."** | **Proposed** |
| **Set password** | Fields | **"New password", "Confirm new password"** (with the drawn Show/Hide toggle and rule list) | **Proposed** |
| **Set password** | Button / link | **"Save password" / "Back to sign in"** | **Proposed** |

### 5.3 Password rules

**Existing, drawn on 03 ✓ (`password-strength.ts:3-5`):** "At least 8 characters", "One number", "One capital letter".

**Proposed (9.10):**
- The server also enforces these three rules.
- A 128-character maximum (message M9).
- No ban on reusing old passwords.

### 5.4 Sidebar user block

All Proposed; see B2.
- **Second line by role:** Management "Full access"; Procurement "Procurement"; Accounts "Accounts"; staff "{office type} · Entry only".
- **No office yet:** the access label only.
- **Initials:** first letters of the first and last words of the name.

### 5.5 Role card summaries

- **China staff:** "China staff can enter receipts and container loading. They cannot see payments, landed cost or reports." Existing (48 ✓).
- **Other five roles:** none (B5.2 (i)), unless you supply text.

### 5.6 Empty values (Proposed)

- **"Last sign-in" for a user who has never signed in:** "–".
- **Teams "Average per piece" with no stock:** "–" (B6.2).

### 5.7 Error and success wording

M1–M26 are in Part 3. K3–K7 toasts are in Part 4.

### 5.8 Development settings

All Proposed. They live in git-ignored files that **I would create only after you approve**.

| Setting | Where | Proposed value | Notes |
|---|---|---|---|
| `NODE_ENV` | API `.env` | `development` | Turns on console links (B1.9) |
| `PORT` | API `.env` | `4000` | API port in development |
| `DATABASE_URL` | API `.env` | `postgres://mr_garments_app:<password from D:\SDEC\pgdata\mr_garments_app.pw>@localhost:5432/mr_garments_dev` | The app account created in the setup |
| `SESSION_SECRET` | API `.env` | A random value of 32 bytes or more, generated locally | Used to sign the session cookie |
| `APP_ORIGIN` | API `.env` | `http://localhost:3000` | Used for the 9.8 address check and for link URLs |
| `SEED_DEV_PASSWORD` | API `.env` | Chosen by you; must meet the password rules | B1.1 (i) |
| `API_URL` | Frontend `.env.local` | `http://localhost:4000` | Where the frontend forwards `/api` |
| Test API port | Test settings | `4100` | B4 |
| Test database | Test settings | `mr_garments_test` | Already created |
| `E2E_PASSWORD` | Test settings | Chosen by you | B4.6 |
| `E2E_PORT` | Existing | `3100` | Existing (`playwright.config.ts`) |

### 5.9 Forgot password in this batch (8.9)

- (i) No, which is recommended: it isn't one of the five screens.
- (ii) Yes: wire AUTH-3, which needs B1 (b).

---

## Part 6. Acceptance tests

Automated tests run as API tests against `mr_garments_test` and as browser tests per B4. The manual steps assume the recommended options; if you choose differently, I'll adjust them.

### Authentication

| ID | Steps | Expected |
|---|---|---|
| AT-A1 | Open `/users` while signed out | Redirected to `/login` |
| AT-A2 | Sign in as `suresh@mrgarments.com` with the development password | Dashboard appears; the sidebar block shows "SM · Suresh Menon · Full access" |
| AT-A3 | Sign in with a wrong password | M2 appears above the button; email kept; password cleared |
| AT-A4 | Sign in with an unknown email | Exactly the same message as AT-A3 |
| AT-A5 | Sign in as a user set to Inactive | Exactly the same message as AT-A3 |
| AT-A6 | Fail 6 times within 15 minutes | Attempts 1–5 show M2; attempt 6 shows M3 (429) |
| AT-A7 | Sign in with "Keep me signed in" ticked, then restart the browser | Still signed in |
| AT-A8 | Sign in without the tick, then restart the browser | Signed out |
| AT-A9 | Sign out from the user menu | `/login`; Back shows no app data |
| AT-A10 | Open `/change-password` while signed out | Redirected to `/login` |

### User management

| ID | Steps | Expected |
|---|---|---|
| AT-U1 | As Suresh, open Users | 8 users, matching 47 ✓ except: 3 empty offices (Head office deferred) and real "Last sign-in" values ("–" for anyone who hasn't signed in) |
| AT-U2 | Search "wang"; filter role "China staff"; click Inactive, then All | 1 row; 3 rows; 0 rows; 8 rows |
| AT-U3 | Edit Wang Fang, untick Container loading, Save | `/users` with "User saved"; the change persists after reopening |
| AT-U4 | Edit Wang Fang, tick Clearing (India), Save | M18 under the stage ticks; nothing saved |
| AT-U5 | Change Chen Yu to India staff while Receiving is ticked | M18; nothing saved |
| AT-U6 | Change Suresh to Procurement, then Suresh to Inactive | M20 under Role, then under Status; nothing saved |
| AT-U7 | Add user: Test User, `test@mrgarments.com`, China staff, Receiving ticked | `/users` with "User added"; the API console shows the invite link |
| AT-U8 | Open the link; set a password breaking a rule, then a mismatched one, then a valid one | M8, then M11, then `/login` with "Password set. You can sign in now." |
| AT-U9 | Sign in as Test User | Staff shell; YOUR STAGE: Receiving (China) |
| AT-U10 | Open the same link again | M12 |
| AT-U11 | Add a user with Wang Fang's email | M15 |
| AT-U12 | Select each role on the edit form | The card follows B5; the Password field can't be typed into (C5) |

### Supplier management

| ID | Steps | Expected |
|---|---|---|
| AT-S1 | Open Settings › Suppliers | 5 suppliers, as 40 ✓, with "Open orders" = 0 |
| AT-S2 | Search by name or phone; use the Active/Inactive/All chips | Rows filter correctly |
| AT-S3 | "+ Add supplier", then Save with the name empty | M21 under Supplier name |
| AT-S4 | Add "Ningbo Denim Works" with city, contact, phone, address and notes | Dialog closes; "Supplier added"; the row persists after a reload; address and notes are stored |
| AT-S5 | Add "ningbo denim works" | M22 |
| AT-S6 | Click Edit on any supplier | The "not in prototype" message, unchanged |
| AT-S7 (B6) | Open the Roles tab and Settings tabs 2–7 | Read-only lists; "+ Add" and Edit show the unchanged message; values as in B6 |

### Password changes

| ID | Steps | Expected |
|---|---|---|
| AT-P1 | As Anita: wrong current password; new password with no capital letter; mismatched confirmation | M6; M8; M11 |
| AT-P2 | Valid change while Anita is also signed in in a second browser | `/profile` with "Password changed"; the second browser's next action goes to `/login` with M4 |
| AT-P3 | Sign out, then sign in with the old and then the new password | Old one: M2. New one: success |

### Permissions

| ID | Steps | Expected |
|---|---|---|
| AT-R1 | Sign in as Priya (Procurement) | The B3 sidebar for Procurement (no Settings or Users); opening `/users` redirects to `/` |
| AT-R2 | Sign in as Anita (Accounts) | The B3 sidebar for Accounts; `/settings/suppliers` redirects |
| AT-R3 | Sign in as Chen Yu | Staff shell; "CY · Chen Yu · China office · Entry only"; `/payments` redirects to `/home` |
| AT-R4 | Sign in as Anil Sharma | Lands on `/clearing` (still mock data); YOUR STAGE lists Clearing (India) and Transport |
| AT-R5 | Automated: every Batch 1 endpoint × 6 roles, plus signed out | 200, 401 or 403 exactly as Part 1 says |
| AT-R6 | Automated: two simultaneous demotions of the last two Management users | Exactly one succeeds; the other gets 409 |

### Sessions

| ID | Steps | Expected |
|---|---|---|
| AT-T1 | Set Chen Yu to Inactive while he is signed in elsewhere | His next action goes to `/login`; he can't sign in again |
| AT-T2 | Change Wang Fang's stage grants while she is signed in | Her next page load shows the new YOUR STAGE items without signing in again |
| AT-T3 | Automated: idle timeout (9.5), using a test-adjusted clock | The session expires |
| AT-T4 | Automated: session ID before and after sign-in | They differ |
| AT-T5 | Automated: a data-changing request from another site's address | 403 |

### Repository checks after implementation

| ID | Check | Expected |
|---|---|---|
| AT-G1 | API tests | All pass |
| AT-G2 | Frontend lint, typecheck, unit tests and browser tests | All pass |
| AT-G3 | `git status` in both repositories | Only the approved files changed; no secrets committed |
