import argon2 from "argon2";

// Approved B9.9: argon2id at the OWASP minimum (19 MiB, 2 iterations, 1 thread). The settings are stored in each
// hash, so needsRehash() picks up stronger settings later.
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export type PasswordProblem = "too_short" | "too_long" | "no_number" | "no_capital";

/** Approved B9.10: 8 to 128 characters, at least one number and one capital letter. */
export function passwordProblems(password: string): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  if (password.length < PASSWORD_MIN) problems.push("too_short");
  if (password.length > PASSWORD_MAX) problems.push("too_long");
  if (!/\d/.test(password)) problems.push("no_number");
  if (!/[A-Z]/.test(password)) problems.push("no_capital");
  return problems;
}

export const hashPassword = (password: string) => argon2.hash(password, OPTIONS);

export async function verifyPassword(hash: string | null, password: string) {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export const needsRehash = (hash: string) => argon2.needsRehash(hash, OPTIONS);
