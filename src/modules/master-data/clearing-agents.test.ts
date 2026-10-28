import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clearingAgents, clearings, containers, shippingAgents, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf, indiaDay } from "../stock/fixtures";
import { MESSAGES } from "./clearing-agents.routes";

const ctx = createTestContext();
const http = api(ctx);
let management = "";
beforeAll(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
});
afterAll(() => ctx.pool.end());

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const COCHIN = { name: "Cochin Customs House Agents", contactPerson: "Mr. Thomas Varghese", phone: "+91 98470 55501", port: "Kochi" };
const NAME_TAKEN = { code: "name_exists", message: MESSAGES.nameTaken, fields: { name: MESSAGES.nameTaken } };

const list = (query = "") => http.get(`/clearing-agents${query}`).set("Cookie", management);
const add = (body: object, cookie = management) => http.post("/clearing-agents", body).set("Cookie", cookie);
const edit = (id: string, body: object, cookie = management) => http.patch(`/clearing-agents/${id}`, body).set("Cookie", cookie);
const idOfAgent = async (name: string) => (await ctx.db.select({ id: clearingAgents.id }).from(clearingAgents).where(eq(clearingAgents.name, name)))[0]!.id;
const rowCount = async () => (await ctx.db.select().from(clearingAgents)).length;

describe("AT-R5: POST and PATCH are Management only", () => {
  it("is 401 signed out and 403 for every other role", async () => {
    const kochi = await idOfAgent("Kochi Clearing Services");
    expect((await http.post("/clearing-agents", COCHIN)).status).toBe(401);
    expect((await http.patch(`/clearing-agents/${kochi}`, { status: "Inactive" })).status).toBe(401);
    for (const email of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      const cookie = await signInAs(ctx, email);
      for (const res of [await add(COCHIN, cookie), await edit(kochi, { status: "Inactive" }, cookie)]) {
        expect(res.status, email).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      }
    }
    expect(await rowCount()).toBe(2);
    expect((await list()).body.map((row: { status: string }) => row.status)).toEqual(["Active", "Active"]);
  });
});

describe("POST /clearing-agents", () => {
  it("adds the agent as Active with 0 containers cleared, trimmed, last in the list", async () => {
    const res = await add({ name: `  ${COCHIN.name} `, contactPerson: ` ${COCHIN.contactPerson}`, phone: COCHIN.phone, port: "Kochi " });
    expect(res.status).toBe(201);
    expect(res.body).toStrictEqual({ clearingAgent: { id: expect.any(String), ...COCHIN, containersCleared: 0, status: "Active" } });
    const listed = (await list()).body;
    expect(listed.map((row: { name: string }) => row.name)).toEqual(["Kochi Clearing Services", "Southern Port Agents", COCHIN.name]);
    expect(listed[2]).toEqual(res.body.clearingAgent);
  });

  it("accepts only the name, defaulting the other fields to empty", async () => {
    const res = await add({ name: "Vizhinjam Port Agents" });
    expect(res.status).toBe(201);
    expect(res.body.clearingAgent).toMatchObject({ name: "Vizhinjam Port Agents", contactPerson: "", phone: "", port: "" });
  });

  it("an empty, blank or missing name is 422 under name", async () => {
    for (const body of [{ ...COCHIN, name: "" }, { ...COCHIN, name: "   " }, { port: "Kochi" }, { name: null }]) {
      const res = await add(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields: { name: MESSAGES.nameEmpty } });
    }
  });

  it("text over 200 characters is 422 under its field", async () => {
    const res = await add({ name: "x".repeat(201), port: "p".repeat(201) });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({ name: MESSAGES.tooLong, port: MESSAGES.tooLong });
    expect((await add({ name: "y".repeat(200) })).status).toBe(201);
  });

  it("an unknown key, a status or a non-object body is 400", async () => {
    for (const body of [{ ...COCHIN, name: "Other", containersCleared: 3 }, { name: "Other", status: "Active" }, []]) {
      const res = await add(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
  });

  it("a name already used in any capitalisation is 409 under name", async () => {
    const before = await rowCount();
    for (const name of ["kochi clearing services", " SOUTHERN PORT AGENTS ", COCHIN.name.toUpperCase()]) {
      const res = await add({ name });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toEqual(NAME_TAKEN);
    }
    expect(await rowCount()).toBe(before);
  });
});

describe("PATCH /clearing-agents/:id", () => {
  it("changes only the keys sent and answers with the full row", async () => {
    const id = await idOfAgent("Southern Port Agents");
    const res = await edit(id, { contactPerson: "  Ms. Deepa Nair ", port: "Vizhinjam" });
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      clearingAgent: { id, name: "Southern Port Agents", contactPerson: "Ms. Deepa Nair", phone: "+91 98950 44210", port: "Vizhinjam", containersCleared: 0, status: "Active" },
    });
    expect((await list()).body[1]).toEqual(res.body.clearingAgent);
  });

  it("renames, including to another capitalisation of its own name", async () => {
    const id = await idOfAgent("Southern Port Agents");
    expect((await edit(id, { name: " Southern Port Agents (Kochi) " })).body.clearingAgent.name).toBe("Southern Port Agents (Kochi)");
    expect((await edit(id, { name: "SOUTHERN PORT AGENTS (KOCHI)" })).body.clearingAgent.name).toBe("SOUTHERN PORT AGENTS (KOCHI)");
    expect((await edit(id, { name: "Southern Port Agents" })).status).toBe(200);
  });

  it("refuses a rename to another agent's name in any capitalisation with 409, changing nothing", async () => {
    const id = await idOfAgent("Southern Port Agents");
    for (const name of ["Kochi Clearing Services", " kochi CLEARING services"]) {
      const res = await edit(id, { name, port: "Elsewhere" });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toEqual(NAME_TAKEN);
    }
    expect((await list("?search=southern")).body[0]).toMatchObject({ name: "Southern Port Agents", port: "Vizhinjam" });
  });

  it("deactivates and reactivates (there is no delete)", async () => {
    const id = await idOfAgent("Southern Port Agents");
    expect((await edit(id, { status: "Inactive" })).body.clearingAgent.status).toBe("Inactive");
    expect((await list("?status=Inactive")).body.map((row: { name: string }) => row.name)).toEqual(["Southern Port Agents"]);
    expect((await edit(id, { status: "Active" })).body.clearingAgent.status).toBe("Active");
    expect((await list("?status=Inactive")).body).toEqual([]);
  });

  it("422 for an empty name, long text or another status, under each field", async () => {
    const id = await idOfAgent("Southern Port Agents");
    const res = await edit(id, { name: " ", phone: "9".repeat(201), status: "Deleted" });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({ name: MESSAGES.nameEmpty, phone: MESSAGES.tooLong, status: MESSAGES.status });
  });

  it("400 for an empty body or an unknown key", async () => {
    const id = await idOfAgent("Southern Port Agents");
    for (const body of [{}, { containersCleared: 5 }, { name: "Other", id: UNKNOWN }]) {
      const res = await edit(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toEqual({ code: "bad_request", message: "Something went wrong." });
    }
  });

  it("404 for an unknown or malformed id", async () => {
    for (const id of [UNKNOWN, "not-a-uuid", "123"]) {
      const res = await edit(id, { status: "Inactive" });
      expect(res.status, id).toBe(404);
      expect(res.body.error).toEqual({ code: "not_found", message: "Clearing agent not found." });
    }
  });
});

describe("containersCleared counts this agent's cleared clearings", () => {
  it("leaves out clearings still in clearing and other agents' clearings", async () => {
    const sino = await idOf(ctx, shippingAgents, "Sino Freight");
    const suresh = await idOf(ctx, users, "Suresh Menon");
    const kochi = await idOfAgent("Kochi Clearing Services");
    const southern = await idOfAgent("Southern Port Agents");
    const clear = async (number: string, clearingAgentId: string, cleared: boolean) => {
      const container = (
        await ctx.db
          .insert(containers)
          .values({ number, shippingAgentId: sino, terms: "FOB", eta: indiaDay(-10), status: "arrived" })
          .returning({ id: containers.id })
      )[0]!;
      await ctx.db.insert(clearings).values({
        containerId: container.id,
        clearingAgentId,
        arrivedOn: indiaDay(-10),
        ...(cleared ? { status: "cleared", dutyPaidOn: indiaDay(-8), clearedOn: indiaDay(-7) } : {}),
        createdBy: suresh,
        updatedBy: suresh,
      });
    };
    await clear("MSCU7000001", kochi, true);
    await clear("MSCU7000002", kochi, true);
    await clear("MSCU7000003", kochi, false);
    await clear("MSCU7000004", southern, false);

    const counts = Object.fromEntries((await list()).body.map((row: { name: string; containersCleared: number }) => [row.name, row.containersCleared]));
    expect(counts).toMatchObject({ "Kochi Clearing Services": 2, "Southern Port Agents": 0, [COCHIN.name]: 0 });
    // Counts are the same on the row a save returns, and after deactivating.
    expect((await edit(kochi, { status: "Inactive" })).body.clearingAgent).toMatchObject({ containersCleared: 2, status: "Inactive" });
    expect((await list("?status=Inactive")).body[0]).toMatchObject({ name: "Kochi Clearing Services", containersCleared: 2 });
  });
});
