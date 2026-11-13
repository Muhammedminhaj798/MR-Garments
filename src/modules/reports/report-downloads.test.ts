import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { containers, receipts, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { makeContainer, masters, stageWriter } from "../stages/fixtures";
import { idOf, indiaDay, makeOrder, receive } from "../stock/fixtures";

// The fields the page report downloads read (docs/report-downloads.md): ORD-7 and the additions to REC-1, CON-1,
// CLR-1, TRN-1, WH-1, GET /landed-cost and RPT-5D `all=1`. All additive: the existing fields are tested elsewhere.

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
  write = stageWriter(ctx, suresh, m);
});
afterAll(() => ctx.pool.end());

const get = (path: string, cookie = suresh) => http.get(path).set("Cookie", cookie);

describe("ORD-7 GET /order-lines", () => {
  it("lists every line with its saved rate, value and received / stocked quantities", async () => {
    const order = await makeOrder(ctx, {
      lines: [
        { item: "Denim jeans", quantity: 120, rateCny: 12.5 },
        { item: "Cotton fabric", quantity: 300, rateCny: 8 },
      ],
    });
    await receive(ctx, order.id, [{ orderLineId: order.lineIds[1]!, quantity: 250 }]);
    const res = await get("/order-lines");
    expect(res.status).toBe(200);
    expect(res.body.filter((line: { po: string }) => line.po === order.po)).toEqual([
      { orderId: order.id, po: order.po, currency: "CNY", position: 0, item: "Denim jeans", unit: "pcs", quantity: 120, rateCny: 12.5, valueCny: 1500, received: 0, stocked: 0 },
      { orderId: order.id, po: order.po, currency: "CNY", position: 1, item: "Cotton fabric", unit: "m", quantity: 300, rateCny: 8, valueCny: 2400, received: 250, stocked: 0 },
    ]);
  });

  it("needs orders View", async () => {
    expect((await get("/order-lines", joseph)).status).toBe(403);
    expect((await http.get("/order-lines")).status).toBe(401);
  });
});

describe("REC-1 and CON-1 additions", () => {
  it("gives each receipt its notes and each line its ordered and received-so-far quantities", async () => {
    const order = await makeOrder(ctx, { stage: 2, lines: [{ item: "Polo shirts", quantity: 80, rateCny: 20 }] });
    const id = await receive(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: 60 }]);
    await ctx.db.update(receipts).set({ deliveryNote: "DN-4471", shortRemark: "20 to follow" }).where(eq(receipts.id, id));
    const row = (await get("/receipts")).body.find((r: { id: string }) => r.id === id);
    expect(row).toMatchObject({ deliveryNote: "DN-4471", shortRemark: "20 to follow", lines: [{ item: "Polo shirts", unit: "pcs", quantity: 60, ordered: 80, received: 60 }] });
  });

  it("gives each container its ports and each order its supplier", async () => {
    const container = await makeContainer(ctx, { status: "sea" });
    await ctx.db.update(containers).set({ portOfLoading: "Nansha", portOfArrival: "Kochi" }).where(eq(containers.id, container.id));
    const row = (await get("/containers")).body.find((c: { id: string }) => c.id === container.id);
    expect(row).toMatchObject({ portOfLoading: "Nansha", portOfArrival: "Kochi", orders: [{ po: container.orders[0]!.po, supplier: "Guangzhou Textile Co.", part: false }] });
  });
});

describe("CLR-1, TRN-1, WH-1 and landed cost additions", () => {
  it("lists the clearing charges apart, the trip's costs, destination and goods, and the warehouse lines", async () => {
    const trip = await write.unloaded({ orders: [[{ item: "Denim jeans", quantity: 100, rateCny: 10 }, { item: "Cotton fabric", quantity: 40, rateCny: 5 }]] }, { bundlesReceived: 3, shortRemark: "1 bundle wet" });
    const clearing = (await get("/clearings")).body.rows.find((r: { containerId: string }) => r.containerId === trip.id);
    expect(clearing).toMatchObject({ goodsValueInr: 98000, customsDutyInr: 19600, otherDutiesInr: 14200, agentChargesInr: 1800, portChargesInr: 1450, clearingCostInr: 37050 });

    const row = (await get("/transports")).body.rows.find((r: { id: string }) => r.id === trip.tripId);
    expect(row).toMatchObject({
      freightInr: 2200,
      handlingInr: 450,
      costInr: 2650,
      destination: "Main warehouse",
      driverName: "Suresh P",
      shortRemark: "1 bundle wet",
      quantities: [
        { unit: "pcs", quantity: 100 },
        { unit: "m", quantity: 40 },
      ],
    });

    const [jeans, cotton] = trip.orders[0]!.lineIds;
    const saved = await http
      .put(`/warehouse-receipts/${trip.tripId}`, {
        locationId: m.warehouse,
        receivedOn: indiaDay(-4),
        receivedBy: "Joseph M",
        bundlesReceived: 3,
        lines: [
          { orderLineId: jeans, teamId: m.retail, quantity: 60 },
          { orderLineId: jeans, teamId: m.online, quantity: 30 },
          { orderLineId: cotton, teamId: m.retail, quantity: 40 },
        ],
        complete: true,
      })
      .set("Cookie", suresh);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const stocked = (await get("/warehouse-receipts")).body.rows.find((r: { transportId: string }) => r.transportId === trip.tripId);
    expect(stocked).toMatchObject({
      item: "Denim jeans",
      received: 130,
      bundlesLoaded: 4,
      shortRemark: "1 bundle wet",
      lines: [
        { orderLineId: jeans, item: "Denim jeans", unit: "pcs", ordered: 100, quantity: 90 },
        { orderLineId: cotton, item: "Cotton fabric", unit: "m", ordered: 40, quantity: 40 },
      ],
    });

    const costed = (await get("/landed-cost")).body.orders.find((o: { po: string }) => o.po === trip.orders[0]!.po);
    expect(costed).toMatchObject({ orderDate: indiaDay(-30), orderValueCny: 1200, exchangeRate: null });
  });
});

describe("RPT-5D all=1", () => {
  it("returns every row of each list instead of a page of 10", async () => {
    const supplierId = await idOf(ctx, suppliers, "Yiwu Trims Ltd.");
    for (let i = 0; i < 11; i++) await makeOrder(ctx, { supplier: "Yiwu Trims Ltd.", lines: [{ item: "Polo shirts", quantity: 10, rateCny: 1 }] });
    const paged = (await get(`/reports/payments-per-supplier/${supplierId}`)).body;
    const all = (await get(`/reports/payments-per-supplier/${supplierId}?all=1`)).body;
    expect(paged.orders.rows).toHaveLength(10);
    expect(all.orders.rows).toHaveLength(all.orders.total);
    expect(all.orders.total).toBeGreaterThan(10);
    expect(all.lines.rows).toHaveLength(all.lines.total);
    expect((await get(`/reports/payments-per-supplier/${supplierId}?all=yes`)).status).toBe(400);
  });
});
