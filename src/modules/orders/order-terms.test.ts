import { readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { containers, items, locations, orders, shippingAgents, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";

// Order container terms (migration 0015, docs/order-container-terms.md): chosen on the order (ORD-3, ORD-5), listed
// (ORD-1, ORD-4, CON-2), and taken by the container that loads the order (CON-3), never mixed in one container.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let ids: { supplier: string; jeans: string; office: string; agent: string };
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  const idOf = async (table: typeof items | typeof suppliers | typeof locations | typeof shippingAgents, name: string) =>
    (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;
  ids = {
    supplier: await idOf(suppliers, "Guangzhou Textile Co."),
    jeans: await idOf(items, "Denim jeans"),
    office: await idOf(locations, "Guangzhou office"),
    agent: await idOf(shippingAgents, "Sino Freight"),
  };
});

const post = (path: string, body: object) => http.post(path).send(body).set("Cookie", management);
const get = (path: string) => http.get(path).set("Cookie", management);
async function createOrder(terms?: string) {
  const res = await post("/orders", {
    supplierId: ids.supplier,
    orderDate: "2026-10-20",
    deliveryDate: "2026-11-30",
    lines: [{ itemId: ids.jeans, quantity: 100, rateCny: 10 }],
    deposits: [],
    ...(terms === undefined ? {} : { terms }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const order = res.body.order as { id: string; po: string };
  return { ...order, lineId: (await get(`/orders/${order.po}`)).body.lines[0].id as string };
}
/** REC-3: all 100 received, so the order (stage 2) can be loaded. */
const receive = async (order: { id: string; lineId: string }) =>
  expect(
    (
      await post("/receipts", {
        orderId: order.id,
        receivedOn: "2026-10-25",
        locationId: ids.office,
        bundles: 2,
        deliveryNote: "",
        shortRemark: "",
        lines: [{ orderLineId: order.lineId, quantity: 100 }],
      })
    ).status,
  ).toBe(201);
let numbers = 0;
/** CON-3 with the given lines (10 each); `terms` sent only when given. */
const load = (lineIds: string[], terms?: string) =>
  post("/containers", {
    number: `TERM${String(++numbers).padStart(7, "0")}`,
    shippingAgentId: ids.agent,
    ...(terms ? { terms } : {}),
    portOfLoading: "",
    portOfArrival: "",
    loadedOn: "2026-10-26",
    eta: "2026-11-20",
    lines: lineIds.map((orderLineId) => ({ orderLineId, bundles: 1, quantity: 10 })),
  });
const termsOf = async (orderId: string) => (await ctx.db.select({ terms: orders.terms }).from(orders).where(eq(orders.id, orderId)))[0]!.terms;
const expectField = (res: { status: number; body: { error?: { fields?: Record<string, string> } } }, field: string, message: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body.error?.fields?.[field]).toBe(message);
};

describe("orders: container terms", () => {
  it("saves the terms chosen on New order and lists them; left out, none yet; anything else is refused", async () => {
    const fob = await createOrder("FOB");
    const none = await createOrder();
    expect((await get(`/orders/${fob.po}`)).body.terms).toBe("FOB");
    expect((await get(`/orders/${none.po}`)).body.terms).toBeNull();
    expect((await get("/orders")).body.map((o: { po: string; terms: string | null }) => [o.po, o.terms])).toEqual(
      expect.arrayContaining([
        [fob.po, "FOB"],
        [none.po, null],
      ]),
    );
    const bad = await post("/orders", { supplierId: ids.supplier, orderDate: "2026-10-20", deliveryDate: "2026-11-30", lines: [{ itemId: ids.jeans, quantity: 1, rateCny: 1 }], terms: "EXW" });
    expectField(bad, "terms", "Choose the container terms: FOB or CNF.");
  });

  it("edits the terms until a container holds the order, at stage 1 and 2", async () => {
    const order = await createOrder();
    const set = await http.patch(`/orders/${order.po}`).send({ terms: "CNF" }).set("Cookie", management);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.order.terms).toBe("CNF");
    await receive(order);
    expect((await get(`/orders/${order.po}`)).body.stage).toBe(2);
    expect((await http.patch(`/orders/${order.po}`).send({ terms: "FOB" }).set("Cookie", management)).status).toBe(200);
    expect(await termsOf(order.id)).toBe("FOB");
    expectField(await http.patch(`/orders/${order.po}`).send({ terms: "fob" }).set("Cookie", management), "terms", "Choose the container terms: FOB or CNF.");
  });

  it("locks the terms once the order is loaded; the same terms are no change; an older order without terms sets them once", async () => {
    const order = await createOrder("FOB");
    await receive(order);
    expect((await load([order.lineId])).status).toBe(201);
    expectField(await http.patch(`/orders/${order.po}`).send({ terms: "CNF" }).set("Cookie", management), "terms", "This order is already loaded in a container, so its container terms can't change.");
    expect((await http.patch(`/orders/${order.po}`).send({ terms: "FOB", deliveryDate: "2026-12-01" }).set("Cookie", management)).status).toBe(200);
    // An order from before 0015 that 0015 couldn't settle (no terms although loaded): its terms can be set, once.
    await ctx.db.update(orders).set({ terms: null }).where(eq(orders.id, order.id));
    expect((await http.patch(`/orders/${order.po}`).send({ terms: "CNF" }).set("Cookie", management)).status).toBe(200);
    expectField(await http.patch(`/orders/${order.po}`).send({ terms: "FOB" }).set("Cookie", management), "terms", "This order is already loaded in a container, so its container terms can't change.");
  });
});

describe("containers: terms from the orders", () => {
  it("lists each loadable line with its order's terms (CON-2)", async () => {
    const order = await createOrder("CNF");
    await receive(order);
    const options = (await get("/containers/options")).body;
    expect(options.lines.find((line: { orderLineId: string }) => line.orderLineId === order.lineId)).toMatchObject({ po: order.po, terms: "CNF" });
  });

  it("gives a container its orders' terms without them being sent, for one or many orders", async () => {
    const a = await createOrder("CNF");
    const b = await createOrder("CNF");
    await receive(a);
    await receive(b);
    const res = await load([a.lineId, b.lineId]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await ctx.db.select({ terms: containers.terms }).from(containers).where(eq(containers.id, res.body.container.id)))[0]!.terms).toBe("CNF");
    expect((await get(`/containers/${res.body.container.id}`)).body.terms).toBe("CNF");
  });

  it("refuses orders with different terms in one container, naming them, and creates nothing", async () => {
    const fob = await createOrder("FOB");
    const cnf = await createOrder("CNF");
    await receive(fob);
    await receive(cnf);
    const res = await load([fob.lineId, cnf.lineId], "FOB");
    expectField(res, "lines", `${fob.po} is FOB and ${cnf.po} is CNF: one container holds orders with the same container terms.`);
    expect(await ctx.db.select({ id: containers.id }).from(containers)).toEqual([]);
    expect((await get(`/orders/${cnf.po}`)).body.stage).toBe(2);
  });

  it("refuses terms that differ from the orders', and an order without terms unless the terms are sent", async () => {
    const fob = await createOrder("FOB");
    const older = await createOrder();
    await receive(fob);
    await receive(older);
    expectField(await load([fob.lineId], "CNF"), "terms", "These orders are FOB, so the container is FOB.");
    expectField(await load([older.lineId]), "lines", `Set the container terms on ${older.po} (Edit order) before loading it.`);
    // An older client still sends the terms it chose: the order without terms takes them.
    const res = await load([older.lineId], "CNF");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await termsOf(older.id)).toBe("CNF");
    // Mixed: one order with terms, one without, terms sent matching the first: both CNF now.
    const cnf = await createOrder("CNF");
    const another = await createOrder();
    await receive(cnf);
    await receive(another);
    expect((await load([cnf.lineId, another.lineId], "CNF")).status).toBe(201);
    expect(await termsOf(another.id)).toBe("CNF");
  });
});

describe("migration 0015 backfill", () => {
  it("gives an already loaded order its containers' terms when they agree; mixed or never loaded stays null", async () => {
    const single = await createOrder();
    const mixed = await createOrder();
    const unloaded = await createOrder();
    await receive(single);
    await receive(mixed);
    await receive(unloaded);
    expect((await load([single.lineId], "CNF")).status).toBe(201);
    expect((await load([mixed.lineId], "FOB")).status).toBe(201);
    // Before 0015 an order could sit in containers with different terms: make the second container CNF directly.
    expect((await load([mixed.lineId], "FOB")).status).toBe(201);
    const second = (await ctx.db.select({ id: containers.id }).from(containers).orderBy(containers.createdAt)).at(-1)!;
    await ctx.db.update(containers).set({ terms: "CNF" }).where(eq(containers.id, second.id));
    await ctx.db.update(orders).set({ terms: null });

    const statements = readFileSync("drizzle/0015_order_terms.sql", "utf8").split("--> statement-breakpoint");
    await ctx.db.execute(sql.raw(statements.at(-1)!));
    expect(await termsOf(single.id)).toBe("CNF");
    expect(await termsOf(mixed.id)).toBeNull();
    expect(await termsOf(unloaded.id)).toBeNull();
  });
});
