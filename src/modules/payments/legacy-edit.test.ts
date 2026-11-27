import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, payments, shippingAgents, supplierLedgerEntries as entries, supplierLedgerHolds, suppliers, users } from "../../db/schema";
import { api, createTestContext, receiveOrder, resetData, SEEDED, signInAs } from "../../test/harness";
import { reconcileLedger } from "../ledger/backfill";
import { MESSAGES as LEDGER } from "../ledger/ledger";
import { buildLifecycle } from "../reports/test-data";
import { indiaDay, postLegacy } from "../stock/fixtures";
import { MESSAGES } from "./payments.routes";

// PAY-4 on legacy order-linked supplier rows (Deposit/Balance; owner decisions of 2026-11-27): every change, text
// included, voids the row and records a copy on the same order (linked both ways), with a reason. The credit's use in
// the FIFO projection (never the Paid label) decides what may change: settled 409, partly keeps date, rate and at least
// what was used, unsettled may change everything. Any change to the account's settlement but the edited credit's free
// part is refused (409 settlement_change), nothing written. PAY-1 and ORD-4 show each payment's settlement.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let managementId = "";
let guangzhou = "";
let jeans = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  managementId = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.management)))[0]!.id;
  guangzhou = (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, "Guangzhou Textile Co.")))[0]!.id;
  jeans = (await ctx.db.select({ id: items.id }).from(items).where(eq(items.name, "Denim jeans")))[0]!.id;
});

type Order = { id: string; po: string };
/** ORD-3 for Guangzhou (CNY), `value` pieces at ¥1, dated `daysAgo`; received in full unless `received` is false (value 0). */
async function placeOrder(daysAgo: number, value: number, received = true): Promise<Order> {
  const res = await http
    .post("/orders", { supplierId: guangzhou, orderDate: indiaDay(-daysAgo), deliveryDate: indiaDay(20), lines: [{ itemId: jeans, quantity: value, rateCny: 1 }] })
    .set("Cookie", management);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  if (received) await receiveOrder(ctx, res.body.order.id);
  return res.body.order;
}
/** A legacy order-linked supplier payment (before the ledger) at 12, posted by the backfill as the cutover did. */
async function legacy(order: Order, amount: number, daysAgo: number, kind = "Deposit") {
  const [row] = await ctx.db
    .insert(payments)
    .values({ orderId: order.id, kind, payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: amount, status: "paid", paidOn: indiaDay(-daysAgo), rateInr: 12, mode: "Bank", reference: "UTR 9" })
    .returning({ id: payments.id });
  await postLegacy(ctx);
  return row!.id;
}
const rowOf = async (id: string) => (await ctx.db.select().from(payments).where(eq(payments.id, id)))[0]!;
/** PAY-4's body: the payment as saved, with `overrides`, a reason and a new key. */
const bodyOf = async (id: string, overrides: object = {}) => {
  const row = await rowOf(id);
  return { amount: row.amountCny, paidOn: row.paidOn, rateInr: row.rateInr, mode: row.mode, reference: row.reference, notes: row.notes, reason: "Bank statement", clientRequestId: randomUUID(), ...overrides };
};
const edit = (id: string, body: object, cookie = management) => http.patch(`/payments/${id}`, body).set("Cookie", cookie);
const postingsOf = (paymentId: string) => ctx.db.select().from(entries).where(eq(entries.paymentId, paymentId)).orderBy(asc(entries.createdAt));
const snapshot = async () => ({ payments: await ctx.db.select().from(payments).orderBy(asc(payments.id)), entries: await ctx.db.select().from(entries).orderBy(asc(entries.id)) });
type Settlement = { state: string; amountCny: number; usedCny: number; freeCny: number; usedBy: { po: string | null; amountCny: number }[] } | null;
const settlementOf = async (id: string): Promise<Settlement> =>
  ((await http.get("/payments").set("Cookie", management)).body.payments as { id: string; settlement: Settlement }[]).find((row) => row.id === id)!.settlement;

/**
 * o1 ¥1,000 (20 days ago) and o2 ¥300 (14 days ago), both received. Legacy A ¥600 (15 days ago, on o1), B ¥1,000 (12
 * days ago, on o1) and C ¥200 (5 days ago, on o2). FIFO: o1 has A 600 + B 400, o2 has B 300. A is settled, B partly
 * (¥700 used, ¥300 free), C unsettled. Balance +¥500.
 */
async function scenario() {
  const o1 = await placeOrder(20, 1000);
  const o2 = await placeOrder(14, 300);
  const a = await legacy(o1, 600, 15);
  const b = await legacy(o1, 1000, 12, "Balance");
  const c = await legacy(o2, 200, 5);
  return { o1, o2, a, b, c };
}

describe("PAY-1 and ORD-4: each payment's settlement", () => {
  it("unsettled, partly and settled from the projection, with what used it (oldest first); null for agent and voided rows", async () => {
    const { o1, o2, a, b, c } = await scenario();
    const sino = (await ctx.db.select({ id: shippingAgents.id }).from(shippingAgents).where(eq(shippingAgents.name, "Sino Freight")))[0]!.id;
    const agent = await http
      .post("/payments", { orderId: o1.id, payeeRole: "agent", agentId: sino, kind: "Balance", amountCny: 50, paidOn: indiaDay(-3), rateInr: 12, mode: "Cash", clientRequestId: randomUUID() })
      .set("Cookie", management);
    const voided = await legacy(o2, 40, 6);
    expect((await http.delete(`/payments/${voided}`, { reason: "Twice" }).set("Cookie", management)).status).toBe(200);
    const expected = {
      [a]: { state: "settled", amountCny: 600, usedCny: 600, freeCny: 0, usedBy: [{ po: o1.po, amountCny: 600 }] },
      [b]: { state: "partly", amountCny: 1000, usedCny: 700, freeCny: 300, usedBy: [{ po: o1.po, amountCny: 400 }, { po: o2.po, amountCny: 300 }] },
      [c]: { state: "unsettled", amountCny: 200, usedCny: 0, freeCny: 200, usedBy: [] },
      [agent.body.payment.id]: null,
      [voided]: null,
    };
    const listed = (await http.get("/payments").set("Cookie", management)).body.payments as { id: string; settlement: Settlement }[];
    expect(Object.fromEntries(listed.map((row) => [row.id, row.settlement]))).toEqual(expected);
    // ORD-4: the order-linked rows, the same settlement.
    for (const [order, ids] of [[o1, [a, b, agent.body.payment.id]], [o2, [voided, c]]] as const) {
      const detail = (await http.get(`/orders/${order.po}`).set("Cookie", management)).body.payments as { id: string; settlement: Settlement }[];
      expect(Object.fromEntries(detail.map((row) => [row.id, row.settlement])), order.po).toEqual(Object.fromEntries(ids.map((id) => [id, expected[id]])));
    }
  });
});

describe("PAY-4 legacy correction", () => {
  it("unsettled: every field changes; the copy keeps the order, kind and payee; the void is dated at the original; both are linked", async () => {
    const order = await placeOrder(10, 1000, false); // nothing received: value 0, so the deposit is all free
    const id = await legacy(order, 300, 10);
    expect(await settlementOf(id)).toMatchObject({ state: "unsettled" });
    const key = randomUUID();
    const res = await edit(id, { amount: 350, paidOn: indiaDay(-12), rateInr: 12.5, mode: "Cash", reference: "R2", notes: "Counted twice", reason: "Bank statement shows ¥350", clientRequestId: key });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const newId = res.body.payment.id as string;
    expect(res.body).toEqual({
      payment: expect.objectContaining({
        id: newId,
        orderId: order.id,
        po: order.po,
        supplierId: guangzhou,
        currency: "CNY",
        kind: "Deposit",
        payee: "Guangzhou Textile Co.",
        payeeRole: "supplier",
        amountCny: 350,
        paidOn: indiaDay(-12),
        rateInr: 12.5,
        amountInr: 4375,
        mode: "Cash",
        reference: "R2",
        notes: "Counted twice",
        voided: false,
        settlement: { state: "unsettled", amountCny: 350, usedCny: 0, freeCny: 350, usedBy: [] },
      }),
      replaced: id,
      ledger: { supplierId: guangzhou, currency: "CNY", balanceBefore: 300, balanceAfter: 350 },
    });
    const voidReason = `Edited: Bank statement shows ¥350; replaced by payment ${newId}`;
    expect(await rowOf(newId)).toMatchObject({ orderId: order.id, supplierId: null, currency: null, kind: "Deposit", payeeRole: "supplier", clientRequestId: key, createdBy: managementId });
    expect(await rowOf(id)).toMatchObject({ amountCny: 300, paidOn: indiaDay(-10), voidedBy: managementId, voidReason });
    expect((await postingsOf(id)).map((row) => [row.entryType, row.amount, row.entryDate, row.notes])).toEqual([
      ["payment", 300, indiaDay(-10), ""],
      ["payment_void", -300, indiaDay(-10), voidReason],
    ]);
    expect((await postingsOf(newId)).map((row) => [row.entryType, row.amount, row.exchangeRate, row.entryDate, row.notes, row.createdBy])).toEqual([
      ["payment", 350, 12.5, indiaDay(-12), `Edited: Bank statement shows ¥350; replaces payment ${id}`, managementId],
    ]);
    // The voided original stays listed (flagged), the copy is the order's deposit now.
    expect(await settlementOf(id)).toBeNull();
    expect((await http.get(`/orders/${order.po}`).set("Cookie", management)).body.payments.map((row: { id: string; voided: boolean }) => [row.id, row.voided])).toEqual([
      [newId, false],
      [id, true],
    ]);
  });

  it("settled: 409 settled_payment naming what used it, for a text-only change too; nothing written", async () => {
    const { o1, a } = await scenario();
    const before = await snapshot();
    for (const overrides of [{ amount: 700 }, { mode: "Cash" }, { mode: "Cash", reason: "" }]) {
      const res = await edit(a, await bodyOf(a, overrides));
      expect(res.status, JSON.stringify(overrides)).toBe(409);
      expect(res.body.error).toEqual({ code: "settled_payment", message: `This payment was fully used to pay ${o1.po} (¥600), so it can't be edited.` });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("partly: the amount may rise; the orders keep their settlement and the free part grows", async () => {
    const { o1, o2, b } = await scenario();
    const res = await edit(b, await bodyOf(b, { amount: 1200, notes: "Second transfer" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.payment.settlement).toEqual({ state: "partly", amountCny: 1200, usedCny: 700, freeCny: 500, usedBy: [{ po: o1.po, amountCny: 400 }, { po: o2.po, amountCny: 300 }] });
    expect(res.body.ledger).toEqual({ supplierId: guangzhou, currency: "CNY", balanceBefore: 500, balanceAfter: 700 });
    for (const order of [o1, o2]) expect((await http.get(`/orders/${order.po}`).set("Cookie", management)).body).toMatchObject({ paymentStatus: "paid", outstandingCny: 0 });
  });

  it("partly: the amount may fall to exactly what was used (then settled), never below it (422, nothing written)", async () => {
    const { o1, o2, b } = await scenario();
    const before = await snapshot();
    const below = await edit(b, await bodyOf(b, { amount: 699.99 }));
    expect(below.status).toBe(422);
    expect(below.body.error.fields).toEqual({ amount: `Enter at least ¥700: that much of this payment already paid ${o1.po} (¥400) and ${o2.po} (¥300).` });
    expect(await snapshot()).toEqual(before);
    const exact = await edit(b, await bodyOf(b, { amount: 700 }));
    expect(exact.status, JSON.stringify(exact.body)).toBe(200);
    expect(exact.body.payment.settlement).toMatchObject({ state: "settled", amountCny: 700, usedCny: 700, freeCny: 0 });
    expect(exact.body.ledger).toMatchObject({ balanceBefore: 500, balanceAfter: 200 });
  });

  it("partly: the date and rate can't change, and every change needs a reason (422, together; nothing written)", async () => {
    const { o1, o2, b } = await scenario();
    const before = await snapshot();
    const paid = `${o1.po} (¥400) and ${o2.po} (¥300)`;
    const res = await edit(b, await bodyOf(b, { paidOn: indiaDay(-11), rateInr: 12.1, reason: "" }));
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({
      reason: MESSAGES.correctionReason,
      paidOn: `The payment date can't change: part of this payment already paid ${paid}.`,
      rateInr: `The rate can't change: part of this payment already paid ${paid}.`,
    });
    expect((await edit(b, await bodyOf(b, { reference: "UTR 10", reason: " " }))).body.error.fields).toEqual({ reason: MESSAGES.correctionReason });
    expect(await snapshot()).toEqual(before);
    // Saved as it is (nothing changed): 200, nothing written, as today.
    const same = await edit(b, await bodyOf(b, { reason: "" }));
    expect(same.body).toMatchObject({ payment: { id: b }, replaced: null, ledger: null });
    expect(await snapshot()).toEqual(before);
  });

  it("unsettled: a date moved before a credit an order uses would re-settle it: 409 settlement_change naming the order, nothing written", async () => {
    const { o1, c } = await scenario();
    const before = await snapshot();
    const res = await edit(c, await bodyOf(c, { paidOn: indiaDay(-16) }));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toEqual({ code: "settlement_change", message: `This change would alter how ${o1.po} is settled, so nothing was saved.` });
    expect(await snapshot()).toEqual(before);
    // A later date takes nothing from anyone: allowed.
    expect((await edit(c, await bodyOf(c, { paidOn: indiaDay(-2) }))).status).toBe(200);
  });

  it("partly: a copy recorded after a same-date credit would let that credit settle first: 409 settlement_change, nothing written", async () => {
    const { o1, b } = await scenario();
    // A current payment on B's date, recorded after it: unused while B stands first.
    const p2 = await http.post("/payments", { supplierId: guangzhou, amount: 100, paidOn: indiaDay(-12), rateInr: 12, mode: "Bank", clientRequestId: randomUUID() }).set("Cookie", management);
    expect(await settlementOf(p2.body.payment.id)).toMatchObject({ state: "unsettled" });
    const before = await snapshot();
    const res = await edit(b, await bodyOf(b, { mode: "Cash" }));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toEqual({ code: "settlement_change", message: `This change would alter how ${o1.po} is settled, so nothing was saved.` });
    expect(await snapshot()).toEqual(before);
  });

  it("decides on the state at save time: a receipt posted after the page opened makes the payment settled (409)", async () => {
    const order = await placeOrder(10, 1000, false);
    const id = await legacy(order, 300, 8);
    const body = await bodyOf(id, { amount: 320 });
    expect(await settlementOf(id)).toMatchObject({ state: "unsettled" });
    await receiveOrder(ctx, order.id); // ¥1,000 received: the deposit is all used
    expect(await settlementOf(id)).toEqual({ state: "settled", amountCny: 300, usedCny: 300, freeCny: 0, usedBy: [{ po: order.po, amountCny: 300 }] });
    const before = await snapshot();
    const res = await edit(id, body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("settled_payment");
    expect(await snapshot()).toEqual(before);
  });

  it("a negative LED-3 adjustment's take counts as used; the copy, recorded after the adjustment, can't stand in for it (409)", async () => {
    const order = await placeOrder(10, 1000, false);
    const id = await legacy(order, 500, 10);
    const adjusted = await http
      .post(`/suppliers/${guangzhou}/ledger/adjustments`, { currency: "CNY", amount: -200, entryDate: indiaDay(0), rateInr: 12, reason: "Supplier refund", idempotencyKey: randomUUID() })
      .set("Cookie", management);
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(201);
    expect(await settlementOf(id)).toEqual({ state: "partly", amountCny: 500, usedCny: 200, freeCny: 300, usedBy: [{ po: null, amountCny: 200 }] });
    const before = await snapshot();
    expect((await edit(id, await bodyOf(id, { amount: 150 }))).body.error.fields).toEqual({ amount: "Enter at least ¥200: that much of this payment already paid a ledger adjustment (¥200)." });
    // The adjustment's take is worked out from the credits recorded before it (M7): a copy is not one of them.
    const res = await edit(id, await bodyOf(id, { amount: 600 }));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toEqual({ code: "settlement_change", message: "This change would alter how this supplier's account is settled, so nothing was saved." });
    expect(await snapshot()).toEqual(before);
  });

  it("two edits with different keys at once: one 200, the other 409 already_voided; one copy", async () => {
    const { c } = await scenario();
    const results = await Promise.all([edit(c, await bodyOf(c, { amount: 210 })), edit(c, await bodyOf(c, { amount: 220 }))]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(results.find((res) => res.status === 409)!.body.error.code).toBe("already_voided");
    expect(await ctx.db.select().from(payments).where(eq(payments.payeeRole, "supplier"))).toHaveLength(4);
    // Exactly one void of the original and one credit of the one copy.
    const copy = results.find((res) => res.status === 200)!.body.payment.id as string;
    expect((await postingsOf(c)).map((row) => row.entryType)).toEqual(["payment", "payment_void"]);
    expect((await postingsOf(copy)).map((row) => row.entryType)).toEqual(["payment"]);
  });

  it("a repeated submit with the same key replays the correction (200, same answer), also at once; one copy", async () => {
    const { c } = await scenario();
    const body = await bodyOf(c, { amount: 250, reference: "UTR 11" });
    const [first, second] = await Promise.all([edit(c, body), edit(c, body)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body).toEqual(first.body);
    const retry = await edit(c, body);
    expect(retry.body).toEqual(first.body);
    expect(await ctx.db.select().from(payments).where(eq(payments.clientRequestId, body.clientRequestId))).toHaveLength(1);
    expect(await ctx.db.select().from(payments).where(eq(payments.payeeRole, "supplier"))).toHaveLength(4);
    expect((await edit(c, { ...body, amount: 260 })).body.error.code).toBe("idempotency_conflict");
  });

  it("a held account (SUP-010-style) is 409 account_held and untouched; below payments Full is 403", async () => {
    const { c } = await scenario();
    for (const email of [SEEDED.accounts, SEEDED.procurement]) expect((await edit(c, await bodyOf(c, { amount: 210 }), await signInAs(ctx, email))).status, email).toBe(403);
    await ctx.db.insert(supplierLedgerHolds).values({ supplierId: guangzhou, currency: "CNY", reason: "test hold" });
    const before = await snapshot();
    expect((await edit(c, await bodyOf(c, { amount: 210 }))).body.error).toEqual({ code: "account_held", message: LEDGER.held });
    expect(await settlementOf(c)).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it("the reconciliation passes after corrections (payments, voids, orders)", async () => {
    const { b, c } = await scenario();
    expect((await edit(b, await bodyOf(b, { amount: 900 }))).status).toBe(200);
    expect((await edit(c, await bodyOf(c, { amount: 150, paidOn: indiaDay(-1), rateInr: 12.2 }))).status).toBe(200);
    const { checks } = await reconcileLedger(ctx.db);
    expect(checks.filter((check) => ["payments", "voids", "orders", "not-posted"].includes(check.id)).map((check) => [check.id, check.problems])).toEqual([
      ["payments", []],
      ["voids", []],
      ["not-posted", []],
      ["orders", []],
    ]);
  });
});

describe("PAY-4 legacy text-only correction: nothing counted twice", () => {
  it("a new reference on an unsettled row is a correction (void + copy, same amount); balances, settlement and reconciliation unchanged", async () => {
    const { o2, c } = await scenario();
    const accountOf = async () =>
      ((await http.get("/payments").set("Cookie", management)).body.accounts as { supplierId: string; currency: string }[]).find(
        (row) => row.supplierId === guangzhou && row.currency === "CNY",
      );
    // PAY-1's order row: the FIFO figures (settled, outstanding, status, INR, milestone).
    const orderOf = async () => ((await http.get("/payments").set("Cookie", management)).body.orders as { po: string }[]).find((row) => row.po === o2.po);
    const [accountBefore, orderBefore] = [await accountOf(), await orderOf()];
    const res = await edit(c, await bodyOf(c, { reference: "UTR 12", reason: "Reference from the bank" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.replaced).toBe(c);
    expect(res.body.payment).toMatchObject({ orderId: o2.id, kind: "Deposit", amountCny: 200, reference: "UTR 12", voided: false });
    expect(await rowOf(c)).toMatchObject({ reference: "UTR 9", voidReason: `Edited: Reference from the bank; replaced by payment ${res.body.payment.id}` });
    // Same credits, balance and INR paid: the voided original and the copy are never both counted.
    expect(await accountOf()).toEqual(accountBefore);
    expect(await orderOf()).toEqual(orderBefore);
    expect(await settlementOf(res.body.payment.id)).toEqual({ state: "unsettled", amountCny: 200, usedCny: 0, freeCny: 200, usedBy: [] });
    const { ok, checks } = await reconcileLedger(ctx.db);
    expect(checks.filter((check) => !check.ok).map((check) => [check.id, check.problems])).toEqual([]);
    expect(ok).toBe(true);
  });
});

describe("PAY-4 legacy correction and a final landed cost (M8)", () => {
  it("a correction of a credit that settles a protected final order needs the Management approval, kept on both postings", async () => {
    const data = await buildLifecycle(ctx); // A (Guangzhou) final, settled by its legacy credits
    // A first credit on A, so the ¥2,000 deposit is partly used (¥500 of it settles A).
    await ctx.db.insert(payments).values({ orderId: data.a.id, kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 2500, status: "paid", paidOn: indiaDay(-39), rateInr: 12, mode: "Bank" });
    await postLegacy(ctx);
    const [deposit] = await ctx.db.select().from(payments).where(and(eq(payments.orderId, data.a.id), eq(payments.amountCny, 2000)));
    expect(await settlementOf(deposit!.id)).toMatchObject({ state: "partly", usedCny: 500, usedBy: [{ po: data.a.po, amountCny: 500 }] });
    const body = await bodyOf(deposit!.id, { reference: "UTR 2000", reason: "Reference from the bank" });
    const before = await snapshot();
    const refused = await edit(deposit!.id, body);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("final_settlement_approval");
    expect(await snapshot()).toEqual(before);
    const approved = await edit(deposit!.id, { ...body, finalSettlementApproval: { reason: "Same money" } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const newId = approved.body.payment.id as string;
    const approval = "; Management approval (final landed cost): Same money";
    expect((await postingsOf(deposit!.id)).at(-1)).toMatchObject({ entryType: "payment_void", notes: `Edited: Reference from the bank; replaced by payment ${newId}${approval}` });
    expect(await postingsOf(newId)).toMatchObject([{ entryType: "payment", amount: 2000, notes: `Edited: Reference from the bank; replaces payment ${deposit!.id}${approval}` }]);
    expect((await http.get(`/orders/${data.a.po}`).set("Cookie", management)).body).toMatchObject({ settledCny: 3000, outstandingCny: 0 });
  });
});
