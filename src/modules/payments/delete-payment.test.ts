import { randomUUID } from "node:crypto";

import { count, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, notifications, orders, payments, shippingAgents, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { loadLandedCosts } from "../costs/landed-cost";
import { UNKNOWN } from "../stages/fixtures";
import { idOf, indiaDay, makeOrder } from "../stock/fixtures";

// PAY-3 DELETE /payments/:id voids the payment (docs/unified-ledger.md): the row stays, flagged, with who and why; a
// posted payment gets its reversing posting; every figure leaves it out, each remaining payment at its own rate; the
// order, its other payments and the notifications stay.

const ctx = createTestContext();
const http = api(ctx);
let suresh = "";
let sino = "";
let guangzhou = "";
beforeEach(async () => {
  await resetData(ctx);
  suresh = await signInAs(ctx, SEEDED.management);
  sino = await idOf(ctx, shippingAgents, "Sino Freight");
  guangzhou = await idOf(ctx, suppliers, "Guangzhou Textile Co.");
});
afterAll(() => ctx.pool.end());

const voidIt = (id: string, cookie = suresh, reason = "Entered by mistake") => http.delete(`/payments/${id}`, { reason }).set("Cookie", cookie);
const get = async <T>(path: string) => {
  const res = await http.get(path).set("Cookie", suresh);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as T;
};
type Detail = { settledCny: number; settledInr: number; outstandingCny: number; agentPaidInr: number; paidInr: number; currency: string; payments: { id: string; voided: boolean }[] };
const detail = (po: string) => get<Detail>(`/orders/${po}`);
type SupplierRow = { supplier: string; currency: string; settledCny: number; outstandingCny: number; creditsCny: number; balanceCny: number };
const supplierRow = async (supplier: string, currency = "CNY") =>
  (await get<{ suppliers: SupplierRow[] }>("/reports/payments-per-supplier")).suppliers.find((row) => row.supplier === supplier && row.currency === currency)!;
const voidedAt = async (id: string) => (await ctx.db.select({ at: payments.voidedAt }).from(payments).where(eq(payments.id, id)))[0]?.at;
const notes = async () => (await ctx.db.select({ n: count() }).from(notifications))[0]!.n;

/** PAY-2 as Management: a supplier payment (against the supplier) or, with an order, a shipping agent's. */
async function pay(amount: number, rateInr: number, agentOrderId?: string, supplierId = guangzhou) {
  const common = { paidOn: indiaDay(-3), rateInr, mode: "Bank transfer", clientRequestId: randomUUID() };
  const body = agentOrderId ? { ...common, orderId: agentOrderId, payeeRole: "agent", agentId: sino, kind: "Balance", amountCny: amount } : { ...common, supplierId, amount };
  const res = await http.post("/payments", body).set("Cookie", suresh);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.payment.id as string;
}
/** An order of 100 Denim jeans at ¥10 (¥1,000), stage 1, posted to the ledger. */
const order = () => makeOrder(ctx, { lines: [{ item: "Denim jeans", quantity: 100, rateCny: 10 }] });

describe("PAY-3 DELETE /payments/:id (void)", () => {
  it("is 401 signed out and 403 below payments Full (Accounts records payments), and changes nothing", async () => {
    const o = await order();
    const id = await pay(300, 12);
    expect((await http.delete(`/payments/${id}`, { reason: "x" })).status).toBe(401);
    for (const email of [SEEDED.accounts, SEEDED.procurement, SEEDED.chinaStaffTwoStages, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      expect((await voidIt(id, await signInAs(ctx, email))).status, email).toBe(403);
    }
    expect(await voidedAt(id)).toBeNull();
    expect((await detail(o.po)).settledCny).toBe(300);
  });

  it("voids a supplier payment: the row stays flagged; settled, INR, outstanding, supplier, cost and REC-2 figures follow", async () => {
    const o = await order();
    const first = await pay(300, 12);
    const second = await pay(200, 12.5);
    const freight = await pay(50, 12, o.id);
    // The ¥50 agent payment is sea freight: never the supplier's money.
    expect(await detail(o.po)).toMatchObject({ settledCny: 500, settledInr: 6100, outstandingCny: 500, agentPaidInr: 600, paidInr: 6700 });
    expect(await supplierRow("Guangzhou Textile Co.")).toMatchObject({ settledCny: 500, outstandingCny: 500, creditsCny: 500, balanceCny: -500 });
    expect(await loadLandedCosts(ctx.db, [o.id]).then((m) => m.get(o.id))).toMatchObject({ goodsInr: 6100, seaFreightInr: 600 });
    const outstanding = async () => (await get<{ orders: { po: string; outstandingCny: number }[] }>("/receipts/options")).orders.find((row) => row.po === o.po)!.outstandingCny;
    expect(await outstanding()).toBe(500);
    const notesBefore = await notes();

    const res = await voidIt(first);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ payment: { id: first, voided: true, voidReason: "Entered by mistake", voidedBy: "Suresh Menon" }, ledger: { balanceBefore: -500, balanceAfter: -800 } });
    expect(await voidedAt(first)).toBeInstanceOf(Date);
    expect((await ctx.db.select().from(orders).where(eq(orders.id, o.id))).length).toBe(1);
    // ¥200 at 12.5 is all that settles the order now; the voided payment is still listed (it was never order-linked).
    const after = await detail(o.po);
    expect(after).toMatchObject({ settledCny: 200, settledInr: 2500, outstandingCny: 800, agentPaidInr: 600, paidInr: 3100 });
    expect(after.payments.map((p) => p.id)).toEqual([freight]);
    expect((await get<{ payments: { id: string; voided: boolean }[] }>("/payments")).payments.filter((p) => p.voided).map((p) => p.id)).toEqual([first]);
    expect(await supplierRow("Guangzhou Textile Co.")).toMatchObject({ settledCny: 200, outstandingCny: 800, creditsCny: 200, balanceCny: -800 });
    expect(await loadLandedCosts(ctx.db, [o.id]).then((m) => m.get(o.id))).toMatchObject({ goodsInr: 2500, seaFreightInr: 600 });
    expect(await outstanding()).toBe(800);
    expect(await voidedAt(second)).toBeNull();
    // The payment-recorded notifications are history: they stay.
    expect(await notes()).toBe(notesBefore);
  });

  it("voids an agent payment: sea freight follows; the supplier's settled and outstanding don't move", async () => {
    const o = await order();
    await pay(400, 12);
    const freight = await pay(80, 12, o.id);
    const supplierBefore = await supplierRow("Guangzhou Textile Co.");
    const res = await voidIt(freight);
    expect(res.body.ledger).toBeNull();
    expect(await detail(o.po)).toMatchObject({ settledCny: 400, settledInr: 4800, agentPaidInr: 0, paidInr: 4800, outstandingCny: 600 });
    expect(await loadLandedCosts(ctx.db, [o.id]).then((m) => m.get(o.id))).toMatchObject({ goodsInr: 4800, seaFreightInr: 0 });
    expect(await supplierRow("Guangzhou Textile Co.")).toEqual(supplierBefore);
  });

  it("keeps the currency and each remaining payment at its own rate (USD supplier)", async () => {
    const shenzhen = await idOf(ctx, suppliers, "Shenzhen Apparel");
    await ctx.db.update(suppliers).set({ currency: "USD", exchangeRate: 83.5 }).where(eq(suppliers.id, shenzhen));
    const jeans = await idOf(ctx, items, "Denim jeans");
    const created = await http
      .post("/orders", { supplierId: shenzhen, orderDate: indiaDay(-5), deliveryDate: indiaDay(20), lines: [{ itemId: jeans, quantity: 100, rateCny: 10 }] })
      .set("Cookie", suresh);
    const po = created.body.order.po as string;
    const first = await pay(100, 83.5, undefined, shenzhen);
    await pay(50, 84.25, undefined, shenzhen);
    expect(await detail(po)).toMatchObject({ currency: "USD", settledCny: 150, settledInr: 12562.5 });
    expect((await voidIt(first)).body.ledger).toMatchObject({ currency: "USD", balanceBefore: -850, balanceAfter: -950 });
    expect(await detail(po)).toMatchObject({ currency: "USD", settledCny: 50, settledInr: 4212.5, outstandingCny: 950 });
  });

  it("voids a due payment: nothing paid changes; the next due date and the 30-day due total move", async () => {
    const o = await order();
    await pay(100, 12);
    const [soon, later] = await Promise.all(
      [
        { amountCny: 300, dueDate: indiaDay(10) },
        { amountCny: 200, dueDate: indiaDay(20) },
      ].map(async (due) =>
        (
          await ctx.db
            .insert(payments)
            .values({ orderId: o.id, kind: "Balance", payee: "Guangzhou Textile Co.", payeeRole: "supplier", status: "due", ...due })
            .returning({ id: payments.id })
        )[0]!.id,
      ),
    );
    const nextDue = async () => (await get<{ orders: { po: string; nextDue: string | null }[] }>("/payments")).orders.find((row) => row.po === o.po)!.nextDue;
    const due30 = async () => (await get<{ dueNext30Cny: number }>("/reports/payments-per-supplier")).dueNext30Cny;
    expect(await nextDue()).toBe(indiaDay(10));
    expect(await due30()).toBe(500);

    expect((await voidIt(soon!)).body.ledger).toBeNull();
    expect(await nextDue()).toBe(indiaDay(20));
    expect(await due30()).toBe(200);
    expect(await detail(o.po)).toMatchObject({ settledCny: 100, settledInr: 1200 });
    expect(await voidedAt(later!)).toBeNull();
  });

  it("is 404 for an unknown or malformed payment; of two voids at once, one succeeds and the other is 409", async () => {
    expect((await voidIt(UNKNOWN)).body.error).toEqual({ code: "not_found", message: "Payment not found." });
    expect((await voidIt("not-a-payment")).status).toBe(404);
    const o = await order();
    const id = await pay(300, 12);
    const results = await Promise.all([voidIt(id), voidIt(id)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(results.find((res) => res.status === 409)!.body.error.code).toBe("already_voided");
    expect((await voidIt(id)).status).toBe(409);
    expect((await detail(o.po)).settledCny).toBe(0);
  });

  it("an order keeps refusing deletion while it has a payment, voided or not (the payment is history)", async () => {
    const o = await order();
    const id = await pay(30, 12, o.id);
    const refused = { code: "in_use", message: "This order has 1 payment, so it can't be deleted." };
    expect((await http.delete(`/orders/${o.po}`).set("Cookie", suresh)).body.error).toEqual(refused);
    expect((await voidIt(id)).status).toBe(200);
    expect((await http.delete(`/orders/${o.po}`).set("Cookie", suresh)).body.error).toEqual(refused);
    expect((await ctx.db.select().from(orders).where(eq(orders.id, o.id))).length).toBe(1);
  });
});
