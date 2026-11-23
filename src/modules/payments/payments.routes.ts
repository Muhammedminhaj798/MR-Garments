import { and, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { currencyCode } from "../../currencies";
import type { Database } from "../../db/client";
import { orders, payments, shippingAgents, supplierLedgerEntries, suppliers } from "../../db/schema";
import { conflict, HttpError, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { atLeast, effectiveAccess } from "../../permissions/matrix";
import { guardFinalSettlements } from "../costs/landed-cost";
import { assertLedgerLive, cents, fromCents, isHeld, loadLedger, lockAccount, MESSAGES as LEDGER, paymentQuery, paymentRow, postPaymentCredit, postPaymentVoid } from "../ledger/ledger";
import { currencyOptions } from "../ledger/ledger.routes";
import { money, notify } from "../notifications/notify";
import { rateProblem } from "../orders/orders.routes";
import { isUuid, todayInIndia } from "../stages/common";

// Owner: BE-payments. PAY-2 POST /payments and PAY-3 DELETE /payments/:id (docs/unified-ledger.md). A supplier payment
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

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

type Stored = typeof payments.$inferSelect;

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

/** The balances a supplier payment's credit left its account with when it was posted (a replayed PAY-2 answers them again). */
async function postedBalances(db: Pick<Database, "select">, paymentId: string) {
  const e = supplierLedgerEntries;
  const [credit] = await db.select().from(e).where(and(eq(e.paymentId, paymentId), eq(e.entryType, "payment")));
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
  const view = async (id: string) => paymentRow((await paymentQuery(db, eq(payments.id, id)))[0]!);

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

  return router;
}
