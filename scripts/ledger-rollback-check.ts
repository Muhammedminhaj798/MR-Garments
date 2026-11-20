import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";

import { config } from "../src/config";
import { createDatabase, databaseName } from "../src/db/client";
import { legacyFingerprints } from "../src/modules/ledger/backfill";

// Plan section 14, the pre-rollback checklist (docs/unified-ledger.md). Read-only. Exit 0 only when every automatic item
// holds; the ledger is roll-forward-only once the application has written any financial record through the new backend.
//
//   tsx scripts/ledger-rollback-check.ts --baseline before.json
//
// Items 6 (the previous backend runs on 0017, proven in the rehearsal) and 7 (the owner's approval) are not automatic.

const args = process.argv.slice(2);
const value = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const url = config().DATABASE_URL;
const { db, pool } = createDatabase(url);
const count = async (query: ReturnType<typeof sql>) => Number((await db.execute<{ n: string }>(query)).rows[0]!.n);
try {
  const state = (await db.execute<{ state: string }>(sql`select state from ledger_state where id = 'ledger'`)).rows[0]?.state;
  const items = [
    { item: "1. ledger_state is maintenance (writes paused)", ok: state === "maintenance", detail: state ?? "missing" },
    { item: "2. no application-written ledger entry", ok: (await count(sql`select count(*) as n from supplier_ledger_entries where origin = 'app'`)) === 0 },
    { item: "3a. no orderless payment", ok: (await count(sql`select count(*) as n from payments where order_id is null`)) === 0 },
    { item: "3b. no voided payment", ok: (await count(sql`select count(*) as n from payments where voided_at is not null`)) === 0 },
    { item: "3c. no payment recorded with an idempotency key", ok: (await count(sql`select count(*) as n from payments where client_request_id is not null`)) === 0 },
  ];
  const baselineFile = value("--baseline");
  if (baselineFile) {
    const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Record<string, string>;
    const now = await legacyFingerprints(db);
    const changed = Object.keys(baseline).filter((table) => baseline[table] !== now[table]);
    items.push({ item: "4/5. orders, lines, payments and archives identical to the baseline", ok: changed.length === 0, detail: changed.join(", ") || "identical" } as never);
  } else {
    items.push({ item: "4/5. baseline comparison (pass --baseline before.json)", ok: false, detail: "not checked" } as never);
  }
  const ok = items.every((row) => row.ok);
  console.info(JSON.stringify({ database: databaseName(url), rollbackAllowed: ok, items, manual: ["6. previous backend proven on 0017 in the rehearsal", "7. owner approval"] }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await pool.end();
}
