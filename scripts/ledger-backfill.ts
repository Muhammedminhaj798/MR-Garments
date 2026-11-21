import { config } from "../src/config";
import { createDatabase, databaseName } from "../src/db/client";
import { backfillLedger, DEFAULT_HOLDS, DEFAULT_RECEIPT_EXCLUSIONS, rateCoverage, readBaseline } from "../src/modules/ledger/backfill";

// Plan 9.4 (docs/unified-ledger.md, release order in docs/operator-commands.md): posts the ledger's history exactly
// once. A dry run unless --apply is given; --apply also needs --database <name> naming the database it connects to, so
// it can never run against the wrong one, and the approved baseline with its sha256, so it posts only the records the
// owner approved in the rehearsal.
//
//   tsx scripts/ledger-backfill.ts --preflight                                     rate coverage (read-only)
//   tsx scripts/ledger-backfill.ts [--baseline f --baseline-sha256 h]              dry run: what would be written, then
//                                                                                  rolled back (and what differs from f)
//   tsx scripts/ledger-backfill.ts --apply --database X --baseline f --baseline-sha256 h
//                                                                                  write it (idempotent: a rerun writes 0)
//
// The exclusion lists are DEFAULT_HOLDS (the whole SUP-010 CNY account, owner decision D4) and DEFAULT_RECEIPT_EXCLUSIONS
// (single legacy receipts the owner ruled invalid; --apply refuses if one is unknown, not a receipt or drawn from).
// --apply also refuses when any legacy record was added, removed or changed (in a financial field) since the baseline.
// Prints JSON only.

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const url = config().DATABASE_URL;
const name = databaseName(url);
const apply = flag("--apply");
if (apply && value("--database") !== name) {
  console.error(`Refusing to apply: pass --database ${name} to confirm the database this run connects to.`);
  process.exit(2);
}
if ((apply || value("--baseline")) && (!value("--baseline") || !value("--baseline-sha256"))) {
  console.error("Refusing: --apply needs --baseline <approved file> --baseline-sha256 <its approved sha256> (the rehearsal's baseline), and a baseline needs its sha256.");
  process.exit(2);
}
const baseline = value("--baseline") ? readBaseline(value("--baseline")!, value("--baseline-sha256")!) : undefined;
const { db, pool } = createDatabase(url);
try {
  if (flag("--preflight")) {
    console.info(JSON.stringify({ database: name, preflight: await rateCoverage(db, DEFAULT_RECEIPT_EXCLUSIONS) }, null, 2));
  } else {
    const result = await backfillLedger(db, { apply, holds: DEFAULT_HOLDS, excludedReceipts: DEFAULT_RECEIPT_EXCLUSIONS, baseline: baseline?.records });
    const report = { database: name, ...(baseline ? { baseline: { file: baseline.file, sha256: baseline.sha256, takenAt: baseline.takenAt } } : {}), ...result };
    console.info(JSON.stringify(report, null, 2));
    if (result.baselineChanges?.length) process.exitCode = 1;
  }
} finally {
  await pool.end();
}
