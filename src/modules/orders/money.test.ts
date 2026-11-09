import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { items, orders, shippingAgents, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { makeOrder } from "../stock/fixtures";
import { depositState } from "./money";
import { MESSAGES as M } from "./orders.routes";

// docs/phase2-fixes.md sections 1 and 2: one money calculation for every screen, and the deposit the supplier asked for.

const ctx = createTestContext();
const http = api(ctx);
let suresh = "";
let priya = "";
let ids: { supplier: string; jeans: string; sino: string };
beforeAll(async () => {
  await resetData(ctx);
  suresh = await signInAs(ctx, SEEDED.management);
  priya = await signInAs(ctx, SEEDED.procurement);
  ids = {
    supplier: (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, "Guangzhou Textile Co.")))[0]!.id,
    jeans: (await ctx.db.select({ id: items.id }).from(items).where(eq(items.name, "Denim jeans")))[0]!.id,
    sino: (await ctx.db.select({ id: shippingAgents.id }).from(shippingAgents).where(eq(shippingAgents.name, "Sino Freight")))[0]!.id,
  };
});
afterAll(() => ctx.pool.end());

const get = (path: string, cookie = suresh) => http.get(path).set("Cookie", cookie);
const post = (path: string, body: object, cookie = suresh) => http.post(path, body).set("Cookie", cookie);
const patch = (path: string, body: object, cookie = suresh) => http.patch(path, body).set("Cookie", cookie);
/** ORD-3: 100 Denim jeans at ¥10 (¥1,000) with the given extras. */
const orderBody = (extra: object = {}) => ({
  supplierId: ids.supplier,
  orderDate: "2026-10-20",
  deliveryDate: "2026-11-30",
  lines: [{ itemId: ids.jeans, quantity: 100, rateCny: 10 }],
  deposits: [],
  ...extra,
});
const place = async (extra: object = {}) => {
  const res = await post("/orders", orderBody(extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.order as { id: string; po: string };
};
const pay = (orderId: string, kind: "Deposit" | "Balance", amountCny: number, rateInr: number, agentId: string | null = null) =>
  post("/payments", { orderId, kind, payeeRole: agentId ? "agent" : "supplier", agentId, amountCny, paidOn: "2026-10-25", rateInr, mode: "Bank transfer" });
type Figures = Record<string, unknown>;
const ord1 = async (po: string) => ((await get("/orders")).body as (Figures & { po: string })[]).find((row) => row.po === po)!;
const ord4 = async (po: string) => (await get(`/orders/${po}`)).body as Figures & { payments: Figures[] };
const pay1 = async (po: string) => ((await get("/payments")).body.orders as (Figures & { po: string })[]).find((row) => row.po === po)!;

describe("depositState", () => {
  it("is none without a requirement, due with nothing paid, partly, then paid; an overpayment never goes negative", () => {
    expect(depositState(null, 300)).toEqual({ depositRequiredCny: null, depositPaidCny: 300, depositPendingCny: null, depositStatus: "none" });
    expect(depositState(1000, 0)).toEqual({ depositRequiredCny: 1000, depositPaidCny: 0, depositPendingCny: 1000, depositStatus: "due" });
    expect(depositState(1000, 300.5)).toEqual({ depositRequiredCny: 1000, depositPaidCny: 300.5, depositPendingCny: 699.5, depositStatus: "partly" });
    expect(depositState(1000, 1000)).toEqual({ depositRequiredCny: 1000, depositPaidCny: 1000, depositPendingCny: 0, depositStatus: "paid" });
    expect(depositState(1000, 1200)).toMatchObject({ depositPendingCny: 0, depositStatus: "paid" });
    // To the paisa: 0.1 + 0.2 style drift is rounded away.
    expect(depositState(0.3, 0.1)).toMatchObject({ depositPendingCny: 0.2, depositStatus: "partly" });
  });
});

describe("one supplier balance on every screen", () => {
  it("ORD-1, ORD-4, PAY-1, the order report, the order reports, Payments per supplier and REC-2 agree, with agent payments apart", async () => {
    // ¥1,000 order, ¥1,000 deposit asked for: ¥300 supplier deposit at 12, ¥100 agent deposit at 12, ¥200 supplier balance at 12.5.
    const order = await place({
      depositRequiredCny: 1000,
      deposits: [
        { payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 300, paidOn: "2026-10-21", rateInr: 12, mode: "Bank transfer" },
        { payee: "Sino Freight", payeeRole: "agent", amountCny: 100, paidOn: "2026-10-22", rateInr: 12, mode: "Cash" },
      ],
    });
    expect((await pay(order.id, "Balance", 200, 12.5)).status).toBe(201);

    const supplier = { supplierPaidCny: 500, supplierPaidInr: 6100, depositRequiredCny: 1000, depositPaidCny: 300, depositPendingCny: 700, depositStatus: "partly" };
    const everyPayee = { paidCny: 600, paidInr: 7300 };
    expect(await ord1(order.po)).toMatchObject({ ...supplier, ...everyPayee, orderValueCny: 1000 });
    const detail = await ord4(order.po);
    expect(detail).toMatchObject({ ...supplier, ...everyPayee, balanceCny: 500 });
    // Each payment's INR comes from SQL, rounded like the totals.
    expect(detail.payments.map((p) => [p.kind, p.payeeRole, p.amountInr])).toEqual([
      ["Deposit", "supplier", 3600],
      ["Deposit", "agent", 1200],
      ["Balance", "supplier", 2500],
    ]);
    expect(await pay1(order.po)).toMatchObject({ ...supplier, ...everyPayee, balanceCny: 500 });

    const report = (await get(`/orders/${order.po}/report`)).body;
    expect(report.payments).toMatchObject({ paidCny: 500, paidInr: 6100, balanceCny: 500, depositsPaidCny: 300, depositRequiredCny: 1000, depositPendingCny: 700, depositStatus: "partly" });
    const reports = (await get("/reports/orders")).body.rows.find((row: { po: string }) => row.po === order.po);
    expect(reports).toMatchObject({ paidCny: 500, paidInr: 6100, balanceCny: 500, paymentStatus: "partly" });
    const perSupplier = (await get("/reports/payments-per-supplier")).body.suppliers.find((row: { supplier: string }) => row.supplier === "Guangzhou Textile Co.");
    expect(perSupplier).toMatchObject({ orders: [order.po], orderValueCny: 1000, paidCny: 500, paidInr: 6100, balanceCny: 500 });
    const option = (await get("/receipts/options")).body.orders.find((row: { po: string }) => row.po === order.po);
    expect(option).toMatchObject({ orderValueCny: 1000, depositsPaidCny: 300 });
    // The agent's money is still there: sea freight in the landed cost, every payee in the INR total.
    const cost = (await get("/landed-cost")).body.orders.find((row: { po: string }) => row.po === order.po);
    expect(cost).toMatchObject({ goodsInr: 6100, seaFreightInr: 1200 });
  });
});

describe("INR per payment comes from SQL on every list", () => {
  it("rounds half away from zero like the totals, where JavaScript floats round the other way: ORD-4 and PAY-1 agree to the paisa", async () => {
    const order = await place();
    const paid = await pay(order.id, "Balance", 100.02, 11.75); // 1,175.235 exactly; the float product lands just below the half
    expect(paid.status).toBe(201);
    expect(Math.round(100.02 * 11.75 * 100) / 100).toBe(1175.23); // what a browser recompute would show
    const fromDetail = (await ord4(order.po)).payments.find((p) => p.id === paid.body.payment.id)!;
    const fromList = ((await get("/payments")).body.payments as Figures[]).find((p) => p.id === paid.body.payment.id)!;
    expect(fromDetail.amountInr).toBe(1175.24);
    expect(fromList.amountInr).toBe(1175.24);
    expect(await ord1(order.po)).toMatchObject({ paidInr: 1175.24, supplierPaidInr: 1175.24 });
  });
});

describe("the deposit the supplier asked for (ORD-3, ORD-5, PAY-2, DEP-1)", () => {
  it("is none when not given, due once given, partly with a first deposit, paid at the requirement, and never negative beyond it", async () => {
    const plain = await place();
    expect(await ord1(plain.po)).toMatchObject({ depositRequiredCny: null, depositPaidCny: 0, depositPendingCny: null, depositStatus: "none" });

    const order = await place({ depositRequiredCny: 1000 });
    expect(await ord1(order.po)).toMatchObject({ depositRequiredCny: 1000, depositPaidCny: 0, depositPendingCny: 1000, depositStatus: "due" });
    expect((await pay(order.id, "Deposit", 300, 12)).status).toBe(201);
    // An agent deposit is freight: it never counts against the supplier's requirement.
    expect((await pay(order.id, "Deposit", 50, 12, ids.sino)).status).toBe(201);
    expect(await ord1(order.po)).toMatchObject({ depositPaidCny: 300, depositPendingCny: 700, depositStatus: "partly" });
    expect((await pay(order.id, "Deposit", 700, 12)).status).toBe(201);
    expect(await ord1(order.po)).toMatchObject({ depositPaidCny: 1000, depositPendingCny: 0, depositStatus: "paid" });
    expect((await pay(order.id, "Deposit", 100, 12)).status).toBe(201);
    expect(await ord1(order.po)).toMatchObject({ depositPaidCny: 1100, depositPendingCny: 0, depositStatus: "paid" });
    expect(await pay1(order.po)).toMatchObject({ depositPaidCny: 1100, depositPendingCny: 0, depositStatus: "paid" });

    // DEP-1 lists the requirement once per order, with its paid supplier deposits (the agent one left out).
    const deposits = (await get("/deposits", priya)).body;
    const pos = deposits.orderObligations.map((row: { po: string }) => row.po);
    expect(pos).toContain(order.po);
    expect(pos).not.toContain(plain.po);
    expect(deposits.orderObligations.find((row: { po: string }) => row.po === order.po)).toMatchObject({
      orderId: order.id,
      po: order.po,
      supplier: "Guangzhou Textile Co.",
      currency: "CNY",
      requiredCny: 1000,
      paidCny: 1100,
      pendingCny: 0,
      status: "paid",
      lastPaidOn: "2026-10-25",
      payments: 3,
    });
  });

  it("ORD-5 sets or clears the requirement until the warehouse (stage 6), with the same checks as ORD-3", async () => {
    const received = await makeOrder(ctx, { stage: 2, lines: [{ item: "Denim jeans", quantity: 10, rateCny: 5 }] });
    expect((await patch(`/orders/${received.po}`, { depositRequiredCny: 20 }, priya)).status).toBe(200);
    expect(await ord1(received.po)).toMatchObject({ depositRequiredCny: 20, depositPendingCny: 20, depositStatus: "due" });
    expect((await patch(`/orders/${received.po}`, { depositRequiredCny: null })).status).toBe(200);
    expect(await ord1(received.po)).toMatchObject({ depositRequiredCny: null, depositStatus: "none" });

    for (const bad of [0, -5, 12.345, 1_000_000_000_000]) {
      const res = await patch(`/orders/${received.po}`, { depositRequiredCny: bad });
      expect([res.status, res.body.error.fields], String(bad)).toEqual([422, { depositRequiredCny: M.depositRequired }]);
      const created = await post("/orders", orderBody({ depositRequiredCny: bad }));
      expect([created.status, created.body.error.fields], String(bad)).toEqual([422, { depositRequiredCny: M.depositRequired }]);
    }
    const stocked = await makeOrder(ctx, { stage: 6, lines: [{ item: "Denim jeans", quantity: 10, rateCny: 5 }] });
    const locked = await patch(`/orders/${stocked.po}`, { depositRequiredCny: 20 });
    expect([locked.status, locked.body.error.code]).toEqual([409, "order_locked"]);
    expect((await ctx.db.select({ v: orders.depositRequiredCny }).from(orders).where(eq(orders.id, stocked.id)))[0]!.v).toBeNull();
  });
});
