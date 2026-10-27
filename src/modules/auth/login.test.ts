import { inspect } from "node:util";
import argon2 from "argon2";
import { and, eq, sql } from "drizzle-orm";
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { needsRehash, verifyPassword } from "../../auth/passwords";
import { IDLE_TTL_SECONDS, KEEP_SIGNED_IN_MS } from "../../auth/session";
import { session, users, userStageGrants } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs, TEST_PASSWORD } from "../../test/harness";

const ctx = createTestContext();
const http = api(ctx);
beforeEach(() => resetData(ctx));
afterAll(() => ctx.pool.end());

// The sign-in limiter (B9.1) lives as long as the app, so it spans every test in this file: each test fails with
// emails that no other test fails with, and never more than 5 times per email except in the 429 test.

const M2 = { error: { code: "invalid_credentials", message: "Email or password is incorrect." } };
const M3 = { error: { code: "rate_limited", message: "Too many attempts. Try again in 15 minutes." } };

const login = (email: string, password = TEST_PASSWORD, keepSignedIn = false) =>
  http.post("/auth/login", { email, password, keepSignedIn });

const setCookieOf = (res: supertest.Response) =>
  ((res.headers["set-cookie"] as unknown as string[] | undefined) ?? []).find((value) => value.startsWith("mrg.sid="));
/** The Cookie header a browser would send back. */
const cookieOf = (res: supertest.Response) => setCookieOf(res)?.split(";")[0] ?? "";
const sidOf = (cookie: string) => {
  const value = decodeURIComponent(cookie.slice("mrg.sid=".length));
  return value.slice(2, value.lastIndexOf("."));
};
const userRow = async (email: string) => (await ctx.db.select().from(users).where(eq(users.email, email)))[0]!;
/** Seconds until the stored session expires (both sides in the database's own clock). */
const sessionSecondsLeft = async () =>
  (await ctx.pool.query<{ seconds: number }>(`select extract(epoch from expire - localtimestamp)::int as seconds from session`)).rows.map(
    (row) => row.seconds,
  );

describe("AUTH-1 POST /auth/login", () => {
  it("signs in with a trimmed, any-case email and returns the ME-1 body (AT-A2)", async () => {
    expect((await userRow(SEEDED.management)).lastSignInAt).toBeNull();
    const res = await login("  Suresh@MRGarments.com ");
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: "Suresh Menon", initials: "SM", accessLabel: "Full access", shell: "management", landing: "/" });
    const me = await http.get("/me").set("Cookie", cookieOf(res));
    expect(me.status).toBe(200);
    expect(res.body).toEqual({ user: me.body });
    expect((await userRow(SEEDED.management)).lastSignInAt).toBeInstanceOf(Date);
  });

  it("answers a wrong password, an unknown email, an inactive user and a user without a password identically (AT-A3-A5, B9.13)", async () => {
    await ctx.db.update(users).set({ status: "Inactive" }).where(eq(users.email, SEEDED.accounts));
    await ctx.db.update(users).set({ passwordHash: null }).where(eq(users.email, SEEDED.procurement));
    const responses = [
      await login(SEEDED.management, "Wrong2026x"),
      await login("nobody@mrgarments.com"),
      await login(SEEDED.accounts),
      await login(SEEDED.procurement),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(M2);
      expect(res.text).toBe(responses[0]!.text);
      expect(setCookieOf(res)).toBeUndefined();
    }
    expect((await userRow(SEEDED.accounts)).lastSignInAt).toBeNull();
  });

  it("checks the body: M1 for empty fields, 400 for unknown or missing structure", async () => {
    const empty = await http.post("/auth/login", { email: "  ", password: "", keepSignedIn: false });
    expect(empty.status).toBe(422);
    expect(empty.body.error.fields).toEqual({ email: "Enter your email and password.", password: "Enter your email and password." });
    const long = await login("long@mrgarments.com", "x".repeat(201));
    expect(long.status).toBe(422);
    expect(long.body.error.fields).toEqual({ password: "Email or password is incorrect." });
    expect((await http.post("/auth/login", { email: "extra@mrgarments.com", password: "x", keepSignedIn: false, role: "Management" })).status).toBe(400);
    const notJson = await supertest(ctx.app).post("/api/v1/auth/login").set("Origin", ctx.config.APP_ORIGIN).set("Content-Type", "application/json").send("[]");
    expect(notJson.status).toBe(400);
  });

  it("refuses the 6th failed attempt within 15 minutes with M3, even with the right password (AT-A6, B9.1)", async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await login(SEEDED.warehouseStaff, `Wrong${attempt}x`);
      expect(res.status, `attempt ${attempt}`).toBe(401);
      expect(res.body).toEqual(M2);
    }
    const sixth = await login(SEEDED.warehouseStaff, "Wrong6x");
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual(M3);
    const right = await login(SEEDED.warehouseStaff);
    expect(right.status).toBe(429);
    expect(setCookieOf(right)).toBeUndefined();
    // The count is per email and address: another account from the same address still signs in.
    expect((await login(SEEDED.chinaStaffTwoStages)).status).toBe(200);
  });

  it("keeps the cookie 30 days when asked, otherwise until the browser closes (AT-A7, AT-A8, B9.4, B9.5, B9.7)", async () => {
    const kept = setCookieOf(await login(SEEDED.management, TEST_PASSWORD, true))!;
    expect(kept).toMatch(/; HttpOnly/i);
    expect(kept).toMatch(/; SameSite=Lax/i);
    expect(kept).toMatch(/; Path=\//i);
    const expires = Date.parse(/Expires=([^;]+)/i.exec(kept)![1]!);
    expect(Math.abs(expires - (Date.now() + KEEP_SIGNED_IN_MS))).toBeLessThan(60_000);
    expect((await sessionSecondsLeft())[0]).toBeGreaterThan(KEEP_SIGNED_IN_MS / 1000 - 60);

    await ctx.db.delete(session);
    const browser = setCookieOf(await login(SEEDED.management))!;
    expect(browser).toMatch(/; HttpOnly/i);
    expect(browser).not.toMatch(/Expires=|Max-Age=/i);
    const [left] = await sessionSecondsLeft();
    expect(Math.abs(left! - IDLE_TTL_SECONDS)).toBeLessThan(60);
  });

  it("gives a new session ID at sign-in and ends the one sent with it (AT-T4, B9.3)", async () => {
    const before = await signInAs(ctx, SEEDED.procurement);
    const res = await login(SEEDED.management).set("Cookie", before);
    expect(res.status).toBe(200);
    const after = cookieOf(res);
    expect(sidOf(after)).not.toBe("");
    expect(sidOf(after)).not.toBe(sidOf(before));
    expect((await http.get("/me").set("Cookie", before)).status).toBe(401);
    expect((await http.get("/me").set("Cookie", after)).body.name).toBe("Suresh Menon");
  });

  it("re-hashes a password stored with weaker settings (B9.9)", async () => {
    const weak = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id, memoryCost: 8_192, timeCost: 1, parallelism: 1 });
    await ctx.db.update(users).set({ passwordHash: weak }).where(eq(users.email, SEEDED.indiaStaff));
    expect((await login(SEEDED.indiaStaff)).status).toBe(200);
    const { passwordHash } = await userRow(SEEDED.indiaStaff);
    expect(passwordHash).not.toBe(weak);
    expect(needsRehash(passwordHash!)).toBe(false);
    expect(await verifyPassword(passwordHash, TEST_PASSWORD)).toBe(true);
  });

  it("refuses a sign-in from another site (AT-T5, B9.8)", async () => {
    const res = await supertest(ctx.app)
      .post("/api/v1/auth/login")
      .set("Origin", "http://evil.example")
      .send({ email: SEEDED.management, password: TEST_PASSWORD, keepSignedIn: false });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("origin_rejected");
    expect(setCookieOf(res)).toBeUndefined();
  });

  it("never logs passwords, hashes or session IDs (B9.16)", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      await login("logs@mrgarments.com", "Secret2026wrong");
      const res = await login(SEEDED.management);
      const cookie = cookieOf(res);
      await http.post("/auth/logout").set("Cookie", cookie);
      const logged = spies.flatMap((spy) => spy.mock.calls).map((args) => inspect(args, { depth: 5 })).join("\n");
      const { passwordHash } = await userRow(SEEDED.management);
      for (const secret of [TEST_PASSWORD, "Secret2026wrong", passwordHash!, sidOf(cookie)]) expect(logged).not.toContain(secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("AUTH-2 POST /auth/logout", () => {
  it("ends the session and clears the cookie (K2)", async () => {
    const cookie = cookieOf(await login(SEEDED.management));
    const res = await http.post("/auth/logout").set("Cookie", cookie);
    expect(res.status).toBe(204);
    expect(setCookieOf(res)).toMatch(/^mrg\.sid=;.*Expires=Thu, 01 Jan 1970/i);
    expect(await ctx.db.select().from(session)).toHaveLength(0);
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(401);
  });

  it("is 401 when signed out", async () => {
    const res = await http.post("/auth/logout");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });
});

describe("sessions", () => {
  it("signs out a user made inactive at once, and refuses their sign-in (AT-T1, B9.15)", async () => {
    const cookie = cookieOf(await login(SEEDED.chinaStaff));
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(200);
    await ctx.db.update(users).set({ status: "Inactive" }).where(eq(users.email, SEEDED.chinaStaff));
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(401);
    const again = await login(SEEDED.chinaStaff);
    expect(again.status).toBe(401);
    expect(again.body).toEqual(M2);
  });

  it("applies changed stage grants on the next request without signing in again (AT-T2, B8.4)", async () => {
    const cookie = cookieOf(await login(SEEDED.chinaStaffTwoStages));
    expect((await http.get("/me").set("Cookie", cookie)).body).toMatchObject({ stages: [2, 3], permissions: { containers: "Enter" } });
    const { id } = await userRow(SEEDED.chinaStaffTwoStages);
    await ctx.db.delete(userStageGrants).where(and(eq(userStageGrants.userId, id), eq(userStageGrants.stage, 3)));
    expect((await http.get("/me").set("Cookie", cookie)).body).toMatchObject({ stages: [2], permissions: { containers: "None" } });
  });

  it("ends an idle session once its expiry passes (AT-T3, B9.5)", async () => {
    const cookie = cookieOf(await login(SEEDED.accounts));
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(200);
    await ctx.db.update(session).set({ expire: sql`localtimestamp - interval '1 minute'` });
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(401);
  });
});
