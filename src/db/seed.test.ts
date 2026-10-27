import { asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyPassword } from "../auth/passwords";
import { createTestContext, resetData } from "../test/harness";
import { clearingAgents, items, locations, shippingAgents, suppliers, teams, transportCompanies, users, userStageGrants } from "./schema";
import { seed } from "./seed";
import { SEED_SUPPLIERS, SEED_USERS } from "./seed-data";

const ctx = createTestContext();
beforeAll(() => resetData(ctx));
afterAll(() => ctx.pool.end());

describe("seed (Q11 master data only, B7 grants, U28 Head office deferred)", () => {
  it("loads the master data from master.ts", async () => {
    expect((await ctx.db.select().from(suppliers).orderBy(asc(suppliers.name))).map((row) => row.name)).toEqual([
      "Foshan Fabrics",
      "Guangzhou Textile Co.",
      "Hangzhou Knits",
      "Shenzhen Apparel",
      "Yiwu Trims Ltd.",
    ]);
    expect(await ctx.db.select().from(shippingAgents)).toHaveLength(2);
    expect(await ctx.db.select().from(clearingAgents)).toHaveLength(2);
    expect(await ctx.db.select().from(transportCompanies)).toHaveLength(2);
    expect(await ctx.db.select().from(teams)).toHaveLength(3);
    expect(await ctx.db.select().from(items)).toHaveLength(8);
    const locationNames = (await ctx.db.select().from(locations)).map((row) => row.name).sort();
    expect(locationNames).toEqual(["Guangzhou office", "India office", "Main warehouse"]);
  });

  it("keeps the master.ts order when sorted by creation time, as list endpoints return rows", async () => {
    const userEmails = await ctx.db.select({ email: users.email }).from(users).orderBy(asc(users.createdAt));
    expect(userEmails.map((row) => row.email)).toEqual(SEED_USERS.map((user) => user.email));
    const supplierNames = await ctx.db.select({ name: suppliers.name }).from(suppliers).orderBy(asc(suppliers.createdAt));
    expect(supplierNames.map((row) => row.name)).toEqual(SEED_SUPPLIERS.map((supplier) => supplier.name));
  });

  it("seeds the 8 users, with no office for the three Head office users", async () => {
    const all = await ctx.db.select().from(users);
    expect(all).toHaveLength(8);
    const officeless = await ctx.db.select({ email: users.email }).from(users).where(isNull(users.locationId));
    expect(officeless.map((row) => row.email).sort()).toEqual(["anita@mrgarments.com", "priya@mrgarments.com", "suresh@mrgarments.com"]);
  });

  it("grants the B7 stages", async () => {
    const grants = await ctx.db
      .select({ email: users.email, stage: userStageGrants.stage })
      .from(userStageGrants)
      .innerJoin(users, eq(users.id, userStageGrants.userId));
    const byUser = (email: string) => grants.filter((grant) => grant.email === email).map((grant) => grant.stage).sort();
    expect(byUser("wang@mrgarments.com")).toEqual([2, 3]);
    expect(byUser("chen@mrgarments.com")).toEqual([2]);
    expect(byUser("li@mrgarments.com")).toEqual([2, 3]);
    expect(byUser("anil@mrgarments.com")).toEqual([4, 5]);
    expect(byUser("joseph@mrgarments.com")).toEqual([6]);
    expect(byUser("suresh@mrgarments.com")).toEqual([]);
  });

  it("refuses a development password in production and one that breaks the rules (B1.2)", async () => {
    await expect(seed(ctx.db, { nodeEnv: "production", devPassword: "Garments2026" })).rejects.toThrow(/production/);
    await expect(seed(ctx.db, { nodeEnv: "development", devPassword: "short" })).rejects.toThrow(/password rules/);
  });

  it("only gives the development password to users without one, and is safe to re-run (B1.3)", async () => {
    await ctx.db.update(users).set({ passwordHash: null }).where(eq(users.email, "li@mrgarments.com"));
    const before = (await ctx.db.select().from(users).where(eq(users.email, "chen@mrgarments.com")))[0]!.passwordHash;
    await seed(ctx.db, { nodeEnv: "development", devPassword: "Seeded2026x" });
    const li = (await ctx.db.select().from(users).where(eq(users.email, "li@mrgarments.com")))[0]!;
    const chen = (await ctx.db.select().from(users).where(eq(users.email, "chen@mrgarments.com")))[0]!;
    expect(await verifyPassword(li.passwordHash, "Seeded2026x")).toBe(true);
    expect(chen.passwordHash).toBe(before);
    expect(await ctx.db.select().from(users)).toHaveLength(8);
  });
});
