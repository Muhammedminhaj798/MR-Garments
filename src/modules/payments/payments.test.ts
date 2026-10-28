import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, payments, shippingAgents, suppliers, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { MESSAGES } from "./payments.routes";

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

const dayInIndia = (offsetDays: number) => new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

let management = "";
let accounts = "";
let orderId = "";
let ids: { sino: string; dragon: string; accountsUser: string };
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  accounts = await signInAs(ctx, SEEDED.accounts);
  const agentId = async (name: string) => (await ctx.db.select({ id: shippingAgents.id }).from(shippingAgents).where(eq(shippingAgents.name, name)))[0]!.id;
  ids = {
    sino: await agentId("Sino Freight"),
    dragon: await agentId("Dragon Cargo"),
    accountsUser: (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.accounts)))[0]!.id,
  };
  // An order worth ¥10,000 with a ¥1,000 deposit, made through ORD-3.
  const supplierId = (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, "Guangzhou Textile Co.")))[0]!.id;
  const itemId = (await ctx.db.select({ id: items.id }).from(items).where(eq(items.name, "Denim jeans")))[0]!.id;
  const order = await http
    .post("/orders", {
      supplierId,
      orderDate: "2026-10-20",
      deliveryDate: "2026-11-30",
      lines: [{ itemId, quantity: 1000, rateCny: 10 }],
      deposits: [{ payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 1000, paidOn: "2026-10-21", rateInr: 12, mode: "Cash" }],
    })
    .set("Cookie", management);
  expect(order.status).toBe(201);
  orderId = order.body.order.id;
});

const body = (overrides: object = {}) => ({
  orderId,
  kind: "Balance",
  payeeRole: "supplier",
  agentId: null,
  amountCny: 2345.67,
  paidOn: "2026-10-25",
  rateInr: 11.8765,
  mode: "  Bank transfer  ",
  ...overrides,
});
const record = (payload: object, cookie = accounts) => http.post("/payments", payload).set("Cookie", cookie);
const get = (path: string) => http.get(path).set("Cookie", management);
const stored = () => ctx.db.select().from(payments).where(eq(payments.kind, "Balance"));

describe("PAY-2 access", () => {
  it("is 401 signed out", async () => {
    expect((await http.post("/payments", body())).status).toBe(401);
  });

  it("is 403 for Procurement (View) and China staff", async () => {
    for (const email of [SEEDED.procurement, SEEDED.chinaStaff]) {
      const res = await record(body(), await signInAs(ctx, email));
      expect(res.status, email).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    expect(await stored()).toHaveLength(0);
  });

  it("is 201 for Management and Accounts", async () => {
    expect((await record(body(), management)).status).toBe(201);
    expect((await record(body(), accounts)).status).toBe(201);
    expect(await stored()).toHaveLength(2);
  });
});

describe("PAY-2 POST /payments", () => {
  it("saves a paid supplier payment, and PAY-1 and ORD-1 count it", async () => {
    const res = await record(body());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ payment: { id: expect.any(String) } });

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: res.body.payment.id,
      orderId,
      kind: "Balance",
      payee: "Guangzhou Textile Co.",
      payeeRole: "supplier",
      amountCny: 2345.67,
      status: "paid",
      paidOn: "2026-10-25",
      dueDate: null,
      rateInr: 11.8765,
      mode: "Bank transfer",
      createdBy: ids.accountsUser,
    });

    // Deposit 1000 * 12 = 12000, plus round2(2345.67 * 11.8765) = 27858.35.
    const pay1 = await get("/payments");
    expect(pay1.body.orders).toEqual([expect.objectContaining({ orderId, paidCny: 3345.67, paidInr: 39858.35, balanceCny: 6654.33 })]);
    expect(pay1.body.payments).toContainEqual(
      expect.objectContaining({ id: res.body.payment.id, kind: "Balance", status: "paid", payee: "Guangzhou Textile Co.", amountCny: 2345.67 }),
    );
    const ord1 = await get("/orders");
    expect(ord1.body[0]).toMatchObject({ id: orderId, paidCny: 3345.67, paidInr: 39858.35 });
  });

  it("names the agent when a shipping agent was paid, and accepts today", async () => {
    const res = await record(body({ kind: "Deposit", payeeRole: "agent", agentId: ids.sino, paidOn: dayInIndia(0), mode: "Cash" }));
    expect(res.status).toBe(201);
    const row = (await ctx.db.select().from(payments).where(eq(payments.id, res.body.payment.id)))[0];
    expect(row).toMatchObject({ kind: "Deposit", payee: "Sino Freight", payeeRole: "agent", status: "paid", paidOn: dayInIndia(0) });
  });

  it("lets the balance go below 0 (no overpayment check)", async () => {
    expect((await record(body({ amountCny: 9500 }))).status).toBe(201);
    const pay1 = await get("/payments");
    expect(pay1.body.orders[0].balanceCny).toBe(-500);
  });

  it("refuses broken rules with 422 under the field and stores nothing", async () => {
    await ctx.db.update(shippingAgents).set({ status: "Inactive" }).where(eq(shippingAgents.id, ids.dragon));
    const cases: [object, string, string][] = [
      [{ orderId: "not-a-uuid" }, "orderId", MESSAGES.order],
      [{ orderId: "00000000-0000-4000-8000-000000000000" }, "orderId", MESSAGES.order],
      [{ kind: "Advance" }, "kind", MESSAGES.kind],
      [{ payeeRole: "bank" }, "payeeRole", MESSAGES.payeeRole],
      [{ payeeRole: "agent", agentId: null }, "agentId", MESSAGES.agent],
      [{ payeeRole: "agent", agentId: "00000000-0000-4000-8000-000000000000" }, "agentId", MESSAGES.agent],
      [{ payeeRole: "agent", agentId: ids.dragon }, "agentId", MESSAGES.agent],
      [{ payeeRole: "supplier", agentId: ids.sino }, "agentId", MESSAGES.agentForSupplier],
      [{ amountCny: 0 }, "amountCny", MESSAGES.amount],
      [{ amountCny: "100" }, "amountCny", MESSAGES.amount],
      [{ amountCny: 1e12 }, "amountCny", MESSAGES.amount],
      [{ paidOn: dayInIndia(1) }, "paidOn", MESSAGES.paidOnFuture],
      [{ paidOn: "25/10/2026" }, "paidOn", MESSAGES.paidOn],
      [{ rateInr: 0 }, "rateInr", MESSAGES.rateInr],
      [{ mode: "   " }, "mode", MESSAGES.mode],
      [{ mode: "x".repeat(101) }, "mode", MESSAGES.modeTooLong],
    ];
    for (const [overrides, field, message] of cases) {
      const res = await record(body(overrides));
      expect(res.status, JSON.stringify(overrides)).toBe(422);
      expect(res.body.error.code).toBe("validation_failed");
      expect(res.body.error.fields, JSON.stringify(overrides)).toEqual({ [field]: message });
    }
    // Problems that need the database are reported together.
    const both = await record(body({ orderId: "00000000-0000-4000-8000-000000000000", payeeRole: "agent", agentId: null }));
    expect(both.body.error.fields).toEqual({ orderId: MESSAGES.order, agentId: MESSAGES.agent });
    expect(await stored()).toHaveLength(0);
  });

  it("is 400 for an unknown key", async () => {
    expect((await record(body({ status: "due" }))).status).toBe(400);
    expect((await record(body({ payee: "Someone" }))).status).toBe(400);
    expect(await stored()).toHaveLength(0);
  });
});
