import { and, asc, countDistinct, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { currencyCode } from "../../currencies";
import { orders, supplierAdvanceEntries as a, suppliers } from "../../db/schema";
import { conflict, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { money } from "../notifications/notify";
import { balanceOf, orderMoney } from "../orders/money";
import { byPo, rateProblem } from "../orders/orders.routes";
import { isUuid, todayInIndia } from "../stages/common";
import { advanceAccount, lockAdvances, settleAdvance } from "./advances";

// Owner: supplier advance (docs/supplier-advance.md). ADV-1 GET /suppliers/:supplierId/advances, ADV-2 POST
// /suppliers/:supplierId/advances, ADV-3 DELETE /supplier-advances/:id, ADV-4 POST /orders/:po/advance. An advance is
// money the client already paid the supplier before any order; it is recorded here, never moved. New orders draw on it
// by themselves (ORD-3, ORD-5, ORD-6, PAY-2 through settleAdvance); an existing order draws when ADV-4 is asked to.
// Nothing here touches `payments` or the supplier deposits.

export const MESSAGES = {
  amount: "Enter an amount above 0, with at most 2 decimals.",
  currency: "Choose a supported currency code (ISO 4217, such as CNY, USD or AED).",
  supplierCurrency: (currency: string) => `This supplier's advances are in ${currency}.`,
  paidOn: "Enter the date the advance was paid.",
  future: "The date can't be in the future.",
  rateInr: "Enter an INR rate above 0.",
  mode: "Enter the payment mode.",
  modeTooLong: "Use 100 characters or fewer for the mode.",
  referenceTooLong: "Use 100 characters or fewer for the reference.",
  notesTooLong: "Use 1,000 characters or fewer for the notes.",
  /** ADV-3: only a receipt nothing was drawn from may go; allocations and reversals are the orders' history. */
  applied: (n: number) => `This advance was applied to ${n} order${n === 1 ? "" : "s"}, so it can't be deleted.`,
  orderEntry: "Order allocations and reversals are kept as the order's history and can't be deleted.",
};
const M = MESSAGES;

const newAdvance = z.strictObject({
  // Inside numeric(14, 2): at most 2 decimals, up to 999,999,999,999.
  amount: z
    .number({ error: M.amount })
    .min(0.01, M.amount)
    .max(999_999_999_999, M.amount)
    .refine((value) => Number(value.toFixed(2)) === value, M.amount),
  /** Left out: the supplier's currency; given, it must be the supplier's. */
  currency: currencyCode(M.currency).optional(),
  paidOn: z.iso.date({ error: M.paidOn }).refine((day) => day <= todayInIndia(), M.future),
  /** INR per 1 of the currency, typed as on a payment (the form offers the supplier's rate); none for INR. */
  rateInr: z.number({ error: M.rateInr }).min(0.0001, M.rateInr).max(99_999_999, M.rateInr).optional(),
  mode: z.string({ error: M.mode }).trim().min(1, M.mode).max(100, M.modeTooLong),
  reference: z.string({ error: M.referenceTooLong }).trim().max(100, M.referenceTooLong).default(""),
  notes: z.string({ error: M.notesTooLong }).trim().max(1000, M.notesTooLong).default(""),
});

export function advancesRoutes({ db }: RouteContext) {
  const router = Router();

  async function supplierOf(id: string) {
    if (!isUuid(id)) throw notFound("Supplier");
    const [supplier] = await db
      .select({ id: suppliers.id, name: suppliers.name, currency: suppliers.currency, exchangeRate: suppliers.exchangeRate, status: suppliers.status })
      .from(suppliers)
      .where(eq(suppliers.id, id));
    if (!supplier) throw notFound("Supplier");
    return supplier;
  }

  // ADV-1. The supplier (with its rate now, the Add advance default), its advance account and its orders still owing
  // the supplier (oldest first): the ones ADV-4 can apply an advance to.
  router.get("/suppliers/:supplierId/advances", requirePermission("payments", "View"), async (req, res) => {
    const supplier = await supplierOf(String(req.params.supplierId));
    const [account, owing] = await Promise.all([
      advanceAccount(db, supplier.id),
      db
        .select({ po: orders.poNumber, orderDate: orders.orderDate, currency: orders.currency, orderValueCny: orderMoney.orderValueCny, paidCny: orderMoney.supplierPaidCny, advanceCny: orderMoney.advanceCny })
        .from(orders)
        .where(eq(orders.supplierId, supplier.id))
        .orderBy(asc(orders.orderDate), asc(orders.createdAt), asc(orders.id)),
    ]);
    const openOrders = owing.map((row) => ({ ...row, balanceCny: balanceOf(row) })).filter((row) => row.balanceCny > 0);
    res.json({ supplier, ...account, openOrders });
  });

  // ADV-2. A receipt in the supplier's currency (another is 422), at the rate typed. Any known supplier, as SD-2: money
  // already with a supplier no longer used is still a record. No order is chosen: orders draw on it when created.
  router.post("/suppliers/:supplierId/advances", requirePermission("payments", "Enter"), async (req, res) => {
    const supplierId = String(req.params.supplierId);
    if (!isUuid(supplierId)) throw notFound("Supplier");
    const input = parse(newAdvance, req.body);
    const entry = await db.transaction(async (tx) => {
      // Share-locked as SD-2 reads it: a currency change waits for this advance, so it is in the currency it was checked against.
      const [supplier] = await tx.select({ currency: suppliers.currency }).from(suppliers).where(eq(suppliers.id, supplierId)).for("share");
      if (!supplier) throw notFound("Supplier");
      const problems: Record<string, string> = {};
      if (input.currency !== undefined && input.currency !== supplier.currency) problems.currency = M.supplierCurrency(supplier.currency);
      const rate = rateProblem(supplier.currency, input.rateInr, M.rateInr);
      if (rate) problems.rateInr = rate;
      if (Object.keys(problems).length > 0) throw validationFailed(problems);
      await lockAdvances(tx, supplierId);
      return (
        await tx
          .insert(a)
          .values({
            supplierId,
            kind: "receipt",
            amount: input.amount,
            currency: supplier.currency,
            exchangeRate: input.rateInr ?? 1,
            entryDate: input.paidOn,
            mode: input.mode,
            reference: input.reference,
            notes: input.notes,
            createdBy: req.user!.id,
          })
          .returning({ id: a.id, amount: a.amount, currency: a.currency, exchangeRate: a.exchangeRate, entryDate: a.entryDate })
      )[0]!;
    });
    res.status(201).json({ advance: entry, ...(await advanceAccount(db, supplierId)) });
  });

  // ADV-3. Management only (payments Full): a receipt recorded by mistake, while no order has drawn on it. Allocations
  // and reversals belong to orders and stay. One transaction under the supplier's advance lock, so no order can start
  // drawing on the receipt between the check and the delete.
  router.delete("/supplier-advances/:id", requirePermission("payments", "Full"), async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Advance");
    const deleted = await db.transaction(async (tx) => {
      const found = (await tx.select({ supplierId: a.supplierId }).from(a).where(eq(a.id, id)))[0];
      if (!found) throw notFound("Advance");
      await lockAdvances(tx, found.supplierId);
      const row = (await tx.select({ kind: a.kind, amount: a.amount, currency: a.currency, entryDate: a.entryDate, supplier: suppliers.name }).from(a).innerJoin(suppliers, eq(suppliers.id, a.supplierId)).where(eq(a.id, id)))[0];
      if (!row) throw notFound("Advance");
      if (row.kind !== "receipt") throw conflict("order_entry", M.orderEntry);
      // Orders by id (a renumbered order's entries may carry two numbers); a deleted one by its stored number.
      const n = (await tx.select({ n: countDistinct(sql`coalesce(${a.orderId}::text, 'deleted ' || lower(${a.poNumber}))`) }).from(a).where(and(eq(a.advanceId, id), eq(a.kind, "allocation"))))[0]!.n;
      if (n > 0) throw conflict("in_use", M.applied(n));
      await tx.delete(a).where(eq(a.id, id));
      return row;
    });
    // ponytail: the server log is the deletion record, as PAY-3 and SD-4; an audit table needs a migration.
    console.info(`Supplier advance ${id} (${money(deleted.amount, deleted.currency)} paid ${deleted.entryDate} to ${deleted.supplier}) deleted by user ${req.user!.id}.`);
    res.status(204).end();
  });

  // ADV-4. An advance recorded after the order was placed: applies the supplier's available advance (the order's
  // currency, oldest receipt first) up to what the order still owes after direct supplier payments. The order row is
  // locked first, as ORD-5, ORD-6 and PAY-2 lock it; settleAdvance then takes the supplier's advance lock. At the target
  // nothing is written, so a repeat or a double click applies nothing twice (changeCny 0).
  router.post("/orders/:po/advance", requirePermission("payments", "Enter"), async (req, res) => {
    const advance = await db.transaction(async (tx) => {
      const row = (
        await tx.select({ id: orders.id, po: orders.poNumber, supplierId: orders.supplierId, currency: orders.currency }).from(orders).where(byPo(String(req.params.po))).for("update")
      )[0];
      if (!row) throw notFound("Order");
      return settleAdvance(tx, row, req.user!.id);
    });
    res.json({ advance });
  });

  return router;
}
