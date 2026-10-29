import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyPassword } from "../../auth/passwords";
import { locations, passwordTokens, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs, TEST_PASSWORD } from "../../test/harness";
import { MESSAGES, passwordMessage, stageProblem } from "./users.routes";

const ctx = createTestContext();
const http = api(ctx);
beforeEach(() => resetData(ctx));
afterAll(() => ctx.pool.end());

const LI_WEI = "li@mrgarments.com";
const NON_MANAGEMENT = [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff];

const idOf = async (email: string) => (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]!.id;
const management = () => signInAs(ctx, SEEDED.management);
const sessionsOf = async (userId: string) =>
  (await ctx.pool.query(`select count(*)::int as n from session where sess->>'userId' = $1`, [userId])).rows[0].n as number;

const INITIAL_PASSWORD = "Welcome2026x";
const newUser = { name: "Test User", email: "test@mrgarments.com", role: "China staff", stages: [2], password: INITIAL_PASSWORD };
const signIn = (email: string, password: string) => http.post("/auth/login", { email, password, keepSignedIn: false });
const userRow = async (email: string) => (await ctx.db.select().from(users).where(eq(users.email, email)))[0]!;
/** No response may carry a password or a hash, under any key. */
const noPassword = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/password|argon2/i);

describe("access (AT-R5)", () => {
  it("lets only Management use USR-1 to USR-4 and ROL-1; signed out is 401", async () => {
    const wang = await idOf(SEEDED.chinaStaffTwoStages);
    const calls = [
      () => http.get("/users"),
      () => http.get(`/users/${wang}`),
      () => http.post("/users", newUser),
      () => http.patch(`/users/${wang}`, {}),
      () => http.get("/roles"),
    ];
    for (const call of calls) {
      expect((await call()).status).toBe(401);
      for (const email of NON_MANAGEMENT) {
        expect((await call().set("Cookie", await signInAs(ctx, email))).status).toBe(403);
      }
    }
    const cookie = await management();
    expect((await http.get("/users").set("Cookie", cookie)).status).toBe(200);
    expect((await http.get(`/users/${wang}`).set("Cookie", cookie)).status).toBe(200);
    expect((await http.post("/users", newUser).set("Cookie", cookie)).status).toBe(201);
    expect((await http.patch(`/users/${wang}`, {}).set("Cookie", cookie)).status).toBe(200);
    expect((await http.get("/roles").set("Cookie", cookie)).status).toBe(200);
  });
});

describe("only Management creates users or assigns roles; nobody promotes themselves", () => {
  it("a non-Management user can't create a Management user or make themselves Management (403, nothing saved)", async () => {
    for (const email of NON_MANAGEMENT) {
      const cookie = await signInAs(ctx, email);
      const self = await idOf(email);
      const before = await userRow(email);
      const created = await http.post("/users", { ...newUser, role: "Management", stages: [] }).set("Cookie", cookie);
      expect(created.status, email).toBe(403);
      for (const body of [{ role: "Management", stages: [] }, { role: "Management" }, { password: INITIAL_PASSWORD }]) {
        const res = await http.patch(`/users/${self}`, body).set("Cookie", cookie);
        expect(res.status, `${email} ${JSON.stringify(body)}`).toBe(403);
      }
      const after = await userRow(email);
      expect(after.role).toBe(before.role);
      expect(after.passwordHash).toBe(before.passwordHash);
      expect((await http.get("/me").set("Cookie", cookie)).body.role).toBe(before.role);
    }
    expect(await ctx.db.select().from(users).where(eq(users.email, newUser.email))).toHaveLength(0);
  });
});

describe("USR-1 GET /users", () => {
  it("lists the 8 seeded users in creation order; the Head office users have no office (AT-U1)", async () => {
    const res = await http.get("/users").set("Cookie", await management());
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ active: 8, inactive: 0 });
    expect(res.body.data.map((row: { name: string; office: string | null }) => [row.name, row.office])).toEqual([
      ["Suresh Menon", null],
      ["Priya Nair", null],
      ["Anita Joseph", null],
      ["Wang Fang", "Guangzhou office"],
      ["Chen Yu", "Guangzhou office"],
      ["Li Wei", "Guangzhou office"],
      ["Anil Sharma", "India office"],
      ["Joseph M", "Main warehouse"],
    ]);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(["email", "id", "lastSignInAt", "name", "office", "role", "status"]);
    expect(res.body.data[0]).toMatchObject({ email: "suresh@mrgarments.com", role: "Management", lastSignInAt: null, status: "Active" });
  });

  it("filters by search, role and status; the counts ignore the filters (AT-U2)", async () => {
    const cookie = await management();
    const names = async (query: string) => {
      const res = await http.get(`/users${query}`).set("Cookie", cookie);
      expect(res.status).toBe(200);
      return res.body.data.map((row: { name: string }) => row.name);
    };
    expect(await names("?search=wang")).toEqual(["Wang Fang"]);
    expect(await names("?search=%20W%20ANG%20")).toEqual(["Wang Fang"]);
    expect(await names("?search=chen%40")).toEqual(["Chen Yu"]);
    expect(await names("?role=China%20staff")).toEqual(["Wang Fang", "Chen Yu", "Li Wei"]);
    expect(await names("?status=Inactive")).toEqual([]);
    expect(await names("")).toHaveLength(8);

    await ctx.db.update(users).set({ status: "Inactive" }).where(eq(users.email, SEEDED.warehouseStaff));
    const res = await http.get("/users?status=Active").set("Cookie", cookie);
    expect(res.body.data).toHaveLength(7);
    expect(res.body.counts).toEqual({ active: 7, inactive: 1 });
  });

  it("refuses unknown query keys and values with 400", async () => {
    const cookie = await management();
    for (const query of ["?sort=name", "?role=Boss", "?status=active", "?role=Accounts&role=Procurement"]) {
      const res = await http.get(`/users${query}`).set("Cookie", cookie);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
  });

  it("shows the last sign-in time once a user has signed in", async () => {
    const at = new Date("2026-10-26T03:42:00.000Z");
    await ctx.db.update(users).set({ lastSignInAt: at }).where(eq(users.email, SEEDED.chinaStaff));
    const res = await http.get("/users?search=chen").set("Cookie", await management());
    expect(res.body.data[0].lastSignInAt).toBe(at.toISOString());
  });
});

describe("USR-2 GET /users/:id", () => {
  it("returns the user and the form options", async () => {
    const res = await http.get(`/users/${await idOf(SEEDED.chinaStaffTwoStages)}`).set("Cookie", await management());
    expect(res.status).toBe(200);
    const guangzhou = (await ctx.db.select().from(locations).where(eq(locations.name, "Guangzhou office")))[0]!;
    expect(res.body.user).toEqual({
      id: await idOf(SEEDED.chinaStaffTwoStages),
      name: "Wang Fang",
      email: "wang@mrgarments.com",
      phone: "",
      role: "China staff",
      officeId: guangzhou.id,
      office: "Guangzhou office",
      language: "English",
      status: "Active",
      stages: [2, 3],
      lastSignInAt: null,
    });
    expect(res.body.options.roles).toEqual(["Management", "Procurement", "Accounts", "China staff", "India staff", "Warehouse staff"]);
    expect(res.body.options.offices.map((office: { name: string }) => office.name)).toEqual(["Guangzhou office", "India office", "Main warehouse"]);
    expect(res.body.options.languages).toEqual(["English"]);
  });

  it("offers active offices only", async () => {
    await ctx.db.update(locations).set({ status: "Inactive" }).where(eq(locations.name, "India office"));
    const res = await http.get(`/users/${await idOf(SEEDED.management)}`).set("Cookie", await management());
    expect(res.body.user.officeId).toBeNull();
    expect(res.body.options.offices.map((office: { name: string }) => office.name)).toEqual(["Guangzhou office", "Main warehouse"]);
  });

  it("is 404 for an unknown or malformed id (E10)", async () => {
    const cookie = await management();
    for (const id of [randomUUID(), "not-an-id"]) {
      const res = await http.get(`/users/${id}`).set("Cookie", cookie);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
  });
});

describe("USR-3 POST /users", () => {
  it("adds an active user with the ticked stages and the initial password; no link is issued (AT-U7)", async () => {
    const res = await http.post("/users", { ...newUser, email: "  Test@MRGarments.com " }).set("Cookie", await management());
    expect(res.status).toBe(201);
    noPassword(res.body);
    expect(res.body.user).toMatchObject({
      name: "Test User",
      email: "test@mrgarments.com",
      phone: "",
      role: "China staff",
      officeId: null,
      office: null,
      language: "English",
      status: "Active",
      stages: [2],
      lastSignInAt: null,
    });
    const id = res.body.user.id as string;
    const stored = (await ctx.db.select().from(users).where(eq(users.id, id)))[0]!;
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(stored.passwordHash, INITIAL_PASSWORD)).toBe(true);
    expect(stored.passwordChangedAt).toBeInstanceOf(Date);
    expect(stored.createdBy).toBe(await idOf(SEEDED.management));
    expect(await ctx.db.select().from(passwordTokens)).toHaveLength(0);

    const list = await http.get("/users").set("Cookie", await management());
    expect(list.body.data.at(-1)).toMatchObject({ name: "Test User", status: "Active" });
    expect(list.body.counts).toEqual({ active: 9, inactive: 0 });
    noPassword(list.body);
    noPassword((await http.get(`/users/${id}`).set("Cookie", await management())).body);

    // The new user signs in with exactly that password.
    expect((await signIn("test@mrgarments.com", "Welcome2026X")).status).toBe(401);
    const login = await signIn("test@mrgarments.com", INITIAL_PASSWORD);
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ id, role: "China staff", stages: [2] });
    noPassword(login.body);
  });

  it("an inactive new user can't sign in with the initial password until made active (B9.15)", async () => {
    const res = await http.post("/users", { ...newUser, status: "Inactive" }).set("Cookie", await management());
    expect(res.status).toBe(201);
    expect((await signIn(newUser.email, INITIAL_PASSWORD)).status).toBe(401);
  });

  it("stores the office, phone, language and status it is given", async () => {
    const office = (await ctx.db.select().from(locations).where(eq(locations.name, "India office")))[0]!;
    const res = await http
      .post("/users", { name: "Ravi K", email: "ravi@mrgarments.com", phone: " +91 98470 11111 ", role: "India staff", officeId: office.id, language: "English", status: "Inactive", stages: [5, 4, 5], password: INITIAL_PASSWORD })
      .set("Cookie", await management());
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ phone: "+91 98470 11111", officeId: office.id, office: "India office", status: "Inactive", stages: [4, 5] });
  });

  it("needs a password that meets the rules (M8, M9), and saves nothing otherwise", async () => {
    const cookie = await management();
    const withoutPassword = { ...newUser, password: undefined }; // JSON drops the key
    const cases: [object, string][] = [
      [withoutPassword, MESSAGES.password],
      [{ ...newUser, password: "" }, MESSAGES.password],
      [{ ...newUser, password: null }, MESSAGES.password],
      [{ ...newUser, password: 12345678 }, MESSAGES.password],
      [{ ...newUser, password: "welcome2026" }, MESSAGES.passwordRules],
      [{ ...newUser, password: "Welcome" }, MESSAGES.passwordRules],
      [{ ...newUser, password: `A1${"x".repeat(127)}` }, MESSAGES.passwordTooLong],
    ];
    for (const [body, message] of cases) {
      const res = await http.post("/users", body).set("Cookie", cookie);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(422);
      expect(res.body.error).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields: { password: message } });
    }
    expect(await ctx.db.select().from(users).where(eq(users.email, newUser.email))).toHaveLength(0);
  });

  it("refuses unknown keys and impossible values with 400", async () => {
    const cookie = await management();
    for (const body of [
      { ...newUser, admin: true },
      { ...newUser, passwordHash: "x" },
      { ...newUser, language: "French" },
      { ...newUser, status: "Gone" },
      { ...newUser, stages: [7] },
      { ...newUser, stages: "2" },
    ]) {
      expect((await http.post("/users", body).set("Cookie", cookie)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("names every missing required field (M13, M14, M16)", async () => {
    const res = await http.post("/users", {}).set("Cookie", await management());
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: "validation_failed",
      fields: { name: MESSAGES.name, email: MESSAGES.email, role: MESSAGES.role, password: MESSAGES.password },
    });
    const blank = await http.post("/users", { name: "  ", email: "not-an-email", role: "", password: "" }).set("Cookie", await management());
    expect(blank.body.error.fields).toEqual({
      name: "Enter the full name.",
      email: "Enter a valid email address.",
      role: "Choose a role.",
      password: "Enter a password.",
    });
  });

  it("refuses a duplicate email in any capitalisation with 409 (AT-U11, M15)", async () => {
    const res = await http.post("/users", { ...newUser, email: "WANG@mrgarments.com" }).set("Cookie", await management());
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "email_exists", fields: { email: "A user with this email already exists." } });
  });

  it("refuses an office that is unknown, malformed or inactive (M17)", async () => {
    const cookie = await management();
    await ctx.db.update(locations).set({ status: "Inactive" }).where(eq(locations.name, "Main warehouse"));
    const closed = (await ctx.db.select().from(locations).where(eq(locations.name, "Main warehouse")))[0]!;
    for (const officeId of [randomUUID(), "Guangzhou office", closed.id]) {
      const res = await http.post("/users", { ...newUser, officeId }).set("Cookie", cookie);
      expect(res.status, officeId).toBe(422);
      expect(res.body.error.fields).toEqual({ officeId: "Choose an office from the list." });
    }
  });

  it("refuses stages outside the role (M18) and stages for non-staff roles (M19)", async () => {
    const cookie = await management();
    const outside = await http.post("/users", { ...newUser, stages: [2, 4] }).set("Cookie", cookie);
    expect(outside.status).toBe(422);
    expect(outside.body.error.fields).toEqual({ stages: "China staff can't enter data for Clearing (India). Untick it first." });
    const notUsed = await http.post("/users", { ...newUser, role: "Procurement" }).set("Cookie", cookie);
    expect(notUsed.body.error.fields).toEqual({ stages: "Procurement doesn't use stage access. Untick all stages first." });
  });
});

describe("USR-4 PATCH /users/:id", () => {
  it("saves a changed stage and keeps it (AT-U3)", async () => {
    const cookie = await management();
    const wang = await idOf(SEEDED.chinaStaffTwoStages);
    const res = await http.patch(`/users/${wang}`, { stages: [2] }).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.stages).toEqual([2]);
    expect((await http.get(`/users/${wang}`).set("Cookie", cookie)).body.user.stages).toEqual([2]);
  });

  it("saves the other fields and only the keys sent", async () => {
    const cookie = await management();
    const wang = await idOf(SEEDED.chinaStaffTwoStages);
    const res = await http.patch(`/users/${wang}`, { name: "Wang Fang ", phone: "+86 138 2210 7745", officeId: null }).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: "Wang Fang", phone: "+86 138 2210 7745", officeId: null, role: "China staff", stages: [2, 3] });
  });

  it("refuses a stage outside the role and saves nothing (AT-U4)", async () => {
    const cookie = await management();
    const wang = await idOf(SEEDED.chinaStaffTwoStages);
    const res = await http.patch(`/users/${wang}`, { stages: [2, 3, 4] }).set("Cookie", cookie);
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({ stages: "China staff can't enter data for Clearing (India). Untick it first." });
    expect((await http.get(`/users/${wang}`).set("Cookie", cookie)).body.user.stages).toEqual([2, 3]);
  });

  it("refuses unknown keys with 400 and unknown users with 404 (E10)", async () => {
    const cookie = await management();
    expect((await http.patch(`/users/${await idOf(SEEDED.chinaStaff)}`, { passwordHash: "x" }).set("Cookie", cookie)).status).toBe(400);
    expect((await http.patch(`/users/${randomUUID()}`, { name: "Nobody" }).set("Cookie", cookie)).status).toBe(404);
    expect((await http.patch("/users/not-an-id", { name: "Nobody" }).set("Cookie", cookie)).status).toBe(404);
  });

  it("refuses another user's email (M15) but accepts the user's own in another case", async () => {
    const cookie = await management();
    const chen = await idOf(SEEDED.chinaStaff);
    const taken = await http.patch(`/users/${chen}`, { email: "Wang@mrgarments.com" }).set("Cookie", cookie);
    expect(taken.status).toBe(409);
    expect(taken.body.error.fields).toEqual({ email: MESSAGES.emailTaken });
    const own = await http.patch(`/users/${chen}`, { email: "CHEN@mrgarments.com" }).set("Cookie", cookie);
    expect(own.status).toBe(200);
    expect(own.body.user.email).toBe("chen@mrgarments.com");
  });

  it("checks a changed office (M17) but not an unchanged one", async () => {
    const cookie = await management();
    const li = await idOf(LI_WEI);
    expect((await http.patch(`/users/${li}`, { officeId: randomUUID() }).set("Cookie", cookie)).body.error.fields).toEqual({ officeId: MESSAGES.office });
    await ctx.db.update(locations).set({ status: "Inactive" }).where(eq(locations.name, "Guangzhou office"));
    const current = (await http.get(`/users/${li}`).set("Cookie", cookie)).body.user;
    expect((await http.patch(`/users/${li}`, { officeId: current.officeId, phone: "1" }).set("Cookie", cookie)).status).toBe(200);
  });
});

describe("USR-4 setting another user's password (password policy)", () => {
  const NEW_PASSWORD = "Ledger2026x";

  it("sets Chen's new password, ends all his sessions and only his; the old password stops working", async () => {
    const cookie = await management();
    const chen = await idOf(SEEDED.chinaStaff);
    const chenCookie = await signInAs(ctx, SEEDED.chinaStaff);
    await signInAs(ctx, SEEDED.chinaStaff);
    const wangCookie = await signInAs(ctx, SEEDED.chinaStaffTwoStages);
    const before = await userRow(SEEDED.chinaStaff);

    const res = await http.patch(`/users/${chen}`, { password: NEW_PASSWORD }).set("Cookie", cookie);
    expect(res.status).toBe(200);
    noPassword(res.body);
    expect(res.body.user).toMatchObject({ id: chen, role: "China staff", stages: [2], status: "Active" });

    expect(await sessionsOf(chen)).toBe(0);
    expect((await http.get("/me").set("Cookie", chenCookie)).status).toBe(401);
    expect((await http.get("/me").set("Cookie", wangCookie)).status).toBe(200);
    expect((await http.get("/users").set("Cookie", cookie)).status).toBe(200);

    const after = await userRow(SEEDED.chinaStaff);
    expect(after.passwordChangedAt!.getTime()).toBeGreaterThan(before.passwordChangedAt!.getTime());
    expect(after.updatedBy).toBe(await idOf(SEEDED.management));
    expect((await signIn(SEEDED.chinaStaff, TEST_PASSWORD)).status).toBe(401);
    expect((await signIn(SEEDED.chinaStaff, NEW_PASSWORD)).status).toBe(200);
  });

  it("can set a password together with other fields, and gives an account with no password one", async () => {
    await ctx.db.update(users).set({ passwordHash: null }).where(eq(users.email, LI_WEI));
    expect((await signIn(LI_WEI, TEST_PASSWORD)).status).toBe(401);
    const res = await http.patch(`/users/${await idOf(LI_WEI)}`, { phone: "+86 1", password: NEW_PASSWORD }).set("Cookie", await management());
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe("+86 1");
    expect((await signIn(LI_WEI, NEW_PASSWORD)).status).toBe(200);
  });

  it("refuses an empty, weak or too long password with the field message and changes nothing", async () => {
    const cookie = await management();
    const chen = await idOf(SEEDED.chinaStaff);
    const chenCookie = await signInAs(ctx, SEEDED.chinaStaff);
    const before = await userRow(SEEDED.chinaStaff);
    for (const [password, message] of [
      ["", MESSAGES.password],
      ["ledger2026", MESSAGES.passwordRules],
      [`A1${"x".repeat(127)}`, MESSAGES.passwordTooLong],
    ] as const) {
      const res = await http.patch(`/users/${chen}`, { name: "Changed", password }).set("Cookie", cookie);
      expect(res.status).toBe(422);
      expect(res.body.error.fields).toEqual({ password: message });
    }
    const after = await userRow(SEEDED.chinaStaff);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.name).toBe(before.name);
    expect((await http.get("/me").set("Cookie", chenCookie)).status).toBe(200);
  });

  it("refuses a Management user's own password with 403 and saves nothing, however the id is written", async () => {
    const cookie = await management();
    const suresh = await idOf(SEEDED.management);
    const before = await userRow(SEEDED.management);
    for (const id of [suresh, suresh.toUpperCase()]) {
      const res = await http.patch(`/users/${id}`, { name: "Suresh M", password: NEW_PASSWORD }).set("Cookie", cookie);
      expect(res.status, id).toBe(403);
      expect(res.body).toEqual({ error: { code: "password_change_disabled", message: MESSAGES.ownPassword } });
    }
    const after = await userRow(SEEDED.management);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.name).toBe("Suresh Menon");
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(200);
    expect((await signIn(SEEDED.management, TEST_PASSWORD)).status).toBe(200);
  });

  it("another Management user can set Suresh's password", async () => {
    await ctx.db.update(users).set({ role: "Management" }).where(eq(users.email, SEEDED.procurement));
    const priya = await signInAs(ctx, SEEDED.procurement);
    const res = await http.patch(`/users/${await idOf(SEEDED.management)}`, { password: NEW_PASSWORD }).set("Cookie", priya);
    expect(res.status).toBe(200);
    expect((await signIn(SEEDED.management, NEW_PASSWORD)).status).toBe(200);
  });

  it("never logs the password or its hash (B9.16)", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      const cookie = await management();
      await http.post("/users", newUser).set("Cookie", cookie);
      await http.patch(`/users/${await idOf(SEEDED.chinaStaff)}`, { password: NEW_PASSWORD }).set("Cookie", cookie);
      const hashes = [(await userRow(newUser.email)).passwordHash!, (await userRow(SEEDED.chinaStaff)).passwordHash!];
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      for (const secret of [INITIAL_PASSWORD, NEW_PASSWORD, ...hashes]) expect(logged).not.toContain(secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("B8 role changes, the last Management user and sessions", () => {
  it("China staff to India staff while Receiving is ticked: 422, session unchanged (B8 row 1, AT-U5)", async () => {
    const chen = await idOf(SEEDED.chinaStaff);
    const chenCookie = await signInAs(ctx, SEEDED.chinaStaff);
    const res = await http.patch(`/users/${chen}`, { role: "India staff" }).set("Cookie", await management());
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({ stages: "India staff can't enter data for Receiving (China). Untick it first." });
    const me = await http.get("/me").set("Cookie", chenCookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: "China staff", stages: [2] });
  });

  it("China staff to India staff with ticks changed to Clearing: saved, next request uses it (B8 row 2, AT-T2)", async () => {
    const wang = await idOf(SEEDED.chinaStaffTwoStages);
    const wangCookie = await signInAs(ctx, SEEDED.chinaStaffTwoStages);
    expect((await http.get("/me").set("Cookie", wangCookie)).body.stages).toEqual([2, 3]);
    const res = await http.patch(`/users/${wang}`, { role: "India staff", stages: [4] }).set("Cookie", await management());
    expect(res.status).toBe(200);
    const me = await http.get("/me").set("Cookie", wangCookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: "India staff", stages: [4], landing: "/clearing" });
  });

  it("a staff user moved to a non-staff role must lose their stages first (M19)", async () => {
    const res = await http.patch(`/users/${await idOf(LI_WEI)}`, { role: "Accounts" }).set("Cookie", await management());
    expect(res.body.error.fields).toEqual({ stages: "Accounts doesn't use stage access. Untick all stages first." });
    const ok = await http.patch(`/users/${await idOf(LI_WEI)}`, { role: "Accounts", stages: [] }).set("Cookie", await management());
    expect(ok.body.user).toMatchObject({ role: "Accounts", stages: [] });
  });

  it("the only Management user can't leave Management or go inactive (B8 row 3, AT-U6, M20)", async () => {
    const cookie = await management();
    const suresh = await idOf(SEEDED.management);
    const role = await http.patch(`/users/${suresh}`, { role: "Procurement" }).set("Cookie", cookie);
    expect(role.status).toBe(409);
    expect(role.body.error).toMatchObject({ code: "last_management", fields: { role: "At least one active Management user is required." } });
    expect(role.body.error.fields.status).toBeUndefined();
    const status = await http.patch(`/users/${suresh}`, { status: "Inactive" }).set("Cookie", cookie);
    expect(status.status).toBe(409);
    expect(status.body.error.fields).toEqual({ status: MESSAGES.lastManagement });
    const both = await http.patch(`/users/${suresh}`, { role: "Accounts", status: "Inactive" }).set("Cookie", cookie);
    expect(both.body.error.fields).toEqual({ role: MESSAGES.lastManagement, status: MESSAGES.lastManagement });
    expect((await http.get(`/users/${suresh}`).set("Cookie", cookie)).body.user).toMatchObject({ role: "Management", status: "Active" });
    // Saving the only Management user without demoting him is fine.
    expect((await http.patch(`/users/${suresh}`, { role: "Management", status: "Active", phone: "1" }).set("Cookie", cookie)).status).toBe(200);
  });

  it("an inactive Management user does not count", async () => {
    await ctx.db.update(users).set({ role: "Management", status: "Inactive" }).where(eq(users.email, SEEDED.procurement));
    const res = await http.patch(`/users/${await idOf(SEEDED.management)}`, { role: "Procurement" }).set("Cookie", await management());
    expect(res.status).toBe(409);
  });

  it("with another Management user, Suresh may demote himself; admin access ends on his next request (B8 row 4, B8.3)", async () => {
    const cookie = await management();
    const priya = await idOf(SEEDED.procurement);
    expect((await http.patch(`/users/${priya}`, { role: "Management" }).set("Cookie", cookie)).status).toBe(200);
    const res = await http.patch(`/users/${await idOf(SEEDED.management)}`, { role: "Procurement" }).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("Procurement");
    expect((await http.get("/users").set("Cookie", cookie)).status).toBe(403);
    expect((await http.get("/me").set("Cookie", cookie)).body.role).toBe("Procurement");
  });

  it("two simultaneous demotions of the last two Management users: exactly one succeeds (AT-R6)", async () => {
    const cookie = await management();
    const suresh = await idOf(SEEDED.management);
    const priya = await idOf(SEEDED.procurement);
    const waitingOnLocks = async () =>
      (await ctx.pool.query(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).rows[0]
        .n as number;
    for (const change of [{ role: "Procurement" }, { status: "Inactive" }]) {
      await ctx.db.update(users).set({ role: "Management", status: "Active" }).where(eq(users.id, priya));
      await ctx.db.update(users).set({ role: "Management", status: "Active" }).where(eq(users.id, suresh));
      // Hold the Management rows until both requests are past sign-in and waiting on them, so they really overlap.
      const holder = await ctx.pool.connect();
      await holder.query("begin");
      await holder.query(`select id from users where role = 'Management' and status = 'Active' for update`);
      const pending = Promise.all([http.patch(`/users/${suresh}`, change).set("Cookie", cookie), http.patch(`/users/${priya}`, change).set("Cookie", cookie)]);
      for (let tries = 0; (await waitingOnLocks()) < 2 && tries < 250; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await waitingOnLocks()).toBe(2);
      await holder.query("commit");
      holder.release();
      const results = await pending;
      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(results.find((res) => res.status === 409)!.body.error.code).toBe("last_management");
      const left = await ctx.db.execute(sql`select count(*)::int as n from users where role = 'Management' and status = 'Active'`);
      expect(left.rows[0]!.n).toBe(1);
    }
  });

  it("deactivating ends that user's sessions at once and only theirs (B8 row 5, AT-T1, B8.4)", async () => {
    const cookie = await management();
    const li = await idOf(LI_WEI);
    const liCookie = await signInAs(ctx, LI_WEI);
    await signInAs(ctx, LI_WEI);
    expect((await http.get("/me").set("Cookie", liCookie)).status).toBe(200);
    expect(await sessionsOf(li)).toBe(2);
    const res = await http.patch(`/users/${li}`, { status: "Inactive" }).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(await sessionsOf(li)).toBe(0);
    expect((await http.get("/me").set("Cookie", liCookie)).status).toBe(401);
    expect((await http.get("/users").set("Cookie", cookie)).status).toBe(200);
  });

  it("reactivating lets the user sign in again (B8 row 6)", async () => {
    const cookie = await management();
    const li = await idOf(LI_WEI);
    await http.patch(`/users/${li}`, { status: "Inactive" }).set("Cookie", cookie);
    expect((await http.get("/me").set("Cookie", await signInAs(ctx, LI_WEI))).status).toBe(401);
    const res = await http.patch(`/users/${li}`, { status: "Active" }).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect((await http.get("/me").set("Cookie", await signInAs(ctx, LI_WEI))).status).toBe(200);
  });
});

describe("passwordMessage", () => {
  it("follows B9.10 with M8 and M9, and never trims", () => {
    expect(passwordMessage("")).toBe(MESSAGES.password);
    expect(passwordMessage("ledger2026")).toBe(MESSAGES.passwordRules);
    expect(passwordMessage("Ledger")).toBe(MESSAGES.passwordRules);
    expect(passwordMessage("        ")).toBe(MESSAGES.passwordRules);
    expect(passwordMessage(`A1${"x".repeat(127)}`)).toBe(MESSAGES.passwordTooLong);
    expect(passwordMessage(`A1${"x".repeat(126)}`)).toBeUndefined();
    expect(passwordMessage(" Ledger2026 ")).toBeUndefined();
  });
});

describe("stageProblem", () => {
  it("follows Q7 for every role", () => {
    expect(stageProblem("China staff", [2, 3])).toBeUndefined();
    expect(stageProblem("India staff", [4, 5])).toBeUndefined();
    expect(stageProblem("Warehouse staff", [6])).toBeUndefined();
    expect(stageProblem("Warehouse staff", [5, 6])).toBe("Warehouse staff can't enter data for Transport. Untick it first.");
    expect(stageProblem("Management", [])).toBeUndefined();
    expect(stageProblem("Management", [2])).toBe("Management doesn't use stage access. Untick all stages first.");
  });
});
