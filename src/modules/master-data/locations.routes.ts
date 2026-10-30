import { and, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { LOCATION_TYPES, locations, receipts, STATUSES, transports, users, warehouseReceipts } from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { deleteRoute } from "./delete-route";
import { creationOrder, listRoute } from "./list-query";

// Owner: A3 (docs/wave3-contracts.md section 4). MD-13 GET /locations, POST /locations, PATCH /locations/:id,
// DELETE /locations/:id (section 4.1).

// Proposed wording (the contract gives the pattern, not the noun).
const M = {
  name: "Enter the office or warehouse name.",
  nameTaken: "An office or warehouse with this name already exists.",
  nameLong: "Use 200 characters or fewer.",
  type: "Choose a type.",
  addressLong: "Use 1000 characters or fewer.",
  status: "Choose Active or Inactive.",
};

const name = z.string({ error: M.name }).trim().min(1, M.name).max(200, M.nameLong);
const address = z.string().trim().max(1000, M.addressLong);
const newLocation = z.strictObject({ name, type: z.enum(LOCATION_TYPES, { error: M.type }), address: address.default("") });
// The type can't change (default rule): receipts, users and trips rely on it, so PATCH refuses the key (400).
const editLocation = z.strictObject({ name, address, status: z.enum(STATUSES, { error: M.status }) }).partial();

const isUuid = (value: string) => z.uuid().safeParse(value).success;
const nameTaken = () => conflict("name_exists", M.nameTaken, { name: M.nameTaken });

/** A rename onto another location's name hits the unique index on lower(name): the same 409 as an add. */
function renameConflict(error: unknown): never {
  type PgError = { code?: string; constraint?: string; cause?: PgError };
  const pg = (error as PgError)?.cause ?? (error as PgError);
  if (pg?.code === "23505" && pg.constraint === "locations_name_unique") throw nameTaken();
  throw error;
}

export function locationsRoutes({ db }: RouteContext) {
  const router = Router();
  const admin = requirePermission("admin", "Full");

  // Staff: the names of the active users at each location, in user list order (B6.3).
  const load = async (id?: string) => {
    const staff = await db
      .select({ name: users.name, locationId: users.locationId })
      .from(users)
      .where(and(eq(users.status, "Active"), id ? eq(users.locationId, id) : undefined))
      .orderBy(...creationOrder(users));
    const rows = await db
      .select({
        id: locations.id,
        name: locations.name,
        type: locations.type,
        country: locations.country,
        address: locations.address,
        status: locations.status,
      })
      .from(locations)
      .where(id ? eq(locations.id, id) : undefined)
      .orderBy(...creationOrder(locations));
    return rows.map(({ status, ...row }) => ({
      ...row,
      staff: staff.filter((user) => user.locationId === row.id).map((user) => user.name),
      status,
    }));
  };

  listRoute(router, "/locations", () => load(), (row) => [row.name, row.address, ...row.staff]);

  router.post("/locations", admin, async (req, res) => {
    const input = parse(newLocation, req.body);
    // The unique index on lower(name) decides duplicates, so two simultaneous adds can't both succeed.
    const created = await db
      .insert(locations)
      .values({ ...input, country: input.type === "China office" ? "China" : "India" })
      .onConflictDoNothing()
      .returning({ id: locations.id });
    if (!created[0]) throw nameTaken();
    res.status(201).json({ location: (await load(created[0].id))[0] });
  });

  // Deactivating keeps the location on its users: the user edit doesn't re-check an unchanged office (USR-4).
  router.patch("/locations/:id", admin, async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Office or warehouse");
    const input = parse(editLocation, req.body);
    if (Object.keys(input).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
    const updated = await db.update(locations).set(input).where(eq(locations.id, id)).returning({ id: locations.id }).catch(renameConflict);
    if (!updated[0]) throw notFound("Office or warehouse");
    res.json({ location: (await load(id))[0] });
  });

  // Users of any status: a user is never deleted, so an inactive user's office stays.
  deleteRoute(router, db, "/locations", locations, "Office or warehouse", [
    { what: "user", table: users, of: (id) => eq(users.locationId, id) },
    { what: "China receipt", table: receipts, of: (id) => eq(receipts.locationId, id) },
    { what: "trip", table: transports, of: (id) => eq(transports.destinationId, id) },
    { what: "warehouse receipt", table: warehouseReceipts, of: (id) => eq(warehouseReceipts.locationId, id) },
  ]);

  return router;
}
