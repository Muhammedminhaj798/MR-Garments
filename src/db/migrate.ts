import { pathToFileURL } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { config } from "../config";
import { createDatabase, databaseName } from "./client";

export async function runMigrations(connectionString: string) {
  const { pool, db } = createDatabase(connectionString);
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}

// Run directly (npm run db:migrate). pathToFileURL encodes spaces ("MR Garments") the way import.meta.url does.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = config().DATABASE_URL;
  await runMigrations(url);
  console.info(`Migrations applied to ${databaseName(url)}.`);
}
