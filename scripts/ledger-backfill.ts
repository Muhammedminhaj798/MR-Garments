import { config } from "../src/config";
import { createDatabase, databaseName } from "../src/db/client";
import { backfillLedger, DEFAULT_HOLDS, DEFAULT_RECEIPT_EXCLUSIONS, rateCoverage } from "../src/modules/ledger/backfill";

// Plan 9.4 (docs/unified-ledger.md): posts the ledger's history exactly once. A dry run unless --apply is given, and
// --apply also needs --database <name> naming the database it connects to, so it can never run against the wrong one.
//
//   tsx scripts/ledger-backfill.ts --preflight             rate coverage per supplier and currency (read-only)
//   tsx scripts/ledger-backfill.ts                         dry run: what would be written, then rolled back
//   tsx scripts/ledger-backfill.ts --apply --database X    write it (idempotent: a second run writes 0 rows)
//
// The exclusion lists are DEFAULT_HOLDS (the whole SUP-010 CNY account, owner decision D4) and DEFAULT_RECEIPT_EXCLUSIONS
// (single legacy receipts the owner ruled invalid; --apply refuses if one is unknown, not a receipt or drawn from).
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
const { db, pool } = createDatabase(url);
try {
  if (flag("--preflight")) {
    console.info(JSON.stringify({ database: name, preflight: await rateCoverage(db, DEFAULT_RECEIPT_EXCLUSIONS) }, null, 2));
  } else {
    const result = await backfillLedger(db, { apply, holds: DEFAULT_HOLDS, excludedReceipts: DEFAULT_RECEIPT_EXCLUSIONS });
    console.info(JSON.stringify({ database: name, ...result }, null, 2));
  }
} finally {
  await pool.end();
}
