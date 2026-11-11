import { and, asc, desc, eq, inArray, lte, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import type { Database } from "../../db/client";
import {
  type Currency,
  CURRENCIES,
  items,
  orderLines,
  orders,
  PAYEE_ROLES,
  payments,
  receiptLines,
  shippingAgents,
  suppliers,
  units,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import { validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { orderClosed, orderClosedOn } from "./closure";
import { depositState, orderMoney, round2 } from "./money";

// Owner: BE-orders. ORD-1 GET /orders, ORD-2 GET /orders/options, ORD-3 POST /orders, CAL-1 GET /deliveries,
// PAY-1 GET /payments (docs/live-screens-contracts.md). Payments are records only: nothing here moves money.
// `stocked`, `closed` and `closedOn` (docs/phase2-contracts.md section 1) come from ./closure.ts.
// Money is in the order's `currency` (the *Cny names stay for compatibility); `rateInr` is INR per 1 of it.

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
  currency: "Choose CNY, USD or INR.",
  /** The order is in its supplier's currency (docs/supplier-currency.md); another one is refused. */
  supplierCurrency: (currency: string) => `This supplier's orders are in ${currency}.`,
  po: "Enter the PO number.",
  poTooLong: "Use 50 characters or fewer.",
  poTaken: "This PO number is already used by another order.",
  depositRequired: "Enter the deposit the supplier asked for: above 0, with at most 2 decimals.",
  referenceTooLong: "Use 100 characters or fewer for the reference.",
  notesTooLong: "Use 1,000 characters or fewer for the notes.",
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
  // The supplier's currency: left out, it is filled in; given, it must match (checkRules).
  currency: z.enum(CURRENCIES, { error: M.currency }).optional(),
  orderDate: z.iso.date({ error: M.orderDate }),
  deliveryDate: z.iso.date({ error: M.deliveryDate }),
  lines: lineList(line),
  deposits: z.array(deposit).max(10, M.tooManyDeposits).default([]),
  // The deposit the supplier asked for (0009), in the order's currency; left out, none was agreed.
  depositRequiredCny: depositRequired.optional(),
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

/** Two simultaneous creates can pick the same number; the unique index refuses the second, which then retries. */
function isPoTaken(error: unknown) {
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
  if (Object.keys(problems).length > 0) throw validationFailed(problems);
  /** The order's money: its currency and the supplier's rate now (1 for INR; null while the supplier has none), kept on the order for good. */
  return { currency, exchangeRate: currency === "INR" ? 1 : (supplier!.exchangeRate ?? null) };
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
  /** The deposit the supplier asked for (0009); null when none. depositState() turns it and depositPaidCny into the status. */
  depositRequiredCny: orders.depositRequiredCny,
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

  // ORD-1. Order date, then PO, newest first.
  router.get("/orders", requirePermission("ordersView", "View"), async (_req, res) => {
    const rows = await orderRows(db, newestFirst);
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
        item: row.item,
        quantity: row.quantity,
        unit: row.unit,
        received: row.received,
        stocked: row.stocked,
        closed: row.closed,
        closedOn: row.closedOn,
        orderValueCny: row.orderValueCny,
        paidCny: row.paidCny,
        paidInr: row.paidInr,
        supplierPaidCny: row.supplierPaidCny,
        supplierPaidInr: row.supplierPaidInr,
        ...depositState(row.depositRequiredCny, row.depositPaidCny),
      })),
    );
  });

  // ORD-2. What the new-order form offers; readable by anyone who can open Orders (no Settings access needed).
  router.get("/orders/options", requirePermission("ordersView", "View"), async (_req, res) => {
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
    res.json({
      nextPo: po,
      suppliers: supplierRows,
      items: itemRows,
      agents,
    });
  });

  // ORD-3. The order, its lines and its deposits in one transaction; the PO number is the form's or assigned inside it.
  router.post("/orders", requirePermission("ordersEdit", "Enter"), async (req, res) => {
    const input = parse(newOrder, req.body);
    const money = await checkRules(db, input);
    const userId = req.user!.id;
    for (let attempt = 1; ; attempt++) {
      try {
        const order = await db.transaction(async (tx) => {
          // One order at a time takes a PO number, so a burst of creates can't all pick the same one (audit M1).
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext('orders.po_number'))`);
          const created = await tx
            .insert(orders)
            .values({
              poNumber: input.po ?? (await nextPo(tx)),
              supplierId: input.supplierId,
              orderDate: input.orderDate,
              deliveryDate: input.deliveryDate,
              currency: money.currency,
              exchangeRate: money.exchangeRate,
              depositRequiredCny: input.depositRequiredCny ?? null,
              createdBy: userId,
            })
            .returning({ id: orders.id, po: orders.poNumber });
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
          if (input.deposits.length > 0) {
            await tx
              .insert(payments)
              .values(input.deposits.map((entry) => ({ ...entry, rateInr: entry.rateInr ?? 1, orderId, kind: "Deposit", status: "paid", createdBy: userId })));
          }
          return created[0]!;
        });
        res.status(201).json({ order });
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

  // PAY-1. Every order's figures (newest first) and every payment record (latest date first). `balanceCny` is what
  // the supplier is still owed (order value less supplier payments); `paidCny`/`paidInr` count every payee.
  router.get("/payments", requirePermission("payments", "View"), async (_req, res) => {
    const [orderList, paymentList] = await Promise.all([
      orderRows(db, newestFirst),
      db
        .select({
          id: payments.id,
          orderId: payments.orderId,
          po: orders.poNumber,
          currency: orders.currency,
          kind: payments.kind,
          payee: payments.payee,
          payeeRole: payments.payeeRole,
          amountCny: payments.amountCny,
          status: payments.status,
          paidOn: payments.paidOn,
          dueDate: payments.dueDate,
          rateInr: payments.rateInr,
          mode: payments.mode,
          reference: payments.reference,
          notes: payments.notes,
          /** INR at the payment's own rate, rounded in SQL as every total is (the same paisa as ORD-4); null while due. */
          amountInr: sql<number | null>`case when ${payments.status} = 'paid' then round(${payments.amountCny} * ${payments.rateInr}, 2) end`.mapWith(Number),
        })
        .from(payments)
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .orderBy(desc(sql`coalesce(${payments.paidOn}, ${payments.dueDate})`), desc(payments.createdAt)),
    ]);
    res.json({
      orders: orderList.map((row) => ({
        orderId: row.id,
        po: row.po,
        supplier: row.supplierName,
        currency: row.currency,
        supplierRate: row.supplierRate,
        orderValueCny: row.orderValueCny,
        paidCny: row.paidCny,
        paidInr: row.paidInr,
        supplierPaidCny: row.supplierPaidCny,
        supplierPaidInr: row.supplierPaidInr,
        balanceCny: round2(row.orderValueCny - row.supplierPaidCny),
        ...depositState(row.depositRequiredCny, row.depositPaidCny),
        nextDue: row.nextDue,
      })),
      payments: paymentList,
    });
  });

  return router;
}
