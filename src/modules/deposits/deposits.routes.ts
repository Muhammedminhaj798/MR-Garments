import { and, desc, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import { Router } from "express";

import { requirePermission } from "../../auth/current-user";
import type { Database } from "../../db/client";
import { compareCurrencies } from "../../currencies";
import { DEPOSIT_DIRECTIONS, orders, payments, supplierDeposits, supplierDepositTransactions, suppliers } from "../../db/schema";
import { HttpError, notFound } from "../../http/errors";
import type { RouteContext } from "../context";
import { depositMilestone, loadLedger, newestPaymentsFirst, paymentQuery, paymentRow } from "../ledger/ledger";
import { round2 } from "../orders/money";
import { isUuid } from "../stages/common";

// Owner: Agent D (docs/phase2-contracts.md section 3; docs/unified-ledger.md). DEP-1 GET /deposits and SD-1 GET
// /suppliers/:supplierId/deposits. Supplier deposits (give/receive, 0008) are a read-only archive since the unified
// ledger: SD-2..5 answer 410. DEP-1's milestones are the Deposit Required term (D11) against the order's FIFO-settled
// amount; its order deposits are the legacy order-linked Deposit payments, listed as they are.

export const MESSAGES = {
  gone: "Supplier deposits are a read-only archive now.",
};

const t = supplierDepositTransactions;
// Nested, so the columns keep their table names whatever select they end up in (drizzle drops them from a
// single-table select's top-level columns; orders/closure.ts).
const settledOf = sql`select coalesce(sum(${t.amount}), 0) from ${t} where ${t.depositId} = ${supplierDeposits.id}`;
const countOf = sql`select count(*) from ${t} where ${t.depositId} = ${supplierDeposits.id}`;
/** Settled so far: the deposit's transactions added up. */
const settled = sql<number>`(${settledOf})`.mapWith(Number);
const transactionCount = sql<number>`(${countOf})`.mapWith(Number);

/** The SupplierDepositRow figures before `settled` and `pending` are derived, newest first (the order report reads it too). */
export function depositRows(db: Pick<Database, "select">, where: SQL) {
  return db
    .select({
      id: supplierDeposits.id,
      supplierId: supplierDeposits.supplierId,
      supplier: suppliers.name,
      direction: supplierDeposits.direction,
      currency: supplierDeposits.currency,
      /** INR per 1 of `currency` when the deposit was opened (the supplier's rate then); null before 0012 or without a rate. */
      exchangeRate: supplierDeposits.exchangeRate,
      amount: supplierDeposits.amount,
      /** The amount in INR at the deposit's own rate, rounded to 2 decimals as every INR figure; null without a rate. */
      amountInr: sql<number | null>`round(${supplierDeposits.amount} * ${supplierDeposits.exchangeRate}, 2)`.mapWith((value) => (value === null ? null : Number(value))),
      settled,
      openedOn: supplierDeposits.openedOn,
      reference: supplierDeposits.reference,
      notes: supplierDeposits.notes,
      transactions: transactionCount,
    })
    .from(supplierDeposits)
    .innerJoin(suppliers, eq(suppliers.id, supplierDeposits.supplierId))
    .where(where)
    // Newest first: the day it was agreed, then the moment it was recorded.
    .orderBy(desc(supplierDeposits.openedOn), desc(supplierDeposits.createdAt), desc(supplierDeposits.id));
}

type Loaded = Awaited<ReturnType<typeof depositRows>>[number];
/** `pending` = amount - settled; status open (nothing settled), partly settled, or settled (nothing pending). */
export function toRow(row: Loaded) {
  const paid = round2(row.settled);
  const pending = round2(row.amount - paid);
  return { ...row, settled: paid, pending, status: paid === 0 ? ("open" as const) : pending === 0 ? ("settled" as const) : ("partly settled" as const) };
}
export type SupplierDepositRow = ReturnType<typeof toRow>;

/** Give and receive are never netted: one summary line per (currency, direction) that has a deposit, CNY, USD, INR, then the rest by code. */
export function summarise(rows: SupplierDepositRow[]) {
  const lines = new Map<string, { currency: Loaded["currency"]; direction: Loaded["direction"]; amount: number; settled: number; pending: number }>();
  for (const row of rows) {
    const key = `${row.currency} ${row.direction}`;
    const line = lines.get(key) ?? { currency: row.currency, direction: row.direction, amount: 0, settled: 0, pending: 0 };
    line.amount = round2(line.amount + row.amount);
    line.settled = round2(line.settled + row.settled);
    line.pending = round2(line.pending + row.pending);
    lines.set(key, line);
  }
  return [...lines.values()].sort(
    (a, b) => compareCurrencies(a.currency, b.currency) || DEPOSIT_DIRECTIONS.indexOf(a.direction) - DEPOSIT_DIRECTIONS.indexOf(b.direction),
  );
}

const transactionColumns = { id: t.id, paidOn: t.paidOn, amount: t.amount, mode: t.mode, reference: t.reference, notes: t.notes };

export function depositsRoutes({ db }: RouteContext) {
  const router = Router();

  // DEP-1. The Deposit Required milestones (newest first), the legacy order deposits (archive, latest first), every
  // supplier deposit (archive) and the suppliers to filter by.
  router.get("/deposits", requirePermission("payments", "View"), async (_req, res) => {
    const [orderDeposits, requirementRows, supplierRows, active, ledger] = await Promise.all([
      // Order-linked Deposit payments of either payee, voided ones flagged: what New order recorded before the ledger.
      paymentQuery(db, and(eq(payments.kind, "Deposit"), isNotNull(payments.orderId))).orderBy(...newestPaymentsFirst),
      db
        .select({
          orderId: orders.id,
          po: orders.poNumber,
          orderDate: orders.orderDate,
          supplierId: orders.supplierId,
          supplier: suppliers.name,
          currency: orders.currency,
          required: orders.depositRequiredCny,
        })
        .from(orders)
        .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
        .where(isNotNull(orders.depositRequiredCny))
        .orderBy(desc(orders.orderDate), desc(orders.poNumber)),
      depositRows(db, sql`true`),
      db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(eq(suppliers.status, "Active")),
      loadLedger(db),
    ]);
    const supplierDepositList = supplierRows.map(toRow);
    const milestones = requirementRows.map(({ required, ...row }) => {
      const settlement = ledger.order(row.orderId);
      return { ...row, ...depositMilestone(required, settlement), held: settlement?.held ?? false };
    });
    const orderDepositList = orderDeposits.map(paymentRow);
    // Active suppliers plus any (inactive) one that still has a row here, so every row can be filtered; by name.
    const byId = new Map(active.map((s) => [s.id, s]));
    for (const row of [...orderDepositList, ...milestones, ...supplierDepositList]) byId.set(row.supplierId, { id: row.supplierId, name: row.supplier });
    res.json({
      milestones,
      orderDeposits: orderDepositList,
      supplierDeposits: supplierDepositList,
      suppliers: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  // SD-1. One supplier's deposits archive: the supplier, a summary per currency and direction, each deposit with its transactions.
  router.get("/suppliers/:supplierId/deposits", requirePermission("payments", "View"), async (req, res) => {
    const supplierId = String(req.params.supplierId);
    if (!isUuid(supplierId)) throw notFound("Supplier");
    const [supplier] = await db
      .select({
        id: suppliers.id,
        name: suppliers.name,
        contactPerson: suppliers.contactPerson,
        phone: suppliers.phone,
        city: suppliers.city,
        currency: suppliers.currency,
        exchangeRate: suppliers.exchangeRate,
        status: suppliers.status,
      })
      .from(suppliers)
      .where(eq(suppliers.id, supplierId));
    if (!supplier) throw notFound("Supplier");
    const deposits = (await depositRows(db, eq(supplierDeposits.supplierId, supplierId))).map(toRow);
    const transactions = deposits.length
      ? await db
          .select({ ...transactionColumns, depositId: t.depositId })
          .from(t)
          .innerJoin(supplierDeposits, eq(supplierDeposits.id, t.depositId))
          .where(eq(supplierDeposits.supplierId, supplierId))
          .orderBy(desc(t.paidOn), desc(t.createdAt), desc(t.id))
      : [];
    res.json({
      supplier,
      summary: summarise(deposits),
      deposits: deposits.map((deposit) => ({
        ...deposit,
        transactions: transactions.filter((row) => row.depositId === deposit.id).map(({ depositId: _depositId, ...row }) => row),
      })),
    });
  });

  // SD-2, SD-3, SD-4, SD-5: retired at the ledger's cutover (refunds and corrections are Management adjustments, LED-3).
  const gone = () => {
    throw new HttpError(410, "gone", MESSAGES.gone);
  };
  router.post("/suppliers/:supplierId/deposits", gone);
  router.post("/supplier-deposits/:id/transactions", gone);
  router.delete("/supplier-deposit-transactions/:id", gone);
  router.delete("/supplier-deposits/:id", gone);

  return router;
}
