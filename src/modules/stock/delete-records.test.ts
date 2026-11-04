import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clearings,
  containerLines,
  containers,
  notifications,
  orders,
  payments,
  receiptLines,
  receipts,
  shippingAgents,
  transports,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { makeContainer, masters, stageOf, stageWriter, UNKNOWN } from "../stages/fixtures";
import { idOf, indiaDay, makeOrder, receive } from "./fixtures";

// REC-4 DELETE /receipts/:id and CON-6 DELETE /containers/:id, then ORD-6 once an order's receipts and containers are
// gone. Receipts are written straight to the database; containers are loaded through CON-3, so orders move as in use.

const ctx = createTestContext();
const http = api(ctx);
let suresh = "";
let sino = "";
let m: Awaited<ReturnType<typeof masters>>;
let write: ReturnType<typeof stageWriter>;
beforeAll(async () => {
  await resetData(ctx);
  suresh = await signInAs(ctx, SEEDED.management);
  sino = await idOf(ctx, shippingAgents, "Sino Freight");
  m = await masters(ctx);
  write = stageWriter(ctx, suresh, m);
});
afterAll(() => ctx.pool.end());

const del = (path: string, cookie = suresh) => http.delete(path).set("Cookie", cookie);
const get = (path: string, cookie = suresh) => http.get(path).set("Cookie", cookie);
const expectConflict = (res: { status: number; body: { error: unknown } }, message: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(res.body.error).toEqual({ code: "in_use", message });
};
const receiptExists = async (id: string) => (await ctx.db.select({ id: receipts.id }).from(receipts).where(eq(receipts.id, id))).length === 1;
const containerExists = async (id: string) => (await ctx.db.select({ id: containers.id }).from(containers).where(eq(containers.id, id))).length === 1;
/** The main line's received and loaded figures (ORD-4). */
const lineOf = async (po: string) => (await get(`/orders/${po}`)).body.lines[0] as { received: number; loaded: number };

/** A stage 2 order of 100 Denim jeans with one receipt per quantity given. */
async function received(...quantities: number[]) {
  const order = await makeOrder(ctx, { stage: 2, lines: [{ item: "Denim jeans", quantity: 100, rateCny: 10 }] });
  const receiptIds: string[] = [];
  for (const quantity of quantities) receiptIds.push(await receive(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity }]));
  return { ...order, line: order.lineIds[0]!, receiptIds };
}

let numbers = 0;
/** Loads through CON-3 as Management: a container in loading; its orders move to 3. Returns its id and number. */
async function load(lines: { orderLineId: string; quantity: number }[]) {
  const number = `DLTU${2000000 + numbers++}`;
  const res = await http
    .post("/containers", {
      number,
      shippingAgentId: sino,
      terms: "FOB",
      portOfLoading: "Nansha",
      portOfArrival: "Kochi",
      loadedOn: indiaDay(-1),
      sailedOn: null,
      eta: indiaDay(20),
      lines: lines.map((line) => ({ ...line, bundles: 1 })),
    })
    .set("Cookie", suresh);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.container.id as string, number };
}

const pay = (orderId: string) =>
  ctx.db
    .insert(payments)
    .values({ orderId, kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 300, status: "paid", paidOn: indiaDay(-3), rateInr: 12, mode: "Bank transfer" });

describe("REC-4 DELETE /receipts/:id", () => {
  it("is 401 signed out and 403 below receiving Full, and changes nothing", async () => {
    const { receiptIds } = await received(40);
    const id = receiptIds[0]!;
    expect((await http.delete(`/receipts/${id}`)).status).toBe(401);
    // Procurement: receiving View. China staff: receiving Enter. Accounts, India and Warehouse staff: none.
    for (const email of [SEEDED.procurement, SEEDED.chinaStaff, SEEDED.chinaStaffTwoStages, SEEDED.accounts, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      expect((await del(`/receipts/${id}`, await signInAs(ctx, email))).status, email).toBe(403);
    }
    expect(await receiptExists(id)).toBe(true);
  });

  it("deletes a receipt nothing was loaded from: its lines go, the goods are to receive again and the order steps back", async () => {
    const order = await received(60, 30);
    await pay(order.id);
    const [first, second] = order.receiptIds as [string, string];

    expect((await del(`/receipts/${first}`)).status).toBe(204);
    expect(await receiptExists(first)).toBe(false);
    expect(await ctx.db.select().from(receiptLines).where(eq(receiptLines.receiptId, first))).toEqual([]);
    expect(await lineOf(order.po)).toMatchObject({ received: 30, loaded: 0 });
    expect(await stageOf(ctx, order.id)).toBe(2); // a receipt is left

    expect((await del(`/receipts/${second}`)).status).toBe(204);
    expect(await stageOf(ctx, order.id)).toBe(1);
    const options = (await get("/receipts/options")).body.orders.find((row: { po: string }) => row.po === order.po);
    expect(options.lines).toEqual([expect.objectContaining({ orderLineId: order.line, ordered: 100, receivedEarlier: 0 })]);
    // The order and its payment stay.
    expect(await ctx.db.select().from(payments).where(eq(payments.orderId, order.id))).toHaveLength(1);
  });

  it("refuses while goods from it are in a container, naming the container, and changes nothing", async () => {
    const order = await received(60, 40);
    const [first, second] = order.receiptIds as [string, string];
    const { number } = await load([{ orderLineId: order.line, quantity: 70 }]);
    // 100 received, 70 loaded: without the first receipt 40 are left, so 30 of its 60 are in the container.
    expectConflict(await del(`/receipts/${first}`), `This receipt can't be deleted: container ${number} already holds 30 pcs of Denim jeans from it. Delete that container first.`);
    expectConflict(await del(`/receipts/${second}`), `This receipt can't be deleted: container ${number} already holds 10 pcs of Denim jeans from it. Delete that container first.`);
    expect([await receiptExists(first), await receiptExists(second)]).toEqual([true, true]);
    expect(await lineOf(order.po)).toMatchObject({ received: 100, loaded: 70 });
    expect(await stageOf(ctx, order.id)).toBe(3);
  });

  it("names every container holding its goods", async () => {
    const order = await received(60);
    const a = await load([{ orderLineId: order.line, quantity: 30 }]);
    const b = await load([{ orderLineId: order.line, quantity: 30 }]);
    expectConflict(
      await del(`/receipts/${order.receiptIds[0]}`),
      `This receipt can't be deleted: containers ${a.number} and ${b.number} already hold 60 pcs of Denim jeans from it. Delete those containers first.`,
    );
  });

  it("deletes a receipt the other receipts cover: the order stays loaded", async () => {
    const order = await received(60, 40);
    await load([{ orderLineId: order.line, quantity: 50 }]);
    expect((await del(`/receipts/${order.receiptIds[1]}`)).status).toBe(204); // 60 left, 50 loaded
    expect(await lineOf(order.po)).toMatchObject({ received: 60, loaded: 50 });
    expect(await stageOf(ctx, order.id)).toBe(3);
  });

  it("REC-1 gives each receipt's lines and the containers REC-4 would name (none when the other receipts cover it)", async () => {
    const order = await makeOrder(ctx, {
      stage: 2,
      lines: [
        { item: "Denim jeans", quantity: 100, rateCny: 10 },
        { item: "Track pants", quantity: 20, rateCny: 5 },
      ],
    });
    const [jeans, pants] = order.lineIds as [string, string];
    const first = await receive(ctx, order.id, [
      { orderLineId: jeans, quantity: 60 },
      { orderLineId: pants, quantity: 0 },
    ]);
    const second = await receive(ctx, order.id, [
      { orderLineId: jeans, quantity: 40 },
      { orderLineId: pants, quantity: 20 },
    ]);
    const a = await load([{ orderLineId: jeans, quantity: 70 }]);
    const b = await load([{ orderLineId: pants, quantity: 5 }]);
    const rowOf = async (id: string) => ((await get("/receipts")).body as { id: string }[]).find((row) => row.id === id);
    // Jeans: 100 received, 70 loaded, so both receipts hold some (without either, less than 70 is left). Pants: only
    // the second has them, and 5 are loaded. A line received as 0 isn't listed.
    expect(await rowOf(first)).toMatchObject({ lines: [{ item: "Denim jeans", unit: "pcs", quantity: 60 }], containers: [a.number] });
    expect(await rowOf(second)).toMatchObject({
      lines: [
        { item: "Denim jeans", unit: "pcs", quantity: 40 },
        { item: "Track pants", unit: "pcs", quantity: 20 },
      ],
      containers: [a.number, b.number],
    });
    // Covered: another 30 jeans received, so 130 - 60 = 70 still cover what is loaded without the first.
    await receive(ctx, order.id, [{ orderLineId: jeans, quantity: 30 }]);
    expect(await rowOf(first)).toMatchObject({ containers: [] });
    expect((await del(`/receipts/${first}`)).status).toBe(204);
    // As REC-4 says for the second: still in both containers.
    expect(await rowOf(second)).toMatchObject({ containers: [a.number, b.number] });
    expect((await del(`/receipts/${second}`)).status).toBe(409);
  });

  it("answers 404 for an unknown or deleted receipt; of two deletes at once, one succeeds", async () => {
    expect((await del(`/receipts/${UNKNOWN}`)).status).toBe(404);
    expect((await del("/receipts/not-a-receipt")).status).toBe(404);
    const order = await received(50);
    const id = order.receiptIds[0]!;
    const statuses = (await Promise.all([del(`/receipts/${id}`), del(`/receipts/${id}`)])).map((res) => res.status);
    expect(statuses.sort()).toEqual([204, 404]);
    expect((await del(`/receipts/${id}`)).body.error).toMatchObject({ code: "not_found", message: "Receipt not found." });
    expect(await stageOf(ctx, order.id)).toBe(1);
  });
});

describe("CON-6 DELETE /containers/:id", () => {
  it("is 401 signed out and 403 below containers Full, and changes nothing", async () => {
    const order = await received(100);
    const { id } = await load([{ orderLineId: order.line, quantity: 100 }]);
    expect((await http.delete(`/containers/${id}`)).status).toBe(401);
    // Wang: China staff with containers Enter. The others have no container access.
    for (const email of [SEEDED.chinaStaffTwoStages, SEEDED.procurement, SEEDED.accounts, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      expect((await del(`/containers/${id}`, await signInAs(ctx, email))).status, email).toBe(403);
    }
    expect(await containerExists(id)).toBe(true);
  });

  it("deletes a container with nothing past loading: every order's lines go, the goods can be loaded again, the orders step back", async () => {
    const a = await received(100);
    const b = await received(100);
    await pay(a.id);
    const shared = await load([
      { orderLineId: a.line, quantity: 100 },
      { orderLineId: b.line, quantity: 60 },
    ]);
    await load([{ orderLineId: b.line, quantity: 40 }]);
    // ORD-4 names every PO in the container, so the confirmation can say whose goods go with it.
    expect((await get(`/orders/${a.po}`)).body.containers).toEqual([expect.objectContaining({ id: shared.id, orders: [a.po, b.po] })]);
    const notes = (await ctx.db.select({ n: count() }).from(notifications))[0]!.n;

    expect((await del(`/containers/${shared.id}`)).status).toBe(204);
    expect(await containerExists(shared.id)).toBe(false);
    expect(await ctx.db.select().from(containerLines).where(eq(containerLines.containerId, shared.id))).toEqual([]);
    expect(await stageOf(ctx, a.id)).toBe(2); // received, nothing loaded now
    expect(await stageOf(ctx, b.id)).toBe(3); // still in the other container
    expect(await lineOf(a.po)).toMatchObject({ received: 100, loaded: 0 });
    expect(await lineOf(b.po)).toMatchObject({ received: 100, loaded: 40 });
    expect((await get("/containers/options")).body.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ po: a.po, received: 100, loaded: 0 }), expect.objectContaining({ po: b.po, received: 100, loaded: 40 })]),
    );
    // Receipts, payments and the notifications (history) stay.
    expect(await receiptExists(a.receiptIds[0]!)).toBe(true);
    expect(await ctx.db.select().from(payments).where(eq(payments.orderId, a.id))).toHaveLength(1);
    expect((await ctx.db.select({ n: count() }).from(notifications))[0]!.n).toBe(notes);
  });

  it("refuses with a clearing, a trip or a warehouse receipt, naming them, and removes nothing (team quantities stay)", async () => {
    const cleared = await makeContainer(ctx);
    await write.clear(cleared.id, { complete: false });
    expectConflict(
      await del(`/containers/${cleared.id}`),
      `Container ${cleared.number} has a clearing record (Clearing in India), so it can't be deleted. Those records can't be removed in the app.`,
    );
    expect(await containerExists(cleared.id)).toBe(true);
    expect(await ctx.db.select().from(clearings).where(eq(clearings.containerId, cleared.id))).toHaveLength(1);
    expect(await stageOf(ctx, cleared.orders[0]!.id)).toBe(4);

    const stocked = await write.unloaded();
    const order = stocked.orders[0]!;
    const saved = await http
      .put(`/warehouse-receipts/${stocked.tripId}`, {
        locationId: m.warehouse,
        receivedOn: indiaDay(-4),
        receivedBy: "Joseph M",
        bundlesReceived: 2,
        lines: [
          { orderLineId: order.lineIds[0]!, teamId: m.retail, quantity: 60 },
          { orderLineId: order.lineIds[0]!, teamId: m.wholesale, quantity: 40 },
        ],
        complete: true,
      })
      .set("Cookie", suresh);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expectConflict(
      await del(`/containers/${stocked.id}`),
      `Container ${stocked.number} has a clearing record (Clearing in India), a transport trip (Transport) and a warehouse receipt (Warehouse), so it can't be deleted. Those records can't be removed in the app.`,
    );
    expect(await ctx.db.select().from(transports).where(eq(transports.containerId, stocked.id))).toHaveLength(1);
    const receipt = (await ctx.db.select().from(warehouseReceipts).where(eq(warehouseReceipts.transportId, stocked.tripId)))[0]!;
    expect(receipt.status).toBe("stocked");
    expect(await ctx.db.select({ teamId: warehouseReceiptLines.teamId, quantity: warehouseReceiptLines.quantity }).from(warehouseReceiptLines).where(eq(warehouseReceiptLines.receiptId, receipt.id))).toEqual(
      expect.arrayContaining([
        { teamId: m.retail, quantity: 60 },
        { teamId: m.wholesale, quantity: 40 },
      ]),
    );
    expect(await stageOf(ctx, order.id)).toBe(6);
  });

  it("deletes an arrived container nothing was cleared for", async () => {
    const order = await received(100);
    const { id } = await load([{ orderLineId: order.line, quantity: 100 }]);
    await ctx.db.update(containers).set({ status: "arrived", sailedOn: indiaDay(-1) }).where(eq(containers.id, id));
    expect((await del(`/containers/${id}`)).status).toBe(204);
    expect(await stageOf(ctx, order.id)).toBe(2);
  });

  it("answers 404 for an unknown or deleted container; of two deletes at once, one succeeds", async () => {
    expect((await del(`/containers/${UNKNOWN}`)).status).toBe(404);
    expect((await del("/containers/not-a-container")).status).toBe(404);
    const order = await received(100);
    const { id } = await load([{ orderLineId: order.line, quantity: 100 }]);
    const statuses = (await Promise.all([del(`/containers/${id}`), del(`/containers/${id}`)])).map((res) => res.status);
    expect(statuses.sort()).toEqual([204, 404]);
    expect((await del(`/containers/${id}`)).body.error).toMatchObject({ code: "not_found", message: "Container not found." });
    expect(await stageOf(ctx, order.id)).toBe(2);
  });
});

describe("ORD-6 once the receipts and containers are deleted", () => {
  it("refuses an order with a receipt and a container, and deletes it once both are gone (container first)", async () => {
    const order = await received(80);
    const container = await load([{ orderLineId: order.line, quantity: 80 }]);
    expectConflict(await del(`/orders/${order.po}`), "This order has 1 receipt and 1 container, so it can't be deleted.");
    // The receipt can't go first: its goods are in the container.
    expect((await del(`/receipts/${order.receiptIds[0]}`)).status).toBe(409);

    expect((await del(`/containers/${container.id}`)).status).toBe(204);
    expectConflict(await del(`/orders/${order.po}`), "This order has 1 receipt, so it can't be deleted.");
    expect((await del(`/receipts/${order.receiptIds[0]}`)).status).toBe(204);
    expect((await del(`/orders/${order.po}`)).status).toBe(204);
    expect(await ctx.db.select().from(orders).where(eq(orders.id, order.id))).toEqual([]);
  });

  it("still refuses an order with a payment: payments are never deleted by these", async () => {
    const order = await received(10);
    await pay(order.id);
    expect((await del(`/receipts/${order.receiptIds[0]}`)).status).toBe(204);
    expectConflict(await del(`/orders/${order.po}`), "This order has 1 payment, so it can't be deleted.");
  });
});
