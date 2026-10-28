import { Router } from "express";

import { items } from "../../db/schema";
import type { RouteContext } from "../context";
import { creationOrder, listRoute } from "./list-query";

// Owner: A4 (docs/wave3-contracts.md section 4). MD-19 GET /items.

export function itemsRoutes({ db }: RouteContext) {
  const router = Router();

  // A database check keeps exactly one of perBundle and bundleLabel set. No orders exist yet, so usedInOrders is [].
  listRoute(
    router,
    "/items",
    async () => {
      const rows = await db
        .select({
          id: items.id,
          name: items.name,
          countedIn: items.countedIn,
          perBundle: items.perBundle,
          bundleLabel: items.bundleLabel,
          status: items.status,
        })
        .from(items)
        .orderBy(...creationOrder(items));
      return rows.map(({ status, ...row }) => ({ ...row, usedInOrders: [] as string[], status }));
    },
    (row) => [row.name, ...row.usedInOrders],
  );

  return router;
}
