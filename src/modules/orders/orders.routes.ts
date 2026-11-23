import { and, asc, desc, eq, gt, inArray, lte, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { currencyCode } from "../../currencies";
import type { Database } from "../../db/client";
import {
  type Currency,
  items,
  orderLines,
  orders,
  PAYEE_ROLES,
  payments,
  receiptLines,
  shippingAgents,
  suppliers,
  TERMS,
  units,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import { conflict, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import { atLeast, effectiveAccess } from "../../permissions/matrix";
import type { RouteContext } from "../context";
import { ledgerOverview } from "../ledger/ledger.routes";
import { guardFinalSettlements } from "../costs/landed-cost";
import {
  assertLedgerLive,
  balancesOf,
  heldAccounts,
  isHeld,
  linePoValue,
  lineValue,
  loadLedger,
  lockAccount,
  MESSAGES as LEDGER,
  newestPaymentsFirst,
  paymentQuery,
  paymentRow,
  postOrderDebit,
} from "../ledger/ledger";
import { orderClosed, orderClosedOn } from "./closure";
import { hiddenSettlement, orderMoney, orderSettlement, round2 } from "./money";

// Owner: BE-orders. ORD-1 GET /orders, ORD-2 GET /orders/options, ORD-3 POST /orders, CAL-1 GET /deliveries,
// PAY-1 GET /payments (docs/live-screens-contracts.md; supplier money per docs/unified-ledger.md). An order's value is
// posted to its supplier's ledger account when it is created (ORD-3); its settled and outstanding amounts are the
// ledger's FIFO projection. `stocked`, `closed` and `closedOn` (docs/phase2-contracts.md section 1) come from
// ./closure.ts. Money is in the order's `currency` (the *Cny names stay for compatibility); `rateInr` is INR per 1 of it.

export const MESSAGES = {
  supplier: "Choose a supplier from the list.",
  orderDate: "Enter the order date.",
  deliveryDate: "Enter the delivery date.",
  deliveryBeforeOrder: "The delivery date can't be before the order date.", // contract
  lines: "Add at least one item.",
  tooManyLines: "An order can have at most 50 items.",
  item: "Choose an item from the list.",
  quantity: "Enter a whole quantity of at least 1.",
  rate: "Enter a rate of 0 or more.",
  tooManyDeposits: "An order can have at most 10 deposits.",
  payee: "Choose who the deposit was paid to.",
  amount: "Enter a deposit amount above 0.",
  paidOn: "Enter the date the deposit was paid.",
  rateInr: "Enter the INR rate.",
  rateForInr: "Leave the rate empty for an INR order.",
  mode: "Enter the payment mode.",
  /** ORD-3 deposits are shipping-agent payments only (docs/unified-ledger.md): supplier money goes through PAY-2. */
  supplierDeposit: "Record supplier payments with Record payment.",
  currency: "Choose a supported currency code (ISO 4217, such as CNY, USD or AED).",
  /** The order is in its supplier's currency (docs/supplier-currency.md); another one is refused. */
  supplierCurrency: (currency: string) => `This supplier's orders are in ${currency}.`,
  po: "Enter the PO number.",
  poTooLong: "Use 50 characters or fewer.",
  poTaken: "This PO number is already used by another order.",
  depositRequired: "Enter the deposit the supplier asked for: above 0, with at most 2 decimals.",
  referenceTooLong: "Use 100 characters or fewer for the reference.",
  notesTooLong: "Use 1,000 characters or fewer for the notes.",
  /** The order's container terms (0015, docs/order-container-terms.md). */
  terms: "Choose the container terms: FOB or CNF.",
  /**
   * Pre-release audit M8: an order that comes first in FIFO order takes the payments of the orders after it, so an
   * order date may not change the settlement of an order whose landed cost is final (costs/landed-cost.ts).
   */
  finalSettled: (pos: string[]) =>
    `This order date comes before ${pos.join(", ")}, whose landed cost is already final: the order would take the payments that settle ${pos.length > 1 ? "them" : "it"}. Choose a later order date.`,
};
const M = MESSAGES;
/** The PO number column is text; this keeps a typed one readable in lists and URLs. */
export const PO_MAX_LENGTH = 50;

// Upper bounds keep values inside the numeric/integer columns, so an absurd number is a 422, not a 500.
export const line = z.strictObject({
  itemId: z.uuid({ error: M.item }),
  quantity: z.number({ error: M.quantity }).int(M.quantity).min(1, M.quantity).max(2_147_483_647, M.quantity),
  rateCny: z.number({ error: M.rate }).min(0, M.rate).max(99_999_999, M.rate),
});
/** 1-50 lines, shared by ORD-3 create and ORD-5 edit. */
export const lineList = <T extends z.ZodType>(entry: T) => z.array(entry, { error: M.lines }).min(1, M.lines).max(50, M.tooManyLines);
const deposit = z.strictObject({
  payee: z.string({ error: M.payee }).trim().min(1, M.payee),
  payeeRole: z.enum(PAYEE_ROLES, { error: M.payee }),
  amountCny: z.number({ error: M.amount }).min(0.01, M.amount).max(999_999_999_999, M.amount),
  paidOn: z.iso.date({ error: M.paidOn }),
  rateInr: z.number({ error: M.rateInr }).min(0.0001, M.rateInr).max(99_999_999, M.rateInr).optional(),
  mode: z.string({ error: M.mode }).trim().min(1, M.mode),
  // Transaction or receipt number and notes (0008); left out by an older frontend, both are "".
  reference: z.string({ error: M.referenceTooLong }).trim().max(100, M.referenceTooLong).default(""),
  notes: z.string({ error: M.notesTooLong }).trim().max(1000, M.notesTooLong).default(""),
});
/** 0.01 to 999,999,999,999 with at most 2 decimals (shared with ORD-5). */
export const depositRequired = z
  .number({ error: M.depositRequired })
  .min(0.01, M.depositRequired)
  .max(999_999_999_999, M.depositRequired)
  .refine((value) => Number(value.toFixed(2)) === value, M.depositRequired);
const newOrder = z.strictObject({
  // The form's PO number (the offered next one, or what the user changed it to) in any format (VM-11340, MR/2026/001),
  // kept as typed apart from the surrounding spaces. Left out, the server assigns the next PO-<number>.
  po: z.string({ error: M.po }).trim().min(1, M.po).max(PO_MAX_LENGTH, M.poTooLong).optional(),
  supplierId: z.uuid({ error: M.supplier }),
  // The supplier's currency (any code of the currency master): left out, it is filled in; given, it must match (checkRules).
  currency: currencyCode(M.currency).optional(),
  orderDate: z.iso.date({ error: M.orderDate }),
  deliveryDate: z.iso.date({ error: M.deliveryDate }),
  lines: lineList(line),
  deposits: z.array(deposit).max(10, M.tooManyDeposits).default([]),
  // The deposit the supplier asked for (0009), in the order's currency; left out, none was agreed.
  depositRequiredCny: depositRequired.optional(),
  // The container terms (0015): FOB or CNF; containers loading this order take them (CON-3). Left out: not set yet.
  terms: z.enum(TERMS, { error: M.terms }).optional(),
});
type NewOrder = z.infer<typeof newOrder>;

/** An item's unit as the screens show it: its unit's symbol ("pcs", "m"), or the unit's name when it has none. */
// Nested, so the columns keep their table names (drizzle drops them from a single-table select's top-level columns).
const symbolOf = sql`select ${units.symbol} from ${units} where ${units.name} = ${items.countedIn}`;
export const unitSymbol = sql<string>`coalesce(nullif((${symbolOf}), ''), ${items.countedIn})`;
export { round2 };

/**
 * What is wrong with a paid payment's INR rate for an order in `currency`, or null. An INR order takes no rate (it is
 * stored as 1, so INR = the amount); every other currency needs the rate typed for that payment. Never a guessed rate.
 */
export const rateProblem = (currency: Currency, rateInr: number | undefined, missing: string) =>
  currency === "INR" ? (rateInr === undefined || rateInr === 1 ? null : M.rateForInr) : rateInr === undefined ? missing : null;

// PO numbers: "PO-" + (highest number + 1); the first is PO-2050. The form may send its own instead (ORD-3 `po`), in
// any format: only PO-<number> ones (any letter case, up to 15 digits) count towards the next number.
const FIRST_PO = 2050;
export const poValue = sql`substring(upper(${orders.poNumber}) from '^PO-([0-9]{1,15})$')::bigint`;
/** The order with this PO number in any letter case (the unique index is on lower(po_number)). */
export const byPo = (po: string) => sql`lower(${orders.poNumber}) = lower(${po})`;
async function nextPo(db: Pick<Database, "select">) {
  const rows = await db.select({ highest: sql<number | null>`max(${poValue})`.mapWith(Number) }).from(orders);
  return `PO-${Math.max(rows[0]?.highest ?? 0, FIRST_PO - 1) + 1}`;
}

/**
 * Two simultaneous creates can pick the same number; the unique index refuses the second, which then retries. ORD-5
 * renumbering an order meets the same index, so two edits to one number can't both land.
 */
export function isPoTaken(error: unknown) {
  type PgError = { code?: string; constraint?: string; cause?: PgError };
  const pg = (error as PgError)?.cause ?? (error as PgError);
  return pg?.code === "23505" && pg.constraint === "orders_po_number_unique";
}

/** Rules that need the database, reported together (E1). */
async function checkRules(db: Database, input: NewOrder) {
  const problems: Record<string, string> = {};
  if (input.po && (await db.select({ id: orders.id }).from(orders).where(byPo(input.po))).length > 0) problems.po = M.poTaken;
  if (input.deliveryDate < input.orderDate) problems.deliveryDate = M.deliveryBeforeOrder;
  const [supplier] = await db
    .select({ id: suppliers.id, currency: suppliers.currency, exchangeRate: suppliers.exchangeRate })
    .from(suppliers)
    .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.status, "Active")));
  if (!supplier) problems.supplierId = M.supplier;
  // The order is in the supplier's currency (docs/supplier-currency.md): another one is refused, left out it is filled in.
  else if (input.currency !== undefined && input.currency !== supplier.currency) problems.currency = M.supplierCurrency(supplier.currency);
  const currency: Currency = supplier?.currency ?? input.currency ?? "CNY";
  const itemIds = [...new Set(input.lines.map((entry) => entry.itemId))];
  const active = await db
    .select({ id: items.id })
    .from(items)
    .where(and(inArray(items.id, itemIds), eq(items.status, "Active")));
  if (active.length < itemIds.length) problems.lines = M.item;
  const rate = input.deposits.map((entry) => rateProblem(currency, entry.rateInr, M.rateInr)).find(Boolean);
  if (rate) problems.deposits = rate;
  if (input.deposits.some((entry) => entry.payeeRole === "supplier")) problems.deposits = M.supplierDeposit;
  if (Object.keys(problems).length > 0) throw validationFailed(problems);
  /** The order's currency (the deposits' rate rule was checked for it); the rate is read again, locked, when the order is written. */
  return { currency };
}

// The main line (position 0) gives the item, quantity and received figures the lists show; the money comes from
// ./money.ts (the one place the payee rules live).
export const main = alias(orderLines, "main_line");
export const orderColumns = {
  id: orders.id,
  po: orders.poNumber,
  orderDate: orders.orderDate,
  deliveryDate: orders.deliveryDate,
  currency: orders.currency,
  /** INR per 1 of `currency` when the order was placed (0012); null for older orders or a supplier without a rate then. */
  exchangeRate: orders.exchangeRate,
  /** orderValueCny (received quantity × rate) at the order's own rate, rounded in SQL as the payments' INR is; null without a rate. */
  orderValueInr: sql<number | null>`round(${orderMoney.orderValueCny} * ${orders.exchangeRate}, 2)`.mapWith((value) => (value === null ? null : Number(value))),
  /** The supplier's rate now (null while not set): a new payment's default rate, never the order's. */
  supplierRate: suppliers.exchangeRate,
  stage: orders.stage,
  supplierId: suppliers.id,
  supplierName: suppliers.name,
  item: items.name,
  unit: unitSymbol,
  quantity: main.quantity,
  received: sql<number>`(select coalesce(sum(${receiptLines.quantity}), 0) from ${receiptLines} where ${receiptLines.orderLineId} = ${main.id})`.mapWith(Number),
  /** The main line's quantity on stocked warehouse receipts. */
  stocked: sql<number>`(select coalesce(sum(${warehouseReceiptLines.quantity}), 0) from ${warehouseReceiptLines}
    join ${warehouseReceipts} on ${warehouseReceipts.id} = ${warehouseReceiptLines.receiptId} and ${warehouseReceipts.status} = 'stocked'
    where ${warehouseReceiptLines.orderLineId} = ${main.id})`.mapWith(Number),
  closed: orderClosed,
  closedOn: orderClosedOn,
  ...orderMoney,
  /** The deposit the supplier asked for (0009); null when none. depositMilestone() compares the FIFO-settled amount with it. */
  depositRequiredCny: orders.depositRequiredCny,
  /** The order's container terms (0015): FOB or CNF; null until set (orders from before 0015). */
  terms: orders.terms,
};
// A typed PO without a number sorts after the numbered ones of its day, then by its text.
export const newestFirst = [desc(orders.orderDate), sql`${poValue} desc nulls last`, desc(orders.poNumber)];

// ponytail: per-order subqueries over every order; add paging or a stage filter when orders reach the thousands.
export function orderRows(db: Database, orderBy: SQL[], where?: SQL) {
  return db
    .select(orderColumns)
    .from(orders)
    .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
    .innerJoin(main, and(eq(main.orderId, orders.id), eq(main.position, 0)))
    .innerJoin(items, eq(items.id, main.itemId))
    .where(where)
    .orderBy(...orderBy);
}

export function ordersRoutes({ db }: RouteContext) {
  const router = Router();

  // ORD-1. Order date, then PO, newest first. The money (the ledger's projection, agent payments) only with payments
  // View, as ORD-4's sections; otherwise those fields are null and the ledger is never read.
  router.get("/orders", requirePermission("ordersView", "View"), async (req, res) => {
    const money = atLeast(effectiveAccess(req.user!.role, req.user!.stages, "payments"), "View");
    const [rows, ledger, held] = await Promise.all([orderRows(db, newestFirst), money ? loadLedger(db) : null, money ? null : heldAccounts(db)]);
    res.json(
      rows.map((row) => ({
        id: row.id,
        po: row.po,
        orderDate: row.orderDate,
        deliveryDate: row.deliveryDate,
        stage: row.stage,
        supplier: { id: row.supplierId, name: row.supplierName },
        currency: row.currency,
        exchangeRate: row.exchangeRate,
        terms: row.terms,
        item: row.item,
        quantity: row.quantity,
        unit: row.unit,
        received: row.received,
        stocked: row.stocked,
        closed: row.closed,
        closedOn: row.closedOn,
        /** Received quantity × rate; poValueCny ordered quantity × rate (reference). */
        orderValueCny: row.orderValueCny,
        poValueCny: row.poValueCny,
        ...(ledger ? orderSettlement(ledger.order(row.id), row) : hiddenSettlement(held!.has(`${row.supplierId} ${row.currency}`), row.depositRequiredCny)),
      })),
    );
  });

  // ORD-7 (docs/report-downloads.md): every line of every order, ORD-1's order then position, for the Orders report's
  // item sheet. `rateCny` is the rate saved on the line, never the item's price now; received (China) and stocked
  // (India warehouse) are per line. Its own path, as /orders/:po would take "lines" for a PO number.
  router.get("/order-lines", requirePermission("ordersView", "View"), async (_req, res) => {
    const ofLine = sql`${receiptLines.orderLineId} = ${orderLines.id}`;
    const stockedOfLine = sql`${warehouseReceiptLines.orderLineId} = ${orderLines.id}`;
    const rows = await db
      .select({
        orderId: orders.id,
        po: orders.poNumber,
        currency: orders.currency,
        position: orderLines.position,
        item: items.name,
        unit: unitSymbol,
        quantity: orderLines.quantity,
        rateCny: orderLines.rateCny,
        /** Received quantity × rate (the line's value); poValueCny is quantity × rate, for reference. */
        valueCny: lineValue,
        poValueCny: linePoValue,
        received: sql<number>`(select coalesce(sum(${receiptLines.quantity}), 0) from ${receiptLines} where ${ofLine})`.mapWith(Number),
        stocked: sql<number>`(select coalesce(sum(${warehouseReceiptLines.quantity}), 0) from ${warehouseReceiptLines}
          join ${warehouseReceipts} on ${warehouseReceipts.id} = ${warehouseReceiptLines.receiptId} and ${warehouseReceipts.status} = 'stocked'
          where ${stockedOfLine})`.mapWith(Number),
      })
      .from(orderLines)
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .innerJoin(items, eq(items.id, orderLines.itemId))
      .orderBy(...newestFirst, asc(orderLines.position));
    res.json(rows);
  });

  // ORD-2. What the new-order form offers; readable by anyone who can open Orders (no Settings access needed).
  router.get("/orders/options", requirePermission("ordersView", "View"), async (req, res) => {
    const [po, supplierRows, itemRows, agents] = await Promise.all([
      nextPo(db),
      db
        .select({
          id: suppliers.id,
          name: suppliers.name,
          contactPerson: suppliers.contactPerson,
          phone: suppliers.phone,
          city: suppliers.city,
          currency: suppliers.currency,
          /** The supplier's rate now, snapshotted on the order placed (null while not set: the form says so). */
          exchangeRate: suppliers.exchangeRate,
        })
        .from(suppliers)
        .where(eq(suppliers.status, "Active"))
        .orderBy(asc(suppliers.createdAt), asc(suppliers.name)),
      db
        // `price`: the item's default rate per unit, which the form offers for the line (null when none is set).
        .select({ id: items.id, name: items.name, unit: unitSymbol, price: items.price })
        .from(items)
        .where(eq(items.status, "Active"))
        .orderBy(asc(items.createdAt), asc(items.name)),
      db
        .select({ id: shippingAgents.id, name: shippingAgents.name })
        .from(shippingAgents)
        .where(eq(shippingAgents.status, "Active"))
        .orderBy(asc(shippingAgents.createdAt), asc(shippingAgents.name)),
    ]);
    // Each supplier's ledger balances (docs/unified-ledger.md), and whether its current currency's account is held
    // (ORD-3 refuses an order into a held account).
    const ledger = await loadLedger(db, { supplierIds: supplierRows.map((row) => row.id) });
    // Money, so only with payments View (as ORD-1's figures); `held` is not money (ORD-3 refuses a held account).
    const canPay = atLeast(effectiveAccess(req.user!.role, req.user!.stages, "payments"), "View");
    res.json({
      nextPo: po,
      suppliers: supplierRows.map((row) => ({ ...row, held: ledger.account(row.id, row.currency)?.held ?? false, ledgerBalance: canPay ? balancesOf(ledger, row.id) : null })),
      items: itemRows,
      agents,
    });
  });

  // ORD-3. The order, its lines, its agent deposits and its debit in the supplier's ledger in one transaction; the PO
  // number is the form's or assigned inside it. Refused while the ledger is in maintenance (503) or the supplier's
  // account in the order's currency is held (409), and when its date would change the settlement of an order whose
  // landed cost is final (422 orderDate, M8).
  router.post("/orders", requirePermission("ordersEdit", "Enter"), async (req, res) => {
    const input = parse(newOrder, req.body);
    const money = await checkRules(db, input);
    const userId = req.user!.id;
    for (let attempt = 1; ; attempt++) {
      try {
        const order = await db.transaction(async (tx) => {
          await assertLedgerLive(tx);
          // One order at a time takes a PO number, so a burst of creates can't all pick the same one (audit M1).
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext('orders.po_number'))`);
          // The supplier's row share-locked (as SD-2 reads it): a rate or currency edit waits for this order, so the
          // snapshot is the rate the supplier has when the order is written, never one already superseded.
          const [supplier] = await tx.select({ currency: suppliers.currency, exchangeRate: suppliers.exchangeRate }).from(suppliers).where(eq(suppliers.id, input.supplierId)).for("share");
          if (!supplier || supplier.currency !== money.currency) throw validationFailed({ currency: M.supplierCurrency(supplier?.currency ?? money.currency) });
          if (await isHeld(tx, input.supplierId, supplier.currency)) throw conflict("account_held", LEDGER.held);
          // M8: with the account locked, the final orders' settlements as they stand; checked again once posted. Only an
          // order dated after this one is settled after it, and only a stage-6 order can be final: without one, skipped.
          await lockAccount(tx, input.supplierId, supplier.currency);
          const later = await tx
            .select({ id: orders.id })
            .from(orders)
            .where(and(eq(orders.supplierId, input.supplierId), eq(orders.currency, supplier.currency), eq(orders.stage, 6), gt(orders.orderDate, input.orderDate)))
            .limit(1);
          const finalChanged = later.length > 0 ? await guardFinalSettlements(tx, input.supplierId, supplier.currency) : null;
          const exchangeRate = supplier.currency === "INR" ? 1 : supplier.exchangeRate;
          const created = await tx
            .insert(orders)
            .values({
              poNumber: input.po ?? (await nextPo(tx)),
              supplierId: input.supplierId,
              orderDate: input.orderDate,
              deliveryDate: input.deliveryDate,
              currency: supplier.currency,
              exchangeRate,
              depositRequiredCny: input.depositRequiredCny ?? null,
              terms: input.terms ?? null,
              createdBy: userId,
            })
            .returning({ id: orders.id, po: orders.poNumber, orderDate: orders.orderDate });
          const orderId = created[0]!.id;
          await tx.insert(orderLines).values(input.lines.map((entry, position) => ({ ...entry, orderId, position })));
          // An agent deposit keeps the agent's name, not its id: it must name an active agent (any letter case), read
          // with the row share-locked, so a rename or delete of that agent waits for this order and then counts it.
          for (const payee of new Set(input.deposits.filter((entry) => entry.payeeRole === "agent").map((entry) => entry.payee))) {
            const agent = await tx
              .select({ id: shippingAgents.id })
              .from(shippingAgents)
              .where(and(eq(shippingAgents.status, "Active"), sql`lower(${shippingAgents.name}) = lower(${payee})`))
              .for("share");
            if (agent.length === 0) throw validationFailed({ deposits: M.payee });
          }
          // Agent deposits only (checkRules refused supplier ones): sea freight, never posted to the ledger.
          if (input.deposits.length > 0) {
            await tx
              .insert(payments)
              .values(input.deposits.map((entry) => ({ ...entry, rateInr: entry.rateInr ?? 1, orderId, kind: "Deposit", status: "paid", createdBy: userId })));
          }
          // The order's value, debited to the supplier's account in the order's currency at its rate snapshot, once.
          const posted = await postOrderDebit(
            tx,
            { id: orderId, po: created[0]!.po, supplierId: input.supplierId, currency: supplier.currency, exchangeRate, orderDate: created[0]!.orderDate },
            userId,
          );
          const reopened = finalChanged ? await finalChanged() : [];
          if (reopened.length > 0) throw validationFailed({ orderDate: M.finalSettled(reopened) });
          return {
            order: { id: orderId, po: created[0]!.po },
            ledger: { supplierId: input.supplierId, currency: supplier.currency, debitCny: -posted.changeCny, balanceBefore: posted.balanceBefore, balanceAfter: posted.balanceAfter },
          };
        });
        // The account's balances are money: only with payments View (ORD-3 itself needs ordersEdit Enter).
        const canPay = atLeast(effectiveAccess(req.user!.role, req.user!.stages, "payments"), "View");
        res.status(201).json(canPay ? order : { ...order, ledger: null });
        return;
      } catch (error) {
        if (!isPoTaken(error)) throw error;
        // A number the user typed is theirs to change (another order took it meanwhile); a generated one is retried.
        if (input.po) throw validationFailed({ po: M.poTaken });
        if (attempt >= 5) throw error;
      }
    }
  });

  // CAL-1. Orders at stage 1-2, due date oldest first. `quantity` and `received` are the main line's; `fullyReceived`
  // says every line has received >= its quantity, from one grouped query beside the rows (not one per order).
  router.get("/deliveries", requirePermission("calendar", "View"), async (_req, res) => {
    const lineReceived = sql`(select coalesce(sum(${receiptLines.quantity}), 0) from ${receiptLines} where ${receiptLines.orderLineId} = ${orderLines.id})`;
    const [rows, received] = await Promise.all([
      orderRows(db, [asc(orders.deliveryDate), asc(poValue), asc(orders.poNumber)], lte(orders.stage, 2)),
      db
        .select({ orderId: orderLines.orderId, full: sql<boolean>`bool_and(${lineReceived} >= ${orderLines.quantity})` })
        .from(orderLines)
        .innerJoin(orders, eq(orders.id, orderLines.orderId))
        .where(lte(orders.stage, 2))
        .groupBy(orderLines.orderId),
    ]);
    const fullyReceived = new Set(received.filter((order) => order.full).map((order) => order.orderId));
    res.json(
      rows.map((row) => ({
        orderId: row.id,
        po: row.po,
        supplier: row.supplierName,
        item: row.item,
        quantity: row.quantity,
        unit: row.unit,
        received: row.received,
        due: row.deliveryDate,
        fullyReceived: fullyReceived.has(row.id),
      })),
    );
  });

  // PAY-1. Every order's figures (newest first: the ledger's projection, its agent payments and next due), every
  // payment record (orderless and voided ones included, latest date first) and the ledger's accounts and totals (LED-2).
  router.get("/payments", requirePermission("payments", "View"), async (_req, res) => {
    const [orderList, paymentList, ledger] = await Promise.all([orderRows(db, newestFirst), paymentQuery(db).orderBy(...newestPaymentsFirst), loadLedger(db)]);
    const { accounts, totals } = await ledgerOverview(db, ledger);
    res.json({
      orders: orderList.map((row) => ({
        orderId: row.id,
        po: row.po,
        supplierId: row.supplierId,
        supplier: row.supplierName,
        currency: row.currency,
        supplierRate: row.supplierRate,
        orderValueCny: row.orderValueCny,
        poValueCny: row.poValueCny,
        ...orderSettlement(ledger.order(row.id), row),
        nextDue: row.nextDue,
      })),
      payments: paymentList.map(paymentRow),
      accounts,
      totals,
    });
  });

  return router;
}
