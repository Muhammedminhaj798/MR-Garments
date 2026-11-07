import { eq, inArray, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import type { Database } from "../../db/client";
import { items, orderLines, orders, STATUSES, units } from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { poValue } from "../orders/orders.routes";
import { deleteRoute } from "./delete-route";
import { creationOrder, listRoute } from "./list-query";

// Owner: A4 (docs/wave3-contracts.md section 4). MD-19 GET /items, POST /items, PATCH /items/:id,
// DELETE /items/:id (section 4.1). Management only (B6).

export const MESSAGES = {
  name: "Enter the item name.",
  nameTooLong: "Use 200 characters or fewer.",
  nameTaken: "An item with this name already exists.",
  countedIn: "Choose a unit from the list.",
  bundle: "Enter the pieces per bundle or a bundle label.", // contract
  perBundle: "Enter a whole number of pieces from 1 to 100000.",
  bundleLabelTooLong: "Use 200 characters or fewer.",
  inUse: "This item is on an order, so its unit can't change.", // contract
};
const M = MESSAGES;

const fields = {
  name: z.string({ error: M.name }).trim().min(1, M.name).max(200, M.nameTooLong),
  countedIn: z.string({ error: M.countedIn }).trim().min(1, M.countedIn).max(50, M.countedIn),
  perBundle: z.number({ error: M.perBundle }).int(M.perBundle).min(1, M.perBundle).max(100_000, M.perBundle).nullable(),
  // A blank label is no label.
  bundleLabel: z
    .string({ error: M.bundle })
    .trim()
    .max(200, M.bundleLabelTooLong)
    .transform((label) => label || null)
    .nullable(),
  status: z.enum(STATUSES),
};
const newItem = z.strictObject({
  name: fields.name,
  countedIn: fields.countedIn,
  perBundle: fields.perBundle.default(null),
  bundleLabel: fields.bundleLabel.default(null),
});
const itemUpdate = z.strictObject(fields).partial();

/** Exactly one of perBundle and bundleLabel is set (the database's items_bundle_check). */
function bundle(perBundle: number | null, bundleLabel: string | null) {
  if ((perBundle === null) === (bundleLabel === null)) throw validationFailed({ perBundle: M.bundle });
  return { perBundle, bundleLabel };
}

const isUuid = (value: string) => z.uuid().safeParse(value).success;

function nameTakenAsConflict(error: unknown): never {
  type PgError = { code?: string; constraint?: string; cause?: PgError };
  const pg = (error as PgError)?.cause ?? (error as PgError);
  if (pg?.code === "23505" && pg.constraint === "items_name_unique") throw conflict("name_exists", M.nameTaken, { name: M.nameTaken });
  // The unit was deleted between the check and the write.
  if (pg?.code === "23503" && pg.constraint === "items_counted_in_units_name_fk") throw validationFailed({ countedIn: M.countedIn });
  throw error;
}

/** The active unit named (any letter case), as its name is stored; items.counted_in points at it. */
async function activeUnit(db: Pick<Database, "select">, name: string) {
  const found = await db
    .select({ name: units.name })
    .from(units)
    .where(sql`lower(${units.name}) = lower(${name}) and ${units.status} = 'Active'`);
  if (!found[0]) throw validationFailed({ countedIn: M.countedIn });
  return found[0].name;
}

// The distinct PO numbers of the orders with a line of this item, in PO order (PO-999 before PO-1000; others after, by text).
// ponytail: one subquery per item over every order; add an order_lines(item_id) index if orders reach the thousands.
const ordersWithItem = sql`select ${orders.poNumber} from ${orders}
  where exists (select 1 from ${orderLines} where ${orderLines.orderId} = ${orders.id} and ${orderLines.itemId} = ${items.id})
  order by ${poValue} nulls last, ${orders.poNumber}`;
// Nested, so the columns keep their table names: drizzle drops them from a single-table select's top-level columns.
const usedInOrders = sql<string[]>`array(${ordersWithItem})`;

function itemRows(db: Database, id?: string) {
  return db
    .select({
      id: items.id,
      name: items.name,
      countedIn: items.countedIn,
      perBundle: items.perBundle,
      bundleLabel: items.bundleLabel,
      usedInOrders,
      status: items.status,
    })
    .from(items)
    .where(id ? eq(items.id, id) : undefined)
    .orderBy(...creationOrder(items));
}

export function itemsRoutes({ db }: RouteContext) {
  const router = Router();
  const admin = requirePermission("admin", "Full");

  listRoute(router, "/items", () => itemRows(db), (row) => [row.name, ...row.usedInOrders]);

  router.post("/items", admin, async (req, res) => {
    const { perBundle, bundleLabel, ...input } = parse(newItem, req.body);
    const countedIn = await activeUnit(db, input.countedIn);
    // The unique index on lower(name) decides duplicates, so two simultaneous adds can't both succeed.
    const created = await db
      .insert(items)
      .values({ ...input, countedIn, ...bundle(perBundle, bundleLabel) })
      .onConflictDoNothing()
      .returning({ id: items.id })
      .catch(nameTakenAsConflict);
    if (!created[0]) throw conflict("name_exists", M.nameTaken, { name: M.nameTaken });
    res.status(201).json({ item: (await itemRows(db, created[0].id))[0] });
  });

  // Only the keys sent change. A bundle key sent replaces the bundle: the other one becomes null unless also sent.
  router.patch("/items/:id", admin, async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Item");
    const parsed = parse(itemUpdate, req.body);
    if (Object.keys(parsed).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
    const { perBundle, bundleLabel, countedIn, ...input } = parsed;
    const values = perBundle === undefined && bundleLabel === undefined ? input : { ...input, ...bundle(perBundle ?? null, bundleLabel ?? null) };

    await db
      .transaction(async (tx) => {
        // Locked, so no order can take the item between the check and the change (a new order line key-share locks it).
        const current = (await tx.select({ countedIn: items.countedIn }).from(items).where(eq(items.id, id)).for("update"))[0];
        if (!current) throw notFound("Item");
        // The same unit again (any letter case) is no change: an item on an order can still be edited with it, and an
        // item whose unit has since been deactivated keeps it.
        const unitChanged = countedIn !== undefined && countedIn.toLowerCase() !== current.countedIn.toLowerCase();
        if (unitChanged) {
          const lines = await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.itemId, id)).limit(1);
          if (lines.length > 0) throw conflict("item_in_use", M.inUse);
        }
        await tx
          .update(items)
          .set(unitChanged ? { ...values, countedIn: await activeUnit(tx, countedIn) } : values)
          .where(eq(items.id, id));
      })
      .catch(nameTakenAsConflict);
    res.json({ item: (await itemRows(db, id))[0] });
  });

  deleteRoute(router, db, "/items", items, "Item", [
    { what: "order", table: orders, of: (id) => inArray(orders.id, db.select({ id: orderLines.orderId }).from(orderLines).where(eq(orderLines.itemId, id))) },
  ]);

  return router;
}
