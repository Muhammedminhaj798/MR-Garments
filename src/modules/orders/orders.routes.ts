import { and, asc, desc, eq, inArray, lte, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import type { Database } from "../../db/client";
import { items, orderLines, orders, PAYEE_ROLES, payments, receiptLines, shippingAgents, suppliers } from "../../db/schema";
import { validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";

// Owner: BE-orders. ORD-1 GET /orders, ORD-2 GET /orders/options, ORD-3 POST /orders, CAL-1 GET /deliveries,
// PAY-1 GET /payments (docs/live-screens-contracts.md). Payments are records only: nothing here moves money.

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
  mode: "Enter the payment mode.",
};
const M = MESSAGES;

// Upper bounds keep values inside the numeric/integer columns, so an absurd number is a 422, not a 500.
const line = z.strictObject({
  itemId: z.uuid({ error: M.item }),
  quantity: z.number({ error: M.quantity }).int(M.quantity).min(1, M.quantity).max(2_147_483_647, M.quantity),
  rateCny: z.number({ error: M.rate }).min(0, M.rate).max(99_999_999, M.rate),
});
const deposit = z.strictObject({
  payee: z.string({ error: M.payee }).trim().min(1, M.payee),
  payeeRole: z.enum(PAYEE_ROLES, { error: M.payee }),
  amountCny: z.number({ error: M.amount }).min(0.01, M.amount).max(999_999_999_999, M.amount),
  paidOn: z.iso.date({ error: M.paidOn }),
  rateInr: z.number({ error: M.rateInr }).min(0.0001, M.rateInr).max(99_999_999, M.rateInr),
  mode: z.string({ error: M.mode }).trim().min(1, M.mode),
});
const newOrder = z.strictObject({
  supplierId: z.uuid({ error: M.supplier }),
  orderDate: z.iso.date({ error: M.orderDate }),
  deliveryDate: z.iso.date({ error: M.deliveryDate }),
  lines: z.array(line, { error: M.lines }).min(1, M.lines).max(50, M.tooManyLines),
  deposits: z.array(deposit).max(10, M.tooManyDeposits).default([]),
});
type NewOrder = z.infer<typeof newOrder>;

const unit = (countedIn: string) => (countedIn === "Metres" ? "m" : "pcs");
const round2 = (value: number) => Math.round(value * 100) / 100;

// PO numbers: "PO-" + (highest number + 1); the first is PO-2050.
const FIRST_PO = 2050;
const poValue = sql`substring(${orders.poNumber} from '^PO-([0-9]+)$')::bigint`;
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
  if (input.deliveryDate < input.orderDate) problems.deliveryDate = M.deliveryBeforeOrder;
  const supplier = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.status, "Active")));
  if (supplier.length === 0) problems.supplierId = M.supplier;
  const itemIds = [...new Set(input.lines.map((entry) => entry.itemId))];
  const active = await db
    .select({ id: items.id })
    .from(items)
    .where(and(inArray(items.id, itemIds), eq(items.status, "Active")));
  if (active.length < itemIds.length) problems.lines = M.item;
  if (Object.keys(problems).length > 0) throw validationFailed(problems);
}

// The main line (position 0) gives the item, quantity and received figures the lists show.
const main = alias(orderLines, "main_line");
const paid = sql`${payments.orderId} = ${orders.id} and ${payments.status} = 'paid'`;
const orderColumns = {
  id: orders.id,
  po: orders.poNumber,
  orderDate: orders.orderDate,
  deliveryDate: orders.deliveryDate,
  stage: orders.stage,
  supplierId: suppliers.id,
  supplierName: suppliers.name,
  item: items.name,
  countedIn: items.countedIn,
  quantity: main.quantity,
  received: sql<number>`(select coalesce(sum(${receiptLines.quantity}), 0) from ${receiptLines} where ${receiptLines.orderLineId} = ${main.id})`.mapWith(Number),
  orderValueCny: sql<number>`(select round(coalesce(sum(${orderLines.quantity} * ${orderLines.rateCny}), 0), 2) from ${orderLines} where ${orderLines.orderId} = ${orders.id})`.mapWith(Number),
  paidCny: sql<number>`(select coalesce(sum(${payments.amountCny}), 0) from ${payments} where ${paid})`.mapWith(Number),
  // INR is amountCny * rateInr rounded to 2 decimals per payment, then summed.
  paidInr: sql<number>`(select coalesce(sum(round(${payments.amountCny} * ${payments.rateInr}, 2)), 0) from ${payments} where ${paid})`.mapWith(Number),
  nextDue: sql<string | null>`(select min(${payments.dueDate})::text from ${payments} where ${payments.orderId} = ${orders.id} and ${payments.status} = 'due')`,
};
const newestFirst = [desc(orders.orderDate), desc(poValue)];

// ponytail: per-order subqueries over every order; add paging or a stage filter when orders reach the thousands.
function orderRows(db: Database, orderBy: SQL[], where?: SQL) {
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
        item: row.item,
        quantity: row.quantity,
        unit: unit(row.countedIn),
        received: row.received,
        orderValueCny: row.orderValueCny,
        paidCny: row.paidCny,
        paidInr: row.paidInr,
      })),
    );
  });

  // ORD-2. What the new-order form offers; readable by anyone who can open Orders (no Settings access needed).
  router.get("/orders/options", requirePermission("ordersView", "View"), async (_req, res) => {
    const [po, supplierRows, itemRows, agents] = await Promise.all([
      nextPo(db),
      db
        .select({ id: suppliers.id, name: suppliers.name, contactPerson: suppliers.contactPerson, phone: suppliers.phone, city: suppliers.city })
        .from(suppliers)
        .where(eq(suppliers.status, "Active"))
        .orderBy(asc(suppliers.createdAt), asc(suppliers.name)),
      db
        .select({ id: items.id, name: items.name, countedIn: items.countedIn })
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
      items: itemRows.map(({ countedIn, ...item }) => ({ ...item, unit: unit(countedIn) })),
      agents,
    });
  });

  // ORD-3. The order, its lines and its deposits in one transaction; the PO number is assigned inside it.
  router.post("/orders", requirePermission("ordersEdit", "Enter"), async (req, res) => {
    const input = parse(newOrder, req.body);
    await checkRules(db, input);
    const userId = req.user!.id;
    for (let attempt = 1; ; attempt++) {
      try {
        const order = await db.transaction(async (tx) => {
          const created = await tx
            .insert(orders)
            .values({ poNumber: await nextPo(tx), supplierId: input.supplierId, orderDate: input.orderDate, deliveryDate: input.deliveryDate, createdBy: userId })
            .returning({ id: orders.id, po: orders.poNumber });
          const orderId = created[0]!.id;
          await tx.insert(orderLines).values(input.lines.map((entry, position) => ({ ...entry, orderId, position })));
          if (input.deposits.length > 0) {
            await tx
              .insert(payments)
              .values(input.deposits.map((entry) => ({ ...entry, orderId, kind: "Deposit", status: "paid", createdBy: userId })));
          }
          return created[0]!;
        });
        res.status(201).json({ order });
        return;
      } catch (error) {
        if (attempt < 5 && isPoTaken(error)) continue;
        throw error;
      }
    }
  });

  // CAL-1. Orders at stage 1-2, due date oldest first.
  router.get("/deliveries", requirePermission("calendar", "View"), async (_req, res) => {
    const rows = await orderRows(db, [asc(orders.deliveryDate), asc(poValue)], lte(orders.stage, 2));
    res.json(
      rows.map((row) => ({
        orderId: row.id,
        po: row.po,
        supplier: row.supplierName,
        item: row.item,
        quantity: row.quantity,
        unit: unit(row.countedIn),
        received: row.received,
        due: row.deliveryDate,
      })),
    );
  });

  // PAY-1. Every order's figures (newest first) and every payment record (latest date first).
  router.get("/payments", requirePermission("payments", "View"), async (_req, res) => {
    const [orderList, paymentList] = await Promise.all([
      orderRows(db, newestFirst),
      db
        .select({
          id: payments.id,
          orderId: payments.orderId,
          po: orders.poNumber,
          kind: payments.kind,
          payee: payments.payee,
          payeeRole: payments.payeeRole,
          amountCny: payments.amountCny,
          status: payments.status,
          paidOn: payments.paidOn,
          dueDate: payments.dueDate,
          rateInr: payments.rateInr,
          mode: payments.mode,
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
        orderValueCny: row.orderValueCny,
        paidCny: row.paidCny,
        paidInr: row.paidInr,
        balanceCny: round2(row.orderValueCny - row.paidCny),
        nextDue: row.nextDue,
      })),
      payments: paymentList,
    });
  });

  return router;
}
