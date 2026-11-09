import { eq } from "drizzle-orm";
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, locations, orderLines, orders, payments, receiptLines, receipts, shippingAgents, suppliers, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { MESSAGES } from "./orders.routes";

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let ids: { supplier: string; jeans: string; fabric: string; userId: string };
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  const itemId = async (name: string) => (await ctx.db.select({ id: items.id }).from(items).where(eq(items.name, name)))[0]!.id;
  ids = {
    supplier: (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, "Guangzhou Textile Co.")))[0]!.id,
    jeans: await itemId("Denim jeans"),
    fabric: await itemId("Cotton fabric"),
    userId: (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.management)))[0]!.id,
  };
});

const orderBody = (overrides: object = {}) => ({
  supplierId: ids.supplier,
  orderDate: "2026-10-20",
  deliveryDate: "2026-11-30",
  lines: [
    { itemId: ids.jeans, quantity: 1000, rateCny: 12.5 },
    { itemId: ids.fabric, quantity: 300, rateCny: 8.25 },
  ],
  deposits: [
    { payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 1234.56, paidOn: "2026-10-21", rateInr: 11.8765, mode: "Bank transfer" },
    { payee: "Sino Freight", payeeRole: "agent", amountCny: 1000, paidOn: "2026-10-22", rateInr: 11.9, mode: "Cash" },
  ],
  ...overrides,
});
const create = (body: object, cookie = management) => http.post("/orders", body).set("Cookie", cookie);
const get = (path: string, cookie = management) => http.get(path).set("Cookie", cookie);
const countOrders = async () => (await ctx.db.select().from(orders)).length;

describe("access", () => {
  it("is 401 signed out on every endpoint", async () => {
    for (const path of ["/orders", "/orders/options", "/deliveries", "/payments"]) expect((await http.get(path)).status, path).toBe(401);
    expect((await http.post("/orders", orderBody())).status).toBe(401);
  });

  it("is 403 for roles without access", async () => {
    const china = await signInAs(ctx, SEEDED.chinaStaff);
    const accounts = await signInAs(ctx, SEEDED.accounts);
    const india = await signInAs(ctx, SEEDED.indiaStaff);
    for (const path of ["/orders", "/orders/options", "/deliveries", "/payments"]) {
      const res = await get(path, china);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    expect((await get("/deliveries", accounts)).status).toBe(403);
    expect((await get("/payments", india)).status).toBe(403);
    expect((await create(orderBody(), china)).status).toBe(403);
    expect((await create(orderBody(), accounts)).status).toBe(403);
    expect(await countOrders()).toBe(0);
    // Accounts may view orders and payments; Procurement may create orders.
    expect((await get("/orders", accounts)).status).toBe(200);
    expect((await get("/orders/options", accounts)).status).toBe(200);
    expect((await get("/payments", accounts)).status).toBe(200);
    expect((await create(orderBody(), await signInAs(ctx, SEEDED.procurement))).status).toBe(201);
  });

  it("POST /orders needs the app's Origin", async () => {
    const noOrigin = await supertest(ctx.app).post("/api/v1/orders").set("Cookie", management).send(orderBody());
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe("origin_rejected");
    const other = await supertest(ctx.app).post("/api/v1/orders").set("Cookie", management).set("Origin", "http://evil.example").send(orderBody());
    expect(other.status).toBe(403);
    expect(await countOrders()).toBe(0);
  });
});

describe("ORD-2 GET /orders/options", () => {
  it("offers the next PO and the active suppliers, items and shipping agents", async () => {
    await ctx.db.update(suppliers).set({ status: "Inactive" }).where(eq(suppliers.name, "Foshan Fabrics"));
    await ctx.db.update(shippingAgents).set({ status: "Inactive" }).where(eq(shippingAgents.name, "Dragon Cargo"));
    const res = await get("/orders/options");
    expect(res.status).toBe(200);
    expect(res.body.nextPo).toBe("PO-2050");
    expect(res.body.suppliers.map((row: { name: string }) => row.name)).toEqual(["Guangzhou Textile Co.", "Shenzhen Apparel", "Yiwu Trims Ltd.", "Hangzhou Knits"]);
    expect(res.body.suppliers[0]).toEqual({ id: ids.supplier, name: "Guangzhou Textile Co.", contactPerson: "Mr. Zhao Lin", phone: "+86 138 0013 2244", city: "Guangzhou", currency: "CNY" });
    expect(res.body.items).toHaveLength(8);
    expect(res.body.items).toContainEqual({ id: ids.jeans, name: "Denim jeans", unit: "pcs", price: null });
    expect(res.body.items).toContainEqual({ id: ids.fabric, name: "Cotton fabric", unit: "m", price: null });
    expect(res.body.agents).toEqual([{ id: expect.any(String), name: "Sino Freight" }]);
  });
});

describe("ORD-3 POST /orders and ORD-1 GET /orders", () => {
  it("creates PO-2050 then PO-2051 with lines and deposits, and lists their figures", async () => {
    const first = await create(orderBody());
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ order: { id: expect.any(String), po: "PO-2050" } });
    const second = await create(orderBody({ orderDate: "2026-10-20", lines: [{ itemId: ids.fabric, quantity: 50, rateCny: 3 }], deposits: [] }));
    expect(second.body.order.po).toBe("PO-2051");
    expect((await get("/orders/options")).body.nextPo).toBe("PO-2052");

    const id = first.body.order.id;
    const stored = (await ctx.db.select().from(orders).where(eq(orders.id, id)))[0];
    expect(stored).toMatchObject({ poNumber: "PO-2050", stage: 1, currency: "CNY", createdBy: ids.userId });
    const lines = await ctx.db.select().from(orderLines).where(eq(orderLines.orderId, id)).orderBy(orderLines.position);
    expect(lines.map(({ itemId, position, quantity, rateCny }) => ({ itemId, position, quantity, rateCny }))).toEqual([
      { itemId: ids.jeans, position: 0, quantity: 1000, rateCny: 12.5 },
      { itemId: ids.fabric, position: 1, quantity: 300, rateCny: 8.25 },
    ]);
    const deposits = await ctx.db.select().from(payments).where(eq(payments.orderId, id));
    expect(deposits).toHaveLength(2);
    for (const row of deposits) expect(row).toMatchObject({ kind: "Deposit", status: "paid", dueDate: null, createdBy: ids.userId });
    expect(deposits).toContainEqual(expect.objectContaining({ payee: "Sino Freight", payeeRole: "agent", amountCny: 1000, paidOn: "2026-10-22", rateInr: 11.9, mode: "Cash" }));

    const list = await get("/orders");
    expect(list.status).toBe(200);
    expect(list.body.map((row: { po: string }) => row.po)).toEqual(["PO-2051", "PO-2050"]);
    expect(list.body[1]).toEqual({
      id,
      po: "PO-2050",
      orderDate: "2026-10-20",
      deliveryDate: "2026-11-30",
      stage: 1,
      supplier: { id: ids.supplier, name: "Guangzhou Textile Co." },
      currency: "CNY",
      item: "Denim jeans",
      quantity: 1000,
      unit: "pcs",
      received: 0,
      stocked: 0,
      closed: false,
      closedOn: null,
      orderValueCny: 14975, // 1000 * 12.5 + 300 * 8.25
      paidCny: 2234.56,
      paidInr: 26562.25, // 1234.56 * 11.8765 = 14662.25 (rounded) + 1000 * 11.9
      supplierPaidCny: 1234.56, // the ¥1,000 agent deposit is sea freight
      supplierPaidInr: 14662.25,
      depositRequiredCny: null,
      depositPaidCny: 1234.56,
      depositPendingCny: null,
      depositStatus: "none",
    });
    expect(list.body[0]).toMatchObject({ item: "Cotton fabric", quantity: 50, unit: "m", orderValueCny: 150, paidCny: 0, paidInr: 0 });
  });

  it("takes an agent deposit to an active agent in any letter case, and refuses one to an inactive agent", async () => {
    const agentDeposit = (payee: string) => ({ payee, payeeRole: "agent", amountCny: 5, paidOn: "2026-10-21", rateInr: 11, mode: "Cash" });
    expect((await create(orderBody({ deposits: [agentDeposit("sino freight")] }))).status).toBe(201);
    await ctx.db.update(shippingAgents).set({ status: "Inactive" }).where(eq(shippingAgents.name, "Dragon Cargo"));
    const refused = await create(orderBody({ deposits: [agentDeposit("Dragon Cargo")] }));
    expect([refused.status, refused.body.error.fields]).toEqual([422, { deposits: MESSAGES.payee }]);
    expect(await countOrders()).toBe(1);
  });

  it("takes the form's PO number as typed, refuses one already used in any letter case, and numbers the next order after it", async () => {
    const typed = await create(orderBody({ po: " po-3000 " }));
    expect(typed.status).toBe(201);
    expect(typed.body.order.po).toBe("po-3000");
    const taken = await create(orderBody({ po: "PO-3000" }));
    expect([taken.status, taken.body.error.fields]).toEqual([422, { po: MESSAGES.poTaken }]);
    expect((await get("/orders/options")).body.nextPo).toBe("PO-3001");
    expect((await create(orderBody())).body.order.po).toBe("PO-3001");
    expect((await get("/orders")).body.map((row: { po: string }) => row.po)).toEqual(["PO-3001", "po-3000"]);
    expect((await get("/orders/PO-3000")).body.po).toBe("po-3000");
    expect(await countOrders()).toBe(2);
    // Two forms sending the same number at once: the unique index refuses the second, as a field error (no retry).
    const race = await Promise.all([create(orderBody({ po: "PO-3005" })), create(orderBody({ po: "PO-3005" }))]);
    expect(race.map((res) => res.status).sort()).toEqual([201, 422]);
    expect(race.find((res) => res.status === 422)!.body.error.fields).toEqual({ po: MESSAGES.poTaken });
    expect(await countOrders()).toBe(3);
  });

  it("takes a PO number in any format, kept as typed, reachable by its encoded URL; only PO-<number> ones count for the next", async () => {
    const typed = ["VM-11340", "MR/2026/001", "ABC-001", "2026-001", "PO-2050", "SUPPLIER/PO/2026/01", "x".repeat(50)];
    for (const po of typed) {
      const res = await create(orderBody({ po: `  ${po} `, deposits: [] }));
      expect([res.status, res.body.order?.po], po).toEqual([201, po]);
      expect((await get(`/orders/${encodeURIComponent(po)}`)).body.po, po).toBe(po);
    }
    expect((await get("/orders/mr%2F2026%2F001")).body.po).toBe("MR/2026/001");
    expect((await http.patch("/orders/MR%2F2026%2F001", { deliveryDate: "2026-12-01" }).set("Cookie", management)).body.order.deliveryDate).toBe("2026-12-01");
    expect((await get("/orders/options")).body.nextPo).toBe("PO-2051");
    expect((await create(orderBody())).body.order.po).toBe("PO-2051");
    // Numbered POs first (newest), then the rest by their text, newest first.
    expect((await get("/orders")).body.map((row: { po: string }) => row.po)).toEqual(["PO-2051", "PO-2050", "x".repeat(50), "VM-11340", "SUPPLIER/PO/2026/01", "MR/2026/001", "ABC-001", "2026-001"]);
    // A duplicate in another letter case, sent later or at the same moment, is refused under the field.
    expect((await create(orderBody({ po: "vm-11340" }))).body.error.fields).toEqual({ po: MESSAGES.poTaken });
    const race = await Promise.all([create(orderBody({ po: "MR-001" })), create(orderBody({ po: "mr-001" }))]);
    expect(race.map((res) => res.status).sort()).toEqual([201, 422]);
    expect(race.find((res) => res.status === 422)!.body.error.fields).toEqual({ po: MESSAGES.poTaken });
    expect((await http.delete("/orders/MR%2F2026%2F001").set("Cookie", management)).status).toBe(204);
    expect((await get("/orders/MR%2F2026%2F001")).status).toBe(404);
    expect(await countOrders()).toBe(8);
  });

  it("gives simultaneous creates different PO numbers", async () => {
    const results = await Promise.all([create(orderBody()), create(orderBody()), create(orderBody())]);
    expect(results.map((res) => res.status)).toEqual([201, 201, 201]);
    expect(results.map((res) => res.body.order.po).sort()).toEqual(["PO-2050", "PO-2051", "PO-2052"]);
  });

  it("refuses broken rules with 422 under the field and stores nothing", async () => {
    const inactiveItem = (await ctx.db.select({ id: items.id }).from(items).where(eq(items.name, "Polo shirts")))[0]!.id;
    await ctx.db.update(items).set({ status: "Inactive" }).where(eq(items.id, inactiveItem));
    await ctx.db.update(suppliers).set({ status: "Inactive" }).where(eq(suppliers.name, "Foshan Fabrics"));
    const foshan = (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, "Foshan Fabrics")))[0]!.id;
    const unknown = "6b1f8e3a-2c4d-4e5f-9a0b-1c2d3e4f5a6b";
    const cases: [object, Record<string, string>][] = [
      [{ deliveryDate: "2026-10-19" }, { deliveryDate: MESSAGES.deliveryBeforeOrder }],
      [{ lines: [] }, { lines: MESSAGES.lines }],
      [{ lines: [{ itemId: ids.jeans, quantity: 0, rateCny: 1 }] }, { lines: MESSAGES.quantity }],
      [{ lines: [{ itemId: ids.jeans, quantity: 1.5, rateCny: 1 }] }, { lines: MESSAGES.quantity }],
      [{ lines: [{ itemId: ids.jeans, quantity: 1, rateCny: -1 }] }, { lines: MESSAGES.rate }],
      [{ supplierId: unknown }, { supplierId: MESSAGES.supplier }],
      [{ supplierId: foshan }, { supplierId: MESSAGES.supplier }],
      [{ supplierId: "nope" }, { supplierId: MESSAGES.supplier }],
      [{ lines: [{ itemId: unknown, quantity: 1, rateCny: 1 }] }, { lines: MESSAGES.item }],
      [{ lines: [{ itemId: ids.jeans, quantity: 1, rateCny: 1 }, { itemId: inactiveItem, quantity: 1, rateCny: 1 }] }, { lines: MESSAGES.item }],
      [{ orderDate: "2026-02-30" }, { orderDate: MESSAGES.orderDate }],
      [{ po: "" }, { po: MESSAGES.po }],
      [{ po: "   " }, { po: MESSAGES.po }],
      [{ po: "x".repeat(51) }, { po: MESSAGES.poTooLong }],
      [{ po: 2050 }, { po: MESSAGES.po }],
      [{ deposits: [{ payee: "X", payeeRole: "supplier", amountCny: 0, paidOn: "2026-10-21", rateInr: 11, mode: "Cash" }] }, { deposits: MESSAGES.amount }],
      [{ deposits: [{ payee: "X", payeeRole: "supplier", amountCny: 5, paidOn: "2026-10-21", rateInr: 11, mode: " " }] }, { deposits: MESSAGES.mode }],
      // An agent deposit keeps the agent's name, so it must be an active agent's (checked inside the transaction).
      [{ deposits: [{ payee: "No Such Agent", payeeRole: "agent", amountCny: 5, paidOn: "2026-10-21", rateInr: 11, mode: "Cash" }] }, { deposits: MESSAGES.payee }],
      [
        { supplierId: foshan, deliveryDate: "2026-10-01", lines: [{ itemId: inactiveItem, quantity: 1, rateCny: 1 }] },
        { supplierId: MESSAGES.supplier, deliveryDate: MESSAGES.deliveryBeforeOrder, lines: MESSAGES.item },
      ],
    ];
    for (const [overrides, fields] of cases) {
      const res = await create(orderBody(overrides));
      expect(res.status, JSON.stringify(overrides)).toBe(422);
      expect(res.body.error).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields });
    }
    expect((await create(orderBody({ stage: 2 }))).status).toBe(400);
    expect(await countOrders()).toBe(0);
    expect((await ctx.db.select().from(payments)).length).toBe(0);
  });
});

describe("CAL-1 GET /deliveries", () => {
  it("lists orders at stage 1-2, oldest due date first, with received quantities", async () => {
    const late = (await create(orderBody({ deliveryDate: "2026-12-15" }))).body.order;
    const soon = (await create(orderBody({ deliveryDate: "2026-11-01", lines: [{ itemId: ids.fabric, quantity: 300, rateCny: 2 }] }))).body.order;
    const loaded = (await create(orderBody({ deliveryDate: "2026-10-25" }))).body.order;
    await ctx.db.update(orders).set({ stage: 2 }).where(eq(orders.id, late.id));
    await ctx.db.update(orders).set({ stage: 3 }).where(eq(orders.id, loaded.id));
    const mainLine = (await ctx.db.select().from(orderLines).where(eq(orderLines.orderId, late.id)))[0]!;
    const office = (await ctx.db.select({ id: locations.id }).from(locations).where(eq(locations.name, "Guangzhou office")))[0]!.id;
    const receipt = (
      await ctx.db.insert(receipts).values({ orderId: late.id, receivedOn: "2026-10-26", locationId: office, receivedBy: ids.userId, bundles: 8 }).returning()
    )[0]!;
    await ctx.db.insert(receiptLines).values({ receiptId: receipt.id, orderLineId: mainLine.id, quantity: 400 });

    const res = await get("/deliveries");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { orderId: soon.id, po: soon.po, supplier: "Guangzhou Textile Co.", item: "Cotton fabric", quantity: 300, unit: "m", received: 0, due: "2026-11-01", fullyReceived: false },
      { orderId: late.id, po: late.po, supplier: "Guangzhou Textile Co.", item: "Denim jeans", quantity: 1000, unit: "pcs", received: 400, due: "2026-12-15", fullyReceived: false },
    ]);
    expect((await get("/orders")).body.find((row: { id: string }) => row.id === late.id).received).toBe(400);
  });

  it("says an order is fully received only when every line is, not just the main line", async () => {
    const twoLines = (await create(orderBody({ deliveryDate: "2026-11-02" }))).body.order; // 1000 jeans (main), 300 fabric
    const oneLine = (await create(orderBody({ deliveryDate: "2026-11-03", lines: [{ itemId: ids.fabric, quantity: 300, rateCny: 2 }] }))).body.order;
    const office = (await ctx.db.select({ id: locations.id }).from(locations).where(eq(locations.name, "Guangzhou office")))[0]!.id;
    const receive = async (orderId: string, quantities: number[]) => {
      const lines = await ctx.db.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(orderLines.position);
      const receipt = (await ctx.db.insert(receipts).values({ orderId, receivedOn: "2026-10-26", locationId: office, receivedBy: ids.userId, bundles: 1 }).returning())[0]!;
      await ctx.db.insert(receiptLines).values(quantities.map((quantity, i) => ({ receiptId: receipt.id, orderLineId: lines[i]!.id, quantity })));
      await ctx.db.update(orders).set({ stage: 2 }).where(eq(orders.id, orderId));
    };
    const flags = async () => ((await get("/deliveries")).body as { po: string; received: number; fullyReceived: boolean }[]).map((r) => [r.po, r.received, r.fullyReceived]);

    await receive(twoLines.id, [1000, 0]);
    await receive(oneLine.id, [299]);
    expect(await flags()).toEqual([
      [twoLines.po, 1000, false], // the main line is complete, the fabric is still awaited
      [oneLine.po, 299, false],
    ]);
    await receive(twoLines.id, [0, 300]);
    await receive(oneLine.id, [1]);
    expect(await flags()).toEqual([
      [twoLines.po, 1000, true],
      [oneLine.po, 300, true],
    ]);
  });
});

describe("PAY-1 GET /payments", () => {
  it("gives every order's balance and next due date, and every payment record", async () => {
    const withDeposits = (await create(orderBody())).body.order;
    const bare = (await create(orderBody({ deposits: [] }))).body.order;
    await ctx.db.insert(payments).values([
      { orderId: withDeposits.id, kind: "Balance", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 5000, status: "due", dueDate: "2026-12-20" },
      { orderId: withDeposits.id, kind: "Balance", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 3000, status: "due", dueDate: "2026-12-05" },
    ]);

    const res = await get("/payments");
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([
      {
        orderId: bare.id,
        po: bare.po,
        supplier: "Guangzhou Textile Co.",
        currency: "CNY",
        orderValueCny: 14975,
        paidCny: 0,
        paidInr: 0,
        supplierPaidCny: 0,
        supplierPaidInr: 0,
        balanceCny: 14975,
        depositRequiredCny: null,
        depositPaidCny: 0,
        depositPendingCny: null,
        depositStatus: "none",
        nextDue: null,
      },
      {
        orderId: withDeposits.id,
        po: withDeposits.po,
        supplier: "Guangzhou Textile Co.",
        currency: "CNY",
        orderValueCny: 14975,
        paidCny: 2234.56,
        paidInr: 26562.25,
        supplierPaidCny: 1234.56,
        supplierPaidInr: 14662.25,
        balanceCny: 13740.44, // what the supplier is owed: due payments are not paid, the agent deposit is freight
        depositRequiredCny: null,
        depositPaidCny: 1234.56,
        depositPendingCny: null,
        depositStatus: "none",
        nextDue: "2026-12-05",
      },
    ]);
    expect(res.body.payments).toHaveLength(4);
    expect(res.body.payments[0]).toEqual({
      id: expect.any(String),
      orderId: withDeposits.id,
      po: withDeposits.po,
      currency: "CNY",
      kind: "Balance",
      payee: "Guangzhou Textile Co.",
      payeeRole: "supplier",
      amountCny: 5000,
      status: "due",
      paidOn: null,
      dueDate: "2026-12-20",
      rateInr: null,
      mode: null,
      reference: "",
      notes: "",
      amountInr: null, // due: no rate yet
    });
    expect(res.body.payments).toContainEqual(expect.objectContaining({ kind: "Deposit", status: "paid", amountCny: 1234.56, rateInr: 11.8765, paidOn: "2026-10-21", dueDate: null, mode: "Bank transfer" }));
  });
});

describe("currencies (migration 0006): CNY, USD and INR orders", () => {
  const supplierDeposit = (overrides: object = {}) => ({
    payee: "Guangzhou Textile Co.",
    payeeRole: "supplier",
    amountCny: 1000,
    paidOn: "2026-10-21",
    rateInr: 88.25,
    mode: "Wire",
    ...overrides,
  });

  it("stores the order's currency (CNY when left out) and returns it on ORD-1, ORD-4 and PAY-1", async () => {
    const usd = (await create(orderBody({ currency: "USD", deposits: [supplierDeposit()] }))).body.order;
    const cny = (await create(orderBody({ deposits: [] }))).body.order;
    const stored = await ctx.db.select({ id: orders.id, currency: orders.currency }).from(orders);
    expect(stored).toEqual(expect.arrayContaining([{ id: usd.id, currency: "USD" }, { id: cny.id, currency: "CNY" }]));

    const listed = (await get("/orders")).body.find((row: { id: string }) => row.id === usd.id);
    expect(listed).toMatchObject({ currency: "USD", orderValueCny: 14975, paidCny: 1000, paidInr: 88250 });
    expect((await get(`/orders/${usd.po}`)).body).toMatchObject({ currency: "USD", balanceCny: 13975 });
    const pay = (await get("/payments")).body;
    expect(pay.orders.find((row: { orderId: string }) => row.orderId === usd.id)).toMatchObject({ currency: "USD", paidInr: 88250 });
    expect(pay.payments).toEqual([expect.objectContaining({ orderId: usd.id, currency: "USD", amountCny: 1000, rateInr: 88.25 })]);
  });

  it("an INR order's deposits take no rate: stored as 1, so INR is the amount", async () => {
    const inr = await create(orderBody({ currency: "INR", deposits: [supplierDeposit({ rateInr: undefined, amountCny: 50000 }), supplierDeposit({ rateInr: 1 })] }));
    expect(inr.status).toBe(201);
    const rows = await ctx.db.select({ rateInr: payments.rateInr }).from(payments).where(eq(payments.orderId, inr.body.order.id));
    expect(rows).toEqual([{ rateInr: 1 }, { rateInr: 1 }]);
    expect((await get("/orders")).body[0]).toMatchObject({ currency: "INR", paidCny: 51000, paidInr: 51000 });
  });

  it("refuses a rate on an INR deposit, a missing rate otherwise, and another currency, storing nothing", async () => {
    const cases: [object, Record<string, string>][] = [
      [{ currency: "INR", deposits: [supplierDeposit({ rateInr: 12 })] }, { deposits: MESSAGES.rateForInr }],
      [{ currency: "USD", deposits: [supplierDeposit({ rateInr: undefined })] }, { deposits: MESSAGES.rateInr }],
      [{ deposits: [supplierDeposit({ rateInr: undefined })] }, { deposits: MESSAGES.rateInr }],
      [{ currency: "EUR" }, { currency: MESSAGES.currency }],
      [{ currency: "usd" }, { currency: MESSAGES.currency }],
    ];
    for (const [overrides, fields] of cases) {
      const res = await create(orderBody(overrides));
      expect(res.status, JSON.stringify(overrides)).toBe(422);
      expect(res.body.error.fields).toEqual(fields);
    }
    expect(await countOrders()).toBe(0);
  });

  it("ORD-2 gives each supplier's currency, the new-order default", async () => {
    await ctx.db.update(suppliers).set({ currency: "USD" }).where(eq(suppliers.id, ids.supplier));
    expect((await get("/orders/options")).body.suppliers[0]).toMatchObject({ id: ids.supplier, currency: "USD" });
  });

  it("the database refuses any other currency (check constraint)", async () => {
    await expect(
      ctx.db.insert(orders).values({ poNumber: "PO-1", supplierId: ids.supplier, orderDate: "2026-10-20", deliveryDate: "2026-10-30", currency: "EUR" as "CNY" }),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "orders_currency_check" } });
  });
});
