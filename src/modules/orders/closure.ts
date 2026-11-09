import { sql } from "drizzle-orm";

import { containerLines, orderLines, orders, transports, warehouseReceiptLines, warehouseReceipts } from "../../db/schema";

// When an order is closed (docs/phase2-contracts.md section 1). Coordinator-owned: Orders, Reports and Deposits read
// these and never write their own rule.
//
// The workflow ends in the India warehouse: an order is **closed** when it is at stage 6 (a warehouse receipt holding
// its goods was stocked, WH-3), every container carrying any of its goods has a stocked warehouse receipt, and at least
// one of its own pieces was given to a team (another order's pieces in a shared container never close it;
// docs/phase2-fixes.md 3). The carrier rule is
// the landed-cost rule already in force (costs/landed-cost.ts `waitingFor`: "warehouse" while stage < 6 or a carrier
// is not stocked), so a multi-container order stays open until its last container is stocked. China receiving,
// loading, clearing and transport never close an order. Nothing is stored: the rule reads the live records, so WH-4
// (deleting a stocked receipt, Management only) reopens the order by itself, as settleStages steps its stage back.
//
// These fragments correlate on `orders.id`, so they belong in a select FROM orders that has at least one join (in a
// single-table select drizzle drops the table name from the outer columns and the inner `orders` would shadow them).

/** A container carrying the order's goods whose trip has no stocked warehouse receipt yet. */
const unstockedCarrier = sql`exists (select 1 from ${containerLines}
  join ${orderLines} on ${orderLines.id} = ${containerLines.orderLineId}
  where ${orderLines.orderId} = ${orders.id} and not exists (select 1 from ${warehouseReceipts}
    join ${transports} on ${transports.id} = ${warehouseReceipts.transportId}
    where ${warehouseReceipts.status} = 'stocked' and ${transports.containerId} = ${containerLines.containerId}))`;

/** This order's own pieces on a stocked receipt (WH-3 refuses a receipt that gives an order none; this is the belt). */
const ownPiecesStocked = sql`exists (select 1 from ${warehouseReceiptLines}
  join ${warehouseReceipts} on ${warehouseReceipts.id} = ${warehouseReceiptLines.receiptId}
  join ${orderLines} on ${orderLines.id} = ${warehouseReceiptLines.orderLineId}
  where ${warehouseReceipts.status} = 'stocked' and ${warehouseReceiptLines.quantity} > 0 and ${orderLines.orderId} = ${orders.id})`;

/** True when the order is closed (stage 6, no carrier left to stock, and some of its own pieces stocked). */
export const orderClosed = sql<boolean>`(${orders.stage} = 6 and not ${unstockedCarrier} and ${ownPiecesStocked})`;

/** The day the order closed: the latest `received_on` of the stocked receipts holding its goods; null while open. */
export const orderClosedOn = sql<string | null>`case when ${orderClosed} then (select max(${warehouseReceipts.receivedOn})::text from ${warehouseReceipts}
  join ${transports} on ${transports.id} = ${warehouseReceipts.transportId}
  join ${containerLines} on ${containerLines.containerId} = ${transports.containerId}
  join ${orderLines} on ${orderLines.id} = ${containerLines.orderLineId}
  where ${warehouseReceipts.status} = 'stocked' and ${orderLines.orderId} = ${orders.id}) else null end`;

// Pending (the lists' other state) is simply `stage = 1`: the order has not entered receiving (REC-3 moves 1 -> 2 on the
// first receipt). Callers compare the stage; no fragment is needed.
