import { count, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import type { Database } from "../../db/client";
import { conflict, notFound } from "../../http/errors";

// Shared by the seven Settings routers: DELETE /<path>/:id (docs/wave3-contracts.md section 4.1). Only a record that
// nothing uses (added by mistake) is deleted; one in use is deactivated instead, so history is never touched.

/** Records that can point at a Settings row: their name (singular; the plural adds "s") and which are this row's. */
export type Use = { what: string; table: PgTable; of: (id: string) => SQL | undefined };

const joined = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!);

/** DELETE `path/:id`, Management only (B6): 204 when deleted; 404 for an unknown id; 409 `in_use` naming its uses. */
export function deleteRoute(router: Router, db: Database, path: string, table: PgTable & { id: PgColumn }, noun: string, uses: Use[]) {
  const inUse = (what: string) => conflict("in_use", `This ${noun.toLowerCase()} is used by ${what}, so it can't be deleted. Deactivate it instead.`);

  router.delete(`${path}/:id`, requirePermission("admin", "Full"), async (req, res) => {
    const id = String(req.params.id);
    if (!z.uuid().safeParse(id).success) throw notFound(noun);
    await db
      .transaction(async (tx) => {
        // Locked, so nothing can start using the row between the counts and the delete (a new reference key-share locks it).
        if (!(await tx.select({ id: table.id }).from(table).where(eq(table.id, id)).for("update"))[0]) throw notFound(noun);
        const used: string[] = [];
        for (const use of uses) {
          const n = (await tx.select({ n: count() }).from(use.table).where(use.of(id)))[0]!.n;
          if (n > 0) used.push(`${n} ${use.what}${n === 1 ? "" : "s"}`);
        }
        if (used.length > 0) throw inUse(joined(used));
        await tx.delete(table).where(eq(table.id, id));
      })
      .catch((error: unknown) => {
        // Every foreign key to a Settings table is ON DELETE NO ACTION: a use the counts missed refuses the delete.
        type PgError = { code?: string; cause?: PgError };
        if (((error as PgError)?.cause ?? (error as PgError))?.code === "23503") throw inUse("other records");
        throw error;
      });
    res.status(204).end();
  });
}
