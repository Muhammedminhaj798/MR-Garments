import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { containerLines, locations, orders, payments, receiptLines, receipts, supplierDeposits, supplierDepositTransactions, suppliers, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { makeContainer, masters, stageWriter } from "../stages/fixtures";
import { idOf, indiaDay, makeOrder, receive } from "../stock/fixtures";

// RPT-O1 GET /orders/:po/report and RPT-O2 GET /reports/orders (docs/phase2-contracts.md section 4) on orders walked
// through the stage fixtures (as closure.test.ts does): China receipt, container, clearing (CLR-3), trip (TRN-3) and
// warehouse receipt (WH-3) through the API.
//
// A  Guangzhou Textile Co., 100 Denim jeans at ¥10 + 50 m Cotton fabric at ¥8 (¥1,400), ordered 30 days ago. Received
//    120 pcs (excess 20) and 30 m (short 20). Paid ¥300 at 12 and ¥500 at 12.5 to the supplier (₹9,850), ¥100 at 12 to
//    the agent; ¥200 due. One CNF container, cleared (₹37,050), trip ₹2,650, stocked 4 days ago (100 pcs, 50 m): closed.
// B  Guangzhou, 80 Track pants at ¥5 (¥400), paid in full. Split over two containers: the first stocked 2 days ago (80),
//    the second (shared with D, 20 more) arrived and not cleared: stage 6, open, "active".
// C  Foshan Fabrics, 10 Polo shirts at ¥3, ordered 3 days ago, nothing received: pending, unpaid.
// D  Guangzhou, 1 Kids t-shirt at ¥1 in B's second container: active, unpaid, no cost yet.
// E  Foshan Fabrics, USD: 50 Polo shirts at $2 ($100), ordered 12 days ago, stage 2. Received in China twice (30 then
//    20); two deposits paid, $40 at 83 and $20 at 84 (₹5,000); nothing shipped: active, partly paid.
// Guangzhou also holds a supplier-level deposit (migration 0008): ¥1,000 to give, ¥400 of it paid, linked to no order.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let suresh = "";
let priya = "";
let anita = "";
let m: Awaited<ReturnType<typeof masters>>;
type Order = Awaited<ReturnType<typeof makeOrder>>;
let a: Order;
let b: Order;
let c: Order;
let d: Order;
let e: Order;
let firstTrip = "";
let secondContainer = "";

beforeAll(async () => {
  await resetData(ctx);
  suresh = await signInAs(ctx, SEEDED.management);
  priya = await signInAs(ctx, SEEDED.procurement);
  anita = await signInAs(ctx, SEEDED.accounts);
  const joseph = await signInAs(ctx, SEEDED.warehouseStaff);
  m = await masters(ctx);
  const write = stageWriter(ctx, await signInAs(ctx, SEEDED.indiaStaff), m);
  const stock = (tripId: string, lines: { orderLineId: string; teamId: string; quantity: number }[], receivedOn: string) =>
    http
      .put(`/warehouse-receipts/${tripId}`, { locationId: m.warehouse, receivedOn, receivedBy: "Joseph M", bundlesReceived: 2, lines, complete: true })
      .set("Cookie", joseph);

  const tripA = await write.unloaded({
    orders: [
      [
        { item: "Denim jeans", quantity: 100, rateCny: 10 },
        { item: "Cotton fabric", quantity: 50, rateCny: 8 },
      ],
    ],
  });
  a = tripA.orders[0]!;
  await receive(ctx, a.id, [
    { orderLineId: a.lineIds[0]!, quantity: 120 },
    { orderLineId: a.lineIds[1]!, quantity: 30 },
  ]);
  const paid = { status: "paid", mode: "Bank" };
  await ctx.db.insert(payments).values([
    { ...paid, orderId: a.id, kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 300, rateInr: 12, paidOn: indiaDay(-29), reference: "TXN-1", notes: "Advance" },
    { ...paid, orderId: a.id, kind: "Balance", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 500, rateInr: 12.5, paidOn: indiaDay(-15) },
    { ...paid, orderId: a.id, kind: "Deposit", payee: "Sino Freight", payeeRole: "agent", amountCny: 100, rateInr: 12, paidOn: indiaDay(-19) },
    { orderId: a.id, kind: "Balance", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 200, status: "due", dueDate: indiaDay(10) },
  ]);
  expect(
    (
      await stock(
        tripA.tripId,
        [
          { orderLineId: a.lineIds[0]!, teamId: m.retail, quantity: 60 },
          { orderLineId: a.lineIds[0]!, teamId: m.online, quantity: 40 },
          { orderLineId: a.lineIds[1]!, teamId: m.retail, quantity: 50 },
        ],
        indiaDay(-4),
      )
    ).status,
  ).toBe(200);

  const tripB = await write.unloaded({ orders: [[{ item: "Track pants", quantity: 80, rateCny: 5 }]] });
  b = tripB.orders[0]!;
  firstTrip = tripB.tripId;
  await ctx.db.insert(payments).values({ ...paid, orderId: b.id, kind: "Balance", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 400, rateInr: 12, paidOn: indiaDay(-10) });
  const second = await makeContainer(ctx, { orders: [[{ item: "Kids t-shirts", quantity: 1, rateCny: 1 }]] });
  secondContainer = second.number;
  d = second.orders[0]!;
  await ctx.db.insert(containerLines).values({ containerId: second.id, orderLineId: b.lineIds[0]!, bundles: 1, quantity: 20 });
  expect((await stock(tripB.tripId, [{ orderLineId: b.lineIds[0]!, teamId: m.wholesale, quantity: 80 }], indiaDay(-2))).status).toBe(200);

  c = await makeOrder(ctx, { supplier: "Foshan Fabrics", lines: [{ item: "Polo shirts", quantity: 10, rateCny: 3 }] });
  await ctx.db.update(orders).set({ orderDate: indiaDay(-3) }).where(eq(orders.id, c.id));

  e = await makeOrder(ctx, { supplier: "Foshan Fabrics", stage: 2, lines: [{ item: "Polo shirts", quantity: 50, rateCny: 2 }] });
  await ctx.db.update(orders).set({ currency: "USD", orderDate: indiaDay(-12) }).where(eq(orders.id, e.id));
  const office = await idOf(ctx, locations, "Guangzhou office");
  const wang = await idOf(ctx, users, "Wang Fang");
  for (const [receivedOn, quantity, deliveryNote] of [
    [indiaDay(-8), 30, "DN-1"],
    [indiaDay(-6), 20, ""],
  ] as const) {
    const [receipt] = await ctx.db.insert(receipts).values({ orderId: e.id, receivedOn, locationId: office, receivedBy: wang, bundles: 1, deliveryNote }).returning({ id: receipts.id });
    await ctx.db.insert(receiptLines).values({ receiptId: receipt!.id, orderLineId: e.lineIds[0]!, quantity });
  }
  await ctx.db.insert(payments).values([
    { ...paid, orderId: e.id, kind: "Deposit", payee: "Foshan Fabrics", payeeRole: "supplier", amountCny: 40, rateInr: 83, paidOn: indiaDay(-11), reference: "USD-1" },
    { ...paid, orderId: e.id, kind: "Deposit", payee: "Foshan Fabrics", payeeRole: "supplier", amountCny: 20, rateInr: 84, paidOn: indiaDay(-9) },
  ]);
  const [deposit] = await ctx.db
    .insert(supplierDeposits)
    .values({ supplierId: await supplierId("Guangzhou Textile Co."), direction: "give", amount: 1000, currency: "CNY", openedOn: indiaDay(-25), reference: "DEP-1" })
    .returning({ id: supplierDeposits.id });
  await ctx.db.insert(supplierDepositTransactions).values({ depositId: deposit!.id, paidOn: indiaDay(-24), amount: 400, mode: "Bank", reference: "DEP-1/1" });
});

const supplierId = async (name: string) => (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, name)))[0]!.id;
const report = async (po: string, cookie = suresh) => {
  const res = await http.get(`/orders/${encodeURIComponent(po)}/report`).set("Cookie", cookie);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};
const steps = (body: { timeline: { step: string }[] }) => body.timeline.map((step) => step.step);

describe("RPT-O1 GET /orders/:po/report", () => {
  it("is 401 signed out, 403 without Orders access and 404 for an unknown PO; the PO matches in any letter case", async () => {
    expect((await http.get(`/orders/${a.po}/report`)).status).toBe(401);
    expect((await http.get(`/orders/${a.po}/report`).set("Cookie", await signInAs(ctx, SEEDED.chinaStaff))).status).toBe(403);
    expect((await http.get("/orders/PO-9999/report").set("Cookie", suresh)).status).toBe(404);
    expect((await report(a.po.toLowerCase())).order.po).toBe(a.po);
  });

  it("gives Management every section of a closed order: totals per unit, excess and short lines, money, logistics, warehouse, cost", async () => {
    const body = await report(a.po);
    expect(body.order).toEqual({
      id: a.id,
      po: a.po,
      // The supplier's whole profile (docs/suppliers.md), as the Supplier section shows it.
      supplier: {
        id: await supplierId("Guangzhou Textile Co."),
        name: "Guangzhou Textile Co.",
        code: "SUP-001",
        contactPerson: "Mr. Zhao Lin",
        phone: expect.any(String),
        email: "",
        country: "China",
        city: expect.any(String),
        state: "",
        postalCode: "",
        address: "",
        paymentTerms: "",
        taxNumber: "",
        notes: "",
        currency: "CNY",
        exchangeRate: null,
        rateUpdatedAt: null,
        status: "Active",
      },
      // Placed before rates were kept: no rate, so no INR value at the PO rate.
      exchangeRate: null,
      orderValueInr: null,
      orderDate: indiaDay(-30),
      deliveryDate: indiaDay(10),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      createdBy: null,
      stage: 6,
      closed: true,
      closedOn: indiaDay(-4),
      currency: "CNY",
      orderValueCny: 1400,
      products: 2,
      totals: [
        { unit: "pcs", ordered: 100, received: 120, pending: 0, stocked: 100 },
        { unit: "m", ordered: 50, received: 30, pending: 20, stocked: 50 },
      ],
    });
    expect(body.lines).toEqual([
      { id: a.lineIds[0], position: 0, itemId: expect.any(String), item: "Denim jeans", unit: "pcs", ordered: 100, received: 120, excess: 20, short: 0, pending: 0, loaded: 100, stocked: 100, rateCny: 10, valueCny: 1000 },
      { id: a.lineIds[1], position: 1, itemId: expect.any(String), item: "Cotton fabric", unit: "m", ordered: 50, received: 30, excess: 0, short: 20, pending: 20, loaded: 50, stocked: 50, rateCny: 8, valueCny: 400 },
    ]);
    // Paid and balance count supplier payments only; the agent's sea freight is reported apart; the list has every payment, oldest first.
    expect(body.payments).toMatchObject({ paidCny: 800, paidInr: 9850, balanceCny: 600, depositsPaidCny: 300, dueCny: 200, agentPaidCny: 100, agentPaidInr: 1200 });
    expect(body.payments.list).toHaveLength(4);
    expect(body.payments.list[0]).toEqual({
      id: expect.any(String),
      kind: "Deposit",
      payee: "Guangzhou Textile Co.",
      payeeRole: "supplier",
      amountCny: 300,
      amountInr: 3600,
      status: "paid",
      paidOn: indiaDay(-29),
      dueDate: null,
      rateInr: 12,
      mode: "Bank",
      reference: "TXN-1",
      notes: "Advance",
      recordedAt: expect.any(String),
      recordedBy: null,
    });
    // The China receipt as the China processing section lists it, with its lines.
    expect(body.receipts).toEqual([
      {
        id: expect.any(String),
        receivedOn: indiaDay(-5),
        office: "Guangzhou office",
        receivedBy: "Wang Fang",
        bundles: 1,
        deliveryNote: "",
        shortRemark: "",
        recordedAt: expect.any(String),
        lines: [
          { item: "Denim jeans", unit: "pcs", quantity: 120 },
          { item: "Cotton fabric", unit: "m", quantity: 30 },
        ],
      },
    ]);
    expect(body.payments.list[3]).toMatchObject({ kind: "Balance", amountCny: 200, amountInr: null, status: "due", dueDate: indiaDay(10), rateInr: null });

    expect(body.logistics).toHaveLength(1);
    const [container] = body.logistics;
    expect(container).toMatchObject({ terms: "CNF", agent: "Sino Freight", status: "arrived", loadedOn: indiaDay(-20), sailedOn: indiaDay(-20), eta: indiaDay(-12) });
    expect(container.lines).toEqual([
      { orderLineId: a.lineIds[0], item: "Denim jeans", unit: "pcs", bundles: 2, quantity: 100 },
      { orderLineId: a.lineIds[1], item: "Cotton fabric", unit: "m", bundles: 2, quantity: 50 },
    ]);
    expect(container.clearing).toMatchObject({
      agent: "Kochi Clearing Services",
      arrivedOn: indiaDay(-10),
      handedOn: indiaDay(-9),
      billOfEntry: "BE-7710482",
      dutyPaidOn: indiaDay(-8),
      clearedOn: indiaDay(-7),
      status: "cleared",
      customsDutyInr: 19600,
      otherDutiesInr: 14200,
      agentChargesInr: 1800,
      portChargesInr: 1450,
      totalInr: 37050,
      goodsValueInr: 98000,
      recordedBy: expect.any(String),
      recordedAt: expect.any(String),
    });
    expect(container.transport).toMatchObject({
      company: "Kerala Roadways",
      lrNumber: "LR-558214",
      vehicleNumber: "KL 07 CD 4821",
      driverName: "Suresh P",
      destination: "Main warehouse",
      loadedOn: indiaDay(-6),
      unloadedOn: indiaDay(-5),
      bundlesLoaded: 4,
      bundlesReceived: 4,
      status: "unloaded",
      freightInr: 2200,
      handlingInr: 450,
      totalInr: 2650,
      driverPhone: "+91 94470 55123",
      loadedFrom: "Kochi port yard",
      loadedBy: "Ravi K",
      receivedBy: "Joseph M",
      shortRemark: "",
      recordedBy: expect.any(String),
    });

    expect(body.warehouse).toEqual([
      {
        receiptId: expect.any(String),
        transportId: container.transport.id,
        container: container.number,
        warehouse: "Main warehouse",
        receivedOn: indiaDay(-4),
        receivedBy: "Joseph M",
        status: "stocked",
        bundlesReceived: 2,
        recordedAt: expect.any(String),
        recordedBy: expect.any(String),
        updatedAt: expect.any(String),
        updatedBy: expect.any(String),
        lines: [
          { item: "Denim jeans", unit: "pcs", team: "Retail team", quantity: 60 },
          { item: "Denim jeans", unit: "pcs", team: "Online team", quantity: 40 },
          { item: "Cotton fabric", unit: "m", team: "Retail team", quantity: 50 },
        ],
      },
    ]);
    // loadLandedCosts, unchanged: 9,850 + 0 (CNF) + 37,050 + 2,650 over 150 stocked; an estimate while ¥600 is unpaid.
    expect(body.landedCost).toEqual({
      orderId: a.id,
      goodsInr: 9850,
      seaFreightInr: 0,
      clearingInr: 37050,
      transportInr: 2650,
      totalInr: 49550,
      stockedPieces: 150,
      perPieceInr: 330.33,
      final: false,
      waitingFor: "supplier payment",
    });
    // Date order; a tie keeps the workflow order (the receipt and the unloading share a day).
    const dated = body.timeline.map(({ step, on, detail }: { step: string; on: string; detail: string }) => ({ step, on, detail }));
    expect(dated).toEqual([
      { step: "created", on: indiaDay(-30), detail: "Ordered from Guangzhou Textile Co." },
      { step: "deposit", on: indiaDay(-29), detail: "300.00 CNY to Guangzhou Textile Co." },
      { step: "loaded", on: indiaDay(-20), detail: `${container.number} · Sino Freight` },
      { step: "sailed", on: indiaDay(-20), detail: container.number },
      { step: "deposit", on: indiaDay(-19), detail: "100.00 CNY to Sino Freight" },
      { step: "payment", on: indiaDay(-15), detail: "500.00 CNY to Guangzhou Textile Co." },
      { step: "arrived", on: indiaDay(-10), detail: `${container.number} · Kochi Clearing Services` },
      { step: "cleared", on: indiaDay(-7), detail: container.number },
      { step: "dispatched", on: indiaDay(-6), detail: `${container.number} · KL 07 CD 4821 · LR LR-558214` },
      { step: "received", on: indiaDay(-5), detail: "Guangzhou office · 120 pcs · 30 m" },
      { step: "unloaded", on: indiaDay(-5), detail: `${container.number} · Main warehouse` },
      { step: "stocked", on: indiaDay(-4), detail: `${container.number} · Main warehouse` },
      { step: "closed", on: indiaDay(-4), detail: "Every container stocked" },
    ]);
    // When and by whom, where the record keeps it: the receipt's user, the stage forms' users; nothing for a derived closure.
    const step = (name: string) => body.timeline.find((entry: { step: string }) => entry.step === name);
    expect(step("created")).toMatchObject({ at: expect.any(String), by: null });
    expect(step("received")).toMatchObject({ at: expect.any(String), by: "Wang Fang" });
    expect(step("cleared")).toMatchObject({ at: expect.any(String), by: expect.any(String) });
    expect(step("stocked")).toMatchObject({ at: expect.any(String), by: expect.any(String) });
    expect(step("sailed")).toMatchObject({ at: null, by: null });
    expect(step("closed")).toMatchObject({ at: null, by: null });
  });

  it("reports the supplier's account beside the order: every order's money per currency and the account-level deposits, which the order's figures never count", async () => {
    const body = await report(a.po);
    // Guangzhou: A (¥1,400, ¥800 paid), B (¥400 paid in full) and D (¥1, unpaid); A is closed.
    expect(body.supplierAccount).toMatchObject({
      orders: 3,
      openOrders: 2,
      purchaseValue: [{ currency: "CNY", amount: 1801 }],
      paid: [{ currency: "CNY", amount: 1200 }],
      balance: [{ currency: "CNY", amount: 601 }],
      deposits: { summary: [{ currency: "CNY", direction: "give", amount: 1000, settled: 400, pending: 600 }] },
    });
    expect(body.supplierAccount.deposits.list).toEqual([
      {
        id: expect.any(String),
        direction: "give",
        currency: "CNY",
        exchangeRate: null,
        amount: 1000,
        settled: 400,
        pending: 600,
        status: "partly settled",
        openedOn: indiaDay(-25),
        reference: "DEP-1",
        notes: "",
        transactions: [{ id: expect.any(String), paidOn: indiaDay(-24), amount: 400, mode: "Bank", reference: "DEP-1/1", notes: "" }],
      },
    ]);
    // The order's own money is untouched by the account deposit.
    expect(body.payments).toMatchObject({ paidCny: 800, depositsPaidCny: 300, balanceCny: 600 });
  });

  it("gives a USD order its two China receipts and two deposits in USD, INR at each payment's rate, nothing shipped, no agent money", async () => {
    const body = await report(e.po);
    expect(body.order).toMatchObject({ currency: "USD", stage: 2, closed: false, orderValueCny: 100, products: 1, totals: [{ unit: "pcs", ordered: 50, received: 50, pending: 0, stocked: 0 }] });
    expect(body.receipts.map((receipt: { receivedOn: string; deliveryNote: string; lines: { quantity: number }[] }) => [receipt.receivedOn, receipt.deliveryNote, receipt.lines[0]!.quantity])).toEqual([
      [indiaDay(-8), "DN-1", 30],
      [indiaDay(-6), "", 20],
    ]);
    expect(body.payments).toMatchObject({ paidCny: 60, paidInr: 5000, balanceCny: 40, depositsPaidCny: 60, dueCny: 0, agentPaidCny: 0, agentPaidInr: 0 });
    expect(body.payments.list.map((payment: { amountCny: number; amountInr: number }) => [payment.amountCny, payment.amountInr])).toEqual([
      [40, 3320],
      [20, 1680],
    ]);
    expect(body).toMatchObject({ logistics: [], warehouse: [], landedCost: { goodsInr: 5000, totalInr: 5000, perPieceInr: null, final: false, waitingFor: "supplier payment" } });
    expect(steps(body)).toEqual(["created", "deposit", "deposit", "received", "received"]);
    expect(body.supplierAccount).toMatchObject({
      orders: 2,
      openOrders: 2,
      purchaseValue: [
        { currency: "CNY", amount: 30 },
        { currency: "USD", amount: 100 },
      ],
      balance: [
        { currency: "CNY", amount: 30 },
        { currency: "USD", amount: 40 },
      ],
      deposits: { summary: [], list: [] },
    });
  });

  it("lists both containers of a split order, the second without clearing or trip, and leaves the order open", async () => {
    const body = await report(b.po);
    expect(body.order).toMatchObject({ stage: 6, closed: false, closedOn: null, totals: [{ unit: "pcs", ordered: 80, received: 0, stocked: 80 }] });
    expect(body.lines[0]).toMatchObject({ ordered: 80, received: 0, excess: 0, short: 80, loaded: 100, stocked: 80 });
    expect(body.logistics).toHaveLength(2);
    expect(body.logistics[0]).toMatchObject({ clearing: { status: "cleared" }, transport: { id: firstTrip, status: "unloaded" }, lines: [{ quantity: 80 }] });
    expect(body.logistics[1]).toMatchObject({ number: secondContainer, clearing: null, transport: null, lines: [{ item: "Track pants", bundles: 1, quantity: 20 }] });
    expect(body.warehouse).toHaveLength(1);
    expect(body.warehouse[0]).toMatchObject({ transportId: firstTrip, status: "stocked", lines: [{ team: "Wholesale team", quantity: 80 }] });
    expect(body.landedCost).toMatchObject({ goodsInr: 4800, clearingInr: 37050, transportInr: 2650, totalInr: 44500, perPieceInr: 556.25, final: false, waitingFor: "duty" });
    expect(steps(body)).toEqual(["created", "loaded", "sailed", "loaded", "sailed", "payment", "arrived", "cleared", "dispatched", "unloaded", "stocked"]);
  });

  it("nulls the sections below View and keeps their steps out of the timeline: Procurement sees payments, Accounts no receipts", async () => {
    const procurement = await report(a.po, priya);
    expect(procurement.payments).toMatchObject({ paidCny: 800 });
    expect(procurement.logistics).toBeNull();
    expect(procurement.warehouse).toBeNull();
    expect(procurement.landedCost).toBeNull();
    expect(procurement.receipts).toHaveLength(1);
    expect(procurement.supplierAccount).toMatchObject({ orders: 3 });
    expect(procurement.lines).toHaveLength(2);
    expect(steps(procurement)).toEqual(["created", "deposit", "deposit", "payment", "received", "closed"]);
    const accounts = await report(a.po, anita);
    expect(accounts.payments.list).toHaveLength(4);
    expect(accounts.receipts).toBeNull();
    expect(steps(accounts)).toEqual(["created", "deposit", "deposit", "payment", "closed"]);
  });

  it("shows a pending order with nothing but its lines", async () => {
    const body = await report(c.po);
    expect(body.order).toMatchObject({ stage: 1, closed: false, orderValueCny: 30, totals: [{ unit: "pcs", ordered: 10, received: 0, stocked: 0 }] });
    expect(body).toMatchObject({ payments: { paidCny: 0, balanceCny: 30, list: [] }, receipts: [], logistics: [], warehouse: [], landedCost: { totalInr: 0, waitingFor: "supplier payment" } });
    expect(body.timeline).toEqual([{ step: "created", on: indiaDay(-3), detail: "Ordered from Foshan Fabrics", at: expect.any(String), by: null }]);
  });
});

const list = async (query = "", cookie = suresh) => {
  const res = await http.get(`/reports/orders${query}`).set("Cookie", cookie);
  expect(res.status, `${query}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
};
const pos = (body: { rows: { po: string }[] }) => body.rows.map((row) => row.po);

describe("RPT-O2 GET /reports/orders", () => {
  it("is 401 signed out and 403 without Reports access", async () => {
    expect((await http.get("/reports/orders")).status).toBe(401);
    expect((await http.get("/reports/orders").set("Cookie", priya)).status).toBe(403);
    expect((await http.get("/reports/orders").set("Cookie", anita)).status).toBe(403);
  });

  it("is 400 for a malformed query", async () => {
    const bad = ["status=done", "paymentStatus=half", "supplierId=abc", "warehouseId=1", "from=2026-13-01", "from=2026-10-02&to=2026-10-01", "foo=1", "po=x&po=y", `po=${"x".repeat(51)}`, "stage=7", "stage=a", "currency=XAU", `supplier=${"s".repeat(201)}`];
    for (const query of bad) {
      const res = await http.get(`/reports/orders?${query}`).set("Cookie", suresh);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
  });

  it("lists every order newest first with its figures, status, cost and the summary, options and an empty filter echo", async () => {
    const body = await list();
    expect(pos(body)).toEqual([c.po, e.po, d.po, b.po, a.po]);
    expect(body.rows[4]).toEqual({
      id: a.id,
      po: a.po,
      orderDate: indiaDay(-30),
      deliveryDate: indiaDay(10),
      stage: 6,
      supplier: { id: await supplierId("Guangzhou Textile Co."), name: "Guangzhou Textile Co.", code: "SUP-001" },
      currency: "CNY",
      exchangeRate: null,
      orderValueInr: null,
      item: "Denim jeans",
      quantity: 100,
      unit: "pcs",
      received: 120,
      stocked: 100,
      // Two lines; the ordered quantity per unit over every line (pieces and metres never added).
      lineCount: 2,
      quantities: [
        { unit: "pcs", quantity: 100 },
        { unit: "m", quantity: 50 },
      ],
      closed: true,
      closedOn: indiaDay(-4),
      orderValueCny: 1400,
      paidCny: 800,
      paidInr: 9850,
      balanceCny: 600,
      paymentStatus: "partly",
      landedCostInr: 49550,
      perPieceInr: 330.33,
    });
    expect(body.rows[3]).toMatchObject({ po: b.po, closed: false, stocked: 80, paidCny: 400, balanceCny: 0, paymentStatus: "paid", landedCostInr: 44500, perPieceInr: 556.25, lineCount: 1, quantities: [{ unit: "pcs", quantity: 80 }] });
    expect(body.rows[2]).toMatchObject({ po: d.po, stage: 3, paymentStatus: "unpaid", landedCostInr: null, perPieceInr: null });
    expect(body.rows[1]).toMatchObject({ po: e.po, currency: "USD", stage: 2, received: 50, paidCny: 60, paidInr: 5000, balanceCny: 40, paymentStatus: "partly", landedCostInr: 5000, perPieceInr: null });
    expect(body.rows[0]).toMatchObject({ po: c.po, stage: 1, orderDate: indiaDay(-3), paymentStatus: "unpaid" });
    expect(body.summary).toEqual({
      orders: 5,
      byCurrency: [
        { currency: "CNY", orderValueCny: 1831, paidCny: 1200, balanceCny: 631 },
        { currency: "USD", orderValueCny: 100, paidCny: 60, balanceCny: 40 },
      ],
      paidInr: 19650,
      landedCostInr: 99050,
    });
    expect(body.filter).toEqual({ po: null, supplierName: null, supplier: null, from: null, to: null, status: null, stage: null, currency: null, warehouse: null, paymentStatus: null });
    expect(body.options.suppliers).toHaveLength(5);
    expect(body.options.warehouses).toEqual([{ id: m.warehouse, name: "Main warehouse" }]);
  });

  it("filters by PO (any case, a part of it), supplier and order date, echoing the filter", async () => {
    expect(pos(await list(`?po=${a.po.toLowerCase()}`))).toEqual([a.po]);
    expect(pos(await list(`?po=${a.po.slice(0, 3)}`))).toHaveLength(5);
    expect((await list("?po=%25")).rows).toEqual([]);
    const foshan = await list(`?supplierId=${await supplierId("Foshan Fabrics")}`);
    expect(pos(foshan)).toEqual([c.po, e.po]);
    expect(foshan.filter).toMatchObject({ supplier: "Foshan Fabrics" });
    expect(foshan.summary).toMatchObject({
      orders: 2,
      byCurrency: [
        { currency: "CNY", orderValueCny: 30, paidCny: 0, balanceCny: 30 },
        { currency: "USD", orderValueCny: 100, paidCny: 60, balanceCny: 40 },
      ],
      paidInr: 5000,
      landedCostInr: 5000,
    });
    expect(pos(await list(`?from=${indiaDay(-5)}`))).toEqual([c.po]);
    expect(pos(await list(`?to=${indiaDay(-10)}`))).toEqual([e.po, d.po, b.po, a.po]);
    expect((await list(`?from=${indiaDay(-31)}&to=${indiaDay(-29)}`)).filter).toMatchObject({ from: indiaDay(-31), to: indiaDay(-29) });
    expect((await list("?supplierId=00000000-0000-4000-8000-000000000000")).filter.supplier).toBeNull();
  });

  it("filters by status: pending is stage 1, closed is the closure rule, active is everything else", async () => {
    expect(pos(await list("?status=pending"))).toEqual([c.po]);
    expect(pos(await list("?status=active"))).toEqual([e.po, d.po, b.po]);
    expect(pos(await list("?status=closed"))).toEqual([a.po]);
    expect((await list("?status=closed")).filter.status).toBe("closed");
  });

  it("filters by warehouse (orders with goods stocked there) and by payment status (supplier payments against the value)", async () => {
    const main = await list(`?warehouseId=${m.warehouse}`);
    expect(pos(main)).toEqual([b.po, a.po]);
    expect(main.filter.warehouse).toBe("Main warehouse");
    const office = await list(`?warehouseId=${m.indiaOffice}`);
    expect(office.rows).toEqual([]);
    expect(office.summary).toEqual({ orders: 0, byCurrency: [], paidInr: 0, landedCostInr: 0 });
    expect(pos(await list("?paymentStatus=unpaid"))).toEqual([c.po, d.po]);
    expect(pos(await list("?paymentStatus=partly"))).toEqual([e.po, a.po]);
    expect(pos(await list("?paymentStatus=paid"))).toEqual([b.po]);
    expect(pos(await list("?paymentStatus=paid&status=closed"))).toEqual([]);
  });

  it("filters by a part of the supplier's name, by stage (the shipment status) and by currency, echoing them", async () => {
    const fosh = await list("?supplier=fosh");
    expect(pos(fosh)).toEqual([c.po, e.po]);
    expect(fosh.filter).toMatchObject({ supplierName: "fosh", supplier: null });
    expect(pos(await list("?stage=2"))).toEqual([e.po]);
    expect(pos(await list("?stage=6"))).toEqual([b.po, a.po]);
    expect((await list("?stage=6")).filter.stage).toBe(6);
    const usd = await list("?currency=USD");
    expect(pos(usd)).toEqual([e.po]);
    expect(usd.filter.currency).toBe("USD");
    expect(usd.summary.byCurrency).toEqual([{ currency: "USD", orderValueCny: 100, paidCny: 60, balanceCny: 40 }]);
    expect(pos(await list("?currency=CNY&stage=1"))).toEqual([c.po]);
  });
});
