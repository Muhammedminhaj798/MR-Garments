import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { indiaDay } from "../stock/fixtures";
import { REPORTS } from "./reports";
import { buildLifecycle } from "./test-data";

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
const get = async (path: string) => {
  const res = await http.get(path).set("Cookie", management);
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
};
const supplierId = async (name: string) => (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, name)))[0]!.id;
const NAMES = Object.keys(REPORTS);
const thisMonth = indiaDay(0).slice(0, 7);

describe("GET /reports/<name> access and filters", () => {
  beforeAll(async () => {
    await resetData(ctx);
    management = await signInAs(ctx, SEEDED.management);
  });

  it("is 401 signed out and 403 for Procurement and Accounts, on every report", async () => {
    const procurement = await signInAs(ctx, SEEDED.procurement);
    const accounts = await signInAs(ctx, SEEDED.accounts);
    for (const name of NAMES) {
      expect((await http.get(`/reports/${name}`)).status, name).toBe(401);
      expect((await http.get(`/reports/${name}`).set("Cookie", procurement)).status, name).toBe(403);
      expect((await http.get(`/reports/${name}`).set("Cookie", accounts)).status, name).toBe(403);
    }
  });

  it("is 400 for malformed filters and 404 for an unknown report", async () => {
    const bad = ["from=2026-13-01", "to=yesterday", "supplierId=abc", "foo=1", "from=2026-10-02&to=2026-10-01", "from=2026-10-01&from=2026-10-02"];
    for (const query of bad) {
      const res = await http.get(`/reports/order-status?${query}`).set("Cookie", management);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
    expect((await http.get("/reports/unknown").set("Cookie", management)).status).toBe(404);
  });

  it("reports zeros and empty lists on an empty database", async () => {
    expect(await get("/reports/summary")).toMatchObject({
      orders: { total: 0, atStage1: 0 },
      deliveries: { dueNext7: 0, late: 0 },
      receiving: { shortOrders: 0, shortPcs: 0, shortM: 0 },
      containers: { onTheWay: 0, arrivingIn7Days: 0 },
      payments: { dueNext30Cny: 0 },
      landedCost: { finishedOrders: 0, finishedTotalInr: 0 },
      filter: { from: null, to: null, supplier: null },
    });
    expect(await get("/reports/order-status")).toMatchObject({ total: 0, stageCounts: [0, 0, 0, 0, 0, 0], late: [], finishedThisMonth: 0, averageOrderDays: null });
    const deliveries = await get("/reports/deliveries-per-day");
    expect(deliveries).toMatchObject({ from: indiaDay(0), to: indiaDay(13), dueNext14: 0, busiest: null, daysWithNone: 14, late: 0 });
    expect(deliveries.days).toHaveLength(14);
    expect(await get("/reports/ordered-vs-received")).toMatchObject({ lines: [], ordersChecked: 0, shortPos: [], shortValueCny: 0, fullOrders: 0 });
    expect(await get("/reports/containers-timeline")).toMatchObject({ from: indiaDay(-25), to: indiaDay(24), containers: [], active: 0, averageSeaDays: null, nextArrival: null });
    expect(await get("/reports/payments-per-supplier")).toMatchObject({ suppliers: [], totals: { orders: 0, orderValueCny: 0 }, dueNext30Cny: 0, finishedPos: [] });
    expect(await get("/reports/landed-cost-by-month")).toMatchObject({ months: [], totals: { orders: 0, pieces: 0, perPieceInr: null }, biggest: null });
  });
});

describe("GET /reports/<name> on the lifecycle data", () => {
  let data: Awaited<ReturnType<typeof buildLifecycle>>;
  beforeAll(async () => {
    await resetData(ctx);
    management = await signInAs(ctx, SEEDED.management);
    data = await buildLifecycle(ctx);
  });

  it("summary: the hub's stat strips and the supplier options", async () => {
    const body = await get("/reports/summary");
    expect(body).toMatchObject({
      orders: { total: 5, atStage1: 1 },
      deliveries: { dueNext7: 1, late: 1 },
      receiving: { shortOrders: 1, shortPcs: 50, shortM: 0 },
      containers: { onTheWay: 1, arrivingIn7Days: 1 },
      payments: { dueNext30Cny: 3000 },
      landedCost: { finishedOrders: 2, finishedTotalInr: 53700 },
    });
    expect(body.suppliers).toHaveLength(5);
  });

  it("order-status: stages, late orders, finished this month and the average order time", async () => {
    expect(await get("/reports/order-status")).toMatchObject({
      total: 5,
      stageCounts: [1, 1, 1, 0, 0, 2],
      late: [{ orderId: data.d.id, po: data.d.po, supplier: "Yiwu Trims Ltd.", due: indiaDay(-2), lateDays: 2 }],
      finishedThisMonth: 2,
      averageOrderDays: 38, // 40 and 35 days
    });
    const guangzhou = await get(`/reports/order-status?supplierId=${await supplierId("Guangzhou Textile Co.")}`);
    expect(guangzhou).toMatchObject({ total: 1, stageCounts: [0, 0, 0, 0, 0, 1], late: [], averageOrderDays: 40, filter: { supplier: "Guangzhou Textile Co." } });
    const recent = await get(`/reports/order-status?from=${indiaDay(-25)}&to=${indiaDay(0)}`);
    expect(recent).toMatchObject({ total: 3, stageCounts: [1, 1, 1, 0, 0, 0], finishedThisMonth: 0, averageOrderDays: null, filter: { from: indiaDay(-25), to: indiaDay(0) } });
  });

  it("deliveries-per-day: the next 14 days of stage 1-2 orders, late ones counted apart", async () => {
    const body = await get("/reports/deliveries-per-day");
    expect(body.days[3]).toEqual({ date: indiaDay(3), count: 1 });
    expect(body).toMatchObject({ dueNext7: 1, suppliersNext7: 1, dueNext14: 1, busiest: { dates: [indiaDay(3)], count: 1 }, daysWithNone: 13, late: 1 });
    const yiwu = await get(`/reports/deliveries-per-day?supplierId=${await supplierId("Yiwu Trims Ltd.")}`);
    expect(yiwu).toMatchObject({ dueNext14: 0, busiest: null, late: 1 });
  });

  it("ordered-vs-received: every received order line with its shortage and its value", async () => {
    const body = await get("/reports/ordered-vs-received");
    expect(body.lines.map((line: { po: string }) => line.po)).toEqual([data.e.po, data.c.po, data.b.po, data.a.po]);
    expect(body.lines[0]).toMatchObject({ supplier: "Hangzhou Knits", item: "Kids t-shirts", unit: "pcs", ordered: 200, received: 150, short: 50, shortValueCny: 200 });
    expect(body.lines[1]).toMatchObject({ unit: "m", ordered: 500, received: 500, short: 0, shortValueCny: null });
    expect(body).toMatchObject({ ordersChecked: 4, shortPos: [data.e.po], shortValueCny: 200, fullOrders: 3 });
    expect((await get(`/reports/ordered-vs-received?from=${indiaDay(-18)}`)).ordersChecked).toBe(1);
  });

  it("containers-timeline: containers overlapping the window, with arrivals and sea time", async () => {
    expect(await get("/reports/containers-timeline")).toMatchObject({
      containers: [
        { id: data.c1.id, number: data.c1.number, status: "arrived", loadedOn: indiaDay(-30), arrival: indiaDay(-9) },
        { id: data.c2.id, number: data.c2.number, status: "sea", loadedOn: indiaDay(-8), arrival: indiaDay(5) },
      ],
      active: 1,
      arrivingIn7Days: [indiaDay(5)],
      averageSeaDays: 21,
      nextArrival: { date: indiaDay(5), number: data.c2.number },
    });
    const foshan = await get(`/reports/containers-timeline?supplierId=${await supplierId("Foshan Fabrics")}`);
    expect(foshan.containers.map((c: { number: string }) => c.number)).toEqual([data.c2.number]);
    const later = await get(`/reports/containers-timeline?from=${indiaDay(10)}&to=${indiaDay(20)}`);
    expect(later).toMatchObject({ from: indiaDay(10), to: indiaDay(20), containers: [], nextArrival: null });
  });

  it("payments-per-supplier: open orders per supplier, supplier payments only, and the finished POs", async () => {
    expect(await get("/reports/payments-per-supplier")).toMatchObject({
      suppliers: [
        { supplier: "Foshan Fabrics", orders: [data.c.po], orderValueCny: 4000, paidCny: 1000, paidInr: 12000, balanceCny: 3000 },
        { supplier: "Yiwu Trims Ltd.", orders: [data.d.po], orderValueCny: 1000, paidCny: 0, paidInr: 0, balanceCny: 1000 },
        { supplier: "Hangzhou Knits", orders: [data.e.po], orderValueCny: 800, paidCny: 0, balanceCny: 800 },
      ],
      totals: { orders: 3, orderValueCny: 5800, paidCny: 1000, paidInr: 12000, balanceCny: 4800 },
      dueNext30Cny: 3000,
      finishedPos: [data.b.po, data.a.po],
    });
  });

  it("landed-cost-by-month: finished orders by the month they were stocked, empty months as 0", async () => {
    expect(await get("/reports/landed-cost-by-month")).toEqual({
      months: [{ month: thisMonth, pieces: 200, landedCostInr: 53700, perPieceInr: 268.5, soFar: true }],
      totals: { orders: 2, pieces: 200, landedCostInr: 53700, perPieceInr: 268.5 },
      biggest: { month: thisMonth, landedCostInr: 53700 },
      filter: { from: null, to: null, supplier: null },
    });
    const endOfLastMonth = indiaDay(-Number(indiaDay(0).slice(8, 10)));
    const lastMonth = endOfLastMonth.slice(0, 7);
    const earlier = await get(`/reports/landed-cost-by-month?from=${lastMonth}-01&to=${endOfLastMonth}`);
    expect(earlier).toMatchObject({ months: [{ month: lastMonth, pieces: 0, landedCostInr: 0, perPieceInr: null, soFar: false }], totals: { orders: 0 }, biggest: null });
    const guangzhou = await get(`/reports/landed-cost-by-month?supplierId=${await supplierId("Guangzhou Textile Co.")}`);
    expect(guangzhou.totals).toEqual({ orders: 1, pieces: 100, landedCostInr: 40450, perPieceInr: 404.5 });
  });
});
