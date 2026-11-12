import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { compareCurrencies, currencySymbol, ISO_4217, isCurrency, orderedCurrencies, PREFERRED_CURRENCIES } from "../../currencies";
import { items, orders, supplierDeposits, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { money } from "../notifications/notify";
import { idOf } from "../stock/fixtures";

// The currency master (docs/supplier-currency.md): every active ISO 4217 currency, served by GET /currencies and the
// only list a supplier, order or deposit currency is checked against. CNY, USD and INR keep their places and symbols.

const ctx = createTestContext();
const http = api(ctx);
let management = "";
let accounts = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  accounts = await signInAs(ctx, SEEDED.accounts);
});
afterAll(() => ctx.pool.end());

const CURRENCY = "Choose a supported currency code (ISO 4217, such as CNY, USD or AED).";
const get = (path: string, cookie = management) => http.get(path).set("Cookie", cookie);
const add = (body: object) => http.post("/suppliers", body).set("Cookie", management);

describe("the master", () => {
  it("holds the active ISO 4217 currencies with code, name, symbol and minor units, and nothing that isn't money", () => {
    expect(ISO_4217.length).toBeGreaterThanOrEqual(150);
    for (const code of ["AED", "AUD", "CNY", "EUR", "GBP", "INR", "JPY", "KWD", "SAR", "USD", "XAF", "XCD"]) expect(isCurrency(code), code).toBe(true);
    // Metals, bond units, SDR, testing and "no currency" codes; fund codes; retired currencies; crypto.
    for (const code of ["XAU", "XAG", "XDR", "XTS", "XXX", "CLF", "USN", "MXV", "HRK", "SLL", "ZWL", "VEF", "BTC", "cny", ""]) expect(isCurrency(code), code).toBe(false);
    for (const currency of ISO_4217) {
      expect(currency.code).toMatch(/^[A-Z]{3}$/);
      expect(currency.name.length).toBeGreaterThan(2);
      expect(currency.symbol.length).toBeGreaterThan(0);
      expect([0, 2, 3]).toContain(currency.minorUnits);
    }
    expect(ISO_4217.find((c) => c.code === "JPY")).toMatchObject({ name: "Japanese Yen", minorUnits: 0 });
    expect(ISO_4217.find((c) => c.code === "KWD")).toMatchObject({ minorUnits: 3 });
  });

  it("keeps ¥, $ and ₹ for CNY, USD and INR; another currency sharing one of them gets a longer form or its code", () => {
    expect([currencySymbol("CNY"), currencySymbol("USD"), currencySymbol("INR")]).toEqual(["¥", "$", "₹"]);
    expect(currencySymbol("EUR")).toBe("€");
    expect(currencySymbol("AUD")).toBe("A$");
    expect(currencySymbol("JPY")).toBe("JPY");
    expect(currencySymbol("AED")).toBe("AED");
    expect(currencySymbol("ZZZ")).toBe("ZZZ");
    expect(money(1200, "AED")).toBe("AED 1,200");
    expect(money(1200.5, "EUR")).toBe("€1,200.50");
    expect(money(141000, "CNY")).toBe("¥1,41,000");
  });

  it("orders CNY, USD, INR first and the rest by code", () => {
    expect(PREFERRED_CURRENCIES).toEqual(["CNY", "USD", "INR"]);
    expect(orderedCurrencies(["JPY", "INR", "AED", "USD", "CNY", "AED", "EUR"])).toEqual(["CNY", "USD", "INR", "AED", "EUR", "JPY"]);
    expect(["USD", "AED", "CNY"].sort(compareCurrencies)).toEqual(["CNY", "USD", "AED"]);
  });
});

describe("GET /currencies", () => {
  it("is 401 signed out and the master for any signed-in role, cacheable for the day", async () => {
    expect((await http.get("/currencies")).status).toBe(401);
    for (const email of [SEEDED.management, SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff]) {
      const res = await get("/currencies", await signInAs(ctx, email));
      expect(res.status, email).toBe(200);
      expect(res.body.currencies).toHaveLength(ISO_4217.length);
      expect(res.body.preferred).toEqual(["CNY", "USD", "INR"]);
      expect(res.headers["cache-control"]).toBe("private, max-age=86400");
    }
    const res = await get("/currencies");
    expect(res.body.currencies.find((c: { code: string }) => c.code === "AED")).toEqual({ code: "AED", name: "United Arab Emirates Dirham", symbol: "AED", minorUnits: 2 });
  });
});

describe("any currency of the master, and only those, for suppliers, orders and deposits", () => {
  it("takes an AED supplier with its rate, an order and a deposit in it with the rate snapshotted, and a JPY supplier", async () => {
    const aed = await add({ name: "Gulf Fabrics", currency: "AED", exchangeRate: 23.5 });
    expect(aed.status, aed.text).toBe(201);
    expect(aed.body.supplier).toMatchObject({ currency: "AED", exchangeRate: 23.5 });
    const jeans = await idOf(ctx, items, "Denim jeans");
    const order = await http
      .post("/orders", { supplierId: aed.body.supplier.id, orderDate: "2026-10-20", deliveryDate: "2026-11-30", lines: [{ itemId: jeans, quantity: 10, rateCny: 4 }], deposits: [] })
      .set("Cookie", management);
    expect(order.status, order.text).toBe(201);
    expect((await ctx.db.select({ currency: orders.currency, exchangeRate: orders.exchangeRate }).from(orders))[0]).toEqual({ currency: "AED", exchangeRate: 23.5 });
    expect((await get("/reports/orders")).body.rows[0]).toMatchObject({ currency: "AED", orderValueCny: 40, exchangeRate: 23.5, orderValueInr: 940 });
    const deposit = await http.post(`/suppliers/${aed.body.supplier.id}/deposits`, { direction: "give", amount: 100, openedOn: "2026-10-20" }).set("Cookie", accounts);
    expect(deposit.status, deposit.text).toBe(201);
    expect(deposit.body.deposit).toMatchObject({ currency: "AED", exchangeRate: 23.5 });
    expect((await ctx.db.select({ currency: supplierDeposits.currency }).from(supplierDeposits))[0]).toEqual({ currency: "AED" });
    const jpy = await add({ name: "Osaka Textiles", currency: "JPY", exchangeRate: 0.58 });
    expect(jpy.status, jpy.text).toBe(201);
    expect((await get("/suppliers")).body.filter((row: { currency: string }) => ["AED", "JPY"].includes(row.currency))).toHaveLength(2);
  });

  it("refuses a code outside the master on a supplier, an order and a deposit, storing nothing", async () => {
    for (const code of ["XAU", "ZZZ", "eur", "EURO"]) {
      const supplier = await add({ name: "Nope", currency: code, exchangeRate: 1 });
      expect(supplier.status, code).toBe(422);
      expect(supplier.body.error.fields).toEqual({ currency: CURRENCY });
    }
    const guangzhou = await idOf(ctx, suppliers, "Guangzhou Textile Co.");
    const jeans = await idOf(ctx, items, "Denim jeans");
    const order = await http
      .post("/orders", { supplierId: guangzhou, currency: "XAU", orderDate: "2026-10-20", deliveryDate: "2026-11-30", lines: [{ itemId: jeans, quantity: 1, rateCny: 1 }], deposits: [] })
      .set("Cookie", management);
    expect(order.status).toBe(422);
    expect(order.body.error.fields).toEqual({ currency: "Choose a supported currency code (ISO 4217, such as CNY, USD or AED)." });
    const deposit = await http.post(`/suppliers/${guangzhou}/deposits`, { direction: "give", amount: 100, currency: "XAU", openedOn: "2026-10-20" }).set("Cookie", accounts);
    expect(deposit.status).toBe(422);
    expect(deposit.body.error.fields).toEqual({ currency: CURRENCY });
    expect(await ctx.db.select().from(suppliers).where(eq(suppliers.name, "Nope"))).toHaveLength(0);
    expect(await ctx.db.select().from(orders)).toHaveLength(0);
    expect(await ctx.db.select().from(supplierDeposits)).toHaveLength(0);
  });

  it("the database keeps only three-capital codes (0013); the API, the master", async () => {
    const foshan = await idOf(ctx, suppliers, "Foshan Fabrics");
    await expect(ctx.db.update(suppliers).set({ currency: "eur" }).where(eq(suppliers.id, foshan))).rejects.toMatchObject({ cause: expect.objectContaining({ constraint: "suppliers_currency_check" }) });
    // A code of the right shape that isn't a currency passes the database (the API is the gate), so nothing writes one.
    expect((await http.patch(`/suppliers/${foshan}`, { currency: "XAU", exchangeRate: 1 }).set("Cookie", management)).status).toBe(422);
  });
});
