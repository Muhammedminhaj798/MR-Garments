import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { containers, locations, shippingAgents, transportCompanies, transports, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf, indiaDay } from "../stock/fixtures";
import { MESSAGES } from "./transport-companies.routes";

const ctx = createTestContext();
const http = api(ctx);
let management = "";
beforeAll(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
});
afterAll(() => ctx.pool.end());

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const PERIYAR = { name: "Periyar Logistics", contactPerson: "Mr. Jose Mathew", phone: "+91 94470 88123" };
const NAME_TAKEN = { code: "name_exists", message: MESSAGES.nameTaken, fields: { name: MESSAGES.nameTaken } };

const list = (query = "") => http.get(`/transport-companies${query}`).set("Cookie", management);
const add = (body: object, cookie = management) => http.post("/transport-companies", body).set("Cookie", cookie);
const edit = (id: string, body: object, cookie = management) => http.patch(`/transport-companies/${id}`, body).set("Cookie", cookie);
const idOfCompany = async (name: string) =>
  (await ctx.db.select({ id: transportCompanies.id }).from(transportCompanies).where(eq(transportCompanies.name, name)))[0]!.id;
const rowCount = async () => (await ctx.db.select().from(transportCompanies)).length;

describe("AT-R5: POST and PATCH are Management only", () => {
  it("is 401 signed out and 403 for every other role", async () => {
    const kerala = await idOfCompany("Kerala Roadways");
    expect((await http.post("/transport-companies", PERIYAR)).status).toBe(401);
    expect((await http.patch(`/transport-companies/${kerala}`, { status: "Inactive" })).status).toBe(401);
    for (const email of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      const cookie = await signInAs(ctx, email);
      for (const res of [await add(PERIYAR, cookie), await edit(kerala, { status: "Inactive" }, cookie)]) {
        expect(res.status, email).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      }
    }
    expect(await rowCount()).toBe(2);
    expect((await list()).body.map((row: { status: string }) => row.status)).toEqual(["Active", "Active"]);
  });
});

describe("POST /transport-companies", () => {
  it("adds the company as Active with 0 trips, trimmed, last in the list", async () => {
    const res = await add({ name: ` ${PERIYAR.name}  `, contactPerson: PERIYAR.contactPerson, phone: ` ${PERIYAR.phone} ` });
    expect(res.status).toBe(201);
    expect(res.body).toStrictEqual({ transportCompany: { id: expect.any(String), ...PERIYAR, tripsSoFar: 0, status: "Active" } });
    const listed = (await list()).body;
    expect(listed.map((row: { name: string }) => row.name)).toEqual(["Kerala Roadways", "Malabar Carriers", PERIYAR.name]);
    expect(listed[2]).toEqual(res.body.transportCompany);
  });

  it("accepts only the name, defaulting the other fields to empty", async () => {
    const res = await add({ name: "Thrissur Transports" });
    expect(res.status).toBe(201);
    expect(res.body.transportCompany).toMatchObject({ name: "Thrissur Transports", contactPerson: "", phone: "" });
  });

  it("an empty, blank or missing name is 422 under name", async () => {
    for (const body of [{ ...PERIYAR, name: "" }, { ...PERIYAR, name: "   " }, { phone: "+91 1" }, { name: 7 }]) {
      const res = await add(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields: { name: MESSAGES.nameEmpty } });
    }
  });

  it("text over 200 characters is 422 under its field", async () => {
    const res = await add({ name: "Long Haul", contactPerson: "c".repeat(201) });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({ contactPerson: MESSAGES.tooLong });
  });

  it("an unknown key (a port, a status, a count) is 400", async () => {
    for (const body of [{ name: "Other", port: "Kochi" }, { name: "Other", status: "Active" }, { name: "Other", tripsSoFar: 1 }]) {
      const res = await add(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
  });

  it("a name already used in any capitalisation is 409 under name", async () => {
    const before = await rowCount();
    for (const name of ["kerala roadways", " MALABAR CARRIERS ", "periyar LOGISTICS"]) {
      const res = await add({ name });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toEqual(NAME_TAKEN);
    }
    expect(await rowCount()).toBe(before);
  });
});

describe("PATCH /transport-companies/:id", () => {
  it("changes only the keys sent and answers with the full row", async () => {
    const id = await idOfCompany("Malabar Carriers");
    const res = await edit(id, { phone: " +91 98460 00000 " });
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      transportCompany: { id, name: "Malabar Carriers", contactPerson: "Mr. Salim P", phone: "+91 98460 00000", tripsSoFar: 0, status: "Active" },
    });
    expect((await list()).body[1]).toEqual(res.body.transportCompany);
  });

  it("renames, including to another capitalisation of its own name", async () => {
    const id = await idOfCompany("Malabar Carriers");
    expect((await edit(id, { name: "Malabar Carriers Pvt Ltd" })).body.transportCompany.name).toBe("Malabar Carriers Pvt Ltd");
    expect((await edit(id, { name: "MALABAR CARRIERS PVT LTD" })).status).toBe(200);
    expect((await edit(id, { name: "Malabar Carriers" })).body.transportCompany.name).toBe("Malabar Carriers");
  });

  it("refuses a rename to another company's name in any capitalisation with 409, changing nothing", async () => {
    const id = await idOfCompany("Malabar Carriers");
    for (const name of ["Kerala Roadways", "KERALA roadways "]) {
      const res = await edit(id, { name, contactPerson: "Someone else" });
      expect(res.status, name).toBe(409);
      expect(res.body.error).toEqual(NAME_TAKEN);
    }
    expect((await list("?search=malabar")).body[0]).toMatchObject({ name: "Malabar Carriers", contactPerson: "Mr. Salim P" });
  });

  it("deactivates and reactivates", async () => {
    const id = await idOfCompany("Malabar Carriers");
    expect((await edit(id, { status: "Inactive" })).body.transportCompany.status).toBe("Inactive");
    expect((await list("?status=Inactive")).body.map((row: { name: string }) => row.name)).toEqual(["Malabar Carriers"]);
    expect((await edit(id, { status: "Active" })).body.transportCompany.status).toBe("Active");
    expect((await list("?status=Inactive")).body).toEqual([]);
  });

  it("422 for an empty name or another status, under each field", async () => {
    const id = await idOfCompany("Malabar Carriers");
    const res = await edit(id, { name: "", status: "active" });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({ name: MESSAGES.nameEmpty, status: MESSAGES.status });
  });

  it("400 for an empty body or an unknown key", async () => {
    const id = await idOfCompany("Malabar Carriers");
    for (const body of [{}, { tripsSoFar: 5 }, { port: "Kochi" }]) {
      const res = await edit(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toEqual({ code: "bad_request", message: "Something went wrong." });
    }
  });

  it("404 for an unknown or malformed id", async () => {
    for (const id of [UNKNOWN, "not-a-uuid"]) {
      const res = await edit(id, { status: "Inactive" });
      expect(res.status, id).toBe(404);
      expect(res.body.error).toEqual({ code: "not_found", message: "Transport company not found." });
    }
  });
});

describe("tripsSoFar counts this company's trips, on the road or unloaded", () => {
  it("counts every trip of the company and none of another's", async () => {
    const sino = await idOf(ctx, shippingAgents, "Sino Freight");
    const warehouse = await idOf(ctx, locations, "Main warehouse");
    const suresh = await idOf(ctx, users, "Suresh Menon");
    const kerala = await idOfCompany("Kerala Roadways");
    const malabar = await idOfCompany("Malabar Carriers");
    const trip = async (number: string, transportCompanyId: string, unloaded: boolean) => {
      const container = (
        await ctx.db
          .insert(containers)
          .values({ number, shippingAgentId: sino, terms: "CNF", eta: indiaDay(-10), status: "arrived" })
          .returning({ id: containers.id })
      )[0]!;
      await ctx.db.insert(transports).values({
        containerId: container.id,
        transportCompanyId,
        destinationId: warehouse,
        lrNumber: `LR-${number}`,
        vehicleNumber: "KL-07-AB-1234",
        driverPhone: "+91 90000 00000",
        bundlesLoaded: 10,
        loadedOn: indiaDay(-3),
        ...(unloaded ? { status: "unloaded", unloadedOn: indiaDay(-2), bundlesReceived: 10 } : {}),
        createdBy: suresh,
        updatedBy: suresh,
      });
    };
    await trip("TGHU8000001", kerala, true);
    await trip("TGHU8000002", kerala, false);
    await trip("TGHU8000003", kerala, false);
    await trip("TGHU8000004", malabar, true);

    const counts = Object.fromEntries((await list()).body.map((row: { name: string; tripsSoFar: number }) => [row.name, row.tripsSoFar]));
    expect(counts).toMatchObject({ "Kerala Roadways": 3, "Malabar Carriers": 1, [PERIYAR.name]: 0 });
    expect((await edit(kerala, { contactPerson: "Mr. Biju T" })).body.transportCompany).toMatchObject({ tripsSoFar: 3 });
  });
});
