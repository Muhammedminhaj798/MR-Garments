import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { suppliers, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf, makeOrder } from "../stock/fixtures";

const ctx = createTestContext();
const http = api(ctx);
let management = "";
beforeAll(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
});
afterAll(() => ctx.pool.end());

const M21 = "Enter the supplier name.";
const M22 = "A supplier with this name already exists.";
const SEEDED_NAMES = ["Guangzhou Textile Co.", "Shenzhen Apparel", "Foshan Fabrics", "Yiwu Trims Ltd.", "Hangzhou Knits"];
const NINGBO = {
  name: "Ningbo Denim Works",
  city: "Ningbo",
  contactPerson: "Mr. Xu Feng",
  phone: "+86 138 5740 9921",
  currency: "CNY",
  address: "88 Zhongshan Road, Ningbo",
  notes: "Denim only",
};

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const list = (query = "") => http.get(`/suppliers${query}`).set("Cookie", management);
const add = (body: object) => http.post("/suppliers", body).set("Cookie", management);
const edit = (id: string, body: object, cookie = management) => http.patch(`/suppliers/${id}`, body).set("Cookie", cookie);
const rowOf = async (name: string) => ((await list()).body as { id: string; name: string }[]).find((row) => row.name === name)!;
const names = (rows: { name: string }[]) => rows.map((row) => row.name);

describe("AT-R5: MD-1, MD-2 and PATCH are Management only", () => {
  it("is 401 signed out and 403 for every other role", async () => {
    const foshan = await idOf(ctx, suppliers, "Foshan Fabrics");
    expect((await http.get("/suppliers")).status).toBe(401);
    expect((await http.post("/suppliers", NINGBO)).status).toBe(401);
    expect((await http.patch(`/suppliers/${foshan}`, { status: "Inactive" })).status).toBe(401);
    for (const email of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      const cookie = await signInAs(ctx, email);
      expect((await http.get("/suppliers").set("Cookie", cookie)).status).toBe(403);
      const post = await http.post("/suppliers", NINGBO).set("Cookie", cookie);
      expect(post.status).toBe(403);
      expect(post.body.error.code).toBe("forbidden");
      const patch = await edit(foshan, { status: "Inactive" }, cookie);
      expect(patch.status).toBe(403);
      expect(patch.body.error.code).toBe("forbidden");
    }
    const stored = await ctx.db.select().from(suppliers);
    expect(stored.length).toBe(5);
    expect(stored.every((row) => row.status === "Active")).toBe(true);
  });
});

describe("MD-1 GET /suppliers", () => {
  it("AT-S1: lists the 5 seeded suppliers in creation order with 0 open orders", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(SEEDED_NAMES);
    expect(res.body[0]).toEqual({
      id: expect.any(String),
      name: "Guangzhou Textile Co.",
      contactPerson: "Mr. Zhao Lin",
      phone: "+86 138 0013 2244",
      city: "Guangzhou",
      address: "",
      notes: "",
      currency: "CNY",
      openOrders: 0,
      status: "Active",
    });
    for (const row of res.body) expect(row).toMatchObject({ openOrders: 0, status: "Active", currency: "CNY" });
  });

  it("AT-S2: searches name, contact and phone ignoring case and spaces", async () => {
    expect(names((await list("?search=YIWU")).body)).toEqual(["Yiwu Trims Ltd."]);
    expect(names((await list("?search=liu%20yan")).body)).toEqual(["Shenzhen Apparel"]);
    expect(names((await list("?search=%2B861372288")).body)).toEqual(["Foshan Fabrics"]);
    expect(names((await list("?search=%2B86%20137")).body)).toEqual(["Foshan Fabrics"]);
    expect((await list("?search=ningbo")).body).toEqual([]);
    expect(names((await list("?search=")).body)).toEqual(SEEDED_NAMES);
  });

  it("AT-S2: filters by status, together with the search", async () => {
    expect((await list("?status=Active")).body).toHaveLength(5);
    expect((await list("?status=Inactive")).body).toEqual([]);
    await ctx.db.update(suppliers).set({ status: "Inactive" }).where(eq(suppliers.name, "Foshan Fabrics"));
    expect(names((await list("?status=Inactive")).body)).toEqual(["Foshan Fabrics"]);
    expect((await list("?status=Active")).body).toHaveLength(4);
    expect(names((await list("?search=fabrics&status=Active")).body)).toEqual([]);
    expect(names((await list("?search=fabrics")).body)).toEqual(["Foshan Fabrics"]);
    await ctx.db.update(suppliers).set({ status: "Active" }).where(eq(suppliers.name, "Foshan Fabrics"));
  });

  it("refuses unknown keys, repeated keys and other status values with 400", async () => {
    for (const query of ["?sort=name", "?status=Deleted", "?status=active", "?status=All", "?search=a&search=b"]) {
      const res = await list(query);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
  });
});

describe("MD-2 POST /suppliers", () => {
  it("AT-S3: an empty or missing name is 422 with M21 under name", async () => {
    for (const body of [{ ...NINGBO, name: "" }, { ...NINGBO, name: "   " }, { city: "Ningbo" }]) {
      const res = await add(body);
      expect(res.status).toBe(422);
      expect(res.body.error).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields: { name: M21 } });
    }
    expect((await ctx.db.select().from(suppliers)).length).toBe(5);
  });

  it("refuses an unknown body key with 400 and another currency with 422", async () => {
    const unknown = await add({ ...NINGBO, openOrders: 3 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("bad_request");
    const currency = await add({ ...NINGBO, currency: "INR" });
    expect(currency.status).toBe(422);
    expect(Object.keys(currency.body.error.fields)).toEqual(["currency"]);
    expect((await ctx.db.select().from(suppliers)).length).toBe(5);
  });

  it("AT-S4: adds the supplier as Active with 0 open orders, stores address, notes and the creator", async () => {
    const res = await add({ ...NINGBO, name: "  Ningbo Denim Works " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ supplier: { ...NINGBO, id: expect.any(String), openOrders: 0, status: "Active" } });

    const listed = (await list()).body;
    expect(names(listed)).toEqual([...SEEDED_NAMES, "Ningbo Denim Works"]);
    expect(listed[5]).toEqual(res.body.supplier);
    expect(names((await list("?status=Active&search=ningbo")).body)).toEqual(["Ningbo Denim Works"]);

    const stored = (await ctx.db.select().from(suppliers).where(eq(suppliers.id, res.body.supplier.id)))[0];
    const suresh = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.management)))[0];
    expect(stored).toMatchObject({ address: NINGBO.address, notes: NINGBO.notes, createdBy: suresh?.id });
  });

  it("AT-S5: a name already used in any capitalisation is 409 with M22 under name", async () => {
    for (const name of ["ningbo denim works", " NINGBO DENIM WORKS ", "guangzhou textile co."]) {
      const res = await add({ ...NINGBO, name });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toEqual({ code: "name_exists", message: M22, fields: { name: M22 } });
    }
    expect((await ctx.db.select().from(suppliers)).length).toBe(6);
  });

  it("accepts only the name, defaulting the other fields", async () => {
    const res = await add({ name: "Wenzhou Buttons" });
    expect(res.status).toBe(201);
    expect(res.body.supplier).toMatchObject({ name: "Wenzhou Buttons", city: "", contactPerson: "", phone: "", currency: "CNY", address: "", notes: "" });
  });

  it("refuses a name or text over the length limits with 422", async () => {
    const res = await add({ name: "M".repeat(201), address: "a".repeat(1001) });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({ name: "Use 200 characters or fewer.", address: "Use 1000 characters or fewer." });
  });
});

describe("PATCH /suppliers/:id", () => {
  it("edits every field, trimmed, and returns the list row in its place", async () => {
    const id = await idOf(ctx, suppliers, "Shenzhen Apparel");
    const changed = {
      name: "Shenzhen Apparel Group",
      city: "Dongguan",
      contactPerson: "Ms. Liu Yan",
      phone: "+86 139 0000 1111",
      address: "12 Nancheng Road, Dongguan",
      notes: "Moved in October",
    };
    const res = await edit(id, { ...changed, name: "  Shenzhen Apparel Group ", city: " Dongguan " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supplier: { ...changed, id, currency: "CNY", openOrders: 0, status: "Active" } });
    expect((await list()).body[1]).toEqual(res.body.supplier);
  });

  it("changes only the fields it is sent", async () => {
    const before = await rowOf("Foshan Fabrics");
    const res = await edit(before.id, { phone: "+86 137 0000 2222" });
    expect(res.status).toBe(200);
    expect(res.body.supplier).toEqual({ ...before, phone: "+86 137 0000 2222" });
  });

  it("deactivates and reactivates; an inactive supplier is listed under Inactive", async () => {
    const id = await idOf(ctx, suppliers, "Hangzhou Knits");
    const off = await edit(id, { status: "Inactive" });
    expect(off.status).toBe(200);
    expect(off.body.supplier).toMatchObject({ name: "Hangzhou Knits", status: "Inactive" });
    expect(names((await list("?status=Inactive")).body)).toEqual(["Hangzhou Knits"]);
    expect((await edit(id, { status: "Active" })).body.supplier.status).toBe("Active");
    expect((await list("?status=Inactive")).body).toEqual([]);
  });

  it("a name another supplier uses, in any capitalisation, is 409 with M22; its own name recased is fine", async () => {
    const id = await idOf(ctx, suppliers, "Foshan Fabrics");
    for (const name of ["guangzhou textile co.", " NINGBO DENIM WORKS "]) {
      const res = await edit(id, { name });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toEqual({ code: "name_exists", message: M22, fields: { name: M22 } });
    }
    expect((await edit(id, { name: "FOSHAN FABRICS" })).body.supplier.name).toBe("FOSHAN FABRICS");
    expect((await edit(id, { name: "Foshan Fabrics" })).status).toBe(200);
  });

  it("an empty name is 422 with M21; over-long text and another status are 422 under their fields", async () => {
    const id = await idOf(ctx, suppliers, "Foshan Fabrics");
    for (const name of ["", "   "]) {
      const res = await edit(id, { name });
      expect(res.status).toBe(422);
      expect(res.body.error).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields: { name: M21 } });
    }
    const long = await edit(id, { name: "N".repeat(201), city: "C".repeat(201), notes: "n".repeat(1001) });
    expect(long.status).toBe(422);
    expect(long.body.error.fields).toEqual({
      name: "Use 200 characters or fewer.",
      city: "Use 200 characters or fewer.",
      notes: "Use 1000 characters or fewer.",
    });
    const status = await edit(id, { status: "Deleted" });
    expect(status.status).toBe(422);
    expect(Object.keys(status.body.error.fields)).toEqual(["status"]);
    expect((await edit(id, { address: "a".repeat(1000), notes: "" })).status).toBe(200);
  });

  it("an empty body or an unknown key (the currency included) is 400", async () => {
    const id = await idOf(ctx, suppliers, "Foshan Fabrics");
    for (const body of [{}, { currency: "CNY" }, { openOrders: 3 }, { name: "Foshan Fabrics", id: UNKNOWN }]) {
      const res = await edit(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual({ error: { code: "bad_request", message: "Something went wrong." } });
    }
  });

  it("an unknown or malformed id is 404", async () => {
    for (const id of [UNKNOWN, "not-a-uuid", "1"]) {
      const res = await edit(id, { status: "Inactive" });
      expect(res.status, id).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found", message: "Supplier not found." } });
    }
    expect((await http.patch("/suppliers", { status: "Inactive" }).set("Cookie", management)).status).toBe(404);
  });
});

describe("open orders", () => {
  it("counts each supplier's orders not yet received in the warehouse (stage < 6)", async () => {
    const lines = [{ item: "Track pants", quantity: 10, rateCny: 5 }];
    for (const stage of [1, 3, 5, 6, 6]) await makeOrder(ctx, { stage, supplier: "Yiwu Trims Ltd.", lines });
    await makeOrder(ctx, { stage: 2, supplier: "Hangzhou Knits", lines });

    const rows = (await list()).body as { name: string; openOrders: number }[];
    expect(Object.fromEntries(rows.map((row) => [row.name, row.openOrders]))).toEqual({
      "Guangzhou Textile Co.": 0,
      "Shenzhen Apparel Group": 0,
      "Foshan Fabrics": 0,
      "Yiwu Trims Ltd.": 3,
      "Hangzhou Knits": 1,
      "Ningbo Denim Works": 0,
      "Wenzhou Buttons": 0,
    });
    expect((await list("?search=yiwu")).body[0].openOrders).toBe(3);
    expect((await edit(await idOf(ctx, suppliers, "Yiwu Trims Ltd."), { notes: "Trims" })).body.supplier.openOrders).toBe(3);
  });
});
