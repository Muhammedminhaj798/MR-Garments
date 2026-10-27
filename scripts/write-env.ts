import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

// Coordinator tool: writes a worktree's git-ignored settings file. It never prints secrets.
// Usage: tsx scripts/write-env.ts --file <path> --database <name> --port <n> --origin <url>
//        [--node-env development|test] [--seed-password-placeholder] [--app-password-file <path>]

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    database: { type: "string" },
    port: { type: "string" },
    origin: { type: "string" },
    "node-env": { type: "string", default: "development" },
    "seed-password-placeholder": { type: "boolean", default: false },
    "app-password-file": { type: "string", default: "D:/SDEC/pgdata/mr_garments_app.pw" },
  },
});

const { file, database, port, origin } = values;
if (!file || !database || !port || !origin) throw new Error("--file, --database, --port and --origin are required.");
if (!/^mr_garments_(dev|test|a[1-5])$/.test(database)) throw new Error(`Unexpected database ${database}.`);
if (existsSync(file)) throw new Error(`${file} already exists; not overwriting it.`);

const appPassword = readFileSync(values["app-password-file"], "utf8").trim();
const lines = [
  "# Written by scripts/write-env.ts. Git-ignored; never commit or print this file.",
  `NODE_ENV=${values["node-env"]}`,
  `PORT=${port}`,
  `DATABASE_URL=postgres://mr_garments_app:${appPassword}@localhost:5432/${database}`,
  `SESSION_SECRET=${randomBytes(48).toString("base64url")}`,
  `APP_ORIGIN=${origin}`,
];
if (values["seed-password-placeholder"]) {
  lines.push("# Fill in yourself: 8-128 characters, a number and a capital letter (decision W6).", "SEED_DEV_PASSWORD=");
}
writeFileSync(file, `${lines.join("\n")}\n`, { flag: "wx" });
console.info(`Wrote ${file} (database ${database}, port ${port}).`);
