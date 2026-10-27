import { ipKeyGenerator, rateLimit } from "express-rate-limit";

import { errorBody, HttpError } from "../http/errors";

// Approved B9.1-9.2: 5 failed sign-ins per email + IP address within 15 minutes, then 429 until the window passes
// (a correct password is refused too while blocked). Counts live in memory during local development.
export const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
export const SIGN_IN_FAILURES = 5;

export function signInRateLimit() {
  return rateLimit({
    windowMs: SIGN_IN_WINDOW_MS,
    limit: SIGN_IN_FAILURES,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}|${String(req.body?.email ?? "").trim().toLowerCase()}`,
    handler: (_req, res) => {
      res.status(429).json(errorBody(new HttpError(429, "rate_limited", "Too many attempts. Try again in 15 minutes.")));
    },
  });
}
