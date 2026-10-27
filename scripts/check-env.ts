import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { passwordProblems } from "../src/auth/passwords";

// Reports whether settings are present and valid. Prints names and "set"/"missing", never values (W6).
// Usage: tsx scripts/check-env.ts [--file .env] [--require-password SEED_DEV_PASSWORD]

const { values } = parseArgs({
  options: { file: { type: "string", default: ".env" }, "require-password": { type: "string", multiple: true, default: [] } },
});

if (!existsSync(values.file)) {
  console.info(`${values.file}: missing`);
  process.exit(1);
}
const entries = new Map(
  readFileSync(values.file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()] as const),
);

let ok = true;
for (const name of ["NODE_ENV", "PORT", "DATABASE_URL", "SESSION_SECRET", "APP_ORIGIN"]) {
  const set = Boolean(entries.get(name));
  ok &&= set;
  console.info(`${name}: ${set ? "set" : "missing"}`);
}
for (const name of values["require-password"]) {
  const value = entries.get(name) ?? "";
  const status = !value ? "missing" : passwordProblems(value).length ? "set, but does not meet the password rules" : "set and meets the rules";
  ok &&= status === "set and meets the rules";
  console.info(`${name}: ${status}`);
}
process.exit(ok ? 0 : 1);
