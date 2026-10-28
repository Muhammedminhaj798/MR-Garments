import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { containers, orders, shippingAgents } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { DETAIL_MESSAGES } from "./container-detail.routes";
import { idOf, indiaDay, makeOrder, receive } from "./fixtures";
import { MESSAGES } from "./stock.routes";

// No seeded role has containers at View only, so Procurement gets View here for the 403-on-Enter check.
vi.mock("../../permissions/matrix", async (original) => {
  const actual = await original<typeof import("../../permissions/matrix")>();
  return {
    ...actual,
    effectiveAccess: (...args: Parameters<typeof actual.effectiveAccess>) =>
      args[0] === "Procurement" && args[2] === "containers" ? "View" : actual.effectiveAccess(...args),
  };
});

const ctx = createTestContext();
const http = api(ctx);
let wang = "";
let sino = "";
beforeAll(async () => {
  await resetData(ctx);
  wang = await signInAs(ctx, SEEDED.chinaStaffTwoStages);
  sino = await idOf(ctx, shippingAgents, "Sino Freight");
});
afterAll(() => ctx.pool.end());

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
let numbers = 0;
const get = (id: string, cookie = wang) => http.get(`/containers/${id}`).set("Cookie", cookie);
const patch = (id: string, body: object, cookie = wang) => http.patch(`/containers/${id}`, body).set("Cookie", cookie);
const stageOf = async (id: string) => (await ctx.db.select({ stage: orders.stage }).from(orders).where(eq(orders.id, id)))[0]!.stage;

/** A stage 2 order, fully received, loaded through CON-3 (which moves it to stage 3). */
async function loadedContainer(extra: object = {}) {
  const order = await makeOrder(ctx, {
    stage: 2,
    lines: [
      { item: "Track pants", quantity: 60, rateCny: 5 },
      { item: "Cotton fabric", quantity: 50, rateCny: 5 },
    ],
  });
  await receive(ctx, order.id, [
    { orderLineId: order.lineIds[0]!, quantity: 60 },
    { orderLineId: order.lineIds[1]!, quantity: 50 },
  ]);
  const number = `MSCU${2000000 + numbers++}`;
  const res = await http
    .post("/containers", {
      number,
      shippingAgentId: sino,
      terms: "FOB",
      portOfLoading: "Nansha",
      portOfArrival: "Kochi",
      loadedOn: indiaDay(-5),
      sailedOn: null,
      eta: indiaDay(20),
      lines: [
        { orderLineId: order.lineIds[1]!, bundles: 2, quantity: 50 },
        { orderLineId: order.lineIds[0]!, bundles: 3, quantity: 40 },
      ],
      ...extra,
    })
    .set("Cookie", wang);
  expect(res.status).toBe(201);
  return { id: res.body.container.id as string, number, order };
}

describe("access", () => {
  it("is 401 signed out, 403 without access, and 403 on PATCH with View only", async () => {
    const { id } = await loadedContainer();
    expect((await http.get(`/containers/${id}`)).status).toBe(401);
    expect((await http.patch(`/containers/${id}`, { eta: indiaDay(21) })).status).toBe(401);
    for (const email of [SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff]) {
      const cookie = await signInAs(ctx, email);
      expect((await get(id, cookie)).status, email).toBe(403);
      expect((await patch(id, { eta: indiaDay(21) }, cookie)).status, email).toBe(403);
    }
    const viewer = await signInAs(ctx, SEEDED.procurement);
    expect((await get(id, viewer)).status).toBe(200);
    const refused = await patch(id, { eta: indiaDay(21) }, viewer);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("forbidden");
    expect((await get(id)).body.eta).toBe(indiaDay(20));
  });
});

describe("CON-4 GET /containers/:id", () => {
  it("returns the CON-1 fields, ports and lines sorted by PO then item", async () => {
    const { id, number, order } = await loadedContainer();
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id,
      number,
      agent: { id: sino, name: "Sino Freight" },
      terms: "FOB",
      loadedOn: indiaDay(-5),
      sailedOn: null,
      eta: indiaDay(20),
      etaEstimated: false,
      status: "loading",
      portOfLoading: "Nansha",
      portOfArrival: "Kochi",
      bundles: 5,
      orders: [{ po: order.po, part: true }],
      lines: [
        { orderLineId: order.lineIds[1], orderId: order.id, po: order.po, item: "Cotton fabric", unit: "m", bundles: 2, quantity: 50 },
        { orderLineId: order.lineIds[0], orderId: order.id, po: order.po, item: "Track pants", unit: "pcs", bundles: 3, quantity: 40 },
      ],
    });
  });

  it("is 404 not_found for a malformed or unknown id", async () => {
    for (const id of ["not-a-uuid", UNKNOWN]) {
      const res = await get(id);
      expect(res.status, id).toBe(404);
      expect(res.body.error).toEqual({ code: "not_found", message: "Container not found." });
      expect((await patch(id, { eta: indiaDay(21) })).status, id).toBe(404);
    }
  });

  it("leaves /containers/options to CON-2", async () => {
    const res = await http.get("/containers/options").set("Cookie", wang);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("agents");
    expect(res.body).toHaveProperty("lines");
  });
});

describe("CON-5 PATCH /containers/:id", () => {
  it("moves loading -> sea -> arrived, persists, and leaves the order stage alone", async () => {
    const { id, order } = await loadedContainer();
    expect(await stageOf(order.id)).toBe(3);

    const sea = await patch(id, { status: "sea", sailedOn: indiaDay(-1) });
    expect(sea.status).toBe(200);
    expect(sea.body).toEqual({ container: { id, status: "sea", sailedOn: indiaDay(-1), eta: indiaDay(20) } });

    // ETA correction while at sea.
    expect((await patch(id, { eta: indiaDay(25) })).body.container.eta).toBe(indiaDay(25));
    expect((await patch(id, { sailedOn: indiaDay(-2) })).body.container.sailedOn).toBe(indiaDay(-2));

    const arrived = await patch(id, { status: "arrived" });
    expect(arrived.status).toBe(200);
    expect(arrived.body).toEqual({ container: { id, status: "arrived", sailedOn: indiaDay(-2), eta: indiaDay(25) } });

    expect(await get(id).then((res) => res.body)).toMatchObject({ status: "arrived", sailedOn: indiaDay(-2), eta: indiaDay(25) });
    const listed = (await http.get("/containers").set("Cookie", wang)).body.find((row: { id: string }) => row.id === id);
    expect(listed).toMatchObject({ status: "arrived", sailedOn: indiaDay(-2), eta: indiaDay(25) });
    expect(await stageOf(order.id)).toBe(3);
  });

  it("moves to sea with a saved sailing date, and needs one otherwise", async () => {
    const saved = await loadedContainer({ sailedOn: indiaDay(-1) });
    expect((await patch(saved.id, { status: "sea" })).body.container).toMatchObject({ status: "sea", sailedOn: indiaDay(-1) });

    const { id } = await loadedContainer();
    const res = await patch(id, { status: "sea" });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({ sailedOn: DETAIL_MESSAGES.sailedOnNeeded });
    expect((await get(id)).body.status).toBe("loading");
  });

  it("checks the sailing date and ETA against loading, sailing and today", async () => {
    const { id } = await loadedContainer();
    const fields = async (body: object) => {
      const res = await patch(id, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      return res.body.error.fields;
    };
    expect(await fields({ status: "sea", sailedOn: indiaDay(-6) })).toEqual({ sailedOn: DETAIL_MESSAGES.sailedBeforeLoading });
    expect(await fields({ status: "sea", sailedOn: indiaDay(1) })).toEqual({ sailedOn: DETAIL_MESSAGES.sailedFuture });
    expect(await fields({ eta: indiaDay(-6) })).toEqual({ eta: DETAIL_MESSAGES.etaBeforeLoading });
    expect(await fields({ sailedOn: indiaDay(-1), eta: indiaDay(-2) })).toEqual({ eta: DETAIL_MESSAGES.etaBeforeSailing });
    expect(await fields({ sailedOn: "31-12-2026", eta: "soon" })).toEqual({ sailedOn: MESSAGES.sailedOn, eta: MESSAGES.eta });
    expect(await fields({ status: "loading" })).toEqual({ status: DETAIL_MESSAGES.status });

    // At sea, a corrected ETA still can't go before the saved sailing date.
    expect((await patch(id, { status: "sea", sailedOn: indiaDay(-1), eta: indiaDay(0) })).status).toBe(200);
    expect(await fields({ eta: indiaDay(-2) })).toEqual({ eta: DETAIL_MESSAGES.etaBeforeSailing });
    expect((await get(id)).body).toMatchObject({ status: "sea", sailedOn: indiaDay(-1), eta: indiaDay(0) });
  });

  it("is 409 for a skipped, repeated or backward status, and for any change after arrival", async () => {
    const { id } = await loadedContainer();
    const invalid = { code: "invalid_status_change", message: DETAIL_MESSAGES.invalidStatusChange };
    const skip = await patch(id, { status: "arrived" });
    expect(skip.status).toBe(409);
    expect(skip.body.error).toEqual(invalid);

    expect((await patch(id, { status: "sea", sailedOn: indiaDay(0) })).status).toBe(200);
    const same = await patch(id, { status: "sea" });
    expect(same.status).toBe(409);
    expect(same.body.error).toEqual(invalid);

    expect((await patch(id, { status: "arrived" })).status).toBe(200);
    const arrived = { code: "container_arrived", message: DETAIL_MESSAGES.arrived };
    for (const body of [{ status: "sea" }, { status: "arrived" }, { eta: indiaDay(30) }, { sailedOn: indiaDay(-1) }]) {
      const res = await patch(id, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.body.error).toEqual(arrived);
    }
    expect((await get(id)).body).toMatchObject({ status: "arrived", sailedOn: indiaDay(0), eta: indiaDay(20) });
  });

  it("is 400 for an empty body or unknown keys", async () => {
    const { id } = await loadedContainer();
    expect((await patch(id, {})).status).toBe(400);
    expect((await patch(id, { eta: indiaDay(21), number: "X" })).status).toBe(400);
    expect((await ctx.db.select({ eta: containers.eta }).from(containers).where(eq(containers.id, id)))[0]!.eta).toBe(indiaDay(20));
  });
});
