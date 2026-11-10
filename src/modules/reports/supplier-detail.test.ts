import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Currency, items, orders, payments, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf, indiaDay, makeOrder } from "../stock/fixtures";

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

const path = (id: string, query = "") => `/reports/payments-per-supplier/${id}${query && `?${query}`}`;
let management = "";
const get = async (url: string) => {
  const res = await http.get(url).set("Cookie", management);
  expect(res.status, `${url}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
};

// Foshan Fabrics:
// CNY  ordered 30 days ago, stage 3: 100 Track pants at ¥2.50 (main line) + 500 m Cotton fabric at ¥8 = ¥4,250.
//      Paid to the supplier: deposit ¥1,000 at 12, balance ¥500 at 12.5 (₹18,250); ¥2,750 due in 10 days.
//      ¥100 paid to the agent: sea freight, never counted or listed.
// USD  ordered 10 days ago, stage 6: 100 Track pants at $2 = $200. Deposit $50 at 88 (₹4,400); $30 due in 5 days.
// Guangzhou Textile Co. has a CNY order of its own, which never shows here.
describe("GET /reports/payments-per-supplier/:supplierId", () => {
  let foshan = "";
  let cny: Awaited<ReturnType<typeof makeOrder>>;
  let usd: Awaited<ReturnType<typeof makeOrder>>;
  beforeAll(async () => {
    await resetData(ctx);
    management = await signInAs(ctx, SEEDED.management);
    foshan = await idOf(ctx, suppliers, "Foshan Fabrics");
    cny = await makeOrder(ctx, {
      supplier: "Foshan Fabrics",
      stage: 3,
      lines: [
        { item: "Track pants", quantity: 100, rateCny: 2.5 },
        { item: "Cotton fabric", quantity: 500, rateCny: 8 },
      ],
    });
    usd = await makeOrder(ctx, { supplier: "Foshan Fabrics", stage: 6, lines: [{ item: "Track pants", quantity: 100, rateCny: 2 }] });
    await ctx.db.update(orders).set({ currency: "USD", orderDate: indiaDay(-10) }).where(eq(orders.id, usd.id));
    const other = await makeOrder(ctx, { lines: [{ item: "Polo shirts", quantity: 10, rateCny: 30 }] });
    const toFoshan = { payee: "Foshan Fabrics", payeeRole: "supplier" } as const;
    await ctx.db.insert(payments).values([
      { ...toFoshan, orderId: cny.id, kind: "Deposit", amountCny: 1000, rateInr: 12, status: "paid", mode: "Bank", paidOn: indiaDay(-28) },
      { ...toFoshan, orderId: cny.id, kind: "Balance", amountCny: 500, rateInr: 12.5, status: "paid", mode: "Bank", paidOn: indiaDay(-15) },
      { ...toFoshan, orderId: cny.id, kind: "Balance", amountCny: 2750, status: "due", dueDate: indiaDay(10) },
      { orderId: cny.id, kind: "Deposit", payee: "Sino Freight", payeeRole: "agent", amountCny: 100, rateInr: 12, status: "paid", mode: "Bank", paidOn: indiaDay(-20) },
      { ...toFoshan, orderId: usd.id, kind: "Deposit", amountCny: 50, rateInr: 88, status: "paid", mode: "Wire", paidOn: indiaDay(-5) },
      { ...toFoshan, orderId: usd.id, kind: "Balance", amountCny: 30, status: "due", dueDate: indiaDay(5) },
      { orderId: other.id, kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 100, rateInr: 12, status: "paid", mode: "Bank", paidOn: indiaDay(-1) },
    ]);
  });

  it("is 401 signed out and 403 without reports access", async () => {
    expect((await http.get(path(foshan))).status).toBe(401);
    for (const user of [SEEDED.procurement, SEEDED.accounts]) {
      expect((await http.get(path(foshan)).set("Cookie", await signInAs(ctx, user))).status, user).toBe(403);
    }
  });

  it("is 404 for a malformed or unknown supplier id", async () => {
    for (const id of ["abc", "00000000-0000-4000-8000-000000000000"]) {
      const res = await http.get(path(id)).set("Cookie", management);
      expect(res.status, id).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
  });

  it("is 400 for a bad query", async () => {
    const bad = [
      "foo=1",
      "from=2026-13-01",
      "from=2026-10-02&to=2026-10-01",
      "paymentFrom=2026-10-02&paymentTo=2026-10-01",
      "stage=0",
      "stage=7",
      "stage=1&stage=2",
      "paymentsPage=0",
      "ordersPage=1.5",
      "linesPage=abc",
      "linesPage=",
    ];
    for (const query of bad) {
      const res = await http.get(path(foshan, query)).set("Cookie", management);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
  });

  it("gives the summary per currency and the newest row of each list", async () => {
    const body = await get(path(foshan));
    expect(body.supplier).toMatchObject({ id: foshan, name: "Foshan Fabrics", status: "Active" });
    expect(body.filter).toEqual({ from: null, to: null });
    expect(body.summary).toEqual({
      orders: 2,
      // Open = not closed: the stage-6 fixture has no stocked receipt, so it is still open (docs/phase2-contracts.md 1).
      openOrders: 2,
      payments: 5,
      lineItems: 3,
      products: 2,
      byCurrency: [
        { currency: "CNY", orders: 1, orderValueCny: 4250, paidCny: 1500, paidInr: 18250, depositsCny: 1000, balanceCny: 2750 },
        { currency: "USD", orders: 1, orderValueCny: 200, paidCny: 50, paidInr: 4400, depositsCny: 50, balanceCny: 150 },
      ],
    });

    expect(body.payments).toMatchObject({ total: 5, page: 1, pageSize: 10 });
    expect(body.payments.rows.map((row: { amountCny: number }) => row.amountCny)).toEqual([2750, 30, 50, 500, 1000]);
    expect(body.payments.rows[0]).toEqual({
      id: expect.any(String),
      orderId: cny.id,
      po: cny.po,
      currency: "CNY",
      kind: "Balance",
      status: "due",
      paidOn: null,
      dueDate: indiaDay(10),
      amountCny: 2750,
      rateInr: null,
      amountInr: null,
      mode: null,
    });
    expect(body.payments.rows[2]).toMatchObject({ orderId: usd.id, currency: "USD", status: "paid", paidOn: indiaDay(-5), rateInr: 88, amountInr: 4400, mode: "Wire" });

    expect(body.orders).toMatchObject({ total: 2, page: 1, pageSize: 10 });
    expect(body.orders.rows[0]).toEqual({
      id: usd.id,
      po: usd.po,
      orderDate: indiaDay(-10),
      deliveryDate: indiaDay(10),
      stage: 6,
      currency: "USD",
      quantities: [{ unit: "pcs", quantity: 100 }],
      quantity: 100,
      received: 0,
      unit: "pcs",
      orderValueCny: 200,
      paidCny: 50,
      balanceCny: 150,
    });
    expect(body.orders.rows[1]).toMatchObject({
      id: cny.id,
      quantities: [
        { unit: "pcs", quantity: 100 },
        { unit: "m", quantity: 500 },
      ],
      paidCny: 1500,
    });

    expect(body.lines).toMatchObject({ total: 3, page: 1, pageSize: 10 });
    expect(body.lines.rows.map((row: { orderLineId: string }) => row.orderLineId)).toEqual([usd.lineIds[0], ...cny.lineIds]);
    expect(body.lines.rows[2]).toEqual({
      orderLineId: cny.lineIds[1],
      orderId: cny.id,
      po: cny.po,
      itemId: await idOf(ctx, items, "Cotton fabric"),
      item: "Cotton fabric",
      unit: "m",
      quantity: 500,
      rateCny: 8,
      amountCny: 4000,
      currency: "CNY",
    });
  });

  it("filters the lists, never the summary; a page past the end is empty with the real total", async () => {
    const all = await get(path(foshan));
    const body = await get(path(foshan, `paymentFrom=${indiaDay(-20)}&paymentTo=${indiaDay(0)}&stage=6&linesPage=2`));
    expect(body.summary).toEqual(all.summary);
    expect(body.payments.rows.map((row: { amountCny: number }) => row.amountCny)).toEqual([50, 500]);
    expect(body.payments.total).toBe(2);
    expect(body.orders).toMatchObject({ total: 1, rows: [{ id: usd.id }] });
    expect(body.lines).toEqual({ rows: [], total: 3, page: 2, pageSize: 10 });
    const before = await get(path(foshan, `to=${indiaDay(-11)}`));
    expect(before.summary).toMatchObject({ orders: 1, payments: 3, byCurrency: [{ currency: "CNY", orderValueCny: 4250 }] });
    expect(before.filter).toEqual({ from: null, to: indiaDay(-11) });
  });

  it("is 200 with zeros and empty lists for a supplier without orders", async () => {
    const shenzhen = await idOf(ctx, suppliers, "Shenzhen Apparel");
    const empty = { rows: [], total: 0, page: 1, pageSize: 10 };
    expect(await get(path(shenzhen))).toMatchObject({
      supplier: { id: shenzhen, name: "Shenzhen Apparel" },
      summary: { orders: 0, openOrders: 0, payments: 0, lineItems: 0, products: 0, byCurrency: [] },
      payments: empty,
      orders: empty,
      lines: empty,
    });
  });
});

// A larger data set for the owner's checks (docs/supplier-payment-detail-contract.md). Yiwu Trims Ltd. (given an
// address, USD as its currency and Inactive) has 12 orders at every stage in CNY, USD and INR, 14 lines, 17 supplier
// payments and one agent payment:
//  #    cur stage ordered lines                                          supplier payments (days from today)
//  1    CNY 1    -60      100 Track pants ¥2.50 + 200 m Cotton ¥8 = 1,850 deposit 500 @12 (-58), balance 1,000 @12.5 (-30), 350 due (+5)
//  2    CNY 2    -55      10 m Cotton ¥6 (main) + 20 Track pants ¥3 = 120 deposit 100 @12 (-50), balance 50 @12 (-20): overpaid by 30
//  3    USD 3    -50      7 Denim jeans at $17.8575 = 125.0025, so $125  deposits 10.01 @12.345 (-45, -44): ₹123.57 each; 104.98 due (+10)
//  4    INR 4    -45      5 Polo shirts at ₹300 = 1,500                  deposit 1,000 @1 (-40); ₹200 to the agent, never counted
//  5    CNY 6    -40      20 Kids t-shirts ¥4 = 80                       balance 80 @12 (-35)
//  6-12 CNY, USD alternating, stages 1 2 3 4 5 1 2, ordered -35 -35 -25 -20 -15 -10 -5: 10 Men's shorts at 1 = 10, each with a
//       deposit of 1 @12 paid on day -32 (one insert: the same day and created_at, so the id breaks the tie)
// Hangzhou Knits: CNY stage 1 (-30) 50 Track pants ¥2 = 100, paid 40 @12 (-32), 60 due (+5), agent 10 @12 (-32); USD stage 3
// (-12) 10 Kids t-shirts $1.50 = 15, paid 5 @88 (-10). Shenzhen Apparel: CNY stage 2 (-20) 10 Men's jackets ¥50 = 500, no
// payments. Guangzhou Textile Co.: nothing.
type PaymentRow = { id: string; orderId: string; currency: Currency; status: string; paidOn: string | null; dueDate: string | null; amountCny: number; amountInr: number | null };
type OrderRow = { id: string; po: string; stage: number; currency: Currency; orderValueCny: number; paidCny: number; balanceCny: number };
type LineRow = { orderLineId: string; orderId: string; po: string; itemId: string; item: string; unit: string; quantity: number; rateCny: number; amountCny: number; currency: Currency };
const LIST_PAGE = { payments: "paymentsPage", orders: "ordersPage", lines: "linesPage" } as const;
const round2 = (value: number) => Math.round(value * 100) / 100;
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

/** Every row of one list, page by page, checking each page's size against the total until the empty page past the end. */
async function everyRow<T>(supplierId: string, list: keyof typeof LIST_PAGE, query = "") {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const body = await get(path(supplierId, [query, `${LIST_PAGE[list]}=${page}`].filter(Boolean).join("&")));
    const { rows: part, total } = body[list] as { rows: T[]; total: number };
    expect(body[list], `${list} page ${page}`).toMatchObject({ page, pageSize: 10 });
    expect(part, `${list} page ${page}`).toHaveLength(Math.min(10, Math.max(0, total - (page - 1) * 10)));
    if (part.length === 0) {
      expect(rows).toHaveLength(total);
      return rows;
    }
    rows.push(...part);
  }
}

describe("GET /reports/payments-per-supplier/:supplierId on a larger data set", () => {
  type Made = Awaited<ReturnType<typeof makeOrder>>;
  let yiwu = "";
  let y: Made[] = []; // y[0] is order 1 of the table
  let others: { hangzhou: Made[]; shenzhen: Made };
  let yiwuPayments: string[] = []; // Yiwu's supplier payments
  let foreignPayments: string[] = []; // every other payment: Hangzhou's and the agents'
  const ADDRESS = "No. 8 Futian Market, Yiwu";

  const order = async (supplier: string, currency: Currency, stage: number, daysAgo: number, lines: { item: string; quantity: number; rateCny: number }[]) => {
    const made = await makeOrder(ctx, { supplier, stage, lines });
    await ctx.db.update(orders).set({ currency, orderDate: indiaDay(-daysAgo) }).where(eq(orders.id, made.id));
    return made;
  };
  const paid = (orderId: string, kind: "Deposit" | "Balance", amountCny: number, rateInr: number, day: number, payee = "Yiwu Trims Ltd.") =>
    ({ orderId, kind, payee, payeeRole: "supplier", amountCny, rateInr, status: "paid", mode: "Bank", paidOn: indiaDay(day) }) as const;
  const due = (orderId: string, amountCny: number, day: number, payee = "Yiwu Trims Ltd.") =>
    ({ orderId, kind: "Balance", payee, payeeRole: "supplier", amountCny, status: "due", dueDate: indiaDay(day) }) as const;
  const toAgent = (orderId: string, amountCny: number, rateInr: number, day: number) =>
    ({ ...paid(orderId, "Deposit", amountCny, rateInr, day, "Sino Freight"), payeeRole: "agent" }) as const;

  beforeAll(async () => {
    await resetData(ctx);
    management = await signInAs(ctx, SEEDED.management);
    yiwu = await idOf(ctx, suppliers, "Yiwu Trims Ltd.");
    await ctx.db.update(suppliers).set({ address: ADDRESS, currency: "USD", status: "Inactive" }).where(eq(suppliers.id, yiwu));
    const Y = "Yiwu Trims Ltd.";
    y = [
      await order(Y, "CNY", 1, 60, [
        { item: "Track pants", quantity: 100, rateCny: 2.5 },
        { item: "Cotton fabric", quantity: 200, rateCny: 8 },
      ]),
      await order(Y, "CNY", 2, 55, [
        { item: "Cotton fabric", quantity: 10, rateCny: 6 },
        { item: "Track pants", quantity: 20, rateCny: 3 },
      ]),
      await order(Y, "USD", 3, 50, [{ item: "Denim jeans", quantity: 7, rateCny: 17.8575 }]),
      await order(Y, "INR", 4, 45, [{ item: "Polo shirts", quantity: 5, rateCny: 300 }]),
      await order(Y, "CNY", 6, 40, [{ item: "Kids t-shirts", quantity: 20, rateCny: 4 }]),
    ];
    const small = [
      [1, 35],
      [2, 35],
      [3, 25],
      [4, 20],
      [5, 15],
      [1, 10],
      [2, 5],
    ] as const;
    for (const [index, [stage, daysAgo]] of small.entries()) {
      y.push(await order(Y, index % 2 ? "USD" : "CNY", stage, daysAgo, [{ item: "Men's shorts", quantity: 10, rateCny: 1 }]));
    }
    others = {
      hangzhou: [
        await order("Hangzhou Knits", "CNY", 1, 30, [{ item: "Track pants", quantity: 50, rateCny: 2 }]),
        await order("Hangzhou Knits", "USD", 3, 12, [{ item: "Kids t-shirts", quantity: 10, rateCny: 1.5 }]),
      ],
      shenzhen: await order("Shenzhen Apparel", "CNY", 2, 20, [{ item: "Men's jackets", quantity: 10, rateCny: 50 }]),
    };
    const [o1, o2, o3, o4, o5] = y.map((made) => made.id) as [string, string, string, string, string];
    const [h1, h2] = others.hangzhou.map((made) => made.id) as [string, string];
    const inserted = await ctx.db
      .insert(payments)
      .values([
        paid(o1, "Deposit", 500, 12, -58),
        paid(o1, "Balance", 1000, 12.5, -30),
        due(o1, 350, 5),
        paid(o2, "Deposit", 100, 12, -50),
        paid(o2, "Balance", 50, 12, -20),
        paid(o3, "Deposit", 10.01, 12.345, -45),
        paid(o3, "Deposit", 10.01, 12.345, -44),
        due(o3, 104.98, 10),
        { ...paid(o4, "Deposit", 1000, 1, -40), mode: "Cash" },
        toAgent(o4, 200, 1, -40),
        paid(o5, "Balance", 80, 12, -35),
        ...y.slice(5).map((made) => paid(made.id, "Deposit", 1, 12, -32)),
        paid(h1, "Deposit", 40, 12, -32, "Hangzhou Knits"),
        due(h1, 60, 5, "Hangzhou Knits"),
        toAgent(h1, 10, 12, -32),
        paid(h2, "Deposit", 5, 88, -10, "Hangzhou Knits"),
      ])
      .returning({ id: payments.id, payee: payments.payee, payeeRole: payments.payeeRole });
    const isYiwus = (row: (typeof inserted)[number]) => row.payee === Y && row.payeeRole === "supplier";
    yiwuPayments = ids(inserted.filter(isYiwus));
    foreignPayments = ids(inserted.filter((row) => !isYiwus(row)));
    expect([yiwuPayments.length, foreignPayments.length]).toEqual([17, 5]);
  });

  it("2: gives every field of the supplier and echoes the period", async () => {
    const body = await get(path(yiwu, `from=${indiaDay(-100)}&to=${indiaDay(0)}`));
    expect(body.supplier).toEqual({
      id: yiwu,
      code: "SUP-004",
      name: "Yiwu Trims Ltd.",
      contactPerson: "Ms. Wu Mei",
      phone: "+86 135 5799 3120",
      email: "",
      country: "China",
      city: "Yiwu",
      state: "",
      postalCode: "",
      address: ADDRESS,
      paymentTerms: "",
      taxNumber: "",
      notes: "",
      currency: "USD",
      status: "Inactive",
    });
    expect(body.filter).toEqual({ from: indiaDay(-100), to: indiaDay(0) });
    expect((await get(path(yiwu, `from=${indiaDay(-100)}`))).filter).toEqual({ from: indiaDay(-100), to: null });
  });

  it("3: lists only the supplier's own supplier payments, on every page; agent payments and other suppliers' never", async () => {
    const rows = await everyRow<PaymentRow>(yiwu, "payments");
    expect(ids(rows).sort()).toEqual([...yiwuPayments].sort());
    for (const id of foreignPayments) expect(ids(rows)).not.toContain(id);
    expect(new Set(rows.map((row) => row.orderId))).toEqual(new Set(ids(y)));
    // Hangzhou's own detail: its supplier payments (paid and due), none of Yiwu's, not its agent payment.
    const hangzhou = await everyRow<PaymentRow>(await idOf(ctx, suppliers, "Hangzhou Knits"), "payments");
    expect(hangzhou.map((row) => row.amountCny)).toEqual([60, 5, 40]);
    for (const id of ids(hangzhou)) expect(yiwuPayments).not.toContain(id);
  });

  it("4: lists only the supplier's orders, on every page, with and without the stage filter", async () => {
    const all = await everyRow<OrderRow>(yiwu, "orders");
    // Newest first: order date desc, then PO desc (orders 6 and 7 share a day).
    const newestFirst = [y[11]!, y[10]!, y[9]!, y[8]!, y[7]!, y[6]!, y[5]!, y[4]!, y[3]!, y[2]!, y[1]!, y[0]!];
    expect(ids(all)).toEqual(ids(newestFirst));
    const atStage: Record<number, Made[]> = { 1: [y[0]!, y[5]!, y[10]!], 2: [y[1]!, y[6]!, y[11]!], 3: [y[2]!, y[7]!], 4: [y[3]!, y[8]!], 5: [y[9]!], 6: [y[4]!] };
    for (const [stage, expected] of Object.entries(atStage)) {
      const rows = await everyRow<OrderRow>(yiwu, "orders", `stage=${stage}`);
      expect(ids(rows).sort(), `stage ${stage}`).toEqual(ids(expected).sort());
      expect(rows.every((row) => row.stage === Number(stage))).toBe(true);
    }
  });

  it("5: lists every order line apart, with its own PO, quantity, rate and amount; never another supplier's", async () => {
    const lines = await everyRow<LineRow>(yiwu, "lines");
    // Order date desc, PO desc, line position asc.
    const newestFirst = [y[11]!, y[10]!, y[9]!, y[8]!, y[7]!, y[6]!, y[5]!, y[4]!, y[3]!, y[2]!, y[1]!, y[0]!];
    expect(lines.map((line) => line.orderLineId)).toEqual(newestFirst.flatMap((made) => made.lineIds));
    const foreignLines = [...others.hangzhou, others.shenzhen].flatMap((made) => made.lineIds);
    for (const line of lines) {
      expect(foreignLines).not.toContain(line.orderLineId);
      expect(line.amountCny, line.orderLineId).toBe(round2(line.quantity * line.rateCny));
    }
    const trackPants = lines.filter((line) => line.item === "Track pants");
    expect(new Set(trackPants.map((line) => line.itemId)).size).toBe(1);
    expect(trackPants.map(({ orderId, po, quantity, rateCny, amountCny, unit, currency }) => ({ orderId, po, quantity, rateCny, amountCny, unit, currency }))).toEqual([
      { orderId: y[1]!.id, po: y[1]!.po, quantity: 20, rateCny: 3, amountCny: 60, unit: "pcs", currency: "CNY" },
      { orderId: y[0]!.id, po: y[0]!.po, quantity: 100, rateCny: 2.5, amountCny: 250, unit: "pcs", currency: "CNY" },
    ]);
    expect(lines.find((line) => line.orderId === y[2]!.id)).toMatchObject({ item: "Denim jeans", quantity: 7, rateCny: 17.8575, amountCny: 125, currency: "USD" });
    expect(lines.find((line) => line.item === "Cotton fabric" && line.orderId === y[1]!.id)).toMatchObject({ unit: "m", quantity: 10, rateCny: 6 });
    expect((await get(path(yiwu))).summary).toMatchObject({ lineItems: 14, products: 6 });

    // Mixed units stay apart, pcs first; the main line (position 0) gives quantity and unit.
    const orderRows = await everyRow<OrderRow & { quantities: unknown; quantity: number; unit: string }>(yiwu, "orders");
    const of = (made: Made) => orderRows.find((row) => row.id === made.id);
    expect(of(y[0]!)).toMatchObject({ quantities: [{ unit: "pcs", quantity: 100 }, { unit: "m", quantity: 200 }], quantity: 100, unit: "pcs" });
    expect(of(y[1]!)).toMatchObject({ quantities: [{ unit: "pcs", quantity: 20 }, { unit: "m", quantity: 10 }], quantity: 10, unit: "m" });
    expect(of(y[4]!)).toMatchObject({ quantities: [{ unit: "pcs", quantity: 20 }], quantity: 20, unit: "pcs" });
  });

  it("7: totals each currency apart: deposits within paid, an overpayment below zero, INR rounded per payment", async () => {
    const { summary } = await get(path(yiwu));
    expect(summary).toEqual({
      orders: 12,
      openOrders: 12, // the stage-6 fixture has no stocked receipt, so it is not closed
      payments: 17,
      lineItems: 14,
      products: 6,
      byCurrency: [
        { currency: "CNY", orders: 7, orderValueCny: 2090, paidCny: 1734, paidInr: 21308, depositsCny: 604, balanceCny: 356 },
        // ₹123.57 + ₹123.57 + 3 x ₹12, not round(2 x 10.01 x 12.345) = ₹247.15 + ₹36.
        { currency: "USD", orders: 4, orderValueCny: 155, paidCny: 23.02, paidInr: 283.14, depositsCny: 23.02, balanceCny: 131.98 },
        { currency: "INR", orders: 1, orderValueCny: 1500, paidCny: 1000, paidInr: 1000, depositsCny: 1000, balanceCny: 500 },
      ],
    });
    const overpaid = await get(path(yiwu, `from=${indiaDay(-55)}&to=${indiaDay(-55)}`));
    expect(overpaid.summary.byCurrency).toEqual([{ currency: "CNY", orders: 1, orderValueCny: 120, paidCny: 150, paidInr: 1800, depositsCny: 100, balanceCny: -30 }]);
    expect(overpaid.orders.rows).toMatchObject([{ id: y[1]!.id, orderValueCny: 120, paidCny: 150, balanceCny: -30 }]);
    for (const row of await everyRow<OrderRow>(yiwu, "orders")) expect(row.balanceCny, row.po).toBe(round2(row.orderValueCny - row.paidCny));
    const inr = (await everyRow<PaymentRow>(yiwu, "payments")).filter((row) => row.currency === "INR");
    expect(inr).toMatchObject([{ orderId: y[3]!.id, amountCny: 1000, amountInr: 1000 }]);
  });

  it("7, 11: open orders match the report's row per currency; the report's figures are unchanged by the shared money SQL", async () => {
    const report = await get("/reports/payments-per-supplier");
    const pos = (...made: Made[]) => made.map((m) => m.po);
    const [h1, h2] = others.hangzhou as [Made, Made];
    const supplierId = expect.any(String);
    expect(report.suppliers).toEqual([
      // y[4] is a stage-6 fixture without a stocked receipt, so it is open, not finished (closure rule, docs/phase2-contracts.md 1).
      { supplierId: yiwu, supplier: "Yiwu Trims Ltd.", currency: "CNY", orders: pos(y[11]!, y[9]!, y[7]!, y[5]!, y[4]!, y[1]!, y[0]!), orderValueCny: 2090, paidCny: 1734, paidInr: 21308, balanceCny: 356 },
      { supplierId, supplier: "Shenzhen Apparel", currency: "CNY", orders: pos(others.shenzhen), orderValueCny: 500, paidCny: 0, paidInr: 0, balanceCny: 500 },
      { supplierId, supplier: "Hangzhou Knits", currency: "CNY", orders: pos(h1), orderValueCny: 100, paidCny: 40, paidInr: 480, balanceCny: 60 },
      { supplierId: yiwu, supplier: "Yiwu Trims Ltd.", currency: "USD", orders: pos(y[10]!, y[8]!, y[6]!, y[2]!), orderValueCny: 155, paidCny: 23.02, paidInr: 283.14, balanceCny: 131.98 },
      { supplierId, supplier: "Hangzhou Knits", currency: "USD", orders: pos(h2), orderValueCny: 15, paidCny: 5, paidInr: 440, balanceCny: 10 },
      { supplierId: yiwu, supplier: "Yiwu Trims Ltd.", currency: "INR", orders: pos(y[3]!), orderValueCny: 1500, paidCny: 1000, paidInr: 1000, balanceCny: 500 },
    ]);
    const cny = { orders: 9, orderValueCny: 2690, paidCny: 1774, paidInr: 21788, balanceCny: 916 };
    expect(report).toMatchObject({
      totals: cny,
      totalsByCurrency: [
        { currency: "CNY", ...cny },
        { currency: "USD", orders: 5, orderValueCny: 170, paidCny: 28.02, paidInr: 723.14, balanceCny: 141.98 },
        { currency: "INR", orders: 1, orderValueCny: 1500, paidCny: 1000, paidInr: 1000, balanceCny: 500 },
      ],
      dueNext30Cny: 410,
      dueNext30ByCurrency: [
        { currency: "CNY", amount: 410 },
        { currency: "USD", amount: 104.98 },
        { currency: "INR", amount: 0 }, // every open order currency is listed, 0 included (13.5)
      ],
      finishedPos: [],
    });

    // The detail's own rows, open orders only, give the same figures as each of the report's Yiwu rows.
    const open = await everyRow<OrderRow>(yiwu, "orders"); // none is closed: no stocked receipt in this data set
    const paymentRows = await everyRow<PaymentRow>(yiwu, "payments");
    const sum = (values: number[]) => round2(values.reduce((total, value) => total + value, 0));
    const yiwuRows = report.suppliers.filter((row: { supplierId: string }) => row.supplierId === yiwu);
    expect(yiwuRows).toHaveLength(3);
    for (const row of yiwuRows) {
      const inCurrency = open.filter((order) => order.currency === row.currency);
      const orderIds = new Set(ids(inCurrency));
      expect(
        {
          orders: inCurrency.map((order) => order.po).sort(),
          orderValueCny: sum(inCurrency.map((order) => order.orderValueCny)),
          paidCny: sum(inCurrency.map((order) => order.paidCny)),
          paidInr: sum(paymentRows.filter((p) => orderIds.has(p.orderId) && p.status === "paid").map((p) => p.amountInr ?? 0)),
          balanceCny: sum(inCurrency.map((order) => order.balanceCny)),
        },
        row.currency,
      ).toEqual({ orders: [...row.orders].sort(), orderValueCny: row.orderValueCny, paidCny: row.paidCny, paidInr: row.paidInr, balanceCny: row.balanceCny });
    }
  });

  it("8: pages of 10 in a stable, non-overlapping order; a page past the end is empty with the real total", async () => {
    const page1 = (await get(path(yiwu))).payments;
    const page2 = (await get(path(yiwu, "paymentsPage=2"))).payments;
    expect([page1.rows.length, page2.rows.length, page1.total, page2.total]).toEqual([10, 7, 17, 17]);
    const rows: PaymentRow[] = [...page1.rows, ...page2.rows];
    expect(new Set(ids(rows)).size).toBe(17);
    expect(rows.map((row) => row.amountCny)).toEqual([104.98, 350, 50, 1000, 1, 1, 1, 1, 1, 1, 1, 80, 1000, 10.01, 10.01, 100, 500]);
    // Newest payment day first; the seven deposits of day -32 share created_at, so the id orders them across the page break.
    const day = (row: PaymentRow) => row.paidOn ?? row.dueDate ?? "";
    expect(rows.map(day)).toEqual(rows.map(day).sort().reverse());
    const tied = ids(rows.filter((row) => row.paidOn === indiaDay(-32)));
    expect(tied).toHaveLength(7);
    expect(tied).toEqual([...tied].sort().reverse());
    expect(ids((await get(path(yiwu, "paymentsPage=2"))).payments.rows)).toEqual(ids(page2.rows));

    expect((await get(path(yiwu, "ordersPage=2"))).orders).toMatchObject({ total: 12, page: 2, rows: [{ id: y[1]!.id }, { id: y[0]!.id }] });
    expect((await get(path(yiwu, "linesPage=2"))).lines).toMatchObject({ total: 14, page: 2, rows: [...y[1]!.lineIds, ...y[0]!.lineIds].map((orderLineId) => ({ orderLineId })) });
    const past = await get(path(yiwu, "paymentsPage=3&ordersPage=3&linesPage=3"));
    expect([past.payments, past.orders, past.lines]).toEqual([
      { rows: [], total: 17, page: 3, pageSize: 10 },
      { rows: [], total: 12, page: 3, pageSize: 10 },
      { rows: [], total: 14, page: 3, pageSize: 10 },
    ]);
    expect((await get(path(yiwu, "paymentsPage=999999999999999"))).payments).toEqual({ rows: [], total: 17, page: 999999999999999, pageSize: 10 });
  });

  it("8: payment dates (inclusive, on the paid or due day) filter only the payments; the period scopes everything; the stage only the orders", async () => {
    const all = await get(path(yiwu));
    const amounts = async (query: string) => {
      const body = await get(path(yiwu, query));
      expect([body.summary, body.orders, body.lines], query).toEqual([all.summary, all.orders, all.lines]);
      expect(body.payments.total, query).toBe(body.payments.rows.length);
      return body.payments.rows.map((row: PaymentRow) => row.amountCny);
    };
    expect(await amounts(`paymentFrom=${indiaDay(-45)}&paymentTo=${indiaDay(-44)}`)).toEqual([10.01, 10.01]);
    expect(await amounts(`paymentFrom=${indiaDay(5)}&paymentTo=${indiaDay(5)}`)).toEqual([350]); // a due payment, by its due date
    expect(await amounts(`paymentFrom=${indiaDay(5)}`)).toEqual([104.98, 350]);
    expect(await amounts(`paymentTo=${indiaDay(-50)}`)).toEqual([100, 500]);
    expect(await amounts(`paymentFrom=${indiaDay(-29)}&paymentTo=${indiaDay(-21)}`)).toEqual([]);
    expect(await amounts(`paymentFrom=${indiaDay(-40)}&paymentTo=${indiaDay(-40)}`)).toEqual([1000]); // not the agent's ₹200 that day

    // Order date period, both days inclusive: orders 2, 3 and 4 only, in the summary and in every list.
    const period = await get(path(yiwu, `from=${indiaDay(-55)}&to=${indiaDay(-45)}`));
    const inPeriod = [y[1]!.id, y[2]!.id, y[3]!.id];
    expect(period.summary).toMatchObject({ orders: 3, openOrders: 3, payments: 6, lineItems: 4, products: 4 });
    expect(period.summary.byCurrency.map((row: { currency: string }) => row.currency)).toEqual(["CNY", "USD", "INR"]);
    expect(ids(period.orders.rows)).toEqual([y[3]!.id, y[2]!.id, y[1]!.id]);
    expect([period.payments.total, period.lines.total]).toEqual([6, 4]);
    for (const row of [...period.payments.rows, ...period.lines.rows]) expect(inPeriod).toContain(row.orderId);

    // Stage: only the orders list.
    const staged = await get(path(yiwu, "stage=3"));
    expect([staged.summary, staged.payments, staged.lines]).toEqual([all.summary, all.payments, all.lines]);
    expect(staged.orders).toMatchObject({ total: 2, rows: [{ id: y[7]!.id }, { id: y[2]!.id }] });
  });

  it("9: a supplier with orders but no payments, and one with neither, are 200 with zeros", async () => {
    const shenzhen = await get(path(await idOf(ctx, suppliers, "Shenzhen Apparel")));
    expect(shenzhen.summary).toEqual({
      orders: 1,
      openOrders: 1,
      payments: 0,
      lineItems: 1,
      products: 1,
      byCurrency: [{ currency: "CNY", orders: 1, orderValueCny: 500, paidCny: 0, paidInr: 0, depositsCny: 0, balanceCny: 500 }],
    });
    expect(shenzhen.payments).toEqual({ rows: [], total: 0, page: 1, pageSize: 10 });
    expect(shenzhen.orders.rows).toMatchObject([{ id: others.shenzhen.id, paidCny: 0, balanceCny: 500 }]);
    expect(shenzhen.lines.rows).toMatchObject([{ orderLineId: others.shenzhen.lineIds[0], item: "Men's jackets" }]);

    const empty = { rows: [], total: 0, page: 1, pageSize: 10 };
    const guangzhou = await idOf(ctx, suppliers, "Guangzhou Textile Co.");
    for (const query of ["", `from=${indiaDay(-100)}&to=${indiaDay(0)}&stage=1&paymentFrom=${indiaDay(-10)}`]) {
      expect(await get(path(guangzhou, query))).toMatchObject({
        supplier: { id: guangzhou, name: "Guangzhou Textile Co." },
        summary: { orders: 0, openOrders: 0, payments: 0, lineItems: 0, products: 0, byCurrency: [] },
        payments: empty,
        orders: empty,
        lines: empty,
      });
    }
    // Yiwu before its first order: zeros too.
    expect((await get(path(yiwu, `to=${indiaDay(-61)}`))).summary).toEqual({ orders: 0, openOrders: 0, payments: 0, lineItems: 0, products: 0, byCurrency: [] });
  });

  it("10: 401 signed out, 403 for every role without Reports, 404 for malformed and unknown ids, with nothing leaked", async () => {
    const signedOut = await http.get(path(yiwu));
    expect(signedOut.status).toBe(401);
    expect(signedOut.body).toEqual({ error: { code: "unauthenticated", message: "Please sign in." } });

    const unknown = "6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f";
    const forbidden = { error: { code: "forbidden", message: "You don't have access to do that." } };
    for (const [role, email] of Object.entries(SEEDED).filter(([role]) => role !== "management")) {
      const cookie = await signInAs(ctx, email);
      // The same 403 for a real, an unknown and a malformed id: nothing says whether the supplier exists.
      for (const id of [yiwu, unknown, "abc"]) {
        const res = await http.get(path(id)).set("Cookie", cookie);
        expect(res.status, `${role} ${id}`).toBe(403);
        expect(res.body).toEqual(forbidden);
      }
    }

    for (const id of ["abc", "123", "00000000-0000-0000-0000-00000000000g", "1' or '1'='1", unknown, yiwu.slice(0, -1)]) {
      const res = await http.get(path(encodeURIComponent(id))).set("Cookie", management);
      expect(res.status, id).toBe(404);
      expect(res.body, id).toEqual({ error: { code: "not_found", message: "Supplier not found." } });
    }
    const bad = await http.get(path(yiwu, "stage=9")).set("Cookie", management);
    expect([bad.status, bad.body]).toEqual([400, { error: { code: "bad_request", message: "Something went wrong." } }]);
  });
});
