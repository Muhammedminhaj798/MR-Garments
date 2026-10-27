import { Router } from "express";

import { loginRoutes } from "./auth/login.routes";
import { passwordRoutes } from "./auth/password.routes";
import type { RouteContext } from "./context";
import { coreRoutes } from "./core/core.routes";
import { readonlyMasterDataRoutes } from "./master-data/readonly.routes";
import { suppliersRoutes } from "./master-data/suppliers.routes";
import { ordersRoutes } from "./orders/orders.routes";
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
  router.use(readonlyMasterDataRoutes(ctx));
  router.use(ordersRoutes(ctx));
  router.use(stockRoutes(ctx));
  return router;
}
