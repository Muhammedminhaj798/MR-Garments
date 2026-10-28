import { createHmac, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import supertest from "supertest";

import { createApp } from "../app";
import { hashPassword } from "../auth/passwords";
import { IDLE_TTL_SECONDS, SESSION_COOKIE } from "../auth/session";
import { readConfig } from "../config";
import { createDatabase, databaseName } from "../db/client";
import { users } from "../db/schema";
import { seed } from "../db/seed";

// Shared test helpers. Coordinator-owned. Test files run one at a time (vitest.config.ts) against this worktree's own
// database, which global-setup rebuilt; call resetData() in beforeEach/beforeAll to start from the seed.

/** A random password per test run that meets the rules. Never a fixed or real password. */
export const TEST_PASSWORD = `Aa1${randomBytes(12).toString("base64url")}`;

export function createTestContext() {
  const settings = readConfig({ ...process.env, NODE_ENV: "test" });
  if (!/^mr_garments_(a[1-5]|test)$/.test(databaseName(settings.DATABASE_URL))) {
    throw new Error("Tests may only use an agent or test database.");
  }
  const { db, pool } = createDatabase(settings.DATABASE_URL);
  const app = createApp({ db, pool, config: settings });
  return { db, pool, config: settings, app };
}

export type TestContext = ReturnType<typeof createTestContext>;

const TABLES = [
  "session",
  "password_tokens",
  "user_stage_grants",
  "users",
  "locations",
  "suppliers",
  "shipping_agents",
  "clearing_agents",
  "transport_companies",
  "teams",
  "items",
  "warehouse_receipt_lines",
  "warehouse_receipts",
  "transports",
  "clearings",
];

/** Empties every table and re-seeds, giving every seeded user TEST_PASSWORD. */
export async function resetData(ctx: TestContext) {
  await ctx.db.execute(sql.raw(`truncate table ${TABLES.map((name) => `"${name}"`).join(", ")} restart identity cascade`));
  await seed(ctx.db, { nodeEnv: "test" });
  const hash = await hashPassword(TEST_PASSWORD);
  await ctx.db.update(users).set({ passwordHash: hash, passwordChangedAt: new Date() });
}

/** Supertest with the headers a same-site browser request carries (B9.8). */
export function api(ctx: TestContext) {
  const origin = ctx.config.APP_ORIGIN;
  const agent = supertest(ctx.app);
  return {
    get: (path: string) => agent.get(`/api/v1${path}`),
    post: (path: string, body: object = {}) => agent.post(`/api/v1${path}`).set("Origin", origin).send(body),
    patch: (path: string, body: object = {}) => agent.patch(`/api/v1${path}`).set("Origin", origin).send(body),
    put: (path: string, body: object = {}) => agent.put(`/api/v1${path}`).set("Origin", origin).send(body),
    delete: (path: string) => agent.delete(`/api/v1${path}`).set("Origin", origin).send({}),
  };
}

const signCookie = (value: string, secret: string) =>
  `${value}.${createHmac("sha256", secret).update(value).digest("base64").replace(/=+$/, "")}`;

/**
 * Signs a seeded user in by writing a session row directly, so agents can test their endpoints without depending on
 * the sign-in endpoint. Returns the Cookie header value.
 */
export async function signInAs(ctx: TestContext, email: string) {
  const user = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0];
  if (!user) throw new Error(`No seeded user ${email}`);
  const sid = randomBytes(24).toString("base64url");
  const sess = { cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: "/", sameSite: "lax" }, userId: user.id };
  await ctx.pool.query(`insert into session (sid, sess, expire) values ($1, $2, now() + ($3 || ' seconds')::interval)`, [
    sid,
    JSON.stringify(sess),
    String(IDLE_TTL_SECONDS),
  ]);
  return `${SESSION_COOKIE}=${encodeURIComponent(`s:${signCookie(sid, ctx.config.SESSION_SECRET)}`)}`;
}

export const SEEDED = {
  management: "suresh@mrgarments.com",
  procurement: "priya@mrgarments.com",
  accounts: "anita@mrgarments.com",
  chinaStaff: "chen@mrgarments.com",
  chinaStaffTwoStages: "wang@mrgarments.com",
  indiaStaff: "anil@mrgarments.com",
  warehouseStaff: "joseph@mrgarments.com",
} as const;
