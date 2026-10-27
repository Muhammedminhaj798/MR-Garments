import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { locations, orders, payments, receipts, users, userStageGrants } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf, indiaDay, makeOrder } from "./fixtures";
import { MESSAGES } from "./stock.routes";

const ctx = createTestContext();
const http = api(ctx);
let chen = "";
let wang = "";
let guangzhou = "";
beforeAll(async () => {
  await resetData(ctx);
  chen = await signInAs(ctx, SEEDED.chinaStaff);
  wang = await signInAs(ctx, SEEDED.chinaStaffTwoStages);
  guangzhou = await idOf(ctx, locations, "Guangzhou office");
});
afterAll(() => ctx.pool.end());

const twoLines = [
  { item: "Denim jeans", quantity: 100, rateCny: 12.5 },
  { item: "Cotton fabric", quantity: 500, rateCny: 3 },
];
const body = (orderId: string, lines: { orderLineId: string; quantity: number }[], extra: object = {}) => ({
  orderId,
  receivedOn: indiaDay(-1),
  locationId: guangzhou,
  bundles: 2,
  deliveryNote: "DN-1",
  shortRemark: "",
  lines,
  ...extra,
});
const post = (cookie: string, payload: object) => http.post("/receipts", payload).set("Cookie", cookie);
const stageOf = async (id: string) => (await ctx.db.select({ stage: orders.stage }).from(orders).where(eq(orders.id, id)))[0]!.stage;
const receiptCount = async (orderId: string) => (await ctx.db.select().from(receipts).where(eq(receipts.orderId, orderId))).length;

describe("access", () => {
  it("is 401 signed out and 403 without receiving access", async () => {
    for (const res of [await http.get("/receipts"), await http.get("/receipts/options"), await http.post("/receipts", {})]) {
      expect(res.status).toBe(401);
    }
    for (const email of [SEEDED.accounts, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
      const cookie = await signInAs(ctx, email);
      expect((await http.get("/receipts").set("Cookie", cookie)).status, email).toBe(403);
      expect((await http.get("/receipts/options").set("Cookie", cookie)).status, email).toBe(403);
      expect((await post(cookie, {})).status, email).toBe(403);
    }
  });

  it("lets Procurement view the list but not enter receipts", async () => {
    const procurement = await signInAs(ctx, SEEDED.procurement);
    expect((await http.get("/receipts").set("Cookie", procurement)).status).toBe(200);
    expect((await http.get("/receipts/options").set("Cookie", procurement)).status).toBe(403);
    expect((await post(procurement, {})).status).toBe(403);
  });

  it("refuses China staff without the receiving stage", async () => {
    const userId = await idOf(ctx, users, "Chen Yu");
    await ctx.db.delete(userStageGrants).where(eq(userStageGrants.userId, userId));
    expect((await http.get("/receipts").set("Cookie", chen)).status).toBe(403);
    await ctx.db.insert(userStageGrants).values({ userId, stage: 2 });
    expect((await http.get("/receipts").set("Cookie", chen)).status).toBe(200);
  });
});

describe("REC-3 POST /receipts and REC-1 GET /receipts", () => {
  it("records two receipts, moves the order 1 -> 2 and lists thisReceipt and totalSoFar", async () => {
    const order = await makeOrder(ctx, { lines: twoLines });
    const [main, fabric] = order.lineIds as [string, string];
    const first = await post(chen, body(order.id, [{ orderLineId: main, quantity: 40 }, { orderLineId: fabric, quantity: 0 }], { receivedOn: indiaDay(-2) }));
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ receipt: { id: expect.any(String) } });
    expect(await stageOf(order.id)).toBe(2);

    const second = await post(wang, body(order.id, [{ orderLineId: main, quantity: 50 }], { receivedOn: indiaDay(0), bundles: 3 }));
    expect(second.status).toBe(201);
    expect(await stageOf(order.id)).toBe(2);

    const list = await http.get("/receipts").set("Cookie", chen);
    expect(list.status).toBe(200);
    const rows = list.body.filter((row: { orderId: string }) => row.orderId === order.id);
    const common = { orderId: order.id, po: order.po, supplier: "Guangzhou Textile Co.", item: "Denim jeans", office: "Guangzhou office", ordered: 100, unit: "pcs" };
    expect(rows).toEqual([
      { ...common, id: second.body.receipt.id, receivedOn: indiaDay(0), thisReceipt: 50, totalSoFar: 90, bundles: 3, receivedBy: "Wang Fang" },
      { ...common, id: first.body.receipt.id, receivedOn: indiaDay(-2), thisReceipt: 40, totalSoFar: 40, bundles: 2, receivedBy: "Chen Yu" },
    ]);
  });

  it("refuses over-receipt, nothing received and negative quantities with 422 under lines", async () => {
    const order = await makeOrder(ctx, { lines: twoLines });
    const [main, fabric] = order.lineIds as [string, string];
    expect((await post(chen, body(order.id, [{ orderLineId: main, quantity: 90 }]))).status).toBe(201);
    const over = await post(chen, body(order.id, [{ orderLineId: main, quantity: 11 }]));
    expect(over.status).toBe(422);
    expect(over.body.error.fields).toEqual({ lines: MESSAGES.overReceipt("Denim jeans", 10, "pcs") });
    expect((await post(chen, body(order.id, [{ orderLineId: fabric, quantity: 501 }]))).body.error.fields).toEqual({
      lines: MESSAGES.overReceipt("Cotton fabric", 500, "m"),
    });
    const zeros = await post(chen, body(order.id, [{ orderLineId: main, quantity: 0 }]));
    expect(zeros.status).toBe(422);
    expect(zeros.body.error.fields).toEqual({ lines: MESSAGES.nothingReceived });
    const negative = await post(chen, body(order.id, [{ orderLineId: main, quantity: -1 }, { orderLineId: fabric, quantity: 5 }]));
    expect(negative.status).toBe(422);
    expect(Object.keys(negative.body.error.fields)).toEqual(["lines"]);
    const twice = await post(chen, body(order.id, [{ orderLineId: fabric, quantity: 1 }, { orderLineId: fabric, quantity: 1 }]));
    expect(twice.body.error.fields).toEqual({ lines: MESSAGES.duplicateLine });
    expect((await post(chen, body(order.id, [{ orderLineId: main, quantity: 10 }]))).status).toBe(201);
    expect(await receiptCount(order.id)).toBe(2);
  });

  it("refuses lines from another order", async () => {
    const order = await makeOrder(ctx, { lines: twoLines });
    const other = await makeOrder(ctx, { lines: twoLines });
    const res = await post(chen, body(order.id, [{ orderLineId: other.lineIds[0]!, quantity: 1 }]));
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual({ lines: MESSAGES.notOnOrder });
    expect(await receiptCount(order.id)).toBe(0);
    expect(await stageOf(order.id)).toBe(1);
  });

  it("refuses a date after today in India and accepts today", async () => {
    const order = await makeOrder(ctx, { lines: twoLines });
    const lines = [{ orderLineId: order.lineIds[0]!, quantity: 1 }];
    const future = await post(chen, body(order.id, lines, { receivedOn: indiaDay(1) }));
    expect(future.status).toBe(422);
    expect(future.body.error.fields).toEqual({ receivedOn: MESSAGES.receivedOnFuture });
    expect((await post(chen, body(order.id, lines, { receivedOn: "2026-02-30" }))).body.error.fields).toEqual({ receivedOn: MESSAGES.receivedOn });
    expect((await post(chen, body(order.id, lines, { receivedOn: indiaDay(0) }))).status).toBe(201);
  });

  it("refuses a non-China, inactive or unknown office", async () => {
    const order = await makeOrder(ctx, { lines: twoLines });
    const lines = [{ orderLineId: order.lineIds[0]!, quantity: 1 }];
    const india = await post(chen, body(order.id, lines, { locationId: await idOf(ctx, locations, "India office") }));
    expect(india.status).toBe(422);
    expect(india.body.error.fields).toEqual({ locationId: MESSAGES.office });
    await ctx.db.update(locations).set({ status: "Inactive" }).where(eq(locations.id, guangzhou));
    expect((await post(chen, body(order.id, lines))).body.error.fields).toEqual({ locationId: MESSAGES.office });
    await ctx.db.update(locations).set({ status: "Active" }).where(eq(locations.id, guangzhou));
    expect((await post(chen, body(order.id, lines, { locationId: "not-an-id" }))).body.error.fields).toEqual({ locationId: MESSAGES.office });
    expect(await receiptCount(order.id)).toBe(0);
  });

  it("is 409 order_not_receivable past stage 2 and 422 for an unknown order", async () => {
    const order = await makeOrder(ctx, { stage: 4, lines: twoLines });
    const res = await post(chen, body(order.id, [{ orderLineId: order.lineIds[0]!, quantity: 1 }]));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("order_not_receivable");
    expect(await receiptCount(order.id)).toBe(0);
    const unknown = await post(chen, body("00000000-0000-4000-8000-000000000000", [{ orderLineId: order.lineIds[0]!, quantity: 1 }]));
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.fields).toEqual({ orderId: MESSAGES.order });
  });

  it("refuses unknown keys with 400 and bad bundles with 422", async () => {
    const order = await makeOrder(ctx, { lines: twoLines });
    const lines = [{ orderLineId: order.lineIds[0]!, quantity: 1 }];
    expect((await post(chen, { ...body(order.id, lines), receivedBy: "someone" })).status).toBe(400);
    expect((await post(chen, { ...body(order.id, []), lines: [{ ...lines[0], extra: 1 }] })).status).toBe(400);
    expect((await post(chen, body(order.id, lines, { bundles: 1.5 }))).body.error.fields).toEqual({ bundles: MESSAGES.bundles });
  });

  it("refuses two simultaneous receipts that together over-receive", async () => {
    const order = await makeOrder(ctx, { lines: twoLines });
    const lines = [{ orderLineId: order.lineIds[0]!, quantity: 60 }];
    const results = await Promise.all([post(chen, body(order.id, lines)), post(wang, body(order.id, lines))]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 422]);
    expect(await receiptCount(order.id)).toBe(1);
  });
});

describe("REC-2 GET /receipts/options", () => {
  it("lists active China offices and the lines still to receive of stage 1-2 orders", async () => {
    const open = await makeOrder(ctx, { lines: twoLines });
    const [main, fabric] = open.lineIds as [string, string];
    const done = await makeOrder(ctx, { lines: [{ item: "Polo shirts", quantity: 10, rateCny: 1 }] });
    const loading = await makeOrder(ctx, { stage: 3, lines: twoLines });
    await ctx.db.insert(payments).values([
      { orderId: open.id, kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 300, status: "paid", paidOn: indiaDay(-20), rateInr: 11.8, mode: "Bank transfer" },
      { orderId: open.id, kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 50, status: "due", dueDate: indiaDay(5) },
    ]);
    expect((await post(chen, body(open.id, [{ orderLineId: main, quantity: 100 }, { orderLineId: fabric, quantity: 120 }]))).status).toBe(201);
    expect((await post(chen, body(done.id, [{ orderLineId: done.lineIds[0]!, quantity: 10 }]))).status).toBe(201);

    const res = await http.get("/receipts/options").set("Cookie", wang);
    expect(res.status).toBe(200);
    expect(res.body.offices).toEqual([{ id: guangzhou, name: "Guangzhou office" }]);
    const ids = res.body.orders.map((order: { orderId: string }) => order.orderId);
    expect(ids).not.toContain(done.id);
    expect(ids).not.toContain(loading.id);
    expect(res.body.orders.find((order: { orderId: string }) => order.orderId === open.id)).toEqual({
      orderId: open.id,
      po: open.po,
      supplier: "Guangzhou Textile Co.",
      orderValueCny: 2750,
      depositsPaidCny: 300,
      lines: [{ orderLineId: fabric, item: "Cotton fabric", unit: "m", ordered: 500, receivedEarlier: 120, unitPriceCny: 3 }],
    });
  });
});
