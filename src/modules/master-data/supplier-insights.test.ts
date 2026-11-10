import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { containerLines, containers, orders, payments, shippingAgents, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf, indiaDay, makeOrder, receive } from "../stock/fixtures";

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
const get = async (url: string, cookie = management) => {
  const res = await http.get(url).set("Cookie", cookie);
  expect(res.status, `${url}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
};

// Foshan Fabrics (SUP-003):
//   A  CNY, stage 3, ordered 30 days ago, due in 10: 100 Track pants at ¥2.50 + 500 m Cotton fabric at ¥8 = ¥4,250.
//      Received in China 5 days ago (on time). Paid ¥1,000 deposit at 12; ¥2,750 due in 5 days; ¥100 paid to the agent
//      (sea freight, never counted). Loaded on a container at sea arriving in 3 days.
//   B  USD, stage 1, ordered 10 days ago, due 2 days ago, nothing received: late. 100 Track pants at $2 = $200, unpaid.
// Guangzhou Textile Co. (SUP-001):
//   C  CNY, stage 2, ordered 30 days ago, due 8 days ago, received 5 days ago (late). 10 Polo shirts at ¥30 = ¥300,
//      paid in full (rate 12).
describe("Suppliers page: MD-1 money, SUP-1 summary and SUP-2 insights", () => {
  let foshan = "";
  let guangzhou = "";
  beforeAll(async () => {
    await resetData(ctx);
    management = await signInAs(ctx, SEEDED.management);
    foshan = await idOf(ctx, suppliers, "Foshan Fabrics");
    guangzhou = await idOf(ctx, suppliers, "Guangzhou Textile Co.");
    const a = await makeOrder(ctx, {
      supplier: "Foshan Fabrics",
      stage: 3,
      lines: [
        { item: "Track pants", quantity: 100, rateCny: 2.5 },
        { item: "Cotton fabric", quantity: 500, rateCny: 8 },
      ],
    });
    await receive(ctx, a.id, [{ orderLineId: a.lineIds[0]!, quantity: 100 }]);
    const b = await makeOrder(ctx, { supplier: "Foshan Fabrics", lines: [{ item: "Track pants", quantity: 100, rateCny: 2 }] });
    await ctx.db.update(orders).set({ currency: "USD", orderDate: indiaDay(-10), deliveryDate: indiaDay(-2) }).where(eq(orders.id, b.id));
    const c = await makeOrder(ctx, { supplier: "Guangzhou Textile Co.", stage: 2, lines: [{ item: "Polo shirts", quantity: 10, rateCny: 30 }] });
    await ctx.db.update(orders).set({ deliveryDate: indiaDay(-8) }).where(eq(orders.id, c.id));
    await receive(ctx, c.id, [{ orderLineId: c.lineIds[0]!, quantity: 10 }]);
    const toFoshan = { payee: "Foshan Fabrics", payeeRole: "supplier" } as const;
    await ctx.db.insert(payments).values([
      { ...toFoshan, orderId: a.id, kind: "Deposit", amountCny: 1000, rateInr: 12, status: "paid", mode: "Bank", paidOn: indiaDay(-28) },
      { ...toFoshan, orderId: a.id, kind: "Balance", amountCny: 2750, status: "due", dueDate: indiaDay(5) },
      { orderId: a.id, kind: "Deposit", payee: "Sino Freight", payeeRole: "agent", amountCny: 100, rateInr: 12, status: "paid", mode: "Bank", paidOn: indiaDay(-20) },
      { orderId: c.id, kind: "Balance", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 300, rateInr: 12, status: "paid", mode: "Bank", paidOn: indiaDay(-3) },
    ]);
    const [container] = await ctx.db
      .insert(containers)
      .values({ number: "TEST0000001", shippingAgentId: await idOf(ctx, shippingAgents, "Sino Freight"), terms: "FOB", eta: indiaDay(3), status: "sea" })
      .returning({ id: containers.id });
    await ctx.db.insert(containerLines).values({ containerId: container!.id, orderLineId: a.lineIds[0]!, bundles: 1, quantity: 100 });
  });

  it("SUP-1 and SUP-2 are 401 signed out and 403 for every other role", async () => {
    for (const path of ["/suppliers/summary", "/suppliers/insights"]) {
      expect((await http.get(path)).status, path).toBe(401);
      for (const email of [SEEDED.procurement, SEEDED.accounts, SEEDED.chinaStaff, SEEDED.indiaStaff, SEEDED.warehouseStaff]) {
        expect((await http.get(path).set("Cookie", await signInAs(ctx, email))).status, `${path} ${email}`).toBe(403);
      }
    }
  });

  it("MD-1 rows carry this year's order value and the balance owed, per currency", async () => {
    const rows: { name: string; code: string; ytdValue: unknown; balance: unknown }[] = await get("/suppliers");
    const jan1 = `${indiaDay().slice(0, 4)}-01-01`;
    const thisYear = (day: string) => day >= jan1;
    const foshanYtd = [
      ...(thisYear(indiaDay(-30)) ? [{ currency: "CNY", amount: 4250 }] : []),
      ...(thisYear(indiaDay(-10)) ? [{ currency: "USD", amount: 200 }] : []),
    ];
    expect(rows.find((row) => row.name === "Foshan Fabrics")).toMatchObject({
      code: "SUP-003",
      openOrders: 2,
      openPos: 2,
      ytdValue: foshanYtd,
      balance: [
        { currency: "CNY", amount: 3250 },
        { currency: "USD", amount: 200 },
      ],
    });
    expect(rows.find((row) => row.name === "Guangzhou Textile Co.")).toMatchObject({ code: "SUP-001", balance: [{ currency: "CNY", amount: 0 }] });
    expect(rows.find((row) => row.name === "Shenzhen Apparel")).toMatchObject({ openOrders: 0, openPos: 0, ytdValue: [], balance: [] });
  });

  it("SUP-1: counts suppliers, open and in-transit orders, what is unpaid and what falls due within 7 days", async () => {
    expect(await get("/suppliers/summary")).toEqual({
      suppliers: { total: 5, active: 5, inactive: 0 },
      openPos: {
        count: 3,
        value: [
          { currency: "CNY", amount: 4550 },
          { currency: "USD", amount: 200 },
        ],
      },
      inTransit: { orders: 1, nextEta: indiaDay(3), arrivingNext7: 1 },
      // Guangzhou is paid in full: only Foshan owes (¥3,250 and $200), so one supplier has a balance.
      unpaid: {
        amount: [
          { currency: "CNY", amount: 3250 },
          { currency: "USD", amount: 200 },
        ],
        suppliers: 1,
      },
      upcomingPayments: { windowDays: 7, count: 1, amount: [{ currency: "CNY", amount: 2750 }] },
    });
  });

  it("SUP-2: delivery and completion figures from the orders and China receipts, per supplier and in total", async () => {
    const body = await get("/suppliers/insights");
    expect(body.filter).toEqual({ from: null, to: null, supplier: null });
    expect(body.suppliers).toEqual({ total: 5, active: 5 });
    // A on time, C late, B not delivered and past due: 2 delivered, 1 on time, 2 delayed, 25 days each.
    expect(body.summary).toEqual({ orders: 3, completed: 0, completionRate: 0, delivered: 2, onTime: 1, onTimeRate: 50, delayed: 2, averageDeliveryDays: 25 });
    expect(body.bySupplier).toEqual([
      {
        supplierId: foshan,
        code: "SUP-003",
        name: "Foshan Fabrics",
        country: "China",
        orders: 2,
        completed: 0,
        completionRate: 0,
        delivered: 1,
        onTime: 1,
        onTimeRate: 100,
        delayed: 1,
        averageDeliveryDays: 25,
        value: [
          { currency: "CNY", amount: 4250 },
          { currency: "USD", amount: 200 },
        ],
        balance: [
          { currency: "CNY", amount: 3250 },
          { currency: "USD", amount: 200 },
        ],
      },
      {
        supplierId: guangzhou,
        code: "SUP-001",
        name: "Guangzhou Textile Co.",
        country: "China",
        orders: 1,
        completed: 0,
        completionRate: 0,
        delivered: 1,
        onTime: 0,
        onTimeRate: 0,
        delayed: 1,
        averageDeliveryDays: 25,
        value: [{ currency: "CNY", amount: 300 }],
        balance: [{ currency: "CNY", amount: 0 }],
      },
    ]);
    expect(body.top.map((row: { name: string }) => row.name)).toEqual(["Foshan Fabrics", "Guangzhou Textile Co."]);
    expect(body.byCountry).toEqual([{ country: "China", suppliers: 5 }]);
    // Twelve months ending this month; the orders' value and the supplier payments (agent ones never) fall in them.
    expect(body.monthly).toHaveLength(12);
    expect(body.monthly.at(-1).month).toBe(indiaDay().slice(0, 7));
    const total = (currency: string, pick: "value" | "paid") =>
      body.monthly.reduce((sum: number, month: { value: { currency: string; amount: number }[]; paid: { currency: string; amount: number }[] }) => sum + (month[pick].find((t) => t.currency === currency)?.amount ?? 0), 0);
    expect(total("CNY", "value")).toBe(4550);
    expect(total("USD", "value")).toBe(200);
    expect(total("CNY", "paid")).toBe(1300);
    expect(body.monthly.reduce((sum: number, month: { paidInr: number }) => sum + month.paidInr, 0)).toBe(15600);
  });

  it("SUP-2 keeps the supplier and the order dates it is given, echoing the supplier's name", async () => {
    const mine = await get(`/suppliers/insights?supplierId=${foshan}`);
    expect(mine.filter.supplier).toBe("Foshan Fabrics");
    expect(mine.summary.orders).toBe(2);
    expect(mine.bySupplier.map((row: { name: string }) => row.name)).toEqual(["Foshan Fabrics"]);
    // Only B was placed in the last 15 days.
    const recent = await get(`/suppliers/insights?from=${indiaDay(-15)}&to=${indiaDay()}`);
    expect(recent.filter).toEqual({ from: indiaDay(-15), to: indiaDay(), supplier: null });
    expect(recent.summary).toMatchObject({ orders: 1, delivered: 0, onTimeRate: null, delayed: 1, averageDeliveryDays: null });
    expect(recent.monthly[0].month).toBe(indiaDay(-15).slice(0, 7));
  });

  it("SUP-2 is 400 for a bad query", async () => {
    for (const query of ["foo=1", "from=2026-13-01", "from=2026-10-02&to=2026-10-01", "supplierId=abc"]) {
      const res = await http.get(`/suppliers/insights?${query}`).set("Cookie", management);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
  });
});
