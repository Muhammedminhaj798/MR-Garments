import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { suppliers } from "../../db/schema";
import { GENERIC_MESSAGE, HttpError } from "../../http/errors";
import type { RouteContext } from "../context";
import { landedCostList } from "./landed-cost-list";
import { REPORTS, todayInIndia } from "./reports";

// Owner: A6. GET /landed-cost (docs/wave3-contracts.md section 6.4) and GET /reports/<name> (section 7); response
// shapes in section 8. Costs: loadLandedCosts (../costs/landed-cost.ts).

const reportQuery = z
  .strictObject({ from: z.iso.date().optional(), to: z.iso.date().optional(), supplierId: z.uuid().optional() })
  .refine((query) => !query.from || !query.to || query.from <= query.to);
const landedCostQuery = z.strictObject({ supplierId: z.uuid().optional(), teamId: z.uuid().optional() });

/** Any bad query (unknown key, repeated key, malformed date or id, `from` after `to`) is malformed: 400. */
function readQuery<T extends z.ZodType>(schema: T, query: unknown): z.infer<T> {
  const result = schema.safeParse(query);
  if (!result.success) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
  return result.data;
}

export function reportsRoutes({ db }: RouteContext) {
  const router = Router();

  router.get("/landed-cost", requirePermission("landedCost", "View"), async (req, res) => {
    res.json(await landedCostList(db, readQuery(landedCostQuery, req.query)));
  });

  // Every report echoes the filters it was given (`supplier` by name, null for an unknown id) for the report header.
  for (const [name, build] of Object.entries(REPORTS)) {
    router.get(`/reports/${name}`, requirePermission("reports", "View"), async (req, res) => {
      const filters = readQuery(reportQuery, req.query);
      const [report, supplier] = await Promise.all([
        build(db, filters, todayInIndia()),
        filters.supplierId ? db.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.id, filters.supplierId)) : [],
      ]);
      res.json({ ...report, filter: { from: filters.from ?? null, to: filters.to ?? null, supplier: supplier[0]?.name ?? null } });
    });
  }

  return router;
}
