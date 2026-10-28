import { Router } from "express";

import type { RouteContext } from "../context";
import { clearingRoutes } from "./clearing.routes";
import { transportRoutes } from "./transport.routes";
import { warehouseRoutes } from "./warehouse.routes";

// Owner: A5. Clearing (CLR-1..3), Transport (TRN-1..3) and Warehouse (WH-1..3), docs/wave3-contracts.md section 5.
// Moving orders forward: moveOrdersToStage (../stages-shared.ts). Costs: loadLandedCosts (../costs/landed-cost.ts).

export function stagesRoutes(ctx: RouteContext) {
  const router = Router();
  router.use(clearingRoutes(ctx));
  router.use(transportRoutes(ctx));
  router.use(warehouseRoutes(ctx));
  return router;
}
