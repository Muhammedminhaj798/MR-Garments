import { and, eq, inArray, lt, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { containerLines, orderLines, orders, receipts } from "../db/schema";

/**
 * After a receipt or container is deleted (REC-4, CON-6): each order goes back to what it still has, never forward. An
 * order still in a container keeps its stage (those deletes refuse anything past loading); otherwise 2 with a receipt
 * left, else 1. Call it inside the delete's transaction, with the orders locked.
 */
export async function settleStages(tx: Pick<Database, "update">, orderIds: string[]) {
  if (orderIds.length === 0) return;
  const loaded = sql`exists (select 1 from ${containerLines} join ${orderLines} on ${orderLines.id} = ${containerLines.orderLineId}
    where ${orderLines.orderId} = ${orders.id})`;
  const received = sql`exists (select 1 from ${receipts} where ${receipts.orderId} = ${orders.id})`;
  await tx
    .update(orders)
    .set({ stage: sql`case when ${loaded} then ${orders.stage} when ${received} then least(${orders.stage}, 2) else 1 end`, updatedAt: new Date() })
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
