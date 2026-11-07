import { eq, inArray, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import type { Database } from "../../db/client";
import { items, STATUSES, units } from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { deleteRoute } from "./delete-route";
import { creationOrder, listRoute } from "./list-query";

// Units an item is counted in (Settings, Units): GET /units, POST /units, PATCH /units/:id, DELETE /units/:id,
// Management only (B6), built like MD-16 Teams. An item keeps its unit's name (items.counted_in follows a rename);
// deactivating a unit only keeps it off new items, and a unit any item uses can't be deleted (409 in_use).

export const MESSAGES = {
  name: "Enter the unit name.",
  nameTooLong: "Use 50 characters or fewer.",
  nameTaken: "A unit with this name already exists.",
  symbolTooLong: "Use 10 characters or fewer.",
  status: "Choose Active or Inactive.",
};
const M = MESSAGES;

const fields = {
  name: z.string({ error: M.name }).trim().min(1, M.name).max(50, M.nameTooLong),
  symbol: z.string({ error: M.symbolTooLong }).trim().max(10, M.symbolTooLong),
  status: z.enum(STATUSES, { error: M.status }),
};
const newUnit = z.strictObject({ name: fields.name, symbol: fields.symbol.default("") });
const unitUpdate = z.strictObject(fields).partial();

const isUuid = (value: string) => z.uuid().safeParse(value).success;
const nameTaken = () => conflict("name_exists", M.nameTaken, { name: M.nameTaken });

/** A rename onto another unit's name hits a unique index (as typed, or in another letter case): the same 409 as an add. */
function renameConflict(error: unknown): never {
  type PgError = { code?: string; constraint?: string; cause?: PgError };
  const pg = (error as PgError)?.cause ?? (error as PgError);
  if (pg?.code === "23505" && (pg.constraint === "units_name_unique" || pg.constraint === "units_name_key")) throw nameTaken();
  throw error;
}

// The names of the items counted in this unit, in their creation order.
const itemsInUnit = sql`select ${items.name} from ${items} where ${items.countedIn} = ${units.name} order by ${items.createdAt}, ${items.name}`;
// Nested, so the columns keep their table names: drizzle drops them from a single-table select's top-level columns.
const usedByItems = sql<string[]>`array(${itemsInUnit})`;

function unitRows(db: Database, id?: string) {
  return db
    .select({ id: units.id, name: units.name, symbol: units.symbol, usedByItems, status: units.status })
    .from(units)
    .where(id ? eq(units.id, id) : undefined)
    .orderBy(...creationOrder(units));
}

export function unitsRoutes({ db }: RouteContext) {
  const router = Router();
  const admin = requirePermission("admin", "Full");

  listRoute(router, "/units", () => unitRows(db), (row) => [row.name, row.symbol]);

  router.post("/units", admin, async (req, res) => {
    const input = parse(newUnit, req.body);
    // The unique indexes decide duplicates, so two simultaneous adds can't both succeed.
    const created = await db.insert(units).values(input).onConflictDoNothing().returning({ id: units.id });
    if (!created[0]) throw nameTaken();
    res.status(201).json({ unit: (await unitRows(db, created[0].id))[0] });
  });

  // Only the keys sent change. A rename reaches every item counted in the unit (the foreign key cascades it).
  router.patch("/units/:id", admin, async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Unit");
    const input = parse(unitUpdate, req.body);
    if (Object.keys(input).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
    const updated = await db.update(units).set(input).where(eq(units.id, id)).returning({ id: units.id }).catch(renameConflict);
    if (!updated[0]) throw notFound("Unit");
    res.json({ unit: (await unitRows(db, id))[0] });
  });

  deleteRoute(router, db, "/units", units, "Unit", [
    { what: "item", table: items, of: (id) => inArray(items.countedIn, db.select({ name: units.name }).from(units).where(eq(units.id, id))) },
  ]);

  return router;
}
