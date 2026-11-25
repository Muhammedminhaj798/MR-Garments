import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { orderLines, receipts, suppliers, users } from "../../db/schema";
import { api, createTestContext, receiveOrder, resetData, SEEDED, signInAs } from "../../test/harness";
import { buildLifecycle } from "../reports/test-data";
import { indiaDay } from "../stock/fixtures";

// Supplier Full History (docs/supplier-history.md) on the lifecycle orders (reports/test-data.ts): A Guangzhou (legacy
// payments posted by the backfill: migrated; an agent payment; container C1 cleared, trucked, stocked), B Shenzhen,
// C Foshan (a deposit), D Yiwu (nothing received), E Hangzhou (part received). Added here through the API: an orderless
// payment to Foshan then voided, a Management adjustment on Foshan, a forward payment to Guangzhou (records A's final
// landed cost), a receipt on D then deleted, and a hold on Yiwu. Every figure must equal the existing reports'.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let data: Awaited<ReturnType<typeof buildLifecycle>>;
const ids: Record<string, string> = {};
let voidedPayment = "";
let fingerprintBefore = "";

const supplierId = async (name: string) => (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, name)))[0]!.id;
const get = async (path: string, cookie = management) => {
  const res = await http.get(path).set("Cookie", cookie);
  expect(res.status, `${path}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  return res.body;
};
beforeAll(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  data = await buildLifecycle(ctx);
  for (const name of ["Guangzhou Textile Co.", "Shenzhen Apparel", "Foshan Fabrics", "Yiwu Trims Ltd.", "Hangzhou Knits"]) ids[name] = await supplierId(name);
  const pay = (body: object) => http.post("/payments", { rateInr: 12, mode: "Bank transfer", paidOn: indiaDay(), clientRequestId: randomUUID(), ...body }).set("Cookie", management);
  // Foshan: an orderless payment of ¥500, voided with a reason; a Management adjustment of −¥25.
  const foshan = await pay({ supplierId: ids["Foshan Fabrics"], amount: 500, reference: "UTR-HIST-1" });
  expect(foshan.status, JSON.stringify(foshan.body)).toBe(201);
  voidedPayment = foshan.body.payment.id;
  expect((await http.delete(`/payments/${voidedPayment}`).send({ reason: "Entered twice" }).set("Cookie", management)).status).toBe(200);
  const adjust = await http
    .post(`/suppliers/${ids["Foshan Fabrics"]}/ledger/adjustments`)
    .send({ currency: "CNY", amount: -25, entryDate: indiaDay(), rateInr: 12, reason: "Bank charge", idempotencyKey: randomUUID() })
    .set("Cookie", management);
  expect(adjust.status, JSON.stringify(adjust.body)).toBe(201);
  // Guangzhou: a forward payment records A's final landed cost (final_cost_protections).
  expect((await pay({ supplierId: ids["Guangzhou Textile Co."], amount: 50, reference: "UTR-HIST-2" })).status).toBe(201);
  // D: a receipt of 20 recorded and then deleted (only its ledger value changes remain).
  const [line] = await ctx.db.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, data.d.id));
  await receiveOrder(ctx, data.d.id, { [line!.id]: 20 });
  const [receipt] = await ctx.db.select({ id: receipts.id }).from(receipts).where(eq(receipts.orderId, data.d.id));
  const removed = await http.delete(`/receipts/${receipt!.id}`).send({}).set("Cookie", management);
  expect(removed.status, JSON.stringify(removed.body)).toBe(204);
  // Yiwu: its CNY account held (D4).
  await ctx.db.execute(sql`insert into supplier_ledger_holds (supplier_id, currency, reason) values (${ids["Yiwu Trims Ltd."]}, 'CNY', 'Pending review (test)')`);
  fingerprintBefore = await tableFingerprint();
});

/** Every public table (the session store aside) as one fingerprint: proves the history wrote nothing. */
async function tableFingerprint() {
  const tables = (await ctx.db.execute<{ t: string }>(sql`select table_name t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'session' order by 1`)).rows;
  const parts: string[] = [];
  for (const { t } of tables) {
    const [row] = (await ctx.db.execute<{ n: number; fp: string }>(sql.raw(`select count(*)::int n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') fp from "${t}" x`))).rows;
    parts.push(`${t}:${row!.n}:${row!.fp}`);
  }
  return parts.join("|");
}

describe("access", () => {
  it("is 401 signed out, 403 for every role but Management, 404 for an unknown supplier and 400 for a malformed query", async () => {
    const id = ids["Foshan Fabrics"]!;
    const paths = [`/suppliers/${id}/history`, `/suppliers/${id}/history/header`, `/suppliers/${id}/history/orders`, `/suppliers/${id}/history/payments`, `/suppliers/${id}/history/receipts`, `/suppliers/${id}/history/landed-cost`, `/suppliers/${id}/history/events`, "/reports/supplier-history"];
    for (const path of paths) expect((await http.get(path)).status, path).toBe(401);
    for (const who of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      const cookie = await signInAs(ctx, who);
      for (const path of paths) expect((await http.get(path).set("Cookie", cookie)).status, `${who} ${path}`).toBe(403);
    }
    for (const path of paths) await get(path);
    expect((await http.get(`/suppliers/${randomUUID()}/history`).set("Cookie", management)).status).toBe(404);
    expect((await http.get("/suppliers/not-an-id/history/orders").set("Cookie", management)).status).toBe(404);
    for (const bad of [`/suppliers/${id}/history/events?types=nope`, `/suppliers/${id}/history/orders?from=2026-12-01&to=2026-11-01`, `/suppliers/${id}/history/payments?page=0`, "/reports/supplier-history?supplierId=x", `/suppliers/${id}/history/receipts?extra=1`]) {
      expect((await http.get(bad).set("Cookie", management)).status, bad).toBe(400);
    }
  });
});

describe("financial figures equal the existing reports and the ledger (no second formula)", () => {
  it("overview: per-currency totals equal the supplier detail report; payments less voids plus adjustments equal the ledger's credits", async () => {
    for (const name of ["Guangzhou Textile Co.", "Foshan Fabrics", "Hangzhou Knits"]) {
      const id = ids[name]!;
      const overview = await get(`/suppliers/${id}/history`);
      // SH-0 (every tab's header) is SH-1's supplier, holds and live accounts, nothing else.
      expect(await get(`/suppliers/${id}/history/header`)).toEqual({ supplier: overview.supplier, accounts: overview.accounts, holds: overview.holds });
      const detail = await get(`/reports/payments-per-supplier/${id}`);
      const ledger = await get(`/suppliers/${id}/ledger`);
      for (const total of overview.totals) {
        const reported = detail.summary.byCurrency.find((row: { currency: string }) => row.currency === total.currency);
        expect(total, name).toMatchObject({ orderValue: reported.orderValueCny, settled: reported.settledCny, outstanding: reported.outstandingCny });
        const account = ledger.accounts.find((row: { currency: string }) => row.currency === total.currency);
        expect(Math.round((total.paymentsActive + total.adjustments) * 100), name).toBe(Math.round(account.creditsCny * 100));
      }
      expect(overview.accounts).toEqual(ledger.accounts.map(({ ...account }) => account));
    }
  });

  it("payments: a voided payment is listed with its reason but counts in no total; current FIFO shares add up to the orders' settled, once", async () => {
    const id = ids["Foshan Fabrics"]!;
    const body = await get(`/suppliers/${id}/history/payments`);
    const voided = body.payments.rows.find((row: { id: string }) => row.id === voidedPayment);
    expect(voided).toMatchObject({ voided: true, voidReason: "Entered twice", reference: "UTR-HIST-1", ledgerCredit: 500, ledgerVoid: -500, settlesNow: [] });
    const overview = await get(`/suppliers/${id}/history`);
    expect(body.totals.find((t: { currency: string }) => t.currency === "CNY").active).toBe(overview.totals.find((t: { currency: string }) => t.currency === "CNY").paymentsActive);
    expect((await get(`/suppliers/${id}/history/payments?status=voided`)).payments.rows.map((row: { id: string }) => row.id)).toEqual([voidedPayment]);
    // No double counting: what every credit settles now adds up to what every order is settled by.
    for (const name of ["Guangzhou Textile Co.", "Shenzhen Apparel", "Foshan Fabrics"]) {
      const supplier = ids[name]!;
      const shares = (await get(`/suppliers/${supplier}/history/payments`)).payments.rows.flatMap((row: { settlesNow: { amount: number }[] }) => row.settlesNow);
      const orders = (await get(`/suppliers/${supplier}/history/orders`)).orders.rows;
      expect(Math.round(shares.reduce((t: number, s: { amount: number }) => t + s.amount, 0) * 100), name).toBe(Math.round(orders.reduce((t: number, o: { settledCny: number | null }) => t + (o.settledCny ?? 0), 0) * 100));
    }
    // Agent (sea-freight) payments are never supplier payments.
    const guangzhou = await get(`/suppliers/${ids["Guangzhou Textile Co."]}/history/payments`);
    expect(guangzhou.payments.rows.every((row: { payeeRole: string }) => row.payeeRole === "supplier")).toBe(true);
    expect(guangzhou.payments.rows.filter((row: { migrated: boolean }) => row.migrated)).toHaveLength(2);
  });

  it("orders and landed cost: the Order Report's rows and loadLandedCosts' parts; agent payments listed apart; A protected", async () => {
    const id = ids["Guangzhou Textile Co."]!;
    const history = await get(`/suppliers/${id}/history/orders`);
    const report = await get(`/reports/supplier-orders?supplierId=${id}`);
    const { protectedAt, ...rowA } = history.orders.rows[0];
    expect(rowA).toEqual(report.suppliers[0].rows[0]);
    expect(protectedAt).toEqual(expect.any(String));
    const cost = await get(`/suppliers/${id}/history/landed-cost`);
    const orderA = cost.orders.rows.find((row: { id: string }) => row.id === data.a.id);
    expect(orderA.landedCost).toEqual(report.suppliers[0].rows[0].landedCost);
    expect(orderA.agentPayments).toMatchObject([{ payeeRole: "agent", amountCny: 100, amountInr: 1200 }]);
    expect(orderA.containers[0]).toMatchObject({ number: "RPTU 1000001", clearing: { status: "cleared" }, transport: expect.any(Object) });
    expect(orderA.protectedAt).toEqual(protectedAt);
  });

  it("receiving: each receipt with its lines, containers and warehouse split; a deleted receipt is not listed", async () => {
    const guangzhou = (await get(`/suppliers/${ids["Guangzhou Textile Co."]}/history/receipts`)).receipts.rows;
    expect(guangzhou[0].lines[0]).toMatchObject({ item: "Polo shirts", quantity: 100, containers: [{ number: "RPTU 1000001" }] });
    expect(guangzhou[0].lines[0].warehouse.map((split: { team: string }) => split.team).sort()).toEqual(["Online team", "Retail team"]);
    // The recorder is the user REC-1 stored, by name (never the raw id).
    const [named] = await ctx.db.select({ name: users.name }).from(users).innerJoin(receipts, eq(receipts.receivedBy, users.id)).where(eq(receipts.id, guangzhou[0].id));
    expect(guangzhou[0].receivedBy).toBe(named!.name);
    expect((await get(`/suppliers/${ids["Yiwu Trims Ltd."]}/history/receipts`)).receipts.total).toBe(0);
  });
});

describe("activity timeline", () => {
  it("shows what each source records, labels migrated postings and unrecorded authors, keeps voids, and never invents the deleted receipt", async () => {
    const guangzhou = (await get(`/suppliers/${ids["Guangzhou Textile Co."]}/history/events?all=1`)).events.rows as { type: string; origin: string; actor: string | null; status: string | null }[];
    const types = new Set(guangzhou.map((event) => event.type));
    for (const type of ["supplier_created", "order_placed", "payment_recorded", "agent_payment", "container_loaded", "clearing_recorded", "transport_recorded", "warehouse_stocked", "landed_cost_final"]) expect(types.has(type), type).toBe(true);
    const migrated = guangzhou.filter((event) => event.origin === "migrated");
    expect(migrated.length).toBeGreaterThan(0);
    expect(migrated.every((event) => event.actor === null)).toBe(true);
    const foshan = (await get(`/suppliers/${ids["Foshan Fabrics"]}/history/events?all=1`)).events.rows;
    expect(foshan.find((event: { type: string }) => event.type === "payment_voided")).toMatchObject({ amount: -500, reason: "Entered twice", actor: "Suresh Menon" });
    expect(foshan.find((event: { type: string; status: string }) => event.type === "payment_recorded" && event.status === "voided")).toMatchObject({ amount: 500, reference: "UTR-HIST-1" });
    expect(foshan.find((event: { type: string }) => event.type === "management_adjustment")).toMatchObject({ amount: -25, reason: "Bank charge" });
    // Yiwu: the receipt is gone; its value changes stay (held: posted before the hold); everything shows the hold.
    const yiwu = (await get(`/suppliers/${ids["Yiwu Trims Ltd."]}/history/events?all=1`)).events.rows;
    expect(yiwu.some((event: { type: string }) => event.type === "receipt_recorded")).toBe(false);
    expect(yiwu.filter((event: { type: string }) => event.type === "order_value_changed").map((event: { amount: number }) => event.amount).sort()).toEqual([-400, 400]);
    expect(yiwu.find((event: { type: string }) => event.type === "account_held")).toMatchObject({ reason: "Pending review (test)", status: "held" });
    expect(yiwu.filter((event: { currency: string | null }) => event.currency === "CNY").every((event: { status: string }) => event.status === "held")).toBe(true);
    const receipt = (await get(`/suppliers/${ids["Hangzhou Knits"]}/history/events?types=receipt_recorded`)).events.rows[0];
    expect(receipt).toMatchObject({ type: "receipt_recorded", actor: expect.any(String), po: data.e.po });
    expect(receipt.actor).not.toMatch(/^[0-9a-f]{8}-/);
  });

  it("filters by type, status, text and dates, pages stably, and the report spans one or every supplier", async () => {
    const id = ids["Guangzhou Textile Co."]!;
    const all = (await get(`/suppliers/${id}/history/events?all=1`)).events.rows as { id: string; date: string; type: string }[];
    expect(all.map((event) => event.date)).toEqual([...all.map((event) => event.date)].sort().reverse());
    const page1 = (await get(`/suppliers/${id}/history/events?page=1`)).events;
    expect(page1).toMatchObject({ page: 1, pageSize: 25, total: all.length });
    expect((await get(`/suppliers/${id}/history/events?page=2`)).events.rows).toEqual(all.slice(25, 50));
    const payments = (await get(`/suppliers/${id}/history/events?types=payment_recorded,agent_payment`)).events.rows;
    expect(payments.every((event: { type: string }) => ["payment_recorded", "agent_payment"].includes(event.type))).toBe(true);
    expect((await get(`/suppliers/${id}/history/events?status=migrated`)).events.rows.every((event: { origin: string }) => event.origin === "migrated")).toBe(true);
    expect((await get(`/suppliers/${id}/history/events?q=RPTU 1000001`)).events.rows.length).toBeGreaterThan(0);
    const recent = (await get(`/suppliers/${id}/history/events?from=${indiaDay(-1)}&to=${indiaDay()}`)).events.rows;
    expect(recent.every((event: { date: string }) => event.date >= indiaDay(-1) && event.date <= indiaDay())).toBe(true);
    const report = await get("/reports/supplier-history?all=1");
    expect(new Set(report.events.rows.map((event: { supplier: { id: string } }) => event.supplier.id)).size).toBeGreaterThan(3);
    const one = await get(`/reports/supplier-history?supplierId=${id}&all=1`);
    expect(one.events.rows).toEqual(all);
    expect(one.filter.supplier).toBe("Guangzhou Textile Co.");
    expect(one.options.types).toContain("payment_voided");
  });
});

it("writes nothing: every table is unchanged after reading every history endpoint", async () => {
  for (const name of Object.keys(ids)) {
    const id = ids[name]!;
    for (const path of ["", "/orders", "/payments", "/receipts", "/landed-cost", "/events?all=1"]) await get(`/suppliers/${id}/history${path}`);
  }
  await get("/reports/supplier-history?all=1");
  expect(await tableFingerprint()).toBe(fingerprintBefore);
});

