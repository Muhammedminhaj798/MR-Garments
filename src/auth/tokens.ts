import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type pg from "pg";

import type { Config } from "../config";
import type { Database } from "../db/client";
import { passwordTokens, users } from "../db/schema";
import { HttpError, validationFailed } from "../http/errors";
import { hashPassword, passwordProblems } from "./passwords";
import { signOutEverywhere } from "./session";

// Invite and reset links (approved B1.4-B1.11, B9.12). Coordinator-owned: USR-3 issues invites, AUTH-4 completes.

export type TokenPurpose = "invite" | "reset";
const LIFETIME_MS: Record<TokenPurpose, number> = { invite: 7 * 24 * 60 * 60 * 1000, reset: 60 * 60 * 1000 };

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const LINK_INVALID_MESSAGE = "This link is invalid or has expired. Ask your manager for a new one.";

const istTime = (date: Date) =>
  new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(date) + " IST";

/**
 * Creates a single-use link and cancels the user's older unused links of the same kind. Only the hash is stored.
 * In development the link is printed to the API console (B1.9); it is never returned to the browser.
 * The raw token is returned to the caller for tests only; route handlers must not send it.
 */
export async function issuePasswordLink(db: Database, settings: Config, userId: string, purpose: TokenPurpose) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + LIFETIME_MS[purpose]);
  const email = await db.transaction(async (tx) => {
    await tx
      .update(passwordTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordTokens.userId, userId), eq(passwordTokens.purpose, purpose), isNull(passwordTokens.usedAt)));
    await tx.insert(passwordTokens).values({ tokenHash: hashToken(token), userId, purpose, expiresAt });
    return (await tx.select({ email: users.email }).from(users).where(eq(users.id, userId)))[0]?.email;
  });
  if (settings.NODE_ENV === "development") {
    const kind = purpose === "invite" ? "Invite" : "Reset";
    console.info(`[dev] ${kind} link for ${email} (expires ${istTime(expiresAt)}): ${settings.APP_ORIGIN}/set-password?token=${token}`);
  }
  return { token, expiresAt };
}

/**
 * Sets a password from a link, atomically (B1.6, B1.11): the link must be unused, unexpired and belong to an active
 * user. On success the link is used, the user's other links are cancelled and every session of the user ends.
 */
export async function completePasswordWithLink(db: Database, pool: pg.Pool, token: string, newPassword: string) {
  if (passwordProblems(newPassword).length > 0) {
    throw validationFailed({ newPassword: "Use at least 8 characters, a number and a capital letter." });
  }
  const passwordHash = await hashPassword(newPassword);
  const userId = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ userId: passwordTokens.userId, usedAt: passwordTokens.usedAt, expiresAt: passwordTokens.expiresAt, status: users.status })
      .from(passwordTokens)
      .innerJoin(users, eq(users.id, passwordTokens.userId))
      .where(eq(passwordTokens.tokenHash, hashToken(token)))
      .for("update");
    const row = rows[0];
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now() || row.status !== "Active") {
      throw new HttpError(422, "token_invalid", LINK_INVALID_MESSAGE);
    }
    await tx
      .update(passwordTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordTokens.userId, row.userId), isNull(passwordTokens.usedAt)));
    await tx.update(users).set({ passwordHash, passwordChangedAt: new Date() }).where(eq(users.id, row.userId));
    return row.userId;
  });
  await signOutEverywhere(pool, userId);
  return userId;
}
