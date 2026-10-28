import { eq } from "drizzle-orm";
import { expect } from "vitest";

import { clearingAgents, containerLines, containers, locations, orders, shippingAgents, teams, transportCompanies } from "../../db/schema";
import { api, type TestContext } from "../../test/harness";
import { idOf, indiaDay, makeOrder } from "../stock/fixtures";

// Test-only helpers for the stage tests: containers are written straight to the database (arrived by default), then
// cleared, moved and received through the API under test.

export const UNKNOWN = "00000000-0000-4000-8000-000000000000";

type Named = typeof clearingAgents | typeof transportCompanies | typeof teams | typeof locations;
export async function named(ctx: TestContext, table: Named, name: string) {
  const row = (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0];
  if (!row) throw new Error(`No seeded ${name}`);
  return row.id;
}

export const stageOf = async (ctx: TestContext, orderId: string) =>
  (await ctx.db.select({ stage: orders.stage }).from(orders).where(eq(orders.id, orderId)))[0]!.stage;

type Line = { item: string; quantity: number; rateCny: number };
let numbers = 0;

/**
 * Orders (stage 3 unless told) fully loaded, 2 bundles a line, into a new container. Defaults: CNF, arrived, loaded 20
 * days ago, one order of 100 Denim jeans at ¥10.
 */
export async function makeContainer(
  ctx: TestContext,
  {
    status = "arrived",
    terms = "CNF",
    loadedOn = indiaDay(-20),
    stage = 3,
    orders: lines = [[{ item: "Denim jeans", quantity: 100, rateCny: 10 }]],
  }: { status?: string; terms?: string; loadedOn?: string; stage?: number; orders?: Line[][] } = {},
) {
  const made = [];
  for (const orderLines of lines) made.push(await makeOrder(ctx, { stage, lines: orderLines }));
  const number = `TCLU${6000000 + numbers++}`;
  const container = (
    await ctx.db
      .insert(containers)
      .values({ number, shippingAgentId: await idOf(ctx, shippingAgents, "Sino Freight"), terms, loadedOn, sailedOn: loadedOn, eta: indiaDay(-12), status })
      .returning({ id: containers.id })
  )[0]!;
  await ctx.db.insert(containerLines).values(
    made.flatMap((order, i) => order.lineIds.map((orderLineId, j) => ({ containerId: container.id, orderLineId, bundles: 2, quantity: lines[i]![j]!.quantity }))),
  );
  return { id: container.id, number, orders: made };
}

/** Master data the stage forms choose from. */
export async function masters(ctx: TestContext) {
  return {
    kochi: await named(ctx, clearingAgents, "Kochi Clearing Services"),
    southern: await named(ctx, clearingAgents, "Southern Port Agents"),
    kerala: await named(ctx, transportCompanies, "Kerala Roadways"),
    malabar: await named(ctx, transportCompanies, "Malabar Carriers"),
    warehouse: await named(ctx, locations, "Main warehouse"),
    indiaOffice: await named(ctx, locations, "India office"),
    retail: await named(ctx, teams, "Retail team"),
    wholesale: await named(ctx, teams, "Wholesale team"),
    online: await named(ctx, teams, "Online team"),
  };
}

/** A full CLR-3 body: arrived 10 days ago, cleared 7 days ago, ₹37,050 of charges. */
export const clearingBody = (clearingAgentId: string, extra: object = {}) => ({
  clearingAgentId,
  arrivedOn: indiaDay(-10),
  handedOn: indiaDay(-9),
  billOfEntry: "BE-7710482",
  dutyPaidOn: indiaDay(-8),
  clearedOn: indiaDay(-7),
  goodsValueInr: 98000,
  customsDutyInr: 19600,
  otherDutiesInr: 14200,
  agentChargesInr: 1800,
  portChargesInr: 1450,
  complete: false,
  ...extra,
});

/** A full TRN-3 body: loaded 6 days ago, unloaded 5 days ago, 4 of 4 bundles, ₹2,650. */
export const tripBody = (transportCompanyId: string, destinationId: string, extra: object = {}) => ({
  transportCompanyId,
  destinationId,
  lrNumber: "LR-558214",
  vehicleNumber: "KL 07 CD 4821",
  driverName: "Suresh P",
  driverPhone: "+91 94470 55123",
  bundlesLoaded: 4,
  loadedOn: indiaDay(-6),
  loadedFrom: "Kochi port yard",
  loadedBy: "Ravi K",
  unloadedOn: indiaDay(-5),
  bundlesReceived: 4,
  receivedBy: "Joseph M",
  shortRemark: "",
  freightInr: 2200,
  handlingInr: 450,
  complete: false,
  ...extra,
});

/** Writes through the API: clears a container, then moves it by road. `cookie` needs clearing and transport Enter. */
export function stageWriter(ctx: TestContext, cookie: string, m: Awaited<ReturnType<typeof masters>>) {
  const http = api(ctx);
  const put = async (path: string, body: object) => {
    const res = await http.put(path, body).set("Cookie", cookie);
    expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body;
  };
  return {
    clear: (containerId: string, extra: object = {}) => put(`/clearings/${containerId}`, clearingBody(m.kochi, { complete: true, ...extra })),
    /** A cleared container, then a trip (unloaded unless `complete: false`); returns the container and trip ids. */
    async unloaded(options: Parameters<typeof makeContainer>[1] = {}, trip: object = {}) {
      const container = await makeContainer(ctx, options);
      await put(`/clearings/${container.id}`, clearingBody(m.kochi, { complete: true }));
      const { trip: saved } = await put(`/transports/${container.id}`, tripBody(m.kerala, m.warehouse, { complete: true, ...trip }));
      return { ...container, tripId: saved.id as string };
    },
  };
}
