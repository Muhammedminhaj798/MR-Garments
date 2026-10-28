import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { locations, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";

const ctx = createTestContext();
const http = api(ctx);
let management = "";
beforeAll(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
});
afterAll(() => ctx.pool.end());

const NAME_EMPTY = "Enter the office or warehouse name.";
const NAME_TAKEN = "An office or warehouse with this name already exists.";
const TYPE = "Choose a type.";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const BAD_REQUEST = { error: { code: "bad_request", message: "Something went wrong." } };
const NOT_FOUND = { error: { code: "not_found", message: "Office or warehouse not found." } };

const add = (body: object) => http.post("/locations", body).set("Cookie", management);
const edit = (id: string, body: object) => http.patch(`/locations/${id}`, body).set("Cookie", management);
const list = async (query = "") => (await http.get(`/locations${query}`).set("Cookie", management)).body as { id: string; name: string }[];
const idOf = async (name: string) => (await ctx.db.select({ id: locations.id }).from(locations).where(eq(locations.name, name)))[0]!.id;
const count = async () => (await ctx.db.select().from(locations)).length;

describe("Management only", () => {
  it("is 401 signed out and 403 for every other role, changing nothing", async () => {
    const id = await idOf("Main warehouse");
    expect((await http.post("/locations", { name: "X", type: "Warehouse" })).status).toBe(401);
    expect((await http.patch(`/locations/${id}`, { name: "X" })).status).toBe(401);
    for (const email of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      const cookie = await signInAs(ctx, email);
      for (const res of [
        await http.post("/locations", { name: "X", type: "Warehouse" }).set("Cookie", cookie),
        await http.patch(`/locations/${id}`, { status: "Inactive" }).set("Cookie", cookie),
      ]) {
        expect(res.status, email).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      }
    }
    expect(await count()).toBe(3);
    expect((await list("?status=Active")).map((row) => row.name)).toEqual(["Guangzhou office", "India office", "Main warehouse"]);
  });
});

describe("POST /locations", () => {
  it("adds an Active location with no staff, the country set from the type, listed last", async () => {
    const res = await add({ name: "  Yiwu office ", type: "China office", address: " 12 Futian Road, Yiwu " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      location: { id: expect.any(String), name: "Yiwu office", type: "China office", country: "China", address: "12 Futian Road, Yiwu", staff: [], status: "Active" },
    });
    const listed = await list();
    expect(listed.map((row) => row.name)).toEqual(["Guangzhou office", "India office", "Main warehouse", "Yiwu office"]);
    expect(listed[3]).toEqual(res.body.location);

    for (const [name, type] of [
      ["Delhi office", "India office"],
      ["Kochi warehouse 2", "Warehouse"],
    ]) {
      const other = await add({ name, type });
      expect(other.status).toBe(201);
      expect(other.body.location).toMatchObject({ name, type, country: "India", address: "", staff: [], status: "Active" });
    }
  });

  it("422: a missing or empty name, a missing or unknown type, each under its field", async () => {
    const cases: [object, Record<string, string>][] = [
      [{ type: "Warehouse" }, { name: NAME_EMPTY }],
      [{ name: "   ", type: "Warehouse" }, { name: NAME_EMPTY }],
      [{ name: "Pune office" }, { type: TYPE }],
      [{ name: "Pune office", type: "Head office" }, { type: TYPE }],
      [{ name: "Pune office", type: "warehouse" }, { type: TYPE }],
      [{}, { name: NAME_EMPTY, type: TYPE }],
      [{ name: "x".repeat(201), type: "Warehouse" }, { name: "Use 200 characters or fewer." }],
      [{ name: "Pune office", type: "Warehouse", address: "x".repeat(1001) }, { address: "Use 1000 characters or fewer." }],
    ];
    for (const [body, fields] of cases) {
      const res = await add(body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(422);
      expect(res.body.error).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields });
    }
    expect(await count()).toBe(6);
  });

  it("400: an unknown key, the country or the status included", async () => {
    for (const extra of [{ country: "China" }, { status: "Inactive" }, { staff: [] }]) {
      const res = await add({ name: "Pune office", type: "India office", ...extra });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(BAD_REQUEST);
    }
    expect(await count()).toBe(6);
  });

  it("409: a name already used in any capitalisation", async () => {
    for (const name of ["main warehouse", " GUANGZHOU OFFICE ", "yiwu Office"]) {
      const res = await add({ name, type: "Warehouse" });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toEqual({ code: "name_exists", message: NAME_TAKEN, fields: { name: NAME_TAKEN } });
    }
    expect(await count()).toBe(6);
  });
});

describe("PATCH /locations/:id", () => {
  it("changes the name and address only, keeping the type, country and staff", async () => {
    const id = await idOf("Main warehouse");
    const res = await edit(id, { name: " Kochi main warehouse ", address: "Willingdon Island, Kochi" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      location: { id, name: "Kochi main warehouse", type: "Warehouse", country: "India", address: "Willingdon Island, Kochi", staff: ["Joseph M"], status: "Active" },
    });
    expect((await list()).find((row) => row.id === id)).toEqual(res.body.location);
    // Another capitalisation of its own name is not a duplicate.
    expect((await edit(id, { name: "Kochi Main Warehouse" })).body.location.name).toBe("Kochi Main Warehouse");
  });

  it("409: renaming onto another location's name in any capitalisation", async () => {
    const id = await idOf("Yiwu office");
    const res = await edit(id, { name: "india OFFICE" });
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: "name_exists", message: NAME_TAKEN, fields: { name: NAME_TAKEN } });
    expect((await list()).find((row) => row.id === id)?.name).toBe("Yiwu office");
  });

  it("400: an empty body, an unknown key or the type (it can't change)", async () => {
    const id = await idOf("Yiwu office");
    for (const body of [{}, { foo: 1 }, { type: "Warehouse" }, { name: "Yiwu office", type: "China office" }, { country: "India" }]) {
      const res = await edit(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual(BAD_REQUEST);
    }
    expect((await list()).find((row) => row.id === id)).toMatchObject({ type: "China office", country: "China" });
  });

  it("422: an empty name or another status value", async () => {
    const id = await idOf("Yiwu office");
    expect((await edit(id, { name: " " })).body.error.fields).toEqual({ name: NAME_EMPTY });
    for (const status of ["Deleted", "inactive", null]) {
      const res = await edit(id, { status });
      expect(res.status).toBe(422);
      expect(res.body.error.fields).toEqual({ status: "Choose Active or Inactive." });
    }
  });

  it("404: an unknown or malformed id", async () => {
    for (const id of [UNKNOWN_ID, "abc", "1"]) {
      const res = await edit(id, { name: "Somewhere" });
      expect(res.status, id).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
  });

  it("deactivates and reactivates; the location's users keep working", async () => {
    const id = await idOf("Kochi Main Warehouse");
    const res = await edit(id, { status: "Inactive" });
    expect(res.status).toBe(200);
    expect(res.body.location).toMatchObject({ status: "Inactive", staff: ["Joseph M"] });
    expect((await list("?status=Inactive")).map((row) => row.name)).toEqual(["Kochi Main Warehouse"]);
    expect((await list("?status=Active")).map((row) => row.name)).not.toContain("Kochi Main Warehouse");

    // Joseph is still signed in at his office, and his record can still be edited without changing it (USR-4).
    const joseph = await signInAs(ctx, SEEDED.warehouseStaff);
    const me = await http.get("/me").set("Cookie", joseph);
    expect(me.status).toBe(200);
    expect(me.body.office).toEqual({ id, name: "Kochi Main Warehouse", type: "Warehouse" });
    const josephId = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.warehouseStaff)))[0]!.id;
    const saved = await http.patch(`/users/${josephId}`, { phone: "+91 98470 11111", officeId: id }).set("Cookie", management);
    expect(saved.status).toBe(200);
    expect(saved.body.user).toMatchObject({ officeId: id, office: "Kochi Main Warehouse" });
    // But nobody new can be put there, and the user form no longer offers it.
    const anilId = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.indiaStaff)))[0]!.id;
    const moved = await http.patch(`/users/${anilId}`, { officeId: id }).set("Cookie", management);
    expect(moved.status).toBe(422);
    expect(moved.body.error.fields).toEqual({ officeId: "Choose an office from the list." });
    const options = (await http.get(`/users/${josephId}`).set("Cookie", management)).body.options.offices as { id: string }[];
    expect(options.map((office) => office.id)).not.toContain(id);

    const back = await edit(id, { status: "Active" });
    expect(back.body.location.status).toBe("Active");
  });
});
