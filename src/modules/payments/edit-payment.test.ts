import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, payments, shippingAgents, supplierLedgerEntries as entries, supplierLedgerHolds, suppliers } from "../../db/schema";
import { api, createTestContext, receiveOrder, resetData, SEEDED, signInAs } from "../../test/harness";
import { MESSAGES as LEDGER } from "../ledger/ledger";
import { buildLifecycle } from "../reports/test-data";
import { todayInIndia } from "../stages/common";
import { indiaDay } from "../stock/fixtures";
import { MESSAGES } from "./payments.routes";

// PAY-4 PATCH /payments/:id (payments Full): mode, reference and notes change in place and post nothing; a new amount,
// date or rate voids the payment as PAY-3 does and records a corrected copy as PAY-2 does, in one transaction, under the
// same M8 guard. Voided rows and held accounts are refused; legacy order-linked rows: legacy-edit.test.ts.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let guangzhou = "";
let sino = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  guangzhou = (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, "Guangzhou Textile Co.")))[0]!.id;
  sino = (await ctx.db.select({ id: shippingAgents.id }).from(shippingAgents).where(eq(shippingAgents.name, "Sino Freight")))[0]!.id;
});

/** ORD-3 then received in full: Guangzhou's CNY account owes ¥10,000. */
async function placeOrder() {
  const itemId = (await ctx.db.select({ id: items.id }).from(items).where(eq(items.name, "Denim jeans")))[0]!.id;
  const res = await http.post("/orders", { supplierId: guangzhou, orderDate: indiaDay(-20), deliveryDate: indiaDay(20), lines: [{ itemId, quantity: 1000, rateCny: 10 }] }).set("Cookie", management);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await receiveOrder(ctx, res.body.order.id);
  return res.body.order as { id: string; po: string };
}
const fields = (overrides: object = {}) => ({ amount: 1000, paidOn: indiaDay(-5), rateInr: 12, mode: "Bank", reference: "UTR 1", notes: "", clientRequestId: randomUUID(), ...overrides });
const pay = async (overrides: object = {}) => {
  const res = await http.post("/payments", { supplierId: guangzhou, ...fields(overrides) }).set("Cookie", management);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.payment.id as string;
};
const edit = (id: string, body: object, cookie = management) => http.patch(`/payments/${id}`, body).set("Cookie", cookie);
const postingsOf = (paymentId: string) => ctx.db.select().from(entries).where(eq(entries.paymentId, paymentId)).orderBy(asc(entries.createdAt));
const rowOf = async (id: string) => (await ctx.db.select().from(payments).where(eq(payments.id, id)))[0]!;
const snapshot = async () => ({ payments: await ctx.db.select().from(payments).orderBy(asc(payments.id)), entries: await ctx.db.select().from(entries).orderBy(asc(entries.id)) });

describe("PAY-4 access", () => {
  it("is 401 signed out and 403 below payments Full (Accounts records payments), changing nothing", async () => {
    await placeOrder();
    const id = await pay();
    const before = await snapshot();
    expect((await http.patch(`/payments/${id}`, fields({ mode: "Cash" }))).status).toBe(401);
    for (const email of [SEEDED.accounts, SEEDED.procurement, SEEDED.chinaStaff]) expect((await edit(id, fields({ mode: "Cash" }), await signInAs(ctx, email))).status, email).toBe(403);
    expect(await snapshot()).toEqual(before);
  });
});

describe("PAY-4 PATCH /payments/:id", () => {
  it("mode, reference and notes change in place and post nothing; an unchanged submit writes nothing", async () => {
    await placeOrder();
    const id = await pay();
    const [credit] = await postingsOf(id);
    const res = await edit(id, fields({ mode: " Cash ", reference: "", notes: "Paid at the office" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ payment: expect.objectContaining({ id, mode: "Cash", reference: "", notes: "Paid at the office", amountCny: 1000, voided: false }), replaced: null, ledger: null });
    expect(await postingsOf(id)).toEqual([credit]);
    expect(await ctx.db.select().from(payments)).toHaveLength(1);
    // The same again (a retry, or Save with nothing changed): 200, nothing written.
    const before = await snapshot();
    const again = await edit(id, fields({ mode: "Cash", reference: "", notes: "Paid at the office" }));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ payment: { id }, replaced: null, ledger: null });
    expect(await snapshot()).toEqual(before);
  });

  it("a new amount, date or rate voids the payment (with its void posting) and records a corrected, posted copy; the balances follow", async () => {
    const order = await placeOrder();
    const id = await pay();
    expect((await edit(id, fields({ amount: 1500 }))).body.error).toEqual({ code: "validation_failed", message: expect.any(String), fields: { reason: MESSAGES.editReason } });
    const key = randomUUID();
    const res = await edit(id, fields({ amount: 1500, paidOn: indiaDay(-4), rateInr: 12.5, reason: "Bank statement shows ¥1,500", clientRequestId: key }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const newId = res.body.payment.id as string;
    expect(newId).not.toBe(id);
    expect(res.body).toEqual({
      payment: expect.objectContaining({ id: newId, orderId: null, supplierId: guangzhou, currency: "CNY", kind: "Payment", payee: "Guangzhou Textile Co.", amountCny: 1500, paidOn: indiaDay(-4), rateInr: 12.5, amountInr: 18750, mode: "Bank", reference: "UTR 1", voided: false }),
      replaced: id,
      ledger: { supplierId: guangzhou, currency: "CNY", balanceBefore: -9000, balanceAfter: -8500 },
    });
    expect(await rowOf(id)).toMatchObject({ voidReason: "Edited: Bank statement shows ¥1,500", amountCny: 1000 });
    expect((await rowOf(id)).voidedAt).toBeInstanceOf(Date);
    expect(await rowOf(newId)).toMatchObject({ clientRequestId: key, status: "paid", payeeRole: "supplier" });
    expect((await postingsOf(id)).map((row) => [row.entryType, row.amount, row.entryDate, row.notes])).toEqual([
      ["payment", 1000, indiaDay(-5), ""],
      // Dated at the original's date (not today): the statement never counts both credits between it and the edit.
      ["payment_void", -1000, indiaDay(-5), "Edited: Bank statement shows ¥1,500"],
    ]);
    // LED-1's statement (newest first; the receipt's ¥10,000 is posted today): the corrected credit alone stands after
    // the original's date, never both.
    const statement = (await http.get(`/suppliers/${guangzhou}/ledger`).set("Cookie", management)).body.entries as { entryType: string; amount: number; entryDate: string; runningBalance: number }[];
    expect(statement.filter((row) => row.entryType.startsWith("payment")).map((row) => [row.entryType, row.amount, row.entryDate, row.runningBalance])).toEqual([
      ["payment", 1500, indiaDay(-4), 1500],
      ["payment_void", -1000, indiaDay(-5), 0],
      ["payment", 1000, indiaDay(-5), 1000],
    ]);
    expect((await postingsOf(newId)).map((row) => [row.entryType, row.amount, row.exchangeRate, row.entryDate, row.notes])).toEqual([["payment", 1500, 12.5, indiaDay(-4), "Edited: Bank statement shows ¥1,500"]]);
    expect((await http.get(`/orders/${order.po}`).set("Cookie", management)).body).toMatchObject({ settledCny: 1500, settledInr: 18750, outstandingCny: 8500 });

    // A retry with the same key and details replays (200, the same answer); other details are 409; the old row can't be edited again.
    const retry = await edit(id, fields({ amount: 1500, paidOn: indiaDay(-4), rateInr: 12.5, reason: "Bank statement shows ¥1,500", clientRequestId: key }));
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toEqual(res.body);
    expect((await edit(id, fields({ amount: 1600, reason: "x", clientRequestId: key }))).body.error.code).toBe("idempotency_conflict");
    expect((await edit(id, fields({ amount: 1600, reason: "x" }))).body.error.code).toBe("already_voided");
    expect(await ctx.db.select().from(payments)).toHaveLength(2);
  });

  it("an agent payment's correction is never posted: the original is voided and a copy kept on the order", async () => {
    const order = await placeOrder();
    const agent = await http
      .post("/payments", { orderId: order.id, payeeRole: "agent", agentId: sino, kind: "Balance", amountCny: 500, paidOn: indiaDay(-5), rateInr: 12, mode: "Cash", clientRequestId: randomUUID() })
      .set("Cookie", management);
    const id = agent.body.payment.id as string;
    const res = await edit(id, fields({ amount: 450, mode: "Cash", reference: "", reason: "Agent invoice" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ payment: { orderId: order.id, po: order.po, payee: "Sino Freight", payeeRole: "agent", kind: "Balance", amountCny: 450, amountInr: 5400 }, replaced: id, ledger: null });
    expect(await rowOf(id)).toMatchObject({ voidReason: "Edited: Agent invoice" });
    expect(await ctx.db.select().from(entries).where(eq(entries.supplierId, guangzhou))).toHaveLength(2); // the order's debit and its receipt only
    expect((await http.get(`/orders/${order.po}`).set("Cookie", management)).body).toMatchObject({ agentPaidCny: 450, agentPaidInr: 5400, settledCny: 0 });
  });

  it("refuses a legacy row outside the ledger, due and voided rows, a held account, and broken fields, writing nothing", async () => {
    const order = await placeOrder();
    // A legacy order-linked row the backfill never posted (no credit): nothing to correct.
    const [legacy] = await ctx.db
      .insert(payments)
      .values({ orderId: order.id, kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 300, status: "paid", paidOn: indiaDay(-9), rateInr: 12, mode: "Bank" })
      .returning({ id: payments.id });
    const id = await pay();
    const voided = await pay({ amount: 10 });
    expect((await http.delete(`/payments/${voided}`, { reason: "Twice" }).set("Cookie", management)).status).toBe(200);
    const before = await snapshot();
    expect((await edit(legacy!.id, fields({ mode: "Cash", reason: "x" }))).body.error).toEqual({ code: "not_editable", message: MESSAGES.editUnposted });
    expect((await edit(voided, fields({ mode: "Cash" }))).body.error.code).toBe("already_voided");
    expect((await edit("00000000-0000-4000-8000-000000000000", fields())).status).toBe(404);
    for (const [overrides, field, message] of [
      [{ amount: 0 }, "amount", MESSAGES.amount],
      [{ amount: 1.005 }, "amount", MESSAGES.amount],
      [{ paidOn: indiaDay(1) }, "paidOn", MESSAGES.paidOnFuture],
      [{ rateInr: undefined }, "rateInr", MESSAGES.rateInr],
      [{ mode: " " }, "mode", MESSAGES.mode],
      [{ clientRequestId: "x" }, "clientRequestId", MESSAGES.clientRequestId],
    ] as const) {
      const res = await edit(id, fields(overrides));
      expect(res.status, JSON.stringify(overrides)).toBe(422);
      expect(res.body.error.fields, JSON.stringify(overrides)).toEqual({ [field]: message });
    }
    expect((await edit(id, { ...fields(), supplierId: guangzhou })).status).toBe(400);
    await ctx.db.insert(supplierLedgerHolds).values({ supplierId: guangzhou, currency: "CNY", reason: "test hold" });
    expect((await edit(id, fields({ mode: "Cash" }))).body.error).toEqual({ code: "account_held", message: LEDGER.held });
    expect(await snapshot()).toEqual(before);
  });
});

describe("PAY-4 and a final landed cost (M8)", () => {
  it("a correction that re-settles a protected final order is 409 until a Management reason approves it; the reason is on both postings", async () => {
    const data = await buildLifecycle(ctx); // A (Guangzhou) final, settled by its legacy credits
    const id = await pay({ amount: 50, paidOn: todayInIndia() });
    const backdated = fields({ amount: 50, paidOn: indiaDay(-45), reason: "Paid before the order" });
    const before = await snapshot();
    const refused = await edit(id, backdated);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("final_settlement_approval");
    expect(refused.body.error.message).toContain(data.a.po);
    expect(await snapshot()).toEqual(before);
    const approved = await edit(id, { ...backdated, finalSettlementApproval: { reason: "Bank statement" } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const notes = "Edited: Paid before the order; Management approval (final landed cost): Bank statement";
    expect((await postingsOf(id)).at(-1)).toMatchObject({ entryType: "payment_void", notes });
    expect(await postingsOf(approved.body.payment.id)).toMatchObject([{ entryType: "payment", amount: 50, entryDate: indiaDay(-45), notes }]);
  });
});
