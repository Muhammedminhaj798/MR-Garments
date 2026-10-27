import { eq } from "drizzle-orm";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";

const ctx = createTestContext();
const http = api(ctx);
beforeAll(() => resetData(ctx));
afterAll(() => ctx.pool.end());

describe("GET /health", () => {
  it("reports the API and database are up, with security headers (B9.18)", async () => {
    const res = await http.get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", database: "ok" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("error format and request protections", () => {
  it("returns the standard 404 body for an unknown endpoint", async () => {
    const res = await http.get("/nothing-here");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found", message: "Endpoint not found." } });
  });

  it("refuses data changes from another site (B9.8) and non-JSON bodies", async () => {
    const other = await supertest(ctx.app).post("/api/v1/auth/logout").set("Origin", "http://evil.example").send({});
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("origin_rejected");
    const noOrigin = await supertest(ctx.app).post("/api/v1/auth/logout").send({});
    expect(noOrigin.status).toBe(403);
    const text = await supertest(ctx.app).post("/api/v1/auth/logout").set("Origin", ctx.config.APP_ORIGIN).set("Content-Type", "text/plain").send("x");
    expect(text.status).toBe(415);
  });

  it("refuses bodies over 100 KB (B9.17) and malformed JSON", async () => {
    const big = await http.post("/users", { filler: "x".repeat(110 * 1024) });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("too_large");
    const broken = await supertest(ctx.app).post("/api/v1/users").set("Origin", ctx.config.APP_ORIGIN).set("Content-Type", "application/json").send("{");
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe("bad_request");
  });
});

describe("ME-1 GET /me", () => {
  it("is 401 when signed out", async () => {
    const res = await http.get("/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it("describes Management", async () => {
    const res = await http.get("/me").set("Cookie", await signInAs(ctx, SEEDED.management));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "Suresh Menon",
      initials: "SM",
      role: "Management",
      office: null,
      accessLabel: "Full access",
      shell: "management",
      landing: "/",
      stages: [],
    });
    expect(res.body.permissions.admin).toBe("Full");
  });

  it("describes China staff with their grants applied", async () => {
    const res = await http.get("/me").set("Cookie", await signInAs(ctx, SEEDED.chinaStaff));
    expect(res.body).toMatchObject({
      name: "Chen Yu",
      initials: "CY",
      office: { name: "Guangzhou office", type: "China office" },
      accessLabel: "Entry only",
      shell: "staff",
      landing: "/home",
      stages: [2],
    });
    expect(res.body.permissions.receiving).toBe("Enter");
    expect(res.body.permissions.containers).toBe("None");
    expect(res.body.permissions.payments).toBe("None");
  });

  it("lands India staff on their first stage", async () => {
    const res = await http.get("/me").set("Cookie", await signInAs(ctx, SEEDED.indiaStaff));
    expect(res.body).toMatchObject({ shell: "staff", landing: "/clearing", stages: [4, 5], accessLabel: "Entry only" });
  });

  it("ends the session of a user made inactive (B8.4, B9.15)", async () => {
    const cookie = await signInAs(ctx, SEEDED.warehouseStaff);
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(200);
    await ctx.db.update(users).set({ status: "Inactive" }).where(eq(users.email, SEEDED.warehouseStaff));
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(401);
    await ctx.db.update(users).set({ status: "Active" }).where(eq(users.email, SEEDED.warehouseStaff));
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(401);
  });
});

describe("ROL-1 GET /roles", () => {
  it("is Management only", async () => {
    expect((await http.get("/roles")).status).toBe(401);
    for (const email of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      expect((await http.get("/roles").set("Cookie", await signInAs(ctx, email))).status).toBe(403);
    }
    const res = await http.get("/roles").set("Cookie", await signInAs(ctx, SEEDED.management));
    expect(res.status).toBe(200);
    expect(res.body.roles).toHaveLength(6);
    expect(res.body.capabilities).toHaveLength(13);
    expect(res.body.matrix.admin.Management).toBe("Full");
  });
});
