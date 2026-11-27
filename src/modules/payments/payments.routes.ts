import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { currencyCode } from "../../currencies";
import type { Database } from "../../db/client";
import { type Currency, orders, payments, shippingAgents, supplierLedgerEntries, suppliers } from "../../db/schema";
import { conflict, HttpError, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { atLeast, effectiveAccess } from "../../permissions/matrix";
import { guardFinalSettlements } from "../costs/landed-cost";
import {
  assertLedgerLive,
  cents,
  fromCents,
  isHeld,
  loadLedger,
  lockAccount,
  MESSAGES as LEDGER,
  type PaymentSettlement,
  paymentQuery,
  paymentRow,
  postPaymentCredit,
  postPaymentVoid,
  settlementDifferences,
} from "../ledger/ledger";
import { currencyOptions } from "../ledger/ledger.routes";
import { money, notify } from "../notifications/notify";
import { rateProblem } from "../orders/orders.routes";
import { isUuid, todayInIndia } from "../stages/common";

// Owner: BE-payments. PAY-2 POST /payments, PAY-3 DELETE /payments/:id and PAY-4 PATCH /payments/:id (docs/unified-ledger.md). A supplier payment
// is recorded against the supplier (no order) and credited to its ledger account in the payment's currency, in one
// transaction; a shipping-agent payment stays on its order as sea freight and is never posted. A payment is never
// deleted: PAY-3 voids it (reason required) and reverses its posting. `rateInr` is INR per 1 of the currency (none,
// stored as 1, for INR).

export const MESSAGES = {
  supplier: "Choose a supplier from the list.",
  currency: "Choose one of this supplier's currencies.",
  order: "Choose an order from the list.",
  kind: "Choose Deposit or Balance.",
  payeeRole: "Choose who the payment was paid to.",
  /** An order-linked supplier body (the form before 0017): supplier money now goes to the supplier's account. */
  supplierOnOrder: "Supplier payments are now recorded against the supplier. Reload the page.",
  agent: "Choose a shipping agent from the list.",
  amount: "Enter an amount above 0.",
  paidOn: "Enter the date the payment was made.",
  paidOnFuture: "The payment date can't be in the future.",
  rateInr: "Enter an INR rate above 0.",
  mode: "Enter the payment mode.",
  modeTooLong: "Use 100 characters or fewer for the mode.",
  referenceTooLong: "Use 100 characters or fewer for the reference.",
  notesTooLong: "Use 1,000 characters or fewer for the notes.",
  clientRequestId: "Reload the page and try again.",
  idempotencyConflict: "This payment was already recorded with different details. Reload the page.",
  reason: "Enter the reason for voiding the payment.",
  reasonTooLong: "Use 1,000 characters or fewer for the reason.",
  alreadyVoided: "This payment was already voided.",
  editReason: "Enter the reason for changing the amount, date or rate.",
  editDue: "Only a paid payment can be edited.",
  /** PAY-4 on a legacy order-linked Deposit/Balance (owner decisions of 2026-11-27): every change is a correction. */
  correctionReason: "Enter the reason for this correction.",
  editUnposted: "This payment isn't in the supplier ledger, so it can't be edited.",
  settled: (paid: string) => `This payment was fully used to pay ${paid}, so it can't be edited.`,
  belowUsed: (least: string, paid: string) => `Enter at least ${least}: that much of this payment already paid ${paid}.`,
  usedDate: (paid: string) => `The payment date can't change: part of this payment already paid ${paid}.`,
  usedRate: (paid: string) => `The rate can't change: part of this payment already paid ${paid}.`,
  settlementChange: (pos: string[]) =>
    pos.length > 0
      ? `This change would alter how ${joinedPos(pos)} ${pos.length > 1 ? "are" : "is"} settled, so nothing was saved.`
      : "This change would alter how this supplier's account is settled, so nothing was saved.",
};
const M = MESSAGES;

// Upper bounds keep values inside the numeric columns, so an absurd number is a 422, not a 500.
const amount = z
  .number({ error: M.amount })
  .min(0.01, M.amount)
  .max(999_999_999_999, M.amount)
  .refine((value) => Number(value.toFixed(2)) === value, M.amount);
const common = {
  paidOn: z.iso.date({ error: M.paidOn }).refine((day) => day <= todayInIndia(), M.paidOnFuture),
  rateInr: z
    .number({ error: M.rateInr })
    .min(0.0001, M.rateInr)
    .max(99_999_999.9999, M.rateInr)
    .refine((value) => Number(value.toFixed(4)) === value, M.rateInr)
    .optional(),
  mode: z.string({ error: M.mode }).trim().min(1, M.mode).max(100, M.modeTooLong),
  reference: z.string({ error: M.referenceTooLong }).trim().max(100, M.referenceTooLong).default(""),
  notes: z.string({ error: M.notesTooLong }).trim().max(1000, M.notesTooLong).default(""),
  /** The client's key for this submit (kept across its retries): a repeat returns the payment already recorded. */
  clientRequestId: z.uuid({ error: M.clientRequestId }),
};
const FINAL = {
  payment: (pos: string[]) =>
    `This payment's date puts it before the payments that settle ${joinedPos(pos)}, whose landed cost is already final, so it changes them. A Management user must approve it with a reason.`,
  void: (pos: string[]) => `Voiding this payment changes the payments that settle ${joinedPos(pos)}, whose landed cost is already final. Give the reason for approving it.`,
  edit: (pos: string[]) => `Changing this payment changes the payments that settle ${joinedPos(pos)}, whose landed cost is already final. Give the reason for approving it.`,
  notAllowed: "Only Management can approve a change to a final landed cost.",
  approvalReason: "Enter the reason for approving this change (up to 500 characters).",
};
const joinedPos = (pos: string[]) => (pos.length > 1 ? `${pos.slice(0, -1).join(", ")} and ${pos.at(-1)}` : pos[0]!);
const approvalNote = (approval: { reason: string } | undefined) => (approval ? `Management approval (final landed cost): ${approval.reason}` : "");
/** A change to a protected final landed cost: 409 without the approval (the transaction rolls back), 403 from a non-Management approver. */
function requireFinalApproval(changed: string[], approval: { reason: string } | undefined, approver: boolean, message: (pos: string[]) => string) {
  if (changed.length === 0) return;
  if (!approval) throw conflict("final_settlement_approval", message(changed));
  if (!approver) throw new HttpError(403, "forbidden", FINAL.notAllowed);
}
/** Only after a 409 final_settlement_approval: a Management user's reason (owner review of 2026-11-23). */
const finalSettlementApproval = z
  .strictObject({ reason: z.string({ error: FINAL.approvalReason }).trim().min(1, FINAL.approvalReason).max(500, FINAL.approvalReason) })
  .optional();
const supplierPayment = z.strictObject({ supplierId: z.uuid({ error: M.supplier }), amount, currency: currencyCode(M.currency).optional(), ...common, finalSettlementApproval });
const agentPayment = z.strictObject({
  orderId: z.uuid({ error: M.order }),
  payeeRole: z.literal("agent", { error: M.payeeRole }),
  agentId: z.uuid({ error: M.agent }),
  kind: z.enum(["Deposit", "Balance"], { error: M.kind }),
  amountCny: amount,
  ...common,
});
const voidPayment = z.strictObject({ reason: z.string({ error: M.reason }).trim().min(1, M.reason).max(1000, M.reasonTooLong), finalSettlementApproval });
/** PAY-4: every field as it should be (PAY-2's rules); `reason` is required when the amount, date or rate changes. */
const editPayment = z.strictObject({
  amount,
  ...common,
  reason: z.string({ error: M.reasonTooLong }).trim().max(1000, M.reasonTooLong).default(""),
  finalSettlementApproval,
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

type Stored = typeof payments.$inferSelect;
type Fields = { amountCny: number; paidOn: string; rateInr: number; mode: string; reference: string; notes: string };
/** A rate to the column's 4 decimals, so a float's last digit is no change. */
const rateKey = (rate: number | null) => Math.round((rate ?? 0) * 10_000);

/**
 * PAY-4 on a legacy order-linked Deposit/Balance (owner decisions of 2026-11-27), from its credit's use in the
 * projection taken under the account lock (never the Paid label): settled is 409 `settled_payment`; partly keeps its
 * date and rate and at least what was used (422); every change needs a reason (422). Throws before anything is written.
 */
function legacyRules(use: PaymentSettlement | null, row: Stored, fields: Fields, reason: string, currency: Currency) {
  if (!use) throw conflict("not_editable", M.editUnposted);
  const paid = joinedPos(use.usedBy.map((part) => `${part.po ?? "a ledger adjustment"} (${money(part.amountCny, currency)})`));
  if (use.state === "settled") throw conflict("settled_payment", M.settled(paid));
  const problems: Record<string, string> = {};
  if (!reason) problems.reason = M.correctionReason;
  if (use.state === "partly") {
    if (cents(fields.amountCny) < cents(use.usedCny)) problems.amount = M.belowUsed(money(use.usedCny, currency), paid);
    if (fields.paidOn !== row.paidOn) problems.paidOn = M.usedDate(paid);
    if (rateKey(fields.rateInr) !== rateKey(row.rateInr)) problems.rateInr = M.usedRate(paid);
  }
  if (Object.keys(problems).length > 0) throw validationFailed(problems);
}

/** One submit at a time per client key, so a double click can't record two payments (the second waits, then replays). */
const lockRequest = (tx: Tx, clientRequestId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('payments.client_request'), hashtext(${clientRequestId}))`);
const byRequest = async (tx: Tx, clientRequestId: string) => (await tx.select().from(payments).where(eq(payments.clientRequestId, clientRequestId)))[0];

/** Every business field of a stored payment against a resubmit's: any difference is 409 `idempotency_conflict`. */
// The payee is compared by its id (supplierId, or orderId + payee role), never by its name: a supplier or agent renamed
// between a timed-out submit and its retry must still replay.
function sameDetails(stored: Stored, fields: Omit<Stored, "id" | "status" | "dueDate" | "clientRequestId" | "createdAt" | "updatedAt" | "createdBy" | "voidedAt" | "voidedBy" | "voidReason" | "payee">) {
  const same = Object.entries(fields).every(([key, value]) => {
    const saved = stored[key as keyof Stored];
    // Numbers to the column's 4 decimals (amounts have 2), so a float's last digit never makes a resubmit different.
    return typeof value === "number" && typeof saved === "number" ? Math.round(value * 10_000) === Math.round(saved * 10_000) : saved === value;
  });
  if (!same) throw conflict("idempotency_conflict", M.idempotencyConflict);
}

/** The balances a payment's credit (or void) left its account with when it was posted (a replayed PAY-2/PAY-4 answers them again). */
async function postedBalances(db: Pick<Database, "select">, paymentId: string, entryType: "payment" | "payment_void" = "payment") {
  const e = supplierLedgerEntries;
  const [credit] = await db.select().from(e).where(and(eq(e.paymentId, paymentId), eq(e.entryType, entryType)));
  if (!credit) return null;
  // Postings to one account are serialised by its lock, so everything recorded before this one was already committed.
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${e.amount}), 0)`.mapWith(Number) })
    .from(e)
    .where(and(eq(e.supplierId, credit.supplierId), eq(e.currency, credit.currency), sql`${e.createdAt} < (select created_at from supplier_ledger_entries where id = ${credit.id})`));
  const before = fromCents(cents(row!.total));
  return { supplierId: credit.supplierId, currency: credit.currency, balanceBefore: before, balanceAfter: fromCents(cents(before) + cents(credit.amount)) };
}

export function paymentsRoutes({ db }: RouteContext) {
  const router = Router();
  /** The PaymentRow with its credit's settlement (null for agent and voided rows). */
  const view = async (id: string) => {
    const row = paymentRow((await paymentQuery(db, eq(payments.id, id)))[0]!);
    const standing = row.payeeRole === "supplier" && !row.voided;
    return { ...row, settlement: standing ? (await loadLedger(db, { supplierIds: [row.supplierId] })).paymentSettlement(id) : null };
  };

  /** PAY-2, supplier body: an orderless payment credited to the supplier's account in the payment's currency (D10). */
  async function recordSupplierPayment(input: z.infer<typeof supplierPayment>, userId: string, approver: boolean) {
    return db.transaction(async (tx) => {
      await assertLedgerLive(tx);
      await lockRequest(tx, input.clientRequestId);
      // Share-locked: a currency change of the supplier waits for this payment, so the options checked stay true.
      const [supplier] = await tx.select({ id: suppliers.id, name: suppliers.name, currency: suppliers.currency }).from(suppliers).where(eq(suppliers.id, input.supplierId)).for("share");
      const existing = await byRequest(tx, input.clientRequestId);
      if (!supplier) throw validationFailed({ supplierId: M.supplier });
      const currency = input.currency ?? supplier.currency;
      const rateInr = currency === "INR" && input.rateInr === undefined ? 1 : (input.rateInr ?? null);
      if (existing) {
        sameDetails(existing, {
          orderId: null,
          supplierId: supplier.id,
          currency,
          kind: "Payment",
          payeeRole: "supplier",
          amountCny: input.amount,
          paidOn: input.paidOn,
          rateInr,
          mode: input.mode,
          reference: input.reference,
          notes: input.notes,
        });
        return { id: existing.id, created: false };
      }
      if (await isHeld(tx, supplier.id, currency)) throw conflict("account_held", LEDGER.held);
      const problems: Record<string, string> = {};
      if (!currencyOptions(supplier, await loadLedger(tx, { supplierIds: [supplier.id] })).includes(currency)) problems.currency = M.currency;
      const rate = rateProblem(currency, input.rateInr, M.rateInr);
      if (rate) problems.rateInr = rate;
      if (Object.keys(problems).length > 0) throw validationFailed(problems);
      // M8 (owner review of 2026-11-23): a payment dated before the credits that settle a protected final landed cost
      // re-prices it; that needs a Management approval with a reason, kept on the posting. A payment of today does not.
      await lockAccount(tx, supplier.id, currency);
      const finalChanged = await guardFinalSettlements(tx, supplier.id, currency);
      const [created] = await tx
        .insert(payments)
        .values({
          supplierId: supplier.id,
          currency,
          kind: "Payment",
          payee: supplier.name,
          payeeRole: "supplier",
          amountCny: input.amount,
          status: "paid",
          paidOn: input.paidOn,
          rateInr: rateInr!,
          mode: input.mode,
          reference: input.reference,
          notes: input.notes,
          clientRequestId: input.clientRequestId,
          createdBy: userId,
        })
        .returning({ id: payments.id });
      await postPaymentCredit(tx, { id: created!.id, supplierId: supplier.id, currency, amount: input.amount, exchangeRate: rateInr, paidOn: input.paidOn }, userId, approvalNote(input.finalSettlementApproval));
      requireFinalApproval(await finalChanged(), input.finalSettlementApproval, approver, FINAL.payment);
      await notify(tx, {
        kind: "payment-recorded",
        actorId: userId,
        sourceId: created!.id,
        title: `${supplier.name} payment recorded`,
        details: [`Payment ${money(input.amount, currency)}`, supplier.name],
        href: () => `/supplier-ledger/${supplier.id}`,
      });
      return { id: created!.id, created: true };
    });
  }

  /** PAY-2, shipping-agent body: sea freight on its order, never posted. Read inside the transaction (E1: problems together). */
  async function recordAgentPayment(input: z.infer<typeof agentPayment>, userId: string) {
    return db.transaction(async (tx) => {
      await assertLedgerLive(tx);
      await lockRequest(tx, input.clientRequestId);
      // A retry of a payment already recorded replays it before any check that may have changed since (an agent
      // deactivated or renamed): same details 200, other details 409.
      const replay = await byRequest(tx, input.clientRequestId);
      if (replay) {
        // The agent (by its id, active or not: a paid agent's name can't change) must be the one recorded.
        const [named] = await tx.select({ name: shippingAgents.name }).from(shippingAgents).where(eq(shippingAgents.id, input.agentId));
        if (!named || named.name.toLowerCase() !== replay.payee.toLowerCase()) throw conflict("idempotency_conflict", M.idempotencyConflict);
        sameDetails(replay, {
          orderId: input.orderId,
          supplierId: null,
          currency: null,
          kind: input.kind,
          payeeRole: "agent",
          amountCny: input.amountCny,
          paidOn: input.paidOn,
          rateInr: input.rateInr ?? 1,
          mode: input.mode,
          reference: input.reference,
          notes: input.notes,
        });
        return { id: replay.id, created: false };
      }
      const problems: Record<string, string> = {};
      const [order] = await tx.select({ po: orders.poNumber, supplierId: orders.supplierId, currency: orders.currency }).from(orders).where(eq(orders.id, input.orderId));
      if (!order) problems.orderId = M.order;
      const rate = order && rateProblem(order.currency, input.rateInr, M.rateInr);
      if (rate) problems.rateInr = rate;
      // The agent's row share-locked: an agent payment keeps the agent's name, so a rename or delete of that agent waits
      // for this payment and then counts it (master-data DELETE, shipping-agent PATCH).
      const [agent] = await tx
        .select({ name: shippingAgents.name })
        .from(shippingAgents)
        .where(and(eq(shippingAgents.id, input.agentId), eq(shippingAgents.status, "Active")))
        .for("share");
      if (!agent) problems.agentId = M.agent;
      if (Object.keys(problems).length > 0) throw validationFailed(problems);
      const rateInr = input.rateInr ?? 1;
      // A payment of either payee on an order of a held account is refused (D18): the order's money is pending review.
      if (await isHeld(tx, order!.supplierId, order!.currency)) throw conflict("account_held", LEDGER.held);
      const [created] = await tx
        .insert(payments)
        .values({
          orderId: input.orderId,
          kind: input.kind,
          payee: agent!.name,
          payeeRole: "agent",
          amountCny: input.amountCny,
          status: "paid",
          paidOn: input.paidOn,
          rateInr,
          mode: input.mode,
          reference: input.reference,
          notes: input.notes,
          clientRequestId: input.clientRequestId,
          createdBy: userId,
        })
        .returning({ id: payments.id });
      const po = order!.po;
      await notify(tx, {
        kind: "payment-recorded",
        actorId: userId,
        sourceId: created!.id,
        title: `${po} payment recorded`,
        details: [`${input.kind} ${money(input.amountCny, order!.currency)}`, agent!.name],
        href: (canView) => (canView("ordersView") ? `/orders/${encodeURIComponent(po)}/payments` : "/payments"),
      });
      return { id: created!.id, created: true };
    });
  }

  // PAY-2. A payment already made, saved as paid. Two bodies: the supplier's (orderless, posted to its ledger account)
  // or a shipping agent's on an order. An order-linked supplier body is the form from before the ledger: 422.
  router.post("/payments", requirePermission("payments", "Enter"), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body === "object" && "supplierId" in body) {
      const result = await recordSupplierPayment(parse(supplierPayment, body), req.user!.id, atLeast(effectiveAccess(req.user!.role, req.user!.stages, "payments"), "Full"));
      res.status(result.created ? 201 : 200).json({ payment: await view(result.id), ledger: await postedBalances(db, result.id) });
      return;
    }
    if (body.payeeRole === "supplier") throw validationFailed({ payeeRole: M.supplierOnOrder });
    const result = await recordAgentPayment(parse(agentPayment, body), req.user!.id);
    res.status(result.created ? 201 : 200).json({ payment: await view(result.id) });
  });

  // PAY-3. Management only (payments Full): voids the payment, with a reason. The row stays (voided, by whom, why) and
  // counts in no total; a posted payment also gets its reversing `payment_void`. The payment row is locked first, so a
  // second void waits and then answers 409 without writing anything. Nothing else changes: no other order or payment.
  router.delete("/payments/:id", requirePermission("payments", "Full"), async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Payment");
    const { reason, finalSettlementApproval: approval } = parse(voidPayment, req.body);
    const userId = req.user!.id;
    const result = await db.transaction(async (tx) => {
      await assertLedgerLive(tx);
      const [row] = await tx.select().from(payments).where(eq(payments.id, id)).for("update");
      if (!row) throw notFound("Payment");
      if (row.voidedAt) throw new HttpError(409, "already_voided", M.alreadyVoided);
      const [order] = row.orderId ? await tx.select({ po: orders.poNumber, supplierId: orders.supplierId, currency: orders.currency }).from(orders).where(eq(orders.id, row.orderId)) : [];
      const supplierId = row.supplierId ?? order!.supplierId;
      const currency = row.currency ?? order!.currency;
      if (await isHeld(tx, supplierId, currency)) throw conflict("account_held", LEDGER.held);
      // A supplier payment's void can take the credits that settle a protected final landed cost: approved or refused.
      const supplierMoney = row.payeeRole === "supplier" && row.status === "paid";
      if (supplierMoney) await lockAccount(tx, supplierId, currency);
      const finalChanged = supplierMoney ? await guardFinalSettlements(tx, supplierId, currency) : null;
      await tx.update(payments).set({ voidedAt: new Date(), voidedBy: userId, voidReason: reason, updatedAt: new Date() }).where(eq(payments.id, id));
      const posted = await postPaymentVoid(tx, id, userId, approval ? `${reason}; ${approvalNote(approval)}` : reason);
      if (finalChanged) requireFinalApproval(await finalChanged(), approval, true, FINAL.void);
      return { row, po: order?.po ?? null, currency, posted };
    });
    // The voided row and its reversal are the record; this line says who voided it, as deletions were logged before.
    const { row, po, currency, posted } = result;
    console.info(
      `Payment ${id} (${row.status} ${row.kind} ${money(row.amountCny, currency)} to ${row.payee}${po ? ` of ${po}` : ""}) voided by user ${userId}: ${reason}`,
    );
    res.json({
      payment: await view(id),
      ledger: posted ? { supplierId: posted.entry.supplierId, currency: posted.entry.currency, balanceBefore: posted.balanceBefore, balanceAfter: posted.balanceAfter } : null,
    });
  });

  // PAY-4. Management only (payments Full), as a void. Edits a current supplier payment (orderless, kind Payment) or a
  // shipping agent's. Mode, reference and notes change in place and post nothing. A new amount, date or rate is one
  // correction: the payment is voided as PAY-3 voids it ("Edited: <reason>") and a corrected copy is recorded and posted
  // as PAY-2 posts it, under the same M8 guard. The body's `clientRequestId` keys the copy: a retry replays it. A
  // submit that changes nothing answers 200 and writes nothing. A legacy order-linked supplier row (Deposit/Balance) is
  // always corrected (owner decisions of 2026-11-27): any change, text included, voids it and records a copy on the same
  // order, the two linked in the void reason and both postings; its credit's use decides what may change
  // (legacyRules), and the correction is refused (409 settlement_change, rolled back) when the account's settlement
  // after it differs from before in anything but the edited credit's free part (settlementDifferences).
  router.patch("/payments/:id", requirePermission("payments", "Full"), async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Payment");
    const input = parse(editPayment, req.body);
    const { reason, finalSettlementApproval: approval } = input;
    const userId = req.user!.id;
    const result = await db.transaction(async (tx) => {
      await assertLedgerLive(tx);
      await lockRequest(tx, input.clientRequestId);
      const [row] = await tx.select().from(payments).where(eq(payments.id, id)).for("update");
      if (!row) throw notFound("Payment");
      // Key-share locked before the account lock: the copy's insert needs this lock on its order (foreign key), and
      // REC-3, ORD-5 and ORD-8 lock the order row before the account, so taking it first keeps one lock order (a
      // receipt on the same order during a legacy correction waits instead of deadlocking).
      const [order] = row.orderId
        ? await tx.select({ po: orders.poNumber, supplierId: orders.supplierId, currency: orders.currency }).from(orders).where(eq(orders.id, row.orderId)).for("key share")
        : [];
      const supplierId = row.supplierId ?? order!.supplierId;
      const currency = row.currency ?? order!.currency;
      const fields = { amountCny: input.amount, paidOn: input.paidOn, rateInr: input.rateInr ?? 1, mode: input.mode, reference: input.reference, notes: input.notes };
      const supplierMoney = row.payeeRole === "supplier";
      // A retry of a correction already made replays it before any check that may have changed since (the original is
      // voided by then): same details 200, other details 409 (as PAY-2).
      const replay = await byRequest(tx, input.clientRequestId);
      if (replay) {
        if (replay.id === id || !row.voidedAt) throw conflict("idempotency_conflict", M.idempotencyConflict);
        sameDetails(replay, { orderId: row.orderId, supplierId: row.supplierId, currency: row.currency, kind: row.kind, payeeRole: row.payeeRole, ...fields });
        const [voided, credit] = supplierMoney ? await Promise.all([postedBalances(tx, id, "payment_void"), postedBalances(tx, replay.id)]) : [null, null];
        const ledger = credit ? { ...credit, balanceBefore: voided?.balanceBefore ?? credit.balanceBefore } : null;
        return { id: replay.id, replaced: id as string | null, ledger, log: null };
      }
      if (row.voidedAt) throw new HttpError(409, "already_voided", M.alreadyVoided);
      if (row.status !== "paid") throw conflict("not_editable", M.editDue);
      if (await isHeld(tx, supplierId, currency)) throw conflict("account_held", LEDGER.held);
      const rate = rateProblem(currency, input.rateInr, M.rateInr);
      if (rate) throw validationFailed({ rateInr: rate });
      const legacy = supplierMoney && (row.orderId !== null || row.kind !== "Payment");
      const was = `${row.kind} ${money(row.amountCny, currency)} paid ${row.paidOn} at ${row.rateInr} to ${row.payee}${order ? ` of ${order.po}` : ""}`;
      const moneyChanged = cents(fields.amountCny) !== cents(row.amountCny) || fields.paidOn !== row.paidOn || rateKey(fields.rateInr) !== rateKey(row.rateInr);
      const text = (["mode", "reference", "notes"] as const).filter((key) => fields[key] !== row[key]);
      if (!moneyChanged && text.length === 0) return { id, replaced: null, ledger: null, log: null };
      if (!moneyChanged && !legacy) {
        await tx.update(payments).set({ mode: fields.mode, reference: fields.reference, notes: fields.notes, updatedAt: new Date() }).where(eq(payments.id, id));
        return { id, replaced: null, ledger: null, log: `Payment ${id} (${was}) edited by user ${userId}: ${text.map((key) => `${key} ${JSON.stringify(row[key])} -> ${JSON.stringify(fields[key])}`).join(", ")}` };
      }
      if (!legacy && !reason) throw validationFailed({ reason: M.editReason });
      if (supplierMoney) await lockAccount(tx, supplierId, currency);
      // A legacy row: its credit's use, projected under the lock (reused by the M8 guard and the settlement guard).
      const before = legacy ? await loadLedger(tx, { supplierIds: [supplierId] }) : undefined;
      if (before) legacyRules(before.paymentSettlement(id), row, fields, reason, currency);
      // The copy's id is known up front, so the void (row and posting) names it and the copy's credit names the original.
      const newId = randomUUID();
      const edited = `Edited: ${reason}`;
      const voidReason = legacy ? `${edited}; replaced by payment ${newId}` : edited;
      const approved = approval ? `; ${approvalNote(approval)}` : "";
      const finalChanged = supplierMoney ? await guardFinalSettlements(tx, supplierId, currency, before) : null;
      await tx.update(payments).set({ voidedAt: new Date(), voidedBy: userId, voidReason, updatedAt: new Date() }).where(eq(payments.id, id));
      // Dated at the original's date, so the statement's running balance never counts both credits in between.
      const voided = await postPaymentVoid(tx, id, userId, `${voidReason}${approved}`, row.paidOn!);
      await tx.insert(payments).values({
        id: newId,
        orderId: row.orderId,
        supplierId: row.supplierId,
        currency: row.currency,
        kind: row.kind,
        payee: row.payee,
        payeeRole: row.payeeRole,
        status: "paid",
        ...fields,
        clientRequestId: input.clientRequestId,
        createdBy: userId,
      });
      const creditNotes = `${legacy ? `${edited}; replaces payment ${id}` : edited}${approved}`;
      const credit = supplierMoney
        ? await postPaymentCredit(tx, { id: newId, supplierId, currency, amount: fields.amountCny, exchangeRate: fields.rateInr, paidOn: fields.paidOn }, userId, creditNotes)
        : null;
      // Legacy: the settlement must be unchanged but for the edited credit's free part (original and copy as one credit).
      const after = before ? await loadLedger(tx, { supplierIds: [supplierId] }) : undefined;
      if (before && after) {
        const moved = settlementDifferences(before, after, supplierId, currency, new Map([[voided!.entry.reversesId!, credit!.entry.id]]));
        if (moved.changed) throw conflict("settlement_change", M.settlementChange(moved.orderIds.map((orderId) => before.poOf(orderId) ?? orderId)));
      }
      if (finalChanged) requireFinalApproval(await finalChanged(after), approval, true, FINAL.edit);
      const ledger = credit ? { supplierId, currency, balanceBefore: voided?.balanceBefore ?? credit.balanceBefore, balanceAfter: credit.balanceAfter } : null;
      const now = `${money(fields.amountCny, currency)} paid ${fields.paidOn} at ${fields.rateInr}`;
      return { id: newId, replaced: id as string | null, ledger, log: `Payment ${id} (${was}) replaced by ${newId} (${now}) by user ${userId}: ${reason}` };
    });
    // The voided row, its replacement and their postings are the record; this line says who changed what, as PAY-3 logs.
    if (result.log) console.info(result.log);
    res.json({ payment: await view(result.id), replaced: result.replaced, ledger: result.ledger });
  });

  return router;
}
