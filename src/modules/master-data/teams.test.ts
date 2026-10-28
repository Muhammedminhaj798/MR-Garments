import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clearingAgents,
  clearings,
  containerLines,
  containers,
  locations,
  payments,
  shippingAgents,
  teams,
  transportCompanies,
  transports,
  users,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { indiaDay, makeOrder } from "../stock/fixtures";

const ctx = createTestContext();
const http = api(ctx);
let management = "";
beforeAll(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
});
afterAll(() => ctx.pool.end());

const NAME_EMPTY = "Enter the team name.";
const NAME_TAKEN = "A team with this name already exists.";
const BAD_REQUEST = { error: { code: "bad_request", message: "Something went wrong." } };
const noStock = { piecesInStock: 0, landedCostOfStockInr: 0, averagePerPieceInr: null };

const add = (body: object) => http.post("/teams", body).set("Cookie", management);
const edit = (id: string, body: object) => http.patch(`/teams/${id}`, body).set("Cookie", management);
const list = async () => (await http.get("/teams").set("Cookie", management)).body as { id: string; name: string }[];
const one = async (table: typeof teams | typeof clearingAgents | typeof transportCompanies | typeof locations | typeof shippingAgents | typeof users, name: string) =>
  (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;
const count = async () => (await ctx.db.select().from(teams)).length;

describe("Management only", () => {
  it("is 401 signed out and 403 for every other role, changing nothing", async () => {
    const id = await one(teams, "Retail team");
    expect((await http.post("/teams", { name: "X" })).status).toBe(401);
    expect((await http.patch(`/teams/${id}`, { name: "X" })).status).toBe(401);
    for (const email of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      const cookie = await signInAs(ctx, email);
      for (const res of [
        await http.post("/teams", { name: "X" }).set("Cookie", cookie),
        await http.patch(`/teams/${id}`, { status: "Inactive" }).set("Cookie", cookie),
      ]) {
        expect(res.status, email).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      }
    }
    expect(await count()).toBe(3);
  });
});

describe("POST /teams", () => {
  it("adds an Active team with no stock, listed last", async () => {
    const res = await add({ name: "  Export team " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ team: { id: expect.any(String), name: "Export team", ...noStock, status: "Active" } });
    const listed = await list();
    expect(listed.map((row) => row.name)).toEqual(["Retail team", "Wholesale team", "Online team", "Export team"]);
    expect(listed[3]).toEqual(res.body.team);
  });

  it("422 for a missing, empty or too long name; 400 for an unknown key", async () => {
    for (const [body, message] of [
      [{}, NAME_EMPTY],
      [{ name: "  " }, NAME_EMPTY],
      [{ name: 5 }, NAME_EMPTY],
      [{ name: "x".repeat(201) }, "Use 200 characters or fewer."],
    ] as const) {
      const res = await add(body);
      expect(res.status).toBe(422);
      expect(res.body.error).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields: { name: message } });
    }
    for (const body of [{ name: "Shop team", status: "Active" }, { name: "Shop team", piecesInStock: 0 }]) {
      const res = await add(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual(BAD_REQUEST);
    }
    expect(await count()).toBe(4);
  });

  it("409: a name already used in any capitalisation", async () => {
    for (const name of ["retail team", " EXPORT TEAM "]) {
      const res = await add({ name });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toEqual({ code: "name_exists", message: NAME_TAKEN, fields: { name: NAME_TAKEN } });
    }
    expect(await count()).toBe(4);
  });
});

describe("PATCH /teams/:id", () => {
  it("renames, deactivates and reactivates", async () => {
    const id = await one(teams, "Export team");
    const renamed = await edit(id, { name: " Export & B2B team " });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ team: { id, name: "Export & B2B team", ...noStock, status: "Active" } });
    expect((await edit(id, { name: "EXPORT & B2B TEAM" })).status).toBe(200);

    const inactive = await edit(id, { status: "Inactive" });
    expect(inactive.body.team.status).toBe("Inactive");
    const filtered = (await http.get("/teams?status=Inactive").set("Cookie", management)).body as { name: string }[];
    expect(filtered.map((row) => row.name)).toEqual(["EXPORT & B2B TEAM"]);
    expect((await edit(id, { status: "Active", name: "Export team" })).body.team).toMatchObject({ name: "Export team", status: "Active" });
  });

  it("409 on a rename onto another team; 400 for an empty body or unknown key; 422 for bad values", async () => {
    const id = await one(teams, "Export team");
    const taken = await edit(id, { name: "online TEAM" });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toEqual({ code: "name_exists", message: NAME_TAKEN, fields: { name: NAME_TAKEN } });
    for (const body of [{}, { piecesInStock: 5 }, { name: "A", id }]) {
      const res = await edit(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual(BAD_REQUEST);
    }
    expect((await edit(id, { name: "" })).body.error.fields).toEqual({ name: NAME_EMPTY });
    expect((await edit(id, { status: "All" })).body.error.fields).toEqual({ status: "Choose Active or Inactive." });
    expect((await list()).find((row) => row.id === id)?.name).toBe("Export team");
  });

  it("404 for an unknown or malformed id", async () => {
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const res = await edit(id, { name: "Somewhere" });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found", message: "Team not found." } });
    }
  });
});

describe("stock from stocked warehouse receipts (6.3)", () => {
  it("adds each team's pieces at its order's landed cost per piece; draft receipts don't count", async () => {
    const user = await one(users, "Suresh Menon");
    const authors = { createdBy: user, updatedBy: user };
    const day = indiaDay(-3);
    const warehouse = await one(locations, "Main warehouse");
    const [retail, wholesale, online] = [await one(teams, "Retail team"), await one(teams, "Wholesale team"), await one(teams, "Online team")];

    // Orders paid in full at 12 INR per CNY, no agent payments (sea freight 0).
    const a = await makeOrder(ctx, { stage: 6, lines: [{ item: "Polo shirts", quantity: 100, rateCny: 30 }] });
    const b = await makeOrder(ctx, { stage: 6, lines: [{ item: "Men's shorts", quantity: 100, rateCny: 10 }] });
    const c = await makeOrder(ctx, { stage: 5, lines: [{ item: "Denim jeans", quantity: 10, rateCny: 50 }] });
    const paid = { kind: "Deposit", status: "paid", paidOn: indiaDay(-20), mode: "Bank", payee: "Guangzhou Textile Co.", payeeRole: "supplier", rateInr: 12 };
    await ctx.db.insert(payments).values([
      { ...paid, orderId: a.id, amountCny: 3000 },
      { ...paid, orderId: b.id, amountCny: 1000 },
      { ...paid, orderId: c.id, amountCny: 500 },
    ]);

    type Line = { orderLineId: string; quantity: number };
    /** A container carrying `loads`, cleared (2000 INR), carried (1000 INR) and received with `status`. */
    async function lifecycle(number: string, loads: Line[], status: "draft" | "stocked", split: (Line & { teamId: string })[]) {
      const [box] = await ctx.db
        .insert(containers)
        .values({ number, shippingAgentId: await one(shippingAgents, "Sino Freight"), terms: "FOB", loadedOn: indiaDay(-15), eta: indiaDay(-5), status: "arrived" })
        .returning({ id: containers.id });
      await ctx.db.insert(containerLines).values(loads.map((load) => ({ ...load, containerId: box!.id, bundles: 1 })));
      await ctx.db.insert(clearings).values({
        ...authors,
        containerId: box!.id,
        clearingAgentId: await one(clearingAgents, "Kochi Clearing Services"),
        arrivedOn: day,
        dutyPaidOn: day,
        clearedOn: day,
        customsDutyInr: 2000,
        status: "cleared",
      });
      const [trip] = await ctx.db
        .insert(transports)
        .values({
          ...authors,
          containerId: box!.id,
          transportCompanyId: await one(transportCompanies, "Kerala Roadways"),
          destinationId: warehouse,
          lrNumber: `LR-${number}`,
          vehicleNumber: "KL-07-1234",
          driverPhone: "9800000000",
          bundlesLoaded: loads.length,
          loadedOn: day,
          unloadedOn: day,
          bundlesReceived: loads.length,
          freightInr: 1000,
          status: "unloaded",
        })
        .returning({ id: transports.id });
      const [receipt] = await ctx.db
        .insert(warehouseReceipts)
        .values({ ...authors, transportId: trip!.id, locationId: warehouse, receivedOn: day, receivedBy: "Joseph M", bundlesReceived: loads.length, status })
        .returning({ id: warehouseReceipts.id });
      await ctx.db.insert(warehouseReceiptLines).values(split.map((line) => ({ ...line, receiptId: receipt!.id })));
    }

    // A is 3000 of the container's 4000 CNY: 36000 goods + 1500 clearing + 750 transport = 38250 over 100 pieces = 382.50.
    // B: 12000 + 500 + 250 = 12750 over the 50 pieces stocked = 255.00.
    await lifecycle(
      "TEAM 1000001",
      [
        { orderLineId: a.lineIds[0]!, quantity: 100 },
        { orderLineId: b.lineIds[0]!, quantity: 100 },
      ],
      "stocked",
      [
        { orderLineId: a.lineIds[0]!, teamId: retail, quantity: 60 },
        { orderLineId: a.lineIds[0]!, teamId: online, quantity: 40 },
        { orderLineId: b.lineIds[0]!, teamId: retail, quantity: 50 },
      ],
    );
    await lifecycle("TEAM 1000002", [{ orderLineId: c.lineIds[0]!, quantity: 10 }], "draft", [{ orderLineId: c.lineIds[0]!, teamId: wholesale, quantity: 10 }]);

    const res = await http.get("/teams").set("Cookie", management);
    expect(res.status).toBe(200);
    const retailStock = { id: retail, name: "Retail team", piecesInStock: 110, landedCostOfStockInr: 35700, averagePerPieceInr: 324.55, status: "Active" };
    expect(res.body).toEqual([
      // 60 * 382.50 + 50 * 255.00 = 35700 over 110 pieces = 324.545...
      retailStock,
      { id: wholesale, name: "Wholesale team", ...noStock, status: "Active" },
      { id: online, name: "Online team", piecesInStock: 40, landedCostOfStockInr: 15300, averagePerPieceInr: 382.5, status: "Active" },
      expect.objectContaining({ name: "Export team", ...noStock }),
    ]);

    // An edit answers with the same stock figures.
    const renamed = await edit(retail, { name: "Retail shops team" });
    expect(renamed.body.team).toEqual({ ...retailStock, name: "Retail shops team" });
  });
});
