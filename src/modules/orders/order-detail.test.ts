import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { items, locations, shippingAgents, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";

// ORD-4 GET /orders/:po. Orders, receipts and containers are created through their own endpoints (ORD-3, REC-3, CON-3).

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

const indiaDay = (days = 0) => new Date(Date.now() + 5.5 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
const idOf = async (table: typeof items | typeof suppliers | typeof locations | typeof shippingAgents, name: string) =>
  (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;

let management = "";
let po = "";
let lineIds: string[] = [];
let ids: { supplier: string; jeans: string; fabric: string; office: string; sino: string };
beforeAll(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  ids = {
    supplier: await idOf(suppliers, "Guangzhou Textile Co."),
    jeans: await idOf(items, "Denim jeans"),
    fabric: await idOf(items, "Cotton fabric"),
    office: await idOf(locations, "Guangzhou office"),
    sino: await idOf(shippingAgents, "Sino Freight"),
  };
});

const get = (path: string, cookie = management) => http.get(path).set("Cookie", cookie);
const post = async (path: string, body: object) => {
  const res = await http.post(path, body).set("Cookie", management);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

describe("ORD-4 GET /orders/:po", () => {
  it("is 401 signed out, 403 without ordersView, and 404 for a malformed or unknown PO", async () => {
    expect((await http.get("/orders/PO-2050")).status).toBe(401);
    const china = await get("/orders/PO-2050", await signInAs(ctx, SEEDED.chinaStaff));
    expect(china.status).toBe(403);
    expect(china.body.error.code).toBe("forbidden");
    for (const path of ["/orders/PO-9999", "/orders/2050", "/orders/po-2050", "/orders/PO-", "/orders/PO-12a"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.body.error).toEqual({ code: "not_found", message: "Order not found." });
    }
    expect((await get("/orders/options")).body.nextPo).toBe("PO-2050");
  });

  it("returns the figures, lines and every section, oldest first, for Management", async () => {
    const created = await post("/orders", {
      supplierId: ids.supplier,
      orderDate: indiaDay(-30),
      deliveryDate: indiaDay(10),
      lines: [
        { itemId: ids.jeans, quantity: 1000, rateCny: 12.5 },
        { itemId: ids.fabric, quantity: 300, rateCny: 8.25 },
      ],
      deposits: [
        { payee: "Sino Freight", payeeRole: "agent", amountCny: 1000, paidOn: indiaDay(-20), rateInr: 11.9, mode: "Cash" },
        { payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 1234.56, paidOn: indiaDay(-25), rateInr: 11.8765, mode: "Bank transfer" },
      ],
    });
    po = created.order.po;
    lineIds = (await get(`/orders/${po}`)).body.lines.map((line: { id: string }) => line.id);
    const [jeans, fabric] = lineIds as [string, string];
    const receipt = (receivedOn: string, lines: { orderLineId: string; quantity: number }[], bundles: number) =>
      post("/receipts", { orderId: created.order.id, receivedOn, locationId: ids.office, bundles, deliveryNote: "DN-7", shortRemark: "More to come.", lines });
    const second = await receipt(indiaDay(-2), [{ orderLineId: jeans, quantity: 500 }, { orderLineId: fabric, quantity: 100 }], 12);
    const first = await receipt(indiaDay(-5), [{ orderLineId: jeans, quantity: 400 }], 8);
    const container = await post("/containers", {
      number: "MSCU7654321",
      shippingAgentId: ids.sino,
      terms: "CNF",
      portOfLoading: "Nansha",
      portOfArrival: "Kochi",
      loadedOn: indiaDay(-1),
      sailedOn: null,
      eta: indiaDay(20),
      lines: [{ orderLineId: jeans, bundles: 15, quantity: 700 }],
    });

    const res = await get(`/orders/${po}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: created.order.id,
      po,
      orderDate: indiaDay(-30),
      deliveryDate: indiaDay(10),
      stage: 3, // 1 -> 2 on the first receipt, 2 -> 3 on loading
      supplier: { id: ids.supplier, name: "Guangzhou Textile Co.", contactPerson: "Mr. Zhao Lin", phone: "+86 138 0013 2244", city: "Guangzhou" },
      item: "Denim jeans",
      quantity: 1000,
      unit: "pcs",
      received: 900,
      orderValueCny: 14975, // 1000 * 12.5 + 300 * 8.25
      paidCny: 2234.56,
      paidInr: 26562.25, // 1234.56 * 11.8765 = 14662.25 (rounded) + 1000 * 11.9
      balanceCny: 12740.44,
      lines: [
        { id: jeans, position: 0, item: { id: ids.jeans, name: "Denim jeans" }, unit: "pcs", quantity: 1000, rateCny: 12.5, valueCny: 12500, received: 900, loaded: 700 },
        { id: fabric, position: 1, item: { id: ids.fabric, name: "Cotton fabric" }, unit: "m", quantity: 300, rateCny: 8.25, valueCny: 2475, received: 100, loaded: 0 },
      ],
      payments: [
        {
          id: expect.any(String),
          kind: "Deposit",
          payee: "Guangzhou Textile Co.",
          payeeRole: "supplier",
          amountCny: 1234.56,
          status: "paid",
          paidOn: indiaDay(-25),
          dueDate: null,
          rateInr: 11.8765,
          mode: "Bank transfer",
        },
        expect.objectContaining({ payee: "Sino Freight", payeeRole: "agent", amountCny: 1000, paidOn: indiaDay(-20), rateInr: 11.9, mode: "Cash" }),
      ],
      receipts: [
        {
          id: first.receipt.id,
          receivedOn: indiaDay(-5),
          office: "Guangzhou office",
          bundles: 8,
          deliveryNote: "DN-7",
          shortRemark: "More to come.",
          receivedBy: "Suresh Menon",
          lines: [{ orderLineId: jeans, item: "Denim jeans", unit: "pcs", quantity: 400 }],
        },
        expect.objectContaining({
          id: second.receipt.id,
          receivedOn: indiaDay(-2),
          bundles: 12,
          lines: [
            { orderLineId: jeans, item: "Denim jeans", unit: "pcs", quantity: 500 },
            { orderLineId: fabric, item: "Cotton fabric", unit: "m", quantity: 100 },
          ],
        }),
      ],
      containers: [
        {
          id: container.container.id,
          number: "MSCU7654321",
          status: "loading",
          terms: "CNF",
          agent: { id: ids.sino, name: "Sino Freight" },
          loadedOn: indiaDay(-1),
          sailedOn: null,
          eta: indiaDay(20),
          lines: [{ orderLineId: jeans, item: "Denim jeans", unit: "pcs", bundles: 15, quantity: 700 }],
        },
      ],
    });
  });

  it("gives empty sections for an order with no records yet", async () => {
    const created = await post("/orders", {
      supplierId: ids.supplier,
      orderDate: indiaDay(-1),
      deliveryDate: indiaDay(5),
      lines: [{ itemId: ids.fabric, quantity: 50, rateCny: 3 }],
      deposits: [],
    });
    const res = await get(`/orders/${created.order.po}`);
    expect(res.body).toMatchObject({ stage: 1, received: 0, paidCny: 0, balanceCny: 150, payments: [], receipts: [], containers: [] });
    expect(res.body.lines).toEqual([expect.objectContaining({ quantity: 50, valueCny: 150, received: 0, loaded: 0 })]);
  });

  it("is null for each section the user can't view", async () => {
    // Accounts: payments Enter, receiving and containers None. Procurement: payments and receiving View, containers None.
    const accounts = await get(`/orders/${po}`, await signInAs(ctx, SEEDED.accounts));
    expect(accounts.status).toBe(200);
    expect(accounts.body).toMatchObject({ po, received: 900, receipts: null, containers: null });
    expect(accounts.body.payments).toHaveLength(2);
    expect(accounts.body.lines.map((line: { received: number; loaded: number }) => [line.received, line.loaded])).toEqual([
      [900, 700],
      [100, 0],
    ]);
    const procurement = await get(`/orders/${po}`, await signInAs(ctx, SEEDED.procurement));
    expect(procurement.body.containers).toBeNull();
    expect(procurement.body.receipts).toHaveLength(2);
    expect(procurement.body.payments).toHaveLength(2);
  });
});
