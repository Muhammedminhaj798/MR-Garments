import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { orders, supplierDeposits, suppliers, users } from "../../db/schema";
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
const CODE_SHAPE = "Use up to 20 letters, digits or dashes.";
const CODE_TAKEN = "A supplier with this code already exists.";
const EMAIL = "Enter a valid email address.";
const SEEDED_NAMES = ["Guangzhou Textile Co.", "Shenzhen Apparel", "Foshan Fabrics", "Yiwu Trims Ltd.", "Hangzhou Knits"];
const NINGBO = {
  name: "Ningbo Denim Works",
  city: "Ningbo",
  contactPerson: "Mr. Xu Feng",
  phone: "+86 138 5740 9921",
  currency: "USD", // any of CNY, USD and INR (0006)
  address: "88 Zhongshan Road, Ningbo",
  notes: "Denim only",
  country: "China",
  email: "xu.feng@ningbo-denim.cn",
};
// The profile fields a row has when they were never set, and the money lists of a supplier without orders.
const EXTRAS = { state: "", postalCode: "", paymentTerms: "", taxNumber: "", openPos: 0, ytdValue: [], balance: [] };

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
      code: "SUP-001",
      name: "Guangzhou Textile Co.",
      contactPerson: "Mr. Zhao Lin",
      phone: "+86 138 0013 2244",
      email: "",
      country: "China",
      city: "Guangzhou",
      address: "",
      notes: "",
      currency: "CNY",
      openOrders: 0,
      status: "Active",
      ...EXTRAS,
    });
    for (const [index, row] of res.body.entries()) expect(row).toMatchObject({ code: `SUP-00${index + 1}`, openOrders: 0, status: "Active", currency: "CNY" });
  });

  it("AT-S2: searches name, contact and phone ignoring case and spaces", async () => {
    expect(names((await list("?search=YIWU")).body)).toEqual(["Yiwu Trims Ltd."]);
    expect(names((await list("?search=liu%20yan")).body)).toEqual(["Shenzhen Apparel"]);
    expect(names((await list("?search=%2B861372288")).body)).toEqual(["Foshan Fabrics"]);
    expect(names((await list("?search=%2B86%20137")).body)).toEqual(["Foshan Fabrics"]);
    // The code and the country too (the Suppliers page searches name, code and country).
    expect(names((await list("?search=sup-003")).body)).toEqual(["Foshan Fabrics"]);
    expect(names((await list("?search=CHINA")).body)).toEqual(SEEDED_NAMES);
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

  it("refuses an unknown body key with 400 and a currency other than CNY, USD or INR with 422", async () => {
    const unknown = await add({ ...NINGBO, openOrders: 3 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("bad_request");
    for (const other of ["EUR", "cny", ""]) {
      const currency = await add({ ...NINGBO, currency: other });
      expect(currency.status, other).toBe(422);
      expect(currency.body.error.fields).toEqual({ currency: "Choose CNY, USD or INR." });
    }
    expect((await ctx.db.select().from(suppliers)).length).toBe(5);
  });

  it("the database refuses any other currency (check constraint, migration 0006)", async () => {
    const foshan = await idOf(ctx, suppliers, "Foshan Fabrics");
    await expect(ctx.db.update(suppliers).set({ currency: "EUR" as "CNY" }).where(eq(suppliers.id, foshan))).rejects.toMatchObject({
      cause: { code: "23514", constraint: "suppliers_currency_check" },
    });
  });

  it("AT-S4: adds the supplier as Active with 0 open orders, stores address, notes and the creator", async () => {
    const res = await add({ ...NINGBO, name: "  Ningbo Denim Works " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ supplier: { ...NINGBO, ...EXTRAS, id: expect.any(String), code: "SUP-006", openOrders: 0, status: "Active" } });

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
    expect(res.body.supplier).toMatchObject({ name: "Wenzhou Buttons", code: "SUP-007", city: "", contactPerson: "", phone: "", currency: "CNY", address: "", notes: "", country: "", email: "" });
  });

  it("assigns the next SUP-nnn code, or keeps a typed code in upper case; a code in use, in any case, is 409 under code", async () => {
    // Ningbo took SUP-006 and Wenzhou SUP-007 above; a typed code never moves the sequence.
    const typed = await add({ name: "Dongguan Zips", code: " dz-01 " });
    expect(typed.status).toBe(201);
    expect(typed.body.supplier.code).toBe("DZ-01");
    const next = await add({ name: "Jiangmen Labels" });
    expect(next.body.supplier.code).toBe("SUP-008");
    for (const code of ["dz-01", "SUP-008", "sup-001"]) {
      const res = await add({ name: `Taken ${code}`, code });
      expect(res.status, code).toBe(409);
      expect(res.body.error).toEqual({ code: "code_exists", message: CODE_TAKEN, fields: { code: CODE_TAKEN } });
    }
    for (const code of ["", "SUP 009", "-SUP", "S".repeat(21), "sup_009"]) {
      const res = await add({ name: `Shape ${code}`, code });
      expect(res.status, code).toBe(422);
      expect(res.body.error.fields).toEqual({ code: CODE_SHAPE });
    }
    for (const name of ["Dongguan Zips", "Jiangmen Labels"]) await ctx.db.delete(suppliers).where(eq(suppliers.name, name));
  });

  it("refuses a phone without five digits with 422 under phone; letters around the digits are fine", async () => {
    for (const phone of ["call me", "1234", "+86 13"]) {
      const res = await add({ name: "Phone Check", phone });
      expect(res.status, phone).toBe(422);
      expect(res.body.error.fields).toEqual({ phone: "Enter a valid phone number." });
    }
    const ok = await add({ name: "Phone Check", phone: "WeChat 13800132244" });
    expect(ok.status).toBe(201);
    expect(ok.body.supplier.phone).toBe("WeChat 13800132244");
    await ctx.db.delete(suppliers).where(eq(suppliers.name, "Phone Check"));
  });

  it("refuses a malformed email with 422 under email; an empty one is fine", async () => {
    for (const email of ["nope", "a@b", "a b@c.com"]) {
      const res = await add({ name: "Mail Check", email });
      expect(res.status, email).toBe(422);
      expect(res.body.error.fields).toEqual({ email: EMAIL });
    }
    const ok = await add({ name: "Mail Check", email: "" });
    expect(ok.status).toBe(201);
    expect(ok.body.supplier.email).toBe("");
    await ctx.db.delete(suppliers).where(eq(suppliers.name, "Mail Check"));
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
    expect(res.body).toEqual({ supplier: { ...changed, ...EXTRAS, id, code: "SUP-002", country: "China", email: "", currency: "CNY", openOrders: 0, status: "Active" } });
    expect((await list()).body[1]).toEqual(res.body.supplier);
  });

  it("changes only the fields it is sent", async () => {
    const before = await rowOf("Foshan Fabrics");
    const res = await edit(before.id, { phone: "+86 137 0000 2222" });
    expect(res.status).toBe(200);
    expect(res.body.supplier).toEqual({ ...before, phone: "+86 137 0000 2222" });
  });

  it("edits the profile fields and the code; a code another supplier has is 409, a blank or malformed one 422", async () => {
    const id = await idOf(ctx, suppliers, "Foshan Fabrics");
    const profile = { country: "Vietnam", email: "sales@foshan.example", state: "Guangdong", postalCode: "528000", paymentTerms: "30% deposit, balance before shipment", taxNumber: "91440600MA" };
    const res = await edit(id, { ...profile, code: "fsh-1" });
    expect(res.status).toBe(200);
    expect(res.body.supplier).toMatchObject({ ...profile, code: "FSH-1" });
    expect((await edit(id, { code: "sup-001" })).body.error).toEqual({ code: "code_exists", message: CODE_TAKEN, fields: { code: CODE_TAKEN } });
    for (const code of ["", "no spaces"]) expect((await edit(id, { code })).body.error.fields, code).toEqual({ code: CODE_SHAPE });
    expect((await edit(id, { email: "bad" })).body.error.fields).toEqual({ email: EMAIL });
    expect((await edit(id, { code: "SUP-003", country: "China", email: "", state: "", postalCode: "", paymentTerms: "", taxNumber: "" })).status).toBe(200);
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

  it("changes the currency for new orders only: the supplier's existing orders keep theirs", async () => {
    const id = await idOf(ctx, suppliers, "Yiwu Trims Ltd.");
    const order = await makeOrder(ctx, { supplier: "Yiwu Trims Ltd.", lines: [{ item: "Denim jeans", quantity: 10, rateCny: 5 }] });
    const res = await edit(id, { currency: "USD" });
    expect(res.status).toBe(200);
    expect(res.body.supplier).toMatchObject({ name: "Yiwu Trims Ltd.", currency: "USD" });
    expect((await ctx.db.select({ currency: orders.currency }).from(orders).where(eq(orders.id, order.id)))[0]!.currency).toBe("CNY");
    expect((await edit(id, { currency: "INR" })).body.supplier.currency).toBe("INR");
    expect((await edit(id, { currency: "EUR" })).body.error.fields).toEqual({ currency: "Choose CNY, USD or INR." });
    expect((await edit(id, { currency: "CNY" })).status).toBe(200);
    await ctx.db.delete(orders).where(eq(orders.id, order.id));
  });

  it("an empty body or an unknown key is 400", async () => {
    const id = await idOf(ctx, suppliers, "Foshan Fabrics");
    for (const body of [{}, { openOrders: 3 }, { name: "Foshan Fabrics", id: UNKNOWN }]) {
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
    // Active POs on the Suppliers page: not closed (phase 2 §1), so the two stage-6 orders without stocked goods count too.
    expect((await list("?search=yiwu")).body[0].openPos).toBe(5);
    expect((await edit(await idOf(ctx, suppliers, "Yiwu Trims Ltd."), { notes: "Trims" })).body.supplier.openOrders).toBe(3);
  });
});

describe("DELETE /suppliers/:id with supplier deposits (docs/phase2-contracts.md 3.2)", () => {
  it("refuses a supplier with a deposit as in use, naming it with any orders; one without goes", async () => {
    const added = await add({ name: "Dalian Deposits" });
    const id = added.body.supplier.id as string;
    const deposit = (
      await ctx.db
        .insert(supplierDeposits)
        .values({ supplierId: id, direction: "give", amount: 1000, currency: "CNY", openedOn: "2026-10-20" })
        .returning({ id: supplierDeposits.id })
    )[0]!;
    const refused = await http.delete(`/suppliers/${id}`).set("Cookie", management);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: { code: "in_use", message: "This supplier is used by 1 deposit, so it can't be deleted. Deactivate it instead." } });
    const order = await makeOrder(ctx, { supplier: "Dalian Deposits", lines: [{ item: "Denim jeans", quantity: 10, rateCny: 5 }] });
    expect((await http.delete(`/suppliers/${id}`).set("Cookie", management)).body.error.message).toBe(
      "This supplier is used by 1 order and 1 deposit, so it can't be deleted. Deactivate it instead.",
    );
    expect((await ctx.db.select().from(suppliers).where(eq(suppliers.id, id))).length).toBe(1);

    await ctx.db.delete(orders).where(eq(orders.id, order.id));
    await ctx.db.delete(supplierDeposits).where(eq(supplierDeposits.id, deposit.id));
    expect((await http.delete(`/suppliers/${id}`).set("Cookie", management)).status).toBe(204);
    expect((await ctx.db.select().from(suppliers).where(eq(suppliers.id, id))).length).toBe(0);
  });
});
