import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clearingAgents,
  clearings,
  containers,
  items,
  locations,
  payments,
  receipts,
  shippingAgents,
  suppliers,
  teams,
  transportCompanies,
  transports,
  users,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf, indiaDay, makeOrder } from "../stock/fixtures";

// DELETE /<path>/:id on the seven Settings tabs (docs/wave3-contracts.md section 4.1).

const ctx = createTestContext();
const http = api(ctx);
let management = "";
let suresh = "";
beforeAll(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  suresh = await idOf(ctx, users, "Suresh Menon");
});
afterAll(() => ctx.pool.end());

const TABS = {
  supplier: { path: "/suppliers", noun: "Supplier", body: {} },
  shippingAgent: { path: "/shipping-agents", noun: "Shipping agent", body: {} },
  clearingAgent: { path: "/clearing-agents", noun: "Clearing agent", body: {} },
  transportCompany: { path: "/transport-companies", noun: "Transport company", body: {} },
  location: { path: "/locations", noun: "Office or warehouse", body: { type: "Warehouse" } },
  team: { path: "/teams", noun: "Team", body: {} },
  item: { path: "/items", noun: "Item", body: { countedIn: "Pieces", perBundle: 10 } },
} as const;
type Tab = keyof typeof TABS;
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

/** Adds a record on the tab through its POST and returns its id. */
async function add(tab: Tab, name: string) {
  const res = await http.post(TABS[tab].path, { ...TABS[tab].body, name }).set("Cookie", management);
  expect(res.status).toBe(201);
  return res.body[tab].id as string;
}
const remove = (tab: Tab, id: string, cookie = management) => http.delete(`${TABS[tab].path}/${id}`).set("Cookie", cookie);
const listed = async (tab: Tab) => ((await http.get(TABS[tab].path).set("Cookie", management)).body as { id: string }[]).map((row) => row.id);

async function expectInUse(tab: Tab, id: string, uses: string) {
  const res = await remove(tab, id);
  expect(res.status).toBe(409);
  expect(res.body).toEqual({
    error: { code: "in_use", message: `This ${TABS[tab].noun.toLowerCase()} is used by ${uses}, so it can't be deleted. Deactivate it instead.` },
  });
  expect(await listed(tab)).toContain(id);
}

let nextContainer = 1;
const container = async (shippingAgentId?: string) =>
  (
    await ctx.db
      .insert(containers)
      .values({
        number: `DELU${String(nextContainer++).padStart(7, "0")}`,
        shippingAgentId: shippingAgentId ?? (await idOf(ctx, shippingAgents, "Sino Freight")),
        terms: "FOB",
        eta: indiaDay(10),
      })
      .returning({ id: containers.id })
  )[0]!.id;
/** A road trip of a new container. */
const trip = async ({ company, destination }: { company?: string; destination?: string }) =>
  (
    await ctx.db
      .insert(transports)
      .values({
        containerId: await container(),
        transportCompanyId: company ?? (await ctx.db.select({ id: transportCompanies.id }).from(transportCompanies).where(eq(transportCompanies.name, "Kerala Roadways")))[0]!.id,
        destinationId: destination ?? (await idOf(ctx, locations, "Main warehouse")),
        lrNumber: "LR-1",
        vehicleNumber: "KL-07-1234",
        driverPhone: "9800000000",
        bundlesLoaded: 1,
        loadedOn: indiaDay(-1),
        createdBy: suresh,
        updatedBy: suresh,
      })
      .returning({ id: transports.id })
  )[0]!.id;

describe("access", () => {
  it("is 401 signed out and 403 for every other role, deleting nothing", async () => {
    for (const tab of Object.keys(TABS) as Tab[]) {
      const id = await add(tab, `Kept ${tab}`);
      expect((await http.delete(`${TABS[tab].path}/${id}`)).status).toBe(401);
      for (const email of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
        const res = await remove(tab, id, await signInAs(ctx, email));
        expect(res.status, `${tab} ${email}`).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      }
      expect(await listed(tab)).toContain(id);
    }
  });

  it("404 for an unknown or malformed id", async () => {
    for (const tab of Object.keys(TABS) as Tab[]) {
      for (const id of [UNKNOWN, "not-a-uuid"]) {
        const res = await remove(tab, id);
        expect(res.status, `${tab} ${id}`).toBe(404);
        expect(res.body).toEqual({ error: { code: "not_found", message: `${TABS[tab].noun} not found.` } });
      }
    }
  });
});

describe("a record nothing uses", () => {
  it("is deleted: 204, gone from the list, and a second delete is 404", async () => {
    for (const tab of Object.keys(TABS) as Tab[]) {
      const id = await add(tab, `Mistake ${tab}`);
      const res = await remove(tab, id);
      expect(res.status, tab).toBe(204);
      expect(res.text).toBe("");
      expect(await listed(tab)).not.toContain(id);
      expect((await remove(tab, id)).status).toBe(404);
    }
  });

  it("is deleted when inactive too", async () => {
    const id = await add("team", "Old team");
    await http.patch(`/teams/${id}`, { status: "Inactive" }).set("Cookie", management);
    expect((await remove("team", id)).status).toBe(204);
  });
});

describe("a record in use is refused with 409 in_use and kept", () => {
  it("supplier: its orders", async () => {
    const id = await add("supplier", "Ningbo Garments");
    await makeOrder(ctx, { supplier: "Ningbo Garments", lines: [{ item: "Polo shirts", quantity: 10, rateCny: 5 }] });
    await makeOrder(ctx, { supplier: "Ningbo Garments", lines: [{ item: "Polo shirts", quantity: 10, rateCny: 5 }] });
    await expectInUse("supplier", id, "2 orders");
  });

  it("shipping agent: its containers and the agent payments made to it by name", async () => {
    const id = await add("shippingAgent", "Ocean Link");
    await container(id);
    await container(id);
    const order = await makeOrder(ctx, { lines: [{ item: "Polo shirts", quantity: 10, rateCny: 5 }] });
    const due = { orderId: order.id, kind: "Balance", payeeRole: "agent", amountCny: 100, status: "due", dueDate: indiaDay(5) };
    await ctx.db.insert(payments).values({ ...due, payee: "Ocean Link" });
    await expectInUse("shippingAgent", id, "2 containers and 1 agent payment");

    // A payment alone (no container) still counts; a supplier payee of the same name doesn't.
    const other = await add("shippingAgent", "Blue Wave");
    await ctx.db.insert(payments).values([
      { ...due, payee: "Blue Wave" },
      { ...due, payee: "Blue Wave", payeeRole: "supplier" },
    ]);
    await expectInUse("shippingAgent", other, "1 agent payment");
  });

  it("clearing agent: the containers it clears", async () => {
    const id = await add("clearingAgent", "Cochin Customs");
    await ctx.db.insert(clearings).values({ containerId: await container(), clearingAgentId: id, arrivedOn: indiaDay(-2), createdBy: suresh, updatedBy: suresh });
    await expectInUse("clearingAgent", id, "1 container");
    expect((await ctx.db.select().from(clearingAgents).where(eq(clearingAgents.id, id))).length).toBe(1);
  });

  it("transport company: its trips", async () => {
    const id = await add("transportCompany", "Coastal Movers");
    await trip({ company: id });
    await expectInUse("transportCompany", id, "1 trip");
  });

  it("office or warehouse: its users (any status), China receipts, trips and warehouse receipts", async () => {
    const id = await add("location", "Second warehouse");
    await ctx.db.insert(users).values({ name: "Old Clerk", email: "old.clerk@mrgarments.com", role: "Warehouse staff", locationId: id, status: "Inactive" });
    const order = await makeOrder(ctx, { lines: [{ item: "Polo shirts", quantity: 10, rateCny: 5 }] });
    await ctx.db.insert(receipts).values({ orderId: order.id, receivedOn: indiaDay(-3), locationId: id, receivedBy: suresh, bundles: 1 });
    const tripId = await trip({ destination: id });
    await ctx.db.insert(warehouseReceipts).values({ transportId: tripId, locationId: id, receivedOn: indiaDay(), receivedBy: "Joseph M", bundlesReceived: 1, createdBy: suresh, updatedBy: suresh });
    await expectInUse("location", id, "1 user, 1 China receipt, 1 trip and 1 warehouse receipt");
  });

  it("team: the warehouse receipts that give it goods, drafts included", async () => {
    const id = await add("team", "Export team");
    const order = await makeOrder(ctx, { lines: [{ item: "Polo shirts", quantity: 10, rateCny: 5 }, { item: "Denim jeans", quantity: 10, rateCny: 5 }] });
    const receipt = (
      await ctx.db
        .insert(warehouseReceipts)
        .values({ transportId: await trip({}), locationId: await idOf(ctx, locations, "Main warehouse"), receivedOn: indiaDay(), receivedBy: "Joseph M", bundlesReceived: 1, createdBy: suresh, updatedBy: suresh })
        .returning({ id: warehouseReceipts.id })
    )[0]!.id;
    await ctx.db.insert(warehouseReceiptLines).values(order.lineIds.map((orderLineId) => ({ receiptId: receipt, orderLineId, teamId: id, quantity: 5 })));
    await expectInUse("team", id, "1 warehouse receipt");
    expect((await ctx.db.select().from(teams).where(eq(teams.id, id))).length).toBe(1);
  });

  it("item: the orders with a line of it", async () => {
    const id = await add("item", "Ladies blazers");
    await makeOrder(ctx, { lines: [{ item: "Ladies blazers", quantity: 10, rateCny: 5 }, { item: "Ladies blazers", quantity: 20, rateCny: 5 }] });
    await expectInUse("item", id, "1 order");
    expect((await ctx.db.select().from(items).where(eq(items.id, id))).length).toBe(1);
  });

  it("an order saved while the delete runs: the delete waits for it and refuses", async () => {
    const id = await add("supplier", "Racing Supplier");
    const client = await ctx.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "insert into orders (po_number, supplier_id, order_date, delivery_date) values ('PO-9999', $1, current_date, current_date)",
        [id],
      );
      const pending = remove("supplier", id).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await client.query("commit");
      const res = await pending;
      expect(res.status).toBe(409);
      // The row lock makes it wait and then count the new order (without it, the foreign key would refuse: "other records").
      expect(res.body.error.message).toBe("This supplier is used by 1 order, so it can't be deleted. Deactivate it instead.");
    } finally {
      client.release();
    }
    expect((await ctx.db.select().from(suppliers).where(eq(suppliers.id, id))).length).toBe(1);
  });
});
