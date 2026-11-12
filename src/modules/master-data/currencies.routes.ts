import { Router } from "express";

import { requireUser } from "../../auth/current-user";
import { ISO_4217, PREFERRED_CURRENCIES } from "../../currencies";
import type { RouteContext } from "../context";

// GET /currencies (docs/supplier-currency.md): the currency master for the supplier form's searchable picker, the same
// list every route checks a currency code against. Any signed-in user: the codes are public knowledge.

export function currenciesRoutes(_ctx: RouteContext) {
  const router = Router();
  router.get("/currencies", requireUser, (_req, res) => {
    // Generated at build time, so a browser may keep it for the day.
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.json({ currencies: ISO_4217, preferred: PREFERRED_CURRENCIES });
  });
  return router;
}
