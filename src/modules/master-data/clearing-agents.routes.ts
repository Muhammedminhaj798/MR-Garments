import { and, eq, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { clearingAgents, clearings, STATUSES } from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { deleteRoute } from "./delete-route";
import { contactSearch, creationOrder, listRoute } from "./list-query";

// Owner: A2 (docs/wave3-contracts.md section 4). MD-7 GET /clearing-agents, POST /clearing-agents and
// PATCH /clearing-agents/:id, DELETE /clearing-agents/:id (section 4.1). Management only (B6).

export const MESSAGES = {
  nameEmpty: "Enter the clearing agent name.",
  nameTaken: "A clearing agent with this name already exists.",
  tooLong: "Use 200 characters or fewer.",
  status: "Choose Active or Inactive.",
};
const M = MESSAGES;

const text = z.string().trim().max(200, M.tooLong);
const fields = {
  name: z.string({ error: M.nameEmpty }).trim().min(1, M.nameEmpty).max(200, M.tooLong),
  contactPerson: text,
  phone: text,
  port: text,
};
const create = z.strictObject({ ...fields, contactPerson: text.default(""), phone: text.default(""), port: text.default("") });
const update = z.strictObject({ ...fields, status: z.enum(STATUSES, { error: M.status }) }).partial();

const columns = {
  id: clearingAgents.id,
  name: clearingAgents.name,
  contactPerson: clearingAgents.contactPerson,
  phone: clearingAgents.phone,
  port: clearingAgents.port,
  containersCleared: sql<number>`(select count(*) from ${clearings} where ${and(
    eq(clearings.clearingAgentId, clearingAgents.id),
    eq(clearings.status, "cleared"),
  )})`.mapWith(Number),
  status: clearingAgents.status,
};

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** The unique index on lower(name) decides duplicates, so two simultaneous saves can't both take a name. */
function nameTakenAsConflict(error: unknown): never {
  type PgError = { code?: string; constraint?: string; cause?: PgError };
  const pg = (error as PgError)?.cause ?? (error as PgError);
  if (pg?.code === "23505" && pg.constraint === "clearing_agents_name_unique") throw conflict("name_exists", M.nameTaken, { name: M.nameTaken });
  throw error;
}

export function clearingAgentsRoutes({ db }: RouteContext) {
  const router = Router();
  const admin = requirePermission("admin", "Full");
  const select = (where?: SQL) => db.select(columns).from(clearingAgents).where(where).orderBy(...creationOrder(clearingAgents));
  const findRow = async (id: string) => (await select(eq(clearingAgents.id, id)))[0]!;

  listRoute(router, "/clearing-agents", () => select(), contactSearch);

  router.post("/clearing-agents", admin, async (req, res) => {
    const input = parse(create, req.body);
    const created = await db.insert(clearingAgents).values(input).onConflictDoNothing().returning({ id: clearingAgents.id });
    if (!created[0]) throw conflict("name_exists", M.nameTaken, { name: M.nameTaken });
    res.status(201).json({ clearingAgent: await findRow(created[0].id) });
  });

  // Only the keys sent change.
  router.patch("/clearing-agents/:id", admin, async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Clearing agent");
    const input = parse(update, req.body);
    if (Object.keys(input).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
    const updated = await db
      .update(clearingAgents)
      .set(input)
      .where(eq(clearingAgents.id, id))
      .returning({ id: clearingAgents.id })
      .catch(nameTakenAsConflict);
    if (!updated[0]) throw notFound("Clearing agent");
    res.json({ clearingAgent: await findRow(id) });
  });

  // One clearing per container.
  deleteRoute(router, db, "/clearing-agents", clearingAgents, "Clearing agent", [
    { what: "container", table: clearings, of: (id) => eq(clearings.clearingAgentId, id) },
  ]);

  return router;
}
