import { asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

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
  supplierDeposits,
  supplierDepositTransactions,
  suppliers,
  teams,
  transportCompanies,
  transports,
  users,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import { notFound } from "../../http/errors";
import { atLeast, type Capability, effectiveAccess } from "../../permissions/matrix";
import { loadLandedCosts } from "../costs/landed-cost";
import { depositRows, summarise, toRow } from "../deposits/deposits.routes";
import { byCurrency } from "../master-data/supplier-insights";
import { orderClosed } from "../orders/closure";
import { depositState } from "../orders/money";
import { byPo, orderRows, round2, unitSymbol } from "../orders/orders.routes";
import { supplierMoney, toSupplier } from "./reports";

// Owner: Agent R. RPT-O1 GET /orders/:po/report (docs/phase2-contracts.md section 4.1; shape in 8.R; the
// comprehensive report's additions in docs/order-report.md): everything the per-order report page and its Excel, PDF
// and CSV show. A section the user can't view (effective access below View, as ORD-4 nulls its sections) is null and
// its queries never run. Money rules are the existing ones: paid and balance count supplier payments only (13.5
// `supplierMoney`); agent payments are sea freight, listed apart; the allocated cost share is `loadLandedCosts`,
// unchanged; clearing and trip costs on a container are that container's totals. Supplier deposits (migration 0008)
// are account-level money with no link to any order, so they are reported beside the order, never as its payments.
// Nothing here is stored or invented: the timeline has only dates the records hold, with the moment each record was
// written and the user who wrote it where the record keeps them.

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
  /** When the record behind the step was written (ISO timestamp): its creation, or its last change for a status step; null when derived (closed). */
  at: string | null;
  /** The user who wrote it, or null when the record keeps no author. */
  by: string | null;
};

/** "2,000.00 CNY": files and the timeline use the code, never a symbol. */
const money = (amount: number, currency: string) => `${amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const sum = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
const iso = (value: Date | string | null | undefined) => (value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString());
const orNull = (name: string | null | undefined) => (name?.trim() ? name : null);
/** Rows grouped by `key`, with the key left out of each row. */
function groupBy<K extends string, T extends Record<K, string>>(rows: T[], key: K) {
  const groups = new Map<string, Omit<T, K>[]>();
  for (const { [key]: id, ...rest } of rows) groups.set(id, [...(groups.get(id) ?? []), rest]);
  return groups;
}

const author = alias(users, "author");
const editor = alias(users, "editor");
const authorName = sql<string>`coalesce(${author.name}, '')`;
const editorName = sql<string>`coalesce(${editor.name}, '')`;
const paidToAgent = sql`${payments.orderId} = ${orders.id} and ${payments.payeeRole} = 'agent' and ${payments.status} = 'paid'`;

/** One order's report, or 404. About twenty queries whatever the order's size, none per row. */
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

  const [[header], lineRows, paymentList, receiptRows, containerList, containerLineRows, clearingRows, tripRows, receiptList, receiptLineRows, costs, account] =
    await Promise.all([
      db
        .select({
          code: suppliers.code,
          contactPerson: suppliers.contactPerson,
          phone: suppliers.phone,
          email: suppliers.email,
          country: suppliers.country,
          city: suppliers.city,
          state: suppliers.state,
          postalCode: suppliers.postalCode,
          address: suppliers.address,
          paymentTerms: suppliers.paymentTerms,
          taxNumber: suppliers.taxNumber,
          supplierNotes: suppliers.notes,
          supplierCurrency: suppliers.currency,
          supplierRate: suppliers.exchangeRate,
          supplierRateUpdatedAt: suppliers.rateUpdatedAt,
          supplierStatus: suppliers.status,
          createdAt: orders.createdAt,
          updatedAt: orders.updatedAt,
          createdBy: authorName,
          paidCny: supplierMoney.paidCny,
          paidInr: supplierMoney.paidInr,
          depositsPaidCny: sql<number>`(select coalesce(sum(${payments.amountCny}), 0) from ${payments}
            where ${toSupplier} and ${payments.status} = 'paid' and ${payments.kind} = 'Deposit')`.mapWith(Number),
          dueCny: sql<number>`(select coalesce(sum(${payments.amountCny}), 0) from ${payments} where ${toSupplier} and ${payments.status} = 'due')`.mapWith(Number),
          /** Paid to shipping agents: sea freight (landed cost), never part of the supplier's paid or balance. */
          agentPaidCny: sql<number>`(select coalesce(sum(${payments.amountCny}), 0) from ${payments} where ${paidToAgent})`.mapWith(Number),
          agentPaidInr: sql<number>`(select coalesce(sum(round(${payments.amountCny} * ${payments.rateInr}, 2)), 0) from ${payments} where ${paidToAgent})`.mapWith(Number),
        })
        .from(orders)
        .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
        .leftJoin(author, eq(author.id, orders.createdBy))
        .where(eq(orders.id, orderId)),
      db
        .select({
          id: orderLines.id,
          position: orderLines.position,
          itemId: items.id,
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
            recordedAt: payments.createdAt,
            recordedBy: authorName,
          })
          .from(payments)
          .leftJoin(author, eq(author.id, payments.createdBy))
          .where(eq(payments.orderId, orderId))
          .orderBy(asc(sql`coalesce(${payments.paidOn}, ${payments.dueDate})`), asc(payments.createdAt)),
      ),
      // China receipts: the China processing section and the timeline (the Items section carries the received figures).
      when(can("receiving"), () =>
        db
          .select({
            id: receipts.id,
            receivedOn: receipts.receivedOn,
            office: locations.name,
            receivedBy: authorName,
            bundles: receipts.bundles,
            deliveryNote: receipts.deliveryNote,
            shortRemark: receipts.shortRemark,
            recordedAt: receipts.createdAt,
            item: items.name,
            unit: unitSymbol,
            quantity: receiptLines.quantity,
          })
          .from(receipts)
          .innerJoin(locations, eq(locations.id, receipts.locationId))
          .leftJoin(author, eq(author.id, receipts.receivedBy))
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
            etaEstimated: containers.etaEstimated,
            recordedAt: containers.createdAt,
            recordedBy: authorName,
          })
          .from(containers)
          .innerJoin(shippingAgents, eq(shippingAgents.id, containers.shippingAgentId))
          .leftJoin(author, eq(author.id, containers.createdBy))
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
            /** Information only: not part of the clearing cost. */
            goodsValueInr: clearings.goodsValueInr,
            customsDutyInr: clearings.customsDutyInr,
            otherDutiesInr: clearings.otherDutiesInr,
            agentChargesInr: clearings.agentChargesInr,
            portChargesInr: clearings.portChargesInr,
            recordedAt: clearings.createdAt,
            recordedBy: authorName,
            updatedAt: clearings.updatedAt,
            updatedBy: editorName,
          })
          .from(clearings)
          .innerJoin(clearingAgents, eq(clearingAgents.id, clearings.clearingAgentId))
          .leftJoin(author, eq(author.id, clearings.createdBy))
          .leftJoin(editor, eq(editor.id, clearings.updatedBy))
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
            driverPhone: transports.driverPhone,
            destination: locations.name,
            loadedOn: transports.loadedOn,
            loadedFrom: transports.loadedFrom,
            loadedBy: transports.loadedBy,
            unloadedOn: transports.unloadedOn,
            bundlesLoaded: transports.bundlesLoaded,
            bundlesReceived: transports.bundlesReceived,
            receivedBy: transports.receivedBy,
            shortRemark: transports.shortRemark,
            status: transports.status,
            freightInr: transports.freightInr,
            handlingInr: transports.handlingInr,
            recordedAt: transports.createdAt,
            recordedBy: authorName,
            updatedAt: transports.updatedAt,
            updatedBy: editorName,
          })
          .from(transports)
          .innerJoin(transportCompanies, eq(transportCompanies.id, transports.transportCompanyId))
          .innerJoin(locations, eq(locations.id, transports.destinationId))
          .leftJoin(author, eq(author.id, transports.createdBy))
          .leftJoin(editor, eq(editor.id, transports.updatedBy))
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
            recordedAt: warehouseReceipts.createdAt,
            recordedBy: authorName,
            updatedAt: warehouseReceipts.updatedAt,
            updatedBy: editorName,
          })
          .from(warehouseReceipts)
          .innerJoin(transports, eq(transports.id, warehouseReceipts.transportId))
          .innerJoin(containers, eq(containers.id, transports.containerId))
          .innerJoin(locations, eq(locations.id, warehouseReceipts.locationId))
          .leftJoin(author, eq(author.id, warehouseReceipts.createdBy))
          .leftJoin(editor, eq(editor.id, warehouseReceipts.updatedBy))
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
      // The supplier's account beside this order (payments View, as the money is): every order's value, paid and
      // balance per currency, and the supplier-level deposits with their transactions, which no order payment counts.
      section("payments", async () => {
        const [perOrder, deposits] = await Promise.all([
          db
            .select({ id: orders.id, currency: orders.currency, closed: orderClosed, orderValueCny: supplierMoney.orderValueCny, paidCny: supplierMoney.paidCny })
            .from(orders)
            .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
            .where(eq(orders.supplierId, row.supplierId)),
          depositRows(db, eq(supplierDeposits.supplierId, row.supplierId)).then((rows) => rows.map(toRow)),
        ]);
        const t = supplierDepositTransactions;
        const transactions = deposits.length
          ? await db
              .select({ depositId: t.depositId, id: t.id, paidOn: t.paidOn, amount: t.amount, mode: t.mode, reference: t.reference, notes: t.notes })
              .from(t)
              .where(
                inArray(
                  t.depositId,
                  deposits.map((deposit) => deposit.id),
                ),
              )
              .orderBy(asc(t.paidOn), asc(t.createdAt))
          : [];
        const byDeposit = groupBy(transactions, "depositId");
        return {
          orders: perOrder.length,
          openOrders: perOrder.filter((order) => !order.closed).length,
          purchaseValue: byCurrency(perOrder, (order) => order.orderValueCny),
          paid: byCurrency(perOrder, (order) => order.paidCny),
          balance: byCurrency(perOrder, (order) => order.orderValueCny - order.paidCny),
          deposits: {
            summary: summarise(deposits),
            list: deposits.map(({ supplierId: _supplierId, supplier: _supplier, transactions: _count, ...deposit }) => ({ ...deposit, transactions: byDeposit.get(deposit.id) ?? [] })),
          },
        };
      }),
    ]);

  const lines = lineRows.map((line) => ({ ...line, excess: Math.max(0, line.received - line.ordered), short: Math.max(0, line.ordered - line.received), pending: Math.max(0, line.ordered - line.received) }));
  // Units differ per line (pieces, metres): one total per unit, never added together.
  const totals = [...new Set(lines.map((line) => line.unit))].map((unit) => {
    const inUnit = lines.filter((line) => line.unit === unit);
    const ordered = sum(inUnit, (line) => line.ordered);
    const receivedInUnit = sum(inUnit, (line) => line.received);
    return { unit, ordered, received: receivedInUnit, pending: Math.max(0, ordered - receivedInUnit), stocked: sum(inUnit, (line) => line.stocked) };
  });
  // One receipt per id, its lines in order-line order.
  const receiptsList = can("receiving")
    ? [...new Set(receiptRows.map((line) => line.id))].map((id) => {
        const inReceipt = receiptRows.filter((line) => line.id === id);
        const first = inReceipt[0]!;
        return {
          id,
          receivedOn: first.receivedOn,
          office: first.office,
          receivedBy: first.receivedBy,
          bundles: first.bundles,
          deliveryNote: first.deliveryNote,
          shortRemark: first.shortRemark,
          recordedAt: iso(first.recordedAt),
          lines: inReceipt.flatMap((line) => (line.item && line.unit ? [{ item: line.item, unit: line.unit, quantity: line.quantity ?? 0 }] : [])),
        };
      })
    : null;
  const linesIn = groupBy(containerLineRows, "containerId");
  // The record's author and last editor as names, null when the row keeps none (older rows, direct inserts).
  const authored = <T extends { recordedAt: Date; recordedBy: string; updatedAt: Date; updatedBy: string }>({ recordedAt, recordedBy, updatedAt, updatedBy, ...rest }: T) => ({
    ...rest,
    recordedAt: iso(recordedAt),
    recordedBy: orNull(recordedBy),
    updatedAt: iso(updatedAt),
    updatedBy: orNull(updatedBy),
  });
  const clearingOf = new Map(
    clearingRows.map(({ containerId, ...clearing }) => [
      containerId,
      { ...authored(clearing), totalInr: round2(clearing.customsDutyInr + clearing.otherDutiesInr + clearing.agentChargesInr + clearing.portChargesInr) },
    ]),
  );
  const tripOf = new Map(tripRows.map(({ containerId, ...trip }) => [containerId, { ...authored(trip), totalInr: round2(trip.freightInr + trip.handlingInr) }]));
  const logisticsList = !logistics
    ? null
    : containerList.map(({ recordedAt, recordedBy, ...container }) => ({
        ...container,
        recordedAt: iso(recordedAt),
        recordedBy: orNull(recordedBy),
        lines: linesIn.get(container.id) ?? [],
        clearing: clearingOf.get(container.id) ?? null,
        transport: tripOf.get(container.id) ?? null,
      }));
  const stockedLines = groupBy(receiptLineRows, "receiptId");
  const warehouse = receiptList && receiptList.map((receipt) => ({ ...authored(receipt), lines: stockedLines.get(receipt.receiptId) ?? [] }));

  // Dated steps only, in date order (a tie keeps the workflow order below); each from a section the user may see.
  const steps: TimelineStep[] = [{ step: "created", on: row.orderDate, detail: `Ordered from ${row.supplierName}`, at: iso(header!.createdAt), by: orNull(header!.createdBy) }];
  for (const payment of paymentList ?? []) {
    if (payment.paidOn) {
      steps.push({ step: payment.kind === "Deposit" ? "deposit" : "payment", on: payment.paidOn, detail: `${money(payment.amountCny, row.currency)} to ${payment.payee}`, at: iso(payment.recordedAt), by: orNull(payment.recordedBy) });
    }
  }
  for (const receipt of receiptsList ?? []) {
    const quantities = [...new Set(receipt.lines.map((line) => line.unit))].map((unit) => `${sum(receipt.lines, (line) => (line.unit === unit ? line.quantity : 0))} ${unit}`);
    steps.push({ step: "received", on: receipt.receivedOn, detail: [receipt.office, ...quantities].join(" · "), at: receipt.recordedAt, by: orNull(receipt.receivedBy) });
  }
  for (const container of logisticsList ?? []) {
    if (container.loadedOn) steps.push({ step: "loaded", on: container.loadedOn, detail: `${container.number} · ${container.agent}`, at: container.recordedAt, by: orNull(container.recordedBy) });
    if (container.sailedOn) steps.push({ step: "sailed", on: container.sailedOn, detail: container.number, at: null, by: null });
    if (container.clearing) {
      const { clearing } = container;
      steps.push({ step: "arrived", on: clearing.arrivedOn, detail: `${container.number} · ${clearing.agent}`, at: clearing.recordedAt, by: orNull(clearing.recordedBy) });
      if (clearing.clearedOn) steps.push({ step: "cleared", on: clearing.clearedOn, detail: container.number, at: clearing.updatedAt, by: orNull(clearing.updatedBy) });
    }
    if (container.transport) {
      const trip = container.transport;
      steps.push({ step: "dispatched", on: trip.loadedOn, detail: `${container.number} · ${trip.vehicleNumber} · LR ${trip.lrNumber}`, at: trip.recordedAt, by: orNull(trip.recordedBy) });
      if (trip.unloadedOn) steps.push({ step: "unloaded", on: trip.unloadedOn, detail: `${container.number} · ${trip.destination}`, at: trip.updatedAt, by: orNull(trip.updatedBy) });
    }
  }
  for (const receipt of warehouse ?? []) {
    if (receipt.status === "stocked") steps.push({ step: "stocked", on: receipt.receivedOn, detail: `${receipt.container} · ${receipt.warehouse}`, at: receipt.updatedAt, by: orNull(receipt.updatedBy) });
  }
  if (row.closedOn) steps.push({ step: "closed", on: row.closedOn, detail: "Every container stocked", at: null, by: null });
  steps.sort((a, b) => a.on.localeCompare(b.on));

  const paymentRows = paymentList?.map(({ recordedAt, recordedBy, ...payment }) => ({ ...payment, recordedAt: iso(recordedAt), recordedBy: orNull(recordedBy) }));
  return {
    order: {
      id: row.id,
      po: row.po,
      supplier: {
        id: row.supplierId,
        name: row.supplierName,
        code: header!.code,
        contactPerson: header!.contactPerson,
        phone: header!.phone,
        email: header!.email,
        country: header!.country,
        city: header!.city,
        state: header!.state,
        postalCode: header!.postalCode,
        address: header!.address,
        paymentTerms: header!.paymentTerms,
        taxNumber: header!.taxNumber,
        notes: header!.supplierNotes,
        currency: header!.supplierCurrency,
        /** The supplier's rate now, for new transactions; the order keeps its own `exchangeRate` below. */
        exchangeRate: header!.supplierRate,
        rateUpdatedAt: iso(header!.supplierRateUpdatedAt),
        status: header!.supplierStatus,
      },
      orderDate: row.orderDate,
      deliveryDate: row.deliveryDate,
      createdAt: iso(header!.createdAt),
      updatedAt: iso(header!.updatedAt),
      createdBy: orNull(header!.createdBy),
      stage: row.stage,
      closed: row.closed,
      closedOn: row.closedOn,
      currency: row.currency,
      orderValueCny: row.orderValueCny,
      /** The rate saved when the order was placed (null for older orders), and the PO value at that rate, never a later one. */
      exchangeRate: row.exchangeRate,
      orderValueInr: row.orderValueInr,
      products: lines.length,
      totals,
    },
    lines,
    payments: paymentRows
      ? {
          paidCny: header!.paidCny,
          paidInr: header!.paidInr,
          balanceCny: round2(row.orderValueCny - header!.paidCny),
          depositsPaidCny: header!.depositsPaidCny,
          dueCny: header!.dueCny,
          agentPaidCny: header!.agentPaidCny,
          agentPaidInr: header!.agentPaidInr,
          // The deposit the supplier asked for and what is still pending against it (0009).
          depositRequiredCny: row.depositRequiredCny,
          depositPendingCny: depositState(row.depositRequiredCny, row.depositPaidCny).depositPendingCny,
          depositStatus: depositState(row.depositRequiredCny, row.depositPaidCny).depositStatus,
          list: paymentRows,
        }
      : null,
    supplierAccount: account,
    receipts: receiptsList,
    logistics: logisticsList,
    warehouse,
    landedCost: costs ? costs.get(orderId)! : null,
    timeline: steps,
  };
}
