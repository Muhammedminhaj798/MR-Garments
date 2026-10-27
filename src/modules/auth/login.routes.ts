import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { findCurrentUser, requireUser, toMe } from "../../auth/current-user";
import { hashPassword, needsRehash, verifyPassword } from "../../auth/passwords";
import { signInRateLimit } from "../../auth/rate-limit";
import { endSession, establishSession } from "../../auth/session";
import { users } from "../../db/schema";
import { GENERIC_MESSAGE, HttpError } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";

const M1 = "Enter your email and password.";
const M2 = "Email or password is incorrect.";

const loginSchema = z.strictObject({
  email: z.string(M1).trim().toLowerCase().min(1, M1),
  // No stored password is longer than 128 characters (B9.10), so a longer one can only be wrong.
  password: z.string(M1).min(1, M1).max(200, M2),
  keepSignedIn: z.boolean(GENERIC_MESSAGE),
});

// B9.13: one answer for an unknown email, a wrong password, an inactive user and a user with no password yet.
const invalidCredentials = () => new HttpError(401, "invalid_credentials", M2);

// Owner: A1 (sign in, sign out). Endpoints: AUTH-1 POST /auth/login, AUTH-2 POST /auth/logout.
export function loginRoutes({ db }: RouteContext) {
  const router = Router();
  // Accounts without a hash are checked against this one, so every failure costs one argon2 verify.
  const dummyHash = hashPassword(randomBytes(32).toString("base64url"));

  router.post("/auth/login", signInRateLimit(), async (req, res) => {
    const { email, password, keepSignedIn } = parse(loginSchema, req.body);
    const account = (await db.select({ id: users.id, hash: users.passwordHash }).from(users).where(eq(users.email, email)))[0];
    const verified = await verifyPassword(account?.hash ?? (await dummyHash), password);
    // findCurrentUser is undefined for an inactive user (B9.15).
    const user = verified && account?.hash ? await findCurrentUser(db, account.id) : undefined;
    if (!user || !account?.hash) throw invalidCredentials();

    const rehash = needsRehash(account.hash) ? { passwordHash: await hashPassword(password) } : {}; // B9.9
    await db.update(users).set({ lastSignInAt: new Date(), ...rehash }).where(eq(users.id, user.id));
    await establishSession(req, user.id, keepSignedIn);
    res.json({ user: toMe(user) });
  });

  router.post("/auth/logout", requireUser, async (req, res) => {
    await endSession(req, res);
    res.status(204).end();
  });

  return router;
}
