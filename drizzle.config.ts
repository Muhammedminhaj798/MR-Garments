import { defineConfig } from "drizzle-kit";

// Migrations are generated from src/db/schema/core.ts (0001), master.ts (0002), orders.ts (0003) and stages.ts (0004).
// Only the coordinator adds migrations, and a merged migration is never edited.
export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema/core.ts", "./src/db/schema/master.ts", "./src/db/schema/orders.ts", "./src/db/schema/stages.ts"],
  out: "./drizzle",
  strict: true,
});
