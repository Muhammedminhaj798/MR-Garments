import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { containerLines } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { makeContainer, masters, stageWriter, tripBody } from "../stages/fixtures";
import { indiaDay, makeOrder } from "../stock/fixtures";

// When an order is closed (docs/phase2-contracts.md section 1; ./closure.ts): stage 6 and every container carrying its
// goods stocked. Read through ORD-1 and ORD-4, written by the warehouse (WH-3) and its delete (WH-4).

const ctx = createTestContext();
const http = api(ctx);
let suresh = "";
let joseph = "";
let m: Awaited<ReturnType<typeof masters>>;
let write: ReturnType<typeof stageWriter>;
beforeAll(async () => {
  await resetData(ctx);
  suresh = await signInAs(ctx, SEEDED.management);
  joseph = await signInAs(ctx, SEEDED.warehouseStaff);
  m = await masters(ctx);
  write = stageWriter(ctx, await signInAs(ctx, SEEDED.indiaStaff), m);
});
afterAll(() => ctx.pool.end());

type Row = { po: string; stage: number; stocked: number; closed: boolean; closedOn: string | null };
const listRow = async (po: string) => ((await http.get("/orders").set("Cookie", suresh)).body as Row[]).find((row) => row.po === po)!;
const detail = async (po: string) => (await http.get(`/orders/${po}`).set("Cookie", suresh)).body as Row;
const stock = (tripId: string, lines: { orderLineId: string; teamId: string; quantity: number }[], receivedOn = indiaDay(-4)) =>
  http
    .put(`/warehouse-receipts/${tripId}`, { locationId: m.warehouse, receivedOn, receivedBy: "Joseph M", bundlesReceived: 2, lines, complete: true })
    .set("Cookie", joseph);

describe("closed orders", () => {
  it("a pending order and one on the way are open; stocking its only container closes it on the receipt's date", async () => {
    const pending = await makeOrder(ctx, { lines: [{ item: "Denim jeans", quantity: 10, rateCny: 1 }] });
    expect(await listRow(pending.po)).toMatchObject({ stage: 1, stocked: 0, closed: false, closedOn: null });

    const trip = await write.unloaded({ orders: [[{ item: "Denim jeans", quantity: 100, rateCny: 10 }]] });
    const order = trip.orders[0]!;
    expect(await listRow(order.po)).toMatchObject({ stage: 5, stocked: 0, closed: false, closedOn: null });

    expect((await stock(trip.tripId, [{ orderLineId: order.lineIds[0]!, teamId: m.retail, quantity: 100 }], indiaDay(-3))).status).toBe(200);
    const closed = { stage: 6, stocked: 100, closed: true, closedOn: indiaDay(-3) };
    expect(await listRow(order.po)).toMatchObject(closed);
    expect(await detail(order.po)).toMatchObject(closed);

    // WH-4 (Management) takes the receipt back: the order reopens by itself.
    expect((await http.delete(`/warehouse-receipts/${trip.tripId}`).set("Cookie", suresh)).status).toBe(204);
    expect(await listRow(order.po)).toMatchObject({ stage: 5, stocked: 0, closed: false, closedOn: null });
  });

  it("an order split over two containers reaches stage 6 with the first stocked receipt but closes only with the last", async () => {
    // The second container carries 40 of the same line; it arrived but is not cleared yet.
    const first = await write.unloaded({ orders: [[{ item: "Denim jeans", quantity: 100, rateCny: 10 }]] });
    const order = first.orders[0]!;
    const second = await makeContainer(ctx, { orders: [[{ item: "Track pants", quantity: 1, rateCny: 1 }]] });
    await ctx.db.insert(containerLines).values({ containerId: second.id, orderLineId: order.lineIds[0]!, bundles: 1, quantity: 40 });

    expect((await stock(first.tripId, [{ orderLineId: order.lineIds[0]!, teamId: m.retail, quantity: 60 }], indiaDay(-4))).status).toBe(200);
    expect(await listRow(order.po)).toMatchObject({ stage: 6, stocked: 60, closed: false, closedOn: null });

    await write.clear(second.id);
    const { trip } = (await http.put(`/transports/${second.id}`, tripBody(m.kerala, m.warehouse, { complete: true })).set("Cookie", suresh)).body;
    expect((await stock(trip.id, [{ orderLineId: order.lineIds[0]!, teamId: m.online, quantity: 40 }], indiaDay(-1))).status).toBe(200);
    expect(await listRow(order.po)).toMatchObject({ stage: 6, stocked: 100, closed: true, closedOn: indiaDay(-1) });
    // The other order in the second container closes with it too.
    expect(await listRow(second.orders[0]!.po)).toMatchObject({ stage: 6, closed: true, closedOn: indiaDay(-1) });
  });
});
