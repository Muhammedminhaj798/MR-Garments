import { eq } from "drizzle-orm";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { items, locations, orders, shippingAgents, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf, indiaDay } from "../stock/fixtures";

// Agent 7 audit: one order driven through the HTTP API (ORD-3, PAY-2, REC-3, CON-3, CON-5) with every read endpoint
// (ORD-1, ORD-4, PAY-1, CAL-1, REC-1, REC-2, CON-1, CON-2, CON-4) compared after each step, plus concurrency probes.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let boss = ""; // Management: sees everything
let wang = ""; // China staff, stages 2-3: Receiving and Containers
let accounts = "";
let procurement = "";
const ids = {} as Record<"supplier" | "pants" | "fabric" | "sino" | "office", string>;
const order = { id: "", po: "", lines: [] as string[] };
const containerIds: string[] = [];
let winnerNumber = "";

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const round2 = (n: number) => Math.round(n * 100) / 100;
/** INR for one payment, rounded to 2 decimals per payment (the contract), in integer arithmetic. */
const inr = (amountCny: number, rate: number) => Math.round((Math.round(amountCny * 100) * Math.round(rate * 10_000)) / 10_000) / 100;

const get = (path: string, cookie = boss) => http.get(path).set("Cookie", cookie);
const post = (path: string, body: object, cookie = wang) => http.post(path, body).set("Cookie", cookie);
const patch = (path: string, body: object, cookie = wang) => http.patch(path, body).set("Cookie", cookie);

const DEPOSITS = [
  { payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 100.1, paidOn: indiaDay(-9), rateInr: 11.8765, mode: "Bank transfer" },
  { payee: "Sino Freight", payeeRole: "agent", amountCny: 50.55, paidOn: indiaDay(-9), rateInr: 11.91, mode: "Cash" },
];
const VALUE = 60 * 5.5 + 50 * 4.25; // 542.5

beforeAll(async () => {
  await resetData(ctx);
  boss = await signInAs(ctx, SEEDED.management);
  wang = await signInAs(ctx, SEEDED.chinaStaffTwoStages);
  accounts = await signInAs(ctx, SEEDED.accounts);
  procurement = await signInAs(ctx, SEEDED.procurement);
  ids.supplier = await idOf(ctx, suppliers, "Guangzhou Textile Co.");
  ids.pants = await idOf(ctx, items, "Track pants");
  ids.fabric = await idOf(ctx, items, "Cotton fabric");
  ids.sino = await idOf(ctx, shippingAgents, "Sino Freight");
  ids.office = await idOf(ctx, locations, "Guangzhou office");
});

type Expected = { stage: number; received: [number, number]; loaded: [number, number]; payments: { amountCny: number; rateInr: number; kind: string }[] };

/** Reads every endpoint for the order and checks they tell one story. */
async function expectConsistent(want: Expected) {
  const [o1, o4, p1, cal, r1, r2, c1, c2] = await Promise.all([
    get("/orders"),
    get(`/orders/${order.po}`),
    get("/payments"),
    get("/deliveries"),
    get("/receipts"),
    get("/receipts/options"),
    get("/containers"),
    get("/containers/options"),
  ]);
  for (const res of [o1, o4, p1, cal, r1, r2, c1, c2]) expect(res.status).toBe(200);

  const ord1 = o1.body.find((row: { id: string }) => row.id === order.id);
  const detail = o4.body;
  const pay = p1.body.orders.find((row: { orderId: string }) => row.orderId === order.id);
  const paidCny = round2(want.payments.reduce((sum, p) => sum + p.amountCny, 0));
  const paidInr = round2(want.payments.reduce((sum, p) => sum + inr(p.amountCny, p.rateInr), 0));

  // Stage and the three money figures: identical in ORD-1, ORD-4 and PAY-1.
  expect(ord1.stage).toBe(want.stage);
  expect(detail.stage).toBe(want.stage);
  for (const view of [ord1, detail, pay]) {
    expect(view.orderValueCny).toBe(VALUE);
    expect(view.paidCny).toBeCloseTo(paidCny, 2);
    expect(view.paidInr).toBeCloseTo(paidInr, 2);
  }
  expect(detail.balanceCny).toBeCloseTo(round2(VALUE - paidCny), 2);
  expect(pay.balanceCny).toBe(detail.balanceCny);
  expect(detail.lines.reduce((sum: number, l: { valueCny: number }) => sum + l.valueCny, 0)).toBeCloseTo(VALUE, 2);

  // Main line (position 0): ORD-1 and ORD-4 header, CAL-1.
  expect(ord1.quantity).toBe(60);
  expect(ord1.received).toBe(want.received[0]);
  expect(detail.received).toBe(want.received[0]);
  expect(detail.quantity).toBe(60);
  expect(ord1.unit).toBe("pcs");
  expect(ord1.supplier.name).toBe(pay.supplier);
  // Per line (ORD-4): received and loaded.
  expect(detail.lines.map((l: { received: number }) => l.received)).toEqual(want.received);
  expect(detail.lines.map((l: { loaded: number }) => l.loaded)).toEqual(want.loaded);
  expect(detail.lines.map((l: { position: number }) => l.position)).toEqual([0, 1]);

  // Payment records: ORD-4 list and PAY-1 list hold the same rows for this order.
  const payList = p1.body.payments.filter((p: { orderId: string }) => p.orderId === order.id);
  expect(payList).toHaveLength(want.payments.length);
  expect(detail.payments).toHaveLength(want.payments.length);
  expect(detail.payments.map((p: { id: string }) => p.id).sort()).toEqual(payList.map((p: { id: string }) => p.id).sort());
  expect(payList.every((p: { po: string; status: string }) => p.po === order.po && p.status === "paid")).toBe(true);

  // CAL-1: orders at stage 1-2 only, same received and due date.
  const inCal = cal.body.find((row: { orderId: string }) => row.orderId === order.id);
  if (want.stage <= 2) {
    expect(inCal).toBeDefined();
    expect(inCal.received).toBe(ord1.received);
    expect(inCal.due).toBe(ord1.deliveryDate);
    expect(inCal.quantity).toBe(ord1.quantity);
    expect(inCal.po).toBe(order.po);
  } else {
    expect(inCal).toBeUndefined();
  }

  // REC-1 rows for this order: one per receipt, the latest main-line total equals ORD-1 received.
  const recRows = r1.body.filter((row: { orderId: string }) => row.orderId === order.id);
  expect(recRows).toHaveLength(detail.receipts.length);
  if (recRows.length > 0) {
    expect(Math.max(...recRows.map((r: { totalSoFar: number }) => r.totalSoFar))).toBe(want.received[0]);
    expect(recRows.reduce((sum: number, r: { thisReceipt: number }) => sum + r.thisReceipt, 0)).toBe(want.received[0]);
    expect(recRows.every((r: { ordered: number }) => r.ordered === 60)).toBe(true);
  }
  const mainReceived = detail.receipts.flatMap((r: { lines: { orderLineId: string; quantity: number }[] }) => r.lines).filter((l: { orderLineId: string }) => l.orderLineId === order.lines[0]);
  expect(mainReceived.reduce((sum: number, l: { quantity: number }) => sum + l.quantity, 0)).toBe(want.received[0]);

  // REC-2: stage 1-2 with something left; per-line receivedEarlier; deposits-only paid total.
  const opt = r2.body.orders.find((row: { orderId: string }) => row.orderId === order.id);
  const left = [60 - want.received[0], 50 - want.received[1]];
  if (want.stage <= 2 && left.some((n) => n > 0)) {
    expect(opt).toBeDefined();
    expect(opt.orderValueCny).toBe(VALUE);
    const deposits = round2(want.payments.filter((p) => p.kind === "Deposit").reduce((sum, p) => sum + p.amountCny, 0));
    expect(opt.depositsPaidCny).toBeCloseTo(deposits, 2);
    expect(opt.lines.map((l: { orderLineId: string }) => l.orderLineId)).toEqual(order.lines.filter((_, i) => left[i]! > 0));
    for (const l of opt.lines as { orderLineId: string; receivedEarlier: number; ordered: number }[]) {
      const i = order.lines.indexOf(l.orderLineId);
      expect(l.receivedEarlier).toBe(want.received[i]);
      expect(l.ordered).toBe(i === 0 ? 60 : 50);
    }
  } else {
    expect(opt).toBeUndefined();
  }

  // CON-2: stage 2-3 lines with received > loaded.
  const loadable = c2.body.lines.filter((l: { orderId: string }) => l.orderId === order.id);
  const expectedLoadable = want.stage === 2 || want.stage === 3 ? order.lines.filter((_, i) => want.received[i]! > want.loaded[i]!) : [];
  expect(loadable.map((l: { orderLineId: string }) => l.orderLineId)).toEqual(expectedLoadable);
  for (const l of loadable as { orderLineId: string; received: number; loaded: number }[]) {
    const i = order.lines.indexOf(l.orderLineId);
    expect([l.received, l.loaded]).toEqual([want.received[i], want.loaded[i]]);
  }

  // CON-1 / ORD-4 containers: same containers, statuses, and this order's lines add up to `loaded`.
  const listed = c1.body.filter((c: { orders: { po: string }[] }) => c.orders.some((x) => x.po === order.po));
  expect(listed.map((c: { id: string }) => c.id).sort()).toEqual(detail.containers.map((c: { id: string }) => c.id).sort());
  for (const c of detail.containers as { id: string; status: string; lines: { orderLineId: string; quantity: number }[] }[]) {
    expect(listed.find((x: { id: string }) => x.id === c.id).status).toBe(c.status);
  }
  const loadedByLine = order.lines.map((id) =>
    (detail.containers as { lines: { orderLineId: string; quantity: number }[] }[]).flatMap((c) => c.lines).filter((l) => l.orderLineId === id).reduce((sum, l) => sum + l.quantity, 0),
  );
  expect(loadedByLine).toEqual(want.loaded);
  // CON-4 agrees with CON-1 for every container.
  for (const c of listed as { id: string }[]) {
    const d = await get(`/containers/${c.id}`);
    expect(d.status).toBe(200);
    const { lines, portOfLoading, portOfArrival, ...rest } = d.body;
    expect(lines.length).toBeGreaterThan(0);
    expect(typeof portOfLoading).toBe("string");
    expect(typeof portOfArrival).toBe("string");
    expect(rest).toEqual(c1.body.find((x: { id: string }) => x.id === c.id));
    expect(rest.bundles).toBe(lines.reduce((sum: number, l: { bundles: number }) => sum + l.bundles, 0));
  }
  return { ord1, detail };
}

const state: Expected = { stage: 1, received: [0, 0], loaded: [0, 0], payments: [] };

describe("one order across all five tabs", () => {
  it("ORD-3 creates the order with two deposits", async () => {
    const options = await get("/orders/options");
    expect(options.body.nextPo).toBe("PO-2050");
    const res = await post(
      "/orders",
      {
        supplierId: ids.supplier,
        orderDate: indiaDay(-10),
        deliveryDate: indiaDay(15),
        lines: [
          { itemId: ids.pants, quantity: 60, rateCny: 5.5 },
          { itemId: ids.fabric, quantity: 50, rateCny: 4.25 },
        ],
        deposits: DEPOSITS,
      },
      boss,
    );
    expect(res.status).toBe(201);
    order.id = res.body.order.id;
    order.po = res.body.order.po;
    expect(order.po).toBe("PO-2050");
    const detail = await get(`/orders/${order.po}`);
    order.lines = detail.body.lines.map((l: { id: string }) => l.id);
    state.payments = DEPOSITS.map((d) => ({ amountCny: d.amountCny, rateInr: d.rateInr, kind: "Deposit" }));
    await expectConsistent(state);
  });

  it("PAY-2 records a balance payment to the agent", async () => {
    const bad = await post("/payments", { orderId: order.id, kind: "Balance", payeeRole: "agent", agentId: null, amountCny: 20.2, paidOn: indiaDay(-1), rateInr: 11.5, mode: "UPI" }, accounts);
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields.agentId).toBeDefined();
    const res = await post("/payments", { orderId: order.id, kind: "Balance", payeeRole: "agent", agentId: ids.sino, amountCny: 20.2, paidOn: indiaDay(-1), rateInr: 11.5, mode: " UPI " }, accounts);
    expect(res.status).toBe(201);
    state.payments.push({ amountCny: 20.2, rateInr: 11.5, kind: "Balance" });
    const { detail } = await expectConsistent(state);
    const added = detail.payments.find((p: { id: string }) => p.id === res.body.payment.id);
    expect(added).toMatchObject({ kind: "Balance", payee: "Sino Freight", payeeRole: "agent", mode: "UPI", status: "paid", dueDate: null, rateInr: 11.5 });
    const supplierPay = await post("/payments", { orderId: order.id, kind: "Balance", payeeRole: "supplier", agentId: null, amountCny: 0.01, paidOn: indiaDay(0), rateInr: 0.0001, mode: "x" }, accounts);
    expect(supplierPay.status).toBe(201);
    state.payments.push({ amountCny: 0.01, rateInr: 0.0001, kind: "Balance" });
    const { detail: d2 } = await expectConsistent(state);
    expect(d2.payments.find((p: { id: string }) => p.id === supplierPay.body.payment.id).payee).toBe("Guangzhou Textile Co.");
  });

  it("REC-3: a short receipt needs a remark, then is saved and moves the order 1 -> 2", async () => {
    const body = { orderId: order.id, receivedOn: indiaDay(-3), locationId: ids.office, bundles: 4, deliveryNote: "DN-1", shortRemark: "", lines: [{ orderLineId: order.lines[0], quantity: 40 }] };
    const noRemark = await post("/receipts", body);
    expect(noRemark.status).toBe(422);
    expect(noRemark.body.error.fields.shortRemark).toBeDefined();
    await expectConsistent(state); // nothing written, still stage 1
    const res = await post("/receipts", { ...body, shortRemark: "20 pants missing" });
    expect(res.status).toBe(201);
    state.stage = 2;
    state.received = [40, 0];
    const { detail } = await expectConsistent(state);
    expect(detail.receipts[0]).toMatchObject({ bundles: 4, deliveryNote: "DN-1", shortRemark: "20 pants missing", office: "Guangzhou office", receivedBy: "Wang Fang" });
    expect(detail.receipts[0].lines).toEqual([{ orderLineId: order.lines[0], item: "Track pants", unit: "pcs", quantity: 40 }]);
  });

  it("REC-3 concurrency: two receipts that together over-receive cannot both succeed", async () => {
    const make = (quantity: number) => ({ orderId: order.id, receivedOn: indiaDay(-2), locationId: ids.office, bundles: 1, deliveryNote: "", shortRemark: "still short", lines: [{ orderLineId: order.lines[0], quantity }] });
    const results = await Promise.all([post("/receipts", make(15)), post("/receipts", make(15)), post("/receipts", make(15))]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 422, 422]); // 40 + 15 = 55; a second 15 would be 70 > 60
    state.received = [55, 0];
    await expectConsistent(state);
  });

  it("REC-3: the completing receipt needs no remark and leaves the order at stage 2", async () => {
    const res = await post("/receipts", {
      orderId: order.id,
      receivedOn: indiaDay(-1),
      locationId: ids.office,
      bundles: 6,
      deliveryNote: "",
      shortRemark: "",
      lines: [
        { orderLineId: order.lines[0], quantity: 5 },
        { orderLineId: order.lines[1], quantity: 50 },
      ],
    });
    expect(res.status).toBe(201);
    state.received = [60, 50];
    await expectConsistent(state); // REC-2 no longer lists it; CON-2 does
    const more = await post("/receipts", { orderId: order.id, receivedOn: indiaDay(-1), locationId: ids.office, bundles: 0, deliveryNote: "", shortRemark: "", lines: [{ orderLineId: order.lines[1], quantity: 1 }] });
    expect(more.status).toBe(422);
  });

  it("CON-3 concurrency: two containers loading the same stock, exactly one wins; stage 2 -> 3", async () => {
    const make = (number: string) => ({
      number,
      shippingAgentId: ids.sino,
      terms: "FOB",
      portOfLoading: "Nansha",
      portOfArrival: "Kochi",
      loadedOn: indiaDay(-1),
      sailedOn: null,
      eta: indiaDay(25),
      lines: [
        { orderLineId: order.lines[0], bundles: 3, quantity: 40 },
        { orderLineId: order.lines[1], bundles: 2, quantity: 30 },
      ],
    });
    const [a, b] = await Promise.all([post("/containers", make("MSCU1000001")), post("/containers", make("MSCU1000002"))]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const winner = a.status === 201 ? a : b;
    containerIds.push(winner.body.container.id);
    winnerNumber = a.status === 201 ? "MSCU1000001" : "MSCU1000002";
    state.stage = 3;
    state.loaded = [40, 30];
    const { detail } = await expectConsistent(state);
    expect(detail.containers).toHaveLength(1);
    expect(detail.containers[0]).toMatchObject({ status: "loading", terms: "FOB", sailedOn: null });
    // Receiving is closed at stage 3.
    const closed = await post("/receipts", { orderId: order.id, receivedOn: indiaDay(0), locationId: ids.office, bundles: 0, deliveryNote: "", shortRemark: "", lines: [{ orderLineId: order.lines[0], quantity: 1 }] });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("order_not_receivable");
  });

  it("CON-3: duplicate numbers (any case) are refused, the rest loads on a second container", async () => {
    const dup = await post("/containers", { number: winnerNumber.toLowerCase(), shippingAgentId: ids.sino, terms: "CNF", portOfLoading: "", portOfArrival: "", loadedOn: indiaDay(0), sailedOn: null, eta: indiaDay(20), lines: [{ orderLineId: order.lines[0], bundles: 1, quantity: 20 }] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("container_exists");
    const rest = await post("/containers", { number: "MSCU1000003", shippingAgentId: ids.sino, terms: "CNF", portOfLoading: "Nansha", portOfArrival: "Kochi", loadedOn: indiaDay(0), sailedOn: indiaDay(0), eta: indiaDay(20), lines: [{ orderLineId: order.lines[0], bundles: 1, quantity: 20 }, { orderLineId: order.lines[1], bundles: 1, quantity: 20 }] });
    expect(rest.status).toBe(201);
    containerIds.push(rest.body.container.id);
    state.loaded = [60, 50];
    const { detail } = await expectConsistent(state); // CON-2 lists nothing for this order
    expect(detail.containers).toHaveLength(2);
    const over = await post("/containers", { number: "MSCU1000004", shippingAgentId: ids.sino, terms: "FOB", portOfLoading: "", portOfArrival: "", loadedOn: indiaDay(0), sailedOn: null, eta: indiaDay(20), lines: [{ orderLineId: order.lines[0], bundles: 1, quantity: 1 }] });
    expect(over.status).toBe(422);
    // Both containers hold only part of the order's lines, so both are `part`.
    const list = await get("/containers");
    for (const id of containerIds) expect(list.body.find((c: { id: string }) => c.id === id).orders).toEqual([{ po: order.po, part: true }]);
  });

  it("CON-5 concurrency: two simultaneous sea moves, exactly one 200; stages untouched", async () => {
    const id = containerIds[0]!;
    const skip = await patch(`/containers/${id}`, { status: "arrived" });
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe("invalid_status_change");
    const noDate = await patch(`/containers/${id}`, { status: "sea" });
    expect(noDate.status).toBe(422);
    expect(noDate.body.error.fields.sailedOn).toBeDefined();
    const results = await Promise.all([patch(`/containers/${id}`, { status: "sea", sailedOn: indiaDay(-1) }), patch(`/containers/${id}`, { status: "sea", sailedOn: indiaDay(-1) })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe("invalid_status_change");
    expect((await expectConsistent(state)).detail.containers.find((c: { id: string }) => c.id === id).status).toBe("sea");
  });

  it("CON-5 concurrency: two simultaneous arrived moves, exactly one 200; then it is frozen", async () => {
    const id = containerIds[0]!;
    const results = await Promise.all([patch(`/containers/${id}`, { status: "arrived" }), patch(`/containers/${id}`, { status: "arrived" })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const { detail } = await expectConsistent(state);
    expect(detail.containers.find((c: { id: string }) => c.id === id)).toMatchObject({ status: "arrived", sailedOn: indiaDay(-1) });
    const frozen = await patch(`/containers/${id}`, { eta: indiaDay(30) });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.code).toBe("container_arrived");
    expect(detail.stage).toBe(3); // CON-5 never changes order stages
    // The other container (planned ETD saved at loading) still moves loading -> sea -> arrived in order.
    const other = containerIds[1]!;
    expect((await patch(`/containers/${other}`, { status: "sea" })).status).toBe(200);
    expect((await patch(`/containers/${other}`, { status: "arrived" })).status).toBe(200);
    const final = await expectConsistent(state);
    expect(final.detail.containers.map((c: { status: string }) => c.status)).toEqual(["arrived", "arrived"]);
    expect((await ctx.db.select({ stage: orders.stage }).from(orders).where(eq(orders.id, order.id)))[0]!.stage).toBe(3);
  });
});

describe("access, validation and error handling", () => {
  it("ORD-4 hides sections the role can't view and 404s bad ids", async () => {
    const acc = await get(`/orders/${order.po}`, accounts); // payments Enter; receiving, containers None
    expect(acc.status).toBe(200);
    expect(acc.body.payments).toHaveLength(4);
    expect(acc.body.receipts).toBeNull();
    expect(acc.body.containers).toBeNull();
    const proc = await get(`/orders/${order.po}`, procurement); // payments View, receiving View, containers None
    expect(proc.body.payments).toHaveLength(4);
    expect(proc.body.receipts).toHaveLength(3);
    expect(proc.body.containers).toBeNull();
    expect((await get(`/orders/${order.po}`, wang)).status).toBe(403); // staff have no Orders access, so never reach ORD-4
    for (const bad of ["po-2050", "PO-", "PO-2050x", "PO-99999999999999999999999", "2050", encodeURIComponent("PO-1 OR 1=1")]) {
      const res = await get(`/orders/${bad}`);
      expect(res.status, bad).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
    for (const bad of ["not-a-uuid", UNKNOWN, "1", encodeURIComponent("' or 1=1 --")]) {
      expect((await get(`/containers/${bad}`)).status, bad).toBe(404);
      expect((await patch(`/containers/${bad}`, { eta: indiaDay(3) })).status, bad).toBe(404);
    }
  });

  it("permissions on each endpoint", async () => {
    expect((await get("/deliveries", accounts)).status).toBe(403);
    expect((await get("/payments", wang)).status).toBe(403);
    expect((await get("/orders", wang)).status).toBe(403);
    expect((await post("/payments", {}, procurement)).status).toBe(403);
    expect((await post("/orders", {}, accounts)).status).toBe(403);
    expect((await post("/receipts", {}, accounts)).status).toBe(403);
    expect((await patch(`/containers/${containerIds[0]}`, { eta: indiaDay(1) }, procurement)).status).toBe(403);
    expect((await get(`/containers/${containerIds[0]}`, procurement)).status).toBe(403);
    expect((await supertest(ctx.app).get(`/api/v1/orders/${order.po}`)).status).toBe(401);
  });

  it("same-site check, strict bodies and date rules on the new routes", async () => {
    const agent = supertest(ctx.app);
    const noOrigin = await agent.patch(`/api/v1/containers/${containerIds[0]}`).set("Cookie", wang).send({ eta: indiaDay(1) });
    expect(noOrigin.status).toBe(403);
    const evil = await agent.post("/api/v1/payments").set("Origin", "https://evil.example").set("Cookie", accounts).send({});
    expect(evil.status).toBe(403);
    const empty = await patch(`/containers/${containerIds[1]}`, {});
    expect(empty.status).toBe(400); // body shape is checked before the container is read
  });

  it("PAY-2 validation: future date (India), unknown order, extra key", async () => {
    const base = { orderId: order.id, kind: "Deposit", payeeRole: "supplier", agentId: null, amountCny: 5, paidOn: indiaDay(0), rateInr: 11, mode: "Cash" };
    expect((await post("/payments", { ...base, paidOn: indiaDay(1) }, accounts)).body.error.fields.paidOn).toBeDefined();
    expect((await post("/payments", { ...base, orderId: UNKNOWN }, accounts)).body.error.fields.orderId).toBeDefined();
    expect((await post("/payments", { ...base, orderId: "nope" }, accounts)).status).toBe(422);
    expect((await post("/payments", { ...base, extra: 1 }, accounts)).status).toBe(400);
    expect((await post("/payments", { ...base, mode: "x".repeat(101) }, accounts)).body.error.fields.mode).toBeDefined();
    expect((await post("/payments", { ...base, amountCny: 0.004 }, accounts)).status).toBe(422);
  });

  // Was audit M1 (a burst of creates got 500s); fixed with an advisory lock around the PO number in ORD-3.
  it("ORD-3 concurrency: 12 simultaneous creates get 12 distinct PO numbers", async () => {
    const body = { supplierId: ids.supplier, orderDate: indiaDay(-1), deliveryDate: indiaDay(5), lines: [{ itemId: ids.pants, quantity: 5, rateCny: 1 }], deposits: [] };
    const results = await Promise.all(Array.from({ length: 12 }, () => post("/orders", body, boss)));
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect(new Set(results.map((r) => r.body.order.po)).size).toBe(12);
  });
});

// Defects found by this audit, written as the behaviour the contract/DB needs. `it.fails` passes while the defect exists;
// when it is fixed the test starts failing, so remove `.fails`.
describe("known defects (it.fails)", () => {
  // Was audit H1 (any integer reached the int4 bundles columns, a 500); fixed with the int4 maximum in REC-3 and CON-3.
  it("REC-3 with absurd bundles on a real order is a 422, not a 500", async () => {
    const o = await post(
      "/orders",
      { supplierId: ids.supplier, orderDate: indiaDay(-1), deliveryDate: indiaDay(5), lines: [{ itemId: ids.pants, quantity: 5, rateCny: 1 }], deposits: [] },
      boss,
    );
    const line = (await get(`/orders/${o.body.order.po}`)).body.lines[0].id;
    const res = await post("/receipts", { orderId: o.body.order.id, receivedOn: indiaDay(0), locationId: ids.office, bundles: 3_000_000_000, deliveryNote: "", shortRemark: "", lines: [{ orderLineId: line, quantity: 5 }] });
    expect(res.status).toBe(422);
  });

  // orders.routes.ts:45 validates deposit paidOn only as a date, while PAY-2 rejects a future paidOn (payments.routes.ts:39).
  it.fails("ORD-3 rejects a deposit dated after today in India, like PAY-2", async () => {
    const res = await post(
      "/orders",
      {
        supplierId: ids.supplier,
        orderDate: indiaDay(0),
        deliveryDate: indiaDay(5),
        lines: [{ itemId: ids.pants, quantity: 5, rateCny: 1 }],
        deposits: [{ payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 1, paidOn: indiaDay(30), rateInr: 11, mode: "Cash" }],
      },
      boss,
    );
    expect(res.status).toBe(422);
  });

  // ORD-1 `received` is the main line only: a stage-3 order whose second line is short shows no shortfall to the
  // frontend (order-status.ts uses quantity/received of the main line), although REC-3 treats it as short.
  it.fails("a stage-3 order short on a non-main line is visible as short in ORD-1", async () => {
    const o = await post(
      "/orders",
      { supplierId: ids.supplier, orderDate: indiaDay(-1), deliveryDate: indiaDay(5), lines: [{ itemId: ids.pants, quantity: 10, rateCny: 1 }, { itemId: ids.fabric, quantity: 10, rateCny: 1 }], deposits: [] },
      boss,
    );
    const d = (await get(`/orders/${o.body.order.po}`)).body;
    await post("/receipts", { orderId: o.body.order.id, receivedOn: indiaDay(0), locationId: ids.office, bundles: 1, deliveryNote: "", shortRemark: "second line short", lines: [{ orderLineId: d.lines[0].id, quantity: 10 }] });
    const c = await post("/containers", { number: "MSCU1000777", shippingAgentId: ids.sino, terms: "FOB", portOfLoading: "", portOfArrival: "", loadedOn: indiaDay(0), sailedOn: null, eta: indiaDay(20), lines: [{ orderLineId: d.lines[0].id, bundles: 1, quantity: 10 }] });
    expect(c.status).toBe(201);
    const row = (await get("/orders")).body.find((r: { id: string }) => r.id === o.body.order.id);
    expect(row.stage).toBe(3);
    expect(row.received).toBeLessThan(row.quantity); // false today: main line is complete, line 2 (0 of 10) is invisible
  });
});
