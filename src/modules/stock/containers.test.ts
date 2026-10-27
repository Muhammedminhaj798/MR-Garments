import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { containers, orders, shippingAgents } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf, indiaDay, makeOrder, receive } from "./fixtures";
import { MESSAGES } from "./stock.routes";

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

let numbers = 0;
const body = (lines: { orderLineId: string; bundles: number; quantity: number }[], extra: object = {}) => ({
  number: `MSCU${1000000 + numbers++}`,
  shippingAgentId: sino,
  terms: "FOB",
  portOfLoading: "Nansha",
  portOfArrival: "Kochi",
  loadedOn: indiaDay(-1),
  sailedOn: null,
  eta: indiaDay(20),
  lines,
  ...extra,
});
const post = (payload: object, cookie = wang) => http.post("/containers", payload).set("Cookie", cookie);
const stageOf = async (id: string) => (await ctx.db.select({ stage: orders.stage }).from(orders).where(eq(orders.id, id)))[0]!.stage;
const containerCount = async () => (await ctx.db.select().from(containers)).length;

/** A stage 2 order with each line received as given. */
async function receivedOrder(lines: { item: string; quantity: number; received: number }[], stage = 2) {
  const order = await makeOrder(ctx, { stage, lines: lines.map(({ item, quantity }) => ({ item, quantity, rateCny: 5 })) });
  await receive(
    ctx,
    order.id,
    order.lineIds.map((orderLineId, i) => ({ orderLineId, quantity: lines[i]!.received })),
  );
  return order;
}

describe("access", () => {
  it("is 401 signed out and 403 without container access", async () => {
    for (const res of [await http.get("/containers"), await http.get("/containers/options"), await http.post("/containers", {})]) {
      expect(res.status).toBe(401);
    }
    // Procurement and Accounts have no container access; Chen is China staff granted receiving only.
    for (const email of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff]) {
      const cookie = await signInAs(ctx, email);
      expect((await http.get("/containers").set("Cookie", cookie)).status, email).toBe(403);
      expect((await http.get("/containers/options").set("Cookie", cookie)).status, email).toBe(403);
      expect((await post({}, cookie)).status, email).toBe(403);
    }
    expect((await http.get("/containers").set("Cookie", wang)).status).toBe(200);
  });
});

describe("CON-3 POST /containers and CON-1 GET /containers", () => {
  it("loads lines, moves orders 2 -> 3 and lists bundles and orders with part", async () => {
    const a = await receivedOrder([
      { item: "Denim jeans", quantity: 100, received: 100 },
      { item: "Cotton fabric", quantity: 50, received: 20 },
    ]);
    const b = await receivedOrder([{ item: "Track pants", quantity: 60, received: 60 }]);
    const payload = body([
      { orderLineId: a.lineIds[0]!, bundles: 2, quantity: 100 },
      { orderLineId: b.lineIds[0]!, bundles: 3, quantity: 60 },
    ]);
    const res = await post(payload);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ container: { id: expect.any(String) } });
    expect(await stageOf(a.id)).toBe(3);
    expect(await stageOf(b.id)).toBe(3);

    // A stage 3 order can be loaded again; it stays at 3.
    const second = await post(body([{ orderLineId: a.lineIds[1]!, bundles: 1, quantity: 20 }], { sailedOn: indiaDay(0), terms: "CNF" }));
    expect(second.status).toBe(201);
    expect(await stageOf(a.id)).toBe(3);

    const list = await http.get("/containers").set("Cookie", wang);
    expect(list.status).toBe(200);
    expect(list.body.slice(0, 2)).toEqual([
      {
        id: second.body.container.id,
        number: expect.any(String),
        agent: { id: sino, name: "Sino Freight" },
        terms: "CNF",
        loadedOn: indiaDay(-1),
        sailedOn: indiaDay(0),
        eta: indiaDay(20),
        etaEstimated: false,
        status: "loading",
        bundles: 1,
        orders: [{ po: a.po, part: true }],
      },
      {
        id: res.body.container.id,
        number: payload.number,
        agent: { id: sino, name: "Sino Freight" },
        terms: "FOB",
        loadedOn: indiaDay(-1),
        sailedOn: null,
        eta: indiaDay(20),
        etaEstimated: false,
        status: "loading",
        bundles: 5,
        orders: [
          { po: a.po, part: true },
          { po: b.po, part: false },
        ],
      },
    ]);
  });

  it("is 409 container_exists for the same number in another case", async () => {
    const order = await receivedOrder([{ item: "Polo shirts", quantity: 40, received: 40 }]);
    const lines = [{ orderLineId: order.lineIds[0]!, bundles: 1, quantity: 10 }];
    expect((await post(body(lines, { number: "TGHU7654321" }))).status).toBe(201);
    const before = await containerCount();
    const res = await post(body(lines, { number: " tghu7654321 " }));
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: "container_exists", message: MESSAGES.numberTaken, fields: { number: MESSAGES.numberTaken } });
    expect(await containerCount()).toBe(before);
  });

  it("refuses loading more than received, counting earlier containers", async () => {
    const order = await receivedOrder([{ item: "Kids t-shirts", quantity: 100, received: 30 }]);
    const line = order.lineIds[0]!;
    const over = await post(body([{ orderLineId: line, bundles: 1, quantity: 31 }]));
    expect(over.status).toBe(422);
    expect(over.body.error.fields).toEqual({ lines: MESSAGES.overLoad("Kids t-shirts", order.po, 30, "pcs") });
    expect((await post(body([{ orderLineId: line, bundles: 1, quantity: 25 }]))).status).toBe(201);
    expect((await post(body([{ orderLineId: line, bundles: 1, quantity: 6 }]))).body.error.fields).toEqual({
      lines: MESSAGES.overLoad("Kids t-shirts", order.po, 5, "pcs"),
    });
    expect((await post(body([{ orderLineId: line, bundles: 1, quantity: 0 }]))).body.error.fields).toEqual({ lines: MESSAGES.loadQuantity });
  });

  it("refuses orders outside stage 2-3, an ETA before loading and an inactive agent", async () => {
    const early = await makeOrder(ctx, { lines: [{ item: "Men's shorts", quantity: 10, rateCny: 1 }] });
    expect((await post(body([{ orderLineId: early.lineIds[0]!, bundles: 0, quantity: 1 }]))).body.error.fields).toEqual({
      lines: MESSAGES.notLoadable(early.po),
    });
    const late = await receivedOrder([{ item: "Men's jackets", quantity: 10, received: 10 }], 4);
    const lateRes = await post(body([{ orderLineId: late.lineIds[0]!, bundles: 0, quantity: 1 }]));
    expect(lateRes.status).toBe(422);
    expect(lateRes.body.error.fields).toEqual({ lines: MESSAGES.notLoadable(late.po) });
    expect(await stageOf(late.id)).toBe(4);

    const ok = await receivedOrder([{ item: "Ladies kurtis", quantity: 10, received: 10 }]);
    const lines = [{ orderLineId: ok.lineIds[0]!, bundles: 0, quantity: 1 }];
    const eta = await post(body(lines, { loadedOn: indiaDay(0), eta: indiaDay(-1) }));
    expect(eta.status).toBe(422);
    expect(eta.body.error.fields).toEqual({ eta: MESSAGES.etaBeforeLoading });
    await ctx.db.update(shippingAgents).set({ status: "Inactive" }).where(eq(shippingAgents.id, sino));
    expect((await post(body(lines))).body.error.fields).toEqual({ shippingAgentId: MESSAGES.agent });
    await ctx.db.update(shippingAgents).set({ status: "Active" }).where(eq(shippingAgents.id, sino));
    expect((await post(body(lines, { terms: "EXW", number: "" }))).body.error.fields).toEqual({ terms: MESSAGES.terms, number: MESSAGES.number });
    expect((await post(body([]))).body.error.fields).toEqual({ lines: MESSAGES.noLines });
    expect((await post({ ...body(lines), status: "sea" })).status).toBe(400);
    expect(await stageOf(ok.id)).toBe(2);
  });
});

describe("CON-2 GET /containers/options", () => {
  it("lists active agents and the received-but-not-loaded lines of stage 2-3 orders", async () => {
    const order = await receivedOrder([
      { item: "Denim jeans", quantity: 100, received: 100 },
      { item: "Cotton fabric", quantity: 300, received: 200 },
    ]);
    const notReceived = await receivedOrder([{ item: "Polo shirts", quantity: 10, received: 0 }]);
    const cleared = await receivedOrder([{ item: "Polo shirts", quantity: 10, received: 10 }], 4);
    expect((await post(body([{ orderLineId: order.lineIds[0]!, bundles: 2, quantity: 100 }, { orderLineId: order.lineIds[1]!, bundles: 2, quantity: 50 }]))).status).toBe(201);
    await ctx.db.update(shippingAgents).set({ status: "Inactive" }).where(eq(shippingAgents.name, "Dragon Cargo"));

    const res = await http.get("/containers/options").set("Cookie", wang);
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([{ id: sino, name: "Sino Freight" }]);
    const mine = res.body.lines.filter((line: { orderId: string }) => [order.id, notReceived.id, cleared.id].includes(line.orderId));
    expect(mine).toEqual([{ orderLineId: order.lineIds[1], orderId: order.id, po: order.po, item: "Cotton fabric", unit: "m", received: 200, loaded: 50 }]);
    for (const line of res.body.lines) expect(line.received).toBeGreaterThan(line.loaded);
  });
});
