import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { suppliers, teams } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { indiaDay } from "../stock/fixtures";
import { buildLifecycle } from "./test-data";

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
const get = (path: string, cookie = management) => http.get(path).set("Cookie", cookie);
const idOf = async (table: typeof suppliers | typeof teams, name: string) => (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;

describe("GET /landed-cost access and filters", () => {
  beforeAll(async () => {
    await resetData(ctx);
    management = await signInAs(ctx, SEEDED.management);
  });

  it("is 401 signed out and 403 for Procurement and Accounts", async () => {
    expect((await http.get("/landed-cost")).status).toBe(401);
    for (const email of [SEEDED.procurement, SEEDED.accounts]) {
      const res = await get("/landed-cost", await signInAs(ctx, email));
      expect(res.status, email).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
  });

  it("is 400 for a malformed or unknown filter", async () => {
    for (const query of ["supplierId=abc", "teamId=1", "from=2026-10-01", "supplierId=a&supplierId=b"]) {
      const res = await get(`/landed-cost?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
  });

  it("returns no rows and zero KPIs on an empty database, with the active suppliers and teams", async () => {
    const res = await get("/landed-cost");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kpis: { finishedTotalInr: 0, finishedPieces: 0, finishedPos: [], estimatePos: [], estimateWaitingFor: null },
      orders: [],
    });
    expect(res.body.suppliers.map((s: { name: string }) => s.name)).toEqual(["Guangzhou Textile Co.", "Shenzhen Apparel", "Foshan Fabrics", "Yiwu Trims Ltd.", "Hangzhou Knits"]);
    expect(res.body.teams.map((t: { name: string }) => t.name)).toEqual(["Retail team", "Wholesale team", "Online team"]);
  });
});

describe("GET /landed-cost on the lifecycle data", () => {
  let data: Awaited<ReturnType<typeof buildLifecycle>>;
  beforeAll(async () => {
    await resetData(ctx);
    management = await signInAs(ctx, SEEDED.management);
    data = await buildLifecycle(ctx);
  });

  it("lists the orders with costs, newest first, with loadLandedCosts' figures, terms, teams and goods payments", async () => {
    const res = await get("/landed-cost");
    expect(res.status).toBe(200);
    const { orders, kpis } = res.body;
    expect(orders.map((o: { po: string }) => o.po)).toEqual([data.c.po, data.b.po, data.a.po]);
    const [c, b, a] = orders;
    expect(a).toMatchObject({
      orderId: data.a.id,
      supplier: { name: "Guangzhou Textile Co." },
      item: "Polo shirts",
      quantity: 100,
      unit: "pcs",
      terms: "FOB",
      goodsInr: 37000,
      seaFreightInr: 1200,
      clearingInr: 1500,
      transportInr: 750,
      totalInr: 40450,
      stockedPieces: 100,
      perPieceInr: 404.5,
      final: true,
      waitingFor: null,
      teams: [
        { team: "Retail team", pieces: 60, costInr: 24270 },
        { team: "Online team", pieces: 40, costInr: 16180 },
      ],
      goodsPayments: [
        { kind: "Deposit", paidOn: indiaDay(-38), amountCny: 2000, rateInr: 12, amountInr: 24000 },
        { kind: "Balance", paidOn: indiaDay(-15), amountCny: 1000, rateInr: 13, amountInr: 13000 },
      ],
    });
    expect(b).toMatchObject({ terms: "FOB", goodsInr: 12500, seaFreightInr: 0, clearingInr: 500, transportInr: 250, totalInr: 13250, perPieceInr: 132.5 });
    expect(b.teams).toMatchObject([{ team: "Wholesale team", pieces: 100, costInr: 13250 }]);
    expect(c).toMatchObject({
      unit: "m",
      terms: "CNF",
      goodsInr: 12000,
      seaFreightInr: 0,
      clearingInr: null,
      transportInr: null,
      totalInr: 12000,
      stockedPieces: 0,
      perPieceInr: null,
      final: false,
      waitingFor: "supplier payment",
      teams: [],
    });
    expect(c.goodsPayments).toHaveLength(1);
    expect(kpis).toEqual({
      finishedTotalInr: 53700,
      finishedPieces: 200,
      finishedPos: [data.b.po, data.a.po],
      estimatePos: [data.c.po],
      estimateWaitingFor: "supplier payment",
    });
  });

  it("filters by supplier and by team, KPIs included", async () => {
    const bySupplier = await get(`/landed-cost?supplierId=${await idOf(suppliers, "Guangzhou Textile Co.")}`);
    expect(bySupplier.body.orders.map((o: { po: string }) => o.po)).toEqual([data.a.po]);
    expect(bySupplier.body.kpis).toMatchObject({ finishedTotalInr: 40450, estimatePos: [] });
    const byTeam = await get(`/landed-cost?teamId=${await idOf(teams, "Wholesale team")}`);
    expect(byTeam.body.orders.map((o: { po: string }) => o.po)).toEqual([data.b.po]);
    const unknown = await get("/landed-cost?supplierId=00000000-0000-4000-8000-000000000000");
    expect(unknown.body.orders).toEqual([]);
  });
});
