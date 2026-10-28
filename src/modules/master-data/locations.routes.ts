import { eq } from "drizzle-orm";
import { Router } from "express";

import { locations, users } from "../../db/schema";
import type { RouteContext } from "../context";
import { creationOrder, listRoute } from "./list-query";

// Owner: A3 (docs/wave3-contracts.md section 4). MD-13 GET /locations.

export function locationsRoutes({ db }: RouteContext) {
  const router = Router();

  // Staff: the names of the active users at each location, in user list order (B6.3).
  listRoute(
    router,
    "/locations",
    async () => {
      const staff = await db
        .select({ name: users.name, locationId: users.locationId })
        .from(users)
        .where(eq(users.status, "Active"))
        .orderBy(...creationOrder(users));
      const rows = await db
        .select({
          id: locations.id,
          name: locations.name,
          type: locations.type,
          country: locations.country,
          address: locations.address,
          status: locations.status,
        })
        .from(locations)
        .orderBy(...creationOrder(locations));
      return rows.map(({ status, ...row }) => ({
        ...row,
        staff: staff.filter((user) => user.locationId === row.id).map((user) => user.name),
        status,
      }));
    },
    (row) => [row.name, row.address, ...row.staff],
  );

  return router;
}
