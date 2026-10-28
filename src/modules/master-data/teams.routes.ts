import { and, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { orderLines, STATUSES, teams, warehouseReceiptLines, warehouseReceipts } from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound } from "../../http/errors";
import { parse } from "../../http/validate";
import { loadLandedCosts } from "../costs/landed-cost";
import { round2 } from "../orders/orders.routes";
import type { RouteContext } from "../context";
import { creationOrder, listRoute } from "./list-query";

// Owner: A3 (docs/wave3-contracts.md sections 4 and 6.3). MD-16 GET /teams, POST /teams, PATCH /teams/:id.

// Proposed wording (the contract gives the pattern).
const M = {
  name: "Enter the team name.",
  nameTaken: "A team with this name already exists.",
  nameLong: "Use 200 characters or fewer.",
  status: "Choose Active or Inactive.",
};

const name = z.string({ error: M.name }).trim().min(1, M.name).max(200, M.nameLong);
const newTeam = z.strictObject({ name });
const editTeam = z.strictObject({ name, status: z.enum(STATUSES, { error: M.status }) }).partial();

const isUuid = (value: string) => z.uuid().safeParse(value).success;
const nameTaken = () => conflict("name_exists", M.nameTaken, { name: M.nameTaken });

/** A rename onto another team's name hits the unique index on lower(name): the same 409 as an add. */
function renameConflict(error: unknown): never {
  type PgError = { code?: string; constraint?: string; cause?: PgError };
  const pg = (error as PgError)?.cause ?? (error as PgError);
  if (pg?.code === "23505" && pg.constraint === "teams_name_unique") throw nameTaken();
  throw error;
}

export function teamsRoutes({ db }: RouteContext) {
  const router = Router();
  const admin = requirePermission("admin", "Full");

  // Stock (6.3): the pieces given to each team on stocked receipts, at their order's landed cost per piece (an order
  // without one yet adds 0). Stock never goes down in this version.
  const load = async (id?: string) => {
    const stock = await db
      .select({
        teamId: warehouseReceiptLines.teamId,
        orderId: orderLines.orderId,
        pieces: sql<number>`sum(${warehouseReceiptLines.quantity})`.mapWith(Number),
      })
      .from(warehouseReceiptLines)
      .innerJoin(warehouseReceipts, and(eq(warehouseReceipts.id, warehouseReceiptLines.receiptId), eq(warehouseReceipts.status, "stocked")))
      .innerJoin(orderLines, eq(orderLines.id, warehouseReceiptLines.orderLineId))
      .where(id ? eq(warehouseReceiptLines.teamId, id) : undefined)
      .groupBy(warehouseReceiptLines.teamId, orderLines.orderId);
    const costs = await loadLandedCosts(db, [...new Set(stock.map((line) => line.orderId))]);
    const rows = await db
      .select({ id: teams.id, name: teams.name, status: teams.status })
      .from(teams)
      .where(id ? eq(teams.id, id) : undefined)
      .orderBy(...creationOrder(teams));
    return rows.map(({ status, ...row }) => {
      const held = stock.filter((line) => line.teamId === row.id);
      const piecesInStock = held.reduce((sum, line) => sum + line.pieces, 0);
      const cost = round2(held.reduce((sum, line) => sum + line.pieces * (costs.get(line.orderId)?.perPieceInr ?? 0), 0));
      return { ...row, piecesInStock, landedCostOfStockInr: cost, averagePerPieceInr: piecesInStock > 0 ? round2(cost / piecesInStock) : null, status };
    });
  };

  listRoute(router, "/teams", () => load(), (row) => [row.name]);

  router.post("/teams", admin, async (req, res) => {
    const input = parse(newTeam, req.body);
    // The unique index on lower(name) decides duplicates, so two simultaneous adds can't both succeed.
    const created = await db.insert(teams).values(input).onConflictDoNothing().returning({ id: teams.id });
    if (!created[0]) throw nameTaken();
    res.status(201).json({ team: (await load(created[0].id))[0] });
  });

  router.patch("/teams/:id", admin, async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Team");
    const input = parse(editTeam, req.body);
    if (Object.keys(input).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
    const updated = await db.update(teams).set(input).where(eq(teams.id, id)).returning({ id: teams.id }).catch(renameConflict);
    if (!updated[0]) throw notFound("Team");
    res.json({ team: (await load(id))[0] });
  });

  return router;
}
