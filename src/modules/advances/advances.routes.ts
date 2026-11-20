import { asc, eq, sql } from "drizzle-orm";
import { Router } from "express";

import { requirePermission } from "../../auth/current-user";
import { orders, supplierAdvanceEntries as a, suppliers, users } from "../../db/schema";
import { HttpError, notFound } from "../../http/errors";
import type { RouteContext } from "../context";
import { balancesOf, loadLedger } from "../ledger/ledger";
import { currencyOptions } from "../ledger/ledger.routes";
import { isUuid } from "../stages/common";

// Owner: supplier advance, now a read-only archive (docs/unified-ledger.md). ADV-1 GET /suppliers/:supplierId/advances
// lists the legacy advance entries (migration 0014) as they are; ADV-5 GET /supplier-advances/suppliers is the Record
// payment supplier list. Supplier money is the unified ledger's: ADV-2, ADV-3 and ADV-4 answer 410.

export const MESSAGES = {
  gone: "Supplier advances are recorded as supplier payments in the supplier ledger now.",
};

export function advancesRoutes({ db }: RouteContext) {
  const router = Router();

  // ADV-1. The supplier and every legacy advance entry, oldest first (day, then recorded). Receipts are posted to the
  // ledger by link; allocations, reversals, excess and excess returns are history only.
  router.get("/suppliers/:supplierId/advances", requirePermission("payments", "View"), async (req, res) => {
    const id = String(req.params.supplierId);
    if (!isUuid(id)) throw notFound("Supplier");
    const [supplier] = await db.select({ id: suppliers.id, name: suppliers.name, currency: suppliers.currency }).from(suppliers).where(eq(suppliers.id, id));
    if (!supplier) throw notFound("Supplier");
    const entries = await db
      .select({
        id: a.id,
        kind: a.kind,
        amount: a.amount,
        currency: a.currency,
        exchangeRate: a.exchangeRate,
        amountInr: sql<number>`round(${a.amount} * ${a.exchangeRate}, 2)`.mapWith(Number),
        entryDate: a.entryDate,
        /** The order's PO as it is now; a deleted order's as it was written; null on a receipt. */
        po: sql<string | null>`coalesce(${orders.poNumber}, nullif(${a.poNumber}, ''))`,
        paymentId: a.paymentId,
        advanceId: a.advanceId,
        mode: a.mode,
        reference: a.reference,
        notes: a.notes,
        recordedAt: a.createdAt,
        recordedBy: sql<string>`coalesce(${users.name}, '')`,
      })
      .from(a)
      .leftJoin(orders, eq(orders.id, a.orderId))
      .leftJoin(users, eq(users.id, a.createdBy))
      .where(eq(a.supplierId, id))
      .orderBy(asc(a.entryDate), asc(a.createdAt), asc(a.id));
    res.json({ supplier, entries });
  });

  // ADV-5. The active suppliers Record payment offers, by name: currency and rate now, whether the current currency's
  // account is held, the currencies a payment may use (D10) and the ledger balances. payments Enter, as PAY-2.
  // lower(name): the production collation (C.UTF-8) would put a lowercase name after Z. Names are unique in any case.
  router.get("/supplier-advances/suppliers", requirePermission("payments", "Enter"), async (_req, res) => {
    const [list, ledger] = await Promise.all([
      db
        .select({ id: suppliers.id, name: suppliers.name, currency: suppliers.currency, exchangeRate: suppliers.exchangeRate })
        .from(suppliers)
        .where(eq(suppliers.status, "Active"))
        .orderBy(sql`lower(${suppliers.name})`),
      loadLedger(db),
    ]);
    res.json({
      suppliers: list.map((row) => ({
        ...row,
        held: ledger.account(row.id, row.currency)?.held ?? false,
        currencyOptions: currencyOptions(row, ledger),
        balances: balancesOf(ledger, row.id),
      })),
    });
  });

  // ADV-2, ADV-3, ADV-4: retired at the ledger's cutover.
  const gone = () => {
    throw new HttpError(410, "gone", MESSAGES.gone);
  };
  router.post("/suppliers/:supplierId/advances", gone);
  router.delete("/supplier-advances/:id", gone);
  router.post("/orders/:po/advance", gone);

  return router;
}
