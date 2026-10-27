import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { passwordTokens, users } from "../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../test/harness";
import { verifyPassword } from "./passwords";
import { completePasswordWithLink, hashToken, issuePasswordLink } from "./tokens";

const ctx = createTestContext();
const http = api(ctx);
beforeEach(() => resetData(ctx));
afterAll(() => ctx.pool.end());

const userId = async (email: string) => (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]!.id;

describe("password links (B1.4-B1.11)", () => {
  it("stores only a hash, and sets the password once", async () => {
    const id = await userId(SEEDED.chinaStaff);
    const { token, expiresAt } = await issuePasswordLink(ctx.db, ctx.config, id, "invite");
    expect(token).toHaveLength(43);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    const stored = await ctx.db.select().from(passwordTokens);
    expect(stored.map((row) => row.tokenHash)).toEqual([hashToken(token)]);
    expect(JSON.stringify(stored)).not.toContain(token);

    await completePasswordWithLink(ctx.db, ctx.pool, token, "Welcome2026x");
    const user = (await ctx.db.select().from(users).where(eq(users.id, id)))[0]!;
    expect(await verifyPassword(user.passwordHash, "Welcome2026x")).toBe(true);
    await expect(completePasswordWithLink(ctx.db, ctx.pool, token, "Another2026x")).rejects.toMatchObject({ status: 422, code: "token_invalid" });
  });

  it("refuses expired, unknown and inactive-user links, and weak passwords", async () => {
    const id = await userId(SEEDED.indiaStaff);
    const { token } = await issuePasswordLink(ctx.db, ctx.config, id, "reset");
    await expect(completePasswordWithLink(ctx.db, ctx.pool, token, "weak")).rejects.toMatchObject({ status: 422, code: "validation_failed" });
    await expect(completePasswordWithLink(ctx.db, ctx.pool, "not-a-real-token", "Welcome2026x")).rejects.toMatchObject({ code: "token_invalid" });
    await ctx.db.update(users).set({ status: "Inactive" }).where(eq(users.id, id));
    await expect(completePasswordWithLink(ctx.db, ctx.pool, token, "Welcome2026x")).rejects.toMatchObject({ code: "token_invalid" });
    await ctx.db.update(users).set({ status: "Active" }).where(eq(users.id, id));
    await ctx.db.update(passwordTokens).set({ expiresAt: sql`now() - interval '1 minute'` });
    await expect(completePasswordWithLink(ctx.db, ctx.pool, token, "Welcome2026x")).rejects.toMatchObject({ code: "token_invalid" });
  });

  it("cancels older links when a new one is issued", async () => {
    const id = await userId(SEEDED.chinaStaff);
    const first = await issuePasswordLink(ctx.db, ctx.config, id, "reset");
    const second = await issuePasswordLink(ctx.db, ctx.config, id, "reset");
    await expect(completePasswordWithLink(ctx.db, ctx.pool, first.token, "Welcome2026x")).rejects.toMatchObject({ code: "token_invalid" });
    await expect(completePasswordWithLink(ctx.db, ctx.pool, second.token, "Welcome2026x")).resolves.toBe(id);
  });

  it("lets exactly one of two simultaneous uses succeed, and signs the user out everywhere", async () => {
    const id = await userId(SEEDED.chinaStaffTwoStages);
    const cookie = await signInAs(ctx, SEEDED.chinaStaffTwoStages);
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(200);
    const { token } = await issuePasswordLink(ctx.db, ctx.config, id, "reset");
    const results = await Promise.allSettled([
      completePasswordWithLink(ctx.db, ctx.pool, token, "Welcome2026x"),
      completePasswordWithLink(ctx.db, ctx.pool, token, "Welcome2026y"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(401);
  });
});
