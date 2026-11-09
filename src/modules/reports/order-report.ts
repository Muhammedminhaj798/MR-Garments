import { asc, eq, inArray, sql } from "drizzle-orm";

import type { CurrentUser } from "../../auth/current-user";
import type { Database } from "../../db/client";
import {
  clearingAgents,
  clearings,
  containerLines,
  containers,
  items,
  locations,
  orderLines,
  orders,
  payments,
  receiptLines,
  receipts,
  shippingAgents,
  suppliers,
  teams,
  transportCompanies,
  transports,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import { notFound } from "../../http/errors";
import { atLeast, type Capability, effectiveAccess } from "../../permissions/matrix";
import { loadLandedCosts } from "../costs/landed-cost";
import { depositState } from "../orders/money";
import { byPo, orderRows, round2, unitSymbol } from "../orders/orders.routes";
import { supplierMoney, toSupplier } from "./reports";

// Owner: Agent R. RPT-O1 GET /orders/:po/report (docs/phase2-contracts.md section 4.1; shape in 8.R): everything the
// per-order report page and its Excel/PDF show. A section the user can't view (effective access below View, as
// ORD-4 nulls its sections) is null and its queries never run. Money rules are the existing ones: paid and balance
// count supplier payments only (13.5 `supplierMoney`); the allocated cost share is `loadLandedCosts`, unchanged;
// clearing and trip costs on a container are that container's totals. Nothing here is stored or invented: the
// timeline has only dates the records hold.

// Per order line, correlated on `orderLines.id` (inside a select with a join, so the columns keep their table).
const received = sql<number>`(select coalesce(sum(${receiptLines.quantity}), 0) from ${receiptLines} where ${receiptLines.orderLineId} = ${orderLines.id})`.mapWith(Number);
const loaded = sql<number>`(select coalesce(sum(${containerLines.quantity}), 0) from ${containerLines} where ${containerLines.orderLineId} = ${orderLines.id})`.mapWith(Number);
const stocked = sql<number>`(select coalesce(sum(${warehouseReceiptLines.quantity}), 0) from ${warehouseReceiptLines}
  join ${warehouseReceipts} on ${warehouseReceipts.id} = ${warehouseReceiptLines.receiptId} and ${warehouseReceipts.status} = 'stocked'
  where ${warehouseReceiptLines.orderLineId} = ${orderLines.id})`.mapWith(Number);

export type TimelineStep = {
  step: "created" | "deposit" | "payment" | "received" | "loaded" | "sailed" | "arrived" | "cleared" | "dispatched" | "unloaded" | "stocked" | "closed";
  on: string;
  detail: string;
};

/** "2,000.00 CNY": files and the timeline use the code, never a symbol. */
const money = (amount: number, currency: string) => `${amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const sum = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
/** Rows grouped by `key`, with the key left out of each row. */
function groupBy<K extends string, T extends Record<K, string>>(rows: T[], key: K) {
  const groups = new Map<string, Omit<T, K>[]>();
  for (const { [key]: id, ...rest } of rows) groups.set(id, [...(groups.get(id) ?? []), rest]);
  return groups;
}

/** One order's report, or 404. About fifteen queries whatever the order's size, none per row. */
export async function orderReport(db: Database, po: string, user: CurrentUser) {
  const row = (await orderRows(db, [], byPo(po)))[0];
  if (!row) throw notFound("Order");
  const orderId = row.id;
  const can = (capability: Capability) => atLeast(effectiveAccess(user.role, user.stages, capability), "View");
  const section = <T>(capability: Capability, query: () => Promise<T>) => (can(capability) ? query() : Promise.resolve(null));
  /** A nested list the user may see; empty otherwise (its parent section says whether it is shown at all). */
  const when = <T>(allowed: boolean, query: () => Promise<T[]>) => (allowed ? query() : Promise.resolve([] as T[]));
  // The containers carrying any of the order's goods (as loadLandedCosts finds them).
  const carriers = db
    .select({ id: containerLines.containerId })
    .from(containerLines)
    .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
    .where(eq(orderLines.orderId, orderId));
  const logistics = can("containers");

  const [[header], lineRows, paymentList, receiptRows, containerList, containerLineRows, clearingRows, tripRows, receiptList, receiptLineRows, costs] =
    await Promise.all([
      db
        .select({
          contactPerson: suppliers.contactPerson,
          phone: suppliers.phone,
          city: suppliers.city,
          paidCny: supplierMoney.paidCny,
          paidInr: supplierMoney.paidInr,
          depositsPaidCny: sql<number>`(select coalesce(sum(${payments.amountCny}), 0) from ${payments}
            where ${toSupplier} and ${payments.status} = 'paid' and ${payments.kind} = 'Deposit')`.mapWith(Number),
          dueCny: sql<number>`(select coalesce(sum(${payments.amountCny}), 0) from ${payments} where ${toSupplier} and ${payments.status} = 'due')`.mapWith(Number),
        })
        .from(orders)
        .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
        .where(eq(orders.id, orderId)),
      db
        .select({
          id: orderLines.id,
          position: orderLines.position,
          item: items.name,
          unit: unitSymbol,
          ordered: orderLines.quantity,
          received,
          loaded,
          stocked,
          rateCny: orderLines.rateCny,
          valueCny: sql<number>`round(${orderLines.quantity} * ${orderLines.rateCny}, 2)`.mapWith(Number),
        })
        .from(orderLines)
        .innerJoin(items, eq(items.id, orderLines.itemId))
        .where(eq(orderLines.orderId, orderId))
        .orderBy(asc(orderLines.position)),
      section("payments", () =>
        db
          .select({
            id: payments.id,
            kind: payments.kind,
            payee: payments.payee,
            payeeRole: payments.payeeRole,
            amountCny: payments.amountCny,
            amountInr: sql<number | null>`case when ${payments.status} = 'paid' then round(${payments.amountCny} * ${payments.rateInr}, 2) end`.mapWith(Number),
            status: payments.status,
            paidOn: payments.paidOn,
            dueDate: payments.dueDate,
            rateInr: payments.rateInr,
            mode: payments.mode,
            reference: payments.reference,
            notes: payments.notes,
          })
          .from(payments)
          .where(eq(payments.orderId, orderId))
          .orderBy(asc(sql`coalesce(${payments.paidOn}, ${payments.dueDate})`), asc(payments.createdAt)),
      ),
      // China receipts feed the timeline only (the Items section carries the received figures).
      when(can("receiving"), () =>
        db
          .select({
            id: receipts.id,
            receivedOn: receipts.receivedOn,
            office: locations.name,
            unit: unitSymbol,
            quantity: receiptLines.quantity,
          })
          .from(receipts)
          .innerJoin(locations, eq(locations.id, receipts.locationId))
          .leftJoin(receiptLines, eq(receiptLines.receiptId, receipts.id))
          .leftJoin(orderLines, eq(orderLines.id, receiptLines.orderLineId))
          .leftJoin(items, eq(items.id, orderLines.itemId))
          .where(eq(receipts.orderId, orderId))
          .orderBy(asc(receipts.receivedOn), asc(receipts.createdAt), asc(orderLines.position)),
      ),
      when(logistics, () =>
        db
          .select({
            id: containers.id,
            number: containers.number,
            status: containers.status,
            terms: containers.terms,
            agent: shippingAgents.name,
            portOfLoading: containers.portOfLoading,
            portOfArrival: containers.portOfArrival,
            loadedOn: containers.loadedOn,
            sailedOn: containers.sailedOn,
            eta: containers.eta,
          })
          .from(containers)
          .innerJoin(shippingAgents, eq(shippingAgents.id, containers.shippingAgentId))
          .where(inArray(containers.id, carriers))
          .orderBy(asc(containers.loadedOn), asc(containers.createdAt)),
      ),
      // Only this order's lines: a shared container shows just this order's goods.
      when(logistics, () =>
        db
          .select({ containerId: containerLines.containerId, orderLineId: containerLines.orderLineId, item: items.name, unit: unitSymbol, bundles: containerLines.bundles, quantity: containerLines.quantity })
          .from(containerLines)
          .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
          .innerJoin(items, eq(items.id, orderLines.itemId))
          .where(eq(orderLines.orderId, orderId))
          .orderBy(asc(orderLines.position)),
      ),
      when(logistics && can("clearing"), () =>
        db
          .select({
            containerId: clearings.containerId,
            id: clearings.id,
            agent: clearingAgents.name,
            arrivedOn: clearings.arrivedOn,
            handedOn: clearings.handedOn,
            billOfEntry: clearings.billOfEntry,
            dutyPaidOn: clearings.dutyPaidOn,
            clearedOn: clearings.clearedOn,
            status: clearings.status,
            customsDutyInr: clearings.customsDutyInr,
            otherDutiesInr: clearings.otherDutiesInr,
            agentChargesInr: clearings.agentChargesInr,
            portChargesInr: clearings.portChargesInr,
          })
          .from(clearings)
          .innerJoin(clearingAgents, eq(clearingAgents.id, clearings.clearingAgentId))
          .where(inArray(clearings.containerId, carriers)),
      ),
      when(logistics && can("transport"), () =>
        db
          .select({
            containerId: transports.containerId,
            id: transports.id,
            company: transportCompanies.name,
            lrNumber: transports.lrNumber,
            vehicleNumber: transports.vehicleNumber,
            driverName: transports.driverName,
            destination: locations.name,
            loadedOn: transports.loadedOn,
            unloadedOn: transports.unloadedOn,
            bundlesLoaded: transports.bundlesLoaded,
            bundlesReceived: transports.bundlesReceived,
            status: transports.status,
            freightInr: transports.freightInr,
            handlingInr: transports.handlingInr,
          })
          .from(transports)
          .innerJoin(transportCompanies, eq(transportCompanies.id, transports.transportCompanyId))
          .innerJoin(locations, eq(locations.id, transports.destinationId))
          .where(inArray(transports.containerId, carriers)),
      ),
      // Every receipt (draft or stocked) of a trip carrying the order's goods: a draft may hold none of its lines yet.
      section("warehouse", () =>
        db
          .select({
            receiptId: warehouseReceipts.id,
            transportId: warehouseReceipts.transportId,
            container: containers.number,
            warehouse: locations.name,
            receivedOn: warehouseReceipts.receivedOn,
            receivedBy: warehouseReceipts.receivedBy,
            status: warehouseReceipts.status,
            bundlesReceived: warehouseReceipts.bundlesReceived,
          })
          .from(warehouseReceipts)
          .innerJoin(transports, eq(transports.id, warehouseReceipts.transportId))
          .innerJoin(containers, eq(containers.id, transports.containerId))
          .innerJoin(locations, eq(locations.id, warehouseReceipts.locationId))
          .where(inArray(transports.containerId, carriers))
          .orderBy(asc(warehouseReceipts.receivedOn), asc(warehouseReceipts.createdAt)),
      ),
      when(can("warehouse"), () =>
        db
          .select({ receiptId: warehouseReceiptLines.receiptId, item: items.name, unit: unitSymbol, team: teams.name, quantity: warehouseReceiptLines.quantity })
          .from(warehouseReceiptLines)
          .innerJoin(orderLines, eq(orderLines.id, warehouseReceiptLines.orderLineId))
          .innerJoin(items, eq(items.id, orderLines.itemId))
          .innerJoin(teams, eq(teams.id, warehouseReceiptLines.teamId))
          .where(eq(orderLines.orderId, orderId))
          .orderBy(asc(orderLines.position), asc(teams.createdAt), asc(teams.name)),
      ),
      section("landedCost", () => loadLandedCosts(db, [orderId])),
    ]);

  const lines = lineRows.map((line) => ({ ...line, excess: Math.max(0, line.received - line.ordered), short: Math.max(0, line.ordered - line.received) }));
  // Units differ per line (pieces, metres): one total per unit, never added together.
  const totals = [...new Set(lines.map((line) => line.unit))].map((unit) => {
    const inUnit = lines.filter((line) => line.unit === unit);
    return { unit, ordered: sum(inUnit, (line) => line.ordered), received: sum(inUnit, (line) => line.received), stocked: sum(inUnit, (line) => line.stocked) };
  });
  const linesIn = groupBy(containerLineRows, "containerId");
  const clearingOf = new Map(
    clearingRows.map(({ containerId, ...clearing }) => [
      containerId,
      { ...clearing, totalInr: round2(clearing.customsDutyInr + clearing.otherDutiesInr + clearing.agentChargesInr + clearing.portChargesInr) },
    ]),
  );
  const tripOf = new Map(tripRows.map(({ containerId, ...trip }) => [containerId, { ...trip, totalInr: round2(trip.freightInr + trip.handlingInr) }]));
  const logisticsList = !logistics
    ? null
    : containerList.map((container) => ({
      ...container,
      lines: linesIn.get(container.id) ?? [],
      clearing: clearingOf.get(container.id) ?? null,
      transport: tripOf.get(container.id) ?? null,
    }));
  const stockedLines = groupBy(receiptLineRows, "receiptId");
  const warehouse = receiptList && receiptList.map((receipt) => ({ ...receipt, lines: stockedLines.get(receipt.receiptId) ?? [] }));

  // Dated steps only, in date order (a tie keeps the workflow order below); each from a section the user may see.
  const steps: TimelineStep[] = [{ step: "created", on: row.orderDate, detail: `Ordered from ${row.supplierName}` }];
  for (const payment of paymentList ?? []) {
    if (payment.paidOn) steps.push({ step: payment.kind === "Deposit" ? "deposit" : "payment", on: payment.paidOn, detail: `${money(payment.amountCny, row.currency)} to ${payment.payee}` });
  }
  for (const id of new Set(receiptRows.map((line) => line.id))) {
    const inReceipt = receiptRows.filter((line) => line.id === id);
    const quantities = [...new Set(inReceipt.flatMap((line) => (line.unit ? [line.unit] : [])))].map(
      (unit) => `${sum(inReceipt, (line) => (line.unit === unit ? (line.quantity ?? 0) : 0))} ${unit}`,
    );
    steps.push({ step: "received", on: inReceipt[0]!.receivedOn, detail: [inReceipt[0]!.office, ...quantities].join(" · ") });
  }
  for (const container of logisticsList ?? []) {
    if (container.loadedOn) steps.push({ step: "loaded", on: container.loadedOn, detail: `${container.number} · ${container.agent}` });
    if (container.sailedOn) steps.push({ step: "sailed", on: container.sailedOn, detail: container.number });
    if (container.clearing) {
      steps.push({ step: "arrived", on: container.clearing.arrivedOn, detail: `${container.number} · ${container.clearing.agent}` });
      if (container.clearing.clearedOn) steps.push({ step: "cleared", on: container.clearing.clearedOn, detail: container.number });
    }
    if (container.transport) {
      const trip = container.transport;
      steps.push({ step: "dispatched", on: trip.loadedOn, detail: `${container.number} · ${trip.vehicleNumber} · LR ${trip.lrNumber}` });
      if (trip.unloadedOn) steps.push({ step: "unloaded", on: trip.unloadedOn, detail: `${container.number} · ${trip.destination}` });
    }
  }
  for (const receipt of warehouse ?? []) {
    if (receipt.status === "stocked") steps.push({ step: "stocked", on: receipt.receivedOn, detail: `${receipt.container} · ${receipt.warehouse}` });
  }
  if (row.closedOn) steps.push({ step: "closed", on: row.closedOn, detail: "Every container stocked" });
  steps.sort((a, b) => a.on.localeCompare(b.on));

  return {
    order: {
      id: row.id,
      po: row.po,
      supplier: { id: row.supplierId, name: row.supplierName, contactPerson: header!.contactPerson, phone: header!.phone, city: header!.city },
      orderDate: row.orderDate,
      deliveryDate: row.deliveryDate,
      stage: row.stage,
      closed: row.closed,
      closedOn: row.closedOn,
      currency: row.currency,
      orderValueCny: row.orderValueCny,
      totals,
    },
    lines,
    payments: paymentList
      ? {
          paidCny: header!.paidCny,
          paidInr: header!.paidInr,
          balanceCny: round2(row.orderValueCny - header!.paidCny),
          depositsPaidCny: header!.depositsPaidCny,
          dueCny: header!.dueCny,
          // The deposit the supplier asked for and what is still pending against it (0009).
          depositRequiredCny: row.depositRequiredCny,
          depositPendingCny: depositState(row.depositRequiredCny, row.depositPaidCny).depositPendingCny,
          depositStatus: depositState(row.depositRequiredCny, row.depositPaidCny).depositStatus,
          list: paymentList,
        }
      : null,
    logistics: logisticsList,
    warehouse,
    landedCost: costs ? costs.get(orderId)! : null,
    timeline: steps,
  };
}
