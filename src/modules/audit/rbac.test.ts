import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROLES, users, userStageGrants } from "../../db/schema";
import { effectiveAccess, MATRIX } from "../../permissions/matrix";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";

// RBAC audit (sprint 2026-10-31, Agent 5). For every mutating route: signed out is 401, every seeded user without the
// gate's access is 403, and every user with it gets past the gate. "With access" requests are harmless on purpose (an
// unknown id or PO, or an invalid body), so nothing is created or changed. `allowed` is written out by hand, not derived
// from the matrix, so a widened gate or a matrix change that leaks access fails here.

const ctx = createTestContext();
const http = api(ctx);
beforeAll(() => resetData(ctx));
afterAll(() => ctx.pool.end());

type Who = keyof typeof SEEDED;
const EVERYONE = Object.keys(SEEDED) as Who[];
const MANAGEMENT: Who[] = ["management"];

type Row = {
  method: "post" | "patch" | "put" | "delete";
  path: string;
  body?: object;
  /** Seeded users who pass the gate; everyone else must get 403. */
  allowed: readonly Who[];
  /** Status a user with access gets; default: any harmless 4xx (400, 404, 409, 422). */
  expected?: number;
};

const NO_ID = "00000000-0000-4000-8000-000000000000";
const NO_PO = "PO-999999";

const SETTINGS = ["/suppliers", "/shipping-agents", "/clearing-agents", "/transport-companies", "/locations", "/teams", "/items"];

const ROUTES: Row[] = [
  // Auth and the signed-in user's own data (requireUser).
  { method: "post", path: "/auth/logout", allowed: EVERYONE, expected: 204 },
  { method: "patch", path: "/profile", allowed: EVERYONE }, // empty body: 400
  { method: "post", path: "/notifications/read-all", allowed: EVERYONE, expected: 200 },
  { method: "post", path: `/notifications/${NO_ID}/read`, allowed: EVERYONE },
  // Users (admin Full).
  { method: "post", path: "/users", allowed: MANAGEMENT },
  { method: "patch", path: `/users/${NO_ID}`, allowed: MANAGEMENT },
  // Settings (admin Full): POST, PATCH and DELETE on each of the seven tabs.
  ...SETTINGS.flatMap((path): Row[] => [
    { method: "post", path, allowed: MANAGEMENT },
    { method: "patch", path: `${path}/${NO_ID}`, body: { status: "Inactive" }, allowed: MANAGEMENT },
    { method: "delete", path: `${path}/${NO_ID}`, allowed: MANAGEMENT },
  ]),
  // Orders and payments.
  { method: "post", path: "/orders", allowed: ["management", "procurement"] }, // ordersEdit >= Enter
  { method: "post", path: "/payments", allowed: ["management", "accounts"] }, // payments >= Enter
  // Stages: the matrix narrowed by grants. Chen holds Receiving only, so Container loading is 403 for him.
  { method: "post", path: "/receipts", allowed: ["management", "chinaStaff", "chinaStaffTwoStages"] },
  { method: "post", path: "/containers", allowed: ["management", "chinaStaffTwoStages"] },
  { method: "patch", path: `/containers/${NO_ID}`, allowed: ["management", "chinaStaffTwoStages"] },
  { method: "put", path: `/clearings/${NO_ID}`, allowed: ["management", "indiaStaff"] },
  { method: "put", path: `/transports/${NO_ID}`, allowed: ["management", "indiaStaff"] },
  { method: "put", path: `/warehouse-receipts/${NO_ID}`, allowed: ["management", "warehouseStaff"] },
];

// docs/orders-users-contract.md. Not in this worktree until the lead integrates the sprint branches.
const SPRINT_ROUTES: Row[] = [
  { method: "patch", path: `/orders/${NO_PO}`, body: { deliveryDate: "2026-12-31" }, allowed: ["management", "procurement"] }, // ORD-5
  { method: "delete", path: `/orders/${NO_PO}`, allowed: MANAGEMENT }, // ORD-6
  { method: "delete", path: `/users/${NO_ID}`, allowed: MANAGEMENT }, // USR-5
];

const send = ({ method, path, body }: Row) => (method === "delete" ? http.delete(path) : http[method](path, body ?? {}));
const label = (row: Row) => `${row.method.toUpperCase()} ${row.path}`;

function gateTests(rows: Row[]) {
  describe.each(rows.map((row) => [label(row), row] as const))("%s", (_name, row) => {
    it("signed out: 401", async () => {
      expect((await send(row)).status).toBe(401);
    });

    const denied = EVERYONE.filter((who) => !row.allowed.includes(who));
    if (denied.length > 0) {
      it.each(denied)("%s without access: 403", async (who) => {
        const res = await send(row).set("Cookie", await signInAs(ctx, SEEDED[who]));
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      });
    }

    it.each(row.allowed)("%s with access: past the gate, nothing changed", async (who) => {
      const res = await send(row).set("Cookie", await signInAs(ctx, SEEDED[who]));
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.body?.error?.message, "route is not registered").not.toBe("Endpoint not found.");
      if (row.expected) expect(res.status).toBe(row.expected);
      else expect([400, 404, 409, 422]).toContain(res.status);
    });
  });
}

describe("seeded users the tables rely on", () => {
  it("cover all six roles, with the stage grants the rows assume", async () => {
    const roleAndStages = async (email: string) => {
      const user = (await ctx.db.select({ id: users.id, role: users.role }).from(users).where(eq(users.email, email)))[0]!;
      const grants = await ctx.db.select({ stage: userStageGrants.stage }).from(userStageGrants).where(eq(userStageGrants.userId, user.id));
      return { role: user.role, stages: grants.map((grant) => grant.stage).sort() };
    };
    expect(await roleAndStages(SEEDED.management)).toEqual({ role: "Management", stages: [] });
    expect(await roleAndStages(SEEDED.procurement)).toEqual({ role: "Procurement", stages: [] });
    expect(await roleAndStages(SEEDED.accounts)).toEqual({ role: "Accounts", stages: [] });
    expect(await roleAndStages(SEEDED.chinaStaff)).toEqual({ role: "China staff", stages: [2] });
    expect(await roleAndStages(SEEDED.chinaStaffTwoStages)).toEqual({ role: "China staff", stages: [2, 3] });
    expect(await roleAndStages(SEEDED.indiaStaff)).toEqual({ role: "India staff", stages: [4, 5] });
    expect(await roleAndStages(SEEDED.warehouseStaff)).toEqual({ role: "Warehouse staff", stages: [6] });
  });
});

describe("admin capability (D1: Settings and users is Management only)", () => {
  it("is Full for Management and None for the other five roles", () => {
    expect(MATRIX.admin).toEqual({
      Management: "Full",
      Procurement: "None",
      Accounts: "None",
      "China staff": "None",
      "India staff": "None",
      "Warehouse staff": "None",
    });
  });

  it("no stage grant gives it to anyone else", () => {
    for (const role of ROLES) expect(effectiveAccess(role, [2, 3, 4, 5, 6], "admin"), role).toBe(role === "Management" ? "Full" : "None");
  });

  it("ME-1 reports it Full only to Management", async () => {
    for (const who of EVERYONE) {
      const me = await http.get("/me").set("Cookie", await signInAs(ctx, SEEDED[who]));
      expect(me.body.permissions.admin, who).toBe(who === "management" ? "Full" : "None");
    }
  });
});

describe("mutating routes that exist today", () => {
  gateTests(ROUTES);

  it("change-password and reset-password are 403 for everyone, signed in or not (disabled by policy)", async () => {
    for (const path of ["/auth/change-password", "/auth/reset-password"]) {
      expect((await http.post(path)).status, path).toBe(403);
      for (const who of EVERYONE) expect((await http.post(path).set("Cookie", await signInAs(ctx, SEEDED[who]))).status, `${path} ${who}`).toBe(403);
    }
  });
});

describe("sprint routes (ORD-5, ORD-6, USR-5)", () => {
  gateTests(SPRINT_ROUTES);
});
