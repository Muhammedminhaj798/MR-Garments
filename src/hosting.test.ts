import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import express from "express";
import type pg from "pg";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "./app";
import { SESSION_COOKIE, establishSession, sessionMiddleware } from "./auth/session";
import { readConfig } from "./config";
import type { Database } from "./db/client";

// B1/B2 without a database: sessions are written to a stand-in pool (the store only needs query() to resolve), and the
// sign-in attempts below fail validation before any database lookup, which is what the rate limit counts.
const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
// https, so the same origin is valid in production (B) as well as in development and tests.
const ORIGIN = "https://app.example.com";
const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:secret-value@localhost:5432/mr_garments_test",
  SESSION_SECRET: "x".repeat(40),
  APP_ORIGIN: ORIGIN,
};
const settings = (env: Record<string, string>) => readConfig({ ...base, ...env });

describe("proxy trust and the sign-in limit (B2, B9.1)", () => {
  const api = (env: Record<string, string>) => request(createApp({ config: settings(env), db: {} as Database, pool }));
  // A missing password fails validation (422) before the database, and every failure counts towards the limit.
  const failedSignIn = (app: ReturnType<typeof api>, forwardedFor: string) =>
    app.post("/api/v1/auth/login").set("Origin", ORIGIN).set("X-Forwarded-For", forwardedFor).send({ email: "limit@example.com", keepSignedIn: false });

  it("takes TRUST_PROXY into the app", () => {
    expect(createApp({ config: settings({ TRUST_PROXY: "2" }), db: {} as Database, pool }).get("trust proxy")).toBe(2);
  });

  it("with the platform's hop count, limits each real client separately and ignores addresses the client adds", async () => {
    // Two proxies in front of the API: the browser's address is the second entry from the right.
    const app = api({ TRUST_PROXY: "2" });
    for (let i = 0; i < 5; i++) expect((await failedSignIn(app, "198.51.100.1, 203.0.113.10, 192.0.2.1")).status).toBe(422);
    // Same client with a different made-up left-most entry: still blocked.
    expect((await failedSignIn(app, "198.51.100.99, 203.0.113.10, 192.0.2.1")).status).toBe(429);
    // Another client behind the same proxy: not blocked.
    expect((await failedSignIn(app, "198.51.100.1, 203.0.113.20, 192.0.2.1")).status).toBe(422);
  });

  it("when the proxy is not trusted, a client can't escape the limit by sending its own X-Forwarded-For", async () => {
    const app = api({ TRUST_PROXY: "false" });
    for (let i = 0; i < 5; i++) expect((await failedSignIn(app, `203.0.113.${i + 1}`)).status).toBe(422);
    expect((await failedSignIn(app, "203.0.113.99")).status).toBe(429);
  });

  // Phase 4B: the API is also reachable directly on its Render address, through one Render proxy that appends the
  // address it saw to whatever X-Forwarded-For the caller sent. With TRUST_PROXY=1 Express takes that appended entry,
  // so a caller rotating forged left-hand entries is still the same client to the B9.1 limit.
  it("TRUST_PROXY=1: a direct caller can't bypass the sign-in limit with forged X-Forwarded-For entries (B9.1)", async () => {
    // For an email nobody uses, sign-in makes exactly one query (the user by email); answer it with no rows. Every
    // attempt then takes the real wrong-credentials path (dummy-hash check, 401 M2). Any other query would fail (500),
    // so the 401 assertions below also guard this stand-in.
    const noAccounts = { select: () => ({ from: () => ({ where: async () => [] }) }) } as unknown as Database;
    const app = request(createApp({ config: settings({ TRUST_PROXY: "1" }), db: noAccounts, pool }));
    const CLIENT = "198.51.100.66";
    const signIn = (forwardedFor: string) =>
      app.post("/api/v1/auth/login").set("Origin", ORIGIN).set("X-Forwarded-For", forwardedFor).send({ email: "probe@example.invalid", password: "Wrong1x", keepSignedIn: false });
    const M2 = { error: { code: "invalid_credentials", message: "Email or password is incorrect." } };
    const M3 = { error: { code: "rate_limited", message: "Too many attempts. Try again in 15 minutes." } };

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await signIn(`203.0.113.${attempt}, ${CLIENT}`); // a different forged entry every time
      expect(res.status, `attempt ${attempt}`).toBe(401);
      expect(res.body).toEqual(M2);
    }
    const sixth = await signIn(`203.0.113.99, ${CLIENT}`);
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual(M3);
    expect((await signIn(`192.0.2.7, 192.0.2.8, ${CLIENT}`)).status).toBe(429); // several forged entries: still blocked

    // Not a global key: a different real client (a different appended address), same email, is still allowed.
    expect((await signIn(`203.0.113.1, 198.51.100.77`)).status).toBe(401);
  });
});

describe("session cookie behind a proxy (B2, B9.3)", () => {
  function signIn(env: Record<string, string>, forwardedProto?: string) {
    const config = settings(env);
    const app = express();
    app.set("trust proxy", config.TRUST_PROXY); // as createApp does
    app.use(sessionMiddleware(pool, config));
    app.post("/sign-in", async (req, res) => {
      await establishSession(req, "user-1", false);
      res.status(204).end();
    });
    const call = request(app).post("/sign-in");
    return (forwardedProto ? call.set("X-Forwarded-Proto", forwardedProto) : call).then((res) =>
      (res.get("Set-Cookie") ?? []).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)),
    );
  }

  it("production behind a trusted https proxy: HttpOnly, Secure, SameSite=Lax", async () => {
    const cookie = await signIn({ NODE_ENV: "production", TRUST_PROXY: "1" }, "https");
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Lax/);
  });

  it("production never sends the session cookie over plain http", async () => {
    expect(await signIn({ NODE_ENV: "production", TRUST_PROXY: "1" })).toBeUndefined();
  });

  it("production with the proxy not trusted sets no cookie: the sign-in failure TRUST_PROXY prevents", async () => {
    expect(await signIn({ NODE_ENV: "production", TRUST_PROXY: "false" }, "https")).toBeUndefined();
  });

  it("development keeps working over http, still HttpOnly and SameSite=Lax", async () => {
    const cookie = await signIn({ NODE_ENV: "development" });
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).not.toMatch(/; Secure/);
  });
});

// A: a real start of src/server.ts in a child process, with a host that can't exist. Startup makes no database query,
// and the placeholder DATABASE_URL is unreachable in any case.
describe("server start (A)", () => {
  it("reports a bind failure and exits non-zero instead of claiming to listen", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href, join(root, "src/server.ts")], {
      cwd: tmpdir(),
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        NODE_ENV: "production",
        HOST: "256.0.0.1",
        TRUST_PROXY: "1",
        PORT: "4999",
        DATABASE_URL: "postgresql://u:secret-value@127.0.0.1:1/placeholder",
        SESSION_SECRET: "x".repeat(40),
        APP_ORIGIN: ORIGIN,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/could not listen on 256\.0\.0\.1:4999/);
    expect(result.stdout).not.toMatch(/listening/);
    expect(result.stdout + result.stderr).not.toContain("secret-value");
  }, 90_000);
});
