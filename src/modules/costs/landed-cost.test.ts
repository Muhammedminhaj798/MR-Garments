import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  clearingAgents,
  clearings,
  containerLines,
  containers,
  locations,
  orders,
  payments,
  shippingAgents,
  teams,
  transportCompanies,
  transports,
  users,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import { createTestContext, resetData } from "../../test/harness";
import { moveOrdersToStage } from "../stages-shared";
import { indiaDay, makeOrder } from "../stock/fixtures";
import { computeLandedCosts, type LandedCostFacts, loadLandedCosts } from "./landed-cost";

type Container = LandedCostFacts["containers"][number];
const container = (id: string, facts: Partial<Container> = {}): Container => ({
  id,
  terms: "FOB",
  clearingInr: null,
  cleared: false,
  tripInr: null,
  unloaded: false,
  stocked: false,
  ...facts,
});
const done = { clearingInr: 0, cleared: true, tripInr: 0, unloaded: true, stocked: true };
const facts = (partial: Partial<LandedCostFacts>): LandedCostFacts => ({ orders: [], payments: [], loads: [], containers: [], stocked: [], ...partial });
const paidInFull = { orderId: "a", payeeRole: "supplier", amountCny: 1000, inr: 12000 };

describe("computeLandedCosts", () => {
  it("shares a container's clearing and trip by goods value, rounded per share", () => {
    const costs = computeLandedCosts(
      facts({
        orders: [
          { id: "a", stage: 5, valueCny: 1000 },
          { id: "b", stage: 5, valueCny: 2000 },
        ],
        loads: [
          { containerId: "c1", orderId: "a", quantity: 900, valueCny: 1000 },
          { containerId: "c1", orderId: "b", quantity: 100, valueCny: 2000 },
        ],
        containers: [container("c1", { clearingInr: 100, tripInr: 2000 })],
      }),
    );
    expect(costs.get("a")).toMatchObject({ clearingInr: 33.33, transportInr: 666.67, totalInr: 700 });
    expect(costs.get("b")).toMatchObject({ clearingInr: 66.67, transportInr: 1333.33, totalInr: 1400 });
  });

  it("shares by quantity when the container's goods value is 0", () => {
    const costs = computeLandedCosts(
      facts({
        orders: [
          { id: "a", stage: 4, valueCny: 0 },
          { id: "b", stage: 4, valueCny: 0 },
        ],
        loads: [
          { containerId: "c1", orderId: "a", quantity: 100, valueCny: 0 },
          { containerId: "c1", orderId: "b", quantity: 300, valueCny: 0 },
        ],
        containers: [container("c1", { clearingInr: 400 })],
      }),
    );
    expect([costs.get("a")?.clearingInr, costs.get("b")?.clearingInr]).toEqual([100, 300]);
    expect(costs.get("a")?.transportInr).toBeNull();
  });

  it("counts agent payments as sea freight for FOB, not for CNF", () => {
    const order = { id: "a", stage: 3, valueCny: 1000 };
    const paid = [paidInFull, { orderId: "a", payeeRole: "agent", amountCny: 100, inr: 1234.56 }];
    const load = { containerId: "c1", orderId: "a", quantity: 10, valueCny: 1000 };
    const fob = computeLandedCosts(facts({ orders: [order], payments: paid, loads: [load], containers: [container("c1")] })).get("a");
    const cnf = computeLandedCosts(facts({ orders: [order], payments: paid, loads: [load], containers: [container("c1", { terms: "CNF" })] })).get("a");
    expect(fob).toMatchObject({ goodsInr: 12000, seaFreightInr: 1234.56, clearingInr: null, transportInr: null, totalInr: 13234.56 });
    expect(cnf).toMatchObject({ goodsInr: 12000, seaFreightInr: 0, totalInr: 12000 });
  });

  it("names the first missing part: supplier payment, duty, transport, warehouse", () => {
    const order = { id: "a", stage: 6, valueCny: 1000 };
    const loads = [
      { containerId: "c1", orderId: "a", quantity: 10, valueCny: 500 },
      { containerId: "c2", orderId: "a", quantity: 10, valueCny: 500 },
    ];
    const waiting = (partial: Partial<LandedCostFacts>) => computeLandedCosts(facts({ orders: [order], loads, payments: [paidInFull], ...partial })).get("a");
    expect(waiting({ payments: [{ ...paidInFull, amountCny: 999.99 }], containers: [container("c1", done), container("c2", done)] })?.waitingFor).toBe(
      "supplier payment",
    );
    expect(waiting({ containers: [container("c1", done), container("c2", { unloaded: true, stocked: true })] })?.waitingFor).toBe("duty");
    expect(waiting({ containers: [container("c1", done), container("c2", { ...done, unloaded: false })] })?.waitingFor).toBe("transport");
    expect(waiting({ containers: [container("c1", done), container("c2", { ...done, stocked: false })] })?.waitingFor).toBe("warehouse");
    expect(waiting({ orders: [{ ...order, stage: 5 }], containers: [container("c1", done), container("c2", done)] })?.waitingFor).toBe("warehouse");
    expect(waiting({ loads: [], containers: [] })?.waitingFor).toBe("duty");
    expect(waiting({ containers: [container("c1", done), container("c2", done)] })).toMatchObject({ final: true, waitingFor: null });
  });

  it("averages per piece over stocked pieces, null while nothing is stocked", () => {
    const order = { id: "a", stage: 6, valueCny: 1000 };
    expect(computeLandedCosts(facts({ orders: [order], payments: [paidInFull] })).get("a")).toMatchObject({ stockedPieces: 0, perPieceInr: null });
    const stocked = computeLandedCosts(facts({ orders: [order], payments: [paidInFull], stocked: [{ orderId: "a", pieces: 7 }] })).get("a");
    expect(stocked).toMatchObject({ stockedPieces: 7, perPieceInr: 1714.29 });
  });
});

describe("loadLandedCosts (database)", () => {
  const ctx = createTestContext();
  afterAll(() => ctx.pool.end());

  it("reads payments, shares, stage records and stock for the requested orders", async () => {
    await resetData(ctx);
    const one = async (table: typeof clearingAgents | typeof transportCompanies | typeof teams | typeof locations | typeof shippingAgents | typeof users, name: string) =>
      (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;
    const user = await one(users, "Suresh Menon");
    const authors = { createdBy: user, updatedBy: user };
    const a = await makeOrder(ctx, { stage: 3, lines: [{ item: "Polo shirts", quantity: 100, rateCny: 30 }] });
    const b = await makeOrder(ctx, { stage: 3, lines: [{ item: "Men's shorts", quantity: 100, rateCny: 10 }] });
    const paid = { kind: "Deposit", status: "paid", paidOn: indiaDay(-20), mode: "Bank" };
    await ctx.db.insert(payments).values([
      { ...paid, orderId: a.id, payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 3000, rateInr: 12.3456 },
      { ...paid, orderId: a.id, payee: "Sino Freight", payeeRole: "agent", amountCny: 100, rateInr: 12 },
      { orderId: a.id, kind: "Balance", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 50, status: "due", dueDate: indiaDay(5) },
    ]);
    const [box] = await ctx.db
      .insert(containers)
      .values({ number: "LCTU 1000001", shippingAgentId: await one(shippingAgents, "Sino Freight"), terms: "FOB", loadedOn: indiaDay(-15), eta: indiaDay(-5), status: "arrived" })
      .returning({ id: containers.id });
    await ctx.db.insert(containerLines).values([
      { containerId: box!.id, orderLineId: a.lineIds[0]!, bundles: 5, quantity: 100 },
      { containerId: box!.id, orderLineId: b.lineIds[0]!, bundles: 5, quantity: 100 },
    ]);
    const day = indiaDay(-3);
    await ctx.db.insert(clearings).values({
      ...authors,
      containerId: box!.id,
      clearingAgentId: await one(clearingAgents, "Kochi Clearing Services"),
      arrivedOn: day,
      dutyPaidOn: day,
      clearedOn: day,
      customsDutyInr: 1000,
      otherDutiesInr: 200,
      agentChargesInr: 300,
      portChargesInr: 500,
      status: "cleared",
    });
    const warehouse = await one(locations, "Main warehouse");
    const [trip] = await ctx.db
      .insert(transports)
      .values({
        ...authors,
        containerId: box!.id,
        transportCompanyId: await one(transportCompanies, "Kerala Roadways"),
        destinationId: warehouse,
        lrNumber: "LR-1",
        vehicleNumber: "KL-07-1234",
        driverPhone: "9800000000",
        bundlesLoaded: 10,
        loadedOn: day,
        unloadedOn: day,
        bundlesReceived: 10,
        freightInr: 800,
        handlingInr: 200,
        status: "unloaded",
      })
      .returning({ id: transports.id });
    const [receipt] = await ctx.db
      .insert(warehouseReceipts)
      .values({ ...authors, transportId: trip!.id, locationId: warehouse, receivedOn: day, receivedBy: "Joseph M", bundlesReceived: 10, status: "stocked" })
      .returning({ id: warehouseReceipts.id });
    await ctx.db.insert(warehouseReceiptLines).values([
      { receiptId: receipt!.id, orderLineId: a.lineIds[0]!, teamId: await one(teams, "Retail team"), quantity: 60 },
      { receiptId: receipt!.id, orderLineId: a.lineIds[0]!, teamId: await one(teams, "Online team"), quantity: 40 },
    ]);
    await moveOrdersToStage(ctx.db, box!.id, 6);
    const stages = await ctx.db.select({ stage: orders.stage }).from(orders).where(inArray(orders.id, [a.id, b.id]));
    expect(stages).toEqual([{ stage: 6 }, { stage: 6 }]);

    // A is 3000 of the container's 4000 CNY: 3/4 of 2000 clearing and 1000 transport.
    const costs = await loadLandedCosts(ctx.db, [a.id]);
    expect([...costs.values()]).toEqual([
      {
        orderId: a.id,
        goodsInr: 37036.8,
        seaFreightInr: 1200,
        clearingInr: 1500,
        transportInr: 750,
        totalInr: 40486.8,
        stockedPieces: 100,
        perPieceInr: 404.87,
        final: true,
        waitingFor: null,
      },
    ]);
    const all = await loadLandedCosts(ctx.db);
    expect(all.get(b.id)).toMatchObject({ goodsInr: 0, clearingInr: 500, transportInr: 250, stockedPieces: 0, perPieceInr: null, waitingFor: "supplier payment" });
    expect((await loadLandedCosts(ctx.db, [])).size).toBe(0);
  });
});
