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
    expect(res.body.suppliers[0]).toEqual({ id: ids.supplier, name: "Guangzhou Textile Co.", contactPerson: "Mr. Zhao Lin", phone: "+86 138 0013 2244", city: "Guangzhou" });
    expect(res.body.items).toHaveLength(8);
    expect(res.body.items).toContainEqual({ id: ids.jeans, name: "Denim jeans", unit: "pcs" });
    expect(res.body.items).toContainEqual({ id: ids.fabric, name: "Cotton fabric", unit: "m" });
    expect(res.body.agents).toEqual([{ id: expect.any(String), name: "Sino Freight" }]);
  });

  // Regression (2026-10-31, "deleted product still on the order page"): New order and Edit order offer only ORD-2's
  // items, so a deleted or deactivated item must never be listed here, while the orders that already use it keep it.
  it("leaves out deactivated and deleted items; an order that uses a deactivated item still shows it", async () => {
    const order = (await create(orderBody({ deposits: [] }))).body.order as { id: string; po: string };
    const spare = await http.post("/items", { name: "Spare buttons", countedIn: "Pieces", perBundle: 100 }).set("Cookie", management);
    expect(spare.status).toBe(201);
    expect((await http.patch(`/items/${ids.jeans}`, { status: "Inactive" }).set("Cookie", management)).status).toBe(200);
    expect((await http.delete(`/items/${spare.body.item.id}`).set("Cookie", management)).status).toBe(204);
    // An item on an order can't be deleted (BR-06), so its order lines are never removed.
    expect((await http.delete(`/items/${ids.fabric}`).set("Cookie", management)).status).toBe(409);

    const offered = (await get("/orders/options")).body.items.map((row: { id: string }) => row.id);
    expect(offered).not.toContain(ids.jeans);
    expect(offered).not.toContain(spare.body.item.id);
    expect(offered).toContain(ids.fabric);

    const detail = (await get(`/orders/${order.po}`)).body;
    expect(detail.lines.map((line: { item: { name: string } }) => line.item.name)).toEqual(["Denim jeans", "Cotton fabric"]);
    expect((await get("/orders")).body.find((row: { po: string }) => row.po === order.po).item).toBe("Denim jeans");
    expect(await ctx.db.select().from(orderLines).where(eq(orderLines.orderId, order.id))).toHaveLength(2);
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
      item: "Denim jeans",
      quantity: 1000,
      unit: "pcs",
      received: 0,
      orderValueCny: 14975, // 1000 * 12.5 + 300 * 8.25
      paidCny: 2234.56,
      paidInr: 26562.25, // 1234.56 * 11.8765 = 14662.25 (rounded) + 1000 * 11.9
    });
    expect(list.body[0]).toMatchObject({ item: "Cotton fabric", quantity: 50, unit: "m", orderValueCny: 150, paidCny: 0, paidInr: 0 });
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
      [{ deposits: [{ payee: "X", payeeRole: "supplier", amountCny: 0, paidOn: "2026-10-21", rateInr: 11, mode: "Cash" }] }, { deposits: MESSAGES.amount }],
      [{ deposits: [{ payee: "X", payeeRole: "supplier", amountCny: 5, paidOn: "2026-10-21", rateInr: 11, mode: " " }] }, { deposits: MESSAGES.mode }],
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
    expect((await create(orderBody({ po: "PO-1" }))).status).toBe(400);
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
      { orderId: bare.id, po: bare.po, supplier: "Guangzhou Textile Co.", orderValueCny: 14975, paidCny: 0, paidInr: 0, balanceCny: 14975, nextDue: null },
      {
        orderId: withDeposits.id,
        po: withDeposits.po,
        supplier: "Guangzhou Textile Co.",
        orderValueCny: 14975,
        paidCny: 2234.56,
        paidInr: 26562.25,
        balanceCny: 12740.44, // due payments are not paid
        nextDue: "2026-12-05",
      },
    ]);
    expect(res.body.payments).toHaveLength(4);
    expect(res.body.payments[0]).toEqual({
      id: expect.any(String),
      orderId: withDeposits.id,
      po: withDeposits.po,
      kind: "Balance",
      payee: "Guangzhou Textile Co.",
      payeeRole: "supplier",
      amountCny: 5000,
      status: "due",
      paidOn: null,
      dueDate: "2026-12-20",
      rateInr: null,
      mode: null,
    });
    expect(res.body.payments).toContainEqual(expect.objectContaining({ kind: "Deposit", status: "paid", amountCny: 1234.56, rateInr: 11.8765, paidOn: "2026-10-21", dueDate: null, mode: "Bank transfer" }));
  });
});
