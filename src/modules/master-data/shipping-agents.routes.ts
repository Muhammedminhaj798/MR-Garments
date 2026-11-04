import { and, count, eq, inArray, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { containers, payments, shippingAgents, STATUSES } from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { deleteRoute } from "./delete-route";
import { contactSearch, creationOrder, listRoute } from "./list-query";

// Owner: A1 (docs/wave3-contracts.md section 4). MD-4 GET /shipping-agents, POST /shipping-agents and
// PATCH /shipping-agents/:id, DELETE /shipping-agents/:id (section 4.1). Management only (B6).

const NAME_EMPTY = "Enter the shipping agent name.";
const NAME_TAKEN = "A shipping agent with this name already exists.";
const NAME_PAID = (n: number) => `${n} payment${n === 1 ? " is" : "s are"} recorded under this name, so it can't change.`;
const tooLong = (max: number) => `Use ${max} characters or fewer.`;

const isUuid = (value: string) => z.uuid().safeParse(value).success;
// Optional text: left out on create, the column default ("") applies.
const text = z.string().trim().max(200, tooLong(200)).optional();
const fields = {
  name: z.string({ error: NAME_EMPTY }).trim().min(1, NAME_EMPTY).max(200, tooLong(200)),
  contactPerson: text,
  phone: text,
  officeCity: text,
};
const newAgent = z.strictObject(fields);
const changes = z.strictObject({ ...fields, status: z.enum(STATUSES) }).partial();

/** The unique index on lower(name) decides duplicates, so two simultaneous saves can't both succeed. */
function nameTakenAsConflict(error: unknown): never {
  type PgError = { code?: string; constraint?: string; cause?: PgError };
  const pg = (error as PgError)?.cause ?? (error as PgError);
  if (pg?.code === "23505" && pg.constraint === "shipping_agents_name_unique") throw conflict("name_exists", NAME_TAKEN, { name: NAME_TAKEN });
  throw error;
}

export function shippingAgentsRoutes({ db }: RouteContext) {
  const router = Router();
  const admin = requirePermission("admin", "Full");

  /** MD-4 rows (one when `id` is given). Active containers: the agent's containers still loading or at sea. */
  const load = (id?: string) =>
    db
      .select({
        id: shippingAgents.id,
        name: shippingAgents.name,
        contactPerson: shippingAgents.contactPerson,
        phone: shippingAgents.phone,
        officeCity: shippingAgents.officeCity,
        activeContainers: count(containers.id),
        status: shippingAgents.status,
      })
      .from(shippingAgents)
      .leftJoin(containers, and(eq(containers.shippingAgentId, shippingAgents.id), inArray(containers.status, ["loading", "sea"])))
      .where(id ? eq(shippingAgents.id, id) : undefined)
      .groupBy(shippingAgents.id)
      .orderBy(...creationOrder(shippingAgents));

  listRoute(router, "/shipping-agents", async () => load(), contactSearch);

  router.post("/shipping-agents", admin, async (req, res) => {
    const input = parse(newAgent, req.body);
    const created = await db.insert(shippingAgents).values(input).returning({ id: shippingAgents.id }).catch(nameTakenAsConflict);
    res.status(201).json({ shippingAgent: (await load(created[0]!.id))[0] });
  });

  router.patch("/shipping-agents/:id", admin, async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Shipping agent");
    const input = parse(changes, req.body);
    if (Object.keys(input).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
    const updated = await db
      .transaction(async (tx) => {
        // Agent payments keep the agent's name, not its id: a rename would cut them off from the agent (and let DELETE
        // miss them), so a paid agent keeps its name; only its letter case may change. The row lock makes a rename or
        // delete of the same agent wait.
        // PAY-2 and ORD-3 read an agent payee's name under a share lock on this row, so they wait for a rename here.
        if (input.name !== undefined) {
          // Compared in SQL with lower(), as DELETE and the unique name index compare them.
          const current = (
            await tx
              .select({ name: shippingAgents.name, sameName: sql<boolean>`lower(${shippingAgents.name}) = lower(${input.name})` })
              .from(shippingAgents)
              .where(eq(shippingAgents.id, id))
              .for("update")
          )[0];
          if (current && !current.sameName) {
            const paid = (
              await tx
                .select({ n: count() })
                .from(payments)
                .where(and(eq(payments.payeeRole, "agent"), sql`lower(${payments.payee}) = lower(${current.name})`))
            )[0]!.n;
            if (paid > 0) throw validationFailed({ name: NAME_PAID(paid) });
          }
        }
        return tx.update(shippingAgents).set(input).where(eq(shippingAgents.id, id)).returning({ id: shippingAgents.id });
      })
      .catch(nameTakenAsConflict);
    if (!updated[0]) throw notFound("Shipping agent");
    res.json({ shippingAgent: (await load(id))[0] });
  });

  deleteRoute(router, db, "/shipping-agents", shippingAgents, "Shipping agent", [
    { what: "container", table: containers, of: (id) => eq(containers.shippingAgentId, id) },
    // An agent payment keeps the agent's name, not its id.
    {
      what: "agent payment",
      table: payments,
      of: (id) =>
        and(
          eq(payments.payeeRole, "agent"),
          sql`lower(${payments.payee}) = (select lower(${shippingAgents.name}) from ${shippingAgents} where ${shippingAgents.id} = ${id})`,
        ),
    },
  ]);

  return router;
}
