import { and, eq, inArray, lt } from "drizzle-orm";

import type { Database } from "../db/client";
import { containerLines, orderLines, orders } from "../db/schema";

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
