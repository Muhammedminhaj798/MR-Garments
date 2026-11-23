import { config } from "../src/config";
import { createDatabase, databaseName } from "../src/db/client";
import { revalueToReceived } from "../src/modules/ledger/revalue";

// The historical revaluation to received quantity x rate (owner rules of 2026-11-23; docs/operator-commands.md,
// "Revaluation to received quantity"). Fix-forward only: once applied it is not rolled back.
//
//   tsx scripts/ledger-revalue-received.ts                                       preview: every order's value before and
//                                                                                after, the postings, rolled back
//   tsx scripts/ledger-revalue-received.ts --apply --database X --note "who, why"
//                                                                                write them; only in maintenance, and
//                                                                                only when no final settlement changes
//
// A rerun posts nothing. A held account (D4) is listed and posted nothing: run again once its hold is released.
// Prints JSON only; exit 1 when refused.

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
const note = value("--note");
if (apply && !note?.trim()) {
  console.error('Refusing to apply: pass --note "who runs it and why" (kept on every posting).');
  process.exit(2);
}
const { db, pool } = createDatabase(url);
try {
  const report = await revalueToReceived(db, { apply, note: note?.trim() || "preview" });
  console.info(JSON.stringify({ database: name, ...report }, null, 2));
  if (report.refused) process.exitCode = 1;
} finally {
  await pool.end();
}
