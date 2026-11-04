import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { notifications, orders, payments, shippingAgents } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { loadLandedCosts } from "../costs/landed-cost";
import { UNKNOWN } from "../stages/fixtures";
import { idOf, indiaDay, makeOrder } from "../stock/fixtures";

// PAY-3 DELETE /payments/:id: only the payment row goes; every figure built from payments follows, each remaining
// payment at its own rate; the order, its other payments and the notifications stay.

const ctx = createTestContext();
const http = api(ctx);
let suresh = "";
let sino = "";
beforeAll(async () => {
  await resetData(ctx);
  suresh = await signInAs(ctx, SEEDED.management);
  sino = await idOf(ctx, shippingAgents, "Sino Freight");
});
afterAll(() => ctx.pool.end());

const del = (path: string, cookie = suresh) => http.delete(path).set("Cookie", cookie);
const get = async <T>(path: string) => {
  const res = await http.get(path).set("Cookie", suresh);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as T;
};
type Detail = { paidCny: number; paidInr: number; balanceCny: number; currency: string; payments: { id: string }[] };
const detail = (po: string) => get<Detail>(`/orders/${po}`);
type SupplierRow = { supplier: string; currency: string; paidCny: number; balanceCny: number };
const supplierRow = async (supplier: string, currency = "CNY") =>
  (await get<{ suppliers: SupplierRow[] }>("/reports/payments-per-supplier")).suppliers.find((row) => row.supplier === supplier && row.currency === currency)!;
const exists = async (id: string) => (await ctx.db.select({ id: payments.id }).from(payments).where(eq(payments.id, id))).length === 1;
const notes = async () => (await ctx.db.select({ n: count() }).from(notifications))[0]!.n;

/** PAY-2 as Management: a payment already made, to the supplier unless an agent is given. */
async function pay(orderId: string, kind: "Deposit" | "Balance", amountCny: number, rateInr: number, agentId: string | null = null) {
  const res = await http
    .post("/payments", { orderId, kind, payeeRole: agentId ? "agent" : "supplier", agentId, amountCny, paidOn: indiaDay(-3), rateInr, mode: "Bank transfer" })
    .set("Cookie", suresh);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.payment.id as string;
}
/** An order of 100 Denim jeans at ¥10 (¥1,000), stage 1. */
const order = () => makeOrder(ctx, { lines: [{ item: "Denim jeans", quantity: 100, rateCny: 10 }] });

describe("PAY-3 DELETE /payments/:id", () => {
  it("is 401 signed out and 403 below payments Full (Accounts records payments), and changes nothing", async () => {
    const o = await order();
    const id = await pay(o.id, "Deposit", 300, 12);
    expect((await http.delete(`/payments/${id}`)).status).toBe(401);
    for (const email of [SEEDED.accounts, SEEDED.procurement, SEEDED.chinaStaffTwoStages, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      expect((await del(`/payments/${id}`, await signInAs(ctx, email))).status, email).toBe(403);
    }
    expect(await exists(id)).toBe(true);
    expect((await detail(o.po)).paidCny).toBe(300);
  });

  it("deletes a paid deposit: the order and its other payments stay; paid, INR, balance, supplier and cost figures follow", async () => {
    const o = await order();
    const deposit = await pay(o.id, "Deposit", 300, 12);
    const balance = await pay(o.id, "Balance", 200, 12.5);
    const freight = await pay(o.id, "Balance", 50, 12, sino);
    expect(await detail(o.po)).toMatchObject({ paidCny: 550, paidInr: 6700, balanceCny: 450 });
    const supplierBefore = await supplierRow("Guangzhou Textile Co.");
    expect(await loadLandedCosts(ctx.db, [o.id]).then((m) => m.get(o.id))).toMatchObject({ goodsInr: 6100, seaFreightInr: 600 });
    const options = async () =>
      (await get<{ orders: { po: string; depositsPaidCny: number }[] }>("/receipts/options")).orders.find((row) => row.po === o.po)!.depositsPaidCny;
    expect(await options()).toBe(300);
    const notesBefore = await notes();

    expect((await del(`/payments/${deposit}`)).status).toBe(204);
    expect(await exists(deposit)).toBe(false);
    expect([await exists(balance), await exists(freight)]).toEqual([true, true]);
    expect((await ctx.db.select().from(orders).where(eq(orders.id, o.id))).length).toBe(1);
    // 200 at 12.5 and 50 at 12 remain, each at its own rate.
    const after = await detail(o.po);
    expect(after).toMatchObject({ paidCny: 250, paidInr: 3100, balanceCny: 750 });
    expect(after.payments.map((p) => p.id).sort()).toEqual([balance, freight].sort());
    const supplierAfter = await supplierRow("Guangzhou Textile Co.");
    expect(supplierAfter.paidCny).toBeCloseTo(supplierBefore.paidCny - 300, 2);
    expect(supplierAfter.balanceCny).toBeCloseTo(supplierBefore.balanceCny + 300, 2);
    expect(await loadLandedCosts(ctx.db, [o.id]).then((m) => m.get(o.id))).toMatchObject({ goodsInr: 2500, seaFreightInr: 600 });
    expect(await options()).toBe(0);
    // The payment-recorded notifications are history: they stay.
    expect(await notes()).toBe(notesBefore);
  });

  it("deletes an agent payment: sea freight follows; the supplier's paid and outstanding don't move", async () => {
    const o = await order();
    await pay(o.id, "Deposit", 400, 12);
    const freight = await pay(o.id, "Balance", 80, 12, sino);
    const supplierBefore = await supplierRow("Guangzhou Textile Co.");
    expect((await del(`/payments/${freight}`)).status).toBe(204);
    expect(await detail(o.po)).toMatchObject({ paidCny: 400, paidInr: 4800, balanceCny: 600 });
    expect(await loadLandedCosts(ctx.db, [o.id]).then((m) => m.get(o.id))).toMatchObject({ goodsInr: 4800, seaFreightInr: 0 });
    expect(await supplierRow("Guangzhou Textile Co.")).toEqual(supplierBefore);
  });

  it("keeps the order's currency and each remaining payment at its own rate (USD order)", async () => {
    const o = await order();
    await ctx.db.update(orders).set({ currency: "USD" }).where(eq(orders.id, o.id));
    const first = await pay(o.id, "Deposit", 100, 83.5);
    await pay(o.id, "Balance", 50, 84.25);
    expect(await detail(o.po)).toMatchObject({ currency: "USD", paidCny: 150, paidInr: 12562.5 });
    expect((await del(`/payments/${first}`)).status).toBe(204);
    expect(await detail(o.po)).toMatchObject({ currency: "USD", paidCny: 50, paidInr: 4212.5, balanceCny: 950 });
  });

  it("deletes a due payment: nothing paid changes; the next due date and the 30-day due total move", async () => {
    const o = await order();
    await pay(o.id, "Deposit", 100, 12);
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
    const dueBefore = await due30();

    expect((await del(`/payments/${soon}`)).status).toBe(204);
    expect(await nextDue()).toBe(indiaDay(20));
    expect(await due30()).toBeCloseTo(dueBefore - 300, 2);
    expect(await detail(o.po)).toMatchObject({ paidCny: 100, paidInr: 1200 });
    expect(await exists(later!)).toBe(true);
  });

  it("is 404 for an unknown, malformed or deleted payment; of two deletes at once, one succeeds", async () => {
    expect((await del(`/payments/${UNKNOWN}`)).body.error).toEqual({ code: "not_found", message: "Payment not found." });
    expect((await del("/payments/not-a-payment")).status).toBe(404);
    const o = await order();
    const id = await pay(o.id, "Deposit", 300, 12);
    const statuses = (await Promise.all([del(`/payments/${id}`), del(`/payments/${id}`)])).map((res) => res.status);
    expect(statuses.sort()).toEqual([204, 404]);
    expect((await del(`/payments/${id}`)).status).toBe(404);
    expect((await detail(o.po)).paidCny).toBe(0);
  });

  it("lets the order be deleted once its payments are gone; racing the order's delete never orphans anything", async () => {
    const o = await order();
    const id = await pay(o.id, "Deposit", 300, 12);
    expect((await del(`/orders/${o.po}`)).body.error).toEqual({ code: "in_use", message: "This order has 1 payment, so it can't be deleted." });
    expect((await del(`/payments/${id}`)).status).toBe(204);
    expect((await del(`/orders/${o.po}`)).status).toBe(204);

    const raced = await order();
    const racedPayment = await pay(raced.id, "Deposit", 300, 12);
    const [paymentRes, orderRes] = await Promise.all([del(`/payments/${racedPayment}`), del(`/orders/${raced.po}`)]);
    // Either the payment went first (then the order) or the order was refused while it still had it.
    expect(["204/204", "204/409"]).toContain(`${paymentRes.status}/${orderRes.status}`);
    expect(await exists(racedPayment)).toBe(false);
    const orderLeft = (await ctx.db.select().from(orders).where(eq(orders.id, raced.id))).length;
    expect(orderLeft).toBe(orderRes.status === 204 ? 0 : 1);
  });
});
