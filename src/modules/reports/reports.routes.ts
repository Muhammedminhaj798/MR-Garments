import { Router } from "express";

import type { RouteContext } from "../context";

// Owner: A6. GET /landed-cost (docs/wave3-contracts.md section 6.4) and GET /reports/<name> (section 7).
// Costs: loadLandedCosts (../costs/landed-cost.ts).

export function reportsRoutes(_ctx: RouteContext) {
  const router = Router();
  return router;
}
