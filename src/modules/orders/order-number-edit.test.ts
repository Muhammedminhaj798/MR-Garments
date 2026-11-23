import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, locations, notifications, orders, payments, shippingAgents, supplierLedgerEntries, suppliers, users } from "../../db/schema";
import { api, createTestContext, receiveOrder, resetData, SEEDED, signInAs } from "../../test/harness";
import { MESSAGES } from "./orders.routes";

// ORD-5 `po`: renumbering an order (docs/contracts.md ORD-5). The order keeps its id, so everything linked to it by id
// follows; notification links follow the new number; the supplier ledger shows it while keeping its stored number.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let ids: { supplier: string; jeans: string; office: string; userId: string; sino: string };
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  const idOf = async (table: typeof items | typeof suppliers | typeof locations, name: string) => (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;
  ids = {
    supplier: await idOf(suppliers, "Guangzhou Textile Co."),
    jeans: await idOf(items, "Denim jeans"),
    office: await idOf(locations, "Guangzhou office"),
    userId: (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.management)))[0]!.id,
    sino: (await ctx.db.select({ id: shippingAgents.id }).from(shippingAgents).where(eq(shippingAgents.name, "Sino Freight")))[0]!.id,
  };
});
/** PAY-2: a shipping-agent payment on the order (order-linked, sea freight). */
const payAgent = (orderId: string, amountCny: number) =>
  http
    .post("/payments")
    .send({ orderId, payeeRole: "agent", agentId: ids.sino, kind: "Balance", amountCny, paidOn: "2026-10-21", rateInr: 12, mode: "Bank transfer", clientRequestId: randomUUID() })
    .set("Cookie", management);

/** ORD-3: jeans 100 x 10 (¥1,000), with an optional typed PO. */
async function createOrder(po?: string) {
  const res = await http
    .post("/orders")
    .send({ ...(po ? { po } : {}), supplierId: ids.supplier, orderDate: "2026-10-20", deliveryDate: "2026-11-30", lines: [{ itemId: ids.jeans, quantity: 100, rateCny: 10 }], deposits: [] })
    .set("Cookie", management);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.order as { id: string; po: string };
}
const edit = (po: string, body: object) => http.patch(`/orders/${encodeURIComponent(po)}`).send(body).set("Cookie", management);
const get = (path: string) => http.get(path).set("Cookie", management);
const poOf = async (id: string) => (await ctx.db.select({ po: orders.poNumber }).from(orders).where(eq(orders.id, id)))[0]!.po;
const expectPoProblem = (res: { status: number; body: { error: unknown } }, message: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body.error).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields: { po: message } });
};

describe("ORD-5 po: renumbering an order", () => {
  it("renumbers the order in place: same id, the new number everywhere, the old one gone", async () => {
    const order = await createOrder();
    const res = await edit(order.po, { po: "MR/2026/001" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order).toMatchObject({ id: order.id, po: "MR/2026/001", stage: 1 });
    expect(await ctx.db.select({ id: orders.id }).from(orders)).toEqual([{ id: order.id }]);

    expect((await get(`/orders/${encodeURIComponent("MR/2026/001")}`)).body).toMatchObject({ id: order.id, po: "MR/2026/001", orderValueCny: 0, poValueCny: 1000 });
    expect((await get(`/orders/${order.po}`)).status).toBe(404);
    expect((await get("/orders")).body.map((row: { id: string; po: string }) => [row.id, row.po])).toEqual([[order.id, "MR/2026/001"]]);
    // Searched and reported by the new number.
    expect((await get("/reports/orders?po=2026%2F001")).body.rows.map((row: { id: string; po: string }) => [row.id, row.po])).toEqual([[order.id, "MR/2026/001"]]);
    expect((await get(`/reports/orders?po=${order.po}`)).body.rows).toEqual([]);
    expect((await get(`/orders/${encodeURIComponent("MR/2026/001")}/report`)).body.order).toMatchObject({ po: "MR/2026/001" });
    expect((await get("/payments")).body.orders.map((row: { po: string }) => row.po)).toEqual(["MR/2026/001"]);
  });

  it("saves the same number as no change, and a letter-case change as a rename of this order (not a duplicate)", async () => {
    const order = await createOrder("VM-11340");
    const same = await edit(order.po, { po: "VM-11340", deliveryDate: "2026-12-01" });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body.order).toMatchObject({ id: order.id, po: "VM-11340", deliveryDate: "2026-12-01" });
    const trimmed = await edit(order.po, { po: "  VM-11340  " });
    expect(trimmed.status).toBe(200);
    expect(await poOf(order.id)).toBe("VM-11340");
    const cased = await edit(order.po, { po: "vm-11340" });
    expect(cased.status, JSON.stringify(cased.body)).toBe(200);
    expect(await poOf(order.id)).toBe("vm-11340");
  });

  it("refuses a number another order uses, in any letter case, and changes nothing", async () => {
    const first = await createOrder();
    const second = await createOrder();
    expectPoProblem(await edit(second.po, { po: first.po.toLowerCase(), deliveryDate: "2026-12-05" }), MESSAGES.poTaken);
    expect(await poOf(second.id)).toBe(second.po);
    expect((await get(`/orders/${second.po}`)).body.deliveryDate).toBe("2026-11-30");
  });

  it("refuses an empty, blank, too long or non-text number with ORD-3's messages", async () => {
    const order = await createOrder();
    expectPoProblem(await edit(order.po, { po: "" }), MESSAGES.po);
    expectPoProblem(await edit(order.po, { po: "   " }), MESSAGES.po);
    expectPoProblem(await edit(order.po, { po: 2051 }), MESSAGES.po);
    expectPoProblem(await edit(order.po, { po: "X".repeat(51) }), MESSAGES.poTooLong);
    expect(await poOf(order.id)).toBe(order.po);
  });

  it("renumbers at stages 2-5 (only the number, the delivery date and the deposit required change there), never at stage 6", async () => {
    const order = await createOrder();
    await ctx.db.update(orders).set({ stage: 4 }).where(eq(orders.id, order.id));
    const res = await edit(order.po, { po: "PO-STAGE-4" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await ctx.db.update(orders).set({ stage: 6 }).where(eq(orders.id, order.id));
    const locked = await edit("PO-STAGE-4", { po: "PO-STAGE-6" });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("order_locked");
    expect(await poOf(order.id)).toBe("PO-STAGE-4");
  });

  it("lets only one of two concurrent edits take the same number; the other gets the duplicate message", async () => {
    for (let round = 0; round < 3; round++) {
      const a = await createOrder();
      const b = await createOrder();
      const target = `PO-RACE-${round}`;
      const results = await Promise.all([edit(a.po, { po: target }), edit(b.po, { po: target })]);
      expect(results.map((res) => res.status).sort()).toEqual([200, 422]);
      expectPoProblem(results.find((res) => res.status === 422)!, MESSAGES.poTaken);
      const numbers = [await poOf(a.id), await poOf(b.id)];
      expect(numbers.filter((po) => po === target)).toHaveLength(1);
    }
  });

  it("refuses a rename to a number a concurrent ORD-3 create takes, or the create's, never both", async () => {
    const order = await createOrder();
    const [renamed, created] = await Promise.all([
      edit(order.po, { po: "PO-BOTH" }),
      http
        .post("/orders")
        .send({ po: "PO-BOTH", supplierId: ids.supplier, orderDate: "2026-10-20", deliveryDate: "2026-11-30", lines: [{ itemId: ids.jeans, quantity: 1, rateCny: 1 }], deposits: [] })
        .set("Cookie", management),
    ]);
    // Exactly one wins (rename 200 or create 201); the loser gets the duplicate message.
    expect([renamed.status === 200, created.status === 201].filter(Boolean)).toHaveLength(1);
    expectPoProblem(renamed.status === 200 ? created : renamed, MESSAGES.poTaken);
    expect((await ctx.db.select({ id: orders.id }).from(orders).where(eq(orders.poNumber, "PO-BOTH"))).length).toBe(1);
  });

  it("keeps payments, receipts and the supplier ledger linked by id, with every amount unchanged", async () => {
    // A supplier payment (PAY-2, against the supplier), an agent payment on the order and a receipt.
    const paid = await http
      .post("/payments")
      .send({ supplierId: ids.supplier, amount: 300, paidOn: "2026-10-19", rateInr: 12.5, mode: "Bank transfer", clientRequestId: randomUUID() })
      .set("Cookie", management);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const order = await createOrder();
    const freight = await payAgent(order.id, 200);
    expect(freight.status, JSON.stringify(freight.body)).toBe(201);
    // Received in full, as REC-3 posts it: worth ¥1,000.
    const receipt = { id: (await receiveOrder(ctx, order.id)).receiptId };
    const before = (await get(`/orders/${order.po}`)).body;
    const ledgerBefore = await ctx.db.select().from(supplierLedgerEntries).orderBy(supplierLedgerEntries.createdAt);
    const paymentsBefore = await ctx.db.select().from(payments);

    expect((await edit(order.po, { po: "PO-RENAMED" })).status).toBe(200);

    const after = (await get("/orders/PO-RENAMED")).body;
    for (const key of ["id", "orderValueCny", "settledCny", "settledInr", "outstandingCny", "paymentStatus", "agentPaidCny", "paidInr", "slices", "supplierAccount"]) expect(after[key], key).toEqual(before[key]);
    expect(after.payments.map((p: { id: string; po: string }) => [p.id, p.po])).toEqual([[freight.body.payment.id, "PO-RENAMED"]]);
    expect(after.receipts.map((r: { id: string }) => r.id)).toEqual([receipt.id]);
    expect(after.settledCny).toBe(300);
    // The ledger shows the order's current number; its stored rows (and every payment row) are untouched.
    expect(await ctx.db.select().from(supplierLedgerEntries).orderBy(supplierLedgerEntries.createdAt)).toEqual(ledgerBefore);
    expect(ledgerBefore.find((row) => row.entryType === "order_debit")!.poNumber).toBe(order.po);
    expect(await ctx.db.select().from(payments)).toEqual(paymentsBefore);
    const statement = (await get(`/suppliers/${ids.supplier}/ledger`)).body;
    expect(statement.entries.filter((e: { entryType: string }) => e.entryType === "order_debit").map((e: { po: string; orderId: string }) => [e.po, e.orderId])).toEqual([["PO-RENAMED", order.id]]);
    expect((await get(`/reports/payments-per-supplier/${ids.supplier}`)).body.orders.rows.map((r: { po: string }) => r.po)).toEqual(["PO-RENAMED"]);
  });

  it("points notification links to the order at the new number, keeping their titles", async () => {
    const order = await createOrder();
    const paid = await payAgent(order.id, 100);
    expect(paid.status).toBe(201);
    const other = await createOrder();
    await ctx.db.insert(notifications).values([
      { userId: ids.userId, kind: "payment-recorded", title: `${order.po} received short`, details: [], href: `/orders/${order.po}/receiving`, dedupeKey: "t1" },
      { userId: ids.userId, kind: "payment-recorded", title: "Order page", details: [], href: `/orders/${order.po}`, dedupeKey: "t2" },
      // Another order whose number starts with this one's stays as it is.
      { userId: ids.userId, kind: "payment-recorded", title: "Other", details: [], href: `/orders/${order.po}0/payments`, dedupeKey: "t3" },
      { userId: ids.userId, kind: "payment-recorded", title: "Other order", details: [], href: `/orders/${other.po}/payments`, dedupeKey: "t4" },
    ]);
    expect((await edit(order.po, { po: "PO A&B" })).status).toBe(200);
    const links = await ctx.db.select({ title: notifications.title, href: notifications.href }).from(notifications);
    expect(links).toEqual(
      expect.arrayContaining([
        { title: `${order.po} received short`, href: "/orders/PO%20A%26B/receiving" },
        { title: "Order page", href: "/orders/PO%20A%26B" },
        { title: "Other", href: `/orders/${order.po}0/payments` },
        { title: "Other order", href: `/orders/${other.po}/payments` },
      ]),
    );
    // PAY-2's own notifications (to the other users) follow too.
    const payment = links.filter((link) => link.title === `${order.po} payment recorded`);
    expect(payment.length).toBeGreaterThan(0);
    expect(payment.every((link) => link.href === "/orders/PO%20A%26B/payments")).toBe(true);
  });

  it("posts the value change under the new number: lines changed in the same edit post nothing before goods, the receipt posts", async () => {
    const order = await createOrder();
    const lines = (await get(`/orders/${order.po}`)).body.lines as { id: string }[];
    const res = await edit(order.po, { po: "PO-BIGGER", lines: [{ id: lines[0]!.id, itemId: ids.jeans, quantity: 200, rateCny: 10 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ledger).toMatchObject({ changeCny: 0, balanceBefore: 0, balanceAfter: 0 });
    // The 200 arrive: worth ¥2,000, posted under the new number.
    expect((await receiveOrder(ctx, order.id)).posted).toMatchObject({ changeCny: -2000, balanceBefore: 0, balanceAfter: -2000 });
    const stored = await ctx.db
      .select({ type: supplierLedgerEntries.entryType, po: supplierLedgerEntries.poNumber })
      .from(supplierLedgerEntries)
      .orderBy(supplierLedgerEntries.createdAt);
    expect(stored).toEqual([
      { type: "order_debit", po: order.po },
      { type: "order_adjustment", po: "PO-BIGGER" },
    ]);
  });
});
