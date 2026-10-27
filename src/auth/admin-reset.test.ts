import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import { accountEmail, resetManagementPassword } from "./admin-reset";
import { needsRehash, verifyPassword } from "./passwords";

// Database-free: a stand-in connection records every statement and simulates the users table. "secret-value" stands
// for a database password and NewPassw0rd for the new admin password; neither may appear in any output.
const PASSWORD = "NewPassw0rd";
const TARGET = 'database "neondb" on ep-example-123456.ap-southeast-1.aws.neon.tech as owner, sslmode=verify-full';
const UPDATE_USER =
  "update users set password_hash = $2, password_changed_at = now(), updated_at = now() where id = $1 and role = 'Management' and status = 'Active'";

type User = { id: string; email: string; name: string; role: string; status: string; phone: string; language: string; passwordHash: string; passwordChangedAt: string; updatedAt: string };
const user = (id: string, email: string, patch: Partial<User> = {}): User => ({
  id,
  email,
  name: "Suresh Menon",
  role: "Management",
  status: "Active",
  phone: "+91 98470 00000",
  language: "English",
  passwordHash: "old-hash",
  passwordChangedAt: "2026-10-01",
  updatedAt: "2026-10-01",
  ...patch,
});
const ADMIN = user("11111111-1111-4111-8111-111111111111", "suresh@mrgarments.com");
const OTHER_ADMIN = user("22222222-2222-4222-8222-222222222222", "second@mrgarments.com", { name: "Second Admin" });

function fakeDatabase(rows: User[], options: { failOn?: string } = {}) {
  const users = rows.map((row) => ({ ...row }));
  const statements: { text: string; values: unknown[] }[] = [];
  const run = async (text: string, values: unknown[] = []) => {
    statements.push({ text, values });
    if (options.failOn && text.startsWith(options.failOn)) throw new Error("Connection terminated unexpectedly");
    if (text.startsWith("select to_regclass")) return { rows: [{ users: "users" }], rowCount: 1 };
    if (text === "select id, name, role, status from users where email = $1") {
      const found = users.filter((u) => u.email === values[0]).map(({ id, name, role, status }) => ({ id, name, role, status }));
      return { rows: found, rowCount: found.length };
    }
    if (text === UPDATE_USER) {
      const matched = users.filter((u) => u.id === values[0] && u.role === "Management" && u.status === "Active");
      for (const u of matched) Object.assign(u, { passwordHash: values[1], passwordChangedAt: "now()", updatedAt: "now()" });
      return { rows: [], rowCount: matched.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query: vi.fn(run), release: vi.fn() };
  const pool = { query: vi.fn(run), connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "query" | "connect">;
  const writes = () => statements.filter((s) => !s.text.startsWith("select ")).map((s) => s.text);
  return { pool, client, users, statements, writes };
}

/** Answers in order; running out behaves like Ctrl+C. `onAsk` lets a test change the database while the operator types. */
function fakePrompt(answers: string[], onAsk?: (question: string) => void) {
  const asked: { question: string; hidden: boolean }[] = [];
  const ask = vi.fn(async (question: string, hidden = false) => {
    asked.push({ question, hidden });
    onAsk?.(question);
    const next = answers.shift();
    if (next === undefined) throw new Error("Cancelled. Nothing was changed.");
    return next;
  });
  return { ask, asked };
}

async function reset(rows: User[], answers: string[], email = ADMIN.email, options: { failOn?: string; onAsk?: (q: string, db: ReturnType<typeof fakeDatabase>) => void } = {}) {
  const db = fakeDatabase(rows, options);
  const prompt = fakePrompt([...answers], options.onAsk && ((q) => options.onAsk?.(q, db)));
  const lines: string[] = [];
  let error: Error | undefined;
  try {
    await resetManagementPassword(db.pool, prompt, (line) => lines.push(line), { email, target: TARGET, appOrigin: "https://app.example.com" });
  } catch (caught) {
    error = caught as Error;
  }
  const output = [...lines, error?.message ?? ""].join("\n");
  return { ...db, prompt, lines, error, output };
}

const noSecrets = (output: string) => {
  expect(output).not.toContain(PASSWORD);
  expect(output).not.toContain("secret-value");
};

describe("account email", () => {
  it("is normalized like sign-in: trimmed and lower case", () => {
    expect(accountEmail("  Suresh@MRGarments.COM ")).toBe("suresh@mrgarments.com");
  });

  it.each([undefined, "", "   ", "not-an-email"])("refuses %j", (value) => {
    expect(() => accountEmail(value)).toThrow(/--email <address of an existing Management user>/);
  });
});

describe("resetting a Management password", () => {
  it.each([
    ["no account", [ADMIN], "nobody@mrgarments.com", /No account uses nobody@mrgarments.com/],
    ["a non-Management account", [user("33333333-3333-4333-8333-333333333333", "priya@mrgarments.com", { role: "Procurement" })], "priya@mrgarments.com", /is a Procurement account/],
    ["an inactive Management account", [user("44444444-4444-4444-8444-444444444444", "old@mrgarments.com", { status: "Inactive" })], "old@mrgarments.com", /is inactive/],
  ])("refuses %s before asking for a password, and writes nothing", async (_case, rows, email, message) => {
    const result = await reset(rows as User[], [PASSWORD, PASSWORD, "yes"], email as string);
    expect(result.error?.message).toMatch(message as RegExp);
    expect(result.error?.message).toMatch(/Nothing was changed/);
    expect(result.prompt.asked).toEqual([]);
    expect(result.writes()).toEqual([]);
    expect(result.pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["the passwords differ", [PASSWORD, "Different1"], /don't match/],
    ["the password breaks the policy", ["weak", "weak"], /8-128 characters, a number and a capital letter/],
  ])("refuses when %s, before the confirmation, and writes nothing", async (_case, answers, message) => {
    const result = await reset([ADMIN], answers);
    expect(result.error?.message).toMatch(message);
    expect(result.prompt.asked.map((a) => a.hidden)).toEqual([true, true]);
    expect(result.writes()).toEqual([]);
    expect(result.users[0]?.passwordHash).toBe("old-hash");
    noSecrets(result.output);
  });

  it.each([
    ["anything but yes", [PASSWORD, PASSWORD, "y"]],
    ["Ctrl+C at the confirmation", [PASSWORD, PASSWORD]],
  ])("cancels on %s and writes nothing", async (_case, answers) => {
    const result = await reset([ADMIN], answers);
    expect(result.error?.message).toBe("Cancelled. Nothing was changed.");
    const confirmation = result.prompt.asked[2];
    expect(confirmation?.hidden).toBe(false);
    expect(confirmation?.question).toContain(`Suresh Menon <suresh@mrgarments.com> in ${TARGET}`);
    expect(result.writes()).toEqual([]);
    noSecrets(result.output);
  });

  it("updates exactly one existing account's password, in one transaction, and nothing else", async () => {
    const result = await reset([ADMIN, OTHER_ADMIN], [PASSWORD, PASSWORD, "yes"]);
    expect(result.error).toBeUndefined();

    // Exactly these writes, in this order: no insert, no other user, no other field.
    expect(result.writes()).toEqual([
      "begin",
      UPDATE_USER,
      "update password_tokens set used_at = now() where user_id = $1 and used_at is null",
      "delete from session where sess->>'userId' = $1",
      "commit",
    ]);
    const writesWithValues = result.statements.filter((s) => !s.text.startsWith("select ") && s.values.length > 0);
    expect(writesWithValues.every((s) => s.values[0] === ADMIN.id)).toBe(true);
    expect(result.client.release).toHaveBeenCalledOnce();

    const [admin, other] = result.users;
    expect(other).toEqual(OTHER_ADMIN);
    expect(admin).toEqual({ ...ADMIN, passwordHash: admin?.passwordHash, passwordChangedAt: "now()", updatedAt: "now()" });

    // The same argon2id settings as sign-in, and never the plain password.
    const hash = admin?.passwordHash ?? "";
    expect(hash).not.toBe(PASSWORD);
    const [, algorithm, , settings] = hash.split("$");
    expect(algorithm).toBe("argon2id");
    expect(settings?.split(",").sort()).toEqual(["m=19456", "p=1", "t=2"]);
    expect(needsRehash(hash)).toBe(false);
    expect(await verifyPassword(hash, PASSWORD)).toBe(true);

    expect(result.lines.at(-1)).toBe("Password reset for suresh@mrgarments.com. Their other sign-ins were ended. Sign in at https://app.example.com/login.");
    expect(result.output).not.toContain(hash);
    noSecrets(result.output);
  });

  it("rolls back if the account is deactivated while the operator types", async () => {
    const result = await reset([ADMIN], [PASSWORD, PASSWORD, "yes"], ADMIN.email, {
      onAsk: (question, db) => {
        if (question.startsWith("Reset the password")) Object.assign(db.users[0] ?? {}, { status: "Inactive" });
      },
    });
    expect(result.error?.message).toMatch(/changed while you were typing/);
    expect(result.writes()).toEqual(["begin", UPDATE_USER, "rollback"]);
    expect(result.users[0]?.passwordHash).toBe("old-hash");
    expect(result.client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the connection when the database fails mid-way", async () => {
    const result = await reset([ADMIN], [PASSWORD, PASSWORD, "yes"], ADMIN.email, { failOn: "delete from session" });
    expect(result.error?.message).toBe("Connection terminated unexpectedly");
    expect(result.writes().at(-1)).toBe("rollback");
    expect(result.writes()).not.toContain("commit");
    expect(result.client.release).toHaveBeenCalledOnce();
    noSecrets(result.output);
  });
});

// Real runs of scripts/reset-admin-password.ts in a child process: every case stops before connecting or asking, and
// the hosts are unreachable (port 1, .invalid) in any case.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = pathToFileURL(join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;
const SCRIPT = join(ROOT, "scripts/reset-admin-password.ts");
const dir = mkdtempSync(join(tmpdir(), "mrg-reset-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const baseEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
const PROD = "postgresql://o:secret-value@ep-prod.example.invalid:1/neondb";

describe("reset-admin-password, real runs", () => {
  it.each([
    ["no --target", PROD, ["--email", "suresh@mrgarments.com"], /--target <database>@<host>/],
    ["a mismatched --target", PROD, ["--target", "neondb@ep-other.example.invalid", "--email", "suresh@mrgarments.com"], /does not match/],
    ["the local development database", "postgresql://o:secret-value@127.0.0.1:1/mr_garments_dev", ["--target", "mr_garments_dev@127.0.0.1", "--email", "suresh@mrgarments.com"], /production refuses/],
    ["no --email", PROD, ["--target", "neondb@ep-prod.example.invalid"], /--email <address of an existing Management user>/],
    ["an invalid --email", PROD, ["--target", "neondb@ep-prod.example.invalid", "--email", "suresh"], /--email/],
    ["a password given as an argument", PROD, ["--target", "neondb@ep-prod.example.invalid", "--email", "suresh@mrgarments.com", "--password", PASSWORD], /Unknown option '--password'/],
  ])("with %s, stops before connecting or asking anything", (_case, databaseUrl, args, message) => {
    const env = { NODE_ENV: "production", DATABASE_URL: databaseUrl as string, SESSION_SECRET: "x".repeat(40), APP_ORIGIN: "https://app.example.com" };
    const result = spawnSync(process.execPath, ["--import", TSX, SCRIPT, ...(args as string[])], {
      cwd: dir,
      env: { ...baseEnv, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message as RegExp);
    expect(result.stdout).not.toContain("Target:");
    noSecrets(result.stdout + result.stderr);
  }, 90_000);
});
