import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import {
  containerLines,
  type Currency,
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
  TERMS,
  users,
} from "../../db/schema";
import { conflict, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import { atLeast, effectiveAccess } from "../../permissions/matrix";
import type { RouteContext } from "../context";
import { unitSymbol } from "../orders/orders.routes";
import { day, notify, qty } from "../notifications/notify";
import { joined } from "../orders/order-detail.routes";
import { settleStages } from "../stages-shared";
import { isUuid } from "../stages/common";

// Owner: BE-stock. REC-1 GET /receipts, REC-2 GET /receipts/options, REC-3 POST /receipts, REC-4 DELETE /receipts/:id,
// CON-1 GET /containers, CON-2 GET /containers/options, CON-3 POST /containers (docs/live-screens-contracts.md).

export const MESSAGES = {
  order: "Choose an order from the list.",
  receivedOn: "Enter the date received.",
  receivedOnFuture: "The received date can't be after today.",
  office: "Choose a China office from the list.",
  bundles: "Enter the number of bundles (0 or more).",
  receiptQuantity: "Quantities must be whole numbers, 0 or more.",
  nothingReceived: "Enter a quantity for at least one line.",
  duplicateLine: "Each line can appear only once.",
  notOnOrder: "Some lines aren't on this order.",
  notReceivable: "This order is past receiving and can't take more receipts.",
  shortRemark: "Add a remark about the short items.",
  number: "Enter the container number.",
  numberTaken: "A container with this number already exists.",
  agent: "Choose a shipping agent from the list.",
  terms: "Choose FOB or CNF.",
  loadedOn: "Enter the loading date.",
  sailedOn: "Enter a valid sailing date.",
  eta: "Enter the ETA.",
  etaBeforeLoading: "The ETA can't be before the loading date.",
  noLines: "Add at least one line.",
  loadQuantity: "Loaded quantities must be whole numbers above 0, bundles 0 or more.",
  unknownLine: "Choose lines from the list.",
  notLoadable: (po: string) => `${po} can't be loaded: only orders being received or loaded.`,
  overLoad: (item: string, po: string, left: number, unit: string) => `${item} (${po}): only ${left} ${unit} left to load.`,
  // Proposed wording (REC-4).
  receiptLoaded: (goods: string[], numbers: string[]) =>
    numbers.length === 1
      ? `This receipt can't be deleted: container ${numbers[0]} already holds ${joined(goods)} from it. Delete that container first.`
      : `This receipt can't be deleted: containers ${joined(numbers)} already hold ${joined(goods)} from it. Delete those containers first.`,
};

/** Today in India (Asia/Kolkata, UTC+5:30, no daylight saving) as YYYY-MM-DD. */
const todayInIndia = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

const text = z.string().trim().default("");
const date = (message: string) => z.iso.date({ error: message });
const distinctLines = (lines: { orderLineId: string }[]) => new Set(lines.map((line) => line.orderLineId)).size === lines.length;

const newReceipt = z.strictObject({
  orderId: z.uuid({ error: MESSAGES.order }),
  receivedOn: date(MESSAGES.receivedOn).refine((day) => day <= todayInIndia(), MESSAGES.receivedOnFuture),
  locationId: z.uuid({ error: MESSAGES.office }),
  bundles: z.number({ error: MESSAGES.bundles }).int(MESSAGES.bundles).min(0, MESSAGES.bundles).max(2_147_483_647, MESSAGES.bundles),
  deliveryNote: text,
  shortRemark: text,
  lines: z
    .array(
      z.strictObject({
        orderLineId: z.uuid({ error: MESSAGES.notOnOrder }),
        quantity: z.number({ error: MESSAGES.receiptQuantity }).int(MESSAGES.receiptQuantity).min(0, MESSAGES.receiptQuantity),
      }),
      { error: MESSAGES.nothingReceived },
    )
    .max(50, MESSAGES.notOnOrder)
    .refine(distinctLines, MESSAGES.duplicateLine)
    .refine((lines) => lines.some((line) => line.quantity > 0), MESSAGES.nothingReceived),
});

const newContainer = z.strictObject({
  number: z.string({ error: MESSAGES.number }).trim().min(1, MESSAGES.number),
  shippingAgentId: z.uuid({ error: MESSAGES.agent }),
  terms: z.enum(TERMS, { error: MESSAGES.terms }),
  portOfLoading: text,
  portOfArrival: text,
  loadedOn: date(MESSAGES.loadedOn),
  sailedOn: date(MESSAGES.sailedOn).nullable().default(null),
  eta: date(MESSAGES.eta),
  lines: z
    .array(
      z.strictObject({
        orderLineId: z.uuid({ error: MESSAGES.unknownLine }),
        bundles: z.number({ error: MESSAGES.loadQuantity }).int(MESSAGES.loadQuantity).min(0, MESSAGES.loadQuantity).max(2_147_483_647, MESSAGES.loadQuantity),
        quantity: z.number({ error: MESSAGES.loadQuantity }).int(MESSAGES.loadQuantity).min(1, MESSAGES.loadQuantity),
      }),
      { error: MESSAGES.noLines },
    )
    .min(1, MESSAGES.noLines)
    .max(100, MESSAGES.unknownLine)
    .refine(distinctLines, MESSAGES.duplicateLine),
});

// Per order line: everything received, and everything loaded into any container (contracts, Conventions).
const receivedOf = () =>
  sql<number>`(select coalesce(sum(${receiptLines.quantity}), 0) from ${receiptLines} where ${receiptLines.orderLineId} = ${orderLines.id})`.mapWith(
    Number,
  );
const loadedOf = () =>
  sql<number>`(select coalesce(sum(${containerLines.quantity}), 0) from ${containerLines} where ${containerLines.orderLineId} = ${orderLines.id})`.mapWith(
    Number,
  );

/**
 * A receipt's goods already in containers: per line, the part of `loaded` the order's other receipts can't cover
 * (received may never fall below loaded). REC-4 refuses while there is any; REC-1 names the containers holding them.
 */
const loadedFrom = <L extends { quantity: number | null; received: number; loaded: number }>(lines: L[]) =>
  lines.flatMap((line) => {
    const fromIt = line.quantity === null ? 0 : Math.min(line.quantity, line.loaded - (line.received - line.quantity));
    return fromIt > 0 ? [{ ...line, fromIt }] : [];
  });

// Aliases render as their bare name inside sql``, so their FROM clauses name the table first.
const earlier = alias(receipts, "earlier");
const allLines = alias(orderLines, "all_lines");
const mainLine = and(eq(orderLines.orderId, orders.id), eq(orderLines.position, 0));

export function stockRoutes({ db }: RouteContext) {
  const router = Router();

  // REC-1. Main-line figures; totalSoFar counts this receipt and every one received before it (date, then entry time).
  router.get("/receipts", requirePermission("receiving", "View"), async (_req, res) => {
    const rows = await db
      .select({
        id: receipts.id,
        receivedOn: receipts.receivedOn,
        orderId: orders.id,
        po: orders.poNumber,
        supplier: suppliers.name,
        item: items.name,
        office: locations.name,
        ordered: orderLines.quantity,
        unit: unitSymbol,
        thisReceipt: sql<number>`coalesce((select ${receiptLines.quantity} from ${receiptLines}
          where ${receiptLines.receiptId} = ${receipts.id} and ${receiptLines.orderLineId} = ${orderLines.id}), 0)`.mapWith(Number),
        totalSoFar: sql<number>`(select coalesce(sum(${receiptLines.quantity}), 0) from ${receiptLines}
          join ${receipts} ${earlier} on ${earlier.id} = ${receiptLines.receiptId}
          where ${receiptLines.orderLineId} = ${orderLines.id}
            and (${earlier.receivedOn}, ${earlier.createdAt}) <= (${receipts.receivedOn}, ${receipts.createdAt}))`.mapWith(Number),
        bundles: receipts.bundles,
        receivedBy: users.name,
        // The receipt's notes, for the report download (docs/report-downloads.md).
        deliveryNote: receipts.deliveryNote,
        shortRemark: receipts.shortRemark,
      })
      .from(receipts)
      .innerJoin(orders, eq(orders.id, receipts.orderId))
      .innerJoin(orderLines, mainLine)
      .innerJoin(items, eq(items.id, orderLines.itemId))
      .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
      .innerJoin(locations, eq(locations.id, receipts.locationId))
      .leftJoin(users, eq(users.id, receipts.receivedBy))
      .orderBy(desc(receipts.receivedOn), desc(receipts.createdAt));
    // Every receipt's lines, and the containers holding goods only that receipt covers: what REC-4 names when it refuses.
    const lines = await db
      .select({
        receiptId: receiptLines.receiptId,
        orderLineId: orderLines.id,
        quantity: receiptLines.quantity,
        item: items.name,
        unit: unitSymbol,
        ordered: orderLines.quantity,
        received: receivedOf(),
        loaded: loadedOf(),
      })
      .from(receiptLines)
      .innerJoin(orderLines, eq(orderLines.id, receiptLines.orderLineId))
      .innerJoin(items, eq(items.id, orderLines.itemId))
      .orderBy(asc(orderLines.position));
    const held = await db
      .selectDistinct({ orderLineId: containerLines.orderLineId, number: containers.number })
      .from(containerLines)
      .innerJoin(containers, eq(containers.id, containerLines.containerId))
      .orderBy(asc(containers.number));
    const linesOf = new Map<string, typeof lines>();
    for (const line of lines) {
      if (!linesOf.has(line.receiptId)) linesOf.set(line.receiptId, []);
      linesOf.get(line.receiptId)!.push(line);
    }
    res.json(
      rows.map(({ receivedBy, ...row }) => {
        const own = linesOf.get(row.id) ?? [];
        const loaded = new Set(loadedFrom(own).map((line) => line.orderLineId));
        return {
          ...row,
          receivedBy: receivedBy ?? "",
          // `ordered`: the order line's quantity; `received`: that line's total over every receipt so far.
          lines: own
            .filter((line) => line.quantity > 0)
            .map((line) => ({ item: line.item, unit: line.unit, quantity: line.quantity, ordered: line.ordered, received: line.received })),
          containers: [...new Set(held.filter((h) => loaded.has(h.orderLineId)).map((h) => h.number))],
        };
      }),
    );
  });

  // REC-2. Orders at stage 1-2, with only the lines that still have something to receive. The money fields are null,
  // and never queried, unless the user may view payments (China staff can't: matrix "Deposits and payments").
  router.get("/receipts/options", requirePermission("receiving", "Enter"), async (req, res) => {
    const money = atLeast(effectiveAccess(req.user!.role, req.user!.stages, "payments"), "View");
    const hidden = () => sql<null>`null`;
    const offices = await db
      .select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(and(eq(locations.type, "China office"), eq(locations.status, "Active")))
      .orderBy(asc(locations.createdAt), asc(locations.name));
    const received = receivedOf();
    const rows = await db
      .select({
        orderId: orders.id,
        po: orders.poNumber,
        supplier: suppliers.name,
        // Not money: the currency of the (possibly withheld) amounts.
        currency: orders.currency,
        orderValueCny: money
          ? sql<number>`(select coalesce(round(sum(${allLines.quantity} * ${allLines.rateCny}), 2), 0) from ${orderLines} ${allLines}
          where ${allLines.orderId} = ${orders.id})`.mapWith(Number)
          : hidden(),
        depositsPaidCny: money
          ? sql<number>`(select coalesce(sum(${payments.amountCny}), 0) from ${payments}
          where ${payments.orderId} = ${orders.id} and ${payments.kind} = 'Deposit' and ${payments.status} = 'paid' and ${payments.payeeRole} = 'supplier')`.mapWith(Number)
          : hidden(),
        orderLineId: orderLines.id,
        item: items.name,
        unit: unitSymbol,
        ordered: orderLines.quantity,
        receivedEarlier: received,
        unitPriceCny: money ? orderLines.rateCny : hidden(),
      })
      .from(orders)
      .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
      .innerJoin(orderLines, eq(orderLines.orderId, orders.id))
      .innerJoin(items, eq(items.id, orderLines.itemId))
      .where(and(inArray(orders.stage, [1, 2]), sql`${received} < ${orderLines.quantity}`))
      .orderBy(desc(orders.orderDate), desc(orders.createdAt), asc(orderLines.position));
    const byOrder = new Map<string, { orderId: string; po: string; supplier: string; currency: Currency; orderValueCny: number | null; depositsPaidCny: number | null; lines: object[] }>();
    for (const { orderLineId, item, unit, ordered, receivedEarlier, unitPriceCny, ...order } of rows) {
      if (!byOrder.has(order.orderId)) byOrder.set(order.orderId, { ...order, lines: [] });
      byOrder.get(order.orderId)!.lines.push({ orderLineId, item, unit, ordered, receivedEarlier, unitPriceCny });
    }
    res.json({ offices, orders: [...byOrder.values()] });
  });

  // REC-3. One transaction with the order row locked (CON-3 and REC-4 lock it too). A line may receive more than was
  // ordered, since suppliers deliver more at times (2026-11-06): nothing caps the quantity, and short is never negative.
  router.post("/receipts", requirePermission("receiving", "Enter"), async (req, res) => {
    const input = parse(newReceipt, req.body);
    const id = await db.transaction(async (tx) => {
      const order = (await tx.select({ id: orders.id, stage: orders.stage }).from(orders).where(eq(orders.id, input.orderId)).for("update"))[0];
      if (!order) throw validationFailed({ orderId: MESSAGES.order });
      if (order.stage > 2) throw conflict("order_not_receivable", MESSAGES.notReceivable);

      const problems: Record<string, string> = {};
      const office = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.id, input.locationId), eq(locations.type, "China office"), eq(locations.status, "Active")));
      if (office.length === 0) problems.locationId = MESSAGES.office;
      const lines = await tx
        .select({ id: orderLines.id, ordered: orderLines.quantity, received: receivedOf(), item: items.name, unit: unitSymbol })
        .from(orderLines)
        .innerJoin(items, eq(items.id, orderLines.itemId))
        .where(eq(orderLines.orderId, order.id));
      const byId = new Map(lines.map((line) => [line.id, line]));
      if (input.lines.some((line) => !byId.has(line.orderLineId))) problems.lines = MESSAGES.notOnOrder;
      // Screen 21: a remark is required while any line of the order is still short after this receipt.
      const now = new Map(input.lines.map((line) => [line.orderLineId, line.quantity]));
      const short = lines
        .map((line) => ({ ...line, left: line.ordered - line.received - (now.get(line.id) ?? 0) }))
        .filter((line) => line.left > 0);
      if (!problems.lines && short.length > 0 && !input.shortRemark) problems.shortRemark = MESSAGES.shortRemark;
      if (Object.keys(problems).length > 0) throw validationFailed(problems);

      const { lines: bodyLines, ...values } = input;
      const created = (await tx.insert(receipts).values({ ...values, receivedBy: req.user!.id }).returning({ id: receipts.id }))[0]!;
      await tx.insert(receiptLines).values(bodyLines.map((line) => ({ ...line, receiptId: created.id })));
      if (order.stage === 1) await tx.update(orders).set({ stage: 2 }).where(eq(orders.id, order.id));
      if (short.length > 0) {
        const { po, supplier } = (
          await tx
            .select({ po: orders.poNumber, supplier: suppliers.name })
            .from(orders)
            .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
            .where(eq(orders.id, order.id))
        )[0]!;
        const line = short[0]!;
        await notify(tx, {
          kind: "short-receipt",
          actorId: req.user!.id,
          sourceId: created.id,
          title: `${po} received short`,
          details: [supplier, short.length === 1 ? `${line.item} short by ${qty(line.left, line.unit)}` : `${short.length} lines short`],
          href: (canView) => (canView("ordersView") ? `/orders/${encodeURIComponent(po)}/receiving` : "/receiving"),
        });
      }
      return created.id;
    });
    res.status(201).json({ receipt: { id } });
  });

  // REC-4. Management only (receiving Full). One transaction with the order row locked, as REC-3 and CON-3 lock it, so
  // no load can land between the check and the delete. Received may never fall below loaded: goods of this receipt
  // already in a container refuse it. Only the receipt and its own lines go; the order steps back (settleStages), and
  // payments and notifications stay.
  router.delete("/receipts/:id", requirePermission("receiving", "Full"), async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Receipt");
    const po = await db.transaction(async (tx) => {
      const found = (await tx.select({ orderId: receipts.orderId }).from(receipts).where(eq(receipts.id, id)))[0];
      if (!found) throw notFound("Receipt");
      const order = (await tx.select({ id: orders.id, po: orders.poNumber }).from(orders).where(eq(orders.id, found.orderId)).for("update"))[0]!;
      // Read again under the lock: a delete of the same receipt that got there first leaves nothing (404).
      const lines = await tx
        .select({ quantity: receiptLines.quantity, orderLineId: orderLines.id, received: receivedOf(), loaded: loadedOf(), item: items.name, unit: unitSymbol })
        .from(receipts)
        .leftJoin(receiptLines, eq(receiptLines.receiptId, receipts.id))
        .leftJoin(orderLines, eq(orderLines.id, receiptLines.orderLineId))
        .leftJoin(items, eq(items.id, orderLines.itemId))
        .where(eq(receipts.id, id))
        .orderBy(asc(orderLines.position));
      if (lines.length === 0) throw notFound("Receipt");
      const inContainers = loadedFrom(lines);
      if (inContainers.length > 0) {
        const holding = await tx
          .selectDistinct({ number: containers.number })
          .from(containerLines)
          .innerJoin(containers, eq(containers.id, containerLines.containerId))
          .where(inArray(containerLines.orderLineId, inContainers.map((line) => line.orderLineId!)))
          .orderBy(asc(containers.number));
        const goods = inContainers.map((line) => `${qty(line.fromIt, line.unit!)} of ${line.item}`);
        throw conflict("in_use", MESSAGES.receiptLoaded(goods, holding.map((container) => container.number)));
      }
      await tx.delete(receipts).where(eq(receipts.id, id));
      await settleStages(tx, [order.id]);
      return order.po;
    });
    // ponytail: the server log is the deletion record; an audit table needs a migration, add one when audits are asked for.
    console.info(`Receipt ${id} of ${po} deleted by user ${req.user!.id}.`);
    res.status(204).end();
  });

  // CON-1. Newest first; `part` when any line of that order is not fully (its ordered quantity) in this container.
  router.get("/containers", requirePermission("containers", "View"), async (_req, res) => {
    const rows = await db
      .select({
        id: containers.id,
        number: containers.number,
        agent: { id: shippingAgents.id, name: shippingAgents.name },
        terms: containers.terms,
        loadedOn: containers.loadedOn,
        sailedOn: containers.sailedOn,
        eta: containers.eta,
        etaEstimated: containers.etaEstimated,
        status: containers.status,
        // For the report download (docs/report-downloads.md).
        portOfLoading: containers.portOfLoading,
        portOfArrival: containers.portOfArrival,
      })
      .from(containers)
      .innerJoin(shippingAgents, eq(shippingAgents.id, containers.shippingAgentId))
      .orderBy(desc(containers.createdAt));
    if (rows.length === 0) return void res.json([]);
    // ponytail: every line of every listed container in memory; page the list when containers number in the thousands.
    const loaded = await db
      .select({
        containerId: containerLines.containerId,
        orderLineId: containerLines.orderLineId,
        bundles: containerLines.bundles,
        quantity: containerLines.quantity,
        orderId: orderLines.orderId,
        po: orders.poNumber,
        supplier: suppliers.name,
      })
      .from(containerLines)
      .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
      .where(
        inArray(
          containerLines.containerId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(orders.poNumber));
    const orderIds = [...new Set(loaded.map((line) => line.orderId))];
    const lines = orderIds.length
      ? await db.select({ id: orderLines.id, orderId: orderLines.orderId, quantity: orderLines.quantity }).from(orderLines).where(inArray(orderLines.orderId, orderIds))
      : [];
    res.json(
      rows.map((row) => {
        const mine = loaded.filter((line) => line.containerId === row.id);
        const inThis = new Map(mine.map((line) => [line.orderLineId, line.quantity]));
        const pos = new Map(mine.map((line) => [line.orderId, line]));
        return {
          ...row,
          bundles: mine.reduce((sum, line) => sum + line.bundles, 0),
          orders: [...pos].map(([orderId, { po, supplier }]) => ({
            po,
            supplier,
            part: lines.some((line) => line.orderId === orderId && (inThis.get(line.id) ?? 0) < line.quantity),
          })),
        };
      }),
    );
  });

  // CON-2. Lines of orders at stage 2-3 with something received and not yet loaded.
  router.get("/containers/options", requirePermission("containers", "Enter"), async (_req, res) => {
    const agents = await db
      .select({ id: shippingAgents.id, name: shippingAgents.name })
      .from(shippingAgents)
      .where(eq(shippingAgents.status, "Active"))
      .orderBy(asc(shippingAgents.createdAt), asc(shippingAgents.name));
    const received = receivedOf();
    const loaded = loadedOf();
    const lines = await db
      .select({
        orderLineId: orderLines.id,
        orderId: orders.id,
        po: orders.poNumber,
        item: items.name,
        unit: unitSymbol,
        received,
        loaded,
      })
      .from(orderLines)
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .innerJoin(items, eq(items.id, orderLines.itemId))
      .where(and(inArray(orders.stage, [2, 3]), sql`${received} > ${loaded}`))
      .orderBy(desc(orders.orderDate), desc(orders.createdAt), asc(orderLines.position));
    res.json({ agents, lines });
  });

  // CON-3. One transaction; the orders being loaded are locked first, so two containers can't both load the same stock.
  router.post("/containers", requirePermission("containers", "Enter"), async (req, res) => {
    const input = parse(newContainer, req.body);
    const id = await db.transaction(async (tx) => {
      const problems: Record<string, string> = {};
      if (input.eta < input.loadedOn) problems.eta = MESSAGES.etaBeforeLoading;
      const agent = await tx
        .select({ name: shippingAgents.name })
        .from(shippingAgents)
        .where(and(eq(shippingAgents.id, input.shippingAgentId), eq(shippingAgents.status, "Active")));
      if (agent.length === 0) problems.shippingAgentId = MESSAGES.agent;

      const lineIds = input.lines.map((line) => line.orderLineId);
      const owners = await tx.selectDistinct({ orderId: orderLines.orderId }).from(orderLines).where(inArray(orderLines.id, lineIds));
      const locked = owners.length
        ? await tx
            .select({ id: orders.id, stage: orders.stage })
            .from(orders)
            .where(
              inArray(
                orders.id,
                owners.map((owner) => owner.orderId),
              ),
            )
            .orderBy(asc(orders.id))
            .for("update")
        : [];
      const stages = new Map(locked.map((order) => [order.id, order.stage]));
      const current = await tx
        .select({
          id: orderLines.id,
          orderId: orderLines.orderId,
          po: orders.poNumber,
          item: items.name,
          unit: unitSymbol,
          received: receivedOf(),
          loaded: loadedOf(),
        })
        .from(orderLines)
        .innerJoin(orders, eq(orders.id, orderLines.orderId))
        .innerJoin(items, eq(items.id, orderLines.itemId))
        .where(inArray(orderLines.id, lineIds));
      const byId = new Map(current.map((line) => [line.id, line]));
      for (const { orderLineId, quantity } of input.lines) {
        const line = byId.get(orderLineId);
        const stage = line && stages.get(line.orderId);
        if (!line) problems.lines ??= MESSAGES.unknownLine;
        else if (stage !== 2 && stage !== 3) problems.lines ??= MESSAGES.notLoadable(line.po);
        else if (line.loaded + quantity > line.received) {
          problems.lines ??= MESSAGES.overLoad(line.item, line.po, line.received - line.loaded, line.unit);
        }
      }
      if (Object.keys(problems).length > 0) throw validationFailed(problems);

      // The unique index on upper(number) decides duplicates, so two simultaneous adds can't both succeed.
      const { lines: bodyLines, ...values } = input;
      const created = await tx
        .insert(containers)
        .values({ ...values, status: "loading", createdBy: req.user!.id })
        .onConflictDoNothing()
        .returning({ id: containers.id });
      if (!created[0]) throw conflict("container_exists", MESSAGES.numberTaken, { number: MESSAGES.numberTaken });
      const containerId = created[0].id;
      await tx.insert(containerLines).values(bodyLines.map((line) => ({ ...line, containerId })));
      await tx
        .update(orders)
        .set({ stage: 3 })
        .where(and(inArray(orders.id, [...stages.keys()]), eq(orders.stage, 2)));
      await notify(tx, {
        kind: "container-loaded",
        actorId: req.user!.id,
        sourceId: containerId,
        title: `Container ${input.number} loaded`,
        details: [agent[0]!.name, [...new Set(current.map((line) => line.po))].sort().join(", "), `ETA ${day(input.eta)}`],
        href: () => `/containers/${containerId}`,
      });
      return containerId;
    });
    res.status(201).json({ container: { id } });
  });

  return router;
}
