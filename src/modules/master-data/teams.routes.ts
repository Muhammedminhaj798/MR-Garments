import { Router } from "express";

import { teams } from "../../db/schema";
import type { RouteContext } from "../context";
import { creationOrder, listRoute } from "./list-query";

// Owner: A3 (docs/wave3-contracts.md section 4). MD-16 GET /teams.

export function teamsRoutes({ db }: RouteContext) {
  const router = Router();

  // Stock values come from later batches: 0, 0 and null (shown as "–", B6.2 and 5.6).
  listRoute(
    router,
    "/teams",
    async () => {
      const rows = await db.select({ id: teams.id, name: teams.name, status: teams.status }).from(teams).orderBy(...creationOrder(teams));
      return rows.map(({ status, ...row }) => ({ ...row, piecesInStock: 0, landedCostOfStockInr: 0, averagePerPieceInr: null, status }));
    },
    (row) => [row.name],
  );

  return router;
}
