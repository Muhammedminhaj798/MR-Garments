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
const BLAZERS = { name: "Ladies blazers", countedIn: "Pieces", price: 1250.5 };
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
  it("adds an item with its price as Active with no orders, listed last", async () => {
    const res = await add({ ...BLAZERS, name: "  Ladies blazers " });
    expect(res.status).toBe(201);
    expect(res.body).toStrictEqual({ item: { id: expect.any(String), ...BLAZERS, usedInOrders: [], status: "Active" } });
    const listed = (await list()).body;
    expect(listed.map((row: { name: string }) => row.name)).toEqual([...SEEDED_NAMES, "Ladies blazers"]);
    expect(listed.at(-1)).toEqual(res.body.item);
  });

  it("takes no price (null) or a price of 0; the price keeps its paise", async () => {
    const none = await add({ name: "Linen fabric", countedIn: "Metres" });
    expect(none.status).toBe(201);
    expect(none.body.item).toMatchObject({ name: "Linen fabric", countedIn: "Metres", price: null });
    expect((await add({ name: "Scarves", countedIn: "Pieces", price: 0 })).body.item.price).toBe(0);
    expect((await add({ name: "Buttons", countedIn: "Pieces", price: 0.75 })).body.item.price).toBe(0.75);
    expect((await add({ name: "Silk", countedIn: "Metres", price: 99_999_999.99 })).body.item.price).toBe(99_999_999.99);
  });

  it("refuses a bad name, unit or price with 422 under the field", async () => {
    expect(fieldsOf(await add({ ...BLAZERS, name: "  " }))).toEqual({ name: M.name });
    expect(fieldsOf(await add({ countedIn: "Pieces", price: 25 }))).toEqual({ name: M.name });
    expect(fieldsOf(await add({ ...BLAZERS, name: "x".repeat(201) }))).toEqual({ name: M.nameTooLong });
    for (const countedIn of ["Kilos", "", undefined, 1]) {
      expect(fieldsOf(await add({ ...BLAZERS, countedIn })), String(countedIn)).toEqual({ countedIn: M.countedIn });
    }
    // Negative, more than 2 decimals, text, or beyond what an order line's rate accepts.
    for (const price of [-0.01, -5, 1.234, "12.5", 100_000_000]) {
      expect(fieldsOf(await add({ ...BLAZERS, price })), String(price)).toEqual({ price: M.price });
    }
    expect(await count()).toBe(SEED_ITEMS.length);
  });

  it("refuses unknown keys and a body that isn't an object with 400", async () => {
    // The retired bundle keys are unknown keys now.
    for (const body of [{ ...BLAZERS, status: "Inactive" }, { ...BLAZERS, usedInOrders: [] }, { ...BLAZERS, perBundle: 25 }, { ...BLAZERS, bundleLabel: "Roll" }, [BLAZERS]]) {
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
      item: { id: jeans, name: "Denim jeans (slim)", countedIn: "Pieces", price: null, usedInOrders: [], status: "Active" },
    });
    expect((await edit(jeans, { countedIn: "Metres", price: 40 })).body.item).toMatchObject({ countedIn: "Metres", price: 40 });
    // Its own name in another capitalisation is not a duplicate.
    expect((await edit(jeans, { name: "DENIM JEANS (SLIM)" })).body.item.name).toBe("DENIM JEANS (SLIM)");
  });

  it("sets, changes and clears the price; other keys leave it alone", async () => {
    const jeans = await itemId("Denim jeans");
    expect((await edit(jeans, { price: 12.5 })).body.item.price).toBe(12.5);
    expect((await edit(jeans, { price: 0 })).body.item.price).toBe(0);
    expect((await edit(jeans, { status: "Active" })).body.item.price).toBe(0);
    expect((await edit(jeans, { price: null })).body.item.price).toBeNull();
  });

  it("an item's price is only a default: changing it never touches a saved order line, and the order form sees the new price", async () => {
    await orderOf("PO-2050", ["Denim jeans"]);
    const jeans = await itemId("Denim jeans");
    expect((await edit(jeans, { price: 99.5 })).body.item.price).toBe(99.5);
    const order = (await http.get("/orders/PO-2050").set("Cookie", management)).body;
    expect(order.lines[0]).toMatchObject({ rateCny: 10, quantity: 100 });
    expect(order.orderValueCny).toBe(1000);
    const options = (await http.get("/orders/options").set("Cookie", management)).body.items as { id: string; price: number | null }[];
    expect(options.find((item) => item.id === jeans)?.price).toBe(99.5);
  });

  it("refuses a bad price, unit, name or status with 422", async () => {
    const jeans = await itemId("Denim jeans");
    for (const price of [-1, 1.005, "x", 100_000_000]) {
      expect(fieldsOf(await edit(jeans, { price })), String(price)).toEqual({ price: M.price });
    }
    expect(fieldsOf(await edit(jeans, { countedIn: "Kilos" }))).toEqual({ countedIn: M.countedIn });
    expect(fieldsOf(await edit(jeans, { name: "" }))).toEqual({ name: M.name });
    expect(fieldsOf(await edit(jeans, { status: "Deleted" }))).toHaveProperty("status");
    expect((await list()).body[0]).toMatchObject({ name: "Denim jeans", price: null, status: "Active" });
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
    const res = await edit(jeans, { countedIn: "Metres", price: 40 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: "item_in_use", message: M.inUse } });
    expect((await list()).body[0]).toMatchObject({ countedIn: "Pieces", price: null });

    const unchanged = await edit(jeans, { countedIn: "Pieces", name: "Jeans", price: 40, status: "Inactive" });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.item).toMatchObject({ name: "Jeans", countedIn: "Pieces", price: 40, usedInOrders: ["PO-2050"] });
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
    expect((await edit(await itemId("Cotton fabric"), { price: 8.25 })).body.item.usedInOrders).toEqual(["PO-2050", "PO-10000"]);
  });
});
