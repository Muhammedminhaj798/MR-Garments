import { eq, sql } from "drizzle-orm";

import { config } from "../src/config";
import { createDatabase, type Database, databaseName } from "../src/db/client";
import { ledgerState } from "../src/db/schema";
import {
  BASELINE_FORMAT,
  baselineChanges,
  DEFAULT_HOLDS,
  DEFAULT_RECEIPT_EXCLUSIONS,
  type Expectation,
  legacyDifferences,
  legacyRecords,
  parseExpectation,
  readBaseline,
  reconcileLedger,
  unexpectedDifferences,
  writeBaseline,
} from "../src/modules/ledger/backfill";

// Plan 4.6 / 4.7 / 9.4 (docs/unified-ledger.md, release order in docs/operator-commands.md): checks every invariant and
// is the only way to open the ledger.
//
//   tsx scripts/ledger-reconcile.ts --write-baseline <new file>      REHEARSAL ONLY (refused in production or on a non-
//                                                                    local database; never overwrites): every legacy record's financial
//                                                                    fields, from the restored snapshot; the owner
//                                                                    approves the file by its sha256
//   tsx scripts/ledger-reconcile.ts --check-baseline f --baseline-sha256 h
//                                                                    ONLY compare the legacy records with the approved
//                                                                    baseline (read-only, works before 0017); exit 1 on
//                                                                    any record added, removed or changed
//   tsx scripts/ledger-reconcile.ts                                  checks (read-only); exit 1 on any failure
//     --baseline f --baseline-sha256 h                               also compare with the approved baseline
//     --compare-legacy --expect <PO>=<legacy>:<ledger> ...           orders whose settled figure differs from the legacy
//                                                                    rules must be exactly the listed ones, amounts too
//     --open "note" --database X                                     set the guard to live, only when all of it passes
//   tsx scripts/ledger-reconcile.ts --close "reason" --database X    set the guard back to maintenance (incident use)

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const values = (name: string) => args.flatMap((arg, at) => (arg === name && args[at + 1] ? [args[at + 1]!] : []));

const settings = config();
const name = databaseName(settings.DATABASE_URL);
const changing = flag("--open") || flag("--close");
if (changing && value("--database") !== name) {
  console.error(`Refusing to change the ledger state: pass --database ${name} to confirm the database.`);
  process.exit(2);
}
// The approved baseline is written in the rehearsal, from the snapshot restored on this computer: never in production,
// never from a database elsewhere.
const host = new URL(settings.DATABASE_URL).hostname;
if (flag("--write-baseline") && (settings.NODE_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(host))) {
  console.error("Refusing to write a baseline: only from the snapshot restored on this computer (a local database, NODE_ENV not production).");
  process.exit(2);
}
if ((flag("--check-baseline") || flag("--baseline")) && !value("--baseline-sha256")) {
  console.error("Refusing: pass --baseline-sha256 <the approved sha256> with the baseline file.");
  process.exit(2);
}
let expected: Expectation[] = [];
try {
  expected = values("--expect").map(parseExpectation);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
const { db, pool } = createDatabase(settings.DATABASE_URL);
let exitCode = 0;
try {
  if (flag("--close")) {
    const note = value("--close");
    if (!note) throw new Error("--close needs a reason.");
    await db.update(ledgerState).set({ state: "maintenance", changedAt: new Date(), note: `closed: ${note}` }).where(eq(ledgerState.id, "ledger"));
    console.info(JSON.stringify({ database: name, state: "maintenance", note }));
  } else if (flag("--write-baseline")) {
    const file = value("--write-baseline");
    if (!file) throw new Error("--write-baseline needs a new file name.");
    const records = await legacyRecords(db);
    const sha256 = writeBaseline(file, { format: BASELINE_FORMAT, database: name, takenAt: new Date().toISOString(), records });
    const counts = Object.fromEntries(Object.entries(records).map(([table, rows]) => [table, Object.keys(rows).length]));
    console.info(JSON.stringify({ database: name, baseline: file, sha256, records: counts }, null, 2));
  } else if (flag("--check-baseline")) {
    const baseline = readBaseline(value("--check-baseline") ?? "", value("--baseline-sha256")!);
    const changes = baselineChanges(baseline.records, await legacyRecords(db));
    console.info(JSON.stringify({ database: name, baseline: { file: baseline.file, sha256: baseline.sha256, takenAt: baseline.takenAt }, ok: changes.length === 0, changes }, null, 2));
    if (changes.length > 0) exitCode = 1;
  } else {
    const opening = flag("--open");
    // One snapshot for every check (repeatable read). Opening also locks the legacy tables and the journal against
    // writes (SHARE) before the first read, until the switch to live commits: nothing can change between the checks and
    // the opening. A plain check locks nothing.
    exitCode = await db.transaction(
      async (tx) => {
        if (opening) {
          await tx.execute(sql`set local lock_timeout = '10s'`);
          await tx.execute(sql`lock table orders, order_lines, receipts, receipt_lines, payments, supplier_advance_entries, supplier_deposits, supplier_deposit_transactions, supplier_ledger_entries, supplier_ledger_holds in share mode`);
        }
        return reconcile(tx);
      },
      { isolationLevel: "repeatable read" },
    );
  }
} finally {
  await pool.end();
}
process.exit(exitCode);

/** The checks, then --open, all in the caller's transaction. Returns the exit code. */
async function reconcile(db: Parameters<Parameters<Database["transaction"]>[0]>[0]) {
  let exitCode = 0;
  const result = await reconcileLedger(db, DEFAULT_HOLDS, DEFAULT_RECEIPT_EXCLUSIONS);
  const report: Record<string, unknown> = { database: name, ok: result.ok, checks: result.checks };
  let ok = result.ok;
  const baselineFile = value("--baseline");
  if (baselineFile) {
    const baseline = readBaseline(baselineFile, value("--baseline-sha256")!);
    const changes = baselineChanges(baseline.records, await legacyRecords(db));
    report.baseline = { file: baseline.file, sha256: baseline.sha256, takenAt: baseline.takenAt, changes };
    ok &&= changes.length === 0;
  }
  if (flag("--compare-legacy")) {
    const differences = await legacyDifferences(db);
    const unexpected = unexpectedDifferences(differences, expected);
    report.legacy = { differences, expected, unexpected };
    ok &&= unexpected.length === 0;
  }
  report.ok = ok;
  if (flag("--open")) {
    const note = value("--open");
    if (!note) throw new Error("--open needs a note (who opens it and why).");
    // Opening needs every check: the legacy records against the approved baseline and the approved legacy differences.
    const missing = [
      !baselineFile && "--baseline <approved file>",
      !value("--baseline-sha256") && "--baseline-sha256 <its approved sha256>",
      !flag("--compare-legacy") && "--compare-legacy --expect <PO>=<legacy>:<ledger>...",
    ].filter(Boolean);
    if (missing.length > 0) {
      report.opened = false;
      report.refused = `--open also needs ${missing.join(" and ")}`;
      exitCode = 1;
    } else if (!ok) {
      report.opened = false;
      exitCode = 1;
    } else {
      await db.update(ledgerState).set({ state: "live", changedAt: new Date(), note: `opened: ${note}` }).where(eq(ledgerState.id, "ledger"));
      report.opened = true;
    }
  }
  if (!ok) exitCode = 1;
  console.info(JSON.stringify(report, null, 2));
  return exitCode;
}
