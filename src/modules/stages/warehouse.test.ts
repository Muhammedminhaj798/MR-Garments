import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type Currency, locations, orders, payments, suppliers, teams, warehouseReceiptLines, warehouseReceipts } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { loadLandedCosts } from "../costs/landed-cost";
import { indiaDay, makeOrder } from "../stock/fixtures";
import { STAGE_MESSAGES } from "./common";
import { makeContainer, masters, stageOf, stageWriter, UNKNOWN } from "./fixtures";
import { WAREHOUSE_MESSAGES as M } from "./warehouse.routes";

// No seeded role has the stage capabilities at View only, so Procurement gets View here for the 403-on-Enter checks.
vi.mock("../../permissions/matrix", async (original) => {
  const actual = await original<typeof import("../../permissions/matrix")>();
  const viewOnly = ["clearing", "transport", "warehouse"];
  return {
    ...actual,
    effectiveAccess: (...args: Parameters<typeof actual.effectiveAccess>) =>
      args[0] === "Procurement" && viewOnly.includes(args[2]) ? "View" : actual.effectiveAccess(...args),
  };
});

const ctx = createTestContext();
const http = api(ctx);
let joseph = "";
let suresh = "";
let m: Awaited<ReturnType<typeof masters>>;
let write: ReturnType<typeof stageWriter>;
beforeAll(async () => {
  await resetData(ctx);
  joseph = await signInAs(ctx, SEEDED.warehouseStaff);
  suresh = await signInAs(ctx, SEEDED.management);
  m = await masters(ctx);
  write = stageWriter(ctx, await signInAs(ctx, SEEDED.indiaStaff), m);
});
afterAll(() => ctx.pool.end());

const get = (path: string, cookie = joseph) => http.get(path).set("Cookie", cookie);
const put = (id: string, body: object, cookie = joseph) => http.put(`/warehouse-receipts/${id}`, body).set("Cookie", cookie);
const receiptOf = async (transportId: string) => (await ctx.db.select().from(warehouseReceipts).where(eq(warehouseReceipts.transportId, transportId)))[0];
const linesOf = async (receiptId: string) =>
  ctx.db
    .select({ orderLineId: warehouseReceiptLines.orderLineId, teamId: warehouseReceiptLines.teamId, quantity: warehouseReceiptLines.quantity })
    .from(warehouseReceiptLines)
    .where(eq(warehouseReceiptLines.receiptId, receiptId));
/** Received 4 days ago (the trip was unloaded 5 days ago) at Main warehouse, 4 bundles. */
const body = (lines: { orderLineId: string; teamId: string; quantity: number }[], extra: object = {}) => ({
  locationId: m.warehouse,
  receivedOn: indiaDay(-4),
  receivedBy: "Joseph M",
  bundlesReceived: 4,
  lines,
  complete: false,
  ...extra,
});
/** An unloaded trip of one order, 100 Denim jeans at ¥10 (CNF), paid in full to the supplier at 12: ₹12,000. */
async function paidTrip() {
  const trip = await write.unloaded();
  await ctx.db.insert(payments).values({
    orderId: trip.orders[0]!.id,
    kind: "Balance",
    payee: "Guangzhou Textile Co.",
    payeeRole: "supplier",
    amountCny: 1000,
    status: "paid",
    paidOn: indiaDay(-30),
    rateInr: 12,
    mode: "Bank transfer",
  });
  return trip;
}

// First, while the database holds only this test's receipts.
describe("WH-1 GET /warehouse-receipts", () => {
  it("lists one row per order per stocked receipt, the trips waiting to be received, and costs for management only", async () => {
    const shared = await write.unloaded({
      orders: [
        [{ item: "Denim jeans", quantity: 100, rateCny: 10 }],
        [
          { item: "Track pants", quantity: 30, rateCny: 6 },
          { item: "Polo shirts", quantity: 20, rateCny: 8 },
        ],
      ],
    });
    const [jeans, mixed] = shared.orders;
    const split = [
      { orderLineId: jeans!.lineIds[0]!, teamId: m.retail, quantity: 60 },
      { orderLineId: jeans!.lineIds[0]!, teamId: m.wholesale, quantity: 40 },
      { orderLineId: mixed!.lineIds[0]!, teamId: m.online, quantity: 30 },
      { orderLineId: mixed!.lineIds[1]!, teamId: m.retail, quantity: 5 },
      { orderLineId: mixed!.lineIds[1]!, teamId: m.online, quantity: 10 },
      { orderLineId: mixed!.lineIds[1]!, teamId: m.wholesale, quantity: 0 },
    ];
    expect((await put(shared.tripId, body(split, { complete: true }))).status).toBe(200);
    const older = await paidTrip();
    expect((await put(older.tripId, body([{ orderLineId: older.orders[0]!.lineIds[0]!, teamId: m.online, quantity: 100 }], { receivedOn: indiaDay(-5), complete: true }))).status).toBe(200);
    const waiting = await write.unloaded({}, { loadedOn: indiaDay(-3), unloadedOn: indiaDay(-2) });
    const draft = await write.unloaded({}, { unloadedOn: indiaDay(-6), loadedOn: indiaDay(-6) });
    expect((await put(draft.tripId, body([], { receivedOn: indiaDay(-1) }))).status).toBe(200);
    await write.unloaded({}, { complete: false }); // still on the road

    const res = await get("/warehouse-receipts");
    expect(res.status).toBe(200);
    expect(res.body.teams).toEqual([
      { id: m.retail, name: "Retail team" },
      { id: m.wholesale, name: "Wholesale team" },
      { id: m.online, name: "Online team" },
    ]);
    expect(res.body.warehouses).toEqual([{ id: m.warehouse, name: "Main warehouse" }]);
    const receipt = (await receiptOf(shared.tripId))!;
    const common = { receiptId: receipt.id, transportId: shared.tripId, receivedOn: indiaDay(-4), receivedBy: "Joseph M", container: shared.number, supplier: "Guangzhou Textile Co." };
    const location = { id: m.warehouse, name: "Main warehouse" };
    expect(res.body.rows).toEqual([
      { ...common, id: `${receipt.id}:${jeans!.id}`, orderId: jeans!.id, po: jeans!.po, item: "Denim jeans", location, received: 100, teams: { [m.retail]: 60, [m.wholesale]: 40 }, costPerPieceInr: null },
      { ...common, id: `${receipt.id}:${mixed!.id}`, orderId: mixed!.id, po: mixed!.po, item: "Track pants", location, received: 45, teams: { [m.online]: 40, [m.retail]: 5 }, costPerPieceInr: null },
      expect.objectContaining({ transportId: older.tripId, po: older.orders[0]!.po, received: 100, teams: { [m.online]: 100 }, costPerPieceInr: null }),
    ]);
    expect(res.body.ready).toEqual([
      {
        transportId: draft.tripId,
        containerId: draft.id,
        container: draft.number,
        vehicleNumber: "KL 07 CD 4821",
        lrNumber: "LR-558214",
        unloadedOn: indiaDay(-6),
        bundlesReceived: 4,
        destination: "Main warehouse",
        receiptStatus: "draft",
        orders: [draft.orders[0]!.po],
      },
      expect.objectContaining({ transportId: waiting.tripId, unloadedOn: indiaDay(-2), receiptStatus: null }),
    ]);

    // Management sees each order's landed cost per piece: ₹12,000 + ₹37,050 clearing + ₹2,650 transport over 100 pcs.
    const costs = await loadLandedCosts(ctx.db, [jeans!.id, mixed!.id]);
    const managed = (await get("/warehouse-receipts", suresh)).body.rows;
    expect(managed.map((row: { costPerPieceInr: number }) => row.costPerPieceInr)).toEqual([costs.get(jeans!.id)!.perPieceInr, costs.get(mixed!.id)!.perPieceInr, 517]);
    expect(managed[0].costPerPieceInr).toBeGreaterThan(0);
  });
});

describe("access", () => {
  it("is 401 signed out, 403 without warehouse access, and 403 on PUT with View only", async () => {
    const { tripId } = await write.unloaded();
    for (const res of [await http.get("/warehouse-receipts"), await http.get(`/warehouse-receipts/${tripId}`), await http.put(`/warehouse-receipts/${tripId}`, body([]))]) {
      expect(res.status).toBe(401);
    }
    for (const email of [SEEDED.chinaStaffTwoStages, SEEDED.indiaStaff, SEEDED.accounts]) {
      const cookie = await signInAs(ctx, email);
      expect((await get("/warehouse-receipts", cookie)).status, email).toBe(403);
      expect((await get(`/warehouse-receipts/${tripId}`, cookie)).status, email).toBe(403);
      expect((await put(tripId, body([]), cookie)).status, email).toBe(403);
    }
    const viewer = await signInAs(ctx, SEEDED.procurement);
    expect((await get("/warehouse-receipts", viewer)).status).toBe(200);
    expect((await get(`/warehouse-receipts/${tripId}`, viewer)).body.cost).toBeNull();
    const refused = await put(tripId, body([]), viewer);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("forbidden");
    expect(await receiptOf(tripId)).toBeUndefined();
  });
});

describe("WH-2 GET /warehouse-receipts/:transportId", () => {
  it("returns the trip, no receipt yet, the lines to split, teams, warehouses, and the cost so far for management", async () => {
    const trip = await paidTrip();
    const [order] = trip.orders;
    const res = await get(`/warehouse-receipts/${trip.tripId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      trip: {
        id: trip.tripId,
        containerId: trip.id,
        container: trip.number,
        terms: "CNF",
        vehicleNumber: "KL 07 CD 4821",
        lrNumber: "LR-558214",
        bundlesLoaded: 4,
        bundlesReceived: 4,
        unloadedOn: indiaDay(-5),
        destinationId: m.warehouse,
        status: "unloaded",
      },
      receipt: null,
      lines: [{ orderLineId: order!.lineIds[0], orderId: order!.id, po: order!.po, item: "Denim jeans", unit: "pcs", quantity: 100 }],
      teams: [
        { id: m.retail, name: "Retail team" },
        { id: m.wholesale, name: "Wholesale team" },
        { id: m.online, name: "Online team" },
      ],
      warehouses: [{ id: m.warehouse, name: "Main warehouse" }],
      cost: null,
      previousOutstanding: null,
    });
    const managed = await get(`/warehouse-receipts/${trip.tripId}`, suresh);
    expect(managed.body.cost).toEqual({
      goodsInr: 12000,
      seaFreightInr: 0,
      clearingInr: 37050,
      transportInr: 2650,
      totalInr: 51700,
      orderedPieces: 100,
      final: false,
    });

    // Stocked and paid in full: the cost is final.
    expect((await put(trip.tripId, body([{ orderLineId: order!.lineIds[0]!, teamId: m.retail, quantity: 100 }], { complete: true }))).status).toBe(200);
    expect((await get(`/warehouse-receipts/${trip.tripId}`, suresh)).body.cost.final).toBe(true);
  });

  it("returns the saved receipt with its split, keeping a deactivated team's column", async () => {
    const trip = await write.unloaded();
    const line = trip.orders[0]!.lineIds[0]!;
    expect((await put(trip.tripId, body([{ orderLineId: line, teamId: m.online, quantity: 30 }]))).status).toBe(200);
    await ctx.db.update(teams).set({ status: "Inactive" }).where(eq(teams.id, m.online));
    try {
      const res = await get(`/warehouse-receipts/${trip.tripId}`);
      expect(res.body.receipt).toEqual({
        id: (await receiptOf(trip.tripId))!.id,
        locationId: m.warehouse,
        receivedOn: indiaDay(-4),
        receivedBy: "Joseph M",
        bundlesReceived: 4,
        status: "draft",
        lines: [{ orderLineId: line, teamId: m.online, quantity: 30 }],
      });
      expect(res.body.teams.map((team: { id: string }) => team.id)).toEqual([m.retail, m.wholesale, m.online]);
      // Saving again needs active teams.
      expect((await put(trip.tripId, body([{ orderLineId: line, teamId: m.online, quantity: 30 }]))).body.error.fields).toEqual({ lines: M.team });
      const other = await write.unloaded();
      expect((await get(`/warehouse-receipts/${other.tripId}`)).body.teams.map((team: { id: string }) => team.id)).toEqual([m.retail, m.wholesale]);
    } finally {
      await ctx.db.update(teams).set({ status: "Active" }).where(eq(teams.id, m.online));
    }
  });

  it("is 404 not_found for a malformed or unknown trip", async () => {
    for (const id of ["not-a-uuid", UNKNOWN]) {
      const res = await get(`/warehouse-receipts/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.body.error).toEqual({ code: "not_found", message: "Trip not found." });
      expect((await put(id, body([]))).status, id).toBe(404);
    }
  });
});

describe("WH-3 PUT /warehouse-receipts/:transportId", () => {
  it("saves a draft (no stage change), replaces its split, then adds it to stock (orders to 6); after that it is closed", async () => {
    const trip = await write.unloaded({
      orders: [[{ item: "Denim jeans", quantity: 100, rateCny: 10 }], [{ item: "Cotton fabric", quantity: 40, rateCny: 3 }]],
    });
    const [jeans, fabric] = trip.orders;
    const first = await put(trip.tripId, body([{ orderLineId: jeans!.lineIds[0]!, teamId: m.retail, quantity: 50 }], { bundlesReceived: 3 }));
    expect(first.status).toBe(200);
    const receiptId = first.body.receipt.id;
    expect(first.body).toEqual({ receipt: { id: receiptId, status: "draft" } });
    expect([await stageOf(ctx, jeans!.id), await stageOf(ctx, fabric!.id)]).toEqual([5, 5]);

    const split = [
      { orderLineId: jeans!.lineIds[0]!, teamId: m.wholesale, quantity: 100 },
      { orderLineId: fabric!.lineIds[0]!, teamId: m.online, quantity: 25 },
      { orderLineId: fabric!.lineIds[0]!, teamId: m.retail, quantity: 0 },
    ];
    expect((await put(trip.tripId, body(split))).body).toEqual({ receipt: { id: receiptId, status: "draft" } });
    expect(await linesOf(receiptId)).toEqual(expect.arrayContaining(split.slice(0, 2)));
    expect(await linesOf(receiptId)).toHaveLength(2);
    expect(await receiptOf(trip.tripId)).toMatchObject({ bundlesReceived: 4, status: "draft" });

    // Unassigned pieces are allowed (15 m of fabric).
    const done = await put(trip.tripId, body(split, { complete: true }));
    expect(done.body).toEqual({ receipt: { id: receiptId, status: "stocked" } });
    expect([await stageOf(ctx, jeans!.id), await stageOf(ctx, fabric!.id)]).toEqual([6, 6]);

    const closed = await put(trip.tripId, body(split));
    expect(closed.status).toBe(409);
    expect(closed.body.error).toEqual({ code: "record_closed", message: STAGE_MESSAGES.closed });
    expect(await linesOf(receiptId)).toHaveLength(2);
  });

  it("is 409 not_unloaded while the trip is on the road, and saves nothing", async () => {
    const trip = await write.unloaded({}, { complete: false });
    const res = await put(trip.tripId, body([{ orderLineId: trip.orders[0]!.lineIds[0]!, teamId: m.retail, quantity: 1 }], { complete: true }));
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: "not_unloaded", message: STAGE_MESSAGES.notUnloaded });
    expect(await receiptOf(trip.tripId)).toBeUndefined();
    expect(await stageOf(ctx, trip.orders[0]!.id)).toBe(5);
  });

  it("checks the warehouse, the date, who received and the bundles", async () => {
    const { tripId } = await write.unloaded(); // unloaded 5 days ago
    const fields = async (extra: object) => {
      const res = await put(tripId, body([], extra));
      expect(res.status, JSON.stringify(extra)).toBe(422);
      return res.body.error.fields;
    };
    expect(await fields({ locationId: m.indiaOffice, receivedOn: indiaDay(-6) })).toEqual({ locationId: M.location, receivedOn: M.receivedBeforeUnloaded });
    expect(await fields({ receivedOn: indiaDay(1), receivedBy: " ", bundlesReceived: -1 })).toEqual({ receivedBy: M.receivedBy, bundlesReceived: M.bundles });
    expect(await fields({ receivedOn: indiaDay(1) })).toEqual({ receivedOn: M.receivedFuture });
    expect(await fields({ receivedOn: "yesterday", locationId: "x" })).toEqual({ receivedOn: M.receivedOn, locationId: M.location });
    await ctx.db.update(locations).set({ status: "Inactive" }).where(eq(locations.id, m.warehouse));
    try {
      expect(await fields({})).toEqual({ locationId: M.location });
    } finally {
      await ctx.db.update(locations).set({ status: "Active" }).where(eq(locations.id, m.warehouse));
    }
    expect(await receiptOf(tripId)).toBeUndefined();
    expect((await put(tripId, body([], { receivedOn: indiaDay(-5) }))).status).toBe(200);
  });

  it("checks the split: lines of this container, active teams, whole numbers, at most the container quantity", async () => {
    const trip = await write.unloaded();
    const other = await makeContainer(ctx);
    const line = trip.orders[0]!.lineIds[0]!;
    const lines = async (split: object[], extra: object = {}) => {
      const res = await put(trip.tripId, body(split as never, extra));
      expect(res.status, JSON.stringify(split)).toBe(422);
      return res.body.error.fields.lines;
    };
    expect(await lines([{ orderLineId: other.orders[0]!.lineIds[0]!, teamId: m.retail, quantity: 1 }])).toBe(M.unknownLine);
    expect(await lines([{ orderLineId: line, teamId: UNKNOWN, quantity: 1 }])).toBe(M.team);
    expect(await lines([{ orderLineId: line, teamId: m.retail, quantity: 1.5 }])).toBe(M.quantity);
    expect(await lines([{ orderLineId: line, teamId: m.retail, quantity: -1 }])).toBe(M.quantity);
    expect(
      await lines([
        { orderLineId: line, teamId: m.retail, quantity: 1 },
        { orderLineId: line, teamId: m.retail, quantity: 2 },
      ]),
    ).toBe(M.duplicateLine);
    expect(
      await lines([
        { orderLineId: line, teamId: m.retail, quantity: 60 },
        { orderLineId: line, teamId: m.online, quantity: 41 },
      ]),
    ).toBe(M.overSplit("Denim jeans", trip.orders[0]!.po, 100, "pcs"));
    expect(await lines([{ orderLineId: line, teamId: m.retail, quantity: 0 }], { complete: true })).toBe(M.nothingAssigned);
    expect(await lines([], { complete: true })).toBe(M.nothingAssigned);
    expect(await receiptOf(trip.tripId)).toBeUndefined();
    expect((await put(trip.tripId, body([{ orderLineId: line, teamId: m.retail, quantity: 100 }], { complete: true }))).status).toBe(200);
  });

  it("refuses unknown keys (400) and lets only one of two simultaneous completions win", async () => {
    const trip = await write.unloaded();
    const split = [{ orderLineId: trip.orders[0]!.lineIds[0]!, teamId: m.retail, quantity: 100 }];
    expect((await put(trip.tripId, body(split, { status: "stocked" }))).status).toBe(400);
    const results = await Promise.all([put(trip.tripId, body(split, { complete: true })), put(trip.tripId, body(split, { complete: true }), suresh)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect((await ctx.db.select().from(warehouseReceipts).where(eq(warehouseReceipts.transportId, trip.tripId))).length).toBe(1);
  });
});

describe("WH-2 previous supplier outstanding", () => {
  let n = 0;
  /** A supplier of its own (the other tests here share the default one), so its other orders are only this test's. */
  async function supplier(currency: Currency = "CNY") {
    const name = `Outstanding Supplier ${++n}`;
    const [row] = await ctx.db.insert(suppliers).values({ name, currency }).returning({ id: suppliers.id });
    return { id: row!.id, name };
  }
  const moveTo = (orderId: string, supplierId: string) => ctx.db.update(orders).set({ supplierId }).where(eq(orders.id, orderId));
  /** An earlier order of `owner`: `quantity` Denim jeans at `rate`, in `currency`. */
  async function earlier(owner: { name: string }, quantity: number, rate: number, currency: Currency = "CNY", stage = 1) {
    const order = await makeOrder(ctx, { supplier: owner.name, stage, lines: [{ item: "Denim jeans", quantity, rateCny: rate }] });
    if (currency !== "CNY") await ctx.db.update(orders).set({ currency }).where(eq(orders.id, order.id));
    return order.id;
  }
  const pay = (orderId: string, amountCny: number, extra: Partial<typeof payments.$inferInsert> = {}) =>
    ctx.db.insert(payments).values({
      orderId,
      kind: "Deposit",
      payee: "supplier",
      payeeRole: "supplier",
      amountCny,
      status: "paid",
      paidOn: indiaDay(-10),
      rateInr: 12,
      mode: "Bank transfer",
      ...extra,
    });
  const due = { status: "due", paidOn: null, rateInr: null, mode: null, dueDate: indiaDay(10) } as const;
  const owedOn = async (tripId: string) => (await get(`/warehouse-receipts/${tripId}`, suresh)).body.previousOutstanding;

  it("is empty for a supplier with no other orders, and leaves out the trip's own unpaid order", async () => {
    const owner = await supplier("USD");
    const trip = await write.unloaded();
    await moveTo(trip.orders[0]!.id, owner.id);
    // The trip's own ¥1,000 order is unpaid, but it is this PO, not a previous one.
    expect(await owedOn(trip.tripId)).toEqual([{ supplierId: owner.id, supplier: owner.name, currency: "USD", orders: 0, byCurrency: [] }]);
  });

  it("adds each currency's unpaid balances apart, counting deposits and payments once, and never changes the cost", async () => {
    const owner = await supplier();
    const trip = await write.unloaded();
    await moveTo(trip.orders[0]!.id, owner.id);
    const before = (await get(`/warehouse-receipts/${trip.tripId}`, suresh)).body.cost;

    // Fully paid: ¥2,000 = ¥500 deposit + ¥1,500 balance. Left out.
    const paid = await earlier(owner, 200, 10);
    await pay(paid, 500);
    await pay(paid, 1500, { kind: "Balance" });
    expect(await owedOn(trip.tripId)).toEqual([{ supplierId: owner.id, supplier: owner.name, currency: "CNY", orders: 0, byCurrency: [] }]);

    // Partly paid: ¥1,000 - ¥300 deposit = ¥700. A scheduled (due) payment and an agent payment don't reduce it.
    const partly = await earlier(owner, 100, 10);
    await pay(partly, 300);
    await pay(partly, 700, { kind: "Balance", ...due });
    await pay(partly, 999, { payeeRole: "agent", payee: "Sino Freight", kind: "Balance" });
    expect((await owedOn(trip.tripId))[0]).toMatchObject({ orders: 1, byCurrency: [{ currency: "CNY", amount: 700 }] });

    // More outstanding orders: an unpaid finished one (¥500) and one rounded per order like the report (3 x 3.3333 = ¥10).
    await earlier(owner, 50, 10, "CNY", 6);
    await earlier(owner, 3, 3.3333);
    // Other currencies stay apart: $300 - $100 = $200; INR paid in full (left out) and overpaid (left out, not netted).
    const usd = await earlier(owner, 30, 10, "USD");
    await pay(usd, 100, { rateInr: 88 });
    const inrPaid = await earlier(owner, 100, 10, "INR");
    await pay(inrPaid, 1000, { rateInr: 1 });
    const inrOver = await earlier(owner, 100, 10, "INR");
    await pay(inrOver, 1200, { rateInr: 1 });
    // Another supplier's unpaid order never counts.
    await earlier(await supplier(), 100, 10);

    expect(await owedOn(trip.tripId)).toEqual([
      {
        supplierId: owner.id,
        supplier: owner.name,
        currency: "CNY",
        orders: 4,
        byCurrency: [
          { currency: "CNY", amount: 1210 },
          { currency: "USD", amount: 200 },
        ],
      },
    ]);
    // The cost so far (goods, total, pieces: so cost per piece and team costs) is exactly what it was.
    expect((await get(`/warehouse-receipts/${trip.tripId}`, suresh)).body.cost).toEqual(before);
  });

  it("lists each supplier of a mixed container, leaving out every PO on the trip; only for cost and payments viewers", async () => {
    const [first, second] = [await supplier(), await supplier()];
    const trip = await write.unloaded({
      orders: [[{ item: "Denim jeans", quantity: 10, rateCny: 10 }], [{ item: "Denim jeans", quantity: 20, rateCny: 10 }]],
    });
    await moveTo(trip.orders[0]!.id, second.id);
    await moveTo(trip.orders[1]!.id, first.id);
    await earlier(first, 40, 10);
    await earlier(second, 60, 10, "USD");
    expect(await owedOn(trip.tripId)).toEqual([
      { supplierId: first.id, supplier: first.name, currency: "CNY", orders: 1, byCurrency: [{ currency: "CNY", amount: 400 }] },
      { supplierId: second.id, supplier: second.name, currency: "CNY", orders: 1, byCurrency: [{ currency: "USD", amount: 600 }] },
    ]);
    // Warehouse staff see neither the cost nor the supplier's money.
    const staff = await get(`/warehouse-receipts/${trip.tripId}`);
    expect([staff.status, staff.body.cost, staff.body.previousOutstanding]).toEqual([200, null, null]);
  });
});
