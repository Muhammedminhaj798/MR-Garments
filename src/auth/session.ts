import type { Request, Response } from "express";
import connectPgSimple from "connect-pg-simple";
import session from "express-session";
import type pg from "pg";

import type { Config } from "../config";

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}

// Approved B9.3-9.7: sessions stored in PostgreSQL; "Keep me signed in" lasts 30 days (extended while in use);
// otherwise the cookie ends with the browser and the server ends the session after 12 idle hours.
export const SESSION_COOKIE = "mrg.sid";
export const IDLE_TTL_SECONDS = 12 * 60 * 60;
export const KEEP_SIGNED_IN_MS = 30 * 24 * 60 * 60 * 1000;

const PgStore = connectPgSimple(session);

export function sessionMiddleware(pool: pg.Pool, settings: Config) {
  return session({
    name: SESSION_COOKIE,
    secret: settings.SESSION_SECRET,
    store: new PgStore({
      pool,
      tableName: "session",
      createTableIfMissing: false,
      ttl: IDLE_TTL_SECONDS,
      pruneSessionInterval: settings.NODE_ENV === "test" ? false : 15 * 60,
    }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: "lax", secure: settings.NODE_ENV === "production", path: "/" },
  });
}

const promisify = (run: (done: (error?: unknown) => void) => void) =>
  new Promise<void>((resolve, reject) => run((error) => (error ? reject(error) : resolve())));

/** Starts a signed-in session with a new session ID (B9.3). */
export async function establishSession(req: Request, userId: string, keepSignedIn: boolean) {
  await promisify((done) => req.session.regenerate(done));
  req.session.userId = userId;
  if (keepSignedIn) req.session.cookie.maxAge = KEEP_SIGNED_IN_MS;
  await promisify((done) => req.session.save(done));
}

/** Ends this request's session and clears its cookie. */
export async function endSession(req: Request, res: Response) {
  await promisify((done) => req.session.destroy(done));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Replaces the current session ID but keeps the user signed in (B9.11, after a password change). */
export async function renewSessionId(req: Request) {
  const { userId } = req.session;
  const maxAge = req.session.cookie.maxAge;
  await promisify((done) => req.session.regenerate(done));
  if (userId) req.session.userId = userId;
  if (maxAge) req.session.cookie.maxAge = maxAge;
  await promisify((done) => req.session.save(done));
}

/** Signs a user out of every session, optionally keeping one (B8.4, B9.11, B9.12). */
export async function signOutEverywhere(pool: pg.Pool, userId: string, keepSessionId?: string) {
  await pool.query(`delete from session where sess->>'userId' = $1 and ($2::text is null or sid <> $2)`, [userId, keepSessionId ?? null]);
}
