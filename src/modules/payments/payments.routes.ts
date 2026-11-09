import { and, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import type { Database } from "../../db/client";
import { orders, PAYEE_ROLES, PAYMENT_KINDS, payments, shippingAgents, suppliers } from "../../db/schema";
import { notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { money, notify } from "../notifications/notify";
import { rateProblem } from "../orders/orders.routes";
import { isUuid } from "../stages/common";

// Owner: BE-payments. PAY-2 POST /payments (docs/live-screens-contracts.md, "Five-tab completion"), PAY-3 DELETE
// /payments/:id. Payments are records only: nothing here moves money. The amount is in the order's currency; `rateInr`
// is INR per 1 of it (none, stored as 1, for an INR order).

export const MESSAGES = {
  order: "Choose an order from the list.",
  kind: "Choose Deposit or Balance.",
  payeeRole: "Choose who the payment was paid to.",
  agent: "Choose a shipping agent from the list.",
  agentForSupplier: "Leave the shipping agent empty when the supplier was paid.",
  amount: "Enter an amount above 0.",
  paidOn: "Enter the date the payment was made.",
  paidOnFuture: "The payment date can't be in the future.",
  rateInr: "Enter an INR rate above 0.",
  mode: "Enter the payment mode.",
  modeTooLong: "Use 100 characters or fewer for the mode.",
  referenceTooLong: "Use 100 characters or fewer for the reference.",
  notesTooLong: "Use 1,000 characters or fewer for the notes.",
};
const M = MESSAGES;

/** Today in India (Asia/Kolkata, UTC+5:30, no daylight saving) as YYYY-MM-DD. */
const todayInIndia = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

// Upper bounds keep values inside the numeric columns, so an absurd number is a 422, not a 500.
const newPayment = z.strictObject({
  orderId: z.uuid({ error: M.order }),
  kind: z.enum(PAYMENT_KINDS, { error: M.kind }),
  payeeRole: z.enum(PAYEE_ROLES, { error: M.payeeRole }),
  agentId: z.uuid({ error: M.agent }).nullable().default(null),
  amountCny: z.number({ error: M.amount }).min(0.01, M.amount).max(999_999_999_999, M.amount),
  paidOn: z.iso.date({ error: M.paidOn }).refine((day) => day <= todayInIndia(), M.paidOnFuture),
  rateInr: z.number({ error: M.rateInr }).min(0.0001, M.rateInr).max(99_999_999, M.rateInr).optional(),
  mode: z.string({ error: M.mode }).trim().min(1, M.mode).max(100, M.modeTooLong),
  // Transaction or receipt number and notes (0008); left out by an older frontend, both are "".
  reference: z.string({ error: M.referenceTooLong }).trim().max(100, M.referenceTooLong).default(""),
  notes: z.string({ error: M.notesTooLong }).trim().max(1000, M.notesTooLong).default(""),
});
type NewPayment = z.infer<typeof newPayment>;

/** The payee's name (the order's supplier, or the active agent), the PO and its currency, or 422 with every problem found (E1). */
async function payeeName(db: Pick<Database, "select">, input: NewPayment) {
  const problems: Record<string, string> = {};
  const order = await db
    .select({ supplier: suppliers.name, po: orders.poNumber, currency: orders.currency })
    .from(orders)
    .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
    .where(eq(orders.id, input.orderId));
  if (order.length === 0) problems.orderId = M.order;
  const rate = order[0] && rateProblem(order[0].currency, input.rateInr, M.rateInr);
  if (rate) problems.rateInr = rate;

  let agent: string | undefined;
  if (input.payeeRole === "supplier") {
    if (input.agentId !== null) problems.agentId = M.agentForSupplier;
  } else if (input.agentId === null) {
    problems.agentId = M.agent;
  } else {
    const rows = await db
      .select({ name: shippingAgents.name })
      .from(shippingAgents)
      .where(and(eq(shippingAgents.id, input.agentId), eq(shippingAgents.status, "Active")))
      .for("share");
    agent = rows[0]?.name;
    if (!agent) problems.agentId = M.agent;
  }

  if (Object.keys(problems).length > 0) throw validationFailed(problems);
  return { payee: input.payeeRole === "supplier" ? order[0]!.supplier : agent!, po: order[0]!.po, currency: order[0]!.currency };
}

export function paymentsRoutes({ db }: RouteContext) {
  const router = Router();

  // PAY-2. A payment already made: saved as paid, at any stage. No overpayment check (the balance may go below 0).
  router.post("/payments", requirePermission("payments", "Enter"), async (req, res) => {
    const input = parse(newPayment, req.body);
    const payment = await db.transaction(async (tx) => {
      // Read inside the transaction, the agent's row share-locked: an agent payment keeps the agent's name, so a rename
      // or delete of that agent waits for this payment and then counts it (master-data DELETE, shipping-agent PATCH).
      const { payee, po, currency } = await payeeName(tx, input);
      const created = (
        await tx
          .insert(payments)
          .values({
            orderId: input.orderId,
            kind: input.kind,
            payee,
            payeeRole: input.payeeRole,
            amountCny: input.amountCny,
            status: "paid",
            paidOn: input.paidOn,
            rateInr: input.rateInr ?? 1,
            mode: input.mode,
            reference: input.reference,
            notes: input.notes,
            createdBy: req.user!.id,
          })
          .returning({ id: payments.id })
      )[0]!;
      await notify(tx, {
        kind: "payment-recorded",
        actorId: req.user!.id,
        sourceId: created.id,
        title: `${po} payment recorded`,
        details: [`${input.kind} ${money(input.amountCny, currency)}`, payee],
        href: (canView) => (canView("ordersView") ? `/orders/${encodeURIComponent(po)}/payments` : "/payments"),
      });
      return created;
    });
    res.status(201).json({ payment });
  });

  // PAY-3. Management only (payments Full). A deposit or a balance payment, paid or due. One transaction: the payment's
  // order locked first (as ORD-5 and ORD-6 lock it, so an order edit or delete can't interleave), then the payment. Only
  // that row goes. No figure is stored: the order's paid, INR and balance, the supplier's paid and outstanding, landed
  // cost (goods or sea freight), deposits paid on receiving, reports and the dashboard all sum the payments live, each at
  // its own rate. Nothing links to a payment (no reconciliation, settlement or allocation exists), so nothing refuses it.
  // The order, its other payments and the payment-recorded notification stay.
  router.delete("/payments/:id", requirePermission("payments", "Full"), async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Payment");
    const deleted = await db.transaction(async (tx) => {
      const found = (await tx.select({ orderId: payments.orderId }).from(payments).where(eq(payments.id, id)))[0];
      if (!found) throw notFound("Payment");
      const order = (await tx.select({ po: orders.poNumber, currency: orders.currency }).from(orders).where(eq(orders.id, found.orderId)).for("update"))[0]!;
      // Read again under the lock: a delete of the same payment that got there first leaves nothing (404).
      const row = (
        await tx
          .select({ kind: payments.kind, status: payments.status, payee: payments.payee, amountCny: payments.amountCny })
          .from(payments)
          .where(eq(payments.id, id))
          .for("update")
      )[0];
      if (!row) throw notFound("Payment");
      await tx.delete(payments).where(eq(payments.id, id));
      return { ...row, ...order };
    });
    // ponytail: the server log is the deletion record; an audit table needs a migration, add one when audits are asked for.
    console.info(
      `Payment ${id} (${deleted.status} ${deleted.kind} ${money(deleted.amountCny, deleted.currency)} to ${deleted.payee}) of ${deleted.po} deleted by user ${req.user!.id}.`,
    );
    res.status(204).end();
  });

  return router;
}
