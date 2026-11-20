import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "../../db/client";
import { containerLines, containers, items, orderLines, orders, suppliers, teams, warehouseReceiptLines, warehouseReceipts } from "../../db/schema";
import { loadLandedCosts } from "../costs/landed-cost";
import { loadLedger, sliceDetails } from "../ledger/ledger";
import { orderMoney } from "../orders/money";
import { round2, unitSymbol } from "../orders/orders.routes";

// GET /landed-cost (docs/wave3-contracts.md sections 6.4 and 8): one row per order with any cost so far, newest first.
// The figures are loadLandedCosts'; this adds what the screen shows around them.

const main = alias(orderLines, "main_line");
const stocked = and(eq(warehouseReceipts.id, warehouseReceiptLines.receiptId), eq(warehouseReceipts.status, "stocked"));

/** `supplierId`: that supplier's orders. `teamId`: orders with stocked pieces for that team. */
export async function landedCostList(db: Database, { supplierId, teamId }: { supplierId?: string; teamId?: string }) {
  const forTeam = sql`exists (select 1 from ${warehouseReceiptLines}
    join ${warehouseReceipts} on ${stocked}
    join ${orderLines} on ${orderLines.id} = ${warehouseReceiptLines.orderLineId}
    where ${orderLines.orderId} = ${orders.id} and ${warehouseReceiptLines.teamId} = ${teamId} and ${warehouseReceiptLines.quantity} > 0)`;
  const rows = await db
    .select({
      orderId: orders.id,
      po: orders.poNumber,
      supplier: { id: suppliers.id, name: suppliers.name },
      // The currency of `goodsPayments[].amountCny`; every other figure here is INR.
      currency: orders.currency,
      item: items.name,
      unit: unitSymbol,
      quantity: main.quantity,
      // The PO in its own currency and the rate saved on the order (0012; null for older orders), for the report
      // download (docs/report-downloads.md). The landed cost's goods stay the credits at their own rates.
      orderDate: orders.orderDate,
      orderValueCny: orderMoney.orderValueCny,
      exchangeRate: orders.exchangeRate,
    })
    .from(orders)
    .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
    .innerJoin(main, and(eq(main.orderId, orders.id), eq(main.position, 0)))
    .innerJoin(items, eq(items.id, main.itemId))
    .where(and(supplierId ? eq(orders.supplierId, supplierId) : undefined, teamId ? forTeam : undefined))
    .orderBy(desc(orders.orderDate), desc(orders.createdAt));
  const ledger = await loadLedger(db, supplierId ? { supplierIds: [supplierId] } : {});
  const costs = await loadLandedCosts(
    db,
    rows.map((row) => row.orderId),
    ledger,
  );
  const costed = rows.filter((row) => costs.get(row.orderId)!.totalInr > 0);
  const ids = costed.map((row) => row.orderId);

  const [terms, splits, goods, supplierOptions, teamOptions] = await Promise.all([
    db
      .selectDistinct({ orderId: orderLines.orderId, terms: containers.terms })
      .from(containerLines)
      .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
      .innerJoin(containers, eq(containers.id, containerLines.containerId))
      .where(inArray(orderLines.orderId, ids)),
    db
      .select({ orderId: orderLines.orderId, teamId: teams.id, team: teams.name, pieces: sql<number>`sum(${warehouseReceiptLines.quantity})`.mapWith(Number) })
      .from(warehouseReceiptLines)
      .innerJoin(warehouseReceipts, stocked)
      .innerJoin(orderLines, eq(orderLines.id, warehouseReceiptLines.orderLineId))
      .innerJoin(teams, eq(teams.id, warehouseReceiptLines.teamId))
      .where(inArray(orderLines.orderId, ids))
      .groupBy(orderLines.orderId, teams.id)
      .having(sql`sum(${warehouseReceiptLines.quantity}) > 0`)
      .orderBy(asc(teams.createdAt), asc(teams.name)),
    // Goods: the credits that settled each order (the ledger's FIFO slices), oldest first, each at its own rate (as loadLandedCosts).
    sliceDetails(
      db,
      ids.flatMap((id) => ledger.order(id)?.slices ?? []),
    ),
    db
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(eq(suppliers.status, "Active"))
      .orderBy(asc(suppliers.createdAt), asc(suppliers.name)),
    db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.status, "Active")).orderBy(asc(teams.createdAt), asc(teams.name)),
  ]);

  const list = costed.map((row) => {
    const cost = costs.get(row.orderId)!;
    // CNF or FOB when every container carrying the order has those terms, "mixed" when they differ, null before loading.
    const kinds = [...new Set(terms.filter((t) => t.orderId === row.orderId).map((t) => t.terms))];
    return {
      ...row,
      terms: kinds.length === 0 ? null : kinds.length === 1 ? kinds[0]! : "mixed",
      ...cost,
      // Cost per team = its pieces x the order's per-piece cost (section 6.3); pieces > 0 means perPieceInr is set.
      teams: splits
        .filter((split) => split.orderId === row.orderId)
        .map(({ teamId: id, team, pieces }) => ({ teamId: id, team, pieces, costInr: round2(pieces * (cost.perPieceInr ?? 0)) })),
      goodsPayments: goods(ledger.order(row.orderId)?.slices ?? []),
    };
  });
  const finished = list.filter((row) => row.final);
  const estimates = list.filter((row) => !row.final);
  const reasons = [...new Set(estimates.map((row) => row.waitingFor))];
  return {
    kpis: {
      finishedTotalInr: round2(finished.reduce((total, row) => total + row.totalInr, 0)),
      finishedPieces: finished.reduce((total, row) => total + row.stockedPieces, 0),
      finishedPos: finished.map((row) => row.po),
      estimatePos: estimates.map((row) => row.po),
      /** What every estimate waits for, or null when they wait for different things (or there are none). */
      estimateWaitingFor: reasons.length === 1 ? reasons[0]! : null,
    },
    orders: list,
    suppliers: supplierOptions,
    teams: teamOptions,
  };
}
