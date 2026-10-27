import { loadEnvFile, readConfig } from "../config";
import { databaseName } from "../db/client";
import { resetDatabase } from "../db/reset";

/** Rebuilds this worktree's own database once per test run: drop, migrate, seed (no passwords). */
export default async function globalSetup() {
  loadEnvFile(".env.test");
  loadEnvFile();
  const settings = readConfig({ ...process.env, NODE_ENV: "test" });
  await resetDatabase(settings.DATABASE_URL, { nodeEnv: "test" });
  console.info(`Test database ${databaseName(settings.DATABASE_URL)} reset.`);
}
