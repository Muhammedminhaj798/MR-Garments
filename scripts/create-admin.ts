import { parseArgs } from "node:util";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { signInUrl, targetProblem, tlsMode } from "../src/auth/admin-setup";
import { operatorPrompt } from "../src/auth/operator-prompt";
import { hashPassword, passwordProblems } from "../src/auth/passwords";
import { type Config, config } from "../src/config";
import { createDatabase, databaseError, describeTarget } from "../src/db/client";
import { users } from "../src/db/schema";

// Operator command (B1 option d): creates one Management user. tsx scripts/create-admin.ts --target <database>@<host>
// --target must name the database and host DATABASE_URL points to (F2); production refuses local hosts and the
// development and test databases. Checked before connecting or asking anything. Then asks for the name, email and
// password (hidden), or takes ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD from the environment, shows the target with its
// TLS mode, and writes only after you type "yes". Never changes an existing user and never prints the password.

const prompt = operatorPrompt({ noTerminalHint: " Or set ADMIN_PASSWORD." });
const ask = prompt.ask;

// The same rules as the Add user form (src/modules/users/users.routes.ts).
const nameSchema = z.string().trim().min(1, "Enter the full name.");
const emailSchema = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address."));
const check = <T>(schema: z.ZodType<T>, value: string) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid value.");
  return parsed.data;
};

/** Settings (F1: production reads only its real environment), arguments and the named target, before any connection. */
function preflight(): Config {
  const settings = config();
  const { values } = parseArgs({ options: { target: { type: "string" } } });
  const problem = targetProblem(settings.DATABASE_URL, values.target, settings.NODE_ENV);
  if (problem) throw new Error(problem);
  return settings;
}

let settings: Config;
try {
  settings = preflight();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const url = settings.DATABASE_URL;
const { pool, db } = createDatabase(url);
try {
  const target = `${describeTarget(url)}, ${tlsMode(url)}`;
  console.info(`Target: ${target}`);
  const ready = (await db.execute<{ users: string | null }>(sql`select to_regclass('public.users')::text as users`)).rows[0]?.users;
  if (!ready) throw new Error("This database has no users table yet. Apply the migrations first (npm run db:migrate), then run this again.");

  const name = check(nameSchema, process.env.ADMIN_NAME || (await ask("Full name: ")));
  const email = check(emailSchema, process.env.ADMIN_EMAIL || (await ask("Email: ")));
  const existing = (await db.select({ role: users.role, status: users.status }).from(users).where(eq(users.email, email)))[0];
  if (existing) {
    throw new Error(`A user with this email already exists (${existing.role}, ${existing.status}). Nothing was changed.`);
  }

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await ask("Password (hidden): ", true);
    if ((await ask("Repeat the password: ", true)) !== password) throw new Error("The passwords don't match. Nothing was changed.");
  }
  if (passwordProblems(password).length > 0) {
    throw new Error("The password needs 8-128 characters, a number and a capital letter. Nothing was changed.");
  }

  const answer = await ask(`Create the Management user ${name} <${email}> in ${target}? Type yes to continue: `);
  if (answer.trim() !== "yes") throw new Error("Cancelled. Nothing was changed.");

  const created = await db
    .insert(users)
    .values({ name, email, role: "Management", passwordHash: await hashPassword(password), passwordChangedAt: new Date() })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (created.length === 0) throw new Error("A user with this email was added meanwhile. Nothing was changed.");
  console.info(`Created the Management user ${email}. Sign in at ${signInUrl(settings.APP_ORIGIN)} with this email and password.`);
} catch (error) {
  console.error(databaseError(error));
  process.exitCode = 1;
} finally {
  prompt.close();
  await pool.end();
}
