import { and, asc, count, countDistinct, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { currencyCode } from "../../currencies";
import {
  containerLines,
  containers,
  items,
  locations,
  notifications,
  orderLines,
  orders,
  payments,
  receiptLines,
  receipts,
  shippingAgents,
  TERMS,
  suppliers,
  users,
  warehouseReceiptLines,
} from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import { atLeast, type Capability, effectiveAccess } from "../../permissions/matrix";
import type { RouteContext } from "../context";
import { guardFinalSettlements } from "../costs/landed-cost";
import { containerOrders } from "../stages/common";
import { money } from "../notifications/notify";
import {
  accountFields,
  assertLedgerLive,
  heldAccounts,
  isHeld,
  linePoValue,
  lineValue,
  loadLedger,
  lockAccount,
  MESSAGES as LEDGER,
  oldestPaymentsFirst,
  paymentQuery,
  paymentRow,
  postOrderCancel,
  sliceDetails,
  syncOrderValue,
} from "../ledger/ledger";
import { hiddenSettlement, orderSettlement } from "./money";
import { byPo, depositRequired, isPoTaken, line, lineList, MESSAGES as M, orderRows, PO_MAX_LENGTH, unitSymbol } from "./orders.routes";

// Owner: BE-orders. ORD-4 GET /orders/:po (docs/live-screens-contracts.md, "Five-tab completion"); ORD-5 PATCH and
// ORD-6 DELETE /orders/:po (docs/contracts.md, "Orders: edit and delete"). Supplier money per docs/unified-ledger.md:
// the order's settlement is the ledger's FIFO projection; a line change posts one order_adjustment, a delete posts
// the order_cancel.

const EDIT = {
  warehouse: "This order has reached the warehouse, so it can't be changed.",
  received: "Goods have been received for this order, so its order date and items can't change.",
  lineChanged: "A line on this order changed. Reload the order and try again.",
  /** Its containers have its terms (CON-3), so they are fixed once it is loaded (unless never set: an older order). */
  termsLoaded: "This order is already loaded in a container, so its container terms can't change.",
  /** M8 (costs/landed-cost.ts guardFinalSettlements): FIFO order follows the order date. */
  finalSettled: (pos: string[]) =>
    `Changing the order date would change the payments that settle ${joined(pos)}, whose landed cost is already final. Keep the saved order date.`,
  /**
   * The order's value is posted to its supplier's account in its currency (docs/unified-ledger.md); the ledger has no
   * transfer between accounts, so both are fixed once the order is placed (owner refinement 2026-11-21: blocked).
   */
  supplierFixed: "An order's supplier can't change: its value is posted to this supplier's account. Place a new order for the other supplier.",
  currencyFixed: (currency: string) => `An order's currency can't change: its rates, value and payments are in ${currency}. Place a new order in the other currency.`,
  /** ORD-8 (owner rule of 2026-11-23, 7): a Management rate correction once goods are received. */
  correctionReason: "Enter the reason for this rate correction (up to 500 characters).",
  correctionUnchanged: "Change the rate of at least one line.",
  correctionNotReceived: "Only a line with goods received is corrected here. Change the other lines on Edit order.",
  correctionFinal: (pos: string[]) =>
    `This rate correction changes the payments that settle ${joined(pos)}, whose landed cost is already final. A Management user must approve it with a reason.`,
  approvalReason: "Enter the reason for approving this change (up to 500 characters).",
};
const rateCorrection = z.strictObject({
  lines: z
    .array(z.strictObject({ id: z.uuid({ error: EDIT.lineChanged }), rateCny: line.shape.rateCny }), { error: EDIT.lineChanged })
    .min(1, EDIT.correctionUnchanged)
    .max(50, EDIT.lineChanged)
    .refine((lines) => new Set(lines.map((entry) => entry.id)).size === lines.length, EDIT.lineChanged),
  reason: z.string({ error: EDIT.correctionReason }).trim().min(1, EDIT.correctionReason).max(500, EDIT.correctionReason),
  /** Only after a 409 final_settlement_approval: the approval of a change to a protected final landed cost. */
  finalSettlementApproval: z.strictObject({ reason: z.string({ error: EDIT.approvalReason }).trim().min(1, EDIT.approvalReason).max(500, EDIT.approvalReason) }).optional(),
});
const orderEdit = z.strictObject({
  /**
   * The order's new PO number (docs/contracts.md ORD-5), as ORD-3 takes one: any format, trimmed, 1-50 characters,
   * unique in any letter case. Only the number changes: the order keeps its id, so everything linked to it follows.
   */
  po: z.string({ error: M.po }).trim().min(1, M.po).max(PO_MAX_LENGTH, M.poTooLong).optional(),
  /**
   * The container terms (0015, docs/order-container-terms.md) at stages 1-5 while no container holds the order; an
   * older order without terms may set them once even when loaded.
   */
  terms: z.enum(TERMS, { error: M.terms }).optional(),
  orderDate: z.iso.date({ error: M.orderDate }).optional(),
  deliveryDate: z.iso.date({ error: M.deliveryDate }).optional(),
  lines: lineList(line.extend({ id: z.uuid({ error: EDIT.lineChanged }).optional() })).optional(),
  /** The deposit the supplier asked for; null clears it. A money term, so it may change until the warehouse (stage 6), like the delivery date. */
  depositRequiredCny: depositRequired.nullable().optional(),
  /** Accepted only to explain the refusal: the saved supplier or currency is no change, another one is 422. */
  supplierId: z.uuid({ error: M.supplier }).optional(),
  currency: currencyCode(M.currency).optional(),
});
/** "a, b and c". */
export const joined = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!);
const received = sql<number>`(select coalesce(sum(${receiptLines.quantity}), 0) from ${receiptLines} where ${receiptLines.orderLineId} = ${orderLines.id})`.mapWith(Number);
const loaded = sql<number>`(select coalesce(sum(${containerLines.quantity}), 0) from ${containerLines} where ${containerLines.orderLineId} = ${orderLines.id})`.mapWith(Number);

export function orderDetailRoutes({ db }: RouteContext) {
  const router = Router();

  router.get("/orders/:po", requirePermission("ordersView", "View"), async (req, res) => {
    const po = String(req.params.po);
    const row = (await orderRows(db, [], byPo(po)))[0];
    if (!row) throw notFound("Order");
    const orderId = row.id;
    const { role, stages } = req.user!;
    // A section the user can't view is null (effective access below View), and its query never runs.
    const section = <T>(capability: Capability, query: () => Promise<T>) =>
      atLeast(effectiveAccess(role, stages, capability), "View") ? query() : Promise.resolve(null);

    const canPay = atLeast(effectiveAccess(role, stages, "payments"), "View");
    const [supplier, lines, paymentList, receiptList, containerList, ledger, held] = await Promise.all([
      db
        .select({ contactPerson: suppliers.contactPerson, phone: suppliers.phone, city: suppliers.city })
        .from(suppliers)
        .where(eq(suppliers.id, row.supplierId)),
      db
        .select({
          id: orderLines.id,
          position: orderLines.position,
          itemId: items.id,
          itemName: items.name,
          unit: unitSymbol,
          quantity: orderLines.quantity,
          rateCny: orderLines.rateCny,
          /** Received quantity × rate (the line's value); poValueCny is quantity × rate, for reference. */
          valueCny: lineValue,
          poValueCny: linePoValue,
          received,
          loaded,
        })
        .from(orderLines)
        .innerJoin(items, eq(items.id, orderLines.itemId))
        .where(eq(orderLines.orderId, orderId))
        .orderBy(asc(orderLines.position)),
      // Order-linked rows only: legacy supplier payments recorded against this PO (a memo) and its agent payments.
      section("payments", async () => (await paymentQuery(db, eq(payments.orderId, orderId)).orderBy(...oldestPaymentsFirst)).map(paymentRow)),
      section("receiving", async () => {
        const [list, lineList] = await Promise.all([
          db
            .select({
              id: receipts.id,
              receivedOn: receipts.receivedOn,
              office: locations.name,
              bundles: receipts.bundles,
              deliveryNote: receipts.deliveryNote,
              shortRemark: receipts.shortRemark,
              receivedBy: sql<string>`coalesce(${users.name}, '')`,
            })
            .from(receipts)
            .innerJoin(locations, eq(locations.id, receipts.locationId))
            .leftJoin(users, eq(users.id, receipts.receivedBy))
            .where(eq(receipts.orderId, orderId))
            .orderBy(asc(receipts.receivedOn), asc(receipts.createdAt)),
          db
            .select({
              receiptId: receiptLines.receiptId,
              orderLineId: receiptLines.orderLineId,
              item: items.name,
              unit: unitSymbol,
              quantity: receiptLines.quantity,
            })
            .from(receiptLines)
            .innerJoin(orderLines, eq(orderLines.id, receiptLines.orderLineId))
            .innerJoin(items, eq(items.id, orderLines.itemId))
            .where(eq(orderLines.orderId, orderId))
            .orderBy(asc(orderLines.position)),
        ]);
        return list.map((receipt) => ({
          ...receipt,
          lines: lineList
            .filter((line) => line.receiptId === receipt.id)
            .map((line) => ({ orderLineId: line.orderLineId, item: line.item, unit: line.unit, quantity: line.quantity })),
        }));
      }),
      section("containers", async () => {
        // Only this order's lines; a container shared with other orders shows just this order's goods.
        const lineList = await db
          .select({
            containerId: containerLines.containerId,
            orderLineId: containerLines.orderLineId,
            item: items.name,
            unit: unitSymbol,
            bundles: containerLines.bundles,
            quantity: containerLines.quantity,
          })
          .from(containerLines)
          .innerJoin(orderLines, eq(orderLines.id, containerLines.orderLineId))
          .innerJoin(items, eq(items.id, orderLines.itemId))
          .where(eq(orderLines.orderId, orderId))
          .orderBy(asc(orderLines.position));
        if (lineList.length === 0) return [];
        const list = await db
          .select({
            id: containers.id,
            number: containers.number,
            status: containers.status,
            terms: containers.terms,
            agentId: shippingAgents.id,
            agentName: shippingAgents.name,
            loadedOn: containers.loadedOn,
            sailedOn: containers.sailedOn,
            eta: containers.eta,
          })
          .from(containers)
          .innerJoin(shippingAgents, eq(shippingAgents.id, containers.shippingAgentId))
          .where(inArray(containers.id, [...new Set(lineList.map((line) => line.containerId))]))
          .orderBy(asc(containers.loadedOn), asc(containers.createdAt));
        const pos = await containerOrders(
          db,
          list.map((container) => container.id),
        );
        return list.map(({ agentId, agentName, ...container }) => ({
          ...container,
          agent: { id: agentId, name: agentName },
          // Every PO in the container, this one included: deleting the container (CON-6) takes all their goods out.
          orders: pos.get(container.id)?.orders ?? [],
          lines: lineList
            .filter((line) => line.containerId === container.id)
            .map((line) => ({ orderLineId: line.orderLineId, item: line.item, unit: line.unit, bundles: line.bundles, quantity: line.quantity })),
        }));
      }),
      // The supplier's ledger (its accounts and the FIFO projection of its orders): money, so the payments section's access.
      section("payments", () => loadLedger(db, { supplierIds: [row.supplierId] })),
      canPay ? null : heldAccounts(db),
    ]);
    const settlement = ledger?.order(orderId);
    const account = ledger?.account(row.supplierId, row.currency);
    const slices = settlement ? (await sliceDetails(db, settlement.slices))(settlement.slices) : null;

    res.json({
      id: row.id,
      po: row.po,
      orderDate: row.orderDate,
      deliveryDate: row.deliveryDate,
      stage: row.stage,
      supplier: { id: row.supplierId, name: row.supplierName, ...supplier[0]! },
      currency: row.currency,
      exchangeRate: row.exchangeRate,
      /** The order's container terms (0015); null until set. */
      terms: row.terms,
      item: row.item,
      quantity: row.quantity,
      unit: row.unit,
      received: row.received,
      stocked: row.stocked,
      closed: row.closed,
      closedOn: row.closedOn,
      /** Received quantity × rate: the value the ledger holds and settles. */
      orderValueCny: row.orderValueCny,
      /** Ordered quantity × rate, for reference only (never posted or settled). */
      poValueCny: row.poValueCny,
      // The FIFO projection of the supplier's account (settled, outstanding, status, goods INR), the Deposit Required
      // milestone, the agent payments (sea freight) and paidInr; null without payments View.
      ...(ledger ? orderSettlement(settlement, row) : hiddenSettlement(held!.has(`${row.supplierId} ${row.currency}`), row.depositRequiredCny)),
      /** The credits that settled the order, oldest first, each at its own rate. */
      slices: ledger ? (slices ?? []) : null,
      /** The supplier's account in the order's currency (signed balance; null figures while held). */
      supplierAccount: account ? accountFields(account) : null,
      lines: lines.map(({ itemId, itemName, ...line }) => ({ ...line, item: { id: itemId, name: itemName } })),
      payments: paymentList?.map((payment) => ({ ...payment, settlement: ledger?.paymentSettlement(payment.id) ?? null })) ?? null,
      receipts: receiptList,
      containers: containerList,
    });
  });

  // ORD-5. One transaction with the order row locked: REC-3 and CON-3 lock it too, and a new payment's foreign key
  // key-share locks it, so no receipt, load or payment can land between the checks below and the change. New lines
  // are a money change: refused while the ledger is in maintenance (503) or the account is held (409), and the value's
  // difference is posted as one order_adjustment (nothing when the value is unchanged). Other edits post nothing. A new
  // order date, PO number or deposit asked is refused in maintenance too (the cutover's baseline holds them: ORD-5 in
  // docs/unified-ledger.md); delivery date and terms are not. A new order date is refused (422) when it would change the
  // settlement of an order whose landed cost is final (M8). Payments never block an edit: a value change is posted as
  // its adjustment and the FIFO projection re-settles. The supplier and currency are fixed (422 with the reason).
  router.patch("/orders/:po", requirePermission("ordersEdit", "Enter"), async (req, res) => {
    const po = String(req.params.po);
    const input = parse(orderEdit, req.body);
    if (Object.keys(input).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);

    const order = await db.transaction(async (tx) => {
      const row = (await tx.select().from(orders).where(byPo(po)).for("update"))[0];
      if (!row) throw notFound("Order");
      if (row.stage === 6) throw conflict("order_locked", EDIT.warehouse);
      const headerOrLines = input.orderDate !== undefined || input.lines !== undefined;
      if (row.stage > 1 && headerOrLines) throw conflict("order_locked", EDIT.received);
      // Defence in depth: a receipt moves an order to stage 2 in the same locked transaction, so through the API a stage-1
      // order has no goods. If the data ever says otherwise (an import, a manual fix), treat the order as received: a
      // removed line would otherwise cascade its receipt, container or warehouse lines away.
      if (headerOrLines) {
        const lineIds = tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, row.id));
        const goods =
          (await tx.select({ n: count() }).from(receiptLines).where(inArray(receiptLines.orderLineId, lineIds)))[0]!.n +
          (await tx.select({ n: count() }).from(containerLines).where(inArray(containerLines.orderLineId, lineIds)))[0]!.n +
          (await tx.select({ n: count() }).from(warehouseReceiptLines).where(inArray(warehouseReceiptLines.orderLineId, lineIds)))[0]!.n;
        if (goods > 0) throw conflict("order_locked", EDIT.received);
      }

      const problems: Record<string, string> = {};
      if (input.supplierId !== undefined && input.supplierId !== row.supplierId) problems.supplierId = EDIT.supplierFixed;
      if (input.currency !== undefined && input.currency !== row.currency) problems.currency = EDIT.currencyFixed(row.currency);
      // A new PO number (the same one, as saved, is no change). Taken by another order in any letter case: 422 here;
      // one taken by a concurrent edit or create after this check is caught by the unique index below.
      const newPo = input.po !== undefined && input.po !== row.poNumber ? input.po : undefined;
      const newDate = input.orderDate !== undefined && input.orderDate !== row.orderDate;
      const newDeposit = input.depositRequiredCny !== undefined && input.depositRequiredCny !== row.depositRequiredCny;
      // Read after the row lock: a 404 or locked order says so whatever the ledger's state.
      if (input.lines || newPo || newDate || newDeposit) await assertLedgerLive(tx, LEDGER.orderMaintenance);
      if (newPo && (await tx.select({ id: orders.id }).from(orders).where(and(byPo(newPo), sql`${orders.id} <> ${row.id}`))).length > 0) problems.po = M.poTaken;
      if ((input.deliveryDate ?? row.deliveryDate) < (input.orderDate ?? row.orderDate)) problems.deliveryDate = M.deliveryBeforeOrder;
      // New terms: refused once a container holds the order (the container has its terms); the same ones are no change.
      const newTerms = input.terms !== undefined && input.terms !== row.terms ? input.terms : undefined;
      if (newTerms && row.terms !== null) {
        const loadedLines = await tx
          .select({ n: count() })
          .from(containerLines)
          .where(inArray(containerLines.orderLineId, tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, row.id))));
        if (loadedLines[0]!.n > 0) problems.terms = EDIT.termsLoaded;
      }
      const kept = (input.lines ?? []).flatMap((entry) => (entry.id ? [entry.id] : []));
      if (input.lines) {
        const saved = await tx.select({ id: orderLines.id, itemId: orderLines.itemId }).from(orderLines).where(eq(orderLines.orderId, row.id));
        const savedItem = new Map(saved.map((entry) => [entry.id, entry.itemId]));
        // A line that keeps its saved item is not re-checked, so an item made inactive since doesn't block the edit.
        const itemIds = [...new Set(input.lines.filter((entry) => !entry.id || savedItem.get(entry.id) !== entry.itemId).map((entry) => entry.itemId))];
        const active = itemIds.length
          ? await tx.select({ id: items.id }).from(items).where(and(inArray(items.id, itemIds), eq(items.status, "Active")))
          : [];
        // The total may go below what was paid (D9): the supplier's account then simply holds more money.
        if (kept.some((id) => !savedItem.has(id)) || new Set(kept).size < kept.length) problems.lines = EDIT.lineChanged;
        else if (active.length < itemIds.length) problems.lines = M.item;
      }
      if (Object.keys(problems).length > 0) throw validationFailed(problems);
      if (input.lines && (await isHeld(tx, row.supplierId, row.currency))) throw conflict("account_held", LEDGER.held);

      if (input.lines) {
        await tx.delete(orderLines).where(and(eq(orderLines.orderId, row.id), kept.length ? notInArray(orderLines.id, kept) : undefined));
        // (order, position) is unique and checked row by row, so kept lines step out of 0-49 before taking their places.
        await tx.update(orderLines).set({ position: sql`${orderLines.position} + 100` }).where(eq(orderLines.orderId, row.id));
        const added: (typeof orderLines.$inferInsert)[] = [];
        for (const [position, { id, ...values }] of input.lines.entries()) {
          if (id) await tx.update(orderLines).set({ ...values, position }).where(eq(orderLines.id, id));
          else added.push({ ...values, orderId: row.id, position });
        }
        if (added.length > 0) await tx.insert(orderLines).values(added);
      }
      // The new value against what the journal holds for the order: one order_adjustment for the difference, at the
      // order's rate snapshot, in this transaction (under the order's row lock, so its key number is its own).
      const posted = input.lines
        ? await syncOrderValue(tx, { id: row.id, po: newPo ?? row.poNumber, supplierId: row.supplierId, currency: row.currency, exchangeRate: row.exchangeRate, orderDate: row.orderDate }, req.user!.id)
        : null;
      const ledger = posted && { supplierId: row.supplierId, currency: row.currency, changeCny: posted.changeCny, balanceBefore: posted.balanceBefore, balanceAfter: posted.balanceAfter };
      // M8: with the account locked (as a posting locks it), the final orders' settlements just before the new date, so
      // only the date move is judged (a line change above is not M8's: docs/unified-ledger.md).
      if (newDate) await lockAccount(tx, row.supplierId, row.currency);
      const finalChanged = newDate ? await guardFinalSettlements(tx, row.supplierId, row.currency) : null;
      const updated = await tx
        .update(orders)
        .set({ poNumber: newPo, terms: newTerms, orderDate: input.orderDate, deliveryDate: input.deliveryDate, depositRequiredCny: input.depositRequiredCny, updatedAt: new Date() })
        .where(eq(orders.id, row.id))
        .returning({ id: orders.id, po: orders.poNumber, stage: orders.stage, orderDate: orders.orderDate, deliveryDate: orders.deliveryDate, terms: orders.terms });
      const reopened = finalChanged ? await finalChanged() : [];
      if (reopened.length > 0) throw validationFailed({ orderDate: EDIT.finalSettled(reopened) });
      if (newPo) {
        // Everything else links to the order by id. Notifications store a link to the order's pages by its number, so
        // those links follow the new number; their titles keep the number the event happened under (a record of it).
        const from = `/orders/${encodeURIComponent(row.poNumber)}`;
        const to = `/orders/${encodeURIComponent(newPo)}`;
        await tx
          .update(notifications)
          .set({ href: sql`${to} || substr(${notifications.href}, ${from.length + 1}::int)` })
          .where(or(eq(notifications.href, from), sql`left(${notifications.href}, ${from.length + 1}::int) = ${`${from}/`}`));
      }
      return { order: updated[0]!, ledger, renamedFrom: newPo ? row.poNumber : null };
    }).catch((error: unknown) => {
      // Another order took the number between the check above and this edit (a concurrent edit or create).
      if (isPoTaken(error)) throw validationFailed({ po: M.poTaken });
      throw error;
    });
    // ponytail: the server log is the record of a renumbering, as of deletions; an audit table needs a migration.
    if (order.renamedFrom) console.info(`Order ${order.renamedFrom} renumbered to ${order.order.po} (order ${order.order.id}) by user ${req.user!.id}.`);
    // The account's balances are money: only with payments View (ORD-5 itself needs ordersEdit Enter).
    const canPay = atLeast(effectiveAccess(req.user!.role, req.user!.stages, "payments"), "View");
    res.json(order.ledger ? { order: order.order, ledger: canPay ? order.ledger : null } : { order: order.order });
  });

  // ORD-8. Management (payments Full): a rate correction once goods are received (owner rule of 2026-11-23, 7), when
  // ORD-5 no longer changes the lines. Only received lines; the corrected rates are written and the value's difference
  // (received quantity x the rate change) is posted as one order_adjustment, dated today, whose notes keep the reason
  // and each rate before and after; the posting keeps the actor and the time (created_by, created_at). Receipts and
  // payments never change. Refused in maintenance (503) and while the account is held (409). A correction that changes
  // the settlement of a protected final landed-cost order answers 409 final_settlement_approval unless the body carries
  // finalSettlementApproval { reason }, kept in the posting's notes; the response names those orders.
  router.post("/orders/:po/rate-corrections", requirePermission("payments", "Full"), async (req, res) => {
    const po = String(req.params.po);
    const input = parse(rateCorrection, req.body);
    const result = await db.transaction(async (tx) => {
      const row = (await tx.select().from(orders).where(byPo(po)).for("update"))[0];
      if (!row) throw notFound("Order");
      await assertLedgerLive(tx);
      if (await isHeld(tx, row.supplierId, row.currency)) throw conflict("account_held", LEDGER.held);
      const saved = await tx
        .select({ id: orderLines.id, rateCny: orderLines.rateCny, received, item: items.name })
        .from(orderLines)
        .innerJoin(items, eq(items.id, orderLines.itemId))
        .where(eq(orderLines.orderId, row.id));
      const byId = new Map(saved.map((entry) => [entry.id, entry]));
      if (input.lines.some((entry) => !byId.has(entry.id))) throw validationFailed({ lines: EDIT.lineChanged });
      if (input.lines.some((entry) => byId.get(entry.id)!.received === 0)) throw validationFailed({ lines: EDIT.correctionNotReceived });
      const changed = input.lines.filter((entry) => Math.round(byId.get(entry.id)!.rateCny * 10_000) !== Math.round(entry.rateCny * 10_000));
      if (changed.length === 0) throw validationFailed({ lines: EDIT.correctionUnchanged });

      await lockAccount(tx, row.supplierId, row.currency);
      const finalChanged = await guardFinalSettlements(tx, row.supplierId, row.currency);
      for (const entry of changed) await tx.update(orderLines).set({ rateCny: entry.rateCny }).where(eq(orderLines.id, entry.id));
      const detail = changed.map((entry) => `${byId.get(entry.id)!.item} ${byId.get(entry.id)!.rateCny} -> ${entry.rateCny} (${byId.get(entry.id)!.received} received)`).join("; ");
      const order = { id: row.id, po: row.poNumber, supplierId: row.supplierId, currency: row.currency, exchangeRate: row.exchangeRate, orderDate: row.orderDate };
      const approval = input.finalSettlementApproval ? `; Management approval (final landed cost): ${input.finalSettlementApproval.reason}` : "";
      const posted = await syncOrderValue(tx, order, req.user!.id, `Rate correction: ${input.reason} (${detail})${approval}`);
      await tx.update(orders).set({ updatedAt: new Date() }).where(eq(orders.id, row.id));
      // A protected final landed cost (M8, final_cost_protections) changes only with an explicit approval (rolled back otherwise).
      const finalOrders = await finalChanged();
      if (finalOrders.length > 0 && !input.finalSettlementApproval) throw conflict("final_settlement_approval", EDIT.correctionFinal(finalOrders));
      return { order, posted, finalOrders, detail };
    });
    console.info(`Order ${result.order.po} rates corrected by user ${req.user!.id}: ${result.detail}.`);
    res.json({
      order: { id: result.order.id, po: result.order.po },
      ledger: {
        supplierId: result.order.supplierId,
        currency: result.order.currency,
        changeCny: result.posted.changeCny,
        balanceBefore: result.posted.balanceBefore,
        balanceAfter: result.posted.balanceAfter,
        entryId: result.posted.entry?.id ?? null,
        finalOrders: result.finalOrders,
      },
    });
  });

  // ORD-6. Only an order nothing depends on is deleted, with its own lines (the order_lines cascade). The order and its
  // lines are locked first: REC-3 and CON-3 lock the order, and any new payment, receipt, container or warehouse line
  // key-share locks the row it names, so nothing can start depending on the order between the counts and the delete.
  // Deleting is cancelling: everything the journal holds for the order is given back (order_cancel) first; its
  // postings stay with the PO number (order_id set null). Refused in maintenance (503) or for a held account (409).
  router.delete("/orders/:po", requirePermission("admin", "Full"), async (req, res) => {
    const po = String(req.params.po);
    const inUse = (what: string) => conflict("in_use", `This order has ${what}, so it can't be deleted.`);
    const returned = await db
      .transaction(async (tx) => {
        await assertLedgerLive(tx);
        const row = (
          await tx
            .select({ id: orders.id, po: orders.poNumber, supplierId: orders.supplierId, currency: orders.currency, exchangeRate: orders.exchangeRate, orderDate: orders.orderDate })
            .from(orders)
            .where(byPo(po))
            .for("update")
        )[0];
        if (!row) throw notFound("Order");
        if (await isHeld(tx, row.supplierId, row.currency)) throw conflict("account_held", LEDGER.held);
        await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, row.id)).for("update");
        const lines = tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, row.id));
        const receiptsWithLines = tx.select({ id: receiptLines.receiptId }).from(receiptLines).where(inArray(receiptLines.orderLineId, lines));
        // Each kind of dependent is counted here (payments of any payee, voided ones too: a payment never disappears).
        const uses: [string, PromiseLike<{ n: number }[]>][] = [
          ["payment", tx.select({ n: count() }).from(payments).where(eq(payments.orderId, row.id))],
          ["receipt", tx.select({ n: countDistinct(receipts.id) }).from(receipts).where(or(eq(receipts.orderId, row.id), inArray(receipts.id, receiptsWithLines)))],
          ["container", tx.select({ n: countDistinct(containerLines.containerId) }).from(containerLines).where(inArray(containerLines.orderLineId, lines))],
          [
            "warehouse receipt",
            tx.select({ n: countDistinct(warehouseReceiptLines.receiptId) }).from(warehouseReceiptLines).where(inArray(warehouseReceiptLines.orderLineId, lines)),
          ],
        ];
        const used: string[] = [];
        for (const [what, query] of uses) {
          const n = (await query)[0]!.n;
          if (n > 0) used.push(`${n} ${what}${n === 1 ? "" : "s"}`);
        }
        if (used.length > 0) throw inUse(joined(used));
        const cancel = await postOrderCancel(tx, { ...row }, req.user!.id);
        await tx.delete(orders).where(eq(orders.id, row.id));
        return { ...row, amount: cancel.changeCny };
      })
      .catch((error: unknown) => {
        // A use the counts missed through a NO ACTION foreign key refuses the delete (none exists today).
        type PgError = { code?: string; cause?: PgError };
        if (((error as PgError)?.cause ?? (error as PgError))?.code === "23503") throw inUse("other records");
        throw error;
      });
    // The order_cancel posting is the record; this line says who cancelled it.
    console.info(`Order ${returned.po} deleted by user ${req.user!.id}: ${money(returned.amount, returned.currency)} debit cancelled.`);
    res.status(204).end();
  });

  return router;
}
