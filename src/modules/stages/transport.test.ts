import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { locations, transportCompanies, transports } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { indiaDay } from "../stock/fixtures";
import { STAGE_MESSAGES } from "./common";
import { clearingBody, makeContainer, masters, stageOf, stageWriter, tripBody, UNKNOWN } from "./fixtures";
import { TRANSPORT_MESSAGES as M } from "./transport.routes";

// No seeded role has the stage capabilities at View only, so Procurement gets View here for the 403-on-Enter checks.
vi.mock("../../permissions/matrix", async (original) => {
  const actual = await original<typeof import("../../permissions/matrix")>();
  const viewOnly = ["clearing", "transport", "warehouse"];
  return {
    ...actual,
    effectiveAccess: (...args: Parameters<typeof actual.effectiveAccess>) =>
      args[0] === "Procurement" && viewOnly.includes(args[2]) ? "View" : actual.effectiveAccess(...args),
  };
});

const ctx = createTestContext();
const http = api(ctx);
let anil = "";
let m: Awaited<ReturnType<typeof masters>>;
let write: ReturnType<typeof stageWriter>;
beforeAll(async () => {
  await resetData(ctx);
  anil = await signInAs(ctx, SEEDED.indiaStaff);
  m = await masters(ctx);
  write = stageWriter(ctx, anil, m);
});
afterAll(() => ctx.pool.end());

const get = (path: string, cookie = anil) => http.get(path).set("Cookie", cookie);
const put = (id: string, body: object, cookie = anil) => http.put(`/transports/${id}`, body).set("Cookie", cookie);
const saved = async (containerId: string) => (await ctx.db.select().from(transports).where(eq(transports.containerId, containerId)))[0];
/** A container whose clearing is cleared (7 days ago), with no trip yet. */
async function cleared(options: Parameters<typeof makeContainer>[1] = {}) {
  const container = await makeContainer(ctx, options);
  await write.clear(container.id);
  return container;
}
const draft = (extra: object = {}) => tripBody(m.kerala, m.warehouse, { unloadedOn: null, bundlesReceived: null, receivedBy: "", ...extra });

// First, while the database holds only this test's trips.
describe("TRN-1 GET /transports", () => {
  it("lists every trip and the cleared containers without one, with the 30-day KPIs", async () => {
    const onRoad = await cleared();
    expect((await put(onRoad.id, draft({ loadedOn: indiaDay(-1), vehicleNumber: "KL 11 BT 3308", transportCompanyId: m.malabar }))).status).toBe(200);
    const full = await write.unloaded(); // loaded -6, unloaded -5, 4 of 4, ₹2,650
    const short = await write.unloaded({}, { loadedOn: indiaDay(-4), unloadedOn: indiaDay(-3), bundlesReceived: 3, shortRemark: "One bundle torn", freightInr: 1000.5, handlingInr: 0 });
    const old = await makeContainer(ctx, { loadedOn: indiaDay(-80) });
    await write.clear(old.id, { arrivedOn: indiaDay(-60), handedOn: null, dutyPaidOn: indiaDay(-50), clearedOn: indiaDay(-50) });
    expect((await put(old.id, tripBody(m.kerala, m.warehouse, { loadedOn: indiaDay(-45), unloadedOn: indiaDay(-40), complete: true }))).status).toBe(200);
    const ready = await cleared({ orders: [[{ item: "Track pants", quantity: 30, rateCny: 6 }], [{ item: "Polo shirts", quantity: 20, rateCny: 8 }]] });
    const notReady = await makeContainer(ctx);
    expect((await http.put(`/clearings/${notReady.id}`, clearingBody(m.kochi)).set("Cookie", anil)).status).toBe(200); // still in clearing

    const res = await get("/transports");
    expect(res.status).toBe(200);
    expect(res.body.kpis).toEqual({
      onTheWay: 1,
      deliveredLast30Days: 2,
      bundlesDeliveredLast30Days: 7,
      shortLast30Days: 1,
      transportCostLast30DaysInr: 3650.5,
    });
    expect(res.body.companies).toEqual([
      { id: m.kerala, name: "Kerala Roadways" },
      { id: m.malabar, name: "Malabar Carriers" },
    ]);
    expect(res.body.rows.map((row: { container: string }) => row.container)).toEqual([onRoad.number, short.number, full.number, old.number]);
    expect(res.body.rows[0]).toEqual({
      id: (await saved(onRoad.id))!.id,
      containerId: onRoad.id,
      container: onRoad.number,
      vehicleNumber: "KL 11 BT 3308",
      lrNumber: "LR-558214",
      company: { id: m.malabar, name: "Malabar Carriers" },
      orders: [onRoad.orders[0]!.po],
      bundlesLoaded: 4,
      loadedOn: indiaDay(-1),
      unloadedOn: null,
      bundlesReceived: null,
      status: "on_road",
      costInr: 2650,
    });
    expect(res.body.rows[1]).toMatchObject({ id: short.tripId, status: "unloaded", unloadedOn: indiaDay(-3), bundlesReceived: 3, costInr: 1000.5 });
    expect(res.body.ready).toEqual([
      {
        containerId: ready.id,
        container: ready.number,
        clearedOn: indiaDay(-7),
        clearingAgent: "Kochi Clearing Services",
        orders: ready.orders.map((order) => order.po).sort(),
        bundles: 4,
      },
    ]);
  });
});

describe("access", () => {
  it("is 401 signed out, 403 without transport access, and 403 on PUT with View only", async () => {
    const { id } = await cleared();
    for (const res of [await http.get("/transports"), await http.get(`/transports/${id}`), await http.put(`/transports/${id}`, draft())]) {
      expect(res.status).toBe(401);
    }
    for (const email of [SEEDED.chinaStaffTwoStages, SEEDED.warehouseStaff, SEEDED.accounts]) {
      const cookie = await signInAs(ctx, email);
      expect((await get("/transports", cookie)).status, email).toBe(403);
      expect((await get(`/transports/${id}`, cookie)).status, email).toBe(403);
      expect((await put(id, draft(), cookie)).status, email).toBe(403);
    }
    const viewer = await signInAs(ctx, SEEDED.procurement);
    expect((await get("/transports", viewer)).status).toBe(200);
    expect((await get(`/transports/${id}`, viewer)).status).toBe(200);
    const refused = await put(id, draft(), viewer);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("forbidden");
    expect(await saved(id)).toBeUndefined();
  });
});

describe("TRN-2 GET /transports/:containerId", () => {
  it("returns the container, its clearing, no trip yet, the goods and the active companies and warehouses", async () => {
    const container = await cleared({ terms: "FOB" });
    const [order] = container.orders;
    const res = await get(`/transports/${container.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      container: { id: container.id, number: container.number, status: "arrived", terms: "FOB" },
      clearing: { status: "cleared", clearedOn: indiaDay(-7), agent: { id: m.kochi, name: "Kochi Clearing Services" } },
      trip: null,
      goods: [{ orderLineId: order!.lineIds[0], orderId: order!.id, po: order!.po, item: "Denim jeans", unit: "pcs", bundles: 2, quantity: 100 }],
      suppliers: ["Guangzhou Textile Co."],
      companies: [
        { id: m.kerala, name: "Kerala Roadways" },
        { id: m.malabar, name: "Malabar Carriers" },
      ],
      warehouses: [{ id: m.warehouse, name: "Main warehouse" }],
    });
    // Not cleared yet: the clearing is null (no record) or in clearing.
    const waiting = await makeContainer(ctx);
    expect((await get(`/transports/${waiting.id}`)).body).toMatchObject({ clearing: null, trip: null });
  });

  it("returns the saved trip, and keeps its company listed after it is deactivated", async () => {
    const { id } = await cleared();
    expect((await put(id, draft({ transportCompanyId: m.malabar, driverName: "", freightInr: 22000.75 }))).status).toBe(200);
    await ctx.db.update(transportCompanies).set({ status: "Inactive" }).where(eq(transportCompanies.id, m.malabar));
    try {
      const res = await get(`/transports/${id}`);
      expect(res.body.trip).toEqual({
        id: (await saved(id))!.id,
        transportCompanyId: m.malabar,
        destinationId: m.warehouse,
        lrNumber: "LR-558214",
        vehicleNumber: "KL 07 CD 4821",
        driverName: "",
        driverPhone: "+91 94470 55123",
        bundlesLoaded: 4,
        loadedOn: indiaDay(-6),
        loadedFrom: "Kochi port yard",
        loadedBy: "Ravi K",
        unloadedOn: null,
        bundlesReceived: null,
        receivedBy: "",
        shortRemark: "",
        freightInr: 22000.75,
        handlingInr: 450,
        status: "on_road",
      });
      expect(res.body.companies.map((company: { id: string }) => company.id)).toEqual([m.kerala, m.malabar]);
      expect((await put(id, draft({ transportCompanyId: m.malabar }))).body.error.fields).toEqual({ transportCompanyId: M.company });
    } finally {
      await ctx.db.update(transportCompanies).set({ status: "Active" }).where(eq(transportCompanies.id, m.malabar));
    }
  });

  it("is 404 not_found for a malformed or unknown container", async () => {
    for (const id of ["not-a-uuid", UNKNOWN]) {
      const res = await get(`/transports/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.body.error).toEqual({ code: "not_found", message: "Container not found." });
      expect((await put(id, draft())).status, id).toBe(404);
    }
  });
});

describe("TRN-3 PUT /transports/:containerId", () => {
  it("saves the loading (orders to stage 5), updates it, then marks it unloaded; after that it is closed", async () => {
    const { id, orders: [order] } = await cleared();
    expect(await stageOf(ctx, order!.id)).toBe(4);
    const first = await put(id, draft());
    expect(first.status).toBe(200);
    const tripId = first.body.trip.id;
    expect(first.body).toEqual({ trip: { id: tripId, status: "on_road" } });
    expect(await stageOf(ctx, order!.id)).toBe(5);

    expect((await put(id, draft({ lrNumber: "LR-2", unloadedOn: indiaDay(-5) }))).body).toEqual({ trip: { id: tripId, status: "on_road" } });
    expect(await saved(id)).toMatchObject({ lrNumber: "LR-2", unloadedOn: indiaDay(-5), status: "on_road" });

    const done = await put(id, tripBody(m.kerala, m.warehouse, { complete: true }));
    expect(done.body).toEqual({ trip: { id: tripId, status: "unloaded" } });
    expect(await stageOf(ctx, order!.id)).toBe(5);
    expect(await saved(id)).toMatchObject({ status: "unloaded", bundlesReceived: 4, receivedBy: "Joseph M", lrNumber: "LR-558214" });

    const closed = await put(id, draft());
    expect(closed.status).toBe(409);
    expect(closed.body.error).toEqual({ code: "record_closed", message: STAGE_MESSAGES.closed });
    expect(await saved(id)).toMatchObject({ status: "unloaded" });
  });

  it("is 409 not_cleared until the clearing is cleared, and saves nothing", async () => {
    const none = await makeContainer(ctx);
    const inClearing = await makeContainer(ctx);
    expect((await http.put(`/clearings/${inClearing.id}`, clearingBody(m.kochi)).set("Cookie", anil)).status).toBe(200);
    for (const container of [none, inClearing]) {
      const res = await put(container.id, draft());
      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({ code: "not_cleared", message: STAGE_MESSAGES.notCleared });
      expect(await saved(container.id)).toBeUndefined();
    }
    expect(await stageOf(ctx, none.orders[0]!.id)).toBe(3);
    expect(await stageOf(ctx, inClearing.orders[0]!.id)).toBe(4);
  });

  it("checks the company, the destination and the required trip details", async () => {
    const { id } = await cleared();
    const fields = async (extra: object) => {
      const res = await put(id, draft(extra));
      expect(res.status, JSON.stringify(extra)).toBe(422);
      return res.body.error.fields;
    };
    expect(await fields({ transportCompanyId: UNKNOWN, destinationId: m.indiaOffice })).toEqual({ transportCompanyId: M.company, destinationId: M.destination });
    expect(await fields({ lrNumber: " ", vehicleNumber: "", driverPhone: undefined, bundlesLoaded: 0 })).toEqual({
      lrNumber: M.lrNumber,
      vehicleNumber: M.vehicleNumber,
      driverPhone: M.driverPhone,
      bundlesLoaded: M.bundlesLoaded,
    });
    expect(await fields({ bundlesLoaded: 2.5, freightInr: -1, handlingInr: 0.001, loadedBy: "x".repeat(201) })).toEqual({
      bundlesLoaded: M.bundlesLoaded,
      freightInr: STAGE_MESSAGES.amount,
      handlingInr: STAGE_MESSAGES.amount,
      loadedBy: STAGE_MESSAGES.tooLong,
    });
    await ctx.db.update(locations).set({ status: "Inactive" }).where(eq(locations.id, m.warehouse));
    try {
      expect(await fields({})).toEqual({ destinationId: M.destination });
    } finally {
      await ctx.db.update(locations).set({ status: "Active" }).where(eq(locations.id, m.warehouse));
    }
    expect(await saved(id)).toBeUndefined();
  });

  it("checks the dates against the clearing, the loading and today", async () => {
    const { id } = await cleared(); // cleared 7 days ago
    const fields = async (extra: object) => {
      const res = await put(id, draft(extra));
      expect(res.status, JSON.stringify(extra)).toBe(422);
      return res.body.error.fields;
    };
    expect(await fields({ loadedOn: indiaDay(-8) })).toEqual({ loadedOn: M.loadedBeforeCleared });
    expect(await fields({ loadedOn: indiaDay(1) })).toEqual({ loadedOn: M.loadedFuture });
    expect(await fields({ unloadedOn: indiaDay(-7) })).toEqual({ unloadedOn: M.unloadedBeforeLoaded });
    expect(await fields({ unloadedOn: indiaDay(1) })).toEqual({ unloadedOn: STAGE_MESSAGES.future });
    expect(await fields({ loadedOn: "1 Oct 2026" })).toEqual({ loadedOn: M.loadedOn });
    // The clearing day and today are fine.
    expect((await put(id, draft({ loadedOn: indiaDay(-7), unloadedOn: indiaDay(0) }))).status).toBe(200);
  });

  it("needs the unloading details to mark unloaded, and a remark when bundles are short", async () => {
    const { id } = await cleared();
    const done = (extra: object) => put(id, tripBody(m.kerala, m.warehouse, { complete: true, ...extra }));
    const missing = await done({ unloadedOn: null, bundlesReceived: null, receivedBy: " " });
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields).toEqual({ unloadedOn: M.unloadedOn, bundlesReceived: M.bundlesReceived, receivedBy: M.receivedBy });
    expect((await done({ bundlesReceived: 5 })).body.error.fields).toEqual({ bundlesReceived: M.moreThanLoaded });
    expect((await done({ bundlesReceived: -1 })).body.error.fields).toEqual({ bundlesReceived: M.bundlesReceived });
    const short = await done({ bundlesReceived: 3 });
    expect(short.status).toBe(422);
    expect(short.body.error.fields).toEqual({ shortRemark: M.shortRemark });
    expect(await saved(id)).toBeUndefined();
    // A draft may be short without a remark; marking unloaded with one works.
    expect((await put(id, draft({ bundlesReceived: 3 }))).status).toBe(200);
    expect((await done({ bundlesReceived: 3, shortRemark: "One bundle torn at the port" })).body.trip.status).toBe("unloaded");
    expect(await saved(id)).toMatchObject({ bundlesReceived: 3, shortRemark: "One bundle torn at the port" });
  });

  it("refuses unknown keys (400) and lets only one of two simultaneous completions win", async () => {
    const { id } = await cleared();
    expect((await put(id, draft({ status: "unloaded" }))).status).toBe(400);
    const results = await Promise.all([put(id, tripBody(m.kerala, m.warehouse, { complete: true })), put(id, tripBody(m.malabar, m.warehouse, { complete: true }))]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect((await ctx.db.select().from(transports).where(eq(transports.containerId, id))).length).toBe(1);
  });
});
