import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { units } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { makeOrder } from "../stock/fixtures";
import { MESSAGES as M } from "./units.routes";

const ctx = createTestContext();
const http = api(ctx);
let management = "";
beforeAll(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
});
afterAll(() => ctx.pool.end());

type UnitRow = { id: string; name: string; symbol: string; usedByItems: string[]; status: string };
const BAD_REQUEST = { error: { code: "bad_request", message: "Something went wrong." } };
const UNIT_MISSING = "Choose a unit from the list.";
const add = (body: object, cookie = management) => http.post("/units", body).set("Cookie", cookie);
const edit = (id: string, body: object, cookie = management) => http.patch(`/units/${id}`, body).set("Cookie", cookie);
const remove = (id: string, cookie = management) => http.delete(`/units/${id}`).set("Cookie", cookie);
const list = async (query = "") => (await http.get(`/units${query}`).set("Cookie", management)).body as UnitRow[];
const unitId = async (name: string) => (await ctx.db.select({ id: units.id }).from(units).where(eq(units.name, name)))[0]!.id;
const count = async () => (await ctx.db.select().from(units)).length;
const addItem = (body: object) => http.post("/items", body).set("Cookie", management);
const editItem = (id: string, body: object) => http.patch(`/items/${id}`, body).set("Cookie", management);
const itemList = async () => (await http.get("/items").set("Cookie", management)).body as { id: string; name: string; countedIn: string }[];
const SEEDED_IN_PIECES = ["Denim jeans", "Track pants", "Kids t-shirts", "Ladies kurtis", "Polo shirts", "Men's shorts", "Men's jackets"];

describe("Management only", () => {
  it("is 401 signed out and 403 for every other role, changing nothing", async () => {
    const id = await unitId("Pieces");
    expect((await http.get("/units")).status).toBe(401);
    expect((await http.post("/units", { name: "Kilograms" })).status).toBe(401);
    expect((await http.patch(`/units/${id}`, { name: "X" })).status).toBe(401);
    expect((await http.delete(`/units/${id}`)).status).toBe(401);
    for (const email of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      const cookie = await signInAs(ctx, email);
      for (const res of [
        await http.get("/units").set("Cookie", cookie),
        await add({ name: "Kilograms" }, cookie),
        await edit(id, { status: "Inactive" }, cookie),
        await remove(id, cookie),
      ]) {
        expect(res.status, email).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      }
    }
    expect(await count()).toBe(2);
  });
});

describe("GET /units", () => {
  it("lists the seeded units with their symbols and the items counted in them; search matches name and symbol", async () => {
    expect(await list()).toEqual([
      { id: expect.any(String), name: "Pieces", symbol: "pcs", usedByItems: SEEDED_IN_PIECES, status: "Active" },
      { id: expect.any(String), name: "Metres", symbol: "m", usedByItems: ["Cotton fabric"], status: "Active" },
    ]);
    expect((await list("?search=M")).map((row) => row.name)).toEqual(["Metres"]);
    expect((await list("?search=pc")).map((row) => row.name)).toEqual(["Pieces"]);
  });
});

describe("POST /units", () => {
  it("adds an Active unit, trimmed, with an optional symbol, listed last", async () => {
    const res = await add({ name: "  Kilograms ", symbol: " kg " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ unit: { id: expect.any(String), name: "Kilograms", symbol: "kg", usedByItems: [], status: "Active" } });
    expect((await add({ name: "Rolls" })).body.unit).toMatchObject({ name: "Rolls", symbol: "", status: "Active" });
    expect((await list()).map((row) => row.name)).toEqual(["Pieces", "Metres", "Kilograms", "Rolls"]);
  });

  it("422 for a missing, empty or too long name or symbol; 400 for an unknown key", async () => {
    for (const [body, fields] of [
      [{}, { name: M.name }],
      [{ name: "  " }, { name: M.name }],
      [{ name: 5 }, { name: M.name }],
      [{ name: "x".repeat(51) }, { name: M.nameTooLong }],
      [{ name: "Boxes", symbol: "x".repeat(11) }, { symbol: M.symbolTooLong }],
    ] as const) {
      const res = await add(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields });
    }
    for (const body of [{ name: "Boxes", status: "Active" }, { name: "Boxes", usedByItems: [] }]) {
      const res = await add(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual(BAD_REQUEST);
    }
    expect(await count()).toBe(4);
  });

  it("409: a name already used in any capitalisation", async () => {
    for (const name of ["pieces", " KILOGRAMS "]) {
      const res = await add({ name });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toEqual({ code: "name_exists", message: M.nameTaken, fields: { name: M.nameTaken } });
    }
    expect(await count()).toBe(4);
  });
});

describe("PATCH /units/:id", () => {
  it("renames (reaching the items counted in it), changes the symbol, deactivates and reactivates", async () => {
    const id = await unitId("Metres");
    const renamed = await edit(id, { name: " Meters ", symbol: "mtr" });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ unit: { id, name: "Meters", symbol: "mtr", usedByItems: ["Cotton fabric"], status: "Active" } });
    expect((await itemList()).find((row) => row.name === "Cotton fabric")?.countedIn).toBe("Meters");
    // Its own name in another capitalisation is not a duplicate.
    expect((await edit(id, { name: "METERS" })).body.unit.name).toBe("METERS");

    expect((await edit(id, { status: "Inactive" })).body.unit.status).toBe("Inactive");
    expect((await list("?status=Inactive")).map((row) => row.name)).toEqual(["METERS"]);
    expect((await edit(id, { status: "Active", name: "Metres", symbol: "m" })).body.unit).toMatchObject({ name: "Metres", symbol: "m", status: "Active" });
    expect((await itemList()).find((row) => row.name === "Cotton fabric")?.countedIn).toBe("Metres");
  });

  it("409 on a rename onto another unit; 400 for an empty body or unknown key; 422 for bad values; 404 for an unknown id", async () => {
    const id = await unitId("Kilograms");
    const taken = await edit(id, { name: "ROLLS" });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toEqual({ code: "name_exists", message: M.nameTaken, fields: { name: M.nameTaken } });
    for (const body of [{}, { usedByItems: [] }, { name: "A", id }]) {
      const res = await edit(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual(BAD_REQUEST);
    }
    expect((await edit(id, { name: "" })).body.error.fields).toEqual({ name: M.name });
    expect((await edit(id, { status: "All" })).body.error.fields).toEqual({ status: M.status });
    for (const unknown of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const res = await edit(unknown, { name: "Somewhere" });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found", message: "Unit not found." } });
    }
    expect((await list()).find((row) => row.id === id)?.name).toBe("Kilograms");
  });
});

describe("DELETE /units/:id", () => {
  it("deletes a unit no item uses; one in use is refused with 409 in_use", async () => {
    const rolls = await unitId("Rolls");
    expect((await remove(rolls)).status).toBe(204);
    expect((await list()).map((row) => row.name)).toEqual(["Pieces", "Metres", "Kilograms"]);
    expect((await remove(rolls)).status).toBe(404);

    const res = await remove(await unitId("Pieces"));
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: "in_use", message: "This unit is used by 7 items, so it can't be deleted. Deactivate it instead." });
    expect(await count()).toBe(3);
  });
});

describe("items counted in a unit", () => {
  it("a new unit is usable on an item at once (any letter case); an inactive or unknown one is not", async () => {
    const yarn = await addItem({ name: "Yarn", countedIn: "kilograms", bundleLabel: "Bag" });
    expect(yarn.status).toBe(201);
    expect(yarn.body.item.countedIn).toBe("Kilograms");
    expect((await list()).find((row) => row.name === "Kilograms")?.usedByItems).toEqual(["Yarn"]);
    // The order form shows the unit's symbol.
    const options = (await http.get("/orders/options").set("Cookie", management)).body.items as { name: string; unit: string }[];
    expect(options.find((item) => item.name === "Yarn")?.unit).toBe("kg");

    await edit(await unitId("Kilograms"), { status: "Inactive" });
    for (const countedIn of ["Kilograms", "Boxes"]) {
      const refused = await addItem({ name: "Wool", countedIn, bundleLabel: "Bag" });
      expect(refused.status, countedIn).toBe(422);
      expect(refused.body.error.fields).toEqual({ countedIn: UNIT_MISSING });
    }
  });

  it("an item keeps a deactivated unit, on an order or not, can be edited with it, and follows the unit's rename", async () => {
    const yarn = (await itemList()).find((row) => row.name === "Yarn")!;
    await makeOrder(ctx, { lines: [{ item: "Yarn", quantity: 10, rateCny: 1 }] });
    const edited = await editItem(yarn.id, { name: "Wool yarn", countedIn: "KILOGRAMS" });
    expect(edited.status).toBe(200);
    expect(edited.body.item).toMatchObject({ name: "Wool yarn", countedIn: "Kilograms" });
    // Moving it to another unit is refused while it is on an order (409 item_in_use).
    expect((await editItem(yarn.id, { countedIn: "Pieces" })).status).toBe(409);

    const kilos = await unitId("Kilograms");
    expect((await edit(kilos, { name: "Kilos", symbol: "", status: "Active" })).status).toBe(200);
    expect((await itemList()).find((row) => row.id === yarn.id)?.countedIn).toBe("Kilos");
    // Without a symbol, the screens show the unit's name.
    const orders = (await http.get("/orders").set("Cookie", management)).body as { item: string; unit: string }[];
    expect(orders.find((row) => row.item === "Wool yarn")?.unit).toBe("Kilos");
  });
});
