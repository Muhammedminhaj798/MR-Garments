import { readFileSync, writeFileSync } from "node:fs";

import { eq } from "drizzle-orm";

import { config } from "../src/config";
import { createDatabase, databaseName } from "../src/db/client";
import { ledgerState } from "../src/db/schema";
import { DEFAULT_HOLDS, DEFAULT_RECEIPT_EXCLUSIONS, legacyDifferences, legacyFingerprints, reconcileLedger } from "../src/modules/ledger/backfill";

// Plan 4.6 / 4.7 / 9.4 (docs/unified-ledger.md): checks every invariant and is the only way to open the ledger.
//
//   tsx scripts/ledger-reconcile.ts                                    checks (read-only); exit 1 on any failure
//   tsx scripts/ledger-reconcile.ts --write-baseline before.json       ONLY save the legacy table fingerprints (run it
//                                                                      BEFORE migration 0017; nothing else is checked)
//   tsx scripts/ledger-reconcile.ts --baseline before.json             also compare them with a saved baseline
//   tsx scripts/ledger-reconcile.ts --compare-legacy --expect PO-1     list orders whose settled figure differs from the
//                                                                      legacy rules; any PO not listed in --expect fails
//   tsx scripts/ledger-reconcile.ts --open "note" --database X ...     set the guard to live, only when everything passes
//   tsx scripts/ledger-reconcile.ts --close "reason" --database X      set the guard back to maintenance (incident use)

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const values = (name: string) => args.flatMap((arg, at) => (arg === name && args[at + 1] ? [args[at + 1]!] : []));

const url = config().DATABASE_URL;
const name = databaseName(url);
const changing = flag("--open") || flag("--close");
if (changing && value("--database") !== name) {
  console.error(`Refusing to change the ledger state: pass --database ${name} to confirm the database.`);
  process.exit(2);
}
const { db, pool } = createDatabase(url);
let exitCode = 0;
try {
  if (flag("--close")) {
    const note = value("--close");
    if (!note) throw new Error("--close needs a reason.");
    await db.update(ledgerState).set({ state: "maintenance", changedAt: new Date(), note: `closed: ${note}` }).where(eq(ledgerState.id, "ledger"));
    console.info(JSON.stringify({ database: name, state: "maintenance", note }));
  } else if (value("--write-baseline")) {
    // Before 0017 the ledger tables don't exist yet: the baseline is the legacy fingerprints alone (they work before
    // and after the migration), taken before anything else runs.
    const fingerprints = await legacyFingerprints(db);
    writeFileSync(value("--write-baseline")!, JSON.stringify(fingerprints, null, 2));
    console.info(JSON.stringify({ database: name, baseline: value("--write-baseline"), fingerprints }, null, 2));
  } else {
    const result = await reconcileLedger(db, DEFAULT_HOLDS, DEFAULT_RECEIPT_EXCLUSIONS);
    const fingerprints = await legacyFingerprints(db);
    const report: Record<string, unknown> = { database: name, ok: result.ok, checks: result.checks, fingerprints };
    let ok = result.ok;
    const baselineFile = value("--baseline");
    if (baselineFile) {
      const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Record<string, string>;
      const changed = Object.keys(baseline).filter((table) => baseline[table] !== fingerprints[table]);
      report.baseline = { file: baselineFile, changed };
      ok &&= changed.length === 0;
    }
    if (flag("--compare-legacy")) {
      const expected = new Set(values("--expect"));
      const differences = await legacyDifferences(db);
      const unexpected = differences.filter((row) => !expected.has(row.po));
      report.legacy = { differences, unexpected: unexpected.map((row) => row.po) };
      ok &&= unexpected.length === 0;
    }
    report.ok = ok;
    if (flag("--open")) {
      const note = value("--open");
      if (!note) throw new Error("--open needs a note (who opens it and why).");
      // Opening needs every check: the legacy tables against the pre-release baseline and the legacy figures.
      const missing = [!baselineFile && "--baseline <file>", !flag("--compare-legacy") && "--compare-legacy --expect <PO>..."].filter(Boolean);
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
  }
} finally {
  await pool.end();
}
process.exit(exitCode);
