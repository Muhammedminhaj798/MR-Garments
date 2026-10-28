import { and, asc, desc, eq, exists, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { clearingAgents, clearings, containers } from "../../db/schema";
import { conflict, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { round2 } from "../orders/orders.routes";
import { moveOrdersToStage } from "../stages-shared";
import {
  addDays,
  closed,
  complete,
  containerOrders,
  daysBetween,
  goodsIn,
  goodsView,
  inr,
  isUuid,
  lockContainer,
  optionalDate,
  STAGE_MESSAGES,
  text,
  todayInIndia,
} from "./common";

// Owner: A5. CLR-1 GET /clearings, CLR-2 GET /clearings/:containerId, CLR-3 PUT /clearings/:containerId
// (docs/wave3-contracts.md sections 2, 3 and 5; shapes in section 8).

export const CLEARING_MESSAGES = {
  agent: "Choose a clearing agent from the list.",
  arrivedOn: "Enter the date it arrived at the port.",
  arrivedFuture: "The arrival date can't be after today.",
  arrivedBeforeLoading: "The arrival date can't be before the loading date.",
  beforeArrival: "This date can't be before the arrival at port.",
  clearedBeforeDuty: "The cleared date can't be before the duty was paid.",
  billOfEntry: "Enter the bill of entry number.",
  dutyPaidOn: "Enter the date the duty was paid.",
  clearedOn: "Enter the date it was cleared.",
};
const M = CLEARING_MESSAGES;

const clearingBody = z.strictObject({
  clearingAgentId: z.uuid({ error: M.agent }),
  arrivedOn: z.iso.date({ error: M.arrivedOn }),
  handedOn: optionalDate(),
  billOfEntry: text(),
  dutyPaidOn: optionalDate(),
  clearedOn: optionalDate(),
  goodsValueInr: inr().nullable().default(null),
  customsDutyInr: inr().default(0),
  otherDutiesInr: inr().default(0),
  agentChargesInr: inr().default(0),
  portChargesInr: inr().default(0),
  complete,
});
type ClearingBody = z.infer<typeof clearingBody>;

const costOf = sql<number>`${clearings.customsDutyInr} + ${clearings.otherDutiesInr} + ${clearings.agentChargesInr} + ${clearings.portChargesInr}`.mapWith(Number);

/** The date rules (section 5), plus what "Mark cleared" needs. */
function dateProblems(input: ClearingBody, loadedOn: string | null) {
  const today = todayInIndia();
  const problems: Record<string, string> = {};
  if (input.arrivedOn > today) problems.arrivedOn = M.arrivedFuture;
  else if (loadedOn && input.arrivedOn < loadedOn) problems.arrivedOn = M.arrivedBeforeLoading;
  for (const key of ["handedOn", "dutyPaidOn", "clearedOn"] as const) {
    const day = input[key];
    if (day && day > today) problems[key] = STAGE_MESSAGES.future;
    else if (day && day < input.arrivedOn) problems[key] = M.beforeArrival;
  }
  if (!problems.clearedOn && input.clearedOn && input.dutyPaidOn && input.clearedOn < input.dutyPaidOn) problems.clearedOn = M.clearedBeforeDuty;
  if (input.complete) {
    if (!input.billOfEntry) problems.billOfEntry = M.billOfEntry;
    if (!input.dutyPaidOn) problems.dutyPaidOn = M.dutyPaidOn;
    if (!input.clearedOn) problems.clearedOn = M.clearedOn;
  }
  return problems;
}

export function clearingRoutes({ db }: RouteContext) {
  const router = Router();

  // CLR-1. One row per arrived container (a clearing needs one), newest arrival first; KPIs over today in India.
  router.get("/clearings", requirePermission("clearing", "View"), async (_req, res) => {
    const rows = await db
      .select({
        containerId: containers.id,
        number: containers.number,
        terms: containers.terms,
        eta: containers.eta,
        agentId: clearingAgents.id,
        agentName: clearingAgents.name,
        arrivedOn: clearings.arrivedOn,
        handedOn: clearings.handedOn,
        billOfEntry: clearings.billOfEntry,
        dutyPaidOn: clearings.dutyPaidOn,
        clearedOn: clearings.clearedOn,
        status: clearings.status,
        clearingCostInr: costOf,
      })
      .from(containers)
      .leftJoin(clearings, eq(clearings.containerId, containers.id))
      .leftJoin(clearingAgents, eq(clearingAgents.id, clearings.clearingAgentId))
      .where(eq(containers.status, "arrived"))
      .orderBy(desc(sql`coalesce(${clearings.arrivedOn}, ${containers.eta})`), desc(containers.createdAt));
    const byContainer = await containerOrders(
      db,
      rows.map((row) => row.containerId),
    );
    const list = rows.map(({ agentId, agentName, status, clearingCostInr, ...row }) => ({
      ...row,
      agent: agentId ? { id: agentId, name: agentName! } : null,
      billOfEntry: row.billOfEntry ?? "",
      orders: byContainer.get(row.containerId)?.orders ?? [],
      status: status ?? "waiting",
      clearingCostInr: status ? clearingCostInr : 0,
    }));

    const since = addDays(todayInIndia(), -29);
    const cleared = list.filter((row) => row.status === "cleared" && row.clearedOn! >= since);
    const days = cleared.reduce((sum, row) => sum + daysBetween(row.arrivedOn!, row.clearedOn!), 0);
    const agents = await db
      .select({ id: clearingAgents.id, name: clearingAgents.name })
      .from(clearingAgents)
      .where(
        or(
          eq(clearingAgents.status, "Active"),
          exists(db.select({ id: clearings.id }).from(clearings).where(eq(clearings.clearingAgentId, clearingAgents.id))),
        ),
      )
      .orderBy(asc(clearingAgents.createdAt), asc(clearingAgents.name));
    res.json({
      kpis: {
        inClearingNow: list.filter((row) => row.status !== "cleared").length,
        clearedLast30Days: cleared.length,
        averageDaysToClear: cleared.length ? Math.round((days / cleared.length) * 10) / 10 : null,
        clearingCostLast30DaysInr: round2(cleared.reduce((sum, row) => sum + row.clearingCostInr, 0)),
      },
      rows: list,
      agents,
    });
  });

  // CLR-2. Any container (the form says when it hasn't arrived); agents are the active ones plus the saved one.
  router.get("/clearings/:containerId", requirePermission("clearing", "View"), async (req, res) => {
    const id = String(req.params.containerId);
    if (!isUuid(id)) throw notFound("Container");
    const container = (
      await db
        .select({
          id: containers.id,
          number: containers.number,
          status: containers.status,
          terms: containers.terms,
          loadedOn: containers.loadedOn,
          eta: containers.eta,
        })
        .from(containers)
        .where(eq(containers.id, id))
    )[0];
    if (!container) throw notFound("Container");
    const clearing =
      (
        await db
          .select({
            id: clearings.id,
            clearingAgentId: clearings.clearingAgentId,
            arrivedOn: clearings.arrivedOn,
            handedOn: clearings.handedOn,
            billOfEntry: clearings.billOfEntry,
            dutyPaidOn: clearings.dutyPaidOn,
            clearedOn: clearings.clearedOn,
            goodsValueInr: clearings.goodsValueInr,
            customsDutyInr: clearings.customsDutyInr,
            otherDutiesInr: clearings.otherDutiesInr,
            agentChargesInr: clearings.agentChargesInr,
            portChargesInr: clearings.portChargesInr,
            status: clearings.status,
          })
          .from(clearings)
          .where(eq(clearings.containerId, id))
      )[0] ?? null;
    const [goods, agents] = await Promise.all([
      goodsIn(db, id),
      db
        .select({ id: clearingAgents.id, name: clearingAgents.name, contactPerson: clearingAgents.contactPerson, phone: clearingAgents.phone })
        .from(clearingAgents)
        .where(or(eq(clearingAgents.status, "Active"), clearing ? eq(clearingAgents.id, clearing.clearingAgentId) : undefined))
        .orderBy(asc(clearingAgents.createdAt), asc(clearingAgents.name)),
    ]);
    res.json({ container, clearing, ...goodsView(goods), agents });
  });

  // CLR-3. One transaction: the container row, then the clearing row, locked. The first save moves the orders to 4.
  router.put("/clearings/:containerId", requirePermission("clearing", "Enter"), async (req, res) => {
    const id = String(req.params.containerId);
    if (!isUuid(id)) throw notFound("Container");
    const input = parse(clearingBody, req.body);
    const clearing = await db.transaction(async (tx) => {
      const container = await lockContainer(tx, id);
      if (container.status !== "arrived") throw conflict("container_not_arrived", STAGE_MESSAGES.notArrived);
      const saved = (await tx.select({ id: clearings.id, status: clearings.status }).from(clearings).where(eq(clearings.containerId, id)).for("update"))[0];
      if (saved?.status === "cleared") throw closed();

      const problems = dateProblems(input, container.loadedOn);
      const agent = await tx
        .select({ id: clearingAgents.id })
        .from(clearingAgents)
        .where(and(eq(clearingAgents.id, input.clearingAgentId), eq(clearingAgents.status, "Active")));
      if (agent.length === 0) problems.clearingAgentId = M.agent;
      if (Object.keys(problems).length > 0) throw validationFailed(problems);

      const { complete: done, ...values } = input;
      const row = { ...values, status: done ? "cleared" : "in_clearing", updatedBy: req.user!.id };
      const written = saved
        ? await tx.update(clearings).set(row).where(eq(clearings.id, saved.id)).returning({ id: clearings.id, status: clearings.status })
        : await tx
            .insert(clearings)
            .values({ ...row, containerId: id, createdBy: req.user!.id })
            .returning({ id: clearings.id, status: clearings.status });
      // Every save, not only the first: the move is forward-only, so later saves change nothing.
      await moveOrdersToStage(tx, id, 4);
      return written[0]!;
    });
    res.json({ clearing });
  });

  return router;
}
