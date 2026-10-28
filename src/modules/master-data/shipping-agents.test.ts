import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { containers, shippingAgents } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf, indiaDay } from "../stock/fixtures";

const ctx = createTestContext();
const http = api(ctx);
let management = "";
beforeAll(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
});
afterAll(() => ctx.pool.end());

const EMPTY = "Enter the shipping agent name.";
const TAKEN = "A shipping agent with this name already exists.";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const OCEAN = { name: "Ocean Link Logistics", contactPerson: "Mr. Li Qiang", phone: "+86 21 6234 7788", officeCity: "Shanghai" };

const list = (query = "") => http.get(`/shipping-agents${query}`).set("Cookie", management);
const add = (body: object, cookie = management) => http.post("/shipping-agents", body).set("Cookie", cookie);
const edit = (id: string, body: object, cookie = management) => http.patch(`/shipping-agents/${id}`, body).set("Cookie", cookie);
const names = (rows: { name: string }[]) => rows.map((row) => row.name);
const count = async () => (await ctx.db.select().from(shippingAgents)).length;

describe("Management only", () => {
  it("POST and PATCH are 401 signed out and 403 for Procurement and the other roles", async () => {
    const sino = await idOf(ctx, shippingAgents, "Sino Freight");
    expect((await http.post("/shipping-agents", OCEAN)).status).toBe(401);
    expect((await http.patch(`/shipping-agents/${sino}`, { status: "Inactive" })).status).toBe(401);
    for (const email of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      const cookie = await signInAs(ctx, email);
      for (const res of [await add(OCEAN, cookie), await edit(sino, { status: "Inactive" }, cookie)]) {
        expect(res.status, email).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      }
    }
    expect(await count()).toBe(2);
    expect(names((await list("?status=Active")).body)).toEqual(["Sino Freight", "Dragon Cargo"]);
  });
});

describe("POST /shipping-agents", () => {
  it("adds the agent as Active with 0 active containers, trimmed, listed last", async () => {
    const res = await add({ ...OCEAN, name: "  Ocean Link Logistics ", officeCity: " Shanghai" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ shippingAgent: { ...OCEAN, id: expect.any(String), activeContainers: 0, status: "Active" } });
    const listed = (await list()).body;
    expect(names(listed)).toEqual(["Sino Freight", "Dragon Cargo", "Ocean Link Logistics"]);
    expect(listed[2]).toEqual(res.body.shippingAgent);
  });

  it("accepts only the name, the other fields empty", async () => {
    const res = await add({ name: "Pearl River Shipping" });
    expect(res.status).toBe(201);
    expect(res.body.shippingAgent).toMatchObject({ name: "Pearl River Shipping", contactPerson: "", phone: "", officeCity: "" });
  });

  it("an empty or missing name is 422 under name; over-long text is 422 under its field", async () => {
    for (const body of [{ ...OCEAN, name: "" }, { ...OCEAN, name: "   " }, { phone: "+86 1" }]) {
      const res = await add(body);
      expect(res.status).toBe(422);
      expect(res.body.error).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields: { name: EMPTY } });
    }
    const long = await add({ name: "N".repeat(201), officeCity: "C".repeat(201) });
    expect(long.status).toBe(422);
    expect(long.body.error.fields).toEqual({ name: "Use 200 characters or fewer.", officeCity: "Use 200 characters or fewer." });
    expect(await count()).toBe(4);
  });

  it("a name already used in any capitalisation is 409 under name", async () => {
    for (const name of ["sino freight", " OCEAN LINK LOGISTICS "]) {
      const res = await add({ ...OCEAN, name });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toEqual({ code: "name_exists", message: TAKEN, fields: { name: TAKEN } });
    }
    expect(await count()).toBe(4);
  });

  it("an unknown key (status and counts included) is 400", async () => {
    for (const body of [{ ...OCEAN, name: "New", status: "Active" }, { name: "New", activeContainers: 1 }, { name: "New", port: "Kochi" }]) {
      const res = await add(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: "bad_request", message: "Something went wrong." } });
    }
    expect(await count()).toBe(4);
  });
});

describe("PATCH /shipping-agents/:id", () => {
  it("edits every field, trimmed, and returns the list row in its place", async () => {
    const id = await idOf(ctx, shippingAgents, "Dragon Cargo");
    const changed = { name: "Dragon Cargo Lines", contactPerson: "Ms. Huang Li", phone: "+86 755 0000 1200", officeCity: "Shekou" };
    const res = await edit(id, { ...changed, name: " Dragon Cargo Lines  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ shippingAgent: { ...changed, id, activeContainers: 0, status: "Active" } });
    expect((await list()).body[1]).toEqual(res.body.shippingAgent);
  });

  it("changes only the fields it is sent", async () => {
    const before = (await list()).body[0];
    const res = await edit(before.id, { officeCity: "Nansha" });
    expect(res.status).toBe(200);
    expect(res.body.shippingAgent).toEqual({ ...before, officeCity: "Nansha" });
  });

  it("deactivates and reactivates; an inactive agent is listed under Inactive", async () => {
    const id = await idOf(ctx, shippingAgents, "Pearl River Shipping");
    const off = await edit(id, { status: "Inactive" });
    expect(off.status).toBe(200);
    expect(off.body.shippingAgent.status).toBe("Inactive");
    expect(names((await list("?status=Inactive")).body)).toEqual(["Pearl River Shipping"]);
    expect(names((await list("?status=Active")).body)).not.toContain("Pearl River Shipping");
    expect((await edit(id, { status: "Active" })).body.shippingAgent.status).toBe("Active");
  });

  it("a name another agent uses, in any capitalisation, is 409; its own name recased is fine", async () => {
    const id = await idOf(ctx, shippingAgents, "Ocean Link Logistics");
    for (const name of ["SINO FREIGHT", "dragon cargo lines"]) {
      const res = await edit(id, { name });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toEqual({ code: "name_exists", message: TAKEN, fields: { name: TAKEN } });
    }
    expect((await edit(id, { name: "ocean link logistics" })).body.shippingAgent.name).toBe("ocean link logistics");
  });

  it("an empty name, over-long text or another status is 422 under its field", async () => {
    const id = await idOf(ctx, shippingAgents, "Sino Freight");
    const empty = await edit(id, { name: " " });
    expect(empty.status).toBe(422);
    expect(empty.body.error.fields).toEqual({ name: EMPTY });
    const long = await edit(id, { contactPerson: "c".repeat(201), phone: "1".repeat(201) });
    expect(long.body.error.fields).toEqual({ contactPerson: "Use 200 characters or fewer.", phone: "Use 200 characters or fewer." });
    const status = await edit(id, { status: "inactive" });
    expect(status.status).toBe(422);
    expect(Object.keys(status.body.error.fields)).toEqual(["status"]);
  });

  it("an empty body or an unknown key is 400", async () => {
    const id = await idOf(ctx, shippingAgents, "Sino Freight");
    for (const body of [{}, { activeContainers: 2 }, { port: "Kochi" }]) {
      const res = await edit(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
  });

  it("an unknown or malformed id is 404; PATCH without an id falls through", async () => {
    for (const id of [UNKNOWN, "sino"]) {
      const res = await edit(id, { status: "Inactive" });
      expect(res.status, id).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found", message: "Shipping agent not found." } });
    }
    const bare = await http.patch("/shipping-agents", { name: "New" }).set("Cookie", management);
    expect(bare.status).toBe(404);
    expect(bare.body.error.message).toBe("Endpoint not found.");
  });
});

describe("active containers", () => {
  it("counts the agent's containers still loading or at sea", async () => {
    const sino = await idOf(ctx, shippingAgents, "Sino Freight");
    const dragon = await idOf(ctx, shippingAgents, "Dragon Cargo Lines");
    const container = (number: string, shippingAgentId: string, status: string) => ({ number, shippingAgentId, status, terms: "FOB", eta: indiaDay(20) });
    await ctx.db
      .insert(containers)
      .values([
        container("MSCU3000001", sino, "loading"),
        container("MSCU3000002", sino, "sea"),
        container("MSCU3000003", sino, "sea"),
        container("MSCU3000004", sino, "arrived"),
        container("MSCU3000005", dragon, "arrived"),
      ]);

    const rows = (await list()).body as { name: string; activeContainers: number }[];
    expect(Object.fromEntries(rows.map((row) => [row.name, row.activeContainers]))).toEqual({
      "Sino Freight": 3,
      "Dragon Cargo Lines": 0,
      "ocean link logistics": 0,
      "Pearl River Shipping": 0,
    });
    expect((await edit(sino, { phone: "+86 20 8123 0000" })).body.shippingAgent.activeContainers).toBe(3);

    await ctx.db.update(containers).set({ status: "arrived" }).where(eq(containers.number, "MSCU3000001"));
    expect((await list("?search=sino")).body[0].activeContainers).toBe(2);
  });
});
