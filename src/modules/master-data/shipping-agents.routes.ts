import { Router } from "express";

import { shippingAgents } from "../../db/schema";
import type { RouteContext } from "../context";
import { contactSearch, creationOrder, listRoute } from "./list-query";

// Owner: A1 (docs/wave3-contracts.md section 4). MD-4 GET /shipping-agents.

export function shippingAgentsRoutes({ db }: RouteContext) {
  const router = Router();

  // Counts that come from later batches' tables are fixed at 0 (B6).
  listRoute(
    router,
    "/shipping-agents",
    async () => {
      const rows = await db
        .select({
          id: shippingAgents.id,
          name: shippingAgents.name,
          contactPerson: shippingAgents.contactPerson,
          phone: shippingAgents.phone,
          officeCity: shippingAgents.officeCity,
          status: shippingAgents.status,
        })
        .from(shippingAgents)
        .orderBy(...creationOrder(shippingAgents));
      return rows.map(({ status, ...row }) => ({ ...row, activeContainers: 0, status }));
    },
    contactSearch,
  );

  return router;
}
