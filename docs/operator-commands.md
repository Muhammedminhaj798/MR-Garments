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

Release order, each step only with the owner's approval.

BEFORE migration 0017 (data entry paused):

```sh
npx tsx scripts/ledger-reconcile.ts --write-baseline before.json      # legacy fingerprints only (works before 0017)
```

Then migrate (the ledger opens in `maintenance`) and deploy the backend, then run the commands below. The `--expect`
list is derived from the 2026-11-20 production snapshot (PO-1134647: the 270.14 excess; 6422 and 6423: SUP-004's
genuine 25,000 receipt settles them FIFO). Re-derive it from the cutover snapshot's rehearsal before use: any receipt
or payment entered since then can change it.

```sh
npx tsx scripts/ledger-backfill.ts --preflight                         # rate coverage (read-only)
npx tsx scripts/ledger-backfill.ts                                     # dry run
npx tsx scripts/ledger-backfill.ts --apply --database <name>           # post history (idempotent: a rerun writes 0)
npx tsx scripts/ledger-reconcile.ts --baseline before.json --compare-legacy --expect PO-1134647 --expect 6422 --expect 6423
npx tsx scripts/ledger-reconcile.ts --baseline before.json --compare-legacy --expect PO-1134647 --expect 6422 --expect 6423 --open "who, why" --database <name>
npx tsx scripts/ledger-reconcile.ts --close "reason" --database <name> # incident: writes paused again
npx tsx scripts/ledger-rollback-check.ts --baseline before.json        # only before any application write
psql -f scripts/rollback/0017-down.sql                                 # only after the check passes and the owner approves
```
