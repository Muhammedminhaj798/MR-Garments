import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clearingAgents, items, shippingAgents, teams, transportCompanies, users } from "../../db/schema";
import {
  SEED_CLEARING_AGENTS,
  SEED_ITEMS,
  SEED_LOCATIONS,
  SEED_SHIPPING_AGENTS,
  SEED_TEAMS,
  SEED_TRANSPORT_COMPANIES,
  SEED_USERS,
} from "../../db/seed-data";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";

const ctx = createTestContext();
const http = api(ctx);
let management = "";
beforeAll(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
});
afterAll(() => ctx.pool.end());

const PATHS = ["/shipping-agents", "/clearing-agents", "/transport-companies", "/locations", "/teams", "/items"];
const id = expect.any(String);
const asManagement = (path: string) => http.get(path).set("Cookie", management);
const names = async (path: string) => {
  const res = await asManagement(path);
  expect(res.status).toBe(200);
  return (res.body as { name: string }[]).map((row) => row.name);
};

describe("seeded rows in seed order, with exactly the contract fields", () => {
  it("MD-4 GET /shipping-agents", async () => {
    const res = await asManagement("/shipping-agents");
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual(SEED_SHIPPING_AGENTS.map((row) => ({ id, ...row, activeContainers: 0, status: "Active" })));
  });

  it("MD-7 GET /clearing-agents", async () => {
    const res = await asManagement("/clearing-agents");
    expect(res.body).toStrictEqual(SEED_CLEARING_AGENTS.map((row) => ({ id, ...row, containersCleared: 0, status: "Active" })));
  });

  it("MD-10 GET /transport-companies", async () => {
    const res = await asManagement("/transport-companies");
    expect(res.body).toStrictEqual(SEED_TRANSPORT_COMPANIES.map((row) => ({ id, ...row, tripsSoFar: 0, status: "Active" })));
  });

  it("MD-13 GET /locations lists the active users at each location, in user order (B6.3)", async () => {
    const res = await asManagement("/locations");
    expect(res.body).toStrictEqual(
      SEED_LOCATIONS.map((row) => ({
        id,
        ...row,
        staff: SEED_USERS.filter((user) => user.office === row.name).map((user) => user.name),
        status: "Active",
      })),
    );
    // The Head office users (no location) appear nowhere.
    expect(res.body[0].staff).toEqual(["Wang Fang", "Chen Yu", "Li Wei"]);
    expect(res.body.flatMap((row: { staff: string[] }) => row.staff)).not.toContain("Suresh Menon");
  });

  it("MD-16 GET /teams has no stock yet (B6.2)", async () => {
    const res = await asManagement("/teams");
    expect(res.body).toStrictEqual(
      SEED_TEAMS.map((row) => ({ id, ...row, piecesInStock: 0, landedCostOfStockInr: 0, averagePerPieceInr: null, status: "Active" })),
    );
  });

  it("MD-19 GET /items sets exactly one of perBundle and bundleLabel", async () => {
    const res = await asManagement("/items");
    expect(res.body).toStrictEqual(SEED_ITEMS.map((row) => ({ id, ...row, usedInOrders: [], status: "Active" })));
    for (const row of res.body as { perBundle: number | null; bundleLabel: string | null }[]) {
      expect((row.perBundle === null) !== (row.bundleLabel === null)).toBe(true);
    }
    expect(res.body.at(-1)).toMatchObject({ name: "Cotton fabric", countedIn: "Metres", perBundle: null, bundleLabel: "Roll" });
  });
});

describe("search: contains, ignoring case and spaces, on the tab's searchable columns", () => {
  it.each([
    ["/shipping-agents?search=%20SINO%20fr%20eight%20", ["Sino Freight"]],
    ["/shipping-agents?search=zhangmin", ["Sino Freight"]],
    ["/shipping-agents?search=%2B8675588", ["Dragon Cargo"]],
    ["/shipping-agents?search=Shenzhen", []], // office city is not searchable
    ["/clearing-agents?search=RAJESH", ["Southern Port Agents"]],
    ["/clearing-agents?search=9847012345", ["Kochi Clearing Services"]],
    ["/transport-companies?search=salim%20p", ["Malabar Carriers"]],
    ["/transport-companies?search=roadways", ["Kerala Roadways"]],
    ["/locations?search=chenyu", ["Guangzhou office"]],
    ["/locations?search=KOCHI", ["India office", "Main warehouse"]],
    ["/locations?search=joseph%20m", ["Main warehouse"]],
    ["/teams?search=online", ["Online team"]],
    ["/items?search=MEN%27S", ["Men's shorts", "Men's jackets"]],
    ["/items?search=cottonfab", ["Cotton fabric"]],
    ["/items?search=Pieces", []], // counted-in is not searchable
    ["/teams?search=", ["Retail team", "Wholesale team", "Online team"]],
  ])("%s", async (path, expected) => {
    expect(await names(path)).toEqual(expected);
  });
});

describe("status filter", () => {
  const tables = [
    ["/shipping-agents", shippingAgents, "Dragon Cargo"],
    ["/clearing-agents", clearingAgents, "Southern Port Agents"],
    ["/transport-companies", transportCompanies, "Malabar Carriers"],
    ["/teams", teams, "Wholesale team"],
    ["/items", items, "Polo shirts"],
  ] as const;

  it.each(tables)("%s keeps Active, Inactive or all rows", async (path, table, name) => {
    await ctx.db.update(table).set({ status: "Inactive" }).where(eq(table.name, name));
    try {
      const all = await names(path);
      expect(await names(`${path}?status=Inactive`)).toEqual([name]);
      expect(await names(`${path}?status=Active`)).toEqual(all.filter((row) => row !== name));
      expect(await names(`${path}?status=Inactive&search=${encodeURIComponent(name.toUpperCase())}`)).toEqual([name]);
      expect(await names(`${path}?status=Active&search=${encodeURIComponent(name)}`)).toEqual([]);
      expect(all).toContain(name);
    } finally {
      await ctx.db.update(table).set({ status: "Active" }).where(eq(table.name, name));
    }
  });

  it("/locations: all seeded locations are Active", async () => {
    expect(await names("/locations?status=Active")).toEqual(SEED_LOCATIONS.map((row) => row.name));
    expect(await names("/locations?status=Inactive")).toEqual([]);
  });
});

describe("MD-13 staff follow the user's status (B6.3)", () => {
  it("drops a user set Inactive and lists them again once Active", async () => {
    const staffOf = async (name: string) =>
      ((await asManagement("/locations")).body as { name: string; staff: string[] }[]).find((row) => row.name === name)?.staff;
    await ctx.db.update(users).set({ status: "Inactive" }).where(eq(users.email, SEEDED.chinaStaff));
    try {
      expect(await staffOf("Guangzhou office")).toEqual(["Wang Fang", "Li Wei"]);
      expect(await names("/locations?search=chen%20yu")).toEqual([]);
    } finally {
      await ctx.db.update(users).set({ status: "Active" }).where(eq(users.email, SEEDED.chinaStaff));
    }
    expect(await staffOf("Guangzhou office")).toEqual(["Wang Fang", "Chen Yu", "Li Wei"]);
  });
});

describe("malformed queries are 400", () => {
  const bad = ["?foo=1", "?status=All", "?status=active", "?status=", "?status=Active&status=Inactive", "?search=a&search=b", "?Search=a"];
  it.each(PATHS)("%s", async (path) => {
    for (const query of bad) {
      const res = await asManagement(`${path}${query}`);
      expect(res.status, `${path}${query}`).toBe(400);
      expect(res.body).toEqual({ error: { code: "bad_request", message: "Something went wrong." } });
    }
    // Permission is checked first: signed out stays 401 whatever the query.
    expect((await http.get(`${path}?foo=1`)).status).toBe(401);
  });
});

describe("read-only: POST and PATCH fall through to 404 (B6)", () => {
  it.each(PATHS.filter((path) => path !== "/shipping-agents"))("%s", async (path) => {
    for (const res of [
      await http.post(path, { name: "New" }).set("Cookie", management),
      await http.patch(path, { name: "New" }).set("Cookie", management),
      await http.patch(`${path}/00000000-0000-4000-8000-000000000000`, { status: "Inactive" }).set("Cookie", management),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found", message: "Endpoint not found." } });
    }
  });
});

describe("AT-R5: Management only", () => {
  const others = [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff];
  it.each(PATHS)("%s", async (path) => {
    expect((await asManagement(path)).status).toBe(200);
    const signedOut = await http.get(path);
    expect(signedOut.status).toBe(401);
    expect(signedOut.body.error.code).toBe("unauthenticated");
    for (const email of others) {
      const res = await http.get(path).set("Cookie", await signInAs(ctx, email));
      expect(res.status, email).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
  });

  it("covers all six roles", () => {
    expect(new Set([SEEDED.management, ...others].map((email) => SEED_USERS.find((user) => user.email === email)?.role)).size).toBe(6);
  });
});
