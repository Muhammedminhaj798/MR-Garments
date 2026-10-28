import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, orders } from "../../db/schema";
import { SEED_ITEMS } from "../../db/seed-data";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf, makeOrder } from "../stock/fixtures";
import { MESSAGES as M } from "./items.routes";

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
});

const SEEDED_NAMES = SEED_ITEMS.map((row) => row.name);
const BLAZERS = { name: "Ladies blazers", countedIn: "Pieces", perBundle: 25, bundleLabel: null };
const list = (query = "") => http.get(`/items${query}`).set("Cookie", management);
const add = (body: object, cookie = management) => http.post("/items", body).set("Cookie", cookie);
const edit = (id: string, body: object, cookie = management) => http.patch(`/items/${id}`, body).set("Cookie", cookie);
const itemId = (name: string) => idOf(ctx, items, name);
const count = async () => (await ctx.db.select().from(items)).length;
const fieldsOf = (res: { status: number; body: { error: { code: string; fields: Record<string, string> } } }) => {
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe("validation_failed");
  return res.body.error.fields;
};
/** An order whose lines are the given items, renumbered to `po`. */
async function orderOf(po: string, itemNames: string[]) {
  const order = await makeOrder(ctx, { lines: itemNames.map((item) => ({ item, quantity: 100, rateCny: 10 })) });
  await ctx.db.update(orders).set({ poNumber: po }).where(eq(orders.id, order.id));
}

describe("access: Management only (B6)", () => {
  it("is 401 signed out and 403 for Procurement, changing nothing", async () => {
    const jeans = await itemId("Denim jeans");
    const priya = await signInAs(ctx, SEEDED.procurement);
    for (const res of [await http.post("/items", BLAZERS), await http.patch(`/items/${jeans}`, { status: "Inactive" })]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthenticated");
    }
    for (const res of [await add(BLAZERS, priya), await edit(jeans, { status: "Inactive" }, priya)]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    expect(await count()).toBe(SEED_ITEMS.length);
    expect((await list("?status=Inactive")).body).toEqual([]);
  });
});

describe("POST /items", () => {
  it("adds an item counted per bundle as Active with no orders, listed last", async () => {
    const res = await add({ ...BLAZERS, name: "  Ladies blazers " });
    expect(res.status).toBe(201);
    expect(res.body).toStrictEqual({ item: { id: expect.any(String), ...BLAZERS, usedInOrders: [], status: "Active" } });
    const listed = (await list()).body;
    expect(listed.map((row: { name: string }) => row.name)).toEqual([...SEEDED_NAMES, "Ladies blazers"]);
    expect(listed.at(-1)).toEqual(res.body.item);
  });

  it("adds an item with a bundle label, trimmed, the missing perBundle null", async () => {
    const res = await add({ name: "Linen fabric", countedIn: "Metres", bundleLabel: " Bale " });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ name: "Linen fabric", countedIn: "Metres", perBundle: null, bundleLabel: "Bale" });
  });

  it("needs exactly one of perBundle and bundleLabel", async () => {
    for (const body of [
      { name: "Scarves", countedIn: "Pieces" },
      { name: "Scarves", countedIn: "Pieces", perBundle: null, bundleLabel: null },
      { name: "Scarves", countedIn: "Pieces", perBundle: null, bundleLabel: "   " },
      { name: "Scarves", countedIn: "Pieces", perBundle: 20, bundleLabel: "Box" },
    ]) {
      expect(fieldsOf(await add(body)), JSON.stringify(body)).toEqual({ perBundle: M.bundle });
    }
    expect(await count()).toBe(SEED_ITEMS.length);
  });

  it("refuses a bad name, unit or pieces per bundle with 422 under the field", async () => {
    expect(fieldsOf(await add({ ...BLAZERS, name: "  " }))).toEqual({ name: M.name });
    expect(fieldsOf(await add({ countedIn: "Pieces", perBundle: 25 }))).toEqual({ name: M.name });
    expect(fieldsOf(await add({ ...BLAZERS, name: "x".repeat(201) }))).toEqual({ name: M.nameTooLong });
    for (const countedIn of ["Kilos", "pieces", undefined, 1]) {
      expect(fieldsOf(await add({ ...BLAZERS, countedIn })), String(countedIn)).toEqual({ countedIn: M.countedIn });
    }
    for (const perBundle of [0, -5, 1.5, 100_001, "25"]) {
      expect(fieldsOf(await add({ ...BLAZERS, perBundle })), String(perBundle)).toEqual({ perBundle: M.perBundle });
    }
    expect(fieldsOf(await add({ ...BLAZERS, perBundle: null, bundleLabel: "x".repeat(201) }))).toEqual({ bundleLabel: M.bundleLabelTooLong });
    expect((await add({ ...BLAZERS, perBundle: 100_000 })).status).toBe(201);
  });

  it("refuses unknown keys and a body that isn't an object with 400", async () => {
    for (const body of [{ ...BLAZERS, status: "Inactive" }, { ...BLAZERS, usedInOrders: [] }, [BLAZERS]]) {
      const res = await add(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
    expect(await count()).toBe(SEED_ITEMS.length);
  });

  it("refuses a name already used in any capitalisation with 409 under name", async () => {
    for (const name of ["denim JEANS", " Cotton Fabric "]) {
      const res = await add({ ...BLAZERS, name });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toEqual({ code: "name_exists", message: M.nameTaken, fields: { name: M.nameTaken } });
    }
    expect(await count()).toBe(SEED_ITEMS.length);
  });
});

describe("PATCH /items/:id", () => {
  it("changes only the keys sent and answers with the full row", async () => {
    const jeans = await itemId("Denim jeans");
    const res = await edit(jeans, { name: " Denim jeans (slim) " });
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      item: { id: jeans, name: "Denim jeans (slim)", countedIn: "Pieces", perBundle: 50, bundleLabel: null, usedInOrders: [], status: "Active" },
    });
    expect((await edit(jeans, { countedIn: "Metres", perBundle: 40 })).body.item).toMatchObject({ countedIn: "Metres", perBundle: 40 });
    // Its own name in another capitalisation is not a duplicate.
    expect((await edit(jeans, { name: "DENIM JEANS (SLIM)" })).body.item.name).toBe("DENIM JEANS (SLIM)");
  });

  it("switches between pieces per bundle and a bundle label, keeping exactly one set", async () => {
    const jeans = await itemId("Denim jeans");
    expect((await edit(jeans, { bundleLabel: "Bale" })).body.item).toMatchObject({ perBundle: null, bundleLabel: "Bale" });
    expect((await edit(jeans, { perBundle: 30 })).body.item).toMatchObject({ perBundle: 30, bundleLabel: null });
    expect((await edit(jeans, { perBundle: null, bundleLabel: "Roll" })).body.item).toMatchObject({ perBundle: null, bundleLabel: "Roll" });
    expect((await edit(jeans, { bundleLabel: null, perBundle: 60 })).body.item).toMatchObject({ perBundle: 60, bundleLabel: null });
    // Other keys leave the bundle alone.
    expect((await edit(jeans, { status: "Active" })).body.item).toMatchObject({ perBundle: 60, bundleLabel: null });
  });

  it("refuses an edit that leaves no bundle, or both, with 422", async () => {
    const jeans = await itemId("Denim jeans");
    for (const body of [{ perBundle: null }, { bundleLabel: "  " }, { bundleLabel: null }, { perBundle: 10, bundleLabel: "Box" }]) {
      expect(fieldsOf(await edit(jeans, body)), JSON.stringify(body)).toEqual({ perBundle: M.bundle });
    }
    expect(fieldsOf(await edit(jeans, { perBundle: 0 }))).toEqual({ perBundle: M.perBundle });
    expect(fieldsOf(await edit(jeans, { countedIn: "Kilos" }))).toEqual({ countedIn: M.countedIn });
    expect(fieldsOf(await edit(jeans, { name: "" }))).toEqual({ name: M.name });
    expect(fieldsOf(await edit(jeans, { status: "Deleted" }))).toHaveProperty("status");
    expect((await list()).body[0]).toMatchObject({ name: "Denim jeans", perBundle: 50, bundleLabel: null, status: "Active" });
  });

  it("deactivates and reactivates an item", async () => {
    const polo = await itemId("Polo shirts");
    expect((await edit(polo, { status: "Inactive" })).body.item.status).toBe("Inactive");
    expect((await list("?status=Inactive")).body.map((row: { name: string }) => row.name)).toEqual(["Polo shirts"]);
    expect((await edit(polo, { status: "Active" })).body.item.status).toBe("Active");
  });

  it("refuses a rename to another item's name in any capitalisation with 409", async () => {
    const jeans = await itemId("Denim jeans");
    const res = await edit(jeans, { name: " COTTON fabric" });
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: "name_exists", message: M.nameTaken, fields: { name: M.nameTaken } });
    expect((await list()).body[0].name).toBe("Denim jeans");
  });

  it("can't change the unit of an item on an order (409 item_in_use), but can change the rest", async () => {
    await orderOf("PO-2050", ["Track pants", "Denim jeans"]);
    const jeans = await itemId("Denim jeans");
    const res = await edit(jeans, { countedIn: "Metres", perBundle: 40 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: "item_in_use", message: M.inUse } });
    expect((await list()).body[0]).toMatchObject({ countedIn: "Pieces", perBundle: 50 });

    const unchanged = await edit(jeans, { countedIn: "Pieces", name: "Jeans", bundleLabel: "Bale", status: "Inactive" });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.item).toMatchObject({ name: "Jeans", countedIn: "Pieces", perBundle: null, bundleLabel: "Bale", usedInOrders: ["PO-2050"] });
    // An item on no order can still change its unit.
    expect((await edit(await itemId("Kids t-shirts"), { countedIn: "Metres" })).body.item.countedIn).toBe("Metres");
  });

  it("is 404 for an unknown or malformed id", async () => {
    for (const id of ["00000000-0000-4000-8000-000000000000", "abc", "1"]) {
      const res = await edit(id, { status: "Inactive" });
      expect(res.status, id).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found", message: "Item not found." } });
    }
  });

  it("is 400 for an empty body or an unknown key", async () => {
    const jeans = await itemId("Denim jeans");
    for (const body of [{}, { usedInOrders: [] }, { id: jeans, name: "Jeans" }]) {
      const res = await edit(jeans, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
  });
});

describe("usedInOrders", () => {
  it("lists the distinct PO numbers with a line of the item, in PO order, and search matches them", async () => {
    await orderOf("PO-10000", ["Denim jeans", "Cotton fabric"]);
    await orderOf("PO-9999", ["Denim jeans", "Denim jeans"]);
    await orderOf("PO-2050", ["Cotton fabric", "Denim jeans"]);
    const used = Object.fromEntries((await list()).body.map((row: { name: string; usedInOrders: string[] }) => [row.name, row.usedInOrders]));
    expect(used).toEqual({
      ...Object.fromEntries(SEEDED_NAMES.map((name) => [name, []])),
      "Denim jeans": ["PO-2050", "PO-9999", "PO-10000"],
      "Cotton fabric": ["PO-2050", "PO-10000"],
    });

    expect((await list("?search=po-9999")).body.map((row: { name: string }) => row.name)).toEqual(["Denim jeans"]);
    expect((await list("?search=10000")).body.map((row: { name: string }) => row.name)).toEqual(["Denim jeans", "Cotton fabric"]);
    expect((await edit(await itemId("Cotton fabric"), { bundleLabel: "Bolt" })).body.item.usedInOrders).toEqual(["PO-2050", "PO-10000"]);
  });
});
