import { parseArgs } from "node:util";

import { accountEmail, resetManagementPassword } from "../src/auth/admin-reset";
import { targetProblem, tlsMode } from "../src/auth/admin-setup";
import { operatorPrompt } from "../src/auth/operator-prompt";
import { config } from "../src/config";
import { createDatabase, databaseError, describeTarget } from "../src/db/client";

// Authorized operators only (docs/operator-commands.md). Resets the password of an existing, active Management account;
// it never creates an account. tsx scripts/reset-admin-password.ts --target <database>@<host> --email <address>
// Settings (F1: production reads only its real environment), arguments, the named target (F2) and the email are
// checked before connecting or asking anything. The new password is typed twice without echo and is never accepted as
// an argument; nothing is written until you type "yes".

function preflight() {
  const settings = config();
  const { values } = parseArgs({ options: { target: { type: "string" }, email: { type: "string" } } });
  const problem = targetProblem(settings.DATABASE_URL, values.target, settings.NODE_ENV);
  if (problem) throw new Error(problem);
  return { settings, email: accountEmail(values.email) };
}

let checked: ReturnType<typeof preflight>;
try {
  checked = preflight();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { settings, email } = checked;
const url = settings.DATABASE_URL;
const { pool } = createDatabase(url);
const prompt = operatorPrompt();
try {
  await resetManagementPassword(pool, prompt, console.info, { email, target: `${describeTarget(url)}, ${tlsMode(url)}`, appOrigin: settings.APP_ORIGIN });
} catch (error) {
  console.error(databaseError(error));
  process.exitCode = 1;
} finally {
  prompt.close();
  await pool.end();
}
