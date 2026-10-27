import { asc, eq } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { clearingAgents, items, locations, shippingAgents, STATUSES, teams, transportCompanies, users } from "../../db/schema";
import { GENERIC_MESSAGE, HttpError } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";

// Owner: A3 (read-only master data, GET only, B6). Endpoints: MD-4 /shipping-agents, MD-7 /clearing-agents,
// MD-10 /transport-companies, MD-13 /locations, MD-16 /teams, MD-19 /items. POST and PATCH fall through to 404.

const listQuery = z.strictObject({ search: z.string().optional(), status: z.enum(STATUSES).optional() });

/** Any bad query (unknown key, another status, a repeated key) is malformed: 400, never field errors. */
function readQuery(query: unknown) {
  try {
    return parse(listQuery, query);
  } catch (error) {
    throw error instanceof HttpError && error.status === 422 ? new HttpError(400, "bad_request", GENERIC_MESSAGE) : error;
  }
}

// The frontend's filterRecords rule: "contains", ignoring case and spaces.
const squash = (text: string) => text.toLowerCase().replace(/\s+/g, "");

/** Creation order, then name (docs/contracts.md, "Lists"). */
const creationOrder = (table: { createdAt: PgColumn; name: PgColumn }) => [asc(table.createdAt), asc(table.name)];

const contactSearch = (row: { name: string; contactPerson: string; phone: string }) => [row.name, row.contactPerson, row.phone];

export function readonlyMasterDataRoutes({ db }: RouteContext) {
  const router = Router();

  // ponytail: search and status filter in memory, as the master tables hold a handful of rows; move to SQL if they grow.
  function list<T extends { status: string }>(path: string, load: () => Promise<T[]>, searchText: (row: T) => string[]) {
    router.get(path, requirePermission("admin", "Full"), async (req, res) => {
      const { search = "", status } = readQuery(req.query);
      const needle = squash(search);
      const rows = await load();
      res.json(rows.filter((row) => (!status || row.status === status) && searchText(row).some((text) => squash(text).includes(needle))));
    });
  }

  // Counts that come from later batches' tables are fixed at 0 (B6).
  list(
    "/shipping-agents",
    async () => {
      const rows = await db
        .select({
          id: shippingAgents.id,
          name: shippingAgents.name,
          contactPerson: shippingAgents.contactPerson,
          phone: shippingAgents.phone,
          officeCity: shippingAgents.officeCity,
          status: shippingAgents.status,
        })
        .from(shippingAgents)
        .orderBy(...creationOrder(shippingAgents));
      return rows.map(({ status, ...row }) => ({ ...row, activeContainers: 0, status }));
    },
    contactSearch,
  );

  list(
    "/clearing-agents",
    async () => {
      const rows = await db
        .select({
          id: clearingAgents.id,
          name: clearingAgents.name,
          contactPerson: clearingAgents.contactPerson,
          phone: clearingAgents.phone,
          port: clearingAgents.port,
          status: clearingAgents.status,
        })
        .from(clearingAgents)
        .orderBy(...creationOrder(clearingAgents));
      return rows.map(({ status, ...row }) => ({ ...row, containersCleared: 0, status }));
    },
    contactSearch,
  );

  list(
    "/transport-companies",
    async () => {
      const rows = await db
        .select({
          id: transportCompanies.id,
          name: transportCompanies.name,
          contactPerson: transportCompanies.contactPerson,
          phone: transportCompanies.phone,
          status: transportCompanies.status,
        })
        .from(transportCompanies)
        .orderBy(...creationOrder(transportCompanies));
      return rows.map(({ status, ...row }) => ({ ...row, tripsSoFar: 0, status }));
    },
    contactSearch,
  );

  // Staff: the names of the active users at each location, in user list order (B6.3).
  list(
    "/locations",
    async () => {
      const staff = await db
        .select({ name: users.name, locationId: users.locationId })
        .from(users)
        .where(eq(users.status, "Active"))
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
        .orderBy(...creationOrder(locations));
      return rows.map(({ status, ...row }) => ({
        ...row,
        staff: staff.filter((user) => user.locationId === row.id).map((user) => user.name),
        status,
      }));
    },
    (row) => [row.name, row.address, ...row.staff],
  );

  // Stock values come from later batches: 0, 0 and null (shown as "–", B6.2 and 5.6).
  list(
    "/teams",
    async () => {
      const rows = await db.select({ id: teams.id, name: teams.name, status: teams.status }).from(teams).orderBy(...creationOrder(teams));
      return rows.map(({ status, ...row }) => ({ ...row, piecesInStock: 0, landedCostOfStockInr: 0, averagePerPieceInr: null, status }));
    },
    (row) => [row.name],
  );

  // A database check keeps exactly one of perBundle and bundleLabel set. No orders exist yet, so usedInOrders is [].
  list(
    "/items",
    async () => {
      const rows = await db
        .select({
          id: items.id,
          name: items.name,
          countedIn: items.countedIn,
          perBundle: items.perBundle,
          bundleLabel: items.bundleLabel,
          status: items.status,
        })
        .from(items)
        .orderBy(...creationOrder(items));
      return rows.map(({ status, ...row }) => ({ ...row, usedInOrders: [] as string[], status }));
    },
    (row) => [row.name, ...row.usedInOrders],
  );

  return router;
}
