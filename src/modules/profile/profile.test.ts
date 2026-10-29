import { eq } from "drizzle-orm";
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { locations, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { MESSAGES } from "../users/users.routes";

const ctx = createTestContext();
const http = api(ctx);
beforeEach(() => resetData(ctx));
afterAll(() => ctx.pool.end());

const rowOf = async (email: string) => (await ctx.db.select().from(users).where(eq(users.email, email)))[0]!;
const officeId = async (name: string) => (await ctx.db.select({ id: locations.id }).from(locations).where(eq(locations.name, name)))[0]!.id;

const PROFILE_KEYS = ["email", "language", "name", "office", "passwordChangedAt", "phone", "role"];

describe("PRF-1 GET /profile", () => {
  it("is 401 signed out, for both routes", async () => {
    expect((await http.get("/profile")).status).toBe(401);
    const res = await http.patch("/profile", { name: "X" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it("gives each seeded role its own profile and nothing internal", async () => {
    const cases: [string, string, string | null][] = [
      [SEEDED.management, "Management", null],
      [SEEDED.procurement, "Procurement", null],
      [SEEDED.accounts, "Accounts", null],
      [SEEDED.chinaStaff, "China staff", "Guangzhou office"],
      [SEEDED.indiaStaff, "India staff", "India office"],
      [SEEDED.warehouseStaff, "Warehouse staff", "Main warehouse"],
    ];
    for (const [email, role, office] of cases) {
      const res = await http.get("/profile").set("Cookie", await signInAs(ctx, email));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(["options", "profile"]);
      expect(res.body.options).toEqual({ languages: ["English"] });
      const { profile } = res.body;
      expect(Object.keys(profile).sort()).toEqual(PROFILE_KEYS);
      const row = await rowOf(email);
      expect(profile).toEqual({
        name: row.name,
        email,
        phone: "",
        role,
        office: office ? { id: await officeId(office), name: office } : null,
        language: "English",
        passwordChangedAt: row.passwordChangedAt!.toISOString(),
      });
    }
  });

  it("gives passwordChangedAt null when no password was ever set", async () => {
    await ctx.db.update(users).set({ passwordChangedAt: null }).where(eq(users.email, SEEDED.accounts));
    const res = await http.get("/profile").set("Cookie", await signInAs(ctx, SEEDED.accounts));
    expect(res.body.profile.passwordChangedAt).toBeNull();
  });

  it("is 401 for a user made inactive", async () => {
    const cookie = await signInAs(ctx, SEEDED.warehouseStaff);
    expect((await http.get("/profile").set("Cookie", cookie)).status).toBe(200);
    await ctx.db.update(users).set({ status: "Inactive" }).where(eq(users.email, SEEDED.warehouseStaff));
    expect((await http.get("/profile").set("Cookie", cookie)).status).toBe(401);
    expect((await http.patch("/profile", { name: "Joe" }).set("Cookie", cookie)).status).toBe(401);
    expect((await rowOf(SEEDED.warehouseStaff)).name).toBe("Joseph M");
  });
});

describe("PRF-2 PATCH /profile", () => {
  it("saves trimmed name, phone and language, sets updated_by, and GET and ME-1 show it", async () => {
    const cookie = await signInAs(ctx, SEEDED.indiaStaff);
    const anil = await rowOf(SEEDED.indiaStaff);
    const res = await http.patch("/profile", { name: "  Anil K Sharma ", phone: " +91 98470 22222 ", language: "English" }).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["profile"]);
    expect(res.body.profile).toMatchObject({ name: "Anil K Sharma", phone: "+91 98470 22222", language: "English", role: "India staff" });
    expect(Object.keys(res.body.profile).sort()).toEqual(PROFILE_KEYS);

    const after = await rowOf(SEEDED.indiaStaff);
    expect(after).toMatchObject({ name: "Anil K Sharma", phone: "+91 98470 22222", updatedBy: anil.id, email: anil.email, role: anil.role });
    expect((await http.get("/profile").set("Cookie", cookie)).body.profile).toEqual(res.body.profile);
    const me = await http.get("/me").set("Cookie", cookie);
    expect(me.body).toMatchObject({ name: "Anil K Sharma", initials: "AS" });
  });

  it("changes only the keys sent; phone may be cleared", async () => {
    await ctx.db.update(users).set({ phone: "+86 1" }).where(eq(users.email, SEEDED.chinaStaff));
    const cookie = await signInAs(ctx, SEEDED.chinaStaff);
    const before = await rowOf(SEEDED.chinaStaff);
    expect((await http.patch("/profile", { phone: "  " }).set("Cookie", cookie)).status).toBe(200);
    const after = await rowOf(SEEDED.chinaStaff);
    expect(after).toEqual({ ...before, phone: "", updatedBy: before.id, updatedAt: after.updatedAt });

    expect((await http.patch("/profile", { name: "Chen Y" }).set("Cookie", cookie)).status).toBe(200);
    expect(await rowOf(SEEDED.chinaStaff)).toMatchObject({ name: "Chen Y", phone: "" });
  });

  it("is 422 with fields for an empty name or a bad language, and saves nothing", async () => {
    const cookie = await signInAs(ctx, SEEDED.procurement);
    const before = await rowOf(SEEDED.procurement);
    const both = await http.patch("/profile", { name: "   ", language: "French", phone: "1" }).set("Cookie", cookie);
    expect(both.status).toBe(422);
    expect(both.body.error.code).toBe("validation_failed");
    expect(both.body.error.fields).toEqual({ name: MESSAGES.name, language: "Choose a language from the list." });
    const missing = await http.patch("/profile", { name: null }).set("Cookie", cookie);
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields).toEqual({ name: MESSAGES.name });
    expect(await rowOf(SEEDED.procurement)).toEqual(before);
  });

  it("is 400 for read-only or unknown keys and an empty body, and saves nothing", async () => {
    const cookie = await signInAs(ctx, SEEDED.chinaStaff);
    const chen = await rowOf(SEEDED.chinaStaff);
    const bodies = [
      { role: "Management" },
      { email: "x@mrgarments.com" },
      { officeId: await officeId("India office") },
      { status: "Inactive" },
      { stages: [2, 3] },
      { password: "Aa1aaaaaaaaaaaa" },
      { id: chen.id },
      { nickname: "C" },
      { name: "Chen Changed", role: "Management" },
      {},
    ];
    for (const body of bodies) {
      const res = await http.patch("/profile", body).set("Cookie", cookie);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
    expect(await rowOf(SEEDED.chinaStaff)).toEqual(chen);
  });

  it("cannot reach another user's row", async () => {
    const cookie = await signInAs(ctx, SEEDED.chinaStaff);
    const wang = await rowOf(SEEDED.chinaStaffTwoStages);
    expect((await http.patch("/profile", { id: wang.id, name: "Hacked" }).set("Cookie", cookie)).status).toBe(400);
    expect((await http.patch(`/profile?id=${wang.id}`, { name: "Chen Two" }).set("Cookie", cookie)).status).toBe(200);
    expect((await http.patch(`/profile/${wang.id}`, { name: "Hacked" }).set("Cookie", cookie)).status).toBe(404);
    expect(await rowOf(SEEDED.chinaStaffTwoStages)).toEqual(wang);
    expect((await rowOf(SEEDED.chinaStaff)).name).toBe("Chen Two");
  });

  it("refuses another site and non-JSON bodies (B9.8)", async () => {
    const cookie = await signInAs(ctx, SEEDED.accounts);
    const before = await rowOf(SEEDED.accounts);
    const other = await supertest(ctx.app).patch("/api/v1/profile").set("Cookie", cookie).set("Origin", "http://evil.example").send({ name: "X" });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("origin_rejected");
    const noOrigin = await supertest(ctx.app).patch("/api/v1/profile").set("Cookie", cookie).send({ name: "X" });
    expect(noOrigin.status).toBe(403);
    const text = await supertest(ctx.app)
      .patch("/api/v1/profile")
      .set("Cookie", cookie)
      .set("Origin", ctx.config.APP_ORIGIN)
      .set("Content-Type", "text/plain")
      .send("name=X");
    expect(text.status).toBe(415);
    expect(await rowOf(SEEDED.accounts)).toEqual(before);
  });
});
