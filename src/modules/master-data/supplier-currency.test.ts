import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, orders, supplierDeposits, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf } from "../stock/fixtures";
import { RATE_MESSAGES } from "./suppliers.routes";

// docs/supplier-currency.md: one currency and one INR rate per supplier. New orders and supplier deposits are in that
// currency (another is 422) and snapshot the rate; a later change of the supplier's rate never touches them.

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

  it("SD-2: a deposit snapshots the supplier's rate; a later rate change leaves it", async () => {
    await edit(guangzhou, { currency: "USD", exchangeRate: 88.25 });
    const opened = await openDeposit(guangzhou, { direction: "give", amount: 100, openedOn: "2026-10-20" });
    expect(opened.status).toBe(201);
    expect(opened.body.deposit).toMatchObject({ currency: "USD", exchangeRate: 88.25 });
    await edit(guangzhou, { exchangeRate: 90 });
    expect((await get(`/suppliers/${guangzhou}/deposits`)).body.deposits[0]).toMatchObject({ currency: "USD", exchangeRate: 88.25 });
    expect((await ctx.db.select({ exchangeRate: supplierDeposits.exchangeRate }).from(supplierDeposits))[0]).toEqual({ exchangeRate: 88.25 });
  });

  it("RPT-O1 and RPT-O2 give the PO's saved rate and its INR value at that rate, beside the supplier's rate now", async () => {
    await edit(guangzhou, { currency: "USD", exchangeRate: 88.25 });
    const po = (await placeOrder(orderBody(guangzhou))).body.order.po as string;
    await edit(guangzhou, { exchangeRate: 90 });
    const report = (await get(`/orders/${po}/report`)).body;
    // 10 x 2.5 = 25 USD at 88.25 = 2,206.25 INR, whatever the supplier's rate is now.
    expect(report.order).toMatchObject({ currency: "USD", orderValueCny: 25, exchangeRate: 88.25, orderValueInr: 2206.25, supplier: { exchangeRate: 90, rateUpdatedAt: expect.any(String) } });
    const list = (await get("/reports/orders")).body;
    expect(list.rows[0]).toMatchObject({ po, currency: "USD", exchangeRate: 88.25, orderValueInr: 2206.25 });
  });
});
