import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clearingAgents, clearings, orders } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { indiaDay } from "../stock/fixtures";
import { CLEARING_MESSAGES as M } from "./clearing.routes";
import { STAGE_MESSAGES } from "./common";
import { clearingBody, makeContainer, masters, stageOf, stageWriter, UNKNOWN } from "./fixtures";

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
beforeAll(async () => {
  await resetData(ctx);
  anil = await signInAs(ctx, SEEDED.indiaStaff);
  m = await masters(ctx);
});
afterAll(() => ctx.pool.end());

const get = (path: string, cookie = anil) => http.get(path).set("Cookie", cookie);
const put = (id: string, body: object, cookie = anil) => http.put(`/clearings/${id}`, body).set("Cookie", cookie);
const saved = async (containerId: string) => (await ctx.db.select().from(clearings).where(eq(clearings.containerId, containerId)))[0];

// First, while the database holds only this test's containers.
describe("CLR-1 GET /clearings", () => {
  it("lists every arrived container, waiting, in clearing or cleared, with the 30-day KPIs", async () => {
    const write = stageWriter(ctx, anil, m);
    const waiting = await makeContainer(ctx, { orders: [[{ item: "Polo shirts", quantity: 50, rateCny: 8 }], [{ item: "Track pants", quantity: 30, rateCny: 6 }]] });
    const inClearing = await makeContainer(ctx);
    expect((await put(inClearing.id, clearingBody(m.southern, { arrivedOn: indiaDay(-3), handedOn: null, dutyPaidOn: null, clearedOn: null }))).status).toBe(200);
    const three = await makeContainer(ctx);
    await write.clear(three.id); // arrived -10, cleared -7: 3 days, ₹37,050
    const four = await makeContainer(ctx);
    await write.clear(four.id, { arrivedOn: indiaDay(-6), handedOn: null, dutyPaidOn: indiaDay(-3), clearedOn: indiaDay(-2), portChargesInr: 1450.5 });
    const old = await makeContainer(ctx, { loadedOn: indiaDay(-70) });
    await write.clear(old.id, { arrivedOn: indiaDay(-50), handedOn: null, dutyPaidOn: indiaDay(-41), clearedOn: indiaDay(-40) });
    await makeContainer(ctx, { status: "sea" });

    const res = await get("/clearings");
    expect(res.status).toBe(200);
    expect(res.body.kpis).toEqual({ inClearingNow: 2, clearedLast30Days: 2, averageDaysToClear: 3.5, clearingCostLast30DaysInr: 74100.5 });
    expect(res.body.agents).toEqual([
      { id: m.kochi, name: "Kochi Clearing Services" },
      { id: m.southern, name: "Southern Port Agents" },
    ]);
    // Newest arrival first; a waiting container sorts by its ETA (12 days ago).
    expect(res.body.rows.map((row: { number: string }) => row.number)).toEqual([inClearing.number, four.number, three.number, waiting.number, old.number]);
    const [draft, , cleared, wait] = res.body.rows;
    expect(wait).toEqual({
      containerId: waiting.id,
      number: waiting.number,
      terms: "CNF",
      eta: indiaDay(-12),
      agent: null,
      arrivedOn: null,
      handedOn: null,
      billOfEntry: "",
      dutyPaidOn: null,
      clearedOn: null,
      orders: waiting.orders.map((order) => order.po),
      status: "waiting",
      clearingCostInr: 0,
    });
    expect(draft).toMatchObject({ agent: { id: m.southern, name: "Southern Port Agents" }, arrivedOn: indiaDay(-3), status: "in_clearing", clearingCostInr: 37050 });
    expect(cleared).toMatchObject({
      agent: { id: m.kochi, name: "Kochi Clearing Services" },
      arrivedOn: indiaDay(-10),
      handedOn: indiaDay(-9),
      billOfEntry: "BE-7710482",
      dutyPaidOn: indiaDay(-8),
      clearedOn: indiaDay(-7),
      orders: [three.orders[0]!.po],
      status: "cleared",
      clearingCostInr: 37050,
    });
  });
});

describe("access", () => {
  it("is 401 signed out, 403 without clearing access, and 403 on PUT with View only", async () => {
    const { id } = await makeContainer(ctx);
    for (const res of [await http.get("/clearings"), await http.get(`/clearings/${id}`), await http.put(`/clearings/${id}`, clearingBody(m.kochi))]) {
      expect(res.status).toBe(401);
    }
    for (const email of [SEEDED.chinaStaffTwoStages, SEEDED.warehouseStaff, SEEDED.accounts]) {
      const cookie = await signInAs(ctx, email);
      expect((await get("/clearings", cookie)).status, email).toBe(403);
      expect((await get(`/clearings/${id}`, cookie)).status, email).toBe(403);
      expect((await put(id, clearingBody(m.kochi), cookie)).status, email).toBe(403);
    }
    const viewer = await signInAs(ctx, SEEDED.procurement);
    expect((await get("/clearings", viewer)).status).toBe(200);
    expect((await get(`/clearings/${id}`, viewer)).status).toBe(200);
    const refused = await put(id, clearingBody(m.kochi), viewer);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("forbidden");
    expect(await saved(id)).toBeUndefined();
    const management = await signInAs(ctx, SEEDED.management);
    expect((await put(id, clearingBody(m.kochi), management)).status).toBe(200);
  });
});

describe("CLR-2 GET /clearings/:containerId", () => {
  it("returns the container, no clearing yet, the goods, suppliers and active agents with contacts", async () => {
    const container = await makeContainer(ctx, {
      terms: "FOB",
      orders: [
        [
          { item: "Denim jeans", quantity: 100, rateCny: 10 },
          { item: "Cotton fabric", quantity: 40, rateCny: 3 },
        ],
      ],
    });
    const [order] = container.orders;
    const res = await get(`/clearings/${container.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      container: { id: container.id, number: container.number, status: "arrived", terms: "FOB", loadedOn: indiaDay(-20), eta: indiaDay(-12) },
      clearing: null,
      goods: [
        { orderLineId: order!.lineIds[0], orderId: order!.id, po: order!.po, item: "Denim jeans", unit: "pcs", bundles: 2, quantity: 100 },
        { orderLineId: order!.lineIds[1], orderId: order!.id, po: order!.po, item: "Cotton fabric", unit: "m", bundles: 2, quantity: 40 },
      ],
      suppliers: ["Guangzhou Textile Co."],
      agents: [
        { id: m.kochi, name: "Kochi Clearing Services", contactPerson: "Mr. Anil Kumar", phone: "+91 98470 12345" },
        { id: m.southern, name: "Southern Port Agents", contactPerson: "Mr. Rajesh Nair", phone: "+91 98950 44210" },
      ],
    });
  });

  it("returns the saved clearing, and keeps its agent listed after it is deactivated", async () => {
    const { id } = await makeContainer(ctx);
    expect((await put(id, clearingBody(m.southern, { portChargesInr: 1450.25 }))).status).toBe(200);
    await ctx.db.update(clearingAgents).set({ status: "Inactive" }).where(eq(clearingAgents.id, m.southern));
    try {
      const res = await get(`/clearings/${id}`);
      expect(res.body.clearing).toEqual({
        id: (await saved(id))!.id,
        clearingAgentId: m.southern,
        arrivedOn: indiaDay(-10),
        handedOn: indiaDay(-9),
        billOfEntry: "BE-7710482",
        dutyPaidOn: indiaDay(-8),
        clearedOn: indiaDay(-7),
        goodsValueInr: 98000,
        customsDutyInr: 19600,
        otherDutiesInr: 14200,
        agentChargesInr: 1800,
        portChargesInr: 1450.25,
        status: "in_clearing",
      });
      expect(res.body.agents.map((agent: { id: string }) => agent.id)).toEqual([m.kochi, m.southern]);
      // Saving again needs an active agent.
      const refused = await put(id, clearingBody(m.southern));
      expect(refused.status).toBe(422);
      expect(refused.body.error.fields).toEqual({ clearingAgentId: M.agent });
      const other = await makeContainer(ctx);
      expect((await get(`/clearings/${other.id}`)).body.agents.map((agent: { id: string }) => agent.id)).toEqual([m.kochi]);
    } finally {
      await ctx.db.update(clearingAgents).set({ status: "Active" }).where(eq(clearingAgents.id, m.southern));
    }
  });

  it("is 404 not_found for a malformed or unknown container", async () => {
    for (const id of ["not-a-uuid", UNKNOWN]) {
      const res = await get(`/clearings/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.body.error).toEqual({ code: "not_found", message: "Container not found." });
      expect((await put(id, clearingBody(m.kochi))).status, id).toBe(404);
    }
  });
});

describe("CLR-3 PUT /clearings/:containerId", () => {
  it("saves a draft (orders to stage 4), updates it, then marks it cleared; after that it is closed", async () => {
    const { id, orders: [order] } = await makeContainer(ctx);
    const draft = await put(id, { clearingAgentId: m.kochi, arrivedOn: indiaDay(-10) });
    expect(draft.status).toBe(200);
    const clearingId = draft.body.clearing.id;
    expect(draft.body).toEqual({ clearing: { id: clearingId, status: "in_clearing" } });
    expect(await stageOf(ctx, order!.id)).toBe(4);
    expect(await saved(id)).toMatchObject({ billOfEntry: "", dutyPaidOn: null, customsDutyInr: 0, goodsValueInr: null, status: "in_clearing" });

    const again = await put(id, clearingBody(m.southern, { clearedOn: null }));
    expect(again.body).toEqual({ clearing: { id: clearingId, status: "in_clearing" } });
    expect((await get(`/clearings/${id}`)).body.clearing).toMatchObject({ clearingAgentId: m.southern, billOfEntry: "BE-7710482", customsDutyInr: 19600 });

    const done = await put(id, clearingBody(m.kochi, { complete: true }));
    expect(done.body).toEqual({ clearing: { id: clearingId, status: "cleared" } });
    expect(await stageOf(ctx, order!.id)).toBe(4);
    expect(await saved(id)).toMatchObject({ status: "cleared", clearedOn: indiaDay(-7), clearingAgentId: m.kochi });

    for (const body of [clearingBody(m.kochi), clearingBody(m.kochi, { complete: true, portChargesInr: 0 })]) {
      const res = await put(id, body);
      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({ code: "record_closed", message: STAGE_MESSAGES.closed });
    }
    expect(await saved(id)).toMatchObject({ status: "cleared", portChargesInr: 1450 });
  });

  it("is 409 container_not_arrived before the container arrives, and saves nothing", async () => {
    for (const status of ["loading", "sea"]) {
      const { id, orders: [order] } = await makeContainer(ctx, { status });
      const res = await put(id, clearingBody(m.kochi));
      expect(res.status, status).toBe(409);
      expect(res.body.error).toEqual({ code: "container_not_arrived", message: STAGE_MESSAGES.notArrived });
      expect(await saved(id)).toBeUndefined();
      expect(await stageOf(ctx, order!.id)).toBe(3);
    }
  });

  it("moves every order in the container forward, never backward", async () => {
    const { id, orders: [behind, ahead] } = await makeContainer(ctx, {
      orders: [[{ item: "Polo shirts", quantity: 10, rateCny: 5 }], [{ item: "Track pants", quantity: 10, rateCny: 5 }]],
    });
    await ctx.db.update(orders).set({ stage: 5 }).where(eq(orders.id, ahead!.id)); // further along in another container
    expect((await put(id, clearingBody(m.kochi))).status).toBe(200);
    expect([await stageOf(ctx, behind!.id), await stageOf(ctx, ahead!.id)]).toEqual([4, 5]);
  });

  it("checks the dates against loading, arrival, duty and today", async () => {
    const { id } = await makeContainer(ctx); // loaded 20 days ago
    const fields = async (extra: object) => {
      const res = await put(id, clearingBody(m.kochi, extra));
      expect(res.status, JSON.stringify(extra)).toBe(422);
      return res.body.error.fields;
    };
    const noDates = { handedOn: null, dutyPaidOn: null, clearedOn: null };
    expect(await fields({ arrivedOn: indiaDay(1), ...noDates })).toEqual({ arrivedOn: M.arrivedFuture });
    expect(await fields({ arrivedOn: indiaDay(-21), ...noDates })).toEqual({ arrivedOn: M.arrivedBeforeLoading });
    expect(await fields({ handedOn: indiaDay(-11), dutyPaidOn: indiaDay(1), clearedOn: indiaDay(-12) })).toEqual({
      handedOn: M.beforeArrival,
      dutyPaidOn: STAGE_MESSAGES.future,
      clearedOn: M.beforeArrival,
    });
    expect(await fields({ dutyPaidOn: indiaDay(-7), clearedOn: indiaDay(-8) })).toEqual({ clearedOn: M.clearedBeforeDuty });
    expect(await fields({ arrivedOn: "28-09-2026", handedOn: "soon" })).toEqual({ arrivedOn: M.arrivedOn, handedOn: STAGE_MESSAGES.date });
    expect(await fields({ arrivedOn: undefined, clearingAgentId: undefined })).toEqual({ arrivedOn: M.arrivedOn, clearingAgentId: M.agent });
    expect(await saved(id)).toBeUndefined();
    // Today itself is fine.
    expect((await put(id, clearingBody(m.kochi, { arrivedOn: indiaDay(0), handedOn: null, dutyPaidOn: indiaDay(0), clearedOn: indiaDay(0) }))).status).toBe(200);
  });

  it("checks the amounts: 0 to 999,999,999,999.99 with 2 decimals", async () => {
    const { id } = await makeContainer(ctx);
    for (const [key, value] of [
      ["customsDutyInr", -1],
      ["otherDutiesInr", 1_000_000_000_000],
      ["agentChargesInr", 10.005],
      ["portChargesInr", "100"],
      ["goodsValueInr", -5],
    ] as const) {
      const res = await put(id, clearingBody(m.kochi, { [key]: value }));
      expect(res.status, key).toBe(422);
      expect(res.body.error.fields).toEqual({ [key]: STAGE_MESSAGES.amount });
    }
    expect((await put(id, clearingBody(m.kochi, { customsDutyInr: 999_999_999_999.99, goodsValueInr: null }))).status).toBe(200);
    expect(await saved(id)).toMatchObject({ customsDutyInr: 999_999_999_999.99, goodsValueInr: null });
  });

  it("needs the bill of entry, duty paid and cleared dates only to mark cleared", async () => {
    const { id } = await makeContainer(ctx);
    const missing = { billOfEntry: "  ", dutyPaidOn: null, clearedOn: null };
    expect((await put(id, clearingBody(m.kochi, missing))).status).toBe(200);
    const res = await put(id, clearingBody(m.kochi, { ...missing, complete: true }));
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({ billOfEntry: M.billOfEntry, dutyPaidOn: M.dutyPaidOn, clearedOn: M.clearedOn });
    expect(await saved(id)).toMatchObject({ status: "in_clearing", billOfEntry: "" });
  });

  it("refuses an unknown agent (422) and unknown keys (400)", async () => {
    const { id } = await makeContainer(ctx);
    expect((await put(id, clearingBody(UNKNOWN))).body.error.fields).toEqual({ clearingAgentId: M.agent });
    expect((await put(id, clearingBody(m.kochi, { status: "cleared" }))).status).toBe(400);
    expect(await saved(id)).toBeUndefined();
  });

  it("lets only one of two simultaneous completions win", async () => {
    const { id } = await makeContainer(ctx);
    const results = await Promise.all([put(id, clearingBody(m.kochi, { complete: true })), put(id, clearingBody(m.southern, { complete: true }))]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(results.find((res) => res.status === 409)!.body.error.code).toBe("record_closed");
    expect((await ctx.db.select().from(clearings).where(eq(clearings.containerId, id))).length).toBe(1);
  });
});
