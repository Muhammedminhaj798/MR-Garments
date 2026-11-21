# Operator commands

For an **authorized operator only**: someone allowed to work directly on the database the command names. Run these
commands from a terminal (PowerShell or Windows Terminal), never from scripts, CI or the launcher. Both are refused
unless the database is named explicitly and matches.

| Command | What it does |
| --- | --- |
| `scripts/db-status.ts` | Read-only: target, TLS mode, applied migrations, active Management users. |
| `scripts/create-admin.ts` | Creates one new Management account. Refuses an email that already exists. |
| `scripts/reset-admin-password.ts` | Resets the password of an **existing, active Management** account. **It never creates an account.** |

## Safeguards (both write commands)

- **Settings (F1).** With `NODE_ENV=production` in the process environment, the `.env` file is not read: every setting
  must come from that environment, and a missing one stops the command.
- **Target (F2).** `--target <database>@<host>` is required and must match `DATABASE_URL` exactly (host in any case).
  Production refuses local hosts and the development and test databases (`mr_garments_dev`, `mr_garments_test`,
  `mr_garments_a1`-`a5`). A `DATABASE_URL` whose host could come from elsewhere (a `?host=` parameter, no host, a
  socket) is refused. This is checked before connecting or asking anything.
- **Confirmation (F3).** The target is shown with its TLS mode (never the connection string or a password). Nothing is
  written until you type `yes`; anything else, Ctrl+C or closed input cancels.
- **Passwords.** Typed twice without echo, never accepted as an argument, never printed or stored in plain text;
  8-128 characters with a number and a capital letter; hashed with the same argon2id settings as sign-in.

## Production syntax

Keep the production settings in a git-ignored `.env.production.local` with `NODE_ENV=production`, `DATABASE_URL`
(Neon, `sslmode=verify-full`), `SESSION_SECRET` and `APP_ORIGIN`. Never put a password for these commands in it.
Run from a checkout of the release commit, and check the target with `db-status` first.

```powershell
D:\SDEC\tools\node-22\node.exe --env-file=.env.production.local --import tsx scripts/db-status.ts
D:\SDEC\tools\node-22\node.exe --env-file=.env.production.local --import tsx scripts/create-admin.ts --target <database>@<host>
D:\SDEC\tools\node-22\node.exe --env-file=.env.production.local --import tsx scripts/reset-admin-password.ts --target <database>@<host> --email <management email>
```

In development, from this folder, the same commands work with `--target mr_garments_dev@localhost`.

## What a password reset changes

In one transaction, for the one account named by `--email` (trimmed and lower case, as at sign-in), and only if it
exists, is a Management account and is active:

- its password hash, `password_changed_at` and `updated_at`;
- any unused password links left from before the password policy are cancelled, and every session it has is signed
  out, as when Management sets a new password on Edit user.

Nothing else changes: no other user, no role, status, name, email or other field, and no new account. If the account
changes while you type (for example it is deactivated), nothing is written.

## Production status

**Production password recovery is not available yet.** This command must be separately approved and then run safely,
by an authorized operator, against an explicitly verified production target before it can be relied on. Until then a
lost Management password in production can be set by another active Management user on Edit user; with no other
Management user it can only be recovered with direct database access.

## Unified supplier ledger (0017, docs/unified-ledger.md)

**Status (2026-11-21): the rehearsal and the rollback rehearsal are done on local copies of the 2026-11-21
production snapshot. The production cutover is NOT approved.** Every production step below needs the owner's separate,
written approval, given for that step.

Four kinds of work, never mixed:

| Kind | Runs against | Writes |
| --- | --- | --- |
| Production snapshot (section 1) | production, read-only | nothing in production; one read-only file under `backups/` |
| Local rehearsal (section 2) | a new, isolated local database restored from that snapshot, and disposable copies of it | those local databases only |
| Production cutover (section 4) | production | migration 0017, the backfill postings, the ledger state |
| Rollback (section 5) | production, only inside the rollback boundary | reverts 0017 |

Run every command from a checkout of the release commit (`npx tsx` below stands for `node --env-file=<settings>
--import tsx`). The local rehearsal and cutover step 3 use a local settings file naming the isolated local database;
every other cutover and rollback step uses the production settings (see "Production syntax" above).

**Pushing `main` deploys.** Render deploys every push to the backend `main`, and Vercel every push to the frontend
`main`. Merging a branch into `main` is therefore its deploy: never merge either one before its cutover step.

### Roles and the maintenance window

- **Owner:** approves each production step in writing, decides go or stop, and approves the rehearsal results (the
  receipts and payments entered since the previous rehearsal, the `--expect` list with both amounts, the baseline and
  its sha256).
- **Operator:** someone authorized to work on the production database. Runs the commands below in order from the
  release checkout, keeps every command's output, never edits data by hand, and stops at any stop condition.
- **Maintenance window:** from cutover step 1 (all data entry paused) to step 10 (resumed). In it nobody enters or edits
  anything, on any screen. The ledger is in `maintenance` (every money write answers 503) from step 4 until step 9
  opens it.

### Stop conditions (every step)

Stop at any non-zero exit, any record listed under `changes` or `baselineChanges`, or any `unexpected` legacy
difference. Then keep the ledger in `maintenance`, keep data entry paused, and report to the owner. Never write a new
baseline, or widen the `--expect` list, to make a check pass: a difference needs a new rehearsal and a new approval.

### Final landed-cost protection (M8, approved by the owner on 2026-11-21)

An order whose landed cost is final keeps its settlement. The new backend refuses, with a 422 under the date field and
nothing written, any of these that would change such an order's settling credits or amounts:

- a new order dated before it (ORD-3, `orderDate`);
- a change of an existing order's date (ORD-5, `orderDate`);
- a Management adjustment, of either sign and any date (LED-3, `entryDate`).

Remaining limitations (details in docs/unified-ledger.md, "M8"): a void, a payment recorded with a past date, a raised
value of an earlier open order, or the delete of an earlier open order can still change a final order's settlement;
"final" is read without a lock (a narrow window); a final order dated in the future blocks the negative adjustments
that would take its credits until its date is corrected; a held account's orders are not checked while held.

### 1. Production snapshot (read-only)

`backups/prod-pre-0017-20261121/scripts/backup-ro.mjs`, run with the production settings and a new, empty folder:

```sh
node --env-file=<production settings> backup-ro.mjs <backups>/<new snapshot folder>
```

Before reading any row it proves the connection read-only (session default read-only, and a probe write refused with
SQLSTATE 25006), and aborts otherwise. It reads every table in one read-only repeatable-read transaction, writes
`backup.json` and `backup.json.sha256`, never overwrites, and never prints the connection string. Check the sha256
(`sha256sum -c`) and make both files read-only.

### 2. Local rehearsal (an isolated local database; nothing is written to production)

1. **A new local database for this snapshot only** (for example `mr_garments_a7`), created by the local Postgres admin
   and owned by `mr_garments_app` (the app role cannot create databases). Never reuse `mr_garments_a2`, `a5`, `a6` or
   another snapshot's rehearsal database.
2. **Restore the snapshot at 0016** with the snapshot folder's restore script (its guard names that one database; run
   from a checkout whose `drizzle/` folder holds 0000-0016). Every table's fingerprint must equal the one production
   computed inside the snapshot transaction, and the 17 migration timestamps must match.
3. **Write the baseline there, before migrating:**
   ```sh
   npx tsx scripts/ledger-reconcile.ts --write-baseline <backups>/<snapshot>/approved-baseline.json
   ```
   It prints the sha256, is refused unless the database is local and `NODE_ENV` is not `production`, and never
   overwrites a file (EEXIST). Check the sha256 independently, and that `--check-baseline` passes.
4. **Keep that database at 0016, unchanged**, as the verified copy. Work only on disposable copies of it
   (`create database <copy> template <verified copy>`): migrate a copy to 0017, then run the preflight, the dry run with
   the baseline, the apply, a rerun (0 rows), and the reconciliation with `--compare-legacy`. The legacy differences
   become the proposed `--expect` list.
5. **Rehearse the rollback** (section 5) on disposable copies: the success path (rollback check allowed, the down script
   exit 0, the schema and data identical to the pre-0017 state) and each refusal case.
6. **The owner approves in writing:** every receipt and payment entered since the previous rehearsal (an invalid
   receipt needs a code change to `DEFAULT_RECEIPT_EXCLUSIONS`, never an edit of the legacy row); the `--expect` list
   with both amounts; the baseline file and its sha256.
7. Make the baseline and its `.sha256` read-only next to the snapshot.

### 3. The 2026-11-21 rehearsal (historical local evidence, not a production run)

These results come from local copies of the snapshot. They prove the procedure and the expected figures; they do not
show that anything ran in production.

- **Snapshot:** `D:\SDEC\MR Garments\backups\prod-pre-0017-20261121\backup.json`, taken 2026-11-21 10:00:47 UTC,
  read-only proven, 28 tables and 244 rows, sha256 `50d5b4c0d2a9d827a3af1edf37edf54caf523272a58faa0030582ade7d714f7d`.
  Against the 2026-11-20 snapshot only 3 expired sessions differ.
- **Baseline:** `D:\SDEC\MR Garments\backups\prod-pre-0017-20261121\approved-baseline.json` (format
  `supplier-ledger-baseline/2`, read-only), sha256 `d342552b7f89f07dbe67dbe66816c7c86f5a08c1918bc1346d74e1f798cb20b3`.
  A second write to it was refused (EEXIST).
- **Local databases:** `mr_garments_a6` (first rehearsal: dry run and a rolled-back preview), `mr_garments_a7` (the
  verified copy at 0016, kept unchanged), `mr_garments_a8` (rollback success path), `mr_garments_a9` and
  `mr_garments_a9_<case>` (rollback refusals). None of them is production.
- **Backfill:** 51 postings: 40 order debits, 10 payment credits and 1 receipt credit (SUP-004 USD 25,000,
  `547ef798`); a rerun writes 0. SUP-010 CNY is held (0 postings). Receipts `f2b7966a` (duplicate) and `6ab149cc`
  (test) are excluded. Rates are the source rows' own; SUP-001's 7 USD orders without a rate stay NULL. Every posting:
  `rehearsal/12-expected-postings.txt` in the snapshot folder.
- **Reconciliation:** 10/10 checks, no baseline changes, and the legacy differences exactly:
  ```sh
  --expect 6422=0:20600 --expect PO-1134647=0:270.14 --expect 6423=0:4400
  ```
  (PO-1134647: the 270.14 excess; 6422 and 6423: SUP-004's genuine 25,000 receipt settles them oldest first.)
- **Rollback rehearsal:** `rollback-a8/SUMMARY.txt` in the snapshot folder (section 5).

### 4. Production cutover (in this order; owner approval required, not given yet)

`<approved>` is the approved baseline file, `<sha>` its approved sha256, `<expect>` the approved list (one
`--expect <PO>=<legacy settled>:<ledger settled>` per difference; for the 2026-11-21 rehearsal the three above), and
`<name>` the production database name.

1. **Pause all data entry.** Every user and every screen, not only money: orders, receiving, containers, clearing,
   transport, warehouse, settings and users. It stays paused until step 10.
2. **Take a fresh read-only production snapshot** (section 1) and record its sha256.
3. **Compare it with the rehearsal.** Restore it into a new, isolated local database (never `a2`, `a5`, `a6` or `a7`) at
   0016, as in section 2, and run with that database's settings:
   ```sh
   npx tsx scripts/ledger-reconcile.ts --check-baseline <approved> --baseline-sha256 <sha>
   ```
   It must print `"ok": true` with no `changes`. Any record added, removed or changed: stop. Do not migrate; rehearse
   again on this snapshot (data entry stays paused, or resumes and the cutover is rescheduled).
4. **Apply migration 0017 to production** (`npm run db:migrate` with the production settings). The ledger starts in
   `maintenance`. Check with `scripts/db-status.ts`: 18 migrations. The previous backend keeps running on 0017 until
   step 5 (rehearsed: its reads work, and its writes pass the new constraints before the backfill).
5. **Deploy the backend:** merge the release branch into the backend `main` and push. Wait until Render shows the
   deploy live and `GET /api/v1/health` answers 200. Never before step 4: the new backend on 0016 fails every ledger
   read and write. In maintenance it answers every money write with 503 `ledger_maintenance`.
6. **Deploy the frontend:** merge the release branch into the frontend `main` and push, then wait for Vercel's
   production deploy. Never before step 5: the new pages need the new endpoints.
7. **Run the backfill:**
   ```sh
   npx tsx scripts/ledger-backfill.ts --preflight                                      # rate coverage (read-only)
   npx tsx scripts/ledger-backfill.ts --baseline <approved> --baseline-sha256 <sha>    # dry run: baselineChanges [], unresolvedExclusions []
   npx tsx scripts/ledger-backfill.ts --apply --database <name> --baseline <approved> --baseline-sha256 <sha>
   ```
   `--apply` compares the records with the approved baseline in the same snapshot it posts from, and refuses on any
   difference. A rerun writes 0 rows. The rehearsed count is 51.
8. **Reconcile every expected difference:**
   ```sh
   npx tsx scripts/ledger-reconcile.ts --baseline <approved> --baseline-sha256 <sha> --compare-legacy <expect>
   ```
   Every check `ok`, no baseline `changes`, `unexpected: []`. The differences must be exactly the approved ones,
   amounts included: an unlisted one, a listed one with other amounts and a listed one that does not occur all fail.
9. **Open the ledger, only after step 8 passed:**
   ```sh
   npx tsx scripts/ledger-reconcile.ts --baseline <approved> --baseline-sha256 <sha> --compare-legacy <expect> --open "who, why" --database <name>
   ```
   It reruns every check and opens only when all of them pass (`"opened": true`).
10. **Resume data entry** and tell every user.

Incident after opening: `npx tsx scripts/ledger-reconcile.ts --close "reason" --database <name>` pauses every money
write again (503); reads keep working.

### 5. Rollback (production; only inside the rollback boundary)

**The rollback boundary.** Rollback is refused, and the only way on is to fix forward, as soon as any one of these
holds:

- The journal has an entry written by the application (`origin = 'app'`): any payment, void or adjustment, or any
  order created, changed or deleted through the new backend.
- A payment exists that has no order (orderless), is voided, or was recorded with an idempotency key
  (`client_request_id`).
- Any legacy record (order, order line, payment, advance entry, supplier deposit) was added, removed or changed in a
  financial field since the approved baseline.
- A migration after 0017 is applied: the down script reverts 0017 only.

The rollback check refuses on the first three, the down script itself also on the first two. The down script does not
compare the baseline: never run it when the rollback check refuses. The ledger must also be in `maintenance` (step 1
below): a precondition, not a reason to roll forward. Once the ledger has been open to users, expect the boundary to
be crossed: rollback is realistic only between cutover steps 4 and 9.

Otherwise, with the owner's approval, in this order:

1. `npx tsx scripts/ledger-reconcile.ts --close "reason" --database <name>`: money writes paused (503).
2. Pause all data entry and stop the new backend (Render: suspend the service), so nothing writes from here on.
3. `npx tsx scripts/ledger-rollback-check.ts --baseline <approved> --baseline-sha256 <sha>`: `"rollbackAllowed": true`,
   exit 0. Items 6 (the previous backend on 0017, proven in the rehearsal) and 7 (the owner's approval) are manual.
4. `psql -v ON_ERROR_STOP=1 -f scripts/rollback/0017-down.sql` against production. Exit 0: 0017 is reverted. Any other
   exit code: it refused or failed and changed nothing (it runs in one transaction), so roll forward instead.
5. Redeploy the previous backend (revert the merge on the backend `main` and push, or deploy its commit on Render),
   then resume the service. Not before step 4: after a backfill, the previous backend's payment and advance deletes
   fail (500) while the ledger tables exist.
6. Roll back the frontend (Vercel: promote the previous production deploy, and revert the merge on the frontend
   `main` so the next push does not deploy it again).
7. Check that the previous screens read correctly, then resume data entry.

**Rehearsed 2026-11-21** on disposable local copies (`rollback-a8/SUMMARY.txt`): after the backfill (51 postings) the
check allowed and the down script reverted 0017, leaving every table, row, column, constraint, index, trigger,
function and migration record identical to the pre-0017 state. On separate copies the check refused an app-written
entry, an orderless payment, a voided payment, a keyed payment, an open ledger and a changed order line; the down script
refused (exit 3) the first five and changed nothing.

**Limits.** The rollback removes the ledger tables and every posting in them (a later cutover backfills again from
the legacy records). It does not undo deploys: steps 5 and 6 do. It cannot recover from anything past the boundary.
