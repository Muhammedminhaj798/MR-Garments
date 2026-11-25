import { readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, orders, supplierLedgerEntries, suppliers } from "../../db/schema";
import { api, createTestContext, receiveOrder, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf } from "../stock/fixtures";
import { RATE_MESSAGES } from "./suppliers.routes";

// docs/supplier-currency.md: one currency and one INR rate per supplier. New orders are in that currency (another is
// 422) and snapshot the rate, and so does their ledger debit (docs/unified-ledger.md); a later change of the supplier's
// rate never touches them. Supplier deposits are a read-only archive (SD-2 answers 410).

const ctx = createTestContext();
const http = api(ctx);
let management = "";
let accounts = "";
let guangzhou = "";
let jeans = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  accounts = await signInAs(ctx, SEEDED.accounts);
  guangzhou = await idOf(ctx, suppliers, "Guangzhou Textile Co.");
  jeans = await idOf(ctx, items, "Denim jeans");
});
afterAll(() => ctx.pool.end());

const add = (body: object) => http.post("/suppliers", body).set("Cookie", management);
const edit = (id: string, body: object) => http.patch(`/suppliers/${id}`, body).set("Cookie", management);
const get = (path: string) => http.get(path).set("Cookie", management);
const placeOrder = (body: object) => http.post("/orders", body).set("Cookie", management);
const openDeposit = (supplierId: string, body: object) => http.post(`/suppliers/${supplierId}/deposits`, body).set("Cookie", accounts);
const orderBody = (supplierId: string, overrides: object = {}) => ({
  supplierId,
  orderDate: "2026-10-20",
  deliveryDate: "2026-11-30",
  lines: [{ itemId: jeans, quantity: 10, rateCny: 2.5 }],
  deposits: [],
  ...overrides,
});
const supplierRow = async (id: string) => ((await get("/suppliers")).body as { id: string; exchangeRate: number | null; rateUpdatedAt: string | null; hasTransactions: boolean }[]).find((row) => row.id === id)!;

describe("the supplier's currency and rate (MD-2, PATCH /suppliers/:id)", () => {
  it("stores the currency and the rate (INR per 1 unit) with the moment set; an INR supplier's rate is 1 even when left out; no rate is null", async () => {
    const usd = await add({ name: "Ningbo Denim Works", currency: "USD", exchangeRate: 88.25 });
    expect(usd.status).toBe(201);
    expect(usd.body.supplier).toMatchObject({ currency: "USD", exchangeRate: 88.25, rateUpdatedAt: expect.any(String), hasTransactions: false });
    const inr = await add({ name: "Kochi Mills", currency: "INR" });
    expect(inr.body.supplier).toMatchObject({ currency: "INR", exchangeRate: 1, rateUpdatedAt: expect.any(String) });
    // An older client, or a supplier whose rate is not known yet: "not set", never a guessed rate.
    const plain = await add({ name: "Plain Textiles" });
    expect(plain.body.supplier).toMatchObject({ currency: "CNY", exchangeRate: null, rateUpdatedAt: null });
  });

  it("refuses a rate of 0, a negative one, more than 4 decimals, a text, or any rate but 1 for INR, storing nothing", async () => {
    const cases: [object, Record<string, string>][] = [
      [{ currency: "CNY", exchangeRate: 0 }, { exchangeRate: RATE_MESSAGES.rate }],
      [{ currency: "USD", exchangeRate: -1 }, { exchangeRate: RATE_MESSAGES.rate }],
      [{ currency: "USD", exchangeRate: 12.12345 }, { exchangeRate: RATE_MESSAGES.rate }],
      [{ currency: "USD", exchangeRate: "12" }, { exchangeRate: RATE_MESSAGES.rate }],
      [{ currency: "INR", exchangeRate: 12 }, { exchangeRate: RATE_MESSAGES.rateForInr }],
    ];
    for (const [overrides, fields] of cases) {
      const res = await add({ name: "Ningbo Denim Works", ...overrides });
      expect(res.status, JSON.stringify(overrides)).toBe(422);
      expect(res.body.error.fields).toEqual(fields);
    }
    expect(await ctx.db.select().from(suppliers)).toHaveLength(5);
  });

  it("PATCH: a new rate sets the moment, a new currency needs its own rate, INR forces 1, and other edits leave the rate alone", async () => {
    const first = await edit(guangzhou, { exchangeRate: 11.5 });
    expect(first.status).toBe(200);
    expect(first.body.supplier).toMatchObject({ currency: "CNY", exchangeRate: 11.5, rateUpdatedAt: expect.any(String) });
    const moment = first.body.supplier.rateUpdatedAt as string;

    const noRate = await edit(guangzhou, { currency: "USD" });
    expect(noRate.status).toBe(422);
    expect(noRate.body.error.fields).toEqual({ exchangeRate: RATE_MESSAGES.rateForCurrency("USD") });
    expect((await edit(guangzhou, { exchangeRate: 11.5 })).body.supplier.rateUpdatedAt).toBe(moment); // the same values: not a change
    expect((await edit(guangzhou, { notes: "Knits only" })).body.supplier).toMatchObject({ exchangeRate: 11.5, rateUpdatedAt: moment });

    const usd = await edit(guangzhou, { currency: "USD", exchangeRate: 88 });
    expect(usd.body.supplier).toMatchObject({ currency: "USD", exchangeRate: 88 });
    expect(Date.parse(usd.body.supplier.rateUpdatedAt)).toBeGreaterThanOrEqual(Date.parse(moment));

    expect((await edit(guangzhou, { currency: "INR", exchangeRate: 2 })).body.error.fields).toEqual({ exchangeRate: RATE_MESSAGES.rateForInr });
    expect((await edit(guangzhou, { currency: "INR" })).body.supplier).toMatchObject({ currency: "INR", exchangeRate: 1 });
    expect((await edit(guangzhou, { exchangeRate: 1 })).status).toBe(200);
  });
});

describe("new orders and deposits take the supplier's currency and snapshot its rate", () => {
  it("ORD-3: the order is in the supplier's currency (filled in when left out) at the supplier's rate now; another currency is 422; the snapshot outlives a rate change", async () => {
    await edit(guangzhou, { currency: "USD", exchangeRate: 88.25 });
    const placed = await placeOrder(orderBody(guangzhou));
    expect(placed.status).toBe(201);
    const po = placed.body.order.po as string;
    expect((await ctx.db.select({ currency: orders.currency, exchangeRate: orders.exchangeRate }).from(orders))[0]).toEqual({ currency: "USD", exchangeRate: 88.25 });
    expect((await get("/orders")).body[0]).toMatchObject({ po, currency: "USD", exchangeRate: 88.25 });
    expect((await supplierRow(guangzhou)).hasTransactions).toBe(true);

    const wrong = await placeOrder(orderBody(guangzhou, { currency: "CNY" }));
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.fields).toEqual({ currency: "This supplier's orders are in USD." });
    expect(await ctx.db.select().from(orders)).toHaveLength(1);

    // The supplier's rate moves on; the order keeps the rate it was placed at, and new payments default to the new one.
    await edit(guangzhou, { exchangeRate: 90 });
    expect((await get(`/orders/${po}`)).body).toMatchObject({ currency: "USD", exchangeRate: 88.25 });
    expect((await get("/orders/options")).body.suppliers[0]).toMatchObject({ id: guangzhou, currency: "USD", exchangeRate: 90 });
    expect((await get("/payments")).body.orders[0]).toMatchObject({ po, currency: "USD", supplierRate: 90 });
  });

  it("a supplier without a rate still gets its order (snapshot null); an INR supplier's order snapshots 1", async () => {
    const shenzhen = await idOf(ctx, suppliers, "Shenzhen Apparel");
    expect((await placeOrder(orderBody(shenzhen))).status).toBe(201);
    const foshan = await idOf(ctx, suppliers, "Foshan Fabrics");
    await edit(foshan, { currency: "INR" });
    expect((await placeOrder(orderBody(foshan))).status).toBe(201);
    const rows = await ctx.db.select({ supplierId: orders.supplierId, currency: orders.currency, exchangeRate: orders.exchangeRate }).from(orders);
    expect(rows).toEqual(expect.arrayContaining([{ supplierId: shenzhen, currency: "CNY", exchangeRate: null }, { supplierId: foshan, currency: "INR", exchangeRate: 1 }]));
  });

  it("the order's ledger postings copy the rate snapshot; a later rate change leaves them; SD-2 is retired (410)", async () => {
    await edit(guangzhou, { currency: "USD", exchangeRate: 88.25 });
    const placed = await placeOrder(orderBody(guangzhou));
    expect(placed.status).toBe(201);
    await edit(guangzhou, { exchangeRate: 90 });
    // Placed: a 0 debit (nothing received); received: its value, both at the order's rate snapshot.
    await receiveOrder(ctx, placed.body.order.id);
    const posted = await ctx.db
      .select({ entryType: supplierLedgerEntries.entryType, currency: supplierLedgerEntries.currency, amount: supplierLedgerEntries.amount, exchangeRate: supplierLedgerEntries.exchangeRate })
      .from(supplierLedgerEntries)
      .orderBy(supplierLedgerEntries.createdAt);
    expect(posted).toEqual([
      { entryType: "order_debit", currency: "USD", amount: 0, exchangeRate: 88.25 },
      { entryType: "order_adjustment", currency: "USD", amount: -25, exchangeRate: 88.25 },
    ]);
    const opened = await openDeposit(guangzhou, { direction: "give", amount: 100, openedOn: "2026-10-20" });
    expect([opened.status, opened.body.error.code]).toEqual([410, "gone"]);
  });

  it("RPT-O1 and RPT-O2 give the PO's saved rate and its INR value at that rate, beside the supplier's rate now", async () => {
    await edit(guangzhou, { currency: "USD", exchangeRate: 88.25 });
    const placed = (await placeOrder(orderBody(guangzhou))).body.order as { id: string; po: string };
    const po = placed.po;
    await receiveOrder(ctx, placed.id); // worth received x rate: all 10 received
    await edit(guangzhou, { exchangeRate: 90 });
    const report = (await get(`/orders/${po}/report`)).body;
    // 10 x 2.5 = 25 USD at 88.25 = 2,206.25 INR, whatever the supplier's rate is now.
    expect(report.order).toMatchObject({ currency: "USD", orderValueCny: 25, exchangeRate: 88.25, orderValueInr: 2206.25, supplier: { exchangeRate: 90, rateUpdatedAt: expect.any(String) } });
    const list = (await get("/reports/orders")).body;
    expect(list.rows[0]).toMatchObject({ po, currency: "USD", exchangeRate: 88.25, orderValueInr: 2206.25 });
  });
});

// Owner decisions of 2026-11-24 (migration 0019): a new order saves the USD rate in force (a USD order its own rate,
// any other the one rate the active USD suppliers agree on, none when missing or conflicting) for Dollar Cost;
// historical orders only where the records prove it for the moment they were entered.
describe("the USD rate saved on an order (0019) and Dollar Cost", () => {
  const usdRateOf = async (id: string) => (await ctx.db.select({ usdRate: orders.usdRate, exchangeRate: orders.exchangeRate }).from(orders).where(eq(orders.id, id)))[0]!;
  // No USD supplier rate on record to start from (the seed has none; cleared in case).
  const clearUsdRates = () => ctx.db.execute(sql`update suppliers set exchange_rate = null, rate_updated_at = null where currency = 'USD'`);

  it("saves the one rate the active USD suppliers agree on; none while missing or conflicting; a USD order its own rate", async () => {
    await clearUsdRates();
    expect((await edit(guangzhou, { currency: "CNY", exchangeRate: 12.5 })).status).toBe(200);
    const usdRate = async () => usdRateOf((await placeOrder(orderBody(guangzhou))).body.order.id);
    expect(await usdRate()).toEqual({ exchangeRate: 12.5, usdRate: null }); // missing: no USD supplier has a rate

    const ningbo = (await add({ name: "Ningbo Denim Works", currency: "USD", exchangeRate: 88 })).body.supplier;
    const boston = (await add({ name: "Boston Denim", currency: "USD", exchangeRate: 90 })).body.supplier;
    expect(await usdRate()).toEqual({ exchangeRate: 12.5, usdRate: null }); // conflicting: 88 and 90, never a pick
    // An inactive USD supplier's rate doesn't count.
    await ctx.db.update(suppliers).set({ status: "Inactive" }).where(eq(suppliers.id, boston.id));
    const agreed = (await placeOrder(orderBody(guangzhou))).body.order;
    expect(await usdRateOf(agreed.id)).toEqual({ exchangeRate: 12.5, usdRate: 88 });
    // Active again at the same rate: they agree. A USD supplier without a rate doesn't count either.
    expect((await edit(boston.id, { currency: "USD", exchangeRate: 88 })).status).toBe(200);
    await ctx.db.update(suppliers).set({ status: "Active" }).where(eq(suppliers.id, boston.id));
    await add({ name: "Austin Mills", currency: "USD" });
    expect(await usdRate()).toEqual({ exchangeRate: 12.5, usdRate: 88 });
    const usd = await placeOrder(orderBody(ningbo.id));
    expect(await usdRateOf(usd.body.order.id)).toEqual({ exchangeRate: 88, usdRate: 88 });
    // A later rate never touches a saved order.
    expect((await edit(boston.id, { currency: "USD", exchangeRate: 95 })).status).toBe(200);
    expect(await usdRateOf(agreed.id)).toEqual({ exchangeRate: 12.5, usdRate: 88 });

    // Dollar Cost on the Order reports: received 10 × ¥2.50 = ¥25 → ₹312.50 ÷ 88 = $3.55.
    await receiveOrder(ctx, agreed.id);
    const rows = (await get("/reports/orders")).body.rows as { po: string; usdRate: number | null; dollarCost: number | null }[];
    expect(rows.find((row) => row.po === agreed.po)).toMatchObject({ usdRate: 88, dollarCost: 3.55 });
  });

  it("migration 0019 gives historical orders only a proven USD rate, judged at the moment each was entered", async () => {
    const backfill = readFileSync("drizzle/0019_order_usd_rate.sql", "utf8")
      .split("--> statement-breakpoint")
      .filter((statement) => statement.includes("UPDATE"));
    expect(backfill).toHaveLength(2);
    const run = async () => {
      for (const statement of backfill) await ctx.db.execute(sql.raw(statement));
    };
    await clearUsdRates();
    expect((await edit(guangzhou, { currency: "CNY", exchangeRate: 12.5 })).status).toBe(200);
    const ningbo = (await add({ name: "Ningbo Denim Works", currency: "USD", exchangeRate: 88 })).body.supplier;
    const boston = (await add({ name: "Boston Denim", currency: "USD", exchangeRate: 88 })).body.supplier;
    const entered = (await placeOrder(orderBody(guangzhou))).body.order; // a CNY order entered a day ago
    const early = (await placeOrder(orderBody(guangzhou))).body.order; // entered before the USD suppliers existed
    const dollars = (await placeOrder(orderBody(ningbo.id))).body.order;
    // As before 0019: no USD rate on any order. Every supplier set up 5 days ago and untouched since.
    const settle = async () => {
      await ctx.db.execute(sql`update orders set usd_rate = null`);
      await ctx.db.execute(sql`update suppliers set created_at = now() - interval '5 days', updated_at = now() - interval '5 days',
        rate_updated_at = case when exchange_rate is null then null else now() - interval '5 days' end`);
      await ctx.db.execute(sql`update orders set created_at = now() - interval '1 day' where id in (${entered.id}, ${dollars.id})`);
      await ctx.db.execute(sql`update orders set created_at = now() - interval '6 days' where id = ${early.id}`);
    };
    const nonUsd = async () => [(await usdRateOf(entered.id)).usdRate, (await usdRateOf(early.id)).usdRate];

    await settle();
    await run();
    expect(await usdRateOf(dollars.id)).toEqual({ exchangeRate: 88, usdRate: 88 }); // a USD order: its own rate
    // Entered after both rates were set (the entry moment counts, not the order date): ₹88. Before: no USD rate then.
    expect(await nonUsd()).toEqual([88, null]);
    await run(); // a rerun changes nothing
    expect(await nonUsd()).toEqual([88, null]);

    const verdict = async (change: () => Promise<unknown>) => {
      await settle();
      await change();
      await run();
      return (await usdRateOf(entered.id)).usdRate;
    };
    // Conflicting active USD rates then: none. An inactive USD supplier (untouched since) doesn't count.
    expect(await verdict(() => ctx.db.execute(sql`update suppliers set exchange_rate = 90 where id = ${boston.id}`))).toBeNull();
    expect(await verdict(() => ctx.db.execute(sql`update suppliers set exchange_rate = 90, status = 'Inactive' where id = ${boston.id}`))).toBe(88);
    // The gap closed: a supplier that existed then and has had its currency or rate changed since (here no longer
    // USD) may have been a USD supplier at that moment: unproven, none.
    expect(await verdict(() => ctx.db.execute(sql`update suppliers set currency = 'CNY', exchange_rate = 12, rate_updated_at = now() where id = ${boston.id}`))).toBeNull();
    // Any supplier's rate changed after the order, a USD supplier edited after it (its status then unknown), or a rate
    // with no recorded moment: none.
    expect(await verdict(() => ctx.db.execute(sql`update suppliers set rate_updated_at = now() where id = ${guangzhou}`))).toBeNull();
    expect(await verdict(() => ctx.db.execute(sql`update suppliers set updated_at = now() where id = ${ningbo.id}`))).toBeNull();
    expect(await verdict(() => ctx.db.execute(sql`update suppliers set rate_updated_at = null where id = ${guangzhou}`))).toBeNull();
    // A held account's orders (D4) are not touched.
    expect(await verdict(() => ctx.db.execute(sql`insert into supplier_ledger_holds (supplier_id, currency, reason) values (${guangzhou}, 'CNY', 'test hold')`))).toBeNull();
    await ctx.db.execute(sql`delete from supplier_ledger_holds where supplier_id = ${guangzhou}`);
    // A supplier set up after the order changes nothing about that moment.
    expect(await verdict(() => ctx.db.execute(sql`update suppliers set created_at = now(), updated_at = now(), rate_updated_at = now(), exchange_rate = 70 where id = ${boston.id}`))).toBe(88);
  });
});
