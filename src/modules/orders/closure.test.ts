import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { containerLines, notifications, orders, warehouseReceiptLines, warehouseReceipts } from "../../db/schema";
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

    // WH-4 (Management) takes the receipt back: the order reopens by itself, and the audit trail reaches warehouse users.
    expect((await http.delete(`/warehouse-receipts/${trip.tripId}`).set("Cookie", suresh)).status).toBe(204);
    expect(await listRow(order.po)).toMatchObject({ stage: 5, stocked: 0, closed: false, closedOn: null });
    const notes = await ctx.db.select({ title: notifications.title, details: notifications.details, href: notifications.href }).from(notifications).where(eq(notifications.kind, "warehouse-receipt-deleted"));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toEqual({ title: `${trip.number} warehouse receipt deleted`, details: ["Stocked receipt of trip LR-558214", `${order.po}: back to an earlier stage`], href: "/warehouse" });
    // The warehouse staff see it (warehouse View); Accounts, with no warehouse access, do not.
    const joseph = await signInAs(ctx, SEEDED.warehouseStaff);
    const anita = await signInAs(ctx, SEEDED.accounts);
    const kinds = async (cookie: string) => ((await http.get("/notifications").set("Cookie", cookie)).body.items as { kind: string }[]).map((n) => n.kind);
    expect(await kinds(joseph)).toContain("warehouse-receipt-deleted");
    expect(await kinds(anita)).not.toContain("warehouse-receipt-deleted");
  });

  it("names only the orders that stepped back when a receipt is deleted: a shared container, one of two containers, a draft", async () => {
    const detailsOf = async (container: string) =>
      (await ctx.db.select({ details: notifications.details }).from(notifications).where(eq(notifications.title, `${container} warehouse receipt deleted`)))[0]?.details;
    const remove = (tripId: string) => http.delete(`/warehouse-receipts/${tripId}`).set("Cookie", suresh);

    // Shared container, both keyed: deleting the receipt steps both orders back, so both are named.
    const shared = await write.unloaded({ orders: [[{ item: "Denim jeans", quantity: 10, rateCny: 1 }], [{ item: "Track pants", quantity: 5, rateCny: 1 }]] });
    const [a, b] = shared.orders;
    expect((await stock(shared.tripId, [{ orderLineId: a!.lineIds[0]!, teamId: m.retail, quantity: 10 }, { orderLineId: b!.lineIds[0]!, teamId: m.retail, quantity: 5 }])).status).toBe(200);
    expect((await remove(shared.tripId)).status).toBe(204);
    expect(await detailsOf(shared.number)).toEqual(["Stocked receipt of trip LR-558214", `${[a!.po, b!.po].sort().join(", ")}: back to an earlier stage`]);

    // An order split over two stocked containers keeps stage 6 when one receipt goes (the other container is still
    // stocked), so it is not named; the order found only in that container is.
    const first = await write.unloaded({ orders: [[{ item: "Denim jeans", quantity: 100, rateCny: 10 }]] });
    const split = first.orders[0]!;
    const second = await makeContainer(ctx, { orders: [[{ item: "Track pants", quantity: 1, rateCny: 1 }]] });
    const pants = second.orders[0]!;
    await ctx.db.insert(containerLines).values({ containerId: second.id, orderLineId: split.lineIds[0]!, bundles: 1, quantity: 40 });
    expect((await stock(first.tripId, [{ orderLineId: split.lineIds[0]!, teamId: m.retail, quantity: 60 }])).status).toBe(200);
    await write.clear(second.id);
    const { trip } = (await http.put(`/transports/${second.id}`, tripBody(m.kerala, m.warehouse, { complete: true })).set("Cookie", suresh)).body;
    expect((await stock(trip.id, [{ orderLineId: split.lineIds[0]!, teamId: m.online, quantity: 40 }, { orderLineId: pants.lineIds[0]!, teamId: m.retail, quantity: 1 }])).status).toBe(200);
    expect(await listRow(split.po)).toMatchObject({ stage: 6, closed: true });
    expect((await remove(trip.id)).status).toBe(204);
    expect(await listRow(split.po)).toMatchObject({ stage: 6, closed: false });
    expect(await listRow(pants.po)).toMatchObject({ stage: 5, closed: false });
    expect(await detailsOf(second.number)).toEqual(["Stocked receipt of trip LR-558214", `${pants.po}: back to an earlier stage`]);

    // A draft moves no stage, and its deletion says so.
    const draft = await write.unloaded({ orders: [[{ item: "Denim jeans", quantity: 10, rateCny: 1 }]] });
    const saved = await http
      .put(`/warehouse-receipts/${draft.tripId}`, { locationId: m.warehouse, receivedOn: indiaDay(-4), receivedBy: "Joseph M", bundlesReceived: 1, lines: [], complete: false })
      .set("Cookie", joseph);
    expect(saved.status).toBe(200);
    expect((await remove(draft.tripId)).status).toBe(204);
    expect(await listRow(draft.orders[0]!.po)).toMatchObject({ stage: 5 });
    expect(await detailsOf(draft.number)).toEqual(["Draft receipt of trip LR-558214", "No order changed stage"]);
  });

  it("never closes an order on another order's pieces: stage 6 with none of its own stocked stays open (docs/phase2-fixes.md 3)", async () => {
    // Written straight to the database, past WH-3's refusal: a stocked receipt whose lines belong to order A only.
    const trip = await write.unloaded({
      orders: [[{ item: "Denim jeans", quantity: 100, rateCny: 10 }], [{ item: "Track pants", quantity: 40, rateCny: 3 }]],
    });
    const [a, b] = trip.orders;
    const receipt = (
      await ctx.db
        .insert(warehouseReceipts)
        .values({ transportId: trip.tripId, locationId: m.warehouse, receivedOn: indiaDay(-2), receivedBy: "Joseph M", bundlesReceived: 4, status: "stocked", createdBy: a!.id, updatedBy: a!.id }) // any uuid: no foreign key on the authors
        .returning({ id: warehouseReceipts.id })
    )[0]!;
    await ctx.db.insert(warehouseReceiptLines).values({ receiptId: receipt.id, orderLineId: a!.lineIds[0]!, teamId: m.retail, quantity: 100 });
    await ctx.db.update(orders).set({ stage: 6 }).where(and(eq(orders.id, a!.id)));
    await ctx.db.update(orders).set({ stage: 6 }).where(and(eq(orders.id, b!.id)));
    expect(await listRow(a!.po)).toMatchObject({ stage: 6, stocked: 100, closed: true, closedOn: indiaDay(-2) });
    expect(await listRow(b!.po)).toMatchObject({ stage: 6, stocked: 0, closed: false, closedOn: null });
    // Payments per supplier and the Closed tab agree: B is still open.
    const finished = (await http.get("/reports/payments-per-supplier").set("Cookie", suresh)).body.finishedPos as string[];
    expect(finished).toContain(a!.po);
    expect(finished).not.toContain(b!.po);
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
    const pants = second.orders[0]!;
    // Keying only this order's 40 would leave the co-loaded order with nothing of its own, so the receipt is refused.
    const refused = await stock(trip.id, [{ orderLineId: order.lineIds[0]!, teamId: m.online, quantity: 40 }], indiaDay(-1));
    expect([refused.status, refused.body.error.fields]).toEqual([422, { lines: `${pants.po}: give at least one of its pieces to a team before completing, or save a draft.` }]);
    expect(await listRow(order.po)).toMatchObject({ stage: 6, stocked: 60, closed: false });
    expect(await listRow(pants.po)).toMatchObject({ stage: 5, closed: false });
    const both = [
      { orderLineId: order.lineIds[0]!, teamId: m.online, quantity: 40 },
      { orderLineId: pants.lineIds[0]!, teamId: m.retail, quantity: 1 },
    ];
    expect((await stock(trip.id, both, indiaDay(-1))).status).toBe(200);
    expect(await listRow(order.po)).toMatchObject({ stage: 6, stocked: 100, closed: true, closedOn: indiaDay(-1) });
    // The other order in the second container closes with it too, on its own piece.
    expect(await listRow(pants.po)).toMatchObject({ stage: 6, stocked: 1, closed: true, closedOn: indiaDay(-1) });
  });
});
