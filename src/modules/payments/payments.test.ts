import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, notifications, payments, shippingAgents, supplierLedgerEntries, suppliers, users } from "../../db/schema";
import { api, createTestContext, receiveOrder, resetData, SEEDED, signInAs } from "../../test/harness";
import { MESSAGES } from "./payments.routes";

// PAY-2 POST /payments (docs/unified-ledger.md): a supplier payment is recorded against the supplier and posted to its
// ledger account; a shipping-agent payment stays on its order (sea freight) and is never posted.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

const dayInIndia = (offsetDays: number) => new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

let management = "";
let accounts = "";
let orderId = "";
let ids: { supplier: string; sino: string; dragon: string; accountsUser: string };
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  accounts = await signInAs(ctx, SEEDED.accounts);
  const agentId = async (name: string) => (await ctx.db.select({ id: shippingAgents.id }).from(shippingAgents).where(eq(shippingAgents.name, name)))[0]!.id;
  ids = {
    supplier: (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, "Guangzhou Textile Co.")))[0]!.id,
    sino: await agentId("Sino Freight"),
    dragon: await agentId("Dragon Cargo"),
    accountsUser: (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.accounts)))[0]!.id,
  };
  // An order worth ¥10,000, made through ORD-3: the supplier's account owes ¥10,000.
  const itemId = (await ctx.db.select({ id: items.id }).from(items).where(eq(items.name, "Denim jeans")))[0]!.id;
  const order = await http
    .post("/orders", { supplierId: ids.supplier, orderDate: "2026-10-20", deliveryDate: "2026-11-30", lines: [{ itemId, quantity: 1000, rateCny: 10 }] })
    .set("Cookie", management);
  expect(order.status).toBe(201);
  orderId = order.body.order.id;
  // Received in full: worth ¥10,000 (received quantity x rate).
  await receiveOrder(ctx, orderId);
});

const body = (overrides: object = {}) => ({
  supplierId: ids.supplier,
  amount: 2345.67,
  paidOn: "2026-10-25",
  rateInr: 11.8765,
  mode: "  Bank transfer  ",
  clientRequestId: randomUUID(),
  ...overrides,
});
const agentBody = (overrides: object = {}) => ({
  orderId,
  payeeRole: "agent",
  agentId: ids.sino,
  kind: "Balance",
  amountCny: 500,
  paidOn: "2026-10-25",
  rateInr: 12,
  mode: "Cash",
  clientRequestId: randomUUID(),
  ...overrides,
});
const record = (payload: object, cookie = accounts) => http.post("/payments", payload).set("Cookie", cookie);
const get = (path: string) => http.get(path).set("Cookie", management);
const stored = () => ctx.db.select().from(payments);

describe("PAY-2 access", () => {
  it("is 401 signed out", async () => {
    expect((await http.post("/payments", body())).status).toBe(401);
  });

  it("is 403 for Procurement (View) and China staff", async () => {
    for (const email of [SEEDED.procurement, SEEDED.chinaStaff]) {
      const res = await record(body(), await signInAs(ctx, email));
      expect(res.status, email).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    expect(await stored()).toHaveLength(0);
  });

  it("is 201 for Management and Accounts", async () => {
    expect((await record(body(), management)).status).toBe(201);
    expect((await record(body(), accounts)).status).toBe(201);
    expect(await stored()).toHaveLength(2);
  });
});

describe("PAY-2 POST /payments", () => {
  it("saves a paid supplier payment against the supplier, posts it, and PAY-1 and ORD-1 show what it settles", async () => {
    const res = await record(body());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      payment: expect.objectContaining({ id: expect.any(String), orderId: null, supplierId: ids.supplier, currency: "CNY", kind: "Payment", amountCny: 2345.67, amountInr: 27858.35 }),
      ledger: { supplierId: ids.supplier, currency: "CNY", balanceBefore: -10000, balanceAfter: -7654.33 },
    });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: res.body.payment.id,
      orderId: null,
      supplierId: ids.supplier,
      currency: "CNY",
      kind: "Payment",
      payee: "Guangzhou Textile Co.",
      payeeRole: "supplier",
      amountCny: 2345.67,
      status: "paid",
      paidOn: "2026-10-25",
      dueDate: null,
      rateInr: 11.8765,
      mode: "Bank transfer",
      createdBy: ids.accountsUser,
    });
    expect(await ctx.db.select().from(supplierLedgerEntries).where(eq(supplierLedgerEntries.paymentId, res.body.payment.id))).toMatchObject([
      { entryType: "payment", amount: 2345.67, exchangeRate: 11.8765, currency: "CNY", supplierId: ids.supplier, createdBy: ids.accountsUser },
    ]);

    // round2(2345.67 * 11.8765) = 27858.35.
    const pay1 = await get("/payments");
    expect(pay1.body.orders).toEqual([expect.objectContaining({ orderId, settledCny: 2345.67, settledInr: 27858.35, paidInr: 27858.35, outstandingCny: 7654.33, paymentStatus: "partly" })]);
    expect(pay1.body.payments).toContainEqual(expect.objectContaining({ id: res.body.payment.id, kind: "Payment", status: "paid", payee: "Guangzhou Textile Co.", amountCny: 2345.67 }));
    const ord1 = await get("/orders");
    expect(ord1.body[0]).toMatchObject({ id: orderId, settledCny: 2345.67, paidInr: 27858.35 });
  });

  it("names the agent when a shipping agent was paid on the order, accepts today, and posts nothing", async () => {
    const res = await record(agentBody({ kind: "Deposit", paidOn: dayInIndia(0) }));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ payment: expect.objectContaining({ orderId, payee: "Sino Freight", payeeRole: "agent", kind: "Deposit", amountInr: 6000 }) });
    const row = (await ctx.db.select().from(payments).where(eq(payments.id, res.body.payment.id)))[0];
    expect(row).toMatchObject({ kind: "Deposit", payee: "Sino Freight", payeeRole: "agent", status: "paid", paidOn: dayInIndia(0), supplierId: null, currency: null });
    expect(await ctx.db.select().from(supplierLedgerEntries).where(eq(supplierLedgerEntries.paymentId, row!.id))).toHaveLength(0);
    expect((await get("/payments")).body.orders[0]).toMatchObject({ settledCny: 0, agentPaidCny: 500, agentPaidInr: 6000, paidInr: 6000 });
  });

  it("takes a payment beyond what is owed (no overpayment check): the order is paid and the account holds the rest", async () => {
    const res = await record(body({ amount: 10500 }));
    expect(res.body.ledger).toMatchObject({ balanceBefore: -10000, balanceAfter: 500 });
    const pay1 = await get("/payments");
    expect(pay1.body.orders[0]).toMatchObject({ settledCny: 10000, outstandingCny: 0, paymentStatus: "paid" });
    expect((await get(`/orders/${encodeURIComponent(pay1.body.orders[0].po)}`)).body).toMatchObject({ outstandingCny: 0, supplierAccount: { balanceCny: 500 } });
  });

  it("refuses broken rules with 422 under the field and stores nothing", async () => {
    await ctx.db.update(shippingAgents).set({ status: "Inactive" }).where(eq(shippingAgents.id, ids.dragon));
    const supplierCases: [object, string, string][] = [
      [{ supplierId: "not-a-uuid" }, "supplierId", MESSAGES.supplier],
      [{ supplierId: "00000000-0000-4000-8000-000000000000" }, "supplierId", MESSAGES.supplier],
      [{ amount: 0 }, "amount", MESSAGES.amount],
      [{ amount: "100" }, "amount", MESSAGES.amount],
      [{ amount: 1e12 }, "amount", MESSAGES.amount],
      [{ amount: 1.005 }, "amount", MESSAGES.amount],
      [{ paidOn: dayInIndia(1) }, "paidOn", MESSAGES.paidOnFuture],
      [{ paidOn: "25/10/2026" }, "paidOn", MESSAGES.paidOn],
      [{ rateInr: 0 }, "rateInr", MESSAGES.rateInr],
      [{ rateInr: undefined }, "rateInr", MESSAGES.rateInr],
      [{ currency: "XAU" }, "currency", MESSAGES.currency],
      [{ currency: "USD" }, "currency", MESSAGES.currency],
      [{ mode: "   " }, "mode", MESSAGES.mode],
      [{ mode: "x".repeat(101) }, "mode", MESSAGES.modeTooLong],
      [{ clientRequestId: "x" }, "clientRequestId", MESSAGES.clientRequestId],
      [{ clientRequestId: undefined }, "clientRequestId", MESSAGES.clientRequestId],
    ];
    const agentCases: [object, string, string][] = [
      [{ orderId: "not-a-uuid" }, "orderId", MESSAGES.order],
      [{ orderId: "00000000-0000-4000-8000-000000000000" }, "orderId", MESSAGES.order],
      [{ kind: "Payment" }, "kind", MESSAGES.kind],
      [{ payeeRole: "bank" }, "payeeRole", MESSAGES.payeeRole],
      [{ agentId: null }, "agentId", MESSAGES.agent],
      [{ agentId: "00000000-0000-4000-8000-000000000000" }, "agentId", MESSAGES.agent],
      [{ agentId: ids.dragon }, "agentId", MESSAGES.agent],
      [{ payeeRole: "supplier" }, "payeeRole", MESSAGES.supplierOnOrder],
      [{ amountCny: 0 }, "amountCny", MESSAGES.amount],
      [{ rateInr: undefined }, "rateInr", MESSAGES.rateInr],
    ];
    for (const [cases, make] of [
      [supplierCases, body],
      [agentCases, agentBody],
    ] as const) {
      for (const [overrides, field, message] of cases) {
        const res = await record(make(overrides));
        expect(res.status, JSON.stringify(overrides)).toBe(422);
        expect(res.body.error.code).toBe("validation_failed");
        expect(res.body.error.fields, JSON.stringify(overrides)).toEqual({ [field]: message });
      }
    }
    // Problems that need the database are reported together.
    const both = await record(agentBody({ orderId: "00000000-0000-4000-8000-000000000000", agentId: ids.dragon }));
    expect(both.body.error.fields).toEqual({ orderId: MESSAGES.order, agentId: MESSAGES.agent });
    expect(await stored()).toHaveLength(0);
  });

  it("is 400 for an unknown key", async () => {
    expect((await record(body({ status: "due" }))).status).toBe(400);
    expect((await record(body({ orderId }))).status).toBe(400);
    expect((await record(agentBody({ payee: "Someone" }))).status).toBe(400);
    expect(await stored()).toHaveLength(0);
  });
});

describe("PAY-2 in the payment's currency (D10)", () => {
  const supplierIn = (currency: "USD" | "INR", exchangeRate: number) => ctx.db.update(suppliers).set({ currency, exchangeRate }).where(eq(suppliers.id, ids.supplier));

  it("an INR payment takes no rate: it is stored at 1, so its INR is the amount", async () => {
    await supplierIn("INR", 1);
    for (const rateInr of [undefined, 1]) expect((await record(body({ rateInr, amount: 5000, currency: "INR" }))).status).toBe(201);
    expect((await stored()).map((row) => row.rateInr)).toEqual([1, 1]);
    expect((await get("/payments")).body.payments.map((row: { currency: string; amountInr: number }) => [row.currency, row.amountInr])).toEqual([
      ["INR", 5000],
      ["INR", 5000],
    ]);
  });

  it("refuses a rate on an INR payment and a missing rate on a USD or CNY one", async () => {
    await supplierIn("INR", 1);
    expect((await record(body({ currency: "INR", rateInr: 12 }))).body.error.fields).toEqual({ rateInr: "Leave the rate empty for an INR order." });
    await supplierIn("USD", 88);
    expect((await record(body({ currency: "USD", rateInr: undefined }))).body.error.fields).toEqual({ rateInr: MESSAGES.rateInr });
    // The CNY account still owes ¥10,000: CNY stays on offer after the move to USD.
    expect((await record(body({ currency: "CNY", rateInr: undefined }))).body.error.fields).toEqual({ rateInr: MESSAGES.rateInr });
    expect(await stored()).toHaveLength(0);
  });

  it("the notification shows the payment's currency and links to the supplier's ledger; an agent's to the order", async () => {
    await supplierIn("USD", 88);
    expect((await record(body({ amount: 500, rateInr: 88 }))).status).toBe(201);
    const sent = await ctx.db.select({ details: notifications.details, href: notifications.href }).from(notifications).where(eq(notifications.kind, "payment-recorded"));
    expect(sent.length).toBeGreaterThan(0);
    for (const row of sent) expect(row).toEqual({ details: ["Payment $500", "Guangzhou Textile Co."], href: `/supplier-ledger/${ids.supplier}` });
    await ctx.db.delete(notifications);
    expect((await record(agentBody())).status).toBe(201);
    const agent = await ctx.db.select({ details: notifications.details, href: notifications.href }).from(notifications);
    expect(agent).toContainEqual({ details: ["Balance ¥500", "Sino Freight"], href: expect.stringMatching(/^\/orders\/PO-\d+\/payments$/) });
  });
});
