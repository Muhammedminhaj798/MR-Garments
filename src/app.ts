import express from "express";
import helmet from "helmet";

import { loadCurrentUser } from "./auth/current-user";
import { sessionMiddleware } from "./auth/session";
import { errorHandler, notFoundHandler } from "./http/errors";
import { sameSiteOnly } from "./http/same-site";
import type { RouteContext } from "./modules/context";
import { apiRoutes } from "./modules/index";

/** Builds the API. Order matters: headers, body limit, same-site check, session, current user, routes, errors. */
export function createApp(ctx: RouteContext) {
  const app = express();
  // B2: trust X-Forwarded-For/-Proto only from the proxies TRUST_PROXY names (development: loopback, the Next.js /api
  // forwarding on this computer). The sign-in rate limit (B9.1) then sees the browser's address, and the Secure session
  // cookie is set when the browser used https.
  app.set("trust proxy", ctx.config.TRUST_PROXY);
  app.use(helmet()); // B9.18
  app.use(express.json({ limit: "100kb" })); // B9.17
  app.use("/api", sameSiteOnly(ctx.config.APP_ORIGIN)); // B9.8
  app.use("/api", sessionMiddleware(ctx.pool, ctx.config));
  app.use("/api", loadCurrentUser(ctx.db));
  app.use("/api/v1", apiRoutes(ctx));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
