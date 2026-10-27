import type pg from "pg";
import { z } from "zod";

import { signInUrl } from "./admin-setup";
import type { Prompt } from "./operator-prompt";
import { hashPassword, passwordProblems } from "./passwords";

// Operator-only reset of an existing, active Management account's password (scripts/reset-admin-password.ts,
// docs/operator-commands.md). It does what setting a password from a link does (B1.6): a new argon2id hash and
// password_changed_at, the user's unused password links cancelled, every session of that user signed out. It never
// creates a user and never changes the role, status or any other field.

// The sign-in rules for an email (login.routes.ts: trimmed, lower case), plus a valid address.
const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

/** The account to reset, from --email. Checked before connecting. */
export function accountEmail(value: string | undefined): string {
  const parsed = emailSchema.safeParse(value ?? "");
  if (!parsed.success) throw new Error("Name the account to reset: --email <address of an existing Management user>.");
  return parsed.data;
}

type Account = { id: string; name: string; role: string; status: string };
export type ResetInput = { email: string; target: string; appOrigin: string };

export async function resetManagementPassword(
  pool: Pick<pg.Pool, "query" | "connect">,
  prompt: Pick<Prompt, "ask">,
  say: (line: string) => void,
  { email, target, appOrigin }: ResetInput,
) {
  say(`Target: ${target}`);
  const ready = (await pool.query<{ users: string | null }>("select to_regclass('public.users')::text as users")).rows[0]?.users;
  if (!ready) throw new Error("This database has no users table. Nothing was changed.");

  // Read-only checks first, so nobody types a password for an account that can't be reset.
  const account = (await pool.query<Account>("select id, name, role, status from users where email = $1", [email])).rows[0];
  if (!account) throw new Error(`No account uses ${email}. This command only resets existing accounts. Nothing was changed.`);
  if (account.role !== "Management") {
    throw new Error(`${email} is a ${account.role} account. Only Management passwords can be reset here. Nothing was changed.`);
  }
  if (account.status !== "Active") throw new Error(`${email} is inactive. Nothing was changed.`);

  const password = await prompt.ask("New password (hidden): ", true);
  if ((await prompt.ask("Repeat the new password: ", true)) !== password) throw new Error("The passwords don't match. Nothing was changed.");
  if (passwordProblems(password).length > 0) {
    throw new Error("The password needs 8-128 characters, a number and a capital letter. Nothing was changed.");
  }
  const answer = await prompt.ask(`Reset the password of the Management user ${account.name} <${email}> in ${target}? Type yes to continue: `);
  if (answer.trim() !== "yes") throw new Error("Cancelled. Nothing was changed.");

  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query("begin");
    // The role and status are checked again, so an account changed while the operator was typing is left alone.
    const updated = await client.query(
      "update users set password_hash = $2, password_changed_at = now(), updated_at = now() where id = $1 and role = 'Management' and status = 'Active'",
      [account.id, passwordHash],
    );
    if (updated.rowCount !== 1) throw new Error("The account changed while you were typing. Nothing was changed.");
    await client.query("update password_tokens set used_at = now() where user_id = $1 and used_at is null", [account.id]);
    await client.query("delete from session where sess->>'userId' = $1", [account.id]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  say(`Password reset for ${email}. Their other sign-ins were ended. Sign in at ${signInUrl(appOrigin)}.`);
}
