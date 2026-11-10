import { eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { CURRENCIES, orders, STATUSES, supplierDeposits, suppliers } from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { orderClosed } from "../orders/closure";
import { todayInIndia } from "../reports/reports";
import { deleteRoute } from "./delete-route";
import { creationOrder, listRoute } from "./list-query";
import { insightsQuery, nextCode, supplierInsights, supplierMoneyRows, suppliersSummary } from "./supplier-insights";

// Owner: A1 (docs/wave3-contracts.md section 4). MD-1 GET /suppliers, MD-2 POST /suppliers (docs/contracts.md),
// PATCH /suppliers/:id, DELETE /suppliers/:id (section 4.1), and the Suppliers page's SUP-1 GET /suppliers/summary
// and SUP-2 GET /suppliers/insights (docs/suppliers.md). Management only (B6).

const NAME_EMPTY = "Enter the supplier name."; // M21
const NAME_TAKEN = "A supplier with this name already exists."; // M22
const CODE_SHAPE = "Use up to 20 letters, digits or dashes.";
const CODE_TAKEN = "A supplier with this code already exists.";
const EMAIL = "Enter a valid email address."; // M14
const PHONE = "Enter a valid phone number.";
const CURRENCY = "Choose CNY, USD or INR.";
const tooLong = (max: number) => `Use ${max} characters or fewer.`;

const isUuid = (value: string) => z.uuid().safeParse(value).success;
// Optional text: left out on create, the column default ("") applies.
const text = (max = 200) => z.string().trim().max(max, tooLong(max)).optional();
const fields = {
  name: z.string({ error: NAME_EMPTY }).trim().min(1, NAME_EMPTY).max(200, tooLong(200)),
  /** Stored upper-case; left out on create, the next SUP-nnn is assigned (docs/suppliers.md). */
  code: z
    .string({ error: CODE_SHAPE })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, CODE_SHAPE),
  country: text(100),
  city: text(),
  state: text(),
  postalCode: text(50),
  contactPerson: text(),
  /** Free text with at least five digits ("+86 138 0013 2244", "WeChat 13800132244"), or "". */
  phone: z
    .string()
    .trim()
    .max(200, tooLong(200))
    .refine((value) => value === "" || (value.match(/\d/g)?.length ?? 0) >= 5, PHONE)
    .optional(),
  email: z
    .string()
    .trim()
    .max(200, tooLong(200))
    .refine((value) => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), EMAIL)
    .optional(),
  address: text(1000),
  paymentTerms: text(),
  taxNumber: text(),
  notes: text(1000),
  // The default for the supplier's new orders; changing it leaves existing orders in their own currency.
  currency: z.enum(CURRENCIES, { error: CURRENCY }).optional(),
};
const newSupplier = z.strictObject({ ...fields, code: fields.code.optional() });
const changes = z.strictObject({ ...fields, status: z.enum(STATUSES) }).partial();

/** The unique indexes on lower(name) and upper(code) decide duplicates, so two simultaneous saves can't both succeed. */
function takenAsConflict(error: unknown): never {
  type PgError = { code?: string; constraint?: string; cause?: PgError };
  const pg = (error as PgError)?.cause ?? (error as PgError);
  if (pg?.code === "23505" && pg.constraint === "suppliers_name_unique") throw conflict("name_exists", NAME_TAKEN, { name: NAME_TAKEN });
  if (pg?.code === "23505" && pg.constraint === "suppliers_code_unique") throw conflict("code_exists", CODE_TAKEN, { code: CODE_TAKEN });
  throw error;
}

/** Any bad query (unknown key, malformed date or id, `from` after `to`) is malformed: 400, as the reports answer. */
function readInsightsQuery(query: unknown) {
  const result = insightsQuery.safeParse(query);
  if (!result.success) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
  return result.data;
}

export function suppliersRoutes({ db }: RouteContext) {
  const router = Router();
  const admin = requirePermission("admin", "Full");

  /**
   * MD-1 rows (one when `id` is given). Open orders: the supplier's orders not yet received in the warehouse
   * (stage < 6). `ytdValue` and `balance`: this year's order value and what is still owed, per order currency.
   */
  const load = async (id?: string) => {
    const [rows, money] = await Promise.all([
      db
        .select({
          id: suppliers.id,
          code: suppliers.code,
          name: suppliers.name,
          contactPerson: suppliers.contactPerson,
          phone: suppliers.phone,
          email: suppliers.email,
          country: suppliers.country,
          city: suppliers.city,
          state: suppliers.state,
          postalCode: suppliers.postalCode,
          address: suppliers.address,
          paymentTerms: suppliers.paymentTerms,
          taxNumber: suppliers.taxNumber,
          notes: suppliers.notes,
          currency: suppliers.currency,
          openOrders: sql<number>`count(${orders.id}) filter (where ${orders.stage} < 6)`.mapWith(Number),
          /** Orders not closed (phase 2 §1): the Suppliers page's "Active POs", the same rule as its Open POs card. */
          openPos: sql<number>`count(${orders.id}) filter (where not ${orderClosed})`.mapWith(Number),
          status: suppliers.status,
        })
        .from(suppliers)
        .leftJoin(orders, eq(orders.supplierId, suppliers.id))
        .where(id ? eq(suppliers.id, id) : undefined)
        .groupBy(suppliers.id)
        .orderBy(...creationOrder(suppliers)),
      supplierMoneyRows(db, todayInIndia()),
    ]);
    return rows.map((row) => ({ ...row, ...(money.get(row.id) ?? { ytdValue: [], balance: [] }) }));
  };

  // Before the :id routes, so "summary" and "insights" are never read as a supplier id.
  router.get("/suppliers/summary", admin, async (_req, res) => {
    res.json(await suppliersSummary(db, todayInIndia()));
  });
  router.get("/suppliers/insights", admin, async (req, res) => {
    res.json(await supplierInsights(db, readInsightsQuery(req.query), todayInIndia()));
  });

  listRoute(router, "/suppliers", () => load(), (row) => [row.name, row.code, row.country, row.contactPerson, row.phone]);

  router.post("/suppliers", admin, async (req, res) => {
    const input = parse(newSupplier, req.body);
    const created = await db
      .transaction(async (tx) => {
        const code = input.code ?? (await nextCode(tx));
        return tx.insert(suppliers).values({ ...input, code, createdBy: req.user!.id }).returning({ id: suppliers.id });
      })
      .catch(takenAsConflict);
    res.status(201).json({ supplier: (await load(created[0]!.id))[0] });
  });

  router.patch("/suppliers/:id", admin, async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Supplier");
    const input = parse(changes, req.body);
    if (Object.keys(input).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
    const updated = await db.update(suppliers).set(input).where(eq(suppliers.id, id)).returning({ id: suppliers.id }).catch(takenAsConflict);
    if (!updated[0]) throw notFound("Supplier");
    res.json({ supplier: (await load(id))[0] });
  });

  // A supplier with orders or supplier deposits (docs/phase2-contracts.md 3.2) is deactivated instead of deleted.
  deleteRoute(router, db, "/suppliers", suppliers, "Supplier", [
    { what: "order", table: orders, of: (id) => eq(orders.supplierId, id) },
    { what: "deposit", table: supplierDeposits, of: (id) => eq(supplierDeposits.supplierId, id) },
  ]);

  return router;
}
