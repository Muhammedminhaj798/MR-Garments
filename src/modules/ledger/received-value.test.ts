import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, locations, orderLines, orders, payments, receiptLines, receipts, supplierLedgerEntries as entries, supplierLedgerHolds, suppliers, users } from "../../db/schema";
import { api, createTestContext, receiveOrder, resetData, SEEDED, signInAs } from "../../test/harness";
import { buildLifecycle } from "../reports/test-data";
import { todayInIndia } from "../stages/common";
import { indiaDay } from "../stock/fixtures";
import { MESSAGES as STOCK } from "../stock/stock.routes";
import { reconcileLedger } from "./backfill";
import { MESSAGES as LEDGER } from "./ledger";
import { revalueToReceived } from "./revalue";

// The received-value rules (owner, 2026-11-23; docs/unified-ledger.md "Order value"): an order is worth its received
// quantity x rate. REC-3 and REC-4 post the value's difference (held accounts defer it), a change to a final landed
// cost needs a Management approval, ORD-8 corrects a received line's rate, "awaiting goods" replaces "paid" for nothing
// received, the deposit milestone counts only what FIFO settled, and the revaluation script brings history to the rule.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let guangzhou = "";
let hangzhou = "";
let jeans = "";
let fabric = "";
let office = "";
let boss = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  const id = async (table: typeof suppliers | typeof items | typeof locations, name: string) => (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;
  guangzhou = await id(suppliers, "Guangzhou Textile Co.");
  hangzhou = await id(suppliers, "Hangzhou Knits");
  jeans = await id(items, "Denim jeans");
  fabric = await id(items, "Cotton fabric");
  office = await id(locations, "Guangzhou office");
  boss = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.management)))[0]!.id;
});

const get = (path: string, cookie = management) => http.get(path).set("Cookie", cookie);
/** ORD-3: 100 jeans at ¥10 and 50 m fabric at ¥8 (PO value ¥1,400), nothing received. */
const place = async (extra: object = {}) => {
  const res = await http
    .post("/orders", {
      supplierId: guangzhou,
      orderDate: indiaDay(-10),
      deliveryDate: indiaDay(20),
      lines: [
        { itemId: jeans, quantity: 100, rateCny: 10 },
        { itemId: fabric, quantity: 50, rateCny: 8 },
      ],
      ...extra,
    })
    .set("Cookie", management);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const order = res.body.order as { id: string; po: string };
  const lineRows = await ctx.db.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, order.id)).orderBy(asc(orderLines.position));
  return { ...order, jeans: lineRows[0]!.id, fabric: lineRows[1]!.id };
};
/** REC-3 through the API. */
const record = (orderId: string, lines: { orderLineId: string; quantity: number }[], extra: object = {}, cookie = management) =>
  http
    .post("/receipts", { orderId, receivedOn: indiaDay(-1), locationId: office, bundles: 1, shortRemark: "Rest to follow", lines, ...extra })
    .set("Cookie", cookie);
const removeReceipt = (id: string, body: object = {}, cookie = management) => http.delete(`/receipts/${id}`, body).set("Cookie", cookie);
const postingsOf = (orderId: string) => ctx.db.select().from(entries).where(eq(entries.orderId, orderId)).orderBy(asc(entries.createdAt), asc(entries.id));
const detail = async (po: string) => (await get(`/orders/${encodeURIComponent(po)}`)).body;
const pay = async (amount: number, supplierId = guangzhou) => {
  const res = await http
    .post("/payments", { supplierId, amount, paidOn: indiaDay(-1), rateInr: 12, mode: "Bank", clientRequestId: randomUUID() })
    .set("Cookie", management);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};
const maintenance = () => ctx.db.execute(sql`update ledger_state set state = 'maintenance'`);
const snapshot = async () => ({
  receipts: await ctx.db.select().from(receipts).orderBy(asc(receipts.id)),
  receiptLines: await ctx.db.select().from(receiptLines).orderBy(asc(receiptLines.receiptId), asc(receiptLines.orderLineId)),
  payments: await ctx.db.select().from(payments).orderBy(asc(payments.id)),
  entries: await ctx.db.select().from(entries).orderBy(asc(entries.id)),
});

describe("REC-3 and REC-4 post the order's value (received quantity x rate)", () => {
  it("partial, second and over-receipts each post their value; a repeat sync posts nothing; earlier postings never change", async () => {
    const order = await place();
    expect(await postingsOf(order.id)).toMatchObject([{ entryType: "order_debit", amount: 0 }]);
    const first = await record(order.id, [{ orderLineId: order.jeans, quantity: 60 }]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.ledger).toEqual({ supplierId: guangzhou, currency: "CNY", deferred: false, changeCny: -600, balanceBefore: 0, balanceAfter: -600, finalOrders: [] });
    const [debit, firstPosting] = await postingsOf(order.id);
    const second = await record(order.id, [
      { orderLineId: order.jeans, quantity: 40 },
      { orderLineId: order.fabric, quantity: 30 },
    ]);
    expect(second.body.ledger).toMatchObject({ changeCny: -640, balanceBefore: -600, balanceAfter: -1240 });
    // 20 jeans more than ordered: excess is included in the value.
    const over = await record(order.id, [{ orderLineId: order.jeans, quantity: 20 }]);
    expect(over.body.ledger).toMatchObject({ changeCny: -200, balanceAfter: -1440 });
    const rows = await postingsOf(order.id);
    expect(rows.map((row) => [row.entryType, row.amount, row.entryDate, row.origin])).toEqual([
      ["order_debit", 0, indiaDay(-10), "app"],
      ["order_adjustment", -600, todayInIndia(), "app"],
      ["order_adjustment", -640, todayInIndia(), "app"],
      ["order_adjustment", -200, todayInIndia(), "app"],
    ]);
    expect(rows[0]).toEqual(debit);
    expect(rows[1]).toEqual(firstPosting);
    expect(await detail(order.po)).toMatchObject({ orderValueCny: 1440, poValueCny: 1400, outstandingCny: 1440, paymentStatus: "unpaid" });
    // Nothing changed since: a sync (the revaluation, or a hold's release) posts nothing.
    await maintenance();
    expect(await revalueToReceived(ctx.db, { apply: true, note: "repeat" })).toMatchObject({ applied: true, postings: 0 });
    expect(await postingsOf(order.id)).toHaveLength(4);
  });

  it("REC-4 posts the deleted receipt's value back; both are 503 in maintenance and write nothing", async () => {
    const order = await place();
    const kept = (await record(order.id, [{ orderLineId: order.jeans, quantity: 100 }])).body.receipt.id as string;
    const removed = (await record(order.id, [{ orderLineId: order.fabric, quantity: 50 }])).body.receipt.id as string;
    expect((await removeReceipt(removed)).status).toBe(204);
    expect((await postingsOf(order.id)).map((row) => row.amount)).toEqual([0, -1000, -400, 400]);
    expect(await detail(order.po)).toMatchObject({ orderValueCny: 1000, received: 100 });

    await maintenance();
    const before = await snapshot();
    const paused = (res: { status: number; body: { error?: unknown } }) => {
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.error).toEqual({ code: "ledger_maintenance", message: STOCK.receiptMaintenance });
    };
    paused(await record(order.id, [{ orderLineId: order.fabric, quantity: 5 }]));
    paused(await removeReceipt(kept));
    expect(await snapshot()).toEqual(before);
  });

  it("a held account's receipt is recorded and nothing is posted; once the hold is released the sync posts its debit at the full value", async () => {
    // Hangzhou's order written as a legacy record (the API refuses new orders into a held account), then held.
    const [order] = await ctx.db.insert(orders).values({ poNumber: "H-REC", supplierId: hangzhou, orderDate: indiaDay(-20), deliveryDate: indiaDay(10), currency: "CNY" }).returning();
    const [line] = await ctx.db.insert(orderLines).values({ orderId: order!.id, itemId: jeans, position: 0, quantity: 100, rateCny: 3 }).returning();
    await ctx.db.insert(supplierLedgerHolds).values({ supplierId: hangzhou, currency: "CNY", reason: "test hold" });
    // Not a money write while held: recorded even in maintenance, and nothing is posted.
    await maintenance();
    const res = await record(order!.id, [{ orderLineId: line!.id, quantity: 80 }]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.ledger).toEqual({ supplierId: hangzhou, currency: "CNY", deferred: true });
    expect(await ctx.db.select().from(receipts).where(eq(receipts.orderId, order!.id))).toHaveLength(1);
    expect(await postingsOf(order!.id)).toHaveLength(0);
    const preview = await revalueToReceived(ctx.db, { apply: false, note: "preview" });
    expect(preview.deferred).toBe(1);
    expect(preview.orders.find((row) => row.po === "H-REC")).toMatchObject({ held: true, received: 80, value: 240, postedBefore: null, valueChange: 0, idempotencyKey: null });
    // Released (the hold row goes): the run posts the order's debit at its received value, once.
    await ctx.db.delete(supplierLedgerHolds).where(eq(supplierLedgerHolds.supplierId, hangzhou));
    expect(await revalueToReceived(ctx.db, { apply: true, note: "SUP hold released" })).toMatchObject({ applied: true, postings: 1 });
    expect(await postingsOf(order!.id)).toMatchObject([{ entryType: "order_debit", amount: -240, entryDate: indiaDay(-20), origin: "app", idempotencyKey: `order:${order!.id}:debit` }]);
    expect(await revalueToReceived(ctx.db, { apply: true, note: "again" })).toMatchObject({ postings: 0 });
  });
});

describe("a final landed cost changes only with Management approval (REC-4 and ORD-8)", () => {
  it("ORD-8 on a final order is 409 until approved; deleting a receipt that re-settles a final order is 409 without approval and nothing changes; approved, the posting keeps the reason", async () => {
    const data = await buildLifecycle(ctx);
    // A (final, ¥3,000 settled by ¥3,000) re-priced from ¥30 to ¥29: it changes A's settlement, so it needs the approval
    // too (owner review of 2026-11-23); approved, the response names A (¥2,900 settled, ¥100 left with the supplier).
    const correction = { lines: [{ id: data.a.lineIds[0], rateCny: 29 }], reason: "Invoice rate" };
    const beforeCorrection = await snapshot();
    const unapproved = await http.post(`/orders/${data.a.po}/rate-corrections`, correction).set("Cookie", management);
    expect(unapproved.status, JSON.stringify(unapproved.body)).toBe(409);
    expect(unapproved.body.error.code).toBe("final_settlement_approval");
    expect(unapproved.body.error.message).toContain(data.a.po);
    expect(await snapshot()).toEqual(beforeCorrection);
    const corrected = await http
      .post(`/orders/${data.a.po}/rate-corrections`, { ...correction, finalSettlementApproval: { reason: "Supplier credit note" } })
      .set("Cookie", management);
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    expect(corrected.body.ledger).toMatchObject({ changeCny: 100, finalOrders: [data.a.po] });
    const [correctionPosting] = (await postingsOf(data.a.id)).slice(-1);
    expect(correctionPosting).toMatchObject({ entryType: "order_adjustment", amount: 100, createdBy: boss });
    expect(correctionPosting!.notes).toMatch(/^Rate correction: Invoice rate \(.*\); Management approval \(final landed cost\): Supplier credit note$/);
    // An order dated before A, received with approval: it takes ¥100 of the credits that settle A.
    const early = await http
      .post("/orders", { supplierId: guangzhou, orderDate: indiaDay(-41), deliveryDate: indiaDay(20), lines: [{ itemId: jeans, quantity: 100, rateCny: 1 }] })
      .set("Cookie", management);
    expect(early.status, JSON.stringify(early.body)).toBe(201);
    const [line] = await ctx.db.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, early.body.order.id));
    const approved = await record(early.body.order.id, [{ orderLineId: line!.id, quantity: 100 }], { finalSettlementApproval: { reason: "Late March lot" } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.ledger.finalOrders).toEqual([data.a.po]);

    // Deleting the receipt gives A its credits back: refused without approval, nothing written.
    const before = await snapshot();
    const refused = await removeReceipt(approved.body.receipt.id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toEqual({ code: "final_settlement_approval", message: STOCK.finalSettlement([data.a.po], true) });
    expect(await snapshot()).toEqual(before);
    const deleted = await removeReceipt(approved.body.receipt.id, { finalSettlementApproval: { reason: "Receipt entered on the wrong order" } });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
    const [last] = (await postingsOf(early.body.order.id)).slice(-1);
    expect(last).toMatchObject({ entryType: "order_adjustment", amount: 100, notes: "Management approval (final landed cost): Receipt entered on the wrong order", createdBy: boss });
  });
});

describe("a final landed cost stays protected after an approved change takes it out of final (owner review of 2026-11-23)", () => {
  it("records the order when first seen final; an approved receipt that un-finals it keeps it protected, so the next change needs an approval again", async () => {
    const data = await buildLifecycle(ctx);
    const protections = () => ctx.db.execute<{ order_id: string }>(sql`select order_id from final_cost_protections order by order_id`);
    // An order dated before A (final, ¥3,000 paid by ¥3,000), worth ¥100 once received: it takes ¥100 of A's credits.
    const early = await http
      .post("/orders", { supplierId: guangzhou, orderDate: indiaDay(-41), deliveryDate: indiaDay(20), lines: [{ itemId: jeans, quantity: 200, rateCny: 1 }] })
      .set("Cookie", management);
    expect(early.status, JSON.stringify(early.body)).toBe(201);
    const [line] = await ctx.db.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, early.body.order.id));
    const first = await record(early.body.order.id, [{ orderLineId: line!.id, quantity: 100 }], { finalSettlementApproval: { reason: "First lot of the early order" } });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.ledger.finalOrders).toEqual([data.a.po]);
    expect((await protections()).rows.map((row) => row.order_id)).toContain(data.a.id);
    // A is now ¥2,900 of ¥3,000 settled: its landed cost is no longer final (waiting for supplier payment)...
    const a = (await get(`/orders/${data.a.po}`)).body;
    expect(a).toMatchObject({ settledCny: 2900, outstandingCny: 100, paymentStatus: "partly" });
    // ...but it stays protected: the second lot takes ¥100 more of A's credits, so it needs an approval again.
    const before = await snapshot();
    const second = await record(early.body.order.id, [{ orderLineId: line!.id, quantity: 100 }]);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.error).toEqual({ code: "final_settlement_approval", message: STOCK.finalSettlement([data.a.po], false) });
    expect(await snapshot()).toEqual(before);
    const approved = await record(early.body.order.id, [{ orderLineId: line!.id, quantity: 100 }], { finalSettlementApproval: { reason: "Second lot of the early order" } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.ledger.finalOrders).toEqual([data.a.po]);
    const [last] = (await postingsOf(early.body.order.id)).slice(-1);
    expect(last).toMatchObject({ entryType: "order_adjustment", amount: -100, notes: "Management approval (final landed cost): Second lot of the early order", createdBy: boss });
    // A rate correction on A (protected, not final now) that changes its settlement (¥30 -> ¥25: ¥2,500 settled) needs
    // the approval as well; one that leaves its settlement as it is (¥31: still ¥2,800 settled) does not.
    const correction = await http.post(`/orders/${data.a.po}/rate-corrections`, { lines: [{ id: data.a.lineIds[0], rateCny: 25 }], reason: "Invoice rate" }).set("Cookie", management);
    expect(correction.status, JSON.stringify(correction.body)).toBe(409);
    expect(correction.body.error.code).toBe("final_settlement_approval");
    const higher = await http.post(`/orders/${data.a.po}/rate-corrections`, { lines: [{ id: data.a.lineIds[0], rateCny: 31 }], reason: "Invoice rate" }).set("Cookie", management);
    expect(higher.status, JSON.stringify(higher.body)).toBe(200);
    expect(higher.body.ledger.finalOrders).toEqual([]);
    // The protection itself can't be removed or changed.
    await expect(ctx.db.execute(sql`delete from final_cost_protections where order_id = ${data.a.id}`)).rejects.toHaveProperty("cause.message", expect.stringMatching(/append-only/));
    await expect(ctx.db.execute(sql`update final_cost_protections set currency = 'USD' where order_id = ${data.a.id}`)).rejects.toHaveProperty("cause.message", expect.stringMatching(/append-only/));
  });
});

// Owner review of 2026-11-23: protection is recorded by whatever completes an order (a payment, a clearing, transport or
// warehouse save, any guarded write), and a void or a backdated payment can't take a protected order's credits unseen.
describe("final landed-cost protection is recorded when an order becomes final and covers voids and backdated payments", () => {
  const protectedIds = async () => (await ctx.db.execute<{ order_id: string }>(sql`select order_id from final_cost_protections order by order_id`)).rows.map((row) => row.order_id);
  const finalCheck = async () => (await reconcileLedger(ctx.db)).checks.find((check) => check.id === "final-protections")!;
  const supplierPayment = (supplierId: string, amount: number, paidOn: string, extra: object = {}) => ({
    supplierId,
    amount,
    paidOn,
    rateInr: 12,
    mode: "Bank transfer",
    clientRequestId: randomUUID(),
    ...extra,
  });

  it("a payment records the orders it finds final; the reconciliation names any final order left unrecorded", async () => {
    const data = await buildLifecycle(ctx); // A and B final, written straight to the database: nothing recorded yet
    expect(await protectedIds()).toEqual([]);
    const unrecorded = await finalCheck();
    expect(unrecorded.ok).toBe(false);
    expect(unrecorded.problems.sort()).toEqual([data.a.po, data.b.po].map((po) => `order ${po}: its landed cost is final but it is not recorded as protected`).sort());

    // A payment of today to A's supplier: it changes no final settlement (A is paid), so no approval; A is recorded.
    const paid = await http.post("/payments", supplierPayment(guangzhou, 50, todayInIndia())).set("Cookie", management);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(await protectedIds()).toEqual([data.a.id]);
    // So does one to B's supplier (a warehouse save that completes an order records it too: warehouse.test.ts).
    const shenzhen = (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, "Shenzhen Apparel")))[0]!.id;
    expect((await http.post("/payments", supplierPayment(shenzhen, 50, todayInIndia())).set("Cookie", management)).status).toBe(201);
    expect((await protectedIds()).sort()).toEqual([data.a.id, data.b.id].sort());
    expect(await finalCheck()).toMatchObject({ ok: true, problems: [] });
  });

  it("a void that takes a protected order's credits needs the approval; afterwards a backdated payment does too (Accounts can't approve)", async () => {
    const data = await buildLifecycle(ctx);
    const [legacy] = await ctx.db
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.orderId, data.a.id), eq(payments.amountCny, 1000), eq(payments.payeeRole, "supplier")));
    const voidIt = (body: object) => http.delete(`/payments/${legacy!.id}`, body).set("Cookie", management);
    const before = await snapshot();
    const refused = await voidIt({ reason: "Entered twice" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("final_settlement_approval");
    expect(refused.body.error.message).toContain(data.a.po);
    expect(await snapshot()).toEqual(before);
    const voided = await voidIt({ reason: "Entered twice", finalSettlementApproval: { reason: "Bank returned it" } });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const [voidEntry] = await ctx.db.select().from(entries).where(eq(entries.idempotencyKey, `payment:${legacy!.id}:void`));
    expect(voidEntry).toMatchObject({ entryType: "payment_void", amount: -1000, notes: "Entered twice; Management approval (final landed cost): Bank returned it", createdBy: boss });
    // A is now ¥1,000 short (no longer final) but stays protected: a payment dated before its credits re-prices it.
    expect(await protectedIds()).toContain(data.a.id);
    const accounts = await signInAs(ctx, SEEDED.accounts);
    const backdated = supplierPayment(guangzhou, 500, indiaDay(-45));
    const asAccounts = await http.post("/payments", backdated).set("Cookie", accounts);
    expect(asAccounts.status, JSON.stringify(asAccounts.body)).toBe(409);
    expect(asAccounts.body.error.code).toBe("final_settlement_approval");
    const notAllowed = await http.post("/payments", { ...backdated, clientRequestId: randomUUID(), finalSettlementApproval: { reason: "Bank statement" } }).set("Cookie", accounts);
    expect(notAllowed.status, JSON.stringify(notAllowed.body)).toBe(403);
    const approved = await http.post("/payments", { ...backdated, clientRequestId: randomUUID(), finalSettlementApproval: { reason: "Bank statement" } }).set("Cookie", management);
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const [credit] = await ctx.db.select().from(entries).where(eq(entries.paymentId, approved.body.payment.id));
    expect(credit).toMatchObject({ entryType: "payment", amount: 500, notes: "Management approval (final landed cost): Bank statement", createdBy: boss });
  });
});

describe("ORD-8 POST /orders/:po/rate-corrections (Management, after receipt)", () => {
  it("is payments Full only, needs a reason, takes received lines whose rate changes, and posts received x the rate change with the rates in its notes", async () => {
    const order = await place();
    await receiveOrder(ctx, order.id, { [order.fabric]: 0 });
    await pay(300);
    const url = `/orders/${order.po}/rate-corrections`;
    const correct = (body: object, cookie = management) => http.post(url, body).set("Cookie", cookie);
    const body = { lines: [{ id: order.jeans, rateCny: 9.5 }], reason: "Supplier credit note" };
    for (const role of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff]) expect((await correct(body, await signInAs(ctx, role))).status, role).toBe(403);
    const fields = async (res: Promise<{ status: number; body: { error: { fields: Record<string, string> } } }>) => {
      const answer = await res;
      expect(answer.status, JSON.stringify(answer.body)).toBe(422);
      return answer.body.error.fields;
    };
    expect(await fields(correct({ ...body, reason: " " }))).toEqual({ reason: "Enter the reason for this rate correction (up to 500 characters)." });
    expect(await fields(correct({ ...body, lines: [{ id: order.fabric, rateCny: 7 }] }))).toEqual({ lines: "Only a line with goods received is corrected here. Change the other lines on Edit order." });
    expect(await fields(correct({ ...body, lines: [{ id: order.jeans, rateCny: 10 }] }))).toEqual({ lines: "Change the rate of at least one line." });
    expect(await fields(correct({ ...body, lines: [{ id: randomUUID(), rateCny: 7 }] }))).toEqual({ lines: "A line on this order changed. Reload the order and try again." });
    expect((await correct({ ...body, extra: 1 })).status).toBe(400);
    expect((await http.post("/orders/PO-404/rate-corrections", body).set("Cookie", management)).status).toBe(404);

    const before = await snapshot();
    const res = await correct(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      order: { id: order.id, po: order.po },
      ledger: { supplierId: guangzhou, currency: "CNY", changeCny: 50, balanceBefore: -700, balanceAfter: -650, entryId: expect.any(String), finalOrders: [] },
    });
    const after = await snapshot();
    // Receipts and payments are untouched; one posting is added; the line's rate is corrected.
    expect({ receipts: after.receipts, receiptLines: after.receiptLines, payments: after.payments }).toEqual({ receipts: before.receipts, receiptLines: before.receiptLines, payments: before.payments });
    expect(after.entries.filter((row) => !before.entries.some((old) => old.id === row.id))).toMatchObject([
      { id: res.body.ledger.entryId, entryType: "order_adjustment", amount: 50, entryDate: todayInIndia(), origin: "app", createdBy: boss, notes: "Rate correction: Supplier credit note (Denim jeans 10 -> 9.5 (100 received))" },
    ]);
    expect((await ctx.db.select({ rate: orderLines.rateCny }).from(orderLines).where(eq(orderLines.id, order.jeans)))[0]!.rate).toBe(9.5);
    expect(await detail(order.po)).toMatchObject({ orderValueCny: 950, poValueCny: 1350, settledCny: 300, outstandingCny: 650 });
  });

  it("is 503 in maintenance and 409 for a held account, changing nothing", async () => {
    const order = await place();
    await receiveOrder(ctx, order.id);
    const body = { lines: [{ id: order.jeans, rateCny: 11 }], reason: "x" };
    await maintenance();
    const paused = await http.post(`/orders/${order.po}/rate-corrections`, body).set("Cookie", management);
    expect(paused.status).toBe(503);
    expect(paused.body.error).toEqual({ code: "ledger_maintenance", message: LEDGER.maintenance });
    await ctx.db.execute(sql`update ledger_state set state = 'live'`);
    await ctx.db.insert(supplierLedgerHolds).values({ supplierId: guangzhou, currency: "CNY", reason: "test hold" });
    const held = await http.post(`/orders/${order.po}/rate-corrections`, body).set("Cookie", management);
    expect(held.status).toBe(409);
    expect(held.body.error).toEqual({ code: "account_held", message: LEDGER.held });
    expect((await ctx.db.select({ rate: orderLines.rateCny }).from(orderLines).where(eq(orderLines.id, order.jeans)))[0]!.rate).toBe(10);
  });
});

describe("payment status and the deposit milestone follow the received value", () => {
  it("awaiting goods (never paid) with nothing received; then partly, paid, and over the PO value; LED-1 gives both values", async () => {
    const order = await place({ depositRequiredCny: 300 });
    // Paid before any goods: supplier credit; nothing settled, so the deposit asked is not met.
    await pay(500);
    expect(await detail(order.po)).toMatchObject({
      orderValueCny: 0,
      poValueCny: 1400,
      settledCny: 0,
      outstandingCny: 0,
      paymentStatus: "awaiting_goods",
      depositRequiredCny: 300,
      depositSettledCny: 0,
      depositPendingCny: 300,
      depositStatus: "unmet",
      supplierAccount: { balanceCny: 500 },
    });
    // 40 jeans (¥400): ¥400 settled of ¥500, the deposit met from what FIFO settled; the rest stays with the supplier.
    await record(order.id, [{ orderLineId: order.jeans, quantity: 40 }]);
    expect(await detail(order.po)).toMatchObject({ orderValueCny: 400, settledCny: 400, outstandingCny: 0, paymentStatus: "paid", depositSettledCny: 400, depositStatus: "met", supplierAccount: { balanceCny: 100 } });
    // 60 more and all the fabric: ¥1,400, ¥500 settled.
    await record(order.id, [
      { orderLineId: order.jeans, quantity: 60 },
      { orderLineId: order.fabric, quantity: 50 },
    ]);
    expect(await detail(order.po)).toMatchObject({ orderValueCny: 1400, settledCny: 500, outstandingCny: 900, paymentStatus: "partly" });
    // Over-received: 10 jeans past the order, worth more than its PO value.
    await record(order.id, [{ orderLineId: order.jeans, quantity: 10 }]);
    expect(await detail(order.po)).toMatchObject({ orderValueCny: 1500, poValueCny: 1400, outstandingCny: 1000 });
    const ledger = (await get(`/suppliers/${guangzhou}/ledger`)).body;
    expect(ledger.orders.find((row: { id: string }) => row.id === order.id)).toMatchObject({ valueCny: 1500, poValueCny: 1400, paymentStatus: "partly" });
    // RPT-O2 filters on the new status.
    const awaiting = await place();
    expect(((await get("/reports/orders?paymentStatus=awaiting_goods")).body.rows as { po: string }[]).map((row) => row.po)).toEqual([awaiting.po]);
  });
});

describe("the revaluation (scripts/ledger-revalue-received.ts)", () => {
  /** A legacy order written to the tables with its debit at the ORDERED value, as the 2026-11-23 cutover posted it. */
  async function legacy(po: string, quantity: number, rate: number, received: number, supplierId = guangzhou) {
    const [order] = await ctx.db.insert(orders).values({ poNumber: po, supplierId, orderDate: indiaDay(-30), deliveryDate: indiaDay(10), currency: "CNY", exchangeRate: 12 }).returning();
    const [line] = await ctx.db.insert(orderLines).values({ orderId: order!.id, itemId: jeans, position: 0, quantity, rateCny: rate }).returning();
    if (received > 0) {
      const [receipt] = await ctx.db.insert(receipts).values({ orderId: order!.id, receivedOn: indiaDay(-20), locationId: office, receivedBy: boss, bundles: 1 }).returning();
      await ctx.db.insert(receiptLines).values({ receiptId: receipt!.id, orderLineId: line!.id, quantity: received });
    }
    await ctx.db.insert(entries).values({
      supplierId,
      currency: "CNY",
      entryType: "order_debit",
      amount: -(quantity * rate),
      exchangeRate: 12,
      entryDate: indiaDay(-30),
      origin: "backfill",
      orderId: order!.id,
      poNumber: po,
      idempotencyKey: `order:${order!.id}:debit`,
    });
    return order!;
  }

  it("previews (rolled back), refuses unless in maintenance, applies one adjustment per changed order dated today, and posts 0 on a rerun", async () => {
    const partial = await legacy("L-1", 100, 10, 60);
    const none = await legacy("L-2", 50, 10, 0);
    const full = await legacy("L-3", 20, 5, 20);
    await pay(500);
    const before = await snapshot();
    const preview = await revalueToReceived(ctx.db, { apply: false, note: "preview" });
    expect(preview).toMatchObject({ applied: false, state: "live", refused: null, postings: 2, deferred: 0, finalChanges: [] });
    expect(preview.orders.filter((row) => row.po.startsWith("L-"))).toEqual([
      { po: "L-1", supplier: "SUP-001", currency: "CNY", held: false, ordered: 100, received: 60, poValue: 1000, postedBefore: 1000, value: 600, valueChange: -400, idempotencyKey: `order:${partial.id}:adj:1` },
      { po: "L-2", supplier: "SUP-001", currency: "CNY", held: false, ordered: 50, received: 0, poValue: 500, postedBefore: 500, value: 0, valueChange: -500, idempotencyKey: `order:${none.id}:adj:1` },
      { po: "L-3", supplier: "SUP-001", currency: "CNY", held: false, ordered: 20, received: 20, poValue: 100, postedBefore: 100, value: 100, valueChange: 0, idempotencyKey: null },
    ]);
    expect(await snapshot()).toEqual(before);
    // The ledger is live: refused, nothing written.
    expect(await revalueToReceived(ctx.db, { apply: true, note: "too early" })).toMatchObject({ applied: false, refused: expect.stringContaining("the ledger is live") });
    expect(await snapshot()).toEqual(before);
    expect((await reconcileLedger(ctx.db, [])).checks.find((check) => check.id === "orders")).toMatchObject({ ok: false });

    await maintenance();
    const applied = await revalueToReceived(ctx.db, { apply: true, note: "Operator, owner-approved revaluation" });
    expect(applied).toMatchObject({ applied: true, state: "maintenance", refused: null, postings: 2 });
    const added = (await snapshot()).entries.filter((row) => !before.entries.some((old) => old.id === row.id));
    expect(added.map((row) => [row.orderId, row.entryType, row.amount, row.entryDate, row.origin, row.createdBy, row.notes])).toEqual(
      expect.arrayContaining([
        [partial.id, "order_adjustment", 400, todayInIndia(), "app", null, "Revaluation to received quantity (owner rule of 2026-11-23): Operator, owner-approved revaluation"],
        [none.id, "order_adjustment", 500, todayInIndia(), "app", null, "Revaluation to received quantity (owner rule of 2026-11-23): Operator, owner-approved revaluation"],
      ]),
    );
    expect(added).toHaveLength(2);
    expect(full.id).toBeTruthy();
    // Earlier postings, payments and receipts unchanged; the reconciliation's orders check now passes.
    const after = await snapshot();
    expect(after.entries.filter((row) => before.entries.some((old) => old.id === row.id))).toEqual(before.entries);
    expect({ payments: after.payments, receipts: after.receipts, receiptLines: after.receiptLines }).toEqual({ payments: before.payments, receipts: before.receipts, receiptLines: before.receiptLines });
    expect((await reconcileLedger(ctx.db, [])).checks.find((check) => check.id === "orders")).toMatchObject({ ok: true });
    expect(await revalueToReceived(ctx.db, { apply: true, note: "rerun" })).toMatchObject({ applied: true, postings: 0 });
    // FIFO re-settles: ¥500 settles L-1 (oldest, now ¥600: ¥500 of it); L-2 awaits its goods.
    expect(await detail("L-1")).toMatchObject({ orderValueCny: 600, settledCny: 500, outstandingCny: 100, paymentStatus: "partly" });
    expect(await detail("L-2")).toMatchObject({ orderValueCny: 0, paymentStatus: "awaiting_goods" });
  });

  it("refuses to apply when a final landed-cost order's settlement would change, writing nothing", async () => {
    const data = await buildLifecycle(ctx);
    // A's received quantity changed behind the ledger's back: revalued, A (final) would settle ¥2,700, not ¥3,000.
    const [aLine] = await ctx.db.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, data.a.id));
    await ctx.db.update(receiptLines).set({ quantity: 90 }).where(eq(receiptLines.orderLineId, aLine!.id));
    const preview = await revalueToReceived(ctx.db, { apply: false, note: "preview" });
    expect(preview.finalChanges).toEqual([{ supplier: "SUP-001", currency: "CNY", orders: [data.a.po] }]);
    await maintenance();
    const before = await snapshot();
    const refused = await revalueToReceived(ctx.db, { apply: true, note: "x" });
    expect(refused).toMatchObject({ applied: false, refused: expect.stringContaining("final landed-cost settlements would change") });
    expect(await snapshot()).toEqual(before);
    expect(await ctx.db.select().from(entries).where(and(eq(entries.orderId, data.a.id), eq(entries.entryType, "order_adjustment")))).toHaveLength(1);
  });
});
