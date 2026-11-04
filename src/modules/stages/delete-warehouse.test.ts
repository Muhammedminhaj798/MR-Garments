import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { containerLines, containers, payments, shippingAgents, transports, warehouseReceiptLines, warehouseReceipts } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { loadLandedCosts } from "../costs/landed-cost";
import { idOf, indiaDay, makeOrder } from "../stock/fixtures";
import { masters, stageOf, stageWriter, tripBody, UNKNOWN } from "./fixtures";

// WH-4 DELETE /warehouse-receipts/:transportId: a draft goes with its lines; a stocked receipt is reversed (its team
// quantities leave stock, the cost per piece and the orders' stages follow); payments, the trip and the clearing stay.

const ctx = createTestContext();
const http = api(ctx);
let suresh = "";
let m: Awaited<ReturnType<typeof masters>>;
let write: ReturnType<typeof stageWriter>;
beforeAll(async () => {
  await resetData(ctx);
  suresh = await signInAs(ctx, SEEDED.management);
  m = await masters(ctx);
  write = stageWriter(ctx, suresh, m);
});
afterAll(() => ctx.pool.end());

const del = (path: string, cookie = suresh) => http.delete(path).set("Cookie", cookie);
const receiptOf = async (tripId: string) => (await ctx.db.select().from(warehouseReceipts).where(eq(warehouseReceipts.transportId, tripId)))[0];
const linesOf = async (receiptId: string) => ctx.db.select().from(warehouseReceiptLines).where(eq(warehouseReceiptLines.receiptId, receiptId));
const costOf = async (orderId: string) => (await loadLandedCosts(ctx.db, [orderId])).get(orderId)!;
const paymentCount = async (orderId: string) => (await ctx.db.select({ n: count() }).from(payments).where(eq(payments.orderId, orderId)))[0]!.n;
const list = async () => (await http.get("/warehouse-receipts").set("Cookie", suresh)).body as {
  rows: { transportId: string; teams: Record<string, number>; received: number }[];
  ready: { transportId: string; receiptStatus: string | null; draft: unknown }[];
};
const pay = (orderId: string) =>
  ctx.db.insert(payments).values({ orderId, kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 1000, status: "paid", paidOn: indiaDay(-20), rateInr: 12, mode: "Bank transfer" });

/** WH-3 for the trip: the given split (draft unless `complete`). */
async function receive(tripId: string, lines: { orderLineId: string; teamId: string; quantity: number }[], complete = true) {
  const res = await http
    .put(`/warehouse-receipts/${tripId}`, { locationId: m.warehouse, receivedOn: indiaDay(-4), receivedBy: "Joseph M", bundlesReceived: 4, lines, complete })
    .set("Cookie", suresh);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

let splits = 0;
/** One order of 200 Denim jeans over two containers (100 each), each cleared, unloaded and stocked to Retail. */
async function splitAndStocked() {
  const order = await makeOrder(ctx, { stage: 3, lines: [{ item: "Denim jeans", quantity: 200, rateCny: 10 }] });
  const agent = await idOf(ctx, shippingAgents, "Sino Freight");
  const trips: string[] = [];
  for (let n = 0; n < 2; n++) {
    const c = (
      await ctx.db
        .insert(containers)
        .values({ number: `WHSP${7100000 + splits++}`, shippingAgentId: agent, terms: "CNF", loadedOn: indiaDay(-20), sailedOn: indiaDay(-20), eta: indiaDay(-12), status: "arrived" })
        .returning({ id: containers.id })
    )[0]!;
    await ctx.db.insert(containerLines).values({ containerId: c.id, orderLineId: order.lineIds[0]!, bundles: 2, quantity: 100 });
    await write.clear(c.id);
    const trip = await http.put(`/transports/${c.id}`, tripBody(m.kerala, m.warehouse, { complete: true })).set("Cookie", suresh);
    expect(trip.status, JSON.stringify(trip.body)).toBe(200);
    trips.push(trip.body.trip.id as string);
    await receive(trip.body.trip.id, [{ orderLineId: order.lineIds[0]!, teamId: m.retail, quantity: 100 }]);
  }
  return { order, trips };
}

describe("WH-4 DELETE /warehouse-receipts/:transportId", () => {
  it("is 401 signed out and 403 below warehouse Full (warehouse staff enter receipts), and changes nothing", async () => {
    const t = await write.unloaded();
    await receive(t.tripId, [{ orderLineId: t.orders[0]!.lineIds[0]!, teamId: m.retail, quantity: 100 }]);
    expect((await http.delete(`/warehouse-receipts/${t.tripId}`)).status).toBe(401);
    for (const email of [SEEDED.warehouseStaff, SEEDED.indiaStaff, SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaffTwoStages]) {
      expect((await del(`/warehouse-receipts/${t.tripId}`, await signInAs(ctx, email))).status, email).toBe(403);
    }
    expect((await receiptOf(t.tripId))?.status).toBe("stocked");
    expect(await stageOf(ctx, t.orders[0]!.id)).toBe(6);
  });

  it("deletes a draft with its own lines: stock, cost, stages and the trip don't change", async () => {
    const t = await write.unloaded();
    const order = t.orders[0]!;
    await receive(t.tripId, [{ orderLineId: order.lineIds[0]!, teamId: m.retail, quantity: 60 }], false);
    const draft = (await receiptOf(t.tripId))!;
    expect(draft.status).toBe("draft");
    const before = await costOf(order.id);
    expect((await list()).ready.find((r) => r.transportId === t.tripId)).toMatchObject({
      receiptStatus: "draft",
      draft: { receivedOn: indiaDay(-4), location: "Main warehouse", bundlesReceived: 4, received: 60, teams: { [m.retail]: 60 } },
    });

    expect((await del(`/warehouse-receipts/${t.tripId}`)).status).toBe(204);
    expect(await receiptOf(t.tripId)).toBeUndefined();
    expect(await linesOf(draft.id)).toEqual([]);
    expect(await stageOf(ctx, order.id)).toBe(5);
    expect((await ctx.db.select().from(transports).where(eq(transports.id, t.tripId)))[0]).toMatchObject({ status: "unloaded" });
    expect(await costOf(order.id)).toEqual(before);
    expect((await list()).ready.find((r) => r.transportId === t.tripId)).toMatchObject({ receiptStatus: null, draft: null });
  });

  it("reverses a stocked receipt: its team quantities leave stock, the cost per piece and the stage follow, payments stay", async () => {
    const t = await write.unloaded();
    const order = t.orders[0]!;
    await pay(order.id);
    await receive(t.tripId, [
      { orderLineId: order.lineIds[0]!, teamId: m.retail, quantity: 60 },
      { orderLineId: order.lineIds[0]!, teamId: m.wholesale, quantity: 40 },
    ]);
    const stocked = (await receiptOf(t.tripId))!;
    const before = await costOf(order.id);
    expect(before).toMatchObject({ stockedPieces: 100 });
    expect(before.perPieceInr).toBeGreaterThan(0);
    expect(await stageOf(ctx, order.id)).toBe(6);
    expect((await list()).rows.find((r) => r.transportId === t.tripId)).toMatchObject({ received: 100, teams: { [m.retail]: 60, [m.wholesale]: 40 } });

    expect((await del(`/warehouse-receipts/${t.tripId}`)).status).toBe(204);
    expect(await receiptOf(t.tripId)).toBeUndefined();
    expect(await linesOf(stocked.id)).toEqual([]);
    expect(await stageOf(ctx, order.id)).toBe(5);
    const after = (await list()).ready.find((r) => r.transportId === t.tripId);
    expect((await list()).rows.some((r) => r.transportId === t.tripId)).toBe(false);
    expect(after).toMatchObject({ receiptStatus: null, draft: null });
    // The money stays as it was; only the stocked pieces (and so the cost per piece) are gone.
    expect(await costOf(order.id)).toMatchObject({
      goodsInr: before.goodsInr,
      clearingInr: before.clearingInr,
      transportInr: before.transportInr,
      totalInr: before.totalInr,
      stockedPieces: 0,
      perPieceInr: null,
      final: false,
    });
    expect(await paymentCount(order.id)).toBe(1);

    // A consistent state: the same goods can be received again.
    await receive(t.tripId, [{ orderLineId: order.lineIds[0]!, teamId: m.online, quantity: 100 }]);
    expect(await stageOf(ctx, order.id)).toBe(6);
    expect((await costOf(order.id)).stockedPieces).toBe(100);
  });

  it("steps back every order in the container; an order stocked through another container stays at 6", async () => {
    const shared = await write.unloaded({
      orders: [[{ item: "Denim jeans", quantity: 100, rateCny: 10 }], [{ item: "Track pants", quantity: 30, rateCny: 6 }]],
    });
    const [a, b] = shared.orders;
    await receive(shared.tripId, [
      { orderLineId: a!.lineIds[0]!, teamId: m.retail, quantity: 100 },
      { orderLineId: b!.lineIds[0]!, teamId: m.online, quantity: 30 },
    ]);
    expect((await del(`/warehouse-receipts/${shared.tripId}`)).status).toBe(204);
    expect([await stageOf(ctx, a!.id), await stageOf(ctx, b!.id)]).toEqual([5, 5]);

    const { order, trips } = await splitAndStocked();
    expect((await del(`/warehouse-receipts/${trips[0]}`)).status).toBe(204);
    expect(await stageOf(ctx, order.id)).toBe(6);
    expect((await costOf(order.id)).stockedPieces).toBe(100);
  });

  it("is 404 for an unknown or malformed trip, a trip without a receipt, and an already deleted one", async () => {
    expect((await del(`/warehouse-receipts/${UNKNOWN}`)).body.error).toEqual({ code: "not_found", message: "Warehouse receipt not found." });
    expect((await del("/warehouse-receipts/not-a-trip")).status).toBe(404);
    const t = await write.unloaded();
    expect((await del(`/warehouse-receipts/${t.tripId}`)).status).toBe(404);
  });

  it("of two deletes at once, one succeeds; a delete racing the completion never leaves the stage out of step", async () => {
    const t = await write.unloaded();
    await receive(t.tripId, [{ orderLineId: t.orders[0]!.lineIds[0]!, teamId: m.retail, quantity: 100 }]);
    const statuses = (await Promise.all([del(`/warehouse-receipts/${t.tripId}`), del(`/warehouse-receipts/${t.tripId}`)])).map((res) => res.status);
    expect(statuses.sort()).toEqual([204, 404]);

    const raced = await write.unloaded();
    const line = raced.orders[0]!.lineIds[0]!;
    await receive(raced.tripId, [{ orderLineId: line, teamId: m.retail, quantity: 100 }], false);
    const [deleted, completed] = await Promise.all([
      del(`/warehouse-receipts/${raced.tripId}`),
      http
        .put(`/warehouse-receipts/${raced.tripId}`, { locationId: m.warehouse, receivedOn: indiaDay(-4), receivedBy: "Joseph M", bundlesReceived: 4, lines: [{ orderLineId: line, teamId: m.retail, quantity: 100 }], complete: true })
        .set("Cookie", suresh),
    ]);
    expect([deleted.status, completed.status].sort()).toEqual([200, 204]);
    // Whichever went first, the order is at 6 exactly when a stocked receipt exists.
    const receipt = await receiptOf(raced.tripId);
    expect(await stageOf(ctx, raced.orders[0]!.id)).toBe(receipt?.status === "stocked" ? 6 : 5);
  });

  it("unwinds the whole chain: warehouse receipt, trip, clearing, container, then the order itself", async () => {
    const t = await write.unloaded();
    const order = t.orders[0]!;
    await receive(t.tripId, [{ orderLineId: order.lineIds[0]!, teamId: m.retail, quantity: 100 }]);
    // The trip is refused while its receipt exists; then each step opens the next.
    expect((await del(`/transports/${t.id}`)).status).toBe(409);
    expect((await del(`/warehouse-receipts/${t.tripId}`)).status).toBe(204);
    expect((await del(`/transports/${t.id}`)).status).toBe(204);
    expect(await stageOf(ctx, order.id)).toBe(4);
    expect((await del(`/clearings/${t.id}`)).status).toBe(204);
    expect(await stageOf(ctx, order.id)).toBe(3);
    expect((await del(`/containers/${t.id}`)).status).toBe(204);
    expect(await stageOf(ctx, order.id)).toBe(1);
    expect((await del(`/orders/${order.po}`)).status).toBe(204);
  });
});
