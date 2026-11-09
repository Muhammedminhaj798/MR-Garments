import { desc, eq, type SQL, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import type { Database } from "../../db/client";
import { CURRENCIES, DEPOSIT_DIRECTIONS, orders, payments, supplierDeposits, supplierDepositTransactions, suppliers } from "../../db/schema";
import { conflict, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { money } from "../notifications/notify";
import { round2 } from "../orders/orders.routes";
import { isUuid, todayInIndia } from "../stages/common";

// Owner: Agent D (docs/phase2-contracts.md section 3). DEP-1 GET /deposits, SD-1 GET /suppliers/:supplierId/deposits,
// SD-2 POST /suppliers/:supplierId/deposits, SD-3 POST /supplier-deposits/:id/transactions, SD-4 DELETE
// /supplier-deposit-transactions/:id, SD-5 DELETE /supplier-deposits/:id. Supplier deposits are records only and are
// never order payments: nothing here touches `payments`, so order paid/balance and every payment report stay as they
// are. A deposit's settled, pending and status are summed live from its transactions.

// Proposed wording, in the voice of payments.routes.ts MESSAGES.
export const MESSAGES = {
  direction: "Choose Give or Receive.",
  amount: "Enter an amount above 0.",
  currency: "Choose CNY, USD or INR.",
  openedOn: "Enter the date the deposit was agreed.",
  paidOn: "Enter the date of the payment or receipt.",
  future: "The date can't be in the future.",
  mode: "Enter the payment mode.",
  modeTooLong: "Use 100 characters or fewer for the mode.",
  referenceTooLong: "Use 100 characters or fewer for the reference.",
  notesTooLong: "Use 1,000 characters or fewer for the notes.",
  /** SD-3: the amount is more than what is left on the deposit (pending in the deposit's currency, "¥1,234.50"). */
  overSettled: (pending: string) => `Only ${pending} left to settle.`,
  inUse: (n: number) => `This deposit has ${n} transaction${n === 1 ? "" : "s"}, so it can't be deleted.`,
};
const M = MESSAGES;

// Inside numeric(14, 2): at most 2 decimals, up to 999,999,999,999.
const amount = z
  .number({ error: M.amount })
  .min(0.01, M.amount)
  .max(999_999_999_999, M.amount)
  .refine((value) => Number(value.toFixed(2)) === value, M.amount);
const notAfterToday = (missing: string) => z.iso.date({ error: missing }).refine((day) => day <= todayInIndia(), M.future);
const reference = z.string({ error: M.referenceTooLong }).trim().max(100, M.referenceTooLong).default("");
const notes = z.string({ error: M.notesTooLong }).trim().max(1000, M.notesTooLong).default("");

const newDeposit = z.strictObject({
  direction: z.enum(DEPOSIT_DIRECTIONS, { error: M.direction }),
  amount,
  /** Left out: the supplier's currency. */
  currency: z.enum(CURRENCIES, { error: M.currency }).optional(),
  openedOn: notAfterToday(M.openedOn),
  reference,
  notes,
});
const newTransaction = z.strictObject({
  paidOn: notAfterToday(M.paidOn),
  amount,
  mode: z.string({ error: M.mode }).trim().min(1, M.mode).max(100, M.modeTooLong),
  reference,
  notes,
});

const t = supplierDepositTransactions;
// Nested, so the columns keep their table names whatever select they end up in (drizzle drops them from a
// single-table select's top-level columns; orders/closure.ts).
const settledOf = sql`select coalesce(sum(${t.amount}), 0) from ${t} where ${t.depositId} = ${supplierDeposits.id}`;
const countOf = sql`select count(*) from ${t} where ${t.depositId} = ${supplierDeposits.id}`;
/** Settled so far: the deposit's transactions added up. */
const settled = sql<number>`(${settledOf})`.mapWith(Number);
const transactionCount = sql<number>`(${countOf})`.mapWith(Number);

/** The SupplierDepositRow figures before `settled` and `pending` are derived, newest first. */
function depositRows(db: Pick<Database, "select">, where: SQL) {
  return db
    .select({
      id: supplierDeposits.id,
      supplierId: supplierDeposits.supplierId,
      supplier: suppliers.name,
      direction: supplierDeposits.direction,
      currency: supplierDeposits.currency,
      amount: supplierDeposits.amount,
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

/** Give and receive are never netted: one summary line per (currency, direction) that has a deposit, CNY, USD, INR order. */
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
    (a, b) => CURRENCIES.indexOf(a.currency) - CURRENCIES.indexOf(b.currency) || DEPOSIT_DIRECTIONS.indexOf(a.direction) - DEPOSIT_DIRECTIONS.indexOf(b.direction),
  );
}

const transactionColumns = { id: t.id, paidOn: t.paidOn, amount: t.amount, mode: t.mode, reference: t.reference, notes: t.notes };

export function depositsRoutes({ db }: RouteContext) {
  const router = Router();

  /** The deposit's row, locked for the rest of the transaction (SD-3 and SD-4 serialise on it); 404 when unknown. */
  async function lockDeposit(tx: Pick<Database, "select">, id: string) {
    if (!isUuid(id)) throw notFound("Deposit");
    const locked = (await tx.select({ id: supplierDeposits.id }).from(supplierDeposits).where(eq(supplierDeposits.id, id)).for("update"))[0];
    if (!locked) throw notFound("Deposit");
    return toRow((await depositRows(tx, eq(supplierDeposits.id, id)))[0]!);
  }

  // DEP-1. Order deposits (payments of kind Deposit, PAY-1's order), every supplier deposit, and the suppliers to filter by.
  router.get("/deposits", requirePermission("payments", "View"), async (_req, res) => {
    const [orderDeposits, supplierRows, active] = await Promise.all([
      db
        .select({
          id: payments.id,
          orderId: payments.orderId,
          po: orders.poNumber,
          supplierId: orders.supplierId,
          supplier: suppliers.name,
          /** Who was paid: the order's supplier, or a shipping agent (ORD-3 `payeeRole: "agent"`). */
          payee: payments.payee,
          payeeRole: payments.payeeRole,
          currency: orders.currency,
          amountCny: payments.amountCny,
          status: payments.status,
          paidOn: payments.paidOn,
          dueDate: payments.dueDate,
          rateInr: payments.rateInr,
          amountInr: sql<number | null>`case when ${payments.status} = 'paid' then round(${payments.amountCny} * ${payments.rateInr}, 2) end`.mapWith(Number),
          mode: payments.mode,
          reference: payments.reference,
          notes: payments.notes,
        })
        .from(payments)
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
        .where(eq(payments.kind, "Deposit"))
        // PAY-1's order; the id last keeps it stable when payments share a timestamp (one ORD-3 insert).
        .orderBy(desc(sql`coalesce(${payments.paidOn}, ${payments.dueDate})`), desc(payments.createdAt), desc(payments.id)),
      depositRows(db, sql`true`),
      db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(eq(suppliers.status, "Active")),
    ]);
    const supplierDepositList = supplierRows.map(toRow);
    // Active suppliers plus any (inactive) one that still has a deposit of either kind, so every row can be filtered; by name.
    const byId = new Map(active.map((s) => [s.id, s]));
    for (const row of [...orderDeposits, ...supplierDepositList]) byId.set(row.supplierId, { id: row.supplierId, name: row.supplier });
    res.json({
      orderDeposits,
      supplierDeposits: supplierDepositList,
      suppliers: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  // SD-1. One supplier's statement: the supplier, a summary per currency and direction, each deposit with its transactions.
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

  // SD-2. Opens a deposit for a supplier (any known one: a deposit to get back from a supplier no longer used is still
  // a record). The currency defaults to the supplier's.
  router.post("/suppliers/:supplierId/deposits", requirePermission("payments", "Enter"), async (req, res) => {
    const supplierId = String(req.params.supplierId);
    if (!isUuid(supplierId)) throw notFound("Supplier");
    const input = parse(newDeposit, req.body);
    const deposit = await db.transaction(async (tx) => {
      // The supplier's row share-locked (as PAY-2 locks the agent): a delete of the supplier waits for this deposit and
      // then counts it, instead of the insert failing on the foreign key.
      const [supplier] = await tx.select({ currency: suppliers.currency }).from(suppliers).where(eq(suppliers.id, supplierId)).for("share");
      if (!supplier) throw notFound("Supplier");
      const created = (
        await tx
          .insert(supplierDeposits)
          .values({ ...input, supplierId, currency: input.currency ?? supplier.currency, createdBy: req.user!.id })
          .returning({ id: supplierDeposits.id })
      )[0]!;
      return toRow((await depositRows(tx, eq(supplierDeposits.id, created.id)))[0]!);
    });
    res.status(201).json({ deposit });
  });

  // SD-3. A payment (give) or receipt (receive) against the deposit, in its currency. One transaction with the deposit
  // row locked, so two settlements can't both fit in the same pending amount.
  router.post("/supplier-deposits/:id/transactions", requirePermission("payments", "Enter"), async (req, res) => {
    const id = String(req.params.id);
    const input = parse(newTransaction, req.body);
    const result = await db.transaction(async (tx) => {
      const deposit = await lockDeposit(tx, id);
      if (input.amount > deposit.pending) throw validationFailed({ amount: M.overSettled(money(deposit.pending, deposit.currency)) });
      const transaction = (await tx.insert(t).values({ ...input, depositId: id, createdBy: req.user!.id }).returning(transactionColumns))[0]!;
      return { transaction, deposit: toRow((await depositRows(tx, eq(supplierDeposits.id, id)))[0]!) };
    });
    res.status(201).json(result);
  });

  // SD-4. Management only (payments Full). The deposit's figures follow; nothing else refers to a transaction.
  router.delete("/supplier-deposit-transactions/:id", requirePermission("payments", "Full"), async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Transaction");
    const deleted = await db.transaction(async (tx) => {
      const found = (await tx.select({ depositId: t.depositId }).from(t).where(eq(t.id, id)))[0];
      if (!found) throw notFound("Transaction");
      const deposit = await lockDeposit(tx, found.depositId);
      // Read again under the lock: a delete of the same transaction that got there first leaves nothing (404).
      const row = (await tx.select({ amount: t.amount, paidOn: t.paidOn }).from(t).where(eq(t.id, id)))[0];
      if (!row) throw notFound("Transaction");
      await tx.delete(t).where(eq(t.id, id));
      return { ...row, deposit };
    });
    // ponytail: the server log is the deletion record, as PAY-3; an audit table needs a migration.
    console.info(
      `Supplier deposit transaction ${id} (${money(deleted.amount, deleted.deposit.currency)} on ${deleted.paidOn}, ${deleted.deposit.direction} deposit ${deleted.deposit.id} of ${deleted.deposit.supplier}) deleted by user ${req.user!.id}.`,
    );
    res.status(204).end();
  });

  // SD-5. Management only. Only a deposit nothing was settled against goes; one with transactions is refused (409 in_use),
  // so no settlement ever disappears with its deposit (the cascade is for the database's integrity, not a flow).
  router.delete("/supplier-deposits/:id", requirePermission("payments", "Full"), async (req, res) => {
    const id = String(req.params.id);
    const deleted = await db.transaction(async (tx) => {
      const deposit = await lockDeposit(tx, id);
      if (deposit.transactions > 0) throw conflict("in_use", M.inUse(deposit.transactions));
      await tx.delete(supplierDeposits).where(eq(supplierDeposits.id, id));
      return deposit;
    });
    console.info(`Supplier deposit ${id} (${deleted.direction} ${money(deleted.amount, deleted.currency)} of ${deleted.supplier}) deleted by user ${req.user!.id}.`);
    res.status(204).end();
  });

  return router;
}
