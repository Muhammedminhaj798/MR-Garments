import { Router } from "express";

import { loginRoutes } from "./auth/login.routes";
import { passwordRoutes } from "./auth/password.routes";
import type { RouteContext } from "./context";
import { coreRoutes } from "./core/core.routes";
import { clearingAgentsRoutes } from "./master-data/clearing-agents.routes";
import { itemsRoutes } from "./master-data/items.routes";
import { locationsRoutes } from "./master-data/locations.routes";
import { shippingAgentsRoutes } from "./master-data/shipping-agents.routes";
import { suppliersRoutes } from "./master-data/suppliers.routes";
import { teamsRoutes } from "./master-data/teams.routes";
import { transportCompaniesRoutes } from "./master-data/transport-companies.routes";
import { orderDetailRoutes } from "./orders/order-detail.routes";
import { ordersRoutes } from "./orders/orders.routes";
import { paymentsRoutes } from "./payments/payments.routes";
import { reportsRoutes } from "./reports/reports.routes";
import { stagesRoutes } from "./stages/stages.routes";
import { containerDetailRoutes } from "./stock/container-detail.routes";
import { stockRoutes } from "./stock/stock.routes";
import { usersRoutes } from "./users/users.routes";

/** Registers every router under /api/v1. Coordinator-owned; agents only edit their own router files. */
export function apiRoutes(ctx: RouteContext) {
  const router = Router();
  router.use(coreRoutes(ctx));
  router.use(loginRoutes(ctx));
  router.use(passwordRoutes(ctx));
  router.use(usersRoutes(ctx));
  router.use(suppliersRoutes(ctx));
  router.use(shippingAgentsRoutes(ctx));
  router.use(clearingAgentsRoutes(ctx));
  router.use(transportCompaniesRoutes(ctx));
  router.use(locationsRoutes(ctx));
  router.use(teamsRoutes(ctx));
  router.use(itemsRoutes(ctx));
  router.use(ordersRoutes(ctx));
  router.use(orderDetailRoutes(ctx)); // after ORD-2, so /orders/options isn't read as a PO
  router.use(paymentsRoutes(ctx));
  router.use(stockRoutes(ctx));
  router.use(containerDetailRoutes(ctx)); // after CON-2, so /containers/options isn't read as an id
  router.use(stagesRoutes(ctx));
  router.use(reportsRoutes(ctx));
  return router;
}
