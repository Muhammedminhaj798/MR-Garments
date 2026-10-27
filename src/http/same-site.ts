import type { RequestHandler } from "express";

import { HttpError } from "./errors";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Approved B9.8: a request that changes data must be JSON and must come from the app's own address.
 * A wrong or missing Origin gets 403; a non-JSON body gets 415.
 */
export function sameSiteOnly(appOrigin: string): RequestHandler {
  return (req, _res, next) => {
    if (SAFE.has(req.method)) return next();
    if (req.get("origin") !== appOrigin) return next(new HttpError(403, "origin_rejected", "You don't have access to do that."));
    if (!req.is("application/json")) return next(new HttpError(415, "unsupported_media_type", "Something went wrong."));
    next();
  };
}
