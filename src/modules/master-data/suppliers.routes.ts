import { asc, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { STATUSES, suppliers } from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";

// Owner: A4 (suppliers). Endpoints: MD-1 GET /suppliers, MD-2 POST /suppliers (docs/contracts.md). Management only (B6).

const NAME_EMPTY = "Enter the supplier name."; // M21
const NAME_TAKEN = "A supplier with this name already exists."; // M22

const listQuery = z.strictObject({ search: z.string().optional(), status: z.enum(STATUSES).optional() });

const optionalText = z.string().trim().default("");
const newSupplier = z.strictObject({
  name: z.string({ error: NAME_EMPTY }).trim().min(1, NAME_EMPTY),
  city: optionalText,
  contactPerson: optionalText,
  phone: optionalText,
  currency: z.literal("CNY").default("CNY"),
  address: optionalText,
  notes: optionalText,
});

const columns = {
  id: suppliers.id,
  name: suppliers.name,
  contactPerson: suppliers.contactPerson,
  phone: suppliers.phone,
  city: suppliers.city,
  address: suppliers.address,
  notes: suppliers.notes,
  currency: suppliers.currency,
  status: suppliers.status,
};

// Open orders come from a later batch's orders table; 0 until then (contracts, MD-1).
const toRow = (row: { [K in keyof typeof columns]: string }) => ({ ...row, openOrders: 0 });

// The frontend's filterRecords rule: case- and space-insensitive "contains" on the searchable columns.
const squash = (text: string) => text.toLowerCase().replace(/\s+/g, "");

export function suppliersRoutes({ db }: RouteContext) {
  const router = Router();
  const admin = requirePermission("admin", "Full");

  router.get("/suppliers", admin, async (req, res) => {
    const query = listQuery.safeParse(req.query);
    // Unknown keys, repeated keys and other status values are a caller bug, not a field problem (contracts: 400).
    if (!query.success) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
    const { search = "", status } = query.data;
    const rows = await db
      .select(columns)
      .from(suppliers)
      .where(status ? eq(suppliers.status, status) : undefined)
      .orderBy(asc(suppliers.createdAt), asc(suppliers.name));
    // ponytail: filtered in memory (a handful of master rows); move into SQL if the list grows large.
    const needle = squash(search);
    res.json(rows.filter((row) => [row.name, row.contactPerson, row.phone].some((text) => squash(text).includes(needle))).map(toRow));
  });

  router.post("/suppliers", admin, async (req, res) => {
    const input = parse(newSupplier, req.body);
    // The unique index on lower(name) decides duplicates, so two simultaneous adds can't both succeed.
    const created = await db
      .insert(suppliers)
      .values({ ...input, createdBy: req.user!.id })
      .onConflictDoNothing()
      .returning(columns);
    if (!created[0]) throw conflict("name_exists", NAME_TAKEN, { name: NAME_TAKEN });
    res.status(201).json({ supplier: toRow(created[0]) });
  });

  return router;
}
