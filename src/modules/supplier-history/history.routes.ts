import { Router } from "express";
import type { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { GENERIC_MESSAGE, HttpError } from "../../http/errors";
import type { RouteContext } from "../context";
import {
  eventsQuery,
  landedCostQuery,
  ordersQuery,
  paymentsQuery,
  receiptsQuery,
  reportQuery,
  supplierHistoryEvents,
  supplierHistoryLandedCost,
  supplierHeader,
  supplierHistoryOrders,
  supplierHistoryPayments,
  supplierHistoryReceipts,
  supplierHistoryReport,
  supplierOverview,
} from "./history";

// Supplier Full History (docs/supplier-history.md): SH-1..SH-6 for the supplier profile's tabs and RPT-SH for the
// Supplier History report. Read-only, Management only (reports View) in the first release.

/** Any bad query (unknown or repeated key, malformed date, id or page, `from` after `to`) is 400. */
function readQuery<T extends z.ZodType>(schema: T, query: unknown): z.infer<T> {
  const result = schema.safeParse(query);
  if (!result.success) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
  return result.data;
}

export function supplierHistoryRoutes({ db }: RouteContext) {
  const router = Router();
  const management = requirePermission("reports", "View");
  const id = (params: { id?: string }) => String(params.id);

  router.get("/suppliers/:id/history", management, async (req, res) => {
    res.json(await supplierOverview(db, id(req.params)));
  });
  router.get("/suppliers/:id/history/header", management, async (req, res) => {
    res.json(await supplierHeader(db, id(req.params)));
  });
  router.get("/suppliers/:id/history/orders", management, async (req, res) => {
    res.json(await supplierHistoryOrders(db, id(req.params), readQuery(ordersQuery, req.query)));
  });
  router.get("/suppliers/:id/history/payments", management, async (req, res) => {
    res.json(await supplierHistoryPayments(db, id(req.params), readQuery(paymentsQuery, req.query)));
  });
  router.get("/suppliers/:id/history/receipts", management, async (req, res) => {
    res.json(await supplierHistoryReceipts(db, id(req.params), readQuery(receiptsQuery, req.query)));
  });
  router.get("/suppliers/:id/history/landed-cost", management, async (req, res) => {
    res.json(await supplierHistoryLandedCost(db, id(req.params), readQuery(landedCostQuery, req.query)));
  });
  router.get("/suppliers/:id/history/events", management, async (req, res) => {
    res.json(await supplierHistoryEvents(db, id(req.params), readQuery(eventsQuery, req.query)));
  });
  router.get("/reports/supplier-history", management, async (req, res) => {
    res.json(await supplierHistoryReport(db, readQuery(reportQuery, req.query)));
  });
  return router;
}
