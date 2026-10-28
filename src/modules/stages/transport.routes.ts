import { and, asc, desc, eq, exists, isNull, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { clearingAgents, clearings, containers, locations, transportCompanies, transports } from "../../db/schema";
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
  count,
  goodsIn,
  goodsView,
  inr,
  isUuid,
  lockContainer,
  optionalDate,
  required,
  STAGE_MESSAGES,
  text,
  todayInIndia,
} from "./common";

// Owner: A5. TRN-1 GET /transports, TRN-2 GET /transports/:containerId, TRN-3 PUT /transports/:containerId
// (docs/wave3-contracts.md sections 2, 3 and 5; shapes in section 8). One road trip per container (default).

export const TRANSPORT_MESSAGES = {
  company: "Choose a transport company from the list.",
  destination: "Choose a warehouse from the list.",
  lrNumber: "Enter the LR number.",
  vehicleNumber: "Enter the vehicle number.",
  driverPhone: "Enter the driver's phone number.",
  bundlesLoaded: "Enter the bundles loaded (1 or more).",
  loadedOn: "Enter the loading date.",
  loadedFuture: "The loading date can't be after today.",
  loadedBeforeCleared: "The loading date can't be before the container was cleared.",
  unloadedOn: "Enter the unloading date.",
  unloadedBeforeLoaded: "The unloading date can't be before the loading date.",
  bundlesReceived: "Enter the bundles received (0 or more).",
  moreThanLoaded: "Bundles received can't be more than the bundles loaded.",
  receivedBy: "Enter who received the goods.",
  shortRemark: "Add a remark about the short bundles.",
};
const M = TRANSPORT_MESSAGES;

const tripBody = z.strictObject({
  transportCompanyId: z.uuid({ error: M.company }),
  destinationId: z.uuid({ error: M.destination }),
  lrNumber: required(M.lrNumber),
  vehicleNumber: required(M.vehicleNumber),
  driverName: text(),
  driverPhone: required(M.driverPhone),
  bundlesLoaded: count(M.bundlesLoaded, 1),
  loadedOn: z.iso.date({ error: M.loadedOn }),
  loadedFrom: text(),
  loadedBy: text(),
  unloadedOn: optionalDate(),
  bundlesReceived: count(M.bundlesReceived).nullable().default(null),
  receivedBy: text(),
  shortRemark: text(1000),
  freightInr: inr().default(0),
  handlingInr: inr().default(0),
  complete,
});
type TripBody = z.infer<typeof tripBody>;

const costOf = sql<number>`${transports.freightInr} + ${transports.handlingInr}`.mapWith(Number);

/** Section 5: loading after clearing, unloading after loading, never after today; what "mark unloaded" needs. */
function tripProblems(input: TripBody, clearedOn: string) {
  const today = todayInIndia();
  const problems: Record<string, string> = {};
  if (input.loadedOn > today) problems.loadedOn = M.loadedFuture;
  else if (input.loadedOn < clearedOn) problems.loadedOn = M.loadedBeforeCleared;
  if (input.unloadedOn && input.unloadedOn > today) problems.unloadedOn = STAGE_MESSAGES.future;
  else if (input.unloadedOn && input.unloadedOn < input.loadedOn) problems.unloadedOn = M.unloadedBeforeLoaded;
  if (input.bundlesReceived !== null && input.bundlesReceived > input.bundlesLoaded) problems.bundlesReceived = M.moreThanLoaded;
  if (input.complete) {
    if (!input.unloadedOn) problems.unloadedOn = M.unloadedOn;
    if (input.bundlesReceived === null) problems.bundlesReceived = M.bundlesReceived;
    if (!input.receivedBy) problems.receivedBy = M.receivedBy;
    // Screen 27: fewer bundles received than loaded needs a short remark.
    const short = input.bundlesReceived !== null && input.bundlesReceived < input.bundlesLoaded;
    if (short && !input.shortRemark) problems.shortRemark = M.shortRemark;
  }
  return problems;
}

export function transportRoutes({ db }: RouteContext) {
  const router = Router();

  // TRN-1. Trips, newest loading first; containers cleared without a trip, oldest clearing first; KPIs over the last
  // 30 days of unloading, today in India.
  router.get("/transports", requirePermission("transport", "View"), async (_req, res) => {
    const [trips, ready, companies] = await Promise.all([
      db
        .select({
          id: transports.id,
          containerId: containers.id,
          container: containers.number,
          vehicleNumber: transports.vehicleNumber,
          lrNumber: transports.lrNumber,
          companyId: transportCompanies.id,
          companyName: transportCompanies.name,
          bundlesLoaded: transports.bundlesLoaded,
          loadedOn: transports.loadedOn,
          unloadedOn: transports.unloadedOn,
          bundlesReceived: transports.bundlesReceived,
          status: transports.status,
          costInr: costOf,
        })
        .from(transports)
        .innerJoin(containers, eq(containers.id, transports.containerId))
        .innerJoin(transportCompanies, eq(transportCompanies.id, transports.transportCompanyId))
        .orderBy(desc(transports.loadedOn), desc(transports.createdAt)),
      db
        .select({ containerId: containers.id, container: containers.number, clearedOn: clearings.clearedOn, clearingAgent: clearingAgents.name })
        .from(clearings)
        .innerJoin(containers, eq(containers.id, clearings.containerId))
        .innerJoin(clearingAgents, eq(clearingAgents.id, clearings.clearingAgentId))
        .leftJoin(transports, eq(transports.containerId, clearings.containerId))
        .where(and(eq(clearings.status, "cleared"), isNull(transports.id)))
        .orderBy(asc(clearings.clearedOn), asc(containers.createdAt)),
      db
        .select({ id: transportCompanies.id, name: transportCompanies.name })
        .from(transportCompanies)
        .where(
          or(
            eq(transportCompanies.status, "Active"),
            exists(db.select({ id: transports.id }).from(transports).where(eq(transports.transportCompanyId, transportCompanies.id))),
          ),
        )
        .orderBy(asc(transportCompanies.createdAt), asc(transportCompanies.name)),
    ]);
    const byContainer = await containerOrders(db, [...trips, ...ready].map((row) => row.containerId));
    const since = addDays(todayInIndia(), -29);
    const delivered = trips.filter((trip) => trip.status === "unloaded" && trip.unloadedOn! >= since);
    res.json({
      kpis: {
        onTheWay: trips.filter((trip) => trip.status === "on_road").length,
        deliveredLast30Days: delivered.length,
        bundlesDeliveredLast30Days: delivered.reduce((sum, trip) => sum + trip.bundlesReceived!, 0),
        shortLast30Days: delivered.filter((trip) => trip.bundlesReceived! < trip.bundlesLoaded).length,
        transportCostLast30DaysInr: round2(delivered.reduce((sum, trip) => sum + trip.costInr, 0)),
      },
      rows: trips.map(({ companyId, companyName, ...trip }) => ({
        ...trip,
        company: { id: companyId, name: companyName },
        orders: byContainer.get(trip.containerId)?.orders ?? [],
      })),
      ready: ready.map((row) => ({ ...row, orders: byContainer.get(row.containerId)?.orders ?? [], bundles: byContainer.get(row.containerId)?.bundles ?? 0 })),
      companies,
    });
  });

  // TRN-2. Any container (the form says when it isn't cleared); options are the active ones plus the saved ones.
  router.get("/transports/:containerId", requirePermission("transport", "View"), async (req, res) => {
    const id = String(req.params.containerId);
    if (!isUuid(id)) throw notFound("Container");
    const container = (
      await db.select({ id: containers.id, number: containers.number, status: containers.status, terms: containers.terms }).from(containers).where(eq(containers.id, id))
    )[0];
    if (!container) throw notFound("Container");
    const [clearing, trip] = await Promise.all([
      db
        .select({ status: clearings.status, clearedOn: clearings.clearedOn, agentId: clearingAgents.id, agentName: clearingAgents.name })
        .from(clearings)
        .innerJoin(clearingAgents, eq(clearingAgents.id, clearings.clearingAgentId))
        .where(eq(clearings.containerId, id)),
      db
        .select({
          id: transports.id,
          transportCompanyId: transports.transportCompanyId,
          destinationId: transports.destinationId,
          lrNumber: transports.lrNumber,
          vehicleNumber: transports.vehicleNumber,
          driverName: transports.driverName,
          driverPhone: transports.driverPhone,
          bundlesLoaded: transports.bundlesLoaded,
          loadedOn: transports.loadedOn,
          loadedFrom: transports.loadedFrom,
          loadedBy: transports.loadedBy,
          unloadedOn: transports.unloadedOn,
          bundlesReceived: transports.bundlesReceived,
          receivedBy: transports.receivedBy,
          shortRemark: transports.shortRemark,
          freightInr: transports.freightInr,
          handlingInr: transports.handlingInr,
          status: transports.status,
        })
        .from(transports)
        .where(eq(transports.containerId, id)),
    ]);
    const saved = trip[0] ?? null;
    const [goods, companies, warehouses] = await Promise.all([
      goodsIn(db, id),
      db
        .select({ id: transportCompanies.id, name: transportCompanies.name })
        .from(transportCompanies)
        .where(or(eq(transportCompanies.status, "Active"), saved ? eq(transportCompanies.id, saved.transportCompanyId) : undefined))
        .orderBy(asc(transportCompanies.createdAt), asc(transportCompanies.name)),
      db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(
          or(
            and(eq(locations.type, "Warehouse"), eq(locations.status, "Active")),
            saved ? eq(locations.id, saved.destinationId) : undefined,
          ),
        )
        .orderBy(asc(locations.createdAt), asc(locations.name)),
    ]);
    const cleared = clearing[0];
    res.json({
      container,
      clearing: cleared ? { status: cleared.status, clearedOn: cleared.clearedOn, agent: { id: cleared.agentId, name: cleared.agentName } } : null,
      trip: saved,
      ...goodsView(goods),
      companies,
      warehouses,
    });
  });

  // TRN-3. One transaction: the container, its clearing and its trip locked. The first save moves the orders to 5.
  router.put("/transports/:containerId", requirePermission("transport", "Enter"), async (req, res) => {
    const id = String(req.params.containerId);
    if (!isUuid(id)) throw notFound("Container");
    const input = parse(tripBody, req.body);
    const trip = await db.transaction(async (tx) => {
      await lockContainer(tx, id);
      const clearing = (await tx.select({ status: clearings.status, clearedOn: clearings.clearedOn }).from(clearings).where(eq(clearings.containerId, id)).for("update"))[0];
      if (clearing?.status !== "cleared") throw conflict("not_cleared", STAGE_MESSAGES.notCleared);
      const saved = (await tx.select({ id: transports.id, status: transports.status }).from(transports).where(eq(transports.containerId, id)).for("update"))[0];
      if (saved?.status === "unloaded") throw closed();

      const problems = tripProblems(input, clearing.clearedOn!);
      const company = await tx
        .select({ id: transportCompanies.id })
        .from(transportCompanies)
        .where(and(eq(transportCompanies.id, input.transportCompanyId), eq(transportCompanies.status, "Active")));
      const destination = await tx
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.id, input.destinationId), eq(locations.type, "Warehouse"), eq(locations.status, "Active")));
      if (company.length === 0) problems.transportCompanyId = M.company;
      if (destination.length === 0) problems.destinationId = M.destination;
      if (Object.keys(problems).length > 0) throw validationFailed(problems);

      const { complete: done, ...values } = input;
      const row = { ...values, status: done ? "unloaded" : "on_road", updatedBy: req.user!.id };
      const written = saved
        ? await tx.update(transports).set(row).where(eq(transports.id, saved.id)).returning({ id: transports.id, status: transports.status })
        : await tx
            .insert(transports)
            .values({ ...row, containerId: id, createdBy: req.user!.id })
            .returning({ id: transports.id, status: transports.status });
      // Every save, not only the first: the move is forward-only, so later saves change nothing.
      await moveOrdersToStage(tx, id, 5);
      return written[0]!;
    });
    res.json({ trip });
  });

  return router;
}
