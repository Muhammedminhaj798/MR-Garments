import { and, eq, inArray, lt, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { clearings, containerLines, orderLines, orders, receipts, transports, warehouseReceipts } from "../db/schema";

/**
 * After a receipt, container, clearing or trip is deleted (REC-4, CON-6, CLR-4, TRN-4): each order goes back to the
 * furthest stage its remaining records reach, never forward. Over the containers holding its goods: a stocked warehouse
 * receipt 6, a trip 5, a clearing 4, any container 3; else a receipt 2; else 1 (the moves of REC-3, CON-3 and
 * moveOrdersToStage, read back). Call it inside the delete's transaction, with the orders locked.
 */
export async function settleStages(tx: Pick<Database, "update">, orderIds: string[]) {
  if (orderIds.length === 0) return;
  const mine = sql`(select ${containerLines.containerId} from ${containerLines} join ${orderLines} on ${orderLines.id} = ${containerLines.orderLineId}
    where ${orderLines.orderId} = ${orders.id})`;
  const reached = sql`case
    when exists (select 1 from ${warehouseReceipts} join ${transports} on ${transports.id} = ${warehouseReceipts.transportId}
      where ${warehouseReceipts.status} = 'stocked' and ${transports.containerId} in ${mine}) then 6
    when exists (select 1 from ${transports} where ${transports.containerId} in ${mine}) then 5
    when exists (select 1 from ${clearings} where ${clearings.containerId} in ${mine}) then 4
    when exists ${mine} then 3
    when exists (select 1 from ${receipts} where ${receipts.orderId} = ${orders.id}) then 2
    else 1 end`;
  await tx
    .update(orders)
    .set({ stage: sql`least(${orders.stage}, ${reached})`, updatedAt: new Date() })
    .where(inArray(orders.id, orderIds));
}

/**
 * Moves every order with goods in the container forward to `stage`, never backward (docs/wave3-contracts.md section 2:
 * 4 In clearing, 5 On the road, 6 Received). Call it inside the write's transaction. Coordinator-owned.
 */
export async function moveOrdersToStage(tx: Pick<Database, "select" | "update">, containerId: string, stage: 4 | 5 | 6) {
  const inContainer = tx
    .select({ id: orderLines.orderId })
    .from(containerLines)
    .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
    .where(eq(containerLines.containerId, containerId));
  await tx
    .update(orders)
    .set({ stage })
    .where(and(inArray(orders.id, inContainer), lt(orders.stage, stage)));
}
