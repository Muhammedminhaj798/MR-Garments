import { sql } from "drizzle-orm";
import { Router } from "express";

import { requirePermission, requireUser, toMe } from "../../auth/current-user";
import { ROLES } from "../../db/schema";
import { CAPABILITIES, MATRIX } from "../../permissions/matrix";
import type { RouteContext } from "../context";

// Coordinator-owned endpoints: GET /health, ME-1 GET /me, ROL-1 GET /roles.
export function coreRoutes({ db }: RouteContext) {
  const router = Router();

  router.get("/health", async (_req, res) => {
    await db.execute(sql`select 1`);
    res.json({ status: "ok", database: "ok" });
  });

  router.get("/me", requireUser, (req, res) => {
    res.json(toMe(req.user!));
  });

  router.get("/roles", requirePermission("admin", "Full"), (_req, res) => {
    res.json({ roles: ROLES, capabilities: CAPABILITIES, matrix: MATRIX });
  });

  return router;
}
