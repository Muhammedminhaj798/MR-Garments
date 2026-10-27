import { config, loadEnvFile } from "../src/config";
import { databaseName } from "../src/db/client";

// QA screenshot checks (visual-diff --storage-state): serves the API on this worktree's test database exactly as the
// last browser-test run left it. No reset and no seeding, so the sessions saved in playwright/.auth stay valid.
// Uses .env.test (mr_garments_test in the integration worktree) and refuses any other database.
loadEnvFile(".env.test");
process.env.NODE_ENV = "test";
const name = databaseName(config().DATABASE_URL);
if (!/^mr_garments_(test|a[1-5])$/.test(name)) throw new Error(`serve-test serves only a test database, not ${name}.`);
await import("../src/server");
