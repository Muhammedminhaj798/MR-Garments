import { readFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { createTestContext } from "../test/harness";

// Migration 0020 (owner approval of 2026-11-25): two indexes on order_line_id, schema only. The test database is
// migrated to the latest by the global setup, so it carries them.
const ctx = createTestContext();
afterAll(() => ctx.pool.end());

const MIGRATION = "drizzle/0020_receipt_line_indexes.sql";

describe("migration 0020: receipt and warehouse receipt lines indexed by order line", () => {
  it("creates exactly the two indexes and changes nothing else (no data, no constraint, no column)", () => {
    const statements = readFileSync(MIGRATION, "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.replace(/^--.*$/gm, "").trim())
      .filter(Boolean);
    expect(statements).toEqual([
      'CREATE INDEX "receipt_lines_order_line_idx" ON "receipt_lines" USING btree ("order_line_id");',
      'CREATE INDEX "warehouse_receipt_lines_order_line_idx" ON "warehouse_receipt_lines" USING btree ("order_line_id");',
    ]);
  });

  it("the migrated database has each once, beside the unchanged primary keys", async () => {
    const { rows } = await ctx.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'public' and tablename in ('receipt_lines', 'warehouse_receipt_lines') order by indexname`,
    );
    expect(rows.map((row) => row.indexdef)).toEqual([
      "CREATE INDEX receipt_lines_order_line_idx ON public.receipt_lines USING btree (order_line_id)",
      "CREATE UNIQUE INDEX receipt_lines_receipt_id_order_line_id_pk ON public.receipt_lines USING btree (receipt_id, order_line_id)",
      "CREATE INDEX warehouse_receipt_lines_order_line_idx ON public.warehouse_receipt_lines USING btree (order_line_id)",
      "CREATE UNIQUE INDEX warehouse_receipt_lines_receipt_id_order_line_id_team_id_pk ON public.warehouse_receipt_lines USING btree (receipt_id, order_line_id, team_id)",
    ]);
  });

  it("a per-line lookup can use them (the order reports' received and stocked sums)", async () => {
    const client = await ctx.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local enable_seqscan = off"); // a tiny test table would otherwise be scanned anyway
      for (const [table, index] of [
        ["receipt_lines", "receipt_lines_order_line_idx"],
        ["warehouse_receipt_lines", "warehouse_receipt_lines_order_line_idx"],
      ]) {
        const { rows } = await client.query<{ "QUERY PLAN": string }>(`explain select sum(quantity) from ${table} where order_line_id = '00000000-0000-0000-0000-000000000000'`);
        expect(rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(index);
      }
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
