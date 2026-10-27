import { describe, expect, it } from "vitest";

import { readConfig, requireHostingSettings, usesEnvFile } from "./config";

const valid = {
  NODE_ENV: "test",
  PORT: "4100",
  DATABASE_URL: "postgres://user:secret-value@localhost:5432/mr_garments_test",
  SESSION_SECRET: "x".repeat(40),
  APP_ORIGIN: "http://localhost:3100",
};

describe("readConfig", () => {
  it("accepts complete settings", () => {
    expect(readConfig(valid).PORT).toBe(4100);
  });

  it("accepts a Neon connection string", () => {
    const neon = "postgresql://role:secret-value@ep-example-123456.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    expect(readConfig({ ...valid, DATABASE_URL: neon }).DATABASE_URL).toBe(neon);
    expect(() => readConfig({ ...valid, DATABASE_URL: "mysql://role:secret-value@host/db" })).toThrow(/DATABASE_URL/);
  });

  it("names a bad setting without printing its value", () => {
    const run = () => readConfig({ ...valid, SESSION_SECRET: "short-secret-value" });
    expect(run).toThrow(/SESSION_SECRET/);
    expect(run).not.toThrow(/short-secret-value/);
  });
});

describe("settings file (F1)", () => {
  it("is read in development and tests, never by a process started with NODE_ENV=production", () => {
    expect(usesEnvFile({})).toBe(true);
    expect(usesEnvFile({ NODE_ENV: "development" })).toBe(true);
    expect(usesEnvFile({ NODE_ENV: "test" })).toBe(true);
    expect(usesEnvFile({ NODE_ENV: "production" })).toBe(false);
  });

  it("fails closed in production when the real environment lacks the settings, naming each one", () => {
    const run = () => readConfig({ NODE_ENV: "production" });
    expect(run).toThrow(/DATABASE_URL[\s\S]*SESSION_SECRET[\s\S]*APP_ORIGIN/);
  });
});

describe("hosting settings (B1, B2)", () => {
  it("keeps development on this computer and trusts only the local /api forwarding by default", () => {
    const settings = readConfig(valid);
    expect(settings.HOST).toBe("127.0.0.1");
    expect(settings.TRUST_PROXY).toBe("loopback");
  });

  it("accepts a platform host and hop counts, false, or proxy names and addresses", () => {
    expect(readConfig({ ...valid, HOST: "0.0.0.0" }).HOST).toBe("0.0.0.0");
    expect(readConfig({ ...valid, TRUST_PROXY: "2" }).TRUST_PROXY).toBe(2);
    expect(readConfig({ ...valid, TRUST_PROXY: "false" }).TRUST_PROXY).toBe(false);
    expect(readConfig({ ...valid, TRUST_PROXY: " loopback , 10.0.0.0/8,::1 " }).TRUST_PROXY).toBe("loopback,10.0.0.0/8,::1");
  });

  it.each(["true", "", "-1", "1.5", "yes", "10.0.0.0/8/1", "loopback;true"])("refuses TRUST_PROXY=%j", (value) => {
    expect(() => readConfig({ ...valid, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
  });

  it("refuses an empty HOST", () => {
    expect(() => readConfig({ ...valid, HOST: " " })).toThrow(/HOST/);
  });

  it("requires HOST and TRUST_PROXY to be set for a production server, and only there", () => {
    const production = { ...valid, NODE_ENV: "production", APP_ORIGIN: "https://app.example.com" };
    expect(() => requireHostingSettings(readConfig(production), production)).toThrow(/HOST: must be set in production[\s\S]*TRUST_PROXY/);
    const chosen = { ...production, HOST: "0.0.0.0", TRUST_PROXY: "2" };
    expect(() => requireHostingSettings(readConfig(chosen), chosen)).not.toThrow();
    expect(() => requireHostingSettings(readConfig(valid), valid)).not.toThrow();
  });
});

describe("APP_ORIGIN (B)", () => {
  const production = { ...valid, NODE_ENV: "production" };

  it.each([
    ["a trailing slash", "https://app.example.com/"],
    ["a path", "https://app.example.com/login"],
    ["a query", "https://app.example.com?x=1"],
    ["an upper-case host (browsers send lower case)", "https://App.Example.com"],
    ["the default port written out (browsers leave it out)", "https://app.example.com:443"],
  ])("refuses %s, which no browser Origin header would match", (_case, origin) => {
    expect(() => readConfig({ ...valid, APP_ORIGIN: origin })).toThrow(/APP_ORIGIN must be only the frontend's origin/);
  });

  it("requires https in production", () => {
    expect(() => readConfig({ ...production, APP_ORIGIN: "http://app.example.com" })).toThrow(/APP_ORIGIN: APP_ORIGIN must use https in production/);
    expect(readConfig({ ...production, APP_ORIGIN: "https://app.example.com" }).APP_ORIGIN).toBe("https://app.example.com");
  });

  it("keeps local development and test origins valid", () => {
    expect(readConfig({ ...valid, NODE_ENV: "development", APP_ORIGIN: "http://localhost:3000" }).APP_ORIGIN).toBe("http://localhost:3000");
    expect(readConfig(valid).APP_ORIGIN).toBe("http://localhost:3100");
  });
});

describe("no public development mode (C)", () => {
  const check = (env: Record<string, string>) => () => requireHostingSettings(readConfig(env), env);
  const withoutNodeEnv = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== "NODE_ENV"));

  it.each([
    ["NODE_ENV omitted", { ...withoutNodeEnv, HOST: "0.0.0.0" }],
    ["NODE_ENV=development", { ...valid, NODE_ENV: "development", HOST: "0.0.0.0" }],
    ["NODE_ENV=test", { ...valid, HOST: "0.0.0.0" }],
    ["a LAN address in development", { ...valid, NODE_ENV: "development", HOST: "192.168.1.76" }],
  ])("refuses a public HOST with %s", (_case, env) => {
    expect(check(env)).toThrow(/HOST: .* is reachable from other computers, which needs NODE_ENV=production/);
  });

  it.each(["127.0.0.1", "127.0.0.2", "localhost", "::1"])("allows the loopback HOST %s outside production", (host) => {
    expect(check({ ...valid, NODE_ENV: "development", HOST: host })).not.toThrow();
  });

  it("keeps the development default, and allows a public HOST in a valid production configuration", () => {
    expect(check({ ...valid, NODE_ENV: "development" })).not.toThrow();
    expect(check({ ...valid, NODE_ENV: "production", APP_ORIGIN: "https://app.example.com", HOST: "0.0.0.0", TRUST_PROXY: "1" })).not.toThrow();
  });
});
