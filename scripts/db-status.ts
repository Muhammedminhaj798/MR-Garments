import { readFileSync } from "node:fs";

import { type SQL, sql } from "drizzle-orm";

import { config } from "../src/config";
import { createDatabase, databaseError, describeTarget } from "../src/db/client";

// Read-only (npm run db:status): where DATABASE_URL points and how many of this checkout's migrations the database
// has. Changes nothing and prints no secrets.

const url = config().DATABASE_URL;
console.info(`Target: ${describeTarget(url)}, sslmode ${new URL(url).searchParams.get("sslmode") ?? "not set (no TLS)"}`);

const { pool, db } = createDatabase(url);
const first = async <T extends Record<string, unknown>>(query: SQL) => (await db.execute<T>(query)).rows[0]!;
try {
  const { version } = await first<{ version: string }>(sql`select current_setting('server_version') as version`);
  console.info(`Connected: PostgreSQL ${version}`);

  const expected: number = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries.length;
  const { tracked, usersTable } = await first<{ tracked: string | null; usersTable: string | null }>(
    sql`select to_regclass('drizzle.__drizzle_migrations')::text as "tracked", to_regclass('public.users')::text as "usersTable"`,
  );
  const applied = tracked ? (await first<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)).n : 0;
  console.info(`Migrations: ${applied} of ${expected} applied${applied < expected ? " (npm run db:migrate applies the rest)" : ""}`);

  if (usersTable) {
    const { n } = await first<{ n: number }>(sql`select count(*)::int as n from users where role = 'Management' and status = 'Active'`);
    console.info(`Active Management users: ${n}`);
  }
} catch (error) {
  console.error(`Database check failed: ${databaseError(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
