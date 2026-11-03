import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clearings, containerLines, containers, payments, shippingAgents, transports, warehouseReceiptLines, warehouseReceipts } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { loadLandedCosts } from "../costs/landed-cost";
import { idOf, indiaDay, makeOrder } from "../stock/fixtures";
import { makeContainer, masters, stageOf, stageWriter, tripBody, UNKNOWN } from "./fixtures";

// CLR-4 DELETE /clearings/:containerId and TRN-4 DELETE /transports/:containerId: what refuses them, what they remove
// (only their own row), and how orders, landed cost and payments follow.

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
const expectConflict = (res: { status: number; body: { error: unknown } }, message: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(res.body.error).toEqual({ code: "in_use", message });
};
const clearingOf = async (containerId: string) => (await ctx.db.select().from(clearings).where(eq(clearings.containerId, containerId)))[0];
const tripOf = async (containerId: string) => (await ctx.db.select().from(transports).where(eq(transports.containerId, containerId)))[0];
const costOf = async (orderId: string) => (await loadLandedCosts(ctx.db, [orderId])).get(orderId)!;
const paymentTotal = async (orderId: string) =>
  (await ctx.db.select({ n: count() }).from(payments).where(eq(payments.orderId, orderId)))[0]!.n;
const pay = (orderId: string) =>
  ctx.db.insert(payments).values({ orderId, kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 1000, status: "paid", paidOn: indiaDay(-20), rateInr: 12, mode: "Bank transfer" });

/** A warehouse receipt for the trip, through WH-3 (stocked unless `complete: false`). */
async function receive(tripId: string, orderLineId: string, complete = true) {
  const res = await http
    .put(`/warehouse-receipts/${tripId}`, {
      locationId: m.warehouse,
      receivedOn: indiaDay(-4),
      receivedBy: "Joseph M",
      bundlesReceived: 2,
      lines: [{ orderLineId, teamId: m.retail, quantity: 100 }],
      complete,
    })
    .set("Cookie", suresh);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

let splits = 0;
/** One order of 200 Denim jeans split over two arrived containers (100 each); returns the order and both containers. */
async function splitOrder() {
  const order = await makeOrder(ctx, { stage: 3, lines: [{ item: "Denim jeans", quantity: 200, rateCny: 10 }] });
  const agent = await idOf(ctx, shippingAgents, "Sino Freight");
  const ids: string[] = [];
  for (let n = 0; n < 2; n++) {
    const c = (
      await ctx.db
        .insert(containers)
        .values({ number: `SPLT${7000000 + splits++}`, shippingAgentId: agent, terms: "CNF", loadedOn: indiaDay(-20), sailedOn: indiaDay(-20), eta: indiaDay(-12), status: "arrived" })
        .returning({ id: containers.id })
    )[0]!;
    await ctx.db.insert(containerLines).values({ containerId: c.id, orderLineId: order.lineIds[0]!, bundles: 2, quantity: 100 });
    ids.push(c.id);
  }
  return { order, a: ids[0]!, b: ids[1]! };
}

describe("CLR-4 DELETE /clearings/:containerId", () => {
  it("is 401 signed out and 403 below clearing Full (India staff enter it), and changes nothing", async () => {
    const c = await makeContainer(ctx);
    await write.clear(c.id, { complete: false });
    expect((await http.delete(`/clearings/${c.id}`)).status).toBe(401);
    for (const email of [SEEDED.indiaStaff, SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaffTwoStages, SEEDED.warehouseStaff]) {
      expect((await del(`/clearings/${c.id}`, await signInAs(ctx, email))).status, email).toBe(403);
    }
    expect(await clearingOf(c.id)).toBeTruthy();
    expect(await stageOf(ctx, c.orders[0]!.id)).toBe(4);
  });

  it("deletes a clearing in progress: only its row goes, the container waits for clearing again, the order steps back to 3", async () => {
    const c = await makeContainer(ctx);
    const order = c.orders[0]!;
    await pay(order.id);
    await write.clear(c.id, { complete: false });
    expect((await costOf(order.id)).clearingInr).toBe(37050);
    const paid = (await costOf(order.id)).goodsInr;

    expect((await del(`/clearings/${c.id}`)).status).toBe(204);
    expect(await clearingOf(c.id)).toBeUndefined();
    expect((await ctx.db.select().from(containers).where(eq(containers.id, c.id)))[0]).toMatchObject({ status: "arrived" });
    expect(await ctx.db.select().from(containerLines).where(eq(containerLines.containerId, c.id))).toHaveLength(1);
    expect(await stageOf(ctx, order.id)).toBe(3);
    // CLR-1 lists it as waiting for clearing; the landed cost loses the charges, never the payments.
    const row = (await http.get("/clearings").set("Cookie", suresh)).body.rows.find((r: { containerId: string }) => r.containerId === c.id);
    expect(row).toMatchObject({ status: "waiting", clearingCostInr: 0, agent: null, trip: null });
    expect(await costOf(order.id)).toMatchObject({ clearingInr: null, goodsInr: paid, final: false });
    expect(await paymentTotal(order.id)).toBe(1);
  });

  it("deletes a cleared clearing with no trip: the container leaves Ready for transport", async () => {
    const c = await makeContainer(ctx);
    await write.clear(c.id);
    expect((await http.get("/transports").set("Cookie", suresh)).body.ready.map((r: { containerId: string }) => r.containerId)).toContain(c.id);
    expect((await del(`/clearings/${c.id}`)).status).toBe(204);
    expect((await http.get("/transports").set("Cookie", suresh)).body.ready.map((r: { containerId: string }) => r.containerId)).not.toContain(c.id);
    expect(await stageOf(ctx, c.orders[0]!.id)).toBe(3);
  });

  it("keeps an order at 4 while another of its containers is still in clearing", async () => {
    const { order, a, b } = await splitOrder();
    await write.clear(a, { complete: false });
    await write.clear(b, { complete: false });
    expect((await del(`/clearings/${a}`)).status).toBe(204);
    expect(await stageOf(ctx, order.id)).toBe(4);
    expect((await del(`/clearings/${b}`)).status).toBe(204);
    expect(await stageOf(ctx, order.id)).toBe(3);
  });

  it("refuses while a trip depends on it, naming the trip, and removes nothing", async () => {
    const onRoad = await makeContainer(ctx);
    await write.clear(onRoad.id);
    expect((await http.put(`/transports/${onRoad.id}`, tripBody(m.kerala, m.warehouse, { lrNumber: "LR-700001" })).set("Cookie", suresh)).status).toBe(200);
    expectConflict(
      await del(`/clearings/${onRoad.id}`),
      `The clearing of container ${onRoad.number} can't be deleted: transport trip LR-700001 depends on it. Delete that trip first.`,
    );
    expect(await clearingOf(onRoad.id)).toBeTruthy();
    expect(await tripOf(onRoad.id)).toBeTruthy();
    expect(await stageOf(ctx, onRoad.orders[0]!.id)).toBe(5);
    expect((await http.get("/clearings").set("Cookie", suresh)).body.rows.find((r: { containerId: string }) => r.containerId === onRoad.id).trip).toEqual({
      lrNumber: "LR-700001",
      status: "on_road",
      warehouseReceipt: null,
    });
  });

  it("refuses while a trip and its warehouse receipt depend on it; the team quantities and stage 6 stay", async () => {
    const stocked = await write.unloaded({}, { lrNumber: "LR-700002" });
    const order = stocked.orders[0]!;
    await receive(stocked.tripId, order.lineIds[0]!);
    expectConflict(
      await del(`/clearings/${stocked.id}`),
      `The clearing of container ${stocked.number} can't be deleted: transport trip LR-700002 and its warehouse receipt depend on it. Warehouse receipts can't be removed in the app.`,
    );
    expect(await clearingOf(stocked.id)).toBeTruthy();
    const receipt = (await ctx.db.select().from(warehouseReceipts).where(eq(warehouseReceipts.transportId, stocked.tripId)))[0]!;
    expect(await ctx.db.select().from(warehouseReceiptLines).where(eq(warehouseReceiptLines.receiptId, receipt.id))).toHaveLength(1);
    expect(await stageOf(ctx, order.id)).toBe(6);
  });

  it("is 404 for an unknown or malformed container, a container without a clearing, and an already deleted one", async () => {
    expect((await del(`/clearings/${UNKNOWN}`)).body.error).toEqual({ code: "not_found", message: "Clearing not found." });
    expect((await del("/clearings/not-a-container")).status).toBe(404);
    const waiting = await makeContainer(ctx);
    expect((await del(`/clearings/${waiting.id}`)).status).toBe(404);
  });

  it("of two deletes at once, one succeeds; a delete racing a new trip never leaves both", async () => {
    const twice = await makeContainer(ctx);
    await write.clear(twice.id, { complete: false });
    const statuses = (await Promise.all([del(`/clearings/${twice.id}`), del(`/clearings/${twice.id}`)])).map((res) => res.status);
    expect(statuses.sort()).toEqual([204, 404]);

    const raced = await makeContainer(ctx);
    await write.clear(raced.id);
    const [deleted, trip] = await Promise.all([
      del(`/clearings/${raced.id}`),
      http.put(`/transports/${raced.id}`, tripBody(m.kerala, m.warehouse, { complete: false })).set("Cookie", suresh),
    ]);
    // Either the clearing went first (the trip is refused: not cleared) or the trip did (the delete is refused). Never a
    // trip without its clearing.
    expect(["204/409", "409/200"]).toContain(`${deleted.status}/${trip.status}`);
    expect(Boolean(await clearingOf(raced.id))).toBe(Boolean(await tripOf(raced.id)));
  });
});

describe("TRN-4 DELETE /transports/:containerId", () => {
  it("is 401 signed out and 403 below transport Full (India staff enter it), and changes nothing", async () => {
    const t = await write.unloaded();
    expect((await http.delete(`/transports/${t.id}`)).status).toBe(401);
    for (const email of [SEEDED.indiaStaff, SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaffTwoStages, SEEDED.warehouseStaff]) {
      expect((await del(`/transports/${t.id}`, await signInAs(ctx, email))).status, email).toBe(403);
    }
    expect(await tripOf(t.id)).toBeTruthy();
  });

  it("deletes a trip with no warehouse receipt: the clearing stays, the container is ready for transport, the order steps back to 4", async () => {
    const t = await write.unloaded();
    const order = t.orders[0]!;
    await pay(order.id);
    expect((await costOf(order.id)).transportInr).toBe(2650);
    expect(await stageOf(ctx, order.id)).toBe(5);

    expect((await del(`/transports/${t.id}`)).status).toBe(204);
    expect(await tripOf(t.id)).toBeUndefined();
    expect(await clearingOf(t.id)).toMatchObject({ status: "cleared" });
    expect(await stageOf(ctx, order.id)).toBe(4);
    expect((await http.get("/transports").set("Cookie", suresh)).body.ready.map((r: { containerId: string }) => r.containerId)).toContain(t.id);
    expect(await costOf(order.id)).toMatchObject({ transportInr: null, clearingInr: 37050 });
    expect(await paymentTotal(order.id)).toBe(1);

    // Then the clearing can go too, back to loaded.
    expect((await del(`/clearings/${t.id}`)).status).toBe(204);
    expect(await stageOf(ctx, order.id)).toBe(3);
  });

  it("refuses with a warehouse receipt, draft or stocked, and removes nothing", async () => {
    for (const complete of [false, true]) {
      const t = await write.unloaded({}, { lrNumber: `LR-80000${complete ? 2 : 1}` });
      const order = t.orders[0]!;
      await receive(t.tripId, order.lineIds[0]!, complete);
      expectConflict(
        await del(`/transports/${t.id}`),
        `Trip LR-80000${complete ? 2 : 1} of container ${t.number} can't be deleted: its warehouse receipt depends on it. Warehouse receipts can't be removed in the app.`,
      );
      expect(await tripOf(t.id)).toBeTruthy();
      expect(await stageOf(ctx, order.id)).toBe(complete ? 6 : 5);
      const row = (await http.get("/transports").set("Cookie", suresh)).body.rows.find((r: { containerId: string }) => r.containerId === t.id);
      expect(row.warehouseReceipt).toBe(complete ? "stocked" : "draft");
    }
  });

  it("keeps an order at 5 while another of its containers is still on the road", async () => {
    const { order, a, b } = await splitOrder();
    for (const id of [a, b]) {
      await write.clear(id);
      expect((await http.put(`/transports/${id}`, tripBody(m.kerala, m.warehouse, { complete: false })).set("Cookie", suresh)).status).toBe(200);
    }
    expect((await del(`/transports/${a}`)).status).toBe(204);
    expect(await stageOf(ctx, order.id)).toBe(5);
  });

  it("is 404 for an unknown or malformed container, one without a trip, and of two deletes at once one succeeds", async () => {
    expect((await del(`/transports/${UNKNOWN}`)).body.error).toEqual({ code: "not_found", message: "Trip not found." });
    expect((await del("/transports/nope")).status).toBe(404);
    const cleared = await makeContainer(ctx);
    await write.clear(cleared.id);
    expect((await del(`/transports/${cleared.id}`)).status).toBe(404);

    const t = await write.unloaded();
    const statuses = (await Promise.all([del(`/transports/${t.id}`), del(`/transports/${t.id}`)])).map((res) => res.status);
    expect(statuses.sort()).toEqual([204, 404]);
    expect(await stageOf(ctx, t.orders[0]!.id)).toBe(4);
  });
});
