import { asc } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { STATUSES } from "../../db/schema";
import { GENERIC_MESSAGE, HttpError } from "../../http/errors";
import { parse } from "../../http/validate";

// Shared by the Settings list routers (MD-4 .. MD-19, docs/contracts.md "Read-only master data"). Coordinator-owned.

const listQuery = z.strictObject({ search: z.string().optional(), status: z.enum(STATUSES).optional() });

/** Any bad query (unknown key, another status, a repeated key) is malformed: 400, never field errors. */
export function readQuery(query: unknown) {
  try {
    return parse(listQuery, query);
  } catch (error) {
    throw error instanceof HttpError && error.status === 422 ? new HttpError(400, "bad_request", GENERIC_MESSAGE) : error;
  }
}

// The frontend's filterRecords rule: "contains", ignoring case and spaces.
export const squash = (text: string) => text.toLowerCase().replace(/\s+/g, "");

/** Creation order, then name (docs/contracts.md, "Lists"). */
export const creationOrder = (table: { createdAt: PgColumn; name: PgColumn }) => [asc(table.createdAt), asc(table.name)];

export const contactSearch = (row: { name: string; contactPerson: string; phone: string }) => [row.name, row.contactPerson, row.phone];

// ponytail: search and status filter in memory, as the master tables hold a handful of rows; move to SQL if they grow.
/** GET `path` (Management only, B6): the loaded rows, kept by the `status` and `search` query. */
export function listRoute<T extends { status: string }>(router: Router, path: string, load: () => Promise<T[]>, searchText: (row: T) => string[]) {
  router.get(path, requirePermission("admin", "Full"), async (req, res) => {
    const { search = "", status } = readQuery(req.query);
    const needle = squash(search);
    const rows = await load();
    res.json(rows.filter((row) => (!status || row.status === status) && searchText(row).some((text) => squash(text).includes(needle))));
  });
}
