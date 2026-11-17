import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, orders, shippingAgents, supplierAdvanceEntries, suppliers, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { loadLandedCosts } from "../costs/landed-cost";
import { indiaDay } from "../stock/fixtures";
import { settleAdvance } from "./advances";
import { MESSAGES } from "./advances.routes";

// Supplier advance account (docs/supplier-advance.md): ADV-1..4, automatic allocation on ORD-3, re-settling on ORD-5,
// reversal on ORD-6 (delete = cancel), the excess given back on PAY-2, and the money rules that read it (balance,
// deposit paid, landed cost, reports).

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let accounts = "";
let procurement = "";
let guangzhou = "";
let hangzhou = "";
let jeans = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  accounts = await signInAs(ctx, SEEDED.accounts);
  procurement = await signInAs(ctx, SEEDED.procurement);
  const id = async (table: typeof suppliers | typeof items, name: string) => (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;
  guangzhou = await id(suppliers, "Guangzhou Textile Co.");
  hangzhou = await id(suppliers, "Hangzhou Knits");
  jeans = await id(items, "Denim jeans");
});

const get = (path: string, cookie = management) => http.get(path).set("Cookie", cookie);
const advance = (overrides: object = {}) => ({ amount: 10_000, paidOn: indiaDay(-10), rateInr: 12.5, mode: "Bank transfer", ...overrides });
const addAdvance = (supplierId: string, body: object = advance(), cookie = accounts) => http.post(`/suppliers/${supplierId}/advances`, body).set("Cookie", cookie);
async function added(supplierId: string, body: object = advance()) {
  const res = await addAdvance(supplierId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.advance as { id: string };
}
/** An order of `value` (one line of jeans at rate 1) through ORD-3; returns the response body. */
async function order(value: number, overrides: object = {}, supplierId = guangzhou, cookie = management) {
  const res = await http
    .post("/orders")
    .set("Cookie", cookie)
    .send({ supplierId, orderDate: indiaDay(-1), deliveryDate: indiaDay(30), lines: [{ itemId: jeans, quantity: value, rateCny: 1 }], ...overrides });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { order: { id: string; po: string }; advance: { appliedCny: number; availableCny: number; balanceCny: number; status: string; changeCny: number } };
}
const account = async (supplierId: string) => (await get(`/suppliers/${supplierId}/advances`)).body;
const available = async (supplierId: string, currency = "CNY") =>
  ((await account(supplierId)).summary as { currency: string; availableCny: number }[]).find((row) => row.currency === currency)?.availableCny ?? 0;
const ledger = () => ctx.db.select().from(supplierAdvanceEntries);
/** PAY-2: a paid supplier Balance payment of `amountCny` (overrides for an agent payment). */
const pay = (orderId: string, amountCny: number, overrides: object = {}) =>
  http.post("/payments").set("Cookie", accounts).send({ orderId, kind: "Balance", payeeRole: "supplier", amountCny, paidOn: indiaDay(), rateInr: 12, mode: "Cash", ...overrides });
/** ADV-4: apply the supplier's available advance to an existing order. */
const apply = (po: string, cookie = accounts) => http.post(`/orders/${encodeURIComponent(po)}/advance`).set("Cookie", cookie);
/** What the order's allocations still apply (allocations less their reversals), straight from the ledger. */
const appliedOf = async (orderId: string) =>
  (await ledger()).filter((row) => row.orderId === orderId).reduce((sum, row) => sum + (row.kind === "allocation" ? 1 : -1) * Number(row.amount), 0);

describe("access (payments: Management Full, Accounts Enter, Procurement View, staff None)", () => {
  it("ADV-1 needs View, ADV-2 Enter, ADV-3 Full", async () => {
    expect((await http.get(`/suppliers/${guangzhou}/advances`)).status).toBe(401);
    const chen = await signInAs(ctx, SEEDED.chinaStaff);
    expect((await get(`/suppliers/${guangzhou}/advances`, chen)).status).toBe(403);
    expect((await get(`/suppliers/${guangzhou}/advances`, procurement)).status).toBe(200);
    expect((await addAdvance(guangzhou, advance(), procurement)).status).toBe(403);
    const { id } = await added(guangzhou);
    expect((await http.delete(`/supplier-advances/${id}`).set("Cookie", accounts)).status).toBe(403);
    expect((await http.delete(`/supplier-advances/${id}`).set("Cookie", management)).status).toBe(204);
  });

  it("an order created by Procurement (payments View only) still draws the advance: allocation is the system's", async () => {
    await added(guangzhou);
    expect((await order(2000, {}, guangzhou, procurement)).advance.appliedCny).toBe(2000);
  });
});

describe("advance account (ADV-1, ADV-2)", () => {
  it("1-2. records an advance without any order and reads the available balance (ADV-1, ORD-2, DEP-1)", async () => {
    const res = await addAdvance(guangzhou, advance({ reference: "UTR-1", notes: "Season advance" }));
    expect(res.status).toBe(201);
    expect(res.body.advance).toEqual({ id: expect.any(String), amount: 10000, currency: "CNY", exchangeRate: 12.5, entryDate: indiaDay(-10) });
    const body = await account(guangzhou);
    expect(body.supplier).toMatchObject({ id: guangzhou, name: "Guangzhou Textile Co.", currency: "CNY" });
    expect(body.summary).toEqual([{ currency: "CNY", receivedCny: 10000, allocatedCny: 0, reversedCny: 0, availableCny: 10000, orders: 0 }]);
    expect(body.entries).toEqual([
      expect.objectContaining({ kind: "receipt", amount: 10000, amountInr: 125000, exchangeRate: 12.5, reference: "UTR-1", notes: "Season advance", orderId: null, po: "", balance: 10000, recordedBy: "Anita Joseph" }),
    ]);
    const options = (await get("/orders/options")).body.suppliers as { id: string; advanceAvailable: number }[];
    expect(options.find((s) => s.id === guangzhou)!.advanceAvailable).toBe(10000);
    expect(options.find((s) => s.id === hangzhou)!.advanceAvailable).toBe(0);
    expect((await get("/deposits")).body.advances).toEqual([expect.objectContaining({ supplierId: guangzhou, supplier: "Guangzhou Textile Co.", currency: "CNY", availableCny: 10000 })]);
  });

  it("3. keeps a separate balance per supplier", async () => {
    await added(guangzhou, advance({ amount: 5000 }));
    await added(hangzhou, advance({ amount: 700 }));
    await order(1200);
    expect(await available(guangzhou)).toBe(3800);
    expect(await available(hangzhou)).toBe(700);
  });

  it("4. refuses another currency than the supplier's, and a rate that does not fit it", async () => {
    let res = await addAdvance(guangzhou, advance({ currency: "USD" }));
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({ currency: "This supplier's advances are in CNY." });
    res = await addAdvance(guangzhou, advance({ rateInr: undefined }));
    expect(res.body.error.fields).toEqual({ rateInr: MESSAGES.rateInr });
    await ctx.db.update(suppliers).set({ currency: "INR", exchangeRate: 1 }).where(eq(suppliers.id, hangzhou));
    res = await addAdvance(hangzhou, advance({ rateInr: 12 }));
    expect(res.status).toBe(422);
    expect((await addAdvance(hangzhou, advance({ rateInr: undefined }))).status).toBe(201);
    expect(await ledger()).toHaveLength(1);
  });

  it("5. refuses zero, negative, over-precise and missing amounts, a future date and an empty mode", async () => {
    for (const amount of [0, -5, 10.123, undefined]) {
      const res = await addAdvance(guangzhou, advance({ amount }));
      expect(res.status, String(amount)).toBe(422);
      expect(res.body.error.fields.amount).toBe(MESSAGES.amount);
    }
    expect((await addAdvance(guangzhou, advance({ paidOn: indiaDay(1) }))).body.error.fields.paidOn).toBe(MESSAGES.future);
    expect((await addAdvance(guangzhou, advance({ mode: " " }))).body.error.fields.mode).toBe(MESSAGES.mode);
    expect((await addAdvance(guangzhou, advance({ orderId: guangzhou }))).status).toBe(400);
    expect(await ledger()).toHaveLength(0);
  });

  it("404 for an unknown supplier", async () => {
    expect((await get("/suppliers/00000000-0000-4000-8000-000000000000/advances")).status).toBe(404);
    expect((await addAdvance("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

describe("automatic allocation on order creation (ORD-3)", () => {
  it("6. sufficient advance covers the whole order", async () => {
    await added(guangzhou);
    const { advance: result, order: created } = await order(2000);
    expect(result).toEqual({ appliedCny: 2000, changeCny: 2000, availableCny: 8000, balanceCny: 0, status: "full" });
    expect(await available(guangzhou)).toBe(8000);
    const detail = (await get(`/orders/${created.po}`)).body;
    expect(detail).toMatchObject({ orderValueCny: 2000, supplierPaidCny: 0, advanceCny: 2000, advanceInr: 25000, advanceStatus: "full", balanceCny: 0 });
    expect(detail.advanceEntries).toEqual([expect.objectContaining({ kind: "allocation", amount: 2000, exchangeRate: 12.5, amountInr: 25000, po: created.po })]);
  });

  it("7. partial advance: applies what there is, oldest receipt first, each at its own rate, and says what is left", async () => {
    await added(guangzhou, advance({ amount: 1000, paidOn: indiaDay(-20), rateInr: 12 }));
    await added(guangzhou, advance({ amount: 2000, paidOn: indiaDay(-5), rateInr: 13 }));
    const { advance: result, order: created } = await order(5000);
    expect(result).toEqual({ appliedCny: 3000, changeCny: 3000, availableCny: 0, balanceCny: 2000, status: "partial" });
    const detail = (await get(`/orders/${created.po}`)).body;
    expect(detail).toMatchObject({ advanceCny: 3000, advanceInr: 12000 + 26000, balanceCny: 2000, advanceStatus: "partial" });
    expect(detail.advanceEntries.map((e: { amount: number; exchangeRate: number }) => [e.amount, e.exchangeRate])).toEqual([
      [1000, 12],
      [2000, 13],
    ]);
  });

  it("8. no advance: nothing applied, nothing written, the order is created as before", async () => {
    const { advance: result, order: created } = await order(5000);
    expect(result).toEqual({ appliedCny: 0, changeCny: 0, availableCny: 0, balanceCny: 5000, status: "none" });
    expect(await ledger()).toHaveLength(0);
    expect((await get(`/orders/${created.po}`)).body).toMatchObject({ advanceCny: 0, advanceStatus: "none", balanceCny: 5000, advanceEntries: [] });
  });

  it("9. never more than the order still owes after the deposits paid with it", async () => {
    await added(guangzhou);
    const deposit = { payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 1234.56, paidOn: indiaDay(-1), rateInr: 12.1, mode: "Cash" };
    const agent = { payee: "Sino Freight", payeeRole: "agent", amountCny: 500, paidOn: indiaDay(-1), rateInr: 12.1, mode: "Cash" };
    const { advance: result } = await order(5000, { deposits: [deposit, agent] });
    // 5,000 - 1,234.56 supplier deposit; the agent's sea freight is not the goods.
    expect(result).toMatchObject({ appliedCny: 3765.44, availableCny: 6234.56, balanceCny: 0, status: "full" });
    const { advance: small } = await order(10);
    expect(small).toMatchObject({ appliedCny: 10, availableCny: 6224.56 });
  });

  it("10. two orders at once never draw the same money", async () => {
    await added(guangzhou, advance({ amount: 3000 }));
    const [a, b] = await Promise.all([order(2000), order(2000)]);
    expect(a.advance.appliedCny + b.advance.appliedCny).toBe(3000);
    expect(await available(guangzhou)).toBe(0);
  });

  it("10b. two order edits at once (not serialised by the PO lock) never over-draw either", async () => {
    await added(guangzhou, advance({ amount: 3000 }));
    const first = await order(1000);
    const second = await order(1000);
    expect(await available(guangzhou)).toBe(1000);
    const edit = (po: string) => http.patch(`/orders/${po}`).set("Cookie", management).send({ lines: [{ itemId: jeans, quantity: 5000, rateCny: 1 }] });
    const results = await Promise.all([edit(first.order.po), edit(second.order.po)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await available(guangzhou)).toBe(0);
    const applied = await Promise.all([first, second].map(async (o) => (await get(`/orders/${o.order.po}`)).body.advanceCny as number));
    expect(applied[0]! + applied[1]!).toBe(3000);
  });

  it("11. a retried create (typed PO taken) writes nothing, and settling again is a no-op", async () => {
    await added(guangzhou);
    const { order: created } = await order(2000, { po: "MR-1" });
    const retry = await http
      .post("/orders")
      .set("Cookie", management)
      .send({ po: "mr-1", supplierId: guangzhou, orderDate: indiaDay(-1), deliveryDate: indiaDay(30), lines: [{ itemId: jeans, quantity: 2000, rateCny: 1 }] });
    expect(retry.status).toBe(422);
    const userId = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.management)))[0]!.id;
    const again = await ctx.db.transaction((tx) => settleAdvance(tx, { id: created.id, po: created.po, supplierId: guangzhou, currency: "CNY" }, userId));
    expect(again).toMatchObject({ appliedCny: 2000, changeCny: 0 });
    expect((await ledger()).filter((row) => row.kind === "allocation")).toHaveLength(1);
    expect(await available(guangzhou)).toBe(8000);
  });

  it("uses only advances in the order's currency; a supplier's old-currency advance stays apart", async () => {
    await added(guangzhou, advance({ amount: 4000 }));
    await http.patch(`/suppliers/${guangzhou}`).set("Cookie", management).send({ currency: "USD", exchangeRate: 84 });
    expect((await addAdvance(guangzhou, advance({ currency: "CNY" }))).status).toBe(422);
    const { advance: result } = await order(1000);
    expect(result).toMatchObject({ appliedCny: 0, status: "none" });
    await added(guangzhou, advance({ amount: 600, rateInr: 84.5 }));
    expect((await order(1000)).advance).toMatchObject({ appliedCny: 600, status: "partial" });
    expect((await account(guangzhou)).summary).toEqual([
      expect.objectContaining({ currency: "CNY", availableCny: 4000 }),
      expect.objectContaining({ currency: "USD", availableCny: 0, allocatedCny: 600 }),
    ]);
  });
});

describe("order edit (ORD-5) re-settles the advance", () => {
  it("a lower total gives the excess back, a higher one draws more while advance is available", async () => {
    await added(guangzhou, advance({ amount: 3000 }));
    const { order: created } = await order(2000);
    const edit = (quantity: number) => http.patch(`/orders/${created.po}`).set("Cookie", management).send({ lines: [{ itemId: jeans, quantity, rateCny: 1 }] });
    let res = await edit(1500);
    expect(res.status).toBe(200);
    expect(res.body.advance).toMatchObject({ appliedCny: 1500, changeCny: -500, availableCny: 1500 });
    res = await edit(4000);
    expect(res.body.advance).toMatchObject({ appliedCny: 3000, changeCny: 1500, availableCny: 0, balanceCny: 1000, status: "partial" });
    // A date-only edit leaves the advance alone and keeps the old answer.
    res = await http.patch(`/orders/${created.po}`).set("Cookie", management).send({ deliveryDate: indiaDay(40) });
    expect(res.body).toEqual({ order: expect.any(Object) });
    const kinds = (await ledger()).map((row) => row.kind).sort();
    expect(kinds).toEqual(["allocation", "allocation", "receipt", "reversal"]);
  });
});

describe("cancellation = order delete (ORD-6)", () => {
  it("12-13. gives the allocation back as reversals and keeps both in the history with the PO number", async () => {
    await added(guangzhou);
    const { order: created } = await order(2000);
    expect(await available(guangzhou)).toBe(8000);
    expect((await http.delete(`/orders/${created.po}`).set("Cookie", management)).status).toBe(204);
    expect(await available(guangzhou)).toBe(10000);
    const { entries, summary } = await account(guangzhou);
    expect(summary).toEqual([{ currency: "CNY", receivedCny: 10000, allocatedCny: 2000, reversedCny: 2000, availableCny: 10000, orders: 1 }]);
    // Newest first, each with the balance right after it.
    expect(entries.map((e: { kind: string; po: string; orderId: string | null; balance: number }) => [e.kind, e.po, e.orderId, e.balance])).toEqual([
      ["reversal", created.po, null, 10000],
      ["allocation", created.po, null, 8000],
      ["receipt", "", null, 10000],
    ]);
    // A new order may take the deleted order's PO number: it is still another order.
    await order(1000, { po: created.po });
    expect((await account(guangzhou)).summary[0].orders).toBe(2);
  });

  it("14. a second cancel finds nothing and returns nothing twice; releasing again is a no-op", async () => {
    await added(guangzhou);
    const { order: created } = await order(2000);
    expect((await http.delete(`/orders/${created.po}`).set("Cookie", management)).status).toBe(204);
    expect((await http.delete(`/orders/${created.po}`).set("Cookie", management)).status).toBe(404);
    expect(await available(guangzhou)).toBe(10000);
    expect((await ledger()).filter((row) => row.kind === "reversal")).toHaveLength(1);
  });

  it("15. an order with a direct payment is not deleted (existing rule): its allocation stays (less what the payment covers)", async () => {
    await added(guangzhou);
    const { order: created } = await order(5000);
    expect((await pay(created.id, 100)).status).toBe(201);
    expect(await available(guangzhou)).toBe(5100);
    const res = await http.delete(`/orders/${created.po}`).set("Cookie", management);
    expect(res.status).toBe(409);
    expect(await available(guangzhou)).toBe(5100);
    // Only PAY-2's reversal: the refused delete returned nothing.
    expect((await ledger()).filter((row) => row.kind === "reversal").map((row) => Number(row.amount))).toEqual([100]);
  });
});

describe("ADV-3 delete a receipt recorded by mistake", () => {
  it("only while no order drew on it; order entries are never deleted", async () => {
    const used = await added(guangzhou, advance({ amount: 100 }));
    const spare = await added(guangzhou, advance({ amount: 50 }));
    await order(100);
    let res = await http.delete(`/supplier-advances/${used.id}`).set("Cookie", management);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(MESSAGES.applied(1));
    const allocation = (await ledger()).find((row) => row.kind === "allocation")!;
    res = await http.delete(`/supplier-advances/${allocation.id}`).set("Cookie", management);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(MESSAGES.orderEntry);
    expect((await http.delete(`/supplier-advances/${spare.id}`).set("Cookie", management)).status).toBe(204);
    expect((await http.delete(`/supplier-advances/${spare.id}`).set("Cookie", management)).status).toBe(404);
  });

  it("a supplier with an advance account is not deleted (deactivate instead)", async () => {
    await added(hangzhou);
    const res = await http.delete(`/suppliers/${hangzhou}`).set("Cookie", management);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("1 advance record");
  });
});

describe("existing money stays right and nothing is counted twice", () => {
  it("16. direct payments still work on an advance-covered order; the advance they now cover goes back", async () => {
    await added(guangzhou);
    const { order: created } = await order(2000);
    const res = await pay(created.id, 300);
    expect(res.status).toBe(201);
    expect(res.body.payment.id).toEqual(expect.any(String));
    expect((await get(`/orders/${created.po}`)).body).toMatchObject({ supplierPaidCny: 300, advanceCny: 1700, balanceCny: 0, advanceStatus: "full" });
    expect(await available(guangzhou)).toBe(8300);
  });

  it("17-18. supplier deposits and their settlements leave the advance account alone, and the reverse", async () => {
    await added(guangzhou);
    const deposit = await http.post(`/suppliers/${guangzhou}/deposits`).set("Cookie", accounts).send({ direction: "give", amount: 1000, openedOn: indiaDay(-3) });
    expect(deposit.status).toBe(201);
    const settle = await http
      .post(`/supplier-deposits/${deposit.body.deposit.id}/transactions`)
      .set("Cookie", accounts)
      .send({ paidOn: indiaDay(-1), amount: 400, mode: "Cash" });
    expect(settle.status).toBe(201);
    await order(2000);
    expect(await available(guangzhou)).toBe(8000);
    const statement = (await get(`/suppliers/${guangzhou}/deposits`)).body;
    expect(statement.deposits).toEqual([expect.objectContaining({ amount: 1000, settled: 400, pending: 600 })]);
    expect(statement.advance.summary).toEqual([expect.objectContaining({ availableCny: 8000 })]);
  });

  it("19. balance, payment status, deposit paid, landed cost and reports count the advance once", async () => {
    await added(guangzhou, advance({ amount: 3000, rateInr: 12 }));
    const deposit = { payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 1000, paidOn: indiaDay(-1), rateInr: 11, mode: "Cash" };
    const { order: created } = await order(5000, { deposits: [deposit], depositRequiredCny: 4500 });
    const detail = (await get(`/orders/${created.po}`)).body;
    expect(detail).toMatchObject({
      orderValueCny: 5000,
      paidCny: 1000,
      supplierPaidCny: 1000,
      advanceCny: 3000,
      balanceCny: 1000,
      // Deposit paid = the direct supplier deposit + the advance applied, against the 4,500 asked for.
      depositPaidCny: 4000,
      depositPendingCny: 500,
      depositStatus: "partly",
    });
    const list = (await get("/orders")).body.find((row: { po: string }) => row.po === created.po);
    expect(list).toMatchObject({ supplierPaidCny: 1000, advanceCny: 3000, advanceInr: 36000 });
    const payments = (await get("/payments")).body.orders.find((row: { po: string }) => row.po === created.po);
    expect(payments).toMatchObject({ supplierPaidCny: 1000, advanceCny: 3000, balanceCny: 1000 });
    const cost = (await loadLandedCosts(ctx.db, [created.id])).get(created.id)!;
    expect(cost).toMatchObject({ goodsInr: 11000 + 36000, waitingFor: "supplier payment" });
    const perSupplier = (await get("/reports/payments-per-supplier")).body.suppliers.find((row: { supplierId: string }) => row.supplierId === guangzhou);
    expect(perSupplier).toMatchObject({ orderValueCny: 5000, paidCny: 1000, advanceCny: 3000, balanceCny: 1000 });
    const detailReport = (await get(`/reports/payments-per-supplier/${guangzhou}`)).body;
    expect(detailReport.summary.byCurrency).toEqual([expect.objectContaining({ paidCny: 1000, advanceCny: 3000, balanceCny: 1000 })]);
    expect(detailReport.advance.summary).toEqual([expect.objectContaining({ allocatedCny: 3000, availableCny: 0 })]);
    const reportList = (await get(`/reports/orders?po=${created.po}`)).body.rows[0];
    expect(reportList).toMatchObject({ paidCny: 1000, advanceCny: 3000, balanceCny: 1000, paymentStatus: "partly" });
    const report = (await get(`/orders/${encodeURIComponent(created.po)}/report`)).body;
    expect(report.payments).toMatchObject({ paidCny: 1000, advanceCny: 3000, balanceCny: 1000, advanceStatus: "partial" });
    expect(report.payments.advanceEntries).toHaveLength(1);
    expect(report.supplierAccount).toMatchObject({ advanceApplied: [{ currency: "CNY", amount: 3000 }], balance: [{ currency: "CNY", amount: 1000 }] });
    const obligations = (await get("/deposits")).body.orderObligations.find((row: { po: string }) => row.po === created.po);
    expect(obligations).toMatchObject({ requiredCny: 4500, paidCny: 4000, advanceCny: 3000, pendingCny: 500 });
    // Fully covered: the list's payment status reads paid.
    await http.patch(`/orders/${created.po}`).set("Cookie", management).send({ lines: [{ itemId: jeans, quantity: 4000, rateCny: 1 }] });
    expect((await get(`/reports/orders?po=${created.po}`)).body.rows[0]).toMatchObject({ advanceCny: 3000, balanceCny: 0, paymentStatus: "paid" });
  });

  it("20. snapshots: the advance keeps its rate when the supplier's changes; allocations carry it, not the order's", async () => {
    await http.patch(`/suppliers/${guangzhou}`).set("Cookie", management).send({ exchangeRate: 12 });
    await added(guangzhou, advance({ amount: 1000, rateInr: 12.3456 }));
    await http.patch(`/suppliers/${guangzhou}`).set("Cookie", management).send({ exchangeRate: 14 });
    const { order: created } = await order(1000);
    const [row] = await ctx.db.select({ exchangeRate: orders.exchangeRate }).from(orders).where(eq(orders.id, created.id));
    expect(row!.exchangeRate).toBe(14);
    const detail = (await get(`/orders/${created.po}`)).body;
    expect(detail.advanceEntries[0]).toMatchObject({ exchangeRate: 12.3456, amountInr: 12345.6 });
    expect(detail.advanceInr).toBe(12345.6);
    expect((await account(guangzhou)).entries.find((e: { kind: string }) => e.kind === "receipt").exchangeRate).toBe(12.3456);
  });
});

describe("PAY-2 gives back the advance a direct supplier payment now covers", () => {
  it("returns the excess as a reversal of the allocation, which stays as it was", async () => {
    await added(guangzhou);
    const { order: created } = await order(2000);
    const res = await pay(created.id, 500);
    expect(res.status).toBe(201);
    expect(res.body.advance).toEqual({ appliedCny: 1500, changeCny: -500, availableCny: 8500, balanceCny: 0, status: "full" });
    const rows = (await ledger()).filter((row) => row.orderId === created.id);
    const allocation = rows.find((row) => row.kind === "allocation")!;
    expect(Number(allocation.amount)).toBe(2000);
    expect(rows.filter((row) => row.kind === "reversal").map((row) => [Number(row.amount), row.reversalOf, Number(row.exchangeRate)])).toEqual([[500, allocation.id, 12.5]]);
    expect((await get(`/orders/${created.po}`)).body).toMatchObject({ supplierPaidCny: 500, advanceCny: 1500, balanceCny: 0 });
  });

  it("partial cover: payments up to the balance leave it; past the balance only the excess goes; past the value, all of it", async () => {
    await added(guangzhou, advance({ amount: 3000 }));
    const { order: created } = await order(5000);
    expect((await pay(created.id, 1500)).body.advance).toMatchObject({ appliedCny: 3000, changeCny: 0, balanceCny: 500, status: "partial" });
    expect((await ledger()).filter((row) => row.kind === "reversal")).toHaveLength(0);
    expect((await pay(created.id, 1000)).body.advance).toMatchObject({ appliedCny: 2500, changeCny: -500, balanceCny: 0, status: "full" });
    // Direct payments alone past the value (no overpayment check, as before): no advance is left applied.
    expect((await pay(created.id, 3000)).body.advance).toMatchObject({ appliedCny: 0, changeCny: -2500, availableCny: 3000, balanceCny: -500, status: "none" });
    expect((await get(`/orders/${created.po}`)).body).toMatchObject({ supplierPaidCny: 5500, advanceCny: 0, balanceCny: -500, advanceStatus: "none" });
    expect(await available(guangzhou)).toBe(3000);
  });

  it("never draws: a payment leaves an uncovered order uncovered; an agent payment answers as before", async () => {
    const { order: created } = await order(5000);
    await added(guangzhou, advance({ amount: 3000 }));
    expect((await pay(created.id, 100)).body.advance).toMatchObject({ appliedCny: 0, changeCny: 0, balanceCny: 4900, status: "none" });
    const sino = (await ctx.db.select({ id: shippingAgents.id }).from(shippingAgents).where(eq(shippingAgents.name, "Sino Freight")))[0]!.id;
    const agentPaid = await pay(created.id, 100, { payeeRole: "agent", agentId: sino });
    expect(agentPaid.status).toBe(201);
    expect(Object.keys(agentPaid.body)).toEqual(["payment"]);
    expect(await available(guangzhou)).toBe(3000);
    expect(await ledger()).toHaveLength(1);
  });

  it("concurrent: two payments and an apply on one order end at the same figures, whatever runs first", async () => {
    await added(guangzhou);
    const { order: created } = await order(2000);
    const results = await Promise.all([pay(created.id, 500), pay(created.id, 700), apply(created.po)]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 200]);
    expect((await get(`/orders/${created.po}`)).body).toMatchObject({ supplierPaidCny: 1200, advanceCny: 800, balanceCny: 0 });
    expect(await appliedOf(created.id)).toBe(800);
    expect(await available(guangzhou)).toBe(9200);
  });

  it("concurrent: a payment's excess and a new order of the same supplier never count the same money twice", async () => {
    await added(guangzhou, advance({ amount: 2000 }));
    const { order: first } = await order(2000);
    const [paid, next] = await Promise.all([pay(first.id, 500), order(1000)]);
    expect(paid.status).toBe(201);
    expect(await appliedOf(first.id)).toBe(1500);
    // The new order got the returned 500 only if it ran after the payment; either way nothing is drawn twice.
    expect([0, 500]).toContain(next.advance.appliedCny);
    expect((await appliedOf(first.id)) + (await appliedOf(next.order.id)) + (await available(guangzhou))).toBe(2000);
  });
});

describe("ADV-4 applies an advance recorded after the order was placed", () => {
  const openPos = async () => ((await account(guangzhou)).openOrders as { po: string; balanceCny: number }[]).map((row) => [row.po, row.balanceCny]);

  it("applies what is available up to what the order owes, once; the open orders and ORD-4 say what is left", async () => {
    const { order: created } = await order(5000);
    expect(await openPos()).toContainEqual([created.po, 5000]);
    expect((await get(`/orders/${created.po}`)).body.advanceAvailableCny).toBe(0);
    await added(guangzhou, advance({ amount: 3000 }));
    expect((await get(`/orders/${created.po}`)).body.advanceAvailableCny).toBe(3000);
    let res = await apply(created.po);
    expect(res.status).toBe(200);
    expect(res.body.advance).toEqual({ appliedCny: 3000, changeCny: 3000, availableCny: 0, balanceCny: 2000, status: "partial" });
    // Again: nothing more to apply, nothing written.
    expect((await apply(created.po)).body.advance).toMatchObject({ appliedCny: 3000, changeCny: 0 });
    expect((await ledger()).filter((row) => row.kind === "allocation")).toHaveLength(1);
    expect(await openPos()).toContainEqual([created.po, 2000]);
    await added(guangzhou, advance({ amount: 4000, paidOn: indiaDay(-1) }));
    res = await apply(created.po);
    expect(res.body.advance).toEqual({ appliedCny: 5000, changeCny: 2000, availableCny: 2000, balanceCny: 0, status: "full" });
    expect((await openPos()).map(([po]) => po)).not.toContain(created.po);
  });

  it("counts the direct supplier payments first", async () => {
    const { order: created } = await order(5000);
    expect((await pay(created.id, 4000)).status).toBe(201);
    await added(guangzhou, advance({ amount: 3000 }));
    expect((await apply(created.po)).body.advance).toMatchObject({ appliedCny: 1000, changeCny: 1000, availableCny: 2000, balanceCny: 0 });
  });

  it("a double click applies once", async () => {
    const { order: created } = await order(5000);
    await added(guangzhou, advance({ amount: 3000 }));
    const both = await Promise.all([apply(created.po), apply(created.po)]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(both.map((r) => r.body.advance.changeCny as number).sort((x, y) => x - y)).toEqual([0, 3000]);
    expect(await appliedOf(created.id)).toBe(3000);
  });

  it("needs payments Enter (Procurement can only view); an unknown PO is 404", async () => {
    const { order: created } = await order(5000);
    await added(guangzhou, advance({ amount: 3000 }));
    expect((await apply(created.po, procurement)).status).toBe(403);
    expect((await apply("PO-404404")).status).toBe(404);
    expect((await apply(created.po, management)).status).toBe(200);
  });
});
