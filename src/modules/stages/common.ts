import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { CurrentUser } from "../../auth/current-user";
import type { Database } from "../../db/client";
import { containerLines, containers, items, orderLines, orders, suppliers } from "../../db/schema";
import { conflict, notFound } from "../../http/errors";
import { atLeast, effectiveAccess } from "../../permissions/matrix";
import { unit } from "../orders/orders.routes";

// Owner: A5. What Clearing, Transport and Warehouse (docs/wave3-contracts.md section 5) share.

export const STAGE_MESSAGES = {
  notArrived: "This container hasn't arrived at the port yet.",
  notCleared: "This container hasn't been cleared yet.",
  notUnloaded: "These goods haven't been unloaded yet.",
  closed: "This record is complete and can't be changed.",
  // Proposed wording (the contract names only the rules).
  amount: "Enter an amount from 0 to 999,999,999,999.99.",
  date: "Enter a valid date.",
  future: "This date can't be after today.",
  tooLong: "Use 200 characters or fewer.",
  remarkTooLong: "Use 1,000 characters or fewer.",
};

/** Today in India (Asia/Kolkata, UTC+5:30, no daylight saving) as YYYY-MM-DD. */
export const todayInIndia = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
/** `day` moved by `days`. The list KPIs' "last 30 days" are today and the 29 days before it. */
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;
export const isUuid = (value: string) => z.uuid().safeParse(value).success;

const MAX_INT = 2_147_483_647;
export const text = (max = 200) => z.string().trim().max(max, max > 200 ? STAGE_MESSAGES.remarkTooLong : STAGE_MESSAGES.tooLong).default("");
export const required = (message: string) => z.string({ error: message }).trim().min(1, message).max(200, STAGE_MESSAGES.tooLong);
export const optionalDate = (message = STAGE_MESSAGES.date) => z.iso.date({ error: message }).nullable().default(null);
export const count = (message: string, min = 0) => z.number({ error: message }).int(message).min(min, message).max(MAX_INT, message);
/** INR with at most 2 decimals, inside numeric(14, 2). */
export const inr = () =>
  z
    .number({ error: STAGE_MESSAGES.amount })
    .min(0, STAGE_MESSAGES.amount)
    .max(999_999_999_999.99, STAGE_MESSAGES.amount)
    .refine((value) => Number(value.toFixed(2)) === value, STAGE_MESSAGES.amount);
export const complete = z.boolean().default(false);

export const canSeeCost = (user: CurrentUser) => atLeast(effectiveAccess(user.role, user.stages, "landedCost"), "View");

/** The container row, locked for the rest of the transaction; 404 when unknown. */
export async function lockContainer(tx: Pick<Database, "select">, id: string) {
  const row = (await tx.select().from(containers).where(eq(containers.id, id)).for("update"))[0];
  if (!row) throw notFound("Container");
  return row;
}

export const closed = () => conflict("record_closed", STAGE_MESSAGES.closed);

/** A container's goods, PO then line position, with each line's supplier. */
export async function goodsIn(db: Pick<Database, "select">, containerId: string) {
  const rows = await db
    .select({
      orderLineId: containerLines.orderLineId,
      orderId: orderLines.orderId,
      po: orders.poNumber,
      item: items.name,
      countedIn: items.countedIn,
      bundles: containerLines.bundles,
      quantity: containerLines.quantity,
      supplier: suppliers.name,
    })
    .from(containerLines)
    .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(items, eq(items.id, orderLines.itemId))
    .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
    .where(eq(containerLines.containerId, containerId))
    .orderBy(asc(orders.poNumber), asc(orderLines.position));
  return rows.map(({ countedIn, ...row }) => ({ ...row, unit: unit(countedIn) }));
}

/** The goods as the forms show them, and the suppliers of the orders in the container. */
export const goodsView = (goods: Awaited<ReturnType<typeof goodsIn>>) => ({
  goods: goods.map(({ orderLineId, orderId, po, item, unit, bundles, quantity }) => ({ orderLineId, orderId, po, item, unit, bundles, quantity })),
  suppliers: [...new Set(goods.map((line) => line.supplier))],
});

/** Per container: its POs (in PO order) and its bundles. */
export async function containerOrders(db: Pick<Database, "select">, containerIds: string[]) {
  const byContainer = new Map<string, { orders: string[]; bundles: number }>();
  if (containerIds.length === 0) return byContainer;
  const rows = await db
    .select({ containerId: containerLines.containerId, po: orders.poNumber, bundles: containerLines.bundles })
    .from(containerLines)
    .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(inArray(containerLines.containerId, containerIds))
    .orderBy(asc(orders.poNumber));
  for (const { containerId, po, bundles } of rows) {
    const entry = byContainer.get(containerId) ?? { orders: [], bundles: 0 };
    if (!entry.orders.includes(po)) entry.orders.push(po);
    entry.bundles += bundles;
    byContainer.set(containerId, entry);
  }
  return byContainer;
}
