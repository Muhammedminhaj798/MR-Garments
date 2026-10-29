import { and, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { orders, PAYEE_ROLES, PAYMENT_KINDS, payments, shippingAgents, suppliers } from "../../db/schema";
import { validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { cny, notify } from "../notifications/notify";

// Owner: BE-payments. PAY-2 POST /payments (docs/live-screens-contracts.md, "Five-tab completion"). Payments are
// records only: nothing here moves money.

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
  rateInr: z.number({ error: M.rateInr }).min(0.0001, M.rateInr).max(99_999_999, M.rateInr),
  mode: z.string({ error: M.mode }).trim().min(1, M.mode).max(100, M.modeTooLong),
});
type NewPayment = z.infer<typeof newPayment>;

/** The payee's name (the order's supplier, or the active agent) and the PO, or 422 with every problem found (E1). */
async function payeeName(db: RouteContext["db"], input: NewPayment) {
  const problems: Record<string, string> = {};
  const order = await db
    .select({ supplier: suppliers.name, po: orders.poNumber })
    .from(orders)
    .innerJoin(suppliers, eq(suppliers.id, orders.supplierId))
    .where(eq(orders.id, input.orderId));
  if (order.length === 0) problems.orderId = M.order;

  let agent: string | undefined;
  if (input.payeeRole === "supplier") {
    if (input.agentId !== null) problems.agentId = M.agentForSupplier;
  } else if (input.agentId === null) {
    problems.agentId = M.agent;
  } else {
    const rows = await db
      .select({ name: shippingAgents.name })
      .from(shippingAgents)
      .where(and(eq(shippingAgents.id, input.agentId), eq(shippingAgents.status, "Active")));
    agent = rows[0]?.name;
    if (!agent) problems.agentId = M.agent;
  }

  if (Object.keys(problems).length > 0) throw validationFailed(problems);
  return { payee: input.payeeRole === "supplier" ? order[0]!.supplier : agent!, po: order[0]!.po };
}

export function paymentsRoutes({ db }: RouteContext) {
  const router = Router();

  // PAY-2. A payment already made: saved as paid, at any stage. No overpayment check (the balance may go below 0).
  router.post("/payments", requirePermission("payments", "Enter"), async (req, res) => {
    const input = parse(newPayment, req.body);
    const { payee, po } = await payeeName(db, input);
    const payment = await db.transaction(async (tx) => {
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
            rateInr: input.rateInr,
            mode: input.mode,
            createdBy: req.user!.id,
          })
          .returning({ id: payments.id })
      )[0]!;
      await notify(tx, {
        kind: "payment-recorded",
        capability: "payments",
        actorId: req.user!.id,
        sourceId: created.id,
        title: `${po} payment recorded`,
        details: [`${input.kind} ${cny(input.amountCny)}`, payee],
        href: (canView) => (canView("ordersView") ? `/orders/${po}/payments` : "/payments"),
      });
      return created;
    });
    res.status(201).json({ payment });
  });

  return router;
}
