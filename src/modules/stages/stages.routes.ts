import { Router } from "express";

import type { RouteContext } from "../context";

// Owner: A5. Clearing (CLR-1..3), Transport (TRN-1..3) and Warehouse (WH-1..3), docs/wave3-contracts.md section 5.
// Moving orders forward: moveOrdersToStage (../stages-shared.ts). Costs: loadLandedCosts (../costs/landed-cost.ts).

export function stagesRoutes(_ctx: RouteContext) {
  const router = Router();
  return router;
}
