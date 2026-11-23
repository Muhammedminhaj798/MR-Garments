import { sql } from "drizzle-orm";

import { orderLines, receiptLines } from "../../db/schema";

// A leaf module (schema only): orders/money.ts reads these at load time, so they must not wait on ledger.ts.

/**
 * The one definition of an order line's received quantity (owner rule of 2026-11-23, docs/unified-ledger.md "Order
 * value"): every China goods receipt of the line (REC-3) added up, excess over the ordered quantity included. India
 * warehouse quantities never count. Correlates on `order_lines.id`.
 */
export const receivedOfLine = sql<number>`(select coalesce(sum(${receiptLines.quantity}), 0) from ${receiptLines} where ${receiptLines.orderLineId} = ${orderLines.id})`.mapWith(Number);
/** A line's value: received quantity x its rate (correlates on `order_lines`). Its PO value is quantity x rate. */
export const lineValue = sql<number>`round(${receivedOfLine} * ${orderLines.rateCny}, 2)`.mapWith(Number);
export const linePoValue = sql<number>`round(${orderLines.quantity} * ${orderLines.rateCny}, 2)`.mapWith(Number);
