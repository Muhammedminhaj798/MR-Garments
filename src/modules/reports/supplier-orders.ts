import { asc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../../db/client";
import { containerLines, containers, items, orderLines } from "../../db/schema";
import { linePoValue, lineValue, receivedOfLine } from "../ledger/received";
import { dollarCost, dollarCostTotal, round2 } from "../orders/money";
import { unitSymbol } from "../orders/orders.routes";
import type { z } from "zod";

import { buildOrderReports, currencyTotals, type orderReportsQuery } from "./order-reports";

// RPT-S1 GET /reports/supplier-orders (owner request of 2026-11-24, docs/order-report.md "Supplier order details"):
// RPT-O2's orders, filters and figures (the same rows: value = received quantity × rate, the ledger's FIFO settled and
// outstanding, money.ts `dollarCost`), grouped by supplier, each order with its lines, the containers carrying it and
// its landed-cost parts. A supplier with no matching order is not listed (an order report, as RPT-O2).

export async function supplierOrders(db: Database, q: z.infer<typeof orderReportsQuery>) {
  const { report, costs } = await buildOrderReports(db, q);
  const ids = report.rows.map((row) => row.id);
  const [lines, carried] = ids.length
    ? await Promise.all([
        db
          .select({
            orderId: orderLines.orderId,
            item: items.name,
            unit: unitSymbol,
            ordered: orderLines.quantity,
            received: receivedOfLine,
            rate: orderLines.rateCny,
            poValueCny: linePoValue,
            orderValueCny: lineValue,
          })
          .from(orderLines)
          .innerJoin(items, eq(items.id, orderLines.itemId))
          .where(inArray(orderLines.orderId, ids))
          .orderBy(asc(orderLines.orderId), asc(orderLines.position)),
        // Each container carrying some of the order: its state and dates, and how much of the order it holds.
        db
          .select({
            orderId: orderLines.orderId,
            number: containers.number,
            status: containers.status,
            terms: containers.terms,
            loadedOn: containers.loadedOn,
            sailedOn: containers.sailedOn,
            eta: containers.eta,
            quantity: sql<number>`sum(${containerLines.quantity})`.mapWith(Number),
          })
          .from(containerLines)
          .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
          .innerJoin(containers, eq(containers.id, containerLines.containerId))
          .where(inArray(orderLines.orderId, ids))
          .groupBy(orderLines.orderId, containers.id)
          .orderBy(asc(containers.loadedOn), asc(containers.number)),
      ])
    : [[], []];

  const rows = report.rows.map((row) => {
    const cost = costs.get(row.id)!;
    return {
      ...row,
      lines: lines
        .filter((line) => line.orderId === row.id)
        .map(({ orderId: _orderId, ...line }) => ({ ...line, dollarCost: dollarCost({ ...row, orderValueCny: line.orderValueCny }) })),
      containers: carried.filter((container) => container.orderId === row.id).map(({ orderId: _orderId, ...container }) => container),
      /** The landed cost's parts (INR), null until the order has any cost (as landedCostInr). */
      landedCost:
        cost.totalInr > 0
          ? {
              goodsInr: cost.goodsInr,
              seaFreightInr: cost.seaFreightInr,
              clearingInr: cost.clearingInr,
              transportInr: cost.transportInr,
              totalInr: cost.totalInr,
              perPieceInr: cost.perPieceInr,
              final: cost.final,
              waitingFor: cost.waitingFor,
            }
          : null,
    };
  });

  const bySupplier = new Map<string, typeof rows>();
  for (const row of rows) bySupplier.set(row.supplier.id, [...(bySupplier.get(row.supplier.id) ?? []), row]);
  const suppliers = [...bySupplier.values()]
    .map((orders) => {
      const counted = orders.filter((row) => !row.held);
      return {
        supplier: { id: orders[0]!.supplier.id, name: orders[0]!.supplier.name },
        orders: orders.length,
        byCurrency: currencyTotals(orders),
        dollarCost: dollarCostTotal(counted.map((row) => row.dollarCost)),
        landedCostInr: round2(counted.reduce((total, row) => total + (row.landedCostInr ?? 0), 0)),
        rows: orders,
      };
    })
    .sort((a, b) => a.supplier.name.localeCompare(b.supplier.name));

  return { suppliers, summary: { ...report.summary, suppliers: suppliers.length }, filter: report.filter, options: report.options };
}
