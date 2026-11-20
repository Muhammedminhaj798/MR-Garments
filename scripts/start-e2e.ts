import { config, loadEnvFile } from "../src/config";
import { databaseName } from "../src/db/client";
import { resetDatabase } from "../src/db/reset";

// Browser tests (B4): started by the frontend's playwright.config.ts, never by hand against a database you need.
// Resets this worktree's test database (.env.test; reset.ts refuses anything but mr_garments_test and a1-a5), seeds
// it with E2E_PASSWORD as every seeded user's password, then serves the API. Playwright passes PORT and APP_ORIGIN.
// The password arrives from the frontend's git-ignored .env.test.local and is never printed.
loadEnvFile(".env.test");
process.env.NODE_ENV = "test";
const password = process.env.E2E_PASSWORD;
if (!password) throw new Error("E2E_PASSWORD is not set. Fill it in the frontend's .env.test.local (decision W6).");
process.env.SEED_DEV_PASSWORD = password;

const settings = config();
await resetDatabase(settings.DATABASE_URL, { nodeEnv: "test", devPassword: password });
// A freshly seeded browser-test database has no history to reconcile, so its ledger is open (docs/unified-ledger.md).
{
  const { createDatabase } = await import("../src/db/client");
  const { sql } = await import("drizzle-orm");
  const fresh = createDatabase(settings.DATABASE_URL);
  await fresh.db.execute(sql`update ledger_state set state = 'live', note = 'browser-test reset'`);
  await fresh.pool.end();
}
console.info(`Browser-test database ${databaseName(settings.DATABASE_URL)} reset and seeded.`);
await import("../src/server");
