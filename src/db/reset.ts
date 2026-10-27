import { pathToFileURL } from "node:url";

import { sql } from "drizzle-orm";

import { config } from "../config";
import { createDatabase, databaseName } from "./client";
import { runMigrations } from "./migrate";
import { seed } from "./seed";

// W4: an agent may reset only its own database. mr_garments_dev is reserved for manual testing and is never reset.
const RESETTABLE = /^mr_garments_(a[1-5]|test)$/;

export async function resetDatabase(connectionString: string, options: Parameters<typeof seed>[1]) {
  const name = databaseName(connectionString);
  if (!RESETTABLE.test(name)) throw new Error(`Refusing to reset ${name}: only agent and test databases can be reset.`);
  const { pool, db } = createDatabase(connectionString);
  try {
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);
  } finally {
    await pool.end();
  }
  await runMigrations(connectionString);
  const fresh = createDatabase(connectionString);
  try {
    await seed(fresh.db, options);
  } finally {
    await fresh.pool.end();
  }
}

// Run directly (npm run db:reset). pathToFileURL encodes spaces ("MR Garments") the way import.meta.url does.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const settings = config();
  if (settings.NODE_ENV === "production") throw new Error("Refusing to reset in production.");
  await resetDatabase(settings.DATABASE_URL, { nodeEnv: settings.NODE_ENV, devPassword: settings.SEED_DEV_PASSWORD || undefined });
  console.info(`Reset, migrated and seeded ${databaseName(settings.DATABASE_URL)}.`);
}
