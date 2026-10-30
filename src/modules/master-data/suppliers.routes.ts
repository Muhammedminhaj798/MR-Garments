import { and, count, eq, lt } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { orders, STATUSES, suppliers } from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { deleteRoute } from "./delete-route";
import { contactSearch, creationOrder, listRoute } from "./list-query";

// Owner: A1 (docs/wave3-contracts.md section 4). MD-1 GET /suppliers, MD-2 POST /suppliers (docs/contracts.md) and
// PATCH /suppliers/:id, DELETE /suppliers/:id (section 4.1). Management only (B6).

const NAME_EMPTY = "Enter the supplier name."; // M21
const NAME_TAKEN = "A supplier with this name already exists."; // M22
const tooLong = (max: number) => `Use ${max} characters or fewer.`;

const isUuid = (value: string) => z.uuid().safeParse(value).success;
// Optional text: left out on create, the column default ("") applies.
const text = (max = 200) => z.string().trim().max(max, tooLong(max)).optional();
const fields = {
  name: z.string({ error: NAME_EMPTY }).trim().min(1, NAME_EMPTY).max(200, tooLong(200)),
  city: text(),
  contactPerson: text(),
  phone: text(),
  address: text(1000),
  notes: text(1000),
};
const newSupplier = z.strictObject({ ...fields, currency: z.literal("CNY").optional() });
// The currency stays CNY, so PATCH doesn't take it.
const changes = z.strictObject({ ...fields, status: z.enum(STATUSES) }).partial();

/** The unique index on lower(name) decides duplicates, so two simultaneous saves can't both succeed. */
function nameTakenAsConflict(error: unknown): never {
  type PgError = { code?: string; constraint?: string; cause?: PgError };
  const pg = (error as PgError)?.cause ?? (error as PgError);
  if (pg?.code === "23505" && pg.constraint === "suppliers_name_unique") throw conflict("name_exists", NAME_TAKEN, { name: NAME_TAKEN });
  throw error;
}

export function suppliersRoutes({ db }: RouteContext) {
  const router = Router();
  const admin = requirePermission("admin", "Full");

  /** MD-1 rows (one when `id` is given). Open orders: the supplier's orders not yet received in the warehouse (stage < 6). */
  const load = (id?: string) =>
    db
      .select({
        id: suppliers.id,
        name: suppliers.name,
        contactPerson: suppliers.contactPerson,
        phone: suppliers.phone,
        city: suppliers.city,
        address: suppliers.address,
        notes: suppliers.notes,
        currency: suppliers.currency,
        openOrders: count(orders.id),
        status: suppliers.status,
      })
      .from(suppliers)
      .leftJoin(orders, and(eq(orders.supplierId, suppliers.id), lt(orders.stage, 6)))
      .where(id ? eq(suppliers.id, id) : undefined)
      .groupBy(suppliers.id)
      .orderBy(...creationOrder(suppliers));

  listRoute(router, "/suppliers", async () => load(), contactSearch);

  router.post("/suppliers", admin, async (req, res) => {
    const input = parse(newSupplier, req.body);
    const created = await db
      .insert(suppliers)
      .values({ ...input, createdBy: req.user!.id })
      .returning({ id: suppliers.id })
      .catch(nameTakenAsConflict);
    res.status(201).json({ supplier: (await load(created[0]!.id))[0] });
  });

  router.patch("/suppliers/:id", admin, async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Supplier");
    const input = parse(changes, req.body);
    if (Object.keys(input).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
    const updated = await db.update(suppliers).set(input).where(eq(suppliers.id, id)).returning({ id: suppliers.id }).catch(nameTakenAsConflict);
    if (!updated[0]) throw notFound("Supplier");
    res.json({ supplier: (await load(id))[0] });
  });

  deleteRoute(router, db, "/suppliers", suppliers, "Supplier", [{ what: "order", table: orders, of: (id) => eq(orders.supplierId, id) }]);

  return router;
}
