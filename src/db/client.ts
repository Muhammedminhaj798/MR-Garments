import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { config } from "../config";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>["db"];

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // Neon closes idle connections when its compute scales to zero. Without a listener that error would stop the API;
  // the pool opens a new connection on the next query. pg error messages never contain the password.
  pool.on("error", (error) => console.error(`Database connection closed: ${error.message}`));
  return { pool, db: drizzle(pool, { schema }) };
}

let shared: ReturnType<typeof createDatabase> | undefined;

/** The process-wide pool for this worktree's database (DATABASE_URL). */
export function database() {
  shared ??= createDatabase(config().DATABASE_URL);
  return shared;
}

/** The database name from a connection string, used by the safety checks in reset and seed. */
export function databaseName(connectionString: string) {
  return new URL(connectionString).pathname.replace(/^\//, "");
}

/** The reason a query failed: Drizzle wraps the pg error (refused, wrong password, ...) as its cause. */
export function databaseError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? error.cause.message : error.message;
}

/** Where a connection string points, for confirmations: database, host and role. Never the password. */
export function describeTarget(connectionString: string) {
  const url = new URL(connectionString);
  return `database "${databaseName(connectionString)}" on ${url.hostname} as ${decodeURIComponent(url.username)}`;
}
