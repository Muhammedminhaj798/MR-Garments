import { Router } from "express";

import { clearingAgents } from "../../db/schema";
import type { RouteContext } from "../context";
import { contactSearch, creationOrder, listRoute } from "./list-query";

// Owner: A2 (docs/wave3-contracts.md section 4). MD-7 GET /clearing-agents.

export function clearingAgentsRoutes({ db }: RouteContext) {
  const router = Router();

  // Counts that come from later batches' tables are fixed at 0 (B6).
  listRoute(
    router,
    "/clearing-agents",
    async () => {
      const rows = await db
        .select({
          id: clearingAgents.id,
          name: clearingAgents.name,
          contactPerson: clearingAgents.contactPerson,
          phone: clearingAgents.phone,
          port: clearingAgents.port,
          status: clearingAgents.status,
        })
        .from(clearingAgents)
        .orderBy(...creationOrder(clearingAgents));
      return rows.map(({ status, ...row }) => ({ ...row, containersCleared: 0, status }));
    },
    contactSearch,
  );

  return router;
}
