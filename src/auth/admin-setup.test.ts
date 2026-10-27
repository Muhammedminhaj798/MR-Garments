import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { connectionTarget, signInUrl, targetProblem, tlsMode } from "./admin-setup";

// Placeholder connection strings only: "secret-value" stands for a password and must never appear in any output.
const NEON = "postgresql://owner:secret-value@ep-example-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full";
const NEON_TARGET = "neondb@ep-example-123456.ap-southeast-1.aws.neon.tech";
const LOCAL_DEV = "postgres://mr_garments_app:secret-value@localhost:5432/mr_garments_dev";

describe("admin target (F2)", () => {
  it("accepts the database and host DATABASE_URL points to, host in any case", () => {
    expect(targetProblem(NEON, NEON_TARGET, "production")).toBeNull();
    expect(targetProblem(NEON, NEON_TARGET.toUpperCase().replace("NEONDB", "neondb"), "production")).toBeNull();
  });

  it("requires --target and its <database>@<host> form", () => {
    expect(targetProblem(NEON, undefined, "production")).toMatch(/--target <database>@<host>/);
    expect(targetProblem(NEON, "  ", "production")).toMatch(/--target <database>@<host>/);
    expect(targetProblem(NEON, "neondb", "production")).toMatch(/must be <database>@<host>/);
    expect(targetProblem(NEON, "neondb@", "production")).toMatch(/must be <database>@<host>/);
  });

  it.each([
    ["another database", "otherdb@ep-example-123456.ap-southeast-1.aws.neon.tech"],
    ["another host", "neondb@ep-other-999999.ap-southeast-1.aws.neon.tech"],
    ["the database name in another case", "NeonDB@ep-example-123456.ap-southeast-1.aws.neon.tech"],
  ])("refuses a mismatch: %s", (_case, named) => {
    const problem = targetProblem(NEON, named, "production");
    expect(problem).toMatch(/does not match DATABASE_URL, which points to neondb@ep-example-123456/);
    expect(problem).not.toMatch(/secret-value/);
  });

  it.each([
    ["localhost", "postgresql://u:secret-value@localhost/neondb", "neondb@localhost"],
    ["127.0.0.1", "postgresql://u:secret-value@127.0.0.1:5432/neondb", "neondb@127.0.0.1"],
    ["::1", "postgresql://u:secret-value@[::1]:5432/neondb", "neondb@[::1]"],
    ["mr_garments_dev", "postgresql://u:secret-value@db.example.com/mr_garments_dev", "mr_garments_dev@db.example.com"],
    ["mr_garments_test", "postgresql://u:secret-value@db.example.com/mr_garments_test", "mr_garments_test@db.example.com"],
    ["mr_garments_a1", "postgresql://u:secret-value@db.example.com/mr_garments_a1", "mr_garments_a1@db.example.com"],
    ["mr_garments_a5", "postgresql://u:secret-value@db.example.com/mr_garments_a5", "mr_garments_a5@db.example.com"],
  ])("production refuses %s even when --target matches", (_case, url, named) => {
    expect(targetProblem(url, named, "production")).toMatch(/production refuses/);
  });

  it("development may still name the local development database", () => {
    expect(targetProblem(LOCAL_DEV, "mr_garments_dev@localhost", "development")).toBeNull();
  });

  it.each([
    ["a ?host= parameter that would override the address", `${NEON}&host=localhost`],
    ["an empty host that would fall back to PGHOST or localhost", "postgresql://u:secret-value@/neondb"],
    ["a Unix socket host", "postgresql://u:secret-value@%2Fvar%2Frun%2Fpostgresql/neondb"],
    ["no database", "postgresql://u:secret-value@ep-example-123456.ap-southeast-1.aws.neon.tech/"],
  ])("refuses an ambiguous DATABASE_URL: %s", (_case, url) => {
    const problem = targetProblem(url, NEON_TARGET, "production");
    expect(problem).toMatch(/DATABASE_URL (must|is not)/);
    expect(problem).not.toMatch(/secret-value/);
  });

  it("reads host and database the way pg does", () => {
    expect(connectionTarget(NEON)).toEqual({ database: "neondb", host: "ep-example-123456.ap-southeast-1.aws.neon.tech" });
  });
});

describe("confirmation output (F3)", () => {
  it("shows the TLS mode, and only that", () => {
    expect(tlsMode(NEON)).toBe("sslmode=verify-full");
    expect(tlsMode(LOCAL_DEV)).toBe("no TLS (sslmode not set)");
    expect(tlsMode("postgresql://u:secret-value@h/db?ssl=true")).toBe("ssl=true");
    expect(tlsMode(`${NEON}&channel_binding=require`)).toBe("sslmode=verify-full");
  });

  it("points the success message at APP_ORIGIN's sign-in page", () => {
    expect(signInUrl("https://app.example.com")).toBe("https://app.example.com/login");
    expect(signInUrl("https://app.example.com/")).toBe("https://app.example.com/login");
    expect(signInUrl("http://localhost:3000")).toBe("http://localhost:3000/login");
  });
});

// Real runs in a child process: the settings loading and the order of checks in scripts/create-admin.ts. Every
// DATABASE_URL below is refused before any connection, and the hosts are unreachable (port 1, .invalid) in any case.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = pathToFileURL(join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;
const dir = mkdtempSync(join(tmpdir(), "mrg-admin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Only what Node needs to start; nothing from this process's settings.
const baseEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
const run = (args: string[], env: Record<string, string>, cwd = dir) =>
  spawnSync(process.execPath, ["--import", TSX, ...args], { cwd, env: { ...baseEnv, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });

describe("real runs (F1, F2)", () => {
  it("F1: development reads .env; a process started with NODE_ENV=production refuses instead of borrowing it", () => {
    const home = mkdtempSync(join(dir, "env-"));
    writeFileSync(
      join(home, ".env"),
      ["DATABASE_URL=postgres://dev:secret-value@127.0.0.1:1/mr_garments_dev", `SESSION_SECRET=${"x".repeat(40)}`, "APP_ORIGIN=http://localhost:3000"].join("\n"),
    );
    const probe = `import { config } from ${JSON.stringify(pathToFileURL(join(ROOT, "src/config.ts")).href)};
      try { console.log("loaded " + new URL(config().DATABASE_URL).pathname.slice(1)); } catch (e) { console.log("refused " + e.message); }`;
    const development = run(["--input-type=module", "-e", probe], {}, home);
    expect(development.stdout).toContain("loaded mr_garments_dev");
    const production = run(["--input-type=module", "-e", probe], { NODE_ENV: "production" }, home);
    expect(production.stdout).toMatch(/refused [\s\S]*DATABASE_URL/);
    expect(production.stdout + production.stderr).not.toMatch(/secret-value/);
  }, 90_000);

  const SCRIPT = join(ROOT, "scripts/create-admin.ts");
  const settings = (databaseUrl: string) => ({ NODE_ENV: "production", DATABASE_URL: databaseUrl, SESSION_SECRET: "x".repeat(40), APP_ORIGIN: "https://app.example.com" });

  it.each([
    ["no --target", "postgresql://o:secret-value@ep-prod.example.invalid:1/neondb", [], /--target <database>@<host>/],
    ["a mismatched --target", "postgresql://o:secret-value@ep-prod.example.invalid:1/neondb", ["--target", "neondb@ep-other.example.invalid"], /does not match/],
    ["the local development database", "postgresql://o:secret-value@127.0.0.1:1/mr_garments_dev", ["--target", "mr_garments_dev@127.0.0.1"], /production refuses/],
    ["an unknown argument", "postgresql://o:secret-value@ep-prod.example.invalid:1/neondb", ["--force"], /Unknown option '--force'/],
  ])("F2: create-admin with %s stops before connecting or asking anything", (_case, databaseUrl, args, message) => {
    const result = run([SCRIPT, ...(args as string[])], settings(databaseUrl as string));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message as RegExp);
    expect(result.stdout).not.toContain("Target:"); // printed only after the checks, just before the first query
    expect(result.stdout + result.stderr).not.toMatch(/secret-value/);
  }, 90_000);
});
