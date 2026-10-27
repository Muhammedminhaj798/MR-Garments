import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyPassword } from "../../auth/passwords";
import { issuePasswordLink, LINK_INVALID_MESSAGE } from "../../auth/tokens";
import { passwordTokens, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs, TEST_PASSWORD } from "../../test/harness";
import { M, newPasswordMessage } from "./password.routes";

const ctx = createTestContext();
const http = api(ctx);
beforeEach(() => resetData(ctx));
afterAll(() => ctx.pool.end());

const NEW_PASSWORD = "Ledger2026x";
const userRow = async (email: string) => (await ctx.db.select().from(users).where(eq(users.email, email)))[0]!;
const sessionCookie = (header: string | string[] | undefined) =>
  ([header ?? []].flat().find((cookie) => cookie.startsWith("mrg.sid=")) ?? "").split(";")[0]!;

describe("password rules for the new password (M7-M9)", () => {
  it("picks the message the user sees", () => {
    expect(newPasswordMessage("")).toBe(M.newEmpty);
    expect(newPasswordMessage("ledger2026")).toBe(M.rules);
    expect(newPasswordMessage("Ledger")).toBe(M.rules);
    expect(newPasswordMessage(`A1${"x".repeat(127)}`)).toBe(M.tooLong);
    expect(newPasswordMessage(`a${"x".repeat(128)}`)).toBe(M.tooLong);
    expect(newPasswordMessage(`A1${"x".repeat(126)}`)).toBeUndefined();
  });
});

describe("AUTH-5 POST /auth/change-password", () => {
  const change = (cookie: string, body: object) => http.post("/auth/change-password", body).set("Cookie", cookie);

  it("is 401 when signed out", async () => {
    const res = await http.post("/auth/change-password", { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it("asks for every empty field (M5, M7, M10) with validation_failed", async () => {
    const cookie = await signInAs(ctx, SEEDED.accounts);
    for (const body of [{}, { currentPassword: "", newPassword: "", confirmPassword: "" }]) {
      const res = await change(cookie, body);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_failed");
      expect(res.body.error.fields).toEqual({ currentPassword: M.currentEmpty, newPassword: M.newEmpty, confirmPassword: M.confirmEmpty });
    }
  });

  it("AT-P1: wrong current password, no capital letter, mismatched confirmation (M6, M8, M11)", async () => {
    const cookie = await signInAs(ctx, SEEDED.accounts);
    const all = await change(cookie, { currentPassword: "Wrong2026x", newPassword: "ledger2026", confirmPassword: "ledger2027" });
    expect(all.status).toBe(422);
    expect(all.body.error.code).toBe("wrong_current_password");
    expect(all.body.error.fields).toEqual({ currentPassword: M.currentWrong, newPassword: M.rules, confirmPassword: M.confirmMismatch });

    const rules = await change(cookie, { currentPassword: TEST_PASSWORD, newPassword: "ledger2026", confirmPassword: "ledger2026" });
    expect(rules.status).toBe(422);
    expect(rules.body.error).toMatchObject({ code: "password_rules", fields: { newPassword: M.rules } });
    expect(Object.keys(rules.body.error.fields)).toEqual(["newPassword"]);

    const tooLong = `A1${"x".repeat(127)}`;
    const long = await change(cookie, { currentPassword: TEST_PASSWORD, newPassword: tooLong, confirmPassword: tooLong });
    expect(long.body.error).toMatchObject({ code: "password_rules", fields: { newPassword: M.tooLong } });

    const mismatch = await change(cookie, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: `${NEW_PASSWORD}y` });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error).toEqual({ code: "confirm_mismatch", message: expect.any(String), fields: { confirmPassword: M.confirmMismatch } });

    // Nothing was saved.
    expect(await verifyPassword((await userRow(SEEDED.accounts)).passwordHash, TEST_PASSWORD)).toBe(true);
  });

  it("refuses unknown fields with 400", async () => {
    const cookie = await signInAs(ctx, SEEDED.accounts);
    const res = await change(cookie, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD, extra: 1 });
    expect(res.status).toBe(400);
  });

  it("AT-P2/AT-P3, 9.11: changes the password, ends other sessions and renews this session's ID", async () => {
    const before = await userRow(SEEDED.accounts);
    const cookie = await signInAs(ctx, SEEDED.accounts);
    const otherBrowser = await signInAs(ctx, SEEDED.accounts);
    const someoneElse = await signInAs(ctx, SEEDED.management);

    const res = await change(cookie, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).toBe(204);

    const renewed = sessionCookie(res.headers["set-cookie"]);
    expect(renewed).not.toBe("");
    expect(renewed).not.toBe(cookie);
    expect((await http.get("/me").set("Cookie", renewed)).status).toBe(200);
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(401);
    expect((await http.get("/me").set("Cookie", otherBrowser)).status).toBe(401);
    expect((await http.get("/me").set("Cookie", someoneElse)).status).toBe(200);

    const after = await userRow(SEEDED.accounts);
    expect(after.passwordChangedAt!.getTime()).toBeGreaterThan(before.passwordChangedAt!.getTime());
    expect(await verifyPassword(after.passwordHash, TEST_PASSWORD)).toBe(false);
    expect(await verifyPassword(after.passwordHash, NEW_PASSWORD)).toBe(true);

    // The old password is now wrong (M6); the new one is accepted, even unchanged (9.10 allows reuse).
    const old = await change(renewed, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(old.body.error.fields).toEqual({ currentPassword: M.currentWrong });
    const again = await change(renewed, { currentPassword: NEW_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(again.status).toBe(204);
  });
});

describe("AUTH-4 POST /auth/reset-password (B1.4-B1.11)", () => {
  const userId = async (email: string) => (await userRow(email)).id;
  const reset = (token: string, newPassword = NEW_PASSWORD) => http.post("/auth/reset-password", { token, newPassword });
  const linkInvalid = { error: { code: "token_invalid", message: LINK_INVALID_MESSAGE } };

  it("checks the password rules first (M7, M8, M9)", async () => {
    const { token } = await issuePasswordLink(ctx.db, ctx.config, await userId(SEEDED.chinaStaff), "invite");
    const empty = await reset(token, "");
    expect(empty.status).toBe(422);
    expect(empty.body.error).toMatchObject({ code: "validation_failed", fields: { newPassword: M.newEmpty } });
    const weak = await reset(token, "ledger2026");
    expect(weak.status).toBe(422);
    expect(weak.body.error).toMatchObject({ code: "password_rules", fields: { newPassword: M.rules } });
    const long = await reset(token, `A1${"x".repeat(127)}`);
    expect(long.body.error).toMatchObject({ code: "password_rules", fields: { newPassword: M.tooLong } });
    // The link is still usable after those refusals.
    expect((await reset(token)).status).toBe(204);
  });

  it("refuses a wrong, missing or malformed code with M12 and no fields", async () => {
    for (const body of [{ token: "not-a-real-token", newPassword: NEW_PASSWORD }, { newPassword: NEW_PASSWORD }, { token: 42, newPassword: NEW_PASSWORD }]) {
      const res = await http.post("/auth/reset-password", body);
      expect(res.status).toBe(422);
      expect(res.body).toEqual(linkInvalid);
    }
    expect((await http.post("/auth/reset-password", { token: "x", newPassword: NEW_PASSWORD, extra: 1 })).status).toBe(400);
  });

  it("works once, stores no raw code, sets password_changed_at and ends the user's sessions", async () => {
    const id = await userId(SEEDED.chinaStaff);
    const cookie = await signInAs(ctx, SEEDED.chinaStaff);
    const before = await userRow(SEEDED.chinaStaff);
    const { token } = await issuePasswordLink(ctx.db, ctx.config, id, "invite");

    const stored = await ctx.db.select().from(passwordTokens);
    expect(JSON.stringify(stored)).not.toContain(token);

    expect((await reset(token)).status).toBe(204);
    const after = await userRow(SEEDED.chinaStaff);
    expect(await verifyPassword(after.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(after.passwordChangedAt!.getTime()).toBeGreaterThan(before.passwordChangedAt!.getTime());
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(401);

    const second = await reset(token, "Another2026x");
    expect(second.status).toBe(422);
    expect(second.body).toEqual(linkInvalid);
    expect(await verifyPassword((await userRow(SEEDED.chinaStaff)).passwordHash, NEW_PASSWORD)).toBe(true);
  });

  it("lets exactly one of two simultaneous submissions succeed", async () => {
    const { token } = await issuePasswordLink(ctx.db, ctx.config, await userId(SEEDED.chinaStaffTwoStages), "reset");
    const results = await Promise.all([reset(token, "Welcome2026x"), reset(token, "Welcome2026y")]);
    expect(results.map((res) => res.status).sort()).toEqual([204, 422]);
    expect(results.find((res) => res.status === 422)!.body).toEqual(linkInvalid);
  });

  it("refuses an expired link and an inactive user's link (B1.11)", async () => {
    const id = await userId(SEEDED.indiaStaff);
    const { token } = await issuePasswordLink(ctx.db, ctx.config, id, "reset");
    await ctx.db.update(users).set({ status: "Inactive" }).where(eq(users.id, id));
    expect((await reset(token)).body).toEqual(linkInvalid);
    await ctx.db.update(users).set({ status: "Active" }).where(eq(users.id, id));
    await ctx.db.update(passwordTokens).set({ expiresAt: sql`now() - interval '1 minute'` });
    expect((await reset(token)).body).toEqual(linkInvalid);
    expect(await verifyPassword((await userRow(SEEDED.indiaStaff)).passwordHash, TEST_PASSWORD)).toBe(true);
  });
});

describe("9.16 logging", () => {
  it("never logs passwords or link codes", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      const cookie = await signInAs(ctx, SEEDED.accounts);
      await http.post("/auth/change-password", { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }).set("Cookie", cookie);
      const { token } = await issuePasswordLink(ctx.db, ctx.config, (await userRow(SEEDED.chinaStaff)).id, "reset");
      await http.post("/auth/reset-password", { token, newPassword: NEW_PASSWORD });
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      for (const secret of [TEST_PASSWORD, NEW_PASSWORD, token]) expect(logged).not.toContain(secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
