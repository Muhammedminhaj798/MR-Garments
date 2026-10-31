import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { containerLines, containers, items, locations, orderLines, orders, payments, receiptLines, receipts, shippingAgents, suppliers, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { MESSAGES } from "./orders.routes";

// ORD-5 PATCH and ORD-6 DELETE /orders/:po. Orders are created through ORD-3; later records are inserted directly.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

const LOCKED_WAREHOUSE = "This order has reached the warehouse, so it can't be changed.";
const LOCKED_RECEIVED = "Goods have been received for this order, so only the delivery date can change.";
const LINE_CHANGED = "A line on this order changed. Reload the order and try again.";

let management = "";
let ids: { supplier: string; jeans: string; fabric: string; polo: string; office: string; agent: string; userId: string };
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  const idOf = async (table: typeof items | typeof suppliers | typeof locations | typeof shippingAgents, name: string) =>
    (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;
  ids = {
    supplier: await idOf(suppliers, "Guangzhou Textile Co."),
    jeans: await idOf(items, "Denim jeans"),
    fabric: await idOf(items, "Cotton fabric"),
    polo: await idOf(items, "Polo shirts"),
    office: await idOf(locations, "Guangzhou office"),
    agent: await idOf(shippingAgents, "Sino Freight"),
    userId: (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.management)))[0]!.id,
  };
});

const linesOf = (orderId: string) =>
  ctx.db
    .select({ id: orderLines.id, itemId: orderLines.itemId, position: orderLines.position, quantity: orderLines.quantity, rateCny: orderLines.rateCny })
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId))
    .orderBy(asc(orderLines.position));
/** An order through ORD-3: jeans 1000 x 12.5 and fabric 300 x 8.25 (total 14,975), ordered 20 Oct, due 30 Nov. */
async function createOrder(overrides: object = {}) {
  const body = {
    supplierId: ids.supplier,
    orderDate: "2026-10-20",
    deliveryDate: "2026-11-30",
    lines: [
      { itemId: ids.jeans, quantity: 1000, rateCny: 12.5 },
      { itemId: ids.fabric, quantity: 300, rateCny: 8.25 },
    ],
    deposits: [],
    ...overrides,
  };
  const res = await http.post("/orders", body).set("Cookie", management);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const order = res.body.order as { id: string; po: string };
  return { ...order, lines: await linesOf(order.id) };
}
const deposit = (amountCny: number) => ({ payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny, paidOn: "2026-10-21", rateInr: 11.8, mode: "Bank transfer" });
const edit = (po: string, body: object, cookie = management) => http.patch(`/orders/${po}`, body).set("Cookie", cookie);
const remove = (po: string, cookie = management) => http.delete(`/orders/${po}`).set("Cookie", cookie);
const setStage = (orderId: string, stage: number) => ctx.db.update(orders).set({ stage }).where(eq(orders.id, orderId));
const orderRow = async (orderId: string) => (await ctx.db.select().from(orders).where(eq(orders.id, orderId)))[0];
const addReceipt = async (orderId: string, orderLineId: string) => {
  const receipt = (await ctx.db.insert(receipts).values({ orderId, receivedOn: "2026-10-26", locationId: ids.office, receivedBy: ids.userId, bundles: 8 }).returning())[0]!;
  await ctx.db.insert(receiptLines).values({ receiptId: receipt.id, orderLineId, quantity: 100 });
};
const expectFields = (res: { status: number; body: { error: unknown } }, fields: Record<string, string>) => {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body.error).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields });
};
const expectConflict = (res: { status: number; body: { error: unknown } }, code: string, message: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(res.body.error).toEqual({ code, message });
};

describe("access", () => {
  it("is 401 signed out on both routes", async () => {
    const order = await createOrder();
    expect((await http.patch(`/orders/${order.po}`, { deliveryDate: "2026-12-01" })).status).toBe(401);
    expect((await http.delete(`/orders/${order.po}`)).status).toBe(401);
    expect(await orderRow(order.id)).toMatchObject({ deliveryDate: "2026-11-30" });
  });

  it("lets Management and Procurement edit, and refuses Accounts and every staff role", async () => {
    const order = await createOrder();
    for (const email of [SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      const res = await edit(order.po, { deliveryDate: "2026-12-01" }, await signInAs(ctx, email));
      expect(res.status, email).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    expect(await orderRow(order.id)).toMatchObject({ deliveryDate: "2026-11-30" });
    const procurement = await edit(order.po, { deliveryDate: "2026-12-01" }, await signInAs(ctx, SEEDED.procurement));
    expect(procurement.status).toBe(200);
    expect(await orderRow(order.id)).toMatchObject({ deliveryDate: "2026-12-01" });
  });

  it("lets only Management delete", async () => {
    const order = await createOrder();
    for (const email of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      const res = await remove(order.po, await signInAs(ctx, email));
      expect(res.status, email).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    expect(await orderRow(order.id)).toBeDefined();
  });
});

describe("ORD-5 PATCH /orders/:po", () => {
  it("changes the dates and adds, updates, removes and reorders lines at stage 1", async () => {
    const order = await createOrder();
    const [jeans, fabric] = order.lines as [(typeof order.lines)[0], (typeof order.lines)[0]];
    const res = await edit(order.po, {
      orderDate: "2026-10-22",
      deliveryDate: "2026-12-15",
      lines: [
        { itemId: ids.polo, quantity: 50, rateCny: 20 },
        { id: jeans.id, itemId: ids.jeans, quantity: 900, rateCny: 12 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ order: { id: order.id, po: order.po, stage: 1, orderDate: "2026-10-22", deliveryDate: "2026-12-15" } });
    const lines = await linesOf(order.id);
    expect(lines).toEqual([
      { id: expect.any(String), itemId: ids.polo, position: 0, quantity: 50, rateCny: 20 },
      { id: jeans.id, itemId: ids.jeans, position: 1, quantity: 900, rateCny: 12 },
    ]);
    expect(lines.map((line) => line.id)).not.toContain(fabric.id);
    // The order page shows the new main line.
    expect((await http.get(`/orders/${order.po}`).set("Cookie", management)).body).toMatchObject({ item: "Polo shirts", quantity: 50, orderValueCny: 11800 });
    // Swapping two kept lines doesn't trip the one-line-per-position index.
    const polo = lines[0]!;
    const swap = await edit(order.po, {
      lines: [
        { id: jeans.id, itemId: ids.jeans, quantity: 900, rateCny: 12 },
        { id: polo.id, itemId: ids.polo, quantity: 50, rateCny: 20 },
      ],
    });
    expect(swap.status, JSON.stringify(swap.body)).toBe(200);
    expect((await linesOf(order.id)).map((line) => [line.id, line.position])).toEqual([
      [jeans.id, 0],
      [polo.id, 1],
    ]);
  });

  it("changes only the delivery date at stages 2-5", async () => {
    const order = await createOrder();
    for (const stage of [2, 5]) {
      await setStage(order.id, stage);
      const res = await edit(order.po, { deliveryDate: `2026-12-0${stage}` });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.order).toMatchObject({ stage, orderDate: "2026-10-20", deliveryDate: `2026-12-0${stage}` });
    }
    const line = order.lines[0]!;
    for (const body of [
      { orderDate: "2026-10-21" },
      { lines: [{ id: line.id, itemId: ids.jeans, quantity: 5, rateCny: 1 }] },
      { deliveryDate: "2026-12-09", lines: [{ id: line.id, itemId: ids.jeans, quantity: 5, rateCny: 1 }] },
    ]) {
      expectConflict(await edit(order.po, body), "order_locked", LOCKED_RECEIVED);
    }
    expect(await orderRow(order.id)).toMatchObject({ orderDate: "2026-10-20", deliveryDate: "2026-12-05" });
    expect(await linesOf(order.id)).toEqual(order.lines);
  });

  it("changes nothing at stage 6", async () => {
    const order = await createOrder();
    await setStage(order.id, 6);
    expectConflict(await edit(order.po, { deliveryDate: "2026-12-01" }), "order_locked", LOCKED_WAREHOUSE);
    expect(await orderRow(order.id)).toMatchObject({ deliveryDate: "2026-11-30" });
  });

  it("refuses a delivery date before the order date, using the saved date for a key not sent (BR-09)", async () => {
    const order = await createOrder();
    for (const body of [{ deliveryDate: "2026-10-19" }, { orderDate: "2026-12-01" }, { orderDate: "2026-11-02", deliveryDate: "2026-11-01" }]) {
      expectFields(await edit(order.po, body), { deliveryDate: MESSAGES.deliveryBeforeOrder });
    }
    await setStage(order.id, 3);
    expectFields(await edit(order.po, { deliveryDate: "2026-10-19" }), { deliveryDate: MESSAGES.deliveryBeforeOrder });
    expect(await orderRow(order.id)).toMatchObject({ orderDate: "2026-10-20", deliveryDate: "2026-11-30" });
  });

  it("refuses an inactive item on a new or changed line, but keeps a saved line whose item is now inactive", async () => {
    const order = await createOrder();
    const [jeans, fabric] = order.lines as [(typeof order.lines)[0], (typeof order.lines)[0]];
    await ctx.db.update(items).set({ status: "Inactive" }).where(eq(items.id, ids.fabric));
    const keepJeans = { id: jeans.id, itemId: ids.jeans, quantity: 1000, rateCny: 12.5 };
    for (const added of [
      { itemId: ids.fabric, quantity: 10, rateCny: 1 }, // new line, inactive item
      { id: fabric.id, itemId: ids.fabric, quantity: 10, rateCny: 1 }, // kept, but jeans moves to fabric below
      { itemId: "00000000-0000-4000-8000-000000000000", quantity: 10, rateCny: 1 }, // unknown item
    ]) {
      const lines = "id" in added ? [{ ...keepJeans, itemId: ids.fabric }, added] : [keepJeans, added];
      expectFields(await edit(order.po, { lines }), { lines: MESSAGES.item });
    }
    expect(await linesOf(order.id)).toEqual(order.lines);
    const res = await edit(order.po, { lines: [keepJeans, { id: fabric.id, itemId: ids.fabric, quantity: 200, rateCny: 8.25 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await linesOf(order.id))[1]).toMatchObject({ id: fabric.id, itemId: ids.fabric, quantity: 200 });
  });

  it("refuses a line id that isn't one of this order's lines", async () => {
    const order = await createOrder();
    const other = await createOrder();
    const line = (id: string) => ({ id, itemId: ids.jeans, quantity: 10, rateCny: 1 });
    for (const lines of [
      [line(other.lines[0]!.id)],
      [line("00000000-0000-4000-8000-000000000000")],
      [line(order.lines[0]!.id), line(order.lines[0]!.id)],
      [line("not-a-line")],
    ]) {
      expectFields(await edit(order.po, { lines }), { lines: LINE_CHANGED });
    }
    expect(await linesOf(order.id)).toEqual(order.lines);
    expect(await linesOf(other.id)).toEqual(other.lines);
  });

  it("refuses a total below the paid payments, in CNY with Indian grouping", async () => {
    const order = await createOrder({ lines: [{ itemId: ids.jeans, quantity: 10000, rateCny: 12.5 }], deposits: [deposit(100000), deposit(23456.78)] });
    const id = order.lines[0]!.id;
    // A due payment is not paid, so it doesn't count.
    await ctx.db.insert(payments).values({ orderId: order.id, kind: "Balance", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 50000, status: "due", dueDate: "2026-12-01" });
    expectFields(await edit(order.po, { lines: [{ id, itemId: ids.jeans, quantity: 9000, rateCny: 12.5 }] }), {
      lines: "The order total can't be less than the ¥1,23,456.78 already paid.",
    });
    expect(await linesOf(order.id)).toEqual(order.lines);
    const equal = await edit(order.po, { lines: [{ id, itemId: ids.jeans, quantity: 1, rateCny: 123456.78 }] });
    expect(equal.status, JSON.stringify(equal.body)).toBe(200);
  });

  it("is 404 for an unknown or malformed PO", async () => {
    for (const po of ["PO-9999", "po-2050", "2050"]) {
      const res = await edit(po, { deliveryDate: "2026-12-01" });
      expect(res.status, po).toBe(404);
      expect(res.body.error).toEqual({ code: "not_found", message: "Order not found." });
    }
  });

  it("is 400 for an empty body or an unknown key, and 422 with the ORD-3 messages", async () => {
    const order = await createOrder();
    const line = { itemId: ids.jeans, quantity: 10, rateCny: 1 };
    for (const body of [{}, { supplierId: ids.supplier }, { stage: 2 }, { lines: [{ ...line, position: 0 }] }]) {
      const res = await edit(order.po, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
    expectFields(await edit(order.po, { orderDate: "soon", lines: [] }), { orderDate: MESSAGES.orderDate, lines: MESSAGES.lines });
    expectFields(await edit(order.po, { lines: [{ ...line, quantity: 0 }] }), { lines: MESSAGES.quantity });
    expectFields(await edit(order.po, { lines: Array.from({ length: 51 }, () => line) }), { lines: MESSAGES.tooManyLines });
    expect(await linesOf(order.id)).toEqual(order.lines);
  });

  it("refuses line and date edits on a stage-1 order whose lines already have goods (data outside the API)", async () => {
    const order = await createOrder();
    await addReceipt(order.id, order.lines[1]!.id); // inserted directly, so the order stays at stage 1
    const before = await ctx.db.select().from(receiptLines);
    expectConflict(await edit(order.po, { lines: [{ id: order.lines[0]!.id, itemId: ids.jeans, quantity: 1000, rateCny: 12.5 }] }), "order_locked", LOCKED_RECEIVED);
    expectConflict(await edit(order.po, { orderDate: "2026-10-19" }), "order_locked", LOCKED_RECEIVED);
    expect(await linesOf(order.id)).toHaveLength(2);
    expect(await ctx.db.select().from(receiptLines)).toEqual(before);
    const res = await edit(order.po, { deliveryDate: "2026-12-05" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe("ORD-6 DELETE /orders/:po", () => {
  it("deletes an order nothing depends on, with its lines", async () => {
    const order = await createOrder();
    const kept = await createOrder();
    const res = await remove(order.po);
    expect(res.status).toBe(204);
    expect(await orderRow(order.id)).toBeUndefined();
    expect(await linesOf(order.id)).toEqual([]);
    expect((await http.get(`/orders/${order.po}`).set("Cookie", management)).status).toBe(404);
    expect(await linesOf(kept.id)).toHaveLength(2);
  });

  it("refuses an order with payments or receipts, naming them, and changes nothing", async () => {
    const order = await createOrder({ deposits: [deposit(1000), deposit(500)] });
    expectConflict(await remove(order.po), "in_use", "This order has 2 payments, so it can't be deleted.");
    await addReceipt(order.id, order.lines[0]!.id);
    expectConflict(await remove(order.po), "in_use", "This order has 2 payments and 1 receipt, so it can't be deleted.");
    expect(await ctx.db.select().from(payments).where(eq(payments.orderId, order.id))).toHaveLength(2);
    expect(await ctx.db.select().from(receipts).where(eq(receipts.orderId, order.id))).toHaveLength(1);
    expect(await linesOf(order.id)).toEqual(order.lines);

    const received = await createOrder();
    await addReceipt(received.id, received.lines[1]!.id);
    expectConflict(await remove(received.po), "in_use", "This order has 1 receipt, so it can't be deleted.");
  });

  // Every foreign key to orders and order_lines is ON DELETE CASCADE, so a dependent ORD-6 doesn't count would be
  // deleted with the order, not refused. A new referencing table must fail here until ORD-6 counts it.
  it("counts every table that references orders or order lines", async () => {
    const found = await ctx.db.execute(sql`
      select kcu.table_name || '.' || kcu.column_name || ' -> ' || ccu.table_name as name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public' and ccu.table_name in ('orders', 'order_lines')`);
    expect(found.rows.map((row) => String(row.name)).sort()).toEqual(
      [
        "container_lines.order_line_id -> order_lines", // containers
        "order_lines.order_id -> orders", // the order's own lines, deleted with it
        "payments.order_id -> orders", // payments
        "receipt_lines.order_line_id -> order_lines", // receipts
        "receipts.order_id -> orders", // receipts
        "warehouse_receipt_lines.order_line_id -> order_lines", // warehouse receipts
      ].sort(),
    );
  });

  it("counts a due payment and a container reached through the lines", async () => {
    const order = await createOrder();
    await ctx.db.insert(payments).values({ orderId: order.id, kind: "Balance", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 50, status: "due", dueDate: "2026-12-01" });
    const container = (await ctx.db.insert(containers).values({ number: "MSCU1234567", shippingAgentId: ids.agent, terms: "FOB", eta: "2026-12-20" }).returning())[0]!;
    await ctx.db.insert(containerLines).values(order.lines.map((line) => ({ containerId: container.id, orderLineId: line.id, bundles: 1, quantity: 10 })));
    expectConflict(await remove(order.po), "in_use", "This order has 1 payment and 1 container, so it can't be deleted.");
    expect(await ctx.db.select().from(containerLines)).toHaveLength(2);
  });

  it("is 404 for an unknown or malformed PO", async () => {
    for (const po of ["PO-9999", "po-2050"]) {
      const res = await remove(po);
      expect(res.status, po).toBe(404);
      expect(res.body.error).toEqual({ code: "not_found", message: "Order not found." });
    }
  });
});
