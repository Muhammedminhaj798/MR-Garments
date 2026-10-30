import { eq, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { STATUSES, transportCompanies, transports } from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { deleteRoute } from "./delete-route";
import { contactSearch, creationOrder, listRoute } from "./list-query";

// Owner: A2 (docs/wave3-contracts.md section 4). MD-10 GET /transport-companies, POST /transport-companies and
// PATCH /transport-companies/:id, DELETE /transport-companies/:id (section 4.1). Management only (B6).

export const MESSAGES = {
  nameEmpty: "Enter the transport company name.",
  nameTaken: "A transport company with this name already exists.",
  tooLong: "Use 200 characters or fewer.",
  status: "Choose Active or Inactive.",
};
const M = MESSAGES;

const text = z.string().trim().max(200, M.tooLong);
const fields = {
  name: z.string({ error: M.nameEmpty }).trim().min(1, M.nameEmpty).max(200, M.tooLong),
  contactPerson: text,
  phone: text,
};
const create = z.strictObject({ ...fields, contactPerson: text.default(""), phone: text.default("") });
const update = z.strictObject({ ...fields, status: z.enum(STATUSES, { error: M.status }) }).partial();

const columns = {
  id: transportCompanies.id,
  name: transportCompanies.name,
  contactPerson: transportCompanies.contactPerson,
  phone: transportCompanies.phone,
  // Every trip, on the road or unloaded.
  tripsSoFar: sql<number>`(select count(*) from ${transports} where ${eq(transports.transportCompanyId, transportCompanies.id)})`.mapWith(Number),
  status: transportCompanies.status,
};

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** The unique index on lower(name) decides duplicates, so two simultaneous saves can't both take a name. */
function nameTakenAsConflict(error: unknown): never {
  type PgError = { code?: string; constraint?: string; cause?: PgError };
  const pg = (error as PgError)?.cause ?? (error as PgError);
  if (pg?.code === "23505" && pg.constraint === "transport_companies_name_unique") throw conflict("name_exists", M.nameTaken, { name: M.nameTaken });
  throw error;
}

export function transportCompaniesRoutes({ db }: RouteContext) {
  const router = Router();
  const admin = requirePermission("admin", "Full");
  const select = (where?: SQL) => db.select(columns).from(transportCompanies).where(where).orderBy(...creationOrder(transportCompanies));
  const findRow = async (id: string) => (await select(eq(transportCompanies.id, id)))[0]!;

  listRoute(router, "/transport-companies", () => select(), contactSearch);

  router.post("/transport-companies", admin, async (req, res) => {
    const input = parse(create, req.body);
    const created = await db.insert(transportCompanies).values(input).onConflictDoNothing().returning({ id: transportCompanies.id });
    if (!created[0]) throw conflict("name_exists", M.nameTaken, { name: M.nameTaken });
    res.status(201).json({ transportCompany: await findRow(created[0].id) });
  });

  // Only the keys sent change.
  router.patch("/transport-companies/:id", admin, async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Transport company");
    const input = parse(update, req.body);
    if (Object.keys(input).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
    const updated = await db
      .update(transportCompanies)
      .set(input)
      .where(eq(transportCompanies.id, id))
      .returning({ id: transportCompanies.id })
      .catch(nameTakenAsConflict);
    if (!updated[0]) throw notFound("Transport company");
    res.json({ transportCompany: await findRow(id) });
  });

  deleteRoute(router, db, "/transport-companies", transportCompanies, "Transport company", [
    { what: "trip", table: transports, of: (id) => eq(transports.transportCompanyId, id) },
  ]);

  return router;
}
