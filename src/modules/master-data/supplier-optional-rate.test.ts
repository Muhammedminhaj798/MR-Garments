import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, payments, supplierDeposits, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { MESSAGES as DEPOSIT } from "../deposits/deposits.routes";
import { indiaDay } from "../stock/fixtures";

// The exchange rate is optional on a supplier (MD-2): left out, it is stored as null ("not set yet"), never 0 or 1. It
// can be set later (MD-3). Every transaction that needs a rate asks for it where it is made: payments (PAY-2), order
// deposits (ORD-3), advances (ADV-2) and supplier deposits (SD-2). Saved suppliers, orders and payments keep their rates.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let accounts = "";
let jeans = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  accounts = await signInAs(ctx, SEEDED.accounts);
  jeans = (await ctx.db.select({ id: items.id }).from(items).where(eq(items.name, "Denim jeans")))[0]!.id;
});

const create = (body: object) => http.post("/suppliers").set("Cookie", management).send({ name: `Rate Test ${Math.random().toString(36).slice(2, 8)}`, ...body });
const rateOf = async (id: string) => (await ctx.db.select({ rate: suppliers.exchangeRate }).from(suppliers).where(eq(suppliers.id, id)))[0]!.rate;

describe("the exchange rate is optional on a supplier", () => {
  it("left out: stored as null (not set), never 0 or 1; given: saved as typed; INR: 1", async () => {
    const without = await create({ currency: "USD" });
    expect(without.status, JSON.stringify(without.body)).toBe(201);
    expect(without.body.supplier).toMatchObject({ currency: "USD", exchangeRate: null });
    expect(await rateOf(without.body.supplier.id)).toBeNull();

    const withRate = await create({ currency: "USD", exchangeRate: 84.25 });
    expect(withRate.status).toBe(201);
    expect(await rateOf(withRate.body.supplier.id)).toBe(84.25);

    const inr = await create({ currency: "INR" });
    expect(await rateOf(inr.body.supplier.id)).toBe(1);
    // A rate that is given is still checked as before.
    expect((await create({ currency: "USD", exchangeRate: 0 })).status).toBe(422);
    expect((await create({ currency: "USD", exchangeRate: 1.23456 })).status).toBe(422);
  });

  it("can be set later on Edit supplier (MD-3), and other edits keep it not set", async () => {
    const { supplier } = (await create({ currency: "CNY" })).body;
    expect((await http.patch(`/suppliers/${supplier.id}`).set("Cookie", management).send({ city: "Ningbo" })).status).toBe(200);
    expect(await rateOf(supplier.id)).toBeNull();
    expect((await http.patch(`/suppliers/${supplier.id}`).set("Cookie", management).send({ exchangeRate: 12.4 })).status).toBe(200);
    expect(await rateOf(supplier.id)).toBe(12.4);
  });
});

describe("a supplier without a rate: each transaction asks for the rate where it is made", () => {
  async function rateless() {
    const { supplier } = (await create({ currency: "USD" })).body as { supplier: { id: string; name: string } };
    return supplier;
  }

  it("New order: placed without a rate (the order keeps none); a deposit paid with it needs its rate typed", async () => {
    const supplier = await rateless();
    const order = { supplierId: supplier.id, orderDate: indiaDay(-1), deliveryDate: indiaDay(30), lines: [{ itemId: jeans, quantity: 10, rateCny: 5 }] };
    const deposit = { payee: supplier.name, payeeRole: "supplier", amountCny: 20, paidOn: indiaDay(-1), mode: "Wire" };
    const refused = await http.post("/orders").set("Cookie", management).send({ ...order, deposits: [deposit] });
    expect(refused.status).toBe(422);
    expect(refused.body.error.fields.deposits).toBeTruthy();
    const placed = await http.post("/orders").set("Cookie", management).send({ ...order, deposits: [{ ...deposit, rateInr: 83.5 }] });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const detail = (await http.get(`/orders/${placed.body.order.po}`).set("Cookie", management)).body;
    expect(detail.exchangeRate).toBeNull();
    expect((await ctx.db.select({ rate: payments.rateInr }).from(payments).where(eq(payments.orderId, placed.body.order.id)))[0]!.rate).toBe(83.5);
  });

  it("a payment (PAY-2) and an advance (ADV-2) need their rate typed: 422 under the rate, nothing saved", async () => {
    const supplier = await rateless();
    const placed = await http
      .post("/orders")
      .set("Cookie", management)
      .send({ supplierId: supplier.id, orderDate: indiaDay(-1), deliveryDate: indiaDay(30), lines: [{ itemId: jeans, quantity: 10, rateCny: 5 }] });
    const payment = await http.post("/payments").set("Cookie", accounts).send({ orderId: placed.body.order.id, kind: "Balance", payeeRole: "supplier", amountCny: 10, paidOn: indiaDay(), mode: "Cash" });
    expect(payment.status).toBe(422);
    expect(payment.body.error.fields.rateInr).toBeTruthy();
    const advance = await http.post(`/suppliers/${supplier.id}/advances`).set("Cookie", accounts).send({ amount: 100, paidOn: indiaDay(), mode: "Wire" });
    expect(advance.status).toBe(422);
    expect(advance.body.error.fields.rateInr).toBeTruthy();
  });

  it("a supplier deposit (SD-2) needs a rate: the supplier's saved one, else the one typed; never a guessed one", async () => {
    const supplier = await rateless();
    const body = { direction: "give", amount: 500, openedOn: indiaDay() };
    const refused = await http.post(`/suppliers/${supplier.id}/deposits`).set("Cookie", accounts).send(body);
    expect(refused.status).toBe(422);
    expect(refused.body.error.fields.rateInr).toBe(DEPOSIT.rateMissing("USD"));
    expect(await ctx.db.select().from(supplierDeposits)).toHaveLength(0);
    // SD-1 says the supplier has no rate, so the form can ask for one.
    expect((await http.get(`/suppliers/${supplier.id}/deposits`).set("Cookie", accounts)).body.supplier.exchangeRate).toBeNull();

    const typed = await http.post(`/suppliers/${supplier.id}/deposits`).set("Cookie", accounts).send({ ...body, rateInr: 84.1 });
    expect(typed.status, JSON.stringify(typed.body)).toBe(201);
    expect(typed.body.deposit).toMatchObject({ currency: "USD", exchangeRate: 84.1 });

    // With a saved rate, the deposit takes it as before.
    expect((await http.patch(`/suppliers/${supplier.id}`).set("Cookie", management).send({ exchangeRate: 85 })).status).toBe(200);
    const saved = await http.post(`/suppliers/${supplier.id}/deposits`).set("Cookie", accounts).send(body);
    expect(saved.body.deposit).toMatchObject({ exchangeRate: 85 });
    expect((await http.post(`/suppliers/${supplier.id}/deposits`).set("Cookie", accounts).send({ ...body, rateInr: 0 })).status).toBe(422);
  });
});

describe("final checks before release", () => {
  it("1. a deposit for a supplier without a saved rate keeps the rate typed in the dialog, and its INR equivalent is at that rate", async () => {
    const { supplier } = (await create({ currency: "USD" })).body as { supplier: { id: string } };
    const res = await http.post(`/suppliers/${supplier.id}/deposits`).set("Cookie", accounts).send({ direction: "give", amount: 1234.5, openedOn: indiaDay(), rateInr: 84.1234 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // 1,234.50 x 84.1234 = 103,850.3373 -> 103,850.34 (2 decimals, as every INR figure).
    expect(res.body.deposit).toMatchObject({ amount: 1234.5, currency: "USD", exchangeRate: 84.1234, amountInr: 103850.34 });
    const [row] = await ctx.db.select({ amount: supplierDeposits.amount, rate: supplierDeposits.exchangeRate }).from(supplierDeposits).where(eq(supplierDeposits.supplierId, supplier.id));
    expect(row).toEqual({ amount: 1234.5, rate: 84.1234 });
    // The INR equivalent at that rate, as every INR figure is rounded (2 decimals): 1234.50 x 84.1234 = 103,850.34.
    expect(Math.round(row!.amount * row!.rate! * 100) / 100).toBe(103850.34);
    // Adding a rate to the supplier later leaves the deposit's own rate as it was.
    expect((await http.patch(`/suppliers/${supplier.id}`).set("Cookie", management).send({ exchangeRate: 90 })).status).toBe(200);
    expect((await http.get(`/suppliers/${supplier.id}/deposits`).set("Cookie", accounts)).body.deposits[0]).toMatchObject({ exchangeRate: 84.1234, amountInr: 103850.34 });
    // DEP-1 (the Deposits tabs and their download) gives the same INR.
    const listed = (await http.get("/deposits").set("Cookie", accounts)).body.supplierDeposits.find((d: { supplierId: string }) => d.supplierId === supplier.id);
    expect(listed).toMatchObject({ exchangeRate: 84.1234, amountInr: 103850.34 });
  });

  it("2. adding a rate later never changes an order placed without one: its rate and PO value in INR stay not set; its payments keep theirs", async () => {
    const { supplier } = (await create({ currency: "USD" })).body as { supplier: { id: string } };
    const placed = await http
      .post("/orders")
      .set("Cookie", management)
      .send({ supplierId: supplier.id, orderDate: indiaDay(-2), deliveryDate: indiaDay(30), lines: [{ itemId: jeans, quantity: 100, rateCny: 5 }] });
    expect(placed.status).toBe(201);
    const po = placed.body.order.po as string;
    expect((await http.post("/payments").set("Cookie", accounts).send({ orderId: placed.body.order.id, kind: "Balance", payeeRole: "supplier", amountCny: 200, paidOn: indiaDay(), rateInr: 83, mode: "Wire" })).status).toBe(201);
    const before = { list: (await http.get("/orders").set("Cookie", management)).body.find((o: { po: string }) => o.po === po), detail: (await http.get(`/orders/${po}`).set("Cookie", management)).body, report: (await http.get(`/orders/${po}/report`).set("Cookie", management)).body };
    expect(before.list).toMatchObject({ exchangeRate: null });
    expect(before.report.order).toMatchObject({ exchangeRate: null, orderValueInr: null });

    expect((await http.patch(`/suppliers/${supplier.id}`).set("Cookie", management).send({ exchangeRate: 85 })).status).toBe(200);
    const list = (await http.get("/orders").set("Cookie", management)).body.find((o: { po: string }) => o.po === po);
    const detail = (await http.get(`/orders/${po}`).set("Cookie", management)).body;
    const report = (await http.get(`/orders/${po}/report`).set("Cookie", management)).body;
    expect(list).toEqual(before.list);
    expect(detail).toEqual(before.detail);
    expect(report.order).toMatchObject({ exchangeRate: null, orderValueInr: null });
    expect(report.payments).toEqual(before.report.payments);
    expect(detail.payments[0]).toMatchObject({ rateInr: 83, amountInr: 16600 });
    expect((await ctx.db.select({ rate: payments.rateInr }).from(payments).where(eq(payments.orderId, placed.body.order.id)))[0]!.rate).toBe(83);
  });
});
