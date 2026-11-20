import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  items,
  notifications,
  orderLines,
  orders,
  payments,
  shippingAgents,
  supplierAdvanceEntries,
  supplierLedgerEntries as entries,
  supplierLedgerHolds,
  suppliers,
  users,
} from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { buildLifecycle } from "../reports/test-data";
import { indiaDay, receive } from "../stock/fixtures";
import { MESSAGES as LEDGER } from "./ledger";

// The unified supplier ledger through the routes (docs/unified-ledger.md): PAY-2's orderless supplier payment and its
// client key, PAY-3's void, the currencies a payment may use (D10), held accounts (D18), the write-state guard, the
// order postings of ORD-3/5/6, the FIFO projection on the screens, the Deposit Required milestone (D11), agent payments
// and landed cost, the retired routes and the foreign keys that keep history.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let accounts = "";
let guangzhou = "";
let hangzhou = "";
let jeans = "";
let sino = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  accounts = await signInAs(ctx, SEEDED.accounts);
  const id = async (table: typeof suppliers | typeof items | typeof shippingAgents, name: string) => (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;
  guangzhou = await id(suppliers, "Guangzhou Textile Co.");
  hangzhou = await id(suppliers, "Hangzhou Knits");
  jeans = await id(items, "Denim jeans");
  sino = await id(shippingAgents, "Sino Freight");
  await ctx.db.update(suppliers).set({ exchangeRate: 12 }).where(eq(suppliers.id, guangzhou));
});

const get = (path: string, cookie = management) => http.get(path).set("Cookie", cookie);
/** ORD-3: `quantity` Denim jeans at ¥1 for the supplier. */
const place = async (quantity: number, extra: object = {}, supplierId = guangzhou) => {
  const res = await http
    .post("/orders", { supplierId, orderDate: indiaDay(-10), deliveryDate: indiaDay(20), lines: [{ itemId: jeans, quantity, rateCny: 1 }], ...extra })
    .set("Cookie", management);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { order: { id: string; po: string }; ledger: { debitCny: number; balanceBefore: number; balanceAfter: number } };
};
const supplierPayment = (overrides: object = {}) => ({ supplierId: guangzhou, amount: 600, paidOn: indiaDay(-1), rateInr: 12, mode: "Bank", reference: "TT-1", clientRequestId: randomUUID(), ...overrides });
const pay = (body: object, cookie = accounts) => http.post("/payments", body).set("Cookie", cookie);
const agentPayment = (orderId: string, overrides: object = {}) => ({
  orderId,
  payeeRole: "agent",
  agentId: sino,
  kind: "Deposit",
  amountCny: 100,
  paidOn: indiaDay(-1),
  rateInr: 12,
  mode: "Bank",
  clientRequestId: randomUUID(),
  ...overrides,
});
const voidIt = (id: string, body: object = { reason: "Recorded twice" }, cookie = management) => http.delete(`/payments/${id}`, body).set("Cookie", cookie);
const balance = async (supplierId = guangzhou, currency = "CNY") =>
  ((await get(`/suppliers/${supplierId}/ledger`)).body.accounts as { currency: string; balanceCny: number | null }[]).find((row) => row.currency === currency)?.balanceCny;
const postingsOf = (where: ReturnType<typeof eq>) => ctx.db.select().from(entries).where(where);
const lines = (orderId: string) => ctx.db.select({ id: orderLines.id, itemId: orderLines.itemId, quantity: orderLines.quantity }).from(orderLines).where(eq(orderLines.orderId, orderId));
const editLines = async (po: string, orderId: string, quantity: number) => {
  const [line] = await lines(orderId);
  return http.patch(`/orders/${po}`, { lines: [{ id: line!.id, itemId: line!.itemId, quantity, rateCny: 1 }] }).set("Cookie", management);
};

describe("PAY-2 orderless supplier payment", () => {
  it("posts a credit to the supplier's account, answers the balance before and after, and links the notification to the ledger", async () => {
    const order = await place(1000);
    expect(order.ledger).toMatchObject({ debitCny: 1000, balanceBefore: 0, balanceAfter: -1000 });
    const res = await pay(supplierPayment());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      payment: { orderId: null, po: null, supplierId: guangzhou, supplier: "Guangzhou Textile Co.", currency: "CNY", kind: "Payment", payeeRole: "supplier", amountCny: 600, amountInr: 7200, status: "paid", voided: false, voidedAt: null, voidedBy: null, voidReason: "" },
      ledger: { supplierId: guangzhou, currency: "CNY", balanceBefore: -1000, balanceAfter: -400 },
    });
    const [row] = await ctx.db.select().from(payments).where(eq(payments.id, res.body.payment.id));
    expect(row).toMatchObject({ orderId: null, supplierId: guangzhou, currency: "CNY", kind: "Payment", payee: "Guangzhou Textile Co.", rateInr: 12 });
    expect(await postingsOf(eq(entries.paymentId, row!.id))).toMatchObject([{ entryType: "payment", amount: 600, exchangeRate: 12, origin: "app", entryDate: indiaDay(-1) }]);
    expect(await balance()).toBe(-400);
    // The order is settled by it (FIFO) though the payment names no order.
    const detail = (await get(`/orders/${order.order.po}`)).body;
    expect(detail).toMatchObject({ settledCny: 600, outstandingCny: 400, paymentStatus: "partly", settledInr: 7200, held: false });
    expect(detail.slices).toMatchObject([{ paymentId: row!.id, amount: 600, exchangeRate: 12, amountInr: 7200, mode: "Bank", reference: "TT-1", memoPo: null }]);
    expect(detail.supplierAccount).toMatchObject({ currency: "CNY", balanceCny: -400, creditsCny: 600, debitsCny: 1000 });
    const sent = await ctx.db.select({ href: notifications.href, title: notifications.title }).from(notifications).where(eq(notifications.kind, "payment-recorded"));
    expect(sent.length).toBeGreaterThan(0);
    for (const note of sent) expect(note).toEqual({ href: `/supplier-ledger/${guangzhou}`, title: "Guangzhou Textile Co. payment recorded" });
  });

  it("D10: the supplier's currency plus any currency with a non-zero balance; another is 422", async () => {
    await place(1000);
    // The supplier moves to USD: its CNY account still owes, so CNY stays on offer until it is settled.
    await ctx.db.update(suppliers).set({ currency: "USD", exchangeRate: 88 }).where(eq(suppliers.id, guangzhou));
    const options = async () => ((await get("/supplier-advances/suppliers", accounts)).body.suppliers as { id: string; currencyOptions: string[] }[]).find((row) => row.id === guangzhou)!.currencyOptions;
    expect(await options()).toEqual(["CNY", "USD"]);
    expect((await pay(supplierPayment({ currency: "CNY", amount: 400 }))).status).toBe(201);
    const inr = await pay(supplierPayment({ currency: "INR", rateInr: undefined }));
    expect(inr.status).toBe(422);
    expect(inr.body.error.fields).toEqual({ currency: "Choose one of this supplier's currencies." });
    expect((await pay(supplierPayment({ currency: "CNY", amount: 600 }))).status).toBe(201); // CNY now 0
    expect(await options()).toEqual(["USD"]);
    expect((await pay(supplierPayment({ currency: "CNY", amount: 1 }))).body.error.fields).toHaveProperty("currency");
    // Left out, the currency is the supplier's own.
    const usd = await pay(supplierPayment({ rateInr: 88.5, amount: 10 }));
    expect(usd.body).toMatchObject({ payment: { currency: "USD", rateInr: 88.5, amountInr: 885 }, ledger: { currency: "USD", balanceBefore: 0, balanceAfter: 10 } });
  });

  it("an INR payment takes rate 1 (none given); a rate on INR, or none on CNY, is 422", async () => {
    await ctx.db.update(suppliers).set({ currency: "INR", exchangeRate: 1 }).where(eq(suppliers.id, hangzhou));
    const res = await pay(supplierPayment({ supplierId: hangzhou, rateInr: undefined, amount: 5000 }));
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ currency: "INR", rateInr: 1, amountInr: 5000 });
    expect((await pay(supplierPayment({ supplierId: hangzhou, rateInr: 12 }))).body.error.fields).toHaveProperty("rateInr");
    const missing = await pay(supplierPayment({ rateInr: undefined }));
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields).toEqual({ rateInr: "Enter an INR rate above 0." });
    expect(await ctx.db.select().from(payments).where(eq(payments.supplierId, guangzhou))).toHaveLength(0);
  });

  it("an order-linked supplier body (the form before the ledger) is 422 on payeeRole; unknown keys are 400", async () => {
    const order = await place(100);
    const old = await pay({ orderId: order.order.id, kind: "Balance", payeeRole: "supplier", agentId: null, amountCny: 10, paidOn: indiaDay(-1), rateInr: 12, mode: "Bank" });
    expect(old.status).toBe(422);
    expect(old.body.error.fields).toEqual({ payeeRole: "Supplier payments are now recorded against the supplier. Reload the page." });
    expect((await pay({ ...supplierPayment(), kind: "Payment" })).status).toBe(400);
    expect((await pay(supplierPayment(), await signInAs(ctx, SEEDED.procurement))).status).toBe(403);
  });
});

describe("PAY-2 clientRequestId", () => {
  it("the same details answer 200 with the same body and one row; other details are 409; a double submit records one", async () => {
    await place(1000);
    const body = supplierPayment();
    const first = await pay(body);
    expect(first.status).toBe(201);
    const again = await pay(body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const other = await pay({ ...body, amount: 601 });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("idempotency_conflict");
    expect((await pay({ ...body, reference: "TT-2" })).status).toBe(409);
    expect(await ctx.db.select().from(payments).where(eq(payments.clientRequestId, body.clientRequestId))).toHaveLength(1);

    const twice = supplierPayment({ amount: 50 });
    const results = await Promise.all([pay(twice), pay(twice)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 201]);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect(await ctx.db.select().from(payments).where(eq(payments.clientRequestId, twice.clientRequestId))).toHaveLength(1);
    expect(await postingsOf(eq(entries.entryType, "payment"))).toHaveLength(2);
    expect(await balance()).toBe(-350);
  });

  it("a shipping-agent payment replays the same way and is never posted", async () => {
    const order = await place(100);
    const body = agentPayment(order.order.id);
    const first = await pay(body);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ payment: expect.objectContaining({ orderId: order.order.id, payeeRole: "agent", payee: "Sino Freight", kind: "Deposit", currency: "CNY" }) });
    expect((await pay(body)).status).toBe(200);
    expect((await pay({ ...body, amountCny: 101 })).status).toBe(409);
    expect(await postingsOf(eq(entries.paymentId, first.body.payment.id))).toHaveLength(0);
    expect(await balance()).toBe(-100);
  });
});

describe("concurrency", () => {
  it("parallel payments for one supplier chain their before/after exactly", async () => {
    await place(1000);
    const results = await Promise.all([100, 200, 300, 400, 500].map((amount) => pay(supplierPayment({ amount }))));
    expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
    const chain = results.map((res) => res.body.ledger as { balanceBefore: number; balanceAfter: number }).sort((x, y) => x.balanceBefore - y.balanceBefore);
    let running = -1000;
    for (const step of chain) {
      expect(step.balanceBefore).toBe(running);
      running = step.balanceAfter;
    }
    expect(running).toBe(500);
    expect(await balance()).toBe(500);
  });

  it("a payment while an order edit runs: both land, and the balances add up", async () => {
    const order = await place(1000);
    const [edit, paid] = await Promise.all([editLines(order.order.po, order.order.id, 1500), pay(supplierPayment({ amount: 700 }))]);
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(paid.status).toBe(201);
    const steps = [
      { before: edit.body.ledger.balanceBefore, after: edit.body.ledger.balanceAfter },
      { before: paid.body.ledger.balanceBefore, after: paid.body.ledger.balanceAfter },
    ].sort((x, y) => (x.before === -1000 ? -1 : y.before === -1000 ? 1 : 0));
    expect(steps[0]!.before).toBe(-1000);
    expect(steps[1]!.before).toBe(steps[0]!.after);
    expect(steps[1]!.after).toBe(-800);
    expect(await balance()).toBe(-800);
  });
});

describe("PAY-3 void", () => {
  it("reverses the posting, keeps the row flagged, leaves it out of totals; a second void is 409 and writes nothing", async () => {
    const order = await place(1000);
    const paid = (await pay(supplierPayment())).body.payment;
    const res = await voidIt(paid.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      payment: { id: paid.id, voided: true, voidedBy: "Suresh Menon", voidReason: "Recorded twice", voidedAt: expect.any(String) },
      ledger: { supplierId: guangzhou, currency: "CNY", balanceBefore: -400, balanceAfter: -1000 },
    });
    expect(await ctx.db.select().from(payments).where(eq(payments.id, paid.id))).toMatchObject([{ amountCny: 600, voidReason: "Recorded twice" }]);
    const posted = await postingsOf(eq(entries.paymentId, paid.id));
    expect(posted.map((row) => [row.entryType, row.amount]).sort()).toEqual([
      ["payment", 600],
      ["payment_void", -600],
    ]);
    expect((await get(`/orders/${order.order.po}`)).body).toMatchObject({ settledCny: 0, outstandingCny: 1000, paymentStatus: "unpaid" });
    const pay1 = (await get("/payments")).body;
    expect(pay1.payments.find((row: { id: string }) => row.id === paid.id)).toMatchObject({ voided: true, voidReason: "Recorded twice" });
    expect(pay1.accounts.find((row: { supplierId: string }) => row.supplierId === guangzhou)).toMatchObject({ paidInr: 0, creditsCny: 0, balanceCny: -1000, lastPaymentOn: null });

    const twice = await voidIt(paid.id, { reason: "Again" });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("already_voided");
    expect(await postingsOf(eq(entries.paymentId, paid.id))).toHaveLength(2);
    expect((await ctx.db.select().from(payments).where(eq(payments.id, paid.id)))[0]!.voidReason).toBe("Recorded twice");
  });

  it("is payments Full only (Accounts' Enter is 403), needs a reason, and is 404 for an unknown payment", async () => {
    await place(100);
    const paid = (await pay(supplierPayment({ amount: 10 }))).body.payment;
    expect((await voidIt(paid.id, { reason: "x" }, accounts)).status).toBe(403);
    expect((await voidIt(paid.id, {})).body.error.fields).toEqual({ reason: "Enter the reason for voiding the payment." });
    expect((await voidIt(paid.id, { reason: "   " })).status).toBe(422);
    expect((await voidIt(randomUUID())).status).toBe(404);
    expect((await ctx.db.select().from(payments).where(eq(payments.id, paid.id)))[0]!.voidedAt).toBeNull();
  });

  it("an agent payment is voided without a posting (ledger null) and drops out of the agent totals", async () => {
    const order = await place(100);
    const agent = (await pay(agentPayment(order.order.id))).body.payment;
    expect((await get(`/orders/${order.order.po}`)).body).toMatchObject({ agentPaidCny: 100, agentPaidInr: 1200 });
    const res = await voidIt(agent.id);
    expect(res.body).toMatchObject({ payment: { voided: true }, ledger: null });
    expect((await get(`/orders/${order.order.po}`)).body).toMatchObject({ agentPaidCny: 0, agentPaidInr: 0 });
  });
});

describe("held accounts (D4, D18)", () => {
  /** A Hangzhou order written straight to the tables (never posted), with a supplier payment and an agent payment, then held. */
  async function heldSetup() {
    const [order] = await ctx.db.insert(orders).values({ poNumber: "H-HELD", supplierId: hangzhou, orderDate: indiaDay(-20), deliveryDate: indiaDay(10), currency: "CNY" }).returning();
    await ctx.db.insert(orderLines).values({ orderId: order!.id, itemId: jeans, position: 0, quantity: 100, rateCny: 1 });
    const [bare] = await ctx.db.insert(orders).values({ poNumber: "H-BARE", supplierId: hangzhou, orderDate: indiaDay(-19), deliveryDate: indiaDay(10), currency: "CNY" }).returning();
    await ctx.db.insert(orderLines).values({ orderId: bare!.id, itemId: jeans, position: 0, quantity: 10, rateCny: 1 });
    const base = { orderId: order!.id, status: "paid", paidOn: indiaDay(-15), rateInr: 12, mode: "Bank", amountCny: 50 };
    const [supplier] = await ctx.db.insert(payments).values({ ...base, kind: "Deposit", payee: "Hangzhou Knits", payeeRole: "supplier" }).returning();
    const [agent] = await ctx.db.insert(payments).values({ ...base, kind: "Deposit", payee: "Sino Freight", payeeRole: "agent" }).returning();
    await ctx.db.insert(supplierLedgerHolds).values({ supplierId: hangzhou, currency: "CNY", reason: "test hold" });
    return { order: order!, bare: bare!, supplier: supplier!, agent: agent! };
  }
  const held = (res: { status: number; body: { error?: { code: string; message: string } } }) => {
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toEqual({ code: "account_held", message: LEDGER.held });
  };

  it("refuses every new financial write into the held account (409) and posts nothing", async () => {
    const seeded = await heldSetup();
    held(await http.post("/orders", { supplierId: hangzhou, orderDate: indiaDay(-1), deliveryDate: indiaDay(9), lines: [{ itemId: jeans, quantity: 1, rateCny: 1 }] }).set("Cookie", management));
    held(await pay(supplierPayment({ supplierId: hangzhou })));
    held(await pay(agentPayment(seeded.order.id)));
    held(await voidIt(seeded.supplier.id));
    held(await voidIt(seeded.agent.id));
    held(await editLines("H-HELD", seeded.order.id, 120));
    held(await http.delete("/orders/H-BARE").set("Cookie", management));
    // Not money: a date edit still works.
    expect((await http.patch("/orders/H-HELD", { deliveryDate: indiaDay(30) }).set("Cookie", management)).status).toBe(200);
    expect(await postingsOf(eq(entries.supplierId, hangzhou))).toHaveLength(0);
    expect(await ctx.db.select().from(orders).where(eq(orders.supplierId, hangzhou))).toHaveLength(2);
    expect((await ctx.db.select().from(payments).where(eq(payments.id, seeded.supplier.id)))[0]!.voidedAt).toBeNull();
  });

  it("reads show the held account and its orders with held: true and null figures", async () => {
    await heldSetup();
    expect((await get("/orders/H-HELD")).body).toMatchObject({ held: true, settledCny: null, outstandingCny: null, paymentStatus: null, supplierAccount: { held: true, balanceCny: null } });
    expect((await get("/orders")).body.find((row: { po: string }) => row.po === "H-HELD")).toMatchObject({ held: true, settledCny: null, paidInr: null });
    expect((await get(`/suppliers/${hangzhou}/ledger`)).body.accounts).toEqual([expect.objectContaining({ currency: "CNY", held: true, balanceCny: null })]);
    const options = (await get("/orders/options")).body.suppliers.find((row: { id: string }) => row.id === hangzhou);
    expect(options).toMatchObject({ held: true, ledgerBalance: [] });
    const report = (await get("/reports/orders?paymentStatus=unpaid")).body.rows.map((row: { po: string }) => row.po);
    expect(report).not.toContain("H-HELD");
  });
});

describe("the write-state guard", () => {
  it("every financial write is 503 while maintenance; a date-only ORD-5 and every read still work", async () => {
    const order = await place(100);
    const paid = (await pay(supplierPayment({ amount: 10 }))).body.payment;
    await ctx.db.execute(sql`update ledger_state set state = 'maintenance'`);
    const paused = (res: { status: number; body: { error?: { code: string; message: string } } }) => {
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.error).toEqual({ code: "ledger_maintenance", message: LEDGER.maintenance });
    };
    paused(await pay(supplierPayment()));
    paused(await pay(agentPayment(order.order.id)));
    paused(await voidIt(paid.id));
    paused(
      await http
        .post(`/suppliers/${guangzhou}/ledger/adjustments`, { currency: "CNY", amount: 1, entryDate: indiaDay(), rateInr: 12, reason: "x", idempotencyKey: randomUUID() })
        .set("Cookie", management),
    );
    paused(await http.post("/orders", { supplierId: guangzhou, orderDate: indiaDay(-1), deliveryDate: indiaDay(9), lines: [{ itemId: jeans, quantity: 1, rateCny: 1 }] }).set("Cookie", management));
    paused(await editLines(order.order.po, order.order.id, 200));
    paused(await http.delete(`/orders/${order.order.po}`).set("Cookie", management));
    expect((await http.patch(`/orders/${order.order.po}`, { deliveryDate: indiaDay(40) }).set("Cookie", management)).status).toBe(200);
    for (const path of ["/payments", "/orders", `/orders/${order.order.po}`, "/supplier-ledger", `/suppliers/${guangzhou}/ledger`, "/reports/orders", "/deposits", "/orders/options"]) {
      expect((await get(path)).status, path).toBe(200);
    }
    expect(await postingsOf(eq(entries.supplierId, guangzhou))).toHaveLength(2);
  });
});

describe("order postings (ORD-3, ORD-5, ORD-6)", () => {
  it("ORD-3 debits once; ORD-5 posts one adjustment per value change and nothing for the same lines or other edits", async () => {
    const order = await place(1000, { depositRequiredCny: 100 });
    const ofOrder = () => postingsOf(eq(entries.orderId, order.order.id));
    expect(await ofOrder()).toMatchObject([{ entryType: "order_debit", amount: -1000, poNumber: order.order.po }]);
    const up = await editLines(order.order.po, order.order.id, 1200);
    expect(up.body.ledger).toEqual({ supplierId: guangzhou, currency: "CNY", changeCny: -200, balanceBefore: -1000, balanceAfter: -1200 });
    const down = await editLines(order.order.po, order.order.id, 900);
    expect(down.body.ledger).toMatchObject({ changeCny: 300, balanceAfter: -900 });
    const same = await editLines(order.order.po, order.order.id, 900);
    expect(same.body.ledger).toMatchObject({ changeCny: 0, balanceBefore: -900, balanceAfter: -900 });
    const patch = (body: object) => http.patch(`/orders/${order.order.po}`, body).set("Cookie", management);
    for (const body of [{ deliveryDate: indiaDay(45) }, { orderDate: indiaDay(-11) }, { terms: "FOB" }, { depositRequiredCny: 300 }]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(res.body.ledger, JSON.stringify(body)).toBeUndefined();
    }
    const renamed = await patch({ po: "LEDGER-RENAMED" });
    expect(renamed.body.order.po).toBe("LEDGER-RENAMED");
    expect((await ofOrder()).map((row) => [row.entryType, row.amount])).toEqual([
      ["order_debit", -1000],
      ["order_adjustment", -200],
      ["order_adjustment", 300],
    ]);
    expect(await balance()).toBe(-900);
  });

  it("lowering the lines below what was paid is allowed now: the balance turns positive and the order is paid", async () => {
    const order = await place(1000);
    await pay(supplierPayment({ amount: 800 }));
    const res = await editLines(order.order.po, order.order.id, 500);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ledger).toMatchObject({ changeCny: 500, balanceBefore: -200, balanceAfter: 300 });
    expect((await get(`/orders/${order.order.po}`)).body).toMatchObject({ settledCny: 500, outstandingCny: 0, paymentStatus: "paid" });
  });

  it("ORD-6 posts the cancel (balance back), keeps the postings by PO; refused with payments (voided too) or receipts", async () => {
    const order = await place(1000);
    expect((await http.delete(`/orders/${order.order.po}`).set("Cookie", management)).status).toBe(204);
    expect(await balance()).toBe(0);
    const kept = await postingsOf(eq(entries.poNumber, order.order.po));
    expect(kept.map((row) => [row.entryType, row.amount, row.orderId])).toEqual([
      ["order_debit", -1000, null],
      ["order_cancel", 1000, null],
    ]);
    const statement = (await get(`/suppliers/${guangzhou}/ledger`)).body.entries;
    expect(statement.map((row: { entryType: string; po: string }) => [row.entryType, row.po])).toEqual([
      ["order_cancel", order.order.po],
      ["order_debit", order.order.po],
    ]);

    const withPayment = await place(100);
    const agent = (await pay(agentPayment(withPayment.order.id))).body.payment;
    await voidIt(agent.id);
    const refused = await http.delete(`/orders/${withPayment.order.po}`).set("Cookie", management);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "in_use", message: "This order has 1 payment, so it can't be deleted." });
    const received = await place(100);
    const [line] = await lines(received.order.id);
    await receive(ctx, received.order.id, [{ orderLineId: line!.id, quantity: 10 }]);
    expect((await http.delete(`/orders/${received.order.po}`).set("Cookie", management)).body.error.code).toBe("in_use");
    expect(await postingsOf(eq(entries.entryType, "order_cancel"))).toHaveLength(1);
  });
});

describe("the FIFO projection on the screens", () => {
  it("ORD-1, ORD-4 and RPT-O2 settle oldest first; the supplier balance may be negative, an order's outstanding never is", async () => {
    const older = await place(1000);
    const newer = await place(500);
    await ctx.db.update(orders).set({ orderDate: indiaDay(-5) }).where(eq(orders.id, newer.order.id));
    await pay(supplierPayment({ amount: 1200 }));
    const ord1 = (await get("/orders")).body as { po: string }[];
    expect(ord1.find((row) => row.po === older.order.po)).toMatchObject({ settledCny: 1000, outstandingCny: 0, paymentStatus: "paid", settledInr: 12000, paidInr: 12000 });
    expect(ord1.find((row) => row.po === newer.order.po)).toMatchObject({ settledCny: 200, outstandingCny: 300, paymentStatus: "partly" });
    expect((await get(`/orders/${newer.order.po}`)).body).toMatchObject({ settledCny: 200, outstandingCny: 300, paymentStatus: "partly", supplierAccount: { balanceCny: -300 } });
    const status = async (paymentStatus: string) => ((await get(`/reports/orders?paymentStatus=${paymentStatus}`)).body.rows as { po: string }[]).map((row) => row.po);
    expect(await status("paid")).toEqual([older.order.po]);
    expect(await status("partly")).toEqual([newer.order.po]);
    expect(await status("unpaid")).toEqual([]);
    const report = (await get("/reports/orders")).body;
    expect(report.summary.byCurrency).toEqual([{ currency: "CNY", orderValueCny: 1500, settledCny: 1200, outstandingCny: 300 }]);
    expect(await balance()).toBe(-300);
    await pay(supplierPayment({ amount: 800 }));
    expect(await balance()).toBe(500);
    const after = (await get("/orders")).body as { po: string; outstandingCny: number }[];
    expect(after.map((row) => row.outstandingCny)).toEqual([0, 0]);
  });

  it("D11: the Deposit Required milestone is none, unmet, partly, then met (exactly and beyond) on ORD-4, ORD-1 and DEP-1", async () => {
    const order = await place(1000, { depositRequiredCny: 500 });
    const plain = await place(100);
    const milestone = async () => {
      const detail = (await get(`/orders/${order.order.po}`)).body;
      const row = ((await get("/orders")).body as { po: string }[]).find((entry) => entry.po === order.order.po)!;
      const dep = ((await get("/deposits")).body.milestones as { po: string }[]).find((entry) => entry.po === order.order.po)!;
      const pick = (from: object) => {
        const { depositRequiredCny, depositSettledCny, depositPendingCny, depositStatus } = from as Record<string, unknown>;
        return { depositRequiredCny, depositSettledCny, depositPendingCny, depositStatus };
      };
      expect(pick(row)).toEqual(pick(detail));
      expect(pick(dep)).toEqual(pick(detail));
      return pick(detail);
    };
    expect((await get(`/orders/${plain.order.po}`)).body).toMatchObject({ depositRequiredCny: null, depositStatus: "none" });
    expect(await milestone()).toEqual({ depositRequiredCny: 500, depositSettledCny: 0, depositPendingCny: 500, depositStatus: "unmet" });
    await pay(supplierPayment({ amount: 200 }));
    expect(await milestone()).toMatchObject({ depositSettledCny: 200, depositPendingCny: 300, depositStatus: "partly" });
    await pay(supplierPayment({ amount: 300 }));
    expect(await milestone()).toMatchObject({ depositSettledCny: 500, depositPendingCny: 0, depositStatus: "met" });
    await pay(supplierPayment({ amount: 100 }));
    expect(await milestone()).toMatchObject({ depositSettledCny: 600, depositPendingCny: 0, depositStatus: "met" });
    expect(((await get("/deposits")).body.milestones as { po: string }[]).map((row) => row.po)).toEqual([order.order.po]);
  });
});

describe("agent payments and landed cost", () => {
  it("goods INR are the settling credits at their own rates (the old figure for a paid order); sea freight is the non-void agent payments", async () => {
    const data = await buildLifecycle(ctx);
    type Cost = Record<string, unknown> & { orderId: string; goodsPayments: { amount: number; amountInr: number }[] };
    const cost = async () => ((await get("/landed-cost")).body.orders as Cost[]).find((row) => row.orderId === data.a.id)!;
    const before = await cost();
    // A: ¥2,000 at 12 and ¥1,000 at 13, as before the ledger; the agent's ¥100 at 12 is the FOB sea freight.
    expect(before).toMatchObject({ goodsInr: 37_000, seaFreightInr: 1_200, totalInr: 40_450, final: true, waitingFor: null });
    expect(before.goodsPayments.map((slice) => [slice.amount, slice.amountInr])).toEqual([
      [2000, 24_000],
      [1000, 13_000],
    ]);
    const [agent] = await ctx.db.select().from(payments).where(and(eq(payments.orderId, data.a.id), eq(payments.payeeRole, "agent")));
    expect(await postingsOf(eq(entries.paymentId, agent!.id))).toHaveLength(0);
    expect((await voidIt(agent!.id)).status).toBe(200);
    expect(await cost()).toMatchObject({ goodsInr: 37_000, seaFreightInr: 0, totalInr: 39_250 });
    // C is still owed ¥3,000: its estimate waits for the supplier payment.
    const c = ((await get("/landed-cost")).body.orders as { orderId: string }[]).find((row) => row.orderId === data.c.id);
    expect(c).toMatchObject({ goodsInr: 12_000, waitingFor: "supplier payment" });
  });
});

describe("retired routes and the archive", () => {
  it("ADV-2/3/4 and SD-2..5 are 410 gone; ADV-1 still lists the legacy entries", async () => {
    const order = await place(100);
    const goneAdvance = "Supplier advances are recorded as supplier payments in the supplier ledger now.";
    const goneDeposit = "Supplier deposits are a read-only archive now.";
    type Res = { status: number; body: { error: { code: string; message: string } } };
    const cases: [() => PromiseLike<Res>, string][] = [
      [() => http.post(`/suppliers/${guangzhou}/advances`, { amount: 1 }).set("Cookie", management), goneAdvance],
      [() => http.delete(`/supplier-advances/${randomUUID()}`).set("Cookie", management), goneAdvance],
      [() => http.post(`/orders/${order.order.po}/advance`).set("Cookie", management), goneAdvance],
      [() => http.post(`/suppliers/${guangzhou}/deposits`, { amount: 1 }).set("Cookie", management), goneDeposit],
      [() => http.post(`/supplier-deposits/${randomUUID()}/transactions`, {}).set("Cookie", management), goneDeposit],
      [() => http.delete(`/supplier-deposit-transactions/${randomUUID()}`).set("Cookie", management), goneDeposit],
      [() => http.delete(`/supplier-deposits/${randomUUID()}`).set("Cookie", management), goneDeposit],
    ];
    for (const [request, message] of cases) {
      const res = await request();
      expect(res.status).toBe(410);
      expect(res.body.error).toEqual({ code: "gone", message });
    }
    await ctx.db.insert(supplierAdvanceEntries).values({ supplierId: guangzhou, kind: "receipt", amount: 5000, currency: "CNY", exchangeRate: 12, entryDate: indiaDay(-40), mode: "Bank", reference: "ADV" });
    const archive = (await get(`/suppliers/${guangzhou}/advances`)).body;
    expect(archive).toMatchObject({
      supplier: { id: guangzhou, name: "Guangzhou Textile Co.", currency: "CNY" },
      entries: [{ kind: "receipt", amount: 5000, currency: "CNY", exchangeRate: 12, amountInr: 60_000, po: null, mode: "Bank", reference: "ADV", recordedBy: "" }],
    });
    expect(Object.keys(archive)).toEqual(["supplier", "entries"]);
  });
});

describe("history is kept (foreign keys, USR-5)", () => {
  it("an order with a payment can't be deleted at the database level; a user who posted or voided can't be removed", async () => {
    const order = await place(100);
    await pay(agentPayment(order.order.id));
    await expect(ctx.db.delete(orders).where(eq(orders.id, order.order.id))).rejects.toThrow();

    const created = await http.post("/users", { name: "Ledger Clerk", email: "ledger.clerk@mrgarments.com", role: "Accounts", password: "Welcome2026x" }).set("Cookie", management);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const clerk = created.body.user.id as string;
    await ctx.db.insert(entries).values({
      supplierId: guangzhou,
      currency: "CNY",
      entryType: "adjustment",
      amount: 5,
      exchangeRate: 12,
      entryDate: indiaDay(),
      origin: "app",
      notes: "test",
      balanceBefore: 0,
      balanceAfter: 5,
      idempotencyKey: `adjustment:${randomUUID()}`,
      createdBy: clerk,
    });
    const refused = await http.delete(`/users/${clerk}`).set("Cookie", management);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe("Ledger Clerk has recorded 1 supplier ledger posting, so they can't be removed. Deactivate them instead.");

    const voider = await http.post("/users", { name: "Void Clerk", email: "void.clerk@mrgarments.com", role: "Accounts", password: "Welcome2026x" }).set("Cookie", management);
    const voiderId = voider.body.user.id as string;
    const paid = (await pay(supplierPayment({ amount: 10 }))).body.payment;
    await ctx.db.update(payments).set({ voidedAt: new Date(), voidedBy: voiderId, voidReason: "test" }).where(eq(payments.id, paid.id));
    const blocked = await http.delete(`/users/${voiderId}`).set("Cookie", management);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toBe("Void Clerk has recorded 1 payment, so they can't be removed. Deactivate them instead.");
    expect(await ctx.db.select().from(users).where(eq(users.id, voiderId))).toHaveLength(1);
  });

  it("a supplier with only an orderless payment (its ledger entry and the payment) is not deleted", async () => {
    expect((await pay(supplierPayment({ supplierId: hangzhou, amount: 10 }))).status).toBe(201);
    const res = await http.delete(`/suppliers/${hangzhou}`).set("Cookie", management);
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: "in_use", message: "This supplier is used by 1 ledger posting and 1 payment, so it can't be deleted. Deactivate it instead." });
  });
});
