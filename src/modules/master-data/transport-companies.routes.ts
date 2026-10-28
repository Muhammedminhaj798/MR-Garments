import { Router } from "express";

import { transportCompanies } from "../../db/schema";
import type { RouteContext } from "../context";
import { contactSearch, creationOrder, listRoute } from "./list-query";

// Owner: A2 (docs/wave3-contracts.md section 4). MD-10 GET /transport-companies.

export function transportCompaniesRoutes({ db }: RouteContext) {
  const router = Router();

  // Counts that come from later batches' tables are fixed at 0 (B6).
  listRoute(
    router,
    "/transport-companies",
    async () => {
      const rows = await db
        .select({
          id: transportCompanies.id,
          name: transportCompanies.name,
          contactPerson: transportCompanies.contactPerson,
          phone: transportCompanies.phone,
          status: transportCompanies.status,
        })
        .from(transportCompanies)
        .orderBy(...creationOrder(transportCompanies));
      return rows.map(({ status, ...row }) => ({ ...row, tripsSoFar: 0, status }));
    },
    contactSearch,
  );

  return router;
}
