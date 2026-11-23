import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { payments, shippingAgents, supplierDeposits, supplierDepositTransactions, suppliers } from "../../db/schema";
import { api, createTestContext, receiveOrder, resetData, SEEDED, signInAs } from "../../test/harness";
import { UNKNOWN } from "../stages/fixtures";
import { idOf, makeOrder, postLegacy } from "../stock/fixtures";
import { MESSAGES } from "./deposits.routes";

// DEP-1 and SD-1 (docs/phase2-contracts.md section 3; docs/unified-ledger.md). Supplier deposits are a read-only archive
// since the unified ledger: SD-2..5 answer 410, so the archive rows here are written straight to the tables. Settled,
// pending and status are still summed live; give and receive are never netted; nothing here is an order payment.
// DEP-1's milestones are the Deposit Required term against the FIFO-settled amount (D11).

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let accounts = "";
let procurement = "";
let guangzhou = "";
let hangzhou = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  accounts = await signInAs(ctx, SEEDED.accounts);
  procurement = await signInAs(ctx, SEEDED.procurement);
  guangzhou = await idOf(ctx, suppliers, "Guangzhou Textile Co.");
  hangzhou = await idOf(ctx, suppliers, "Hangzhou Knits");
});

const get = (path: string, cookie = management) => http.get(path).set("Cookie", cookie);

/** An archived deposit (as SD-2 wrote it before the ledger): ¥1,000 to give at 12, opened 20 Oct, unless told. */
async function archived(supplierId: string, values: Partial<typeof supplierDeposits.$inferInsert> = {}) {
  const [row] = await ctx.db
    .insert(supplierDeposits)
    .values({ supplierId, direction: "give", amount: 1000, currency: "CNY", exchangeRate: 12, openedOn: "2026-10-20", ...values })
    .returning({ id: supplierDeposits.id });
  return row!;
}
/** An archived settlement of a deposit (as SD-3 wrote it). */
const settledBy = (depositId: string, values: Partial<typeof supplierDepositTransactions.$inferInsert> = {}) =>
  ctx.db.insert(supplierDepositTransactions).values({ depositId, paidOn: "2026-10-25", amount: 300, mode: "Bank transfer", ...values });

describe("access (payments: Management Full, Accounts Enter, Procurement View, staff None)", () => {
  it("reads need View: 401 signed out, 403 for China staff, 200 for Procurement, Accounts and Management", async () => {
    expect((await http.get("/deposits")).status).toBe(401);
    expect((await http.get(`/suppliers/${guangzhou}/deposits`)).status).toBe(401);
    const chen = await signInAs(ctx, SEEDED.chinaStaff);
    expect((await get("/deposits", chen)).status).toBe(403);
    expect((await get(`/suppliers/${guangzhou}/deposits`, chen)).body.error.code).toBe("forbidden");
    for (const cookie of [procurement, accounts, management]) {
      expect((await get("/deposits", cookie)).status).toBe(200);
      expect((await get(`/suppliers/${guangzhou}/deposits`, cookie)).status).toBe(200);
    }
  });
});

describe("SD-2 .. SD-5: retired (the archive is read-only)", () => {
  it("answers 410 gone for every role and writes nothing", async () => {
    const deposit = await archived(guangzhou);
    await settledBy(deposit.id);
    const [transaction] = await ctx.db.select({ id: supplierDepositTransactions.id }).from(supplierDepositTransactions);
    const requests = (cookie: string) => [
      () => http.post(`/suppliers/${guangzhou}/deposits`, { direction: "give", amount: 1, openedOn: "2026-10-20" }).set("Cookie", cookie),
      () => http.post(`/supplier-deposits/${deposit.id}/transactions`, { paidOn: "2026-10-25", amount: 1, mode: "Cash" }).set("Cookie", cookie),
      () => http.delete(`/supplier-deposit-transactions/${transaction!.id}`).set("Cookie", cookie),
      () => http.delete(`/supplier-deposits/${deposit.id}`).set("Cookie", cookie),
    ];
    for (const cookie of [management, accounts]) {
      for (const request of requests(cookie)) {
        const res = await request();
        expect(res.status).toBe(410);
        expect(res.body.error).toEqual({ code: "gone", message: MESSAGES.gone });
      }
    }
    expect(await ctx.db.select().from(supplierDeposits)).toHaveLength(1);
    expect(await ctx.db.select().from(supplierDepositTransactions)).toHaveLength(1);
  });
});

describe("SD-1 GET /suppliers/:supplierId/deposits", () => {
  it("shows the supplier, a summary per currency and direction that never nets give against receive, and each deposit's transactions", async () => {
    const toGive = await archived(guangzhou, { openedOn: "2026-10-01" });
    await settledBy(toGive.id, { amount: 300, paidOn: "2026-10-05" });
    const toReceive = await archived(guangzhou, { direction: "receive", amount: 500, openedOn: "2026-10-10", reference: "Mould" });
    await settledBy(toReceive.id, { amount: 60, paidOn: "2026-10-12", mode: "Cash" });
    await settledBy(toReceive.id, { amount: 40, paidOn: "2026-10-20", mode: "Cash" });
    // Guangzhou was paid in USD for a while: the deposit from then keeps its currency.
    const usd = await archived(guangzhou, { amount: 200, currency: "USD", exchangeRate: 88, openedOn: "2026-09-15" });
    await archived(hangzhou, { amount: 999 }); // another supplier's: not here

    const res = await get(`/suppliers/${guangzhou}/deposits`, procurement);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["supplier", "summary", "deposits"]);
    expect(res.body.supplier).toEqual({
      id: guangzhou,
      name: "Guangzhou Textile Co.",
      contactPerson: "Mr. Zhao Lin",
      phone: "+86 138 0013 2244",
      city: "Guangzhou",
      currency: "CNY",
      exchangeRate: null,
      status: "Active",
    });
    expect(res.body.summary).toEqual([
      { currency: "CNY", direction: "give", amount: 1000, settled: 300, pending: 700 },
      { currency: "CNY", direction: "receive", amount: 500, settled: 100, pending: 400 },
      { currency: "USD", direction: "give", amount: 200, settled: 0, pending: 200 },
    ]);
    // Newest first; transactions newest first inside.
    expect(res.body.deposits.map((row: { id: string }) => row.id)).toEqual([toReceive.id, toGive.id, usd.id]);
    expect(res.body.deposits[0]).toMatchObject({
      direction: "receive",
      amount: 500,
      amountInr: 6000,
      settled: 100,
      pending: 400,
      status: "partly settled",
      reference: "Mould",
      transactions: [
        { id: expect.any(String), paidOn: "2026-10-20", amount: 40, mode: "Cash", reference: "", notes: "" },
        { id: expect.any(String), paidOn: "2026-10-12", amount: 60, mode: "Cash", reference: "", notes: "" },
      ],
    });
    expect(res.body.deposits[1]).toMatchObject({ status: "partly settled", settled: 300, pending: 700 });
    expect(res.body.deposits[2]).toMatchObject({ currency: "USD", status: "open", transactions: [] });
  });

  it("a supplier without deposits has an empty statement; an unknown or malformed id is 404", async () => {
    const res = await get(`/suppliers/${hangzhou}/deposits`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ supplier: { name: "Hangzhou Knits" }, summary: [], deposits: [] });
    for (const id of [UNKNOWN, "abc"]) {
      const missing = await get(`/suppliers/${id}/deposits`);
      expect(missing.status, id).toBe(404);
      expect(missing.body.error.message).toBe("Supplier not found.");
    }
  });
});

describe("DEP-1 GET /deposits", () => {
  it("lists the legacy order deposits (kind Deposit only, latest first) as PaymentRows and the supplier deposits newest first", async () => {
    const order = await makeOrder(ctx, { lines: [{ item: "Denim jeans", quantity: 100, rateCny: 10 }] });
    // Order-linked supplier payments from before the ledger, written as they were; the backfill posts the paid ones.
    const legacy = (values: Partial<typeof payments.$inferInsert>) =>
      ctx.db
        .insert(payments)
        .values({ orderId: order.id, kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 1, status: "paid", ...values })
        .returning({ id: payments.id });
    const [paid] = await legacy({ amountCny: 123.45, paidOn: "2026-10-21", rateInr: 11.5, mode: "Bank transfer", reference: "UTR 9", notes: "Half" });
    await legacy({ kind: "Balance", amountCny: 500, paidOn: "2026-10-22", rateInr: 12, mode: "Bank transfer" });
    const [due] = await legacy({ amountCny: 200, status: "due", dueDate: "2026-11-30" });
    await postLegacy(ctx);
    const older = await archived(hangzhou, { openedOn: "2026-10-01" });
    const newer = await archived(guangzhou, { amount: 50, openedOn: "2026-10-15" });
    await settledBy(newer.id, { amount: 50 });

    const res = await get("/deposits", procurement);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["milestones", "orderDeposits", "supplierDeposits", "suppliers"]);
    const row = { orderId: order.id, po: order.po, supplierId: guangzhou, supplier: "Guangzhou Textile Co.", currency: "CNY", kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier" };
    const notVoided = { voided: false, voidedAt: null, voidedBy: null, voidReason: "", held: false, recordedAt: expect.any(String) };
    expect(res.body.orderDeposits).toEqual([
      { id: due!.id, ...row, amountCny: 200, status: "due", paidOn: null, dueDate: "2026-11-30", rateInr: null, amountInr: null, mode: null, reference: "", notes: "", ...notVoided },
      {
        id: paid!.id,
        ...row,
        amountCny: 123.45,
        status: "paid",
        paidOn: "2026-10-21",
        dueDate: null,
        rateInr: 11.5,
        amountInr: 1419.68, // round2(123.45 * 11.5)
        mode: "Bank transfer",
        reference: "UTR 9",
        notes: "Half",
        ...notVoided,
      },
    ]);
    expect(res.body.supplierDeposits.map((deposit: { id: string; status: string }) => [deposit.id, deposit.status])).toEqual([
      [newer.id, "settled"],
      [older.id, "open"],
    ]);
    expect(res.body.supplierDeposits[0]).toMatchObject({ supplier: "Guangzhou Textile Co.", amount: 50, settled: 50, pending: 0, transactions: 1 });
    expect(res.body.milestones).toEqual([]);
  });

  it("lists the Deposit Required milestones, newest first, from the FIFO projection; a voided order deposit stays listed, flagged", async () => {
    const jeans = (await http.get("/orders/options").set("Cookie", management)).body.items.find((item: { name: string }) => item.name === "Denim jeans").id;
    // Each order received in full (worth ¥1,000): only what FIFO settles to an order counts toward its deposit.
    const place = async (orderDate: string, depositRequiredCny?: number) => {
      const order = (
        await http
          .post("/orders", { supplierId: guangzhou, orderDate, deliveryDate: "2026-12-30", lines: [{ itemId: jeans, quantity: 100, rateCny: 10 }], depositRequiredCny })
          .set("Cookie", management)
      ).body.order as { id: string; po: string };
      await receiveOrder(ctx, order.id);
      return order;
    };
    const first = await place("2026-10-01", 400);
    await place("2026-10-02");
    const third = await place("2026-10-03", 300);
    const pay = await http.post("/payments", { supplierId: guangzhou, amount: 1250, paidOn: "2026-10-05", rateInr: 12, mode: "Bank", clientRequestId: randomUUID() }).set("Cookie", accounts);
    expect(pay.status).toBe(201);
    const res = await get("/deposits");
    // ¥1,250 settles the first (¥1,000) and ¥250 of the second; the third (¥300 asked) has nothing yet.
    expect(res.body.milestones).toEqual([
      { orderId: third.id, po: third.po, orderDate: "2026-10-03", supplierId: guangzhou, supplier: "Guangzhou Textile Co.", currency: "CNY", depositRequiredCny: 300, depositSettledCny: 0, depositPendingCny: 300, depositStatus: "unmet", held: false },
      { orderId: first.id, po: first.po, orderDate: "2026-10-01", supplierId: guangzhou, supplier: "Guangzhou Textile Co.", currency: "CNY", depositRequiredCny: 400, depositSettledCny: 1000, depositPendingCny: 0, depositStatus: "met", held: false },
    ]);
    // An agent deposit on the order, voided: still an order deposit row, flagged.
    const sino = await idOf(ctx, shippingAgents, "Sino Freight");
    const agent = await http
      .post("/payments", { orderId: first.id, payeeRole: "agent", agentId: sino, kind: "Deposit", amountCny: 50, paidOn: "2026-10-21", rateInr: 12, mode: "Cash", clientRequestId: randomUUID() })
      .set("Cookie", accounts);
    expect((await http.delete(`/payments/${agent.body.payment.id}`, { reason: "Wrong order" }).set("Cookie", management)).status).toBe(200);
    expect((await get("/deposits")).body.orderDeposits).toEqual([expect.objectContaining({ id: agent.body.payment.id, voided: true, voidReason: "Wrong order", voidedBy: "Suresh Menon" })]);
  });

  it("offers the active suppliers plus any inactive one that still has deposits, by name", async () => {
    await archived(hangzhou);
    await ctx.db.update(suppliers).set({ status: "Inactive" }).where(eq(suppliers.id, hangzhou));
    await ctx.db.update(suppliers).set({ status: "Inactive" }).where(eq(suppliers.name, "Yiwu Trims Ltd."));
    const res = await get("/deposits");
    expect(res.body.suppliers).toEqual([
      { id: expect.any(String), name: "Foshan Fabrics" },
      { id: guangzhou, name: "Guangzhou Textile Co." },
      { id: hangzhou, name: "Hangzhou Knits" },
      { id: expect.any(String), name: "Shenzhen Apparel" },
    ]);
  });

  it("names who was paid: an agent-paid order deposit keeps the order's supplier and carries the agent as payee; that supplier is offered even when inactive", async () => {
    const order = await makeOrder(ctx, { supplier: "Hangzhou Knits", lines: [{ item: "Denim jeans", quantity: 100, rateCny: 10 }] });
    const sino = await idOf(ctx, shippingAgents, "Sino Freight");
    const paid = await http
      .post("/payments", { orderId: order.id, kind: "Deposit", payeeRole: "agent", agentId: sino, amountCny: 50, paidOn: "2026-10-21", rateInr: 12, mode: "Cash", clientRequestId: randomUUID() })
      .set("Cookie", accounts);
    expect(paid.status).toBe(201);
    await ctx.db.update(suppliers).set({ status: "Inactive" }).where(eq(suppliers.id, hangzhou));

    const res = await get("/deposits");
    expect(res.body.orderDeposits).toEqual([
      expect.objectContaining({ id: paid.body.payment.id, supplierId: hangzhou, supplier: "Hangzhou Knits", payee: "Sino Freight", payeeRole: "agent", amountInr: 600 }),
    ]);
    expect(res.body.suppliers).toContainEqual({ id: hangzhou, name: "Hangzhou Knits" });
  });

  it("leaves the order figures alone: PAY-1 ignores the supplier deposits archive and its settlements", async () => {
    const order = await makeOrder(ctx, { lines: [{ item: "Denim jeans", quantity: 100, rateCny: 10 }] });
    await receiveOrder(ctx, order.id); // worth ¥1,000 (received x rate)
    const pay = await http.post("/payments", { supplierId: guangzhou, amount: 300, paidOn: "2026-10-21", rateInr: 12, mode: "Cash", clientRequestId: randomUUID() }).set("Cookie", accounts);
    expect(pay.status).toBe(201);
    const before = (await get("/payments")).body;
    const deposit = await archived(guangzhou, { amount: 5000 });
    await settledBy(deposit.id, { amount: 4000 });
    const after = (await get("/payments")).body;
    expect(after).toEqual(before);
    expect(after.orders).toEqual([expect.objectContaining({ orderId: order.id, settledCny: 300, settledInr: 3600, outstandingCny: 700 })]);
    expect(after.payments).toHaveLength(1);
    expect((await get("/orders")).body[0]).toMatchObject({ id: order.id, settledCny: 300, paidInr: 3600 });
  });
});
