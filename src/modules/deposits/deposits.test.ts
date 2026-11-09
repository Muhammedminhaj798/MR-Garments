import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { payments, shippingAgents, supplierDeposits, supplierDepositTransactions, suppliers, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { UNKNOWN } from "../stages/fixtures";
import { idOf, indiaDay, makeOrder } from "../stock/fixtures";
import { MESSAGES } from "./deposits.routes";

// Supplier deposits (docs/phase2-contracts.md section 3): DEP-1, SD-1 .. SD-5. Deposits are records in the deposit's
// currency; settled, pending and status are summed live; give and receive are never netted; nothing here is an order
// payment.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let accounts = "";
let procurement = "";
let guangzhou = "";
let hangzhou = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  accounts = await signInAs(ctx, SEEDED.accounts);
  procurement = await signInAs(ctx, SEEDED.procurement);
  guangzhou = await idOf(ctx, suppliers, "Guangzhou Textile Co.");
  hangzhou = await idOf(ctx, suppliers, "Hangzhou Knits");
});

const give = (overrides: object = {}) => ({ direction: "give", amount: 1000, openedOn: "2026-10-20", ...overrides });
const settlement = (overrides: object = {}) => ({ paidOn: "2026-10-25", amount: 300, mode: "Bank transfer", ...overrides });
const open = (supplierId: string, body: object, cookie = accounts) => http.post(`/suppliers/${supplierId}/deposits`, body).set("Cookie", cookie);
const settle = (depositId: string, body: object, cookie = accounts) => http.post(`/supplier-deposits/${depositId}/transactions`, body).set("Cookie", cookie);
const get = (path: string, cookie = management) => http.get(path).set("Cookie", cookie);
const del = (path: string, cookie = management) => http.delete(path).set("Cookie", cookie);

/** A deposit opened through SD-2 (201), as its row. */
async function opened(supplierId: string, body: object = give()) {
  const res = await open(supplierId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.deposit as { id: string; pending: number };
}
/** A settlement recorded through SD-3 (201). */
async function settled(depositId: string, body: object = settlement()) {
  const res = await settle(depositId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { transaction: { id: string }; deposit: { settled: number; pending: number; status: string } };
}

const OPEN_ROW = {
  id: expect.any(String),
  supplierId: expect.any(String),
  supplier: "Guangzhou Textile Co.",
  direction: "give",
  currency: "CNY",
  amount: 1000,
  settled: 0,
  pending: 1000,
  status: "open",
  openedOn: "2026-10-20",
  reference: "",
  notes: "",
  transactions: 0,
};

describe("access (payments: Management Full, Accounts Enter, Procurement View, staff None)", () => {
  it("reads need View: 401 signed out, 403 for China staff, 200 for Procurement, Accounts and Management", async () => {
    expect((await http.get("/deposits")).status).toBe(401);
    expect((await http.get(`/suppliers/${guangzhou}/deposits`)).status).toBe(401);
    const chen = await signInAs(ctx, SEEDED.chinaStaff);
    expect((await get("/deposits", chen)).status).toBe(403);
    expect((await get(`/suppliers/${guangzhou}/deposits`, chen)).body.error.code).toBe("forbidden");
    for (const cookie of [procurement, accounts, management]) {
      expect((await get("/deposits", cookie)).status).toBe(200);
      expect((await get(`/suppliers/${guangzhou}/deposits`, cookie)).status).toBe(200);
    }
  });

  it("writes need Enter: 403 for Procurement (View) and staff, 201 for Accounts and Management", async () => {
    const deposit = await opened(guangzhou);
    for (const cookie of [procurement, await signInAs(ctx, SEEDED.warehouseStaff)]) {
      expect((await open(guangzhou, give(), cookie)).status).toBe(403);
      expect((await settle(deposit.id, settlement(), cookie)).status).toBe(403);
    }
    expect((await http.post(`/suppliers/${guangzhou}/deposits`, give())).status).toBe(401);
    expect((await open(guangzhou, give(), management)).status).toBe(201);
    expect((await settle(deposit.id, settlement(), management)).status).toBe(201);
    expect((await settle(deposit.id, settlement(), accounts)).status).toBe(201);
    expect(await ctx.db.select().from(supplierDeposits)).toHaveLength(2);
    expect(await ctx.db.select().from(supplierDepositTransactions)).toHaveLength(2);
  });

  it("deletes need Full (Management): 401 signed out, 403 for Accounts and Procurement, and nothing changes", async () => {
    const deposit = await opened(guangzhou);
    const { transaction } = await settled(deposit.id);
    const empty = await opened(hangzhou);
    expect((await http.delete(`/supplier-deposit-transactions/${transaction.id}`)).status).toBe(401);
    expect((await http.delete(`/supplier-deposits/${empty.id}`)).status).toBe(401);
    for (const cookie of [accounts, procurement, await signInAs(ctx, SEEDED.indiaStaff)]) {
      expect((await del(`/supplier-deposit-transactions/${transaction.id}`, cookie)).status).toBe(403);
      expect((await del(`/supplier-deposits/${empty.id}`, cookie)).body.error.code).toBe("forbidden");
    }
    expect(await ctx.db.select().from(supplierDeposits)).toHaveLength(2);
    expect(await ctx.db.select().from(supplierDepositTransactions)).toHaveLength(1);
    expect((await del(`/supplier-deposit-transactions/${transaction.id}`)).status).toBe(204);
    expect((await del(`/supplier-deposits/${empty.id}`)).status).toBe(204);
  });
});

describe("SD-2 POST /suppliers/:supplierId/deposits", () => {
  it("opens a deposit to give in the supplier's currency, open with nothing settled, and stores the creator", async () => {
    const res = await open(guangzhou, give());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ deposit: { ...OPEN_ROW, supplierId: guangzhou } });
    const anita = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.accounts)))[0]!.id;
    expect((await ctx.db.select().from(supplierDeposits))[0]).toMatchObject({ supplierId: guangzhou, currency: "CNY", amount: 1000, createdBy: anita });
  });

  it("opens a deposit to receive in another currency, with the reference and notes trimmed; today is accepted", async () => {
    const res = await open(hangzhou, { direction: "receive", amount: 250.5, currency: "USD", openedOn: indiaDay(0), reference: "  INV-77 ", notes: " Returned mould " });
    expect(res.status).toBe(201);
    expect(res.body.deposit).toMatchObject({ supplier: "Hangzhou Knits", direction: "receive", currency: "USD", amount: 250.5, pending: 250.5, openedOn: indiaDay(0), reference: "INV-77", notes: "Returned mould" });
  });

  it("takes a deposit for an inactive supplier (a deposit to get back is still a record); SD-1 shows the supplier Inactive", async () => {
    await ctx.db.update(suppliers).set({ status: "Inactive" }).where(eq(suppliers.id, hangzhou));
    const res = await open(hangzhou, { direction: "receive", amount: 300, openedOn: "2026-10-20" });
    expect(res.status).toBe(201);
    expect(res.body.deposit).toMatchObject({ supplier: "Hangzhou Knits", direction: "receive", currency: "CNY", pending: 300 });
    const statement = await get(`/suppliers/${hangzhou}/deposits`);
    expect(statement.body.supplier).toMatchObject({ name: "Hangzhou Knits", status: "Inactive" });
    expect(statement.body.deposits).toHaveLength(1);
  });

  it("refuses broken rules with 422 under the field (every problem at once) and stores nothing", async () => {
    const cases: [object, Record<string, string>][] = [
      [{ direction: "lend" }, { direction: MESSAGES.direction }],
      [{ amount: 0 }, { amount: MESSAGES.amount }],
      [{ amount: "100" }, { amount: MESSAGES.amount }],
      [{ amount: 1e12 }, { amount: MESSAGES.amount }],
      [{ amount: 12.345 }, { amount: MESSAGES.amount }],
      [{ currency: "EUR" }, { currency: MESSAGES.currency }],
      [{ openedOn: undefined }, { openedOn: MESSAGES.openedOn }],
      [{ openedOn: "20-10-2026" }, { openedOn: MESSAGES.openedOn }],
      [{ openedOn: indiaDay(1) }, { openedOn: MESSAGES.future }],
      [{ reference: "r".repeat(101) }, { reference: MESSAGES.referenceTooLong }],
      [{ notes: "n".repeat(1001) }, { notes: MESSAGES.notesTooLong }],
      [{ direction: "", amount: -5 }, { direction: MESSAGES.direction, amount: MESSAGES.amount }],
    ];
    for (const [overrides, fields] of cases) {
      const res = await open(guangzhou, give(overrides));
      expect(res.status, JSON.stringify(overrides)).toBe(422);
      expect(res.body.error, JSON.stringify(overrides)).toEqual({ code: "validation_failed", message: "Some fields need attention.", fields });
    }
    expect((await open(guangzhou, give({ settled: 0 }))).status).toBe(400);
    expect(await ctx.db.select().from(supplierDeposits)).toHaveLength(0);
  });

  it("is 404 for an unknown or malformed supplier", async () => {
    for (const id of [UNKNOWN, "not-a-uuid"]) {
      const res = await open(id, give());
      expect(res.status, id).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found", message: "Supplier not found." } });
    }
  });
});

describe("SD-3 POST /supplier-deposits/:id/transactions", () => {
  it("settles a deposit in parts: open, partly settled, settled; the refreshed row comes back each time", async () => {
    const deposit = await opened(guangzhou);
    const first = await settle(deposit.id, settlement({ reference: " TXN-1 ", notes: "first half" }));
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transaction: { id: expect.any(String), paidOn: "2026-10-25", amount: 300, mode: "Bank transfer", reference: "TXN-1", notes: "first half" },
      deposit: { ...OPEN_ROW, id: deposit.id, supplierId: guangzhou, settled: 300, pending: 700, status: "partly settled", transactions: 1 },
    });
    const second = await settled(deposit.id, settlement({ amount: 700, paidOn: indiaDay(0), mode: "Cash" }));
    expect(second.deposit).toMatchObject({ settled: 1000, pending: 0, status: "settled" });
    const stored = await ctx.db.select().from(supplierDepositTransactions);
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.depositId === deposit.id)).toBe(true);
  });

  it("refuses more than what is pending with 422 under amount, naming the pending amount as the screens show it", async () => {
    const deposit = await opened(guangzhou, give({ amount: 1234.5 }));
    const over = await settle(deposit.id, settlement({ amount: 1234.51 }));
    expect(over.status).toBe(422);
    expect(over.body.error.fields).toEqual({ amount: MESSAGES.overSettled("¥1,234.50") });
    await settled(deposit.id, settlement({ amount: 1000 }));
    expect((await settle(deposit.id, settlement({ amount: 234.51 }))).body.error.fields).toEqual({ amount: "Only ¥234.50 left to settle." });
    await settled(deposit.id, settlement({ amount: 234.49 }));
    expect((await settle(deposit.id, settlement({ amount: 0.02 }))).body.error.fields).toEqual({ amount: "Only ¥0.01 left to settle." });
    await settled(deposit.id, settlement({ amount: 0.01 }));
    expect((await settle(deposit.id, settlement({ amount: 0.01 }))).body.error.fields).toEqual({ amount: "Only ¥0 left to settle." });
    expect(await ctx.db.select().from(supplierDepositTransactions)).toHaveLength(3);
  });

  it("a receipt against a deposit to receive works the same, in the deposit's currency", async () => {
    const deposit = await opened(hangzhou, { direction: "receive", amount: 500, currency: "USD", openedOn: "2026-10-01" });
    const res = await settled(deposit.id, settlement({ amount: 120 }));
    expect(res.deposit).toMatchObject({ direction: "receive", currency: "USD", settled: 120, pending: 380, status: "partly settled" });
    expect((await settle(deposit.id, settlement({ amount: 380.01 }))).body.error.fields).toEqual({ amount: "Only $380 left to settle." });
  });

  it("two settlements at once can't both fit: the deposit row is locked, so exactly one of two ¥600 on ¥1,000 is recorded", async () => {
    const deposit = await opened(guangzhou);
    const [a, b] = await Promise.all([settle(deposit.id, settlement({ amount: 600 })), settle(deposit.id, settlement({ amount: 600, mode: "Cash" }))]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const refused = a.status === 422 ? a : b;
    expect(refused.body.error.fields).toEqual({ amount: "Only ¥400 left to settle." });
    expect(await ctx.db.select().from(supplierDepositTransactions)).toHaveLength(1);
    expect((await get(`/suppliers/${guangzhou}/deposits`)).body.deposits[0]).toMatchObject({ settled: 600, pending: 400, status: "partly settled" });
  });

  it("refuses broken rules with 422 under the field, unknown keys with 400, and an unknown deposit with 404", async () => {
    const deposit = await opened(guangzhou);
    const cases: [object, Record<string, string>][] = [
      [{ paidOn: undefined }, { paidOn: MESSAGES.paidOn }],
      [{ paidOn: indiaDay(1) }, { paidOn: MESSAGES.future }],
      [{ amount: 0 }, { amount: MESSAGES.amount }],
      [{ amount: 1.005 }, { amount: MESSAGES.amount }],
      [{ mode: "  " }, { mode: MESSAGES.mode }],
      [{ mode: "m".repeat(101) }, { mode: MESSAGES.modeTooLong }],
      [{ reference: "r".repeat(101), notes: "n".repeat(1001) }, { reference: MESSAGES.referenceTooLong, notes: MESSAGES.notesTooLong }],
    ];
    for (const [overrides, fields] of cases) {
      const res = await settle(deposit.id, settlement(overrides));
      expect(res.status, JSON.stringify(overrides)).toBe(422);
      expect(res.body.error.fields, JSON.stringify(overrides)).toEqual(fields);
    }
    expect((await settle(deposit.id, settlement({ depositId: deposit.id }))).status).toBe(400);
    for (const id of [UNKNOWN, "1"]) {
      const res = await settle(id, settlement());
      expect(res.status, id).toBe(404);
      expect(res.body.error.message).toBe("Deposit not found.");
    }
    expect(await ctx.db.select().from(supplierDepositTransactions)).toHaveLength(0);
  });
});

describe("SD-1 GET /suppliers/:supplierId/deposits", () => {
  it("shows the supplier, a summary per currency and direction that never nets give against receive, and each deposit's transactions", async () => {
    const toGive = await opened(guangzhou, give({ openedOn: "2026-10-01" }));
    await settled(toGive.id, settlement({ amount: 300, paidOn: "2026-10-05" }));
    const toReceive = await opened(guangzhou, { direction: "receive", amount: 500, openedOn: "2026-10-10", reference: "Mould" });
    await settled(toReceive.id, settlement({ amount: 60, paidOn: "2026-10-12", mode: "Cash" }));
    await settled(toReceive.id, settlement({ amount: 40, paidOn: "2026-10-20", mode: "Cash" }));
    const usd = await opened(guangzhou, give({ amount: 200, currency: "USD", openedOn: "2026-09-15" }));
    await opened(hangzhou, give({ amount: 999 })); // another supplier's: not here

    const res = await get(`/suppliers/${guangzhou}/deposits`, procurement);
    expect(res.status).toBe(200);
    expect(res.body.supplier).toEqual({
      id: guangzhou,
      name: "Guangzhou Textile Co.",
      contactPerson: "Mr. Zhao Lin",
      phone: "+86 138 0013 2244",
      city: "Guangzhou",
      currency: "CNY",
      status: "Active",
    });
    expect(res.body.summary).toEqual([
      { currency: "CNY", direction: "give", amount: 1000, settled: 300, pending: 700 },
      { currency: "CNY", direction: "receive", amount: 500, settled: 100, pending: 400 },
      { currency: "USD", direction: "give", amount: 200, settled: 0, pending: 200 },
    ]);
    // Newest first; transactions newest first inside.
    expect(res.body.deposits.map((row: { id: string }) => row.id)).toEqual([toReceive.id, toGive.id, usd.id]);
    expect(res.body.deposits[0]).toMatchObject({
      direction: "receive",
      amount: 500,
      settled: 100,
      pending: 400,
      status: "partly settled",
      reference: "Mould",
      transactions: [
        { id: expect.any(String), paidOn: "2026-10-20", amount: 40, mode: "Cash", reference: "", notes: "" },
        { id: expect.any(String), paidOn: "2026-10-12", amount: 60, mode: "Cash", reference: "", notes: "" },
      ],
    });
    expect(res.body.deposits[2]).toMatchObject({ currency: "USD", status: "open", transactions: [] });
  });

  it("a supplier without deposits has an empty statement; an unknown or malformed id is 404", async () => {
    const res = await get(`/suppliers/${hangzhou}/deposits`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ supplier: { name: "Hangzhou Knits" }, summary: [], deposits: [] });
    for (const id of [UNKNOWN, "abc"]) {
      const missing = await get(`/suppliers/${id}/deposits`);
      expect(missing.status, id).toBe(404);
      expect(missing.body.error.message).toBe("Supplier not found.");
    }
  });
});

describe("DEP-1 GET /deposits", () => {
  it("lists order deposits (kind Deposit only, latest first, with reference, notes and INR) and supplier deposits newest first", async () => {
    const order = await makeOrder(ctx, { lines: [{ item: "Denim jeans", quantity: 100, rateCny: 10 }] });
    const pay = (body: object) =>
      http.post("/payments", { orderId: order.id, payeeRole: "supplier", agentId: null, rateInr: 12, mode: "Bank transfer", ...body }).set("Cookie", accounts);
    const paid = await pay({ kind: "Deposit", amountCny: 123.45, paidOn: "2026-10-21", rateInr: 11.5, reference: "UTR 9", notes: "Half" });
    expect(paid.status).toBe(201);
    expect((await pay({ kind: "Balance", amountCny: 500, paidOn: "2026-10-22" })).status).toBe(201);
    // No endpoint records a due deposit; the schema allows one, so it is written directly.
    const due = (
      await ctx.db
        .insert(payments)
        .values({ orderId: order.id, kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 200, status: "due", dueDate: "2026-11-30" })
        .returning({ id: payments.id })
    )[0]!;
    const older = await opened(hangzhou, give({ openedOn: "2026-10-01" }));
    const newer = await opened(guangzhou, give({ amount: 50, openedOn: "2026-10-15" }));
    await settled(newer.id, settlement({ amount: 50 }));

    const res = await get("/deposits", procurement);
    expect(res.status).toBe(200);
    expect(res.body.orderDeposits).toEqual([
      {
        id: due.id,
        orderId: order.id,
        po: order.po,
        supplierId: guangzhou,
        supplier: "Guangzhou Textile Co.",
        payee: "Guangzhou Textile Co.",
        payeeRole: "supplier",
        currency: "CNY",
        amountCny: 200,
        status: "due",
        paidOn: null,
        dueDate: "2026-11-30",
        rateInr: null,
        amountInr: null,
        mode: null,
        reference: "",
        notes: "",
      },
      {
        id: paid.body.payment.id,
        orderId: order.id,
        po: order.po,
        supplierId: guangzhou,
        supplier: "Guangzhou Textile Co.",
        payee: "Guangzhou Textile Co.",
        payeeRole: "supplier",
        currency: "CNY",
        amountCny: 123.45,
        status: "paid",
        paidOn: "2026-10-21",
        dueDate: null,
        rateInr: 11.5,
        amountInr: 1419.68, // round2(123.45 * 11.5)
        mode: "Bank transfer",
        reference: "UTR 9",
        notes: "Half",
      },
    ]);
    expect(res.body.supplierDeposits.map((row: { id: string; status: string }) => [row.id, row.status])).toEqual([
      [newer.id, "settled"],
      [older.id, "open"],
    ]);
    expect(res.body.supplierDeposits[0]).toMatchObject({ supplier: "Guangzhou Textile Co.", amount: 50, settled: 50, pending: 0, transactions: 1 });
  });

  it("offers the active suppliers plus any inactive one that still has deposits, by name", async () => {
    await opened(hangzhou);
    await ctx.db.update(suppliers).set({ status: "Inactive" }).where(eq(suppliers.id, hangzhou));
    await ctx.db.update(suppliers).set({ status: "Inactive" }).where(eq(suppliers.name, "Yiwu Trims Ltd."));
    const res = await get("/deposits");
    expect(res.body.suppliers).toEqual([
      { id: expect.any(String), name: "Foshan Fabrics" },
      { id: guangzhou, name: "Guangzhou Textile Co." },
      { id: hangzhou, name: "Hangzhou Knits" },
      { id: expect.any(String), name: "Shenzhen Apparel" },
    ]);
  });

  it("names who was paid: an agent-paid order deposit keeps the order's supplier and carries the agent as payee; that supplier is offered even when inactive", async () => {
    const order = await makeOrder(ctx, { supplier: "Hangzhou Knits", lines: [{ item: "Denim jeans", quantity: 100, rateCny: 10 }] });
    const sino = await idOf(ctx, shippingAgents, "Sino Freight");
    const paid = await http
      .post("/payments", { orderId: order.id, kind: "Deposit", payeeRole: "agent", agentId: sino, amountCny: 50, paidOn: "2026-10-21", rateInr: 12, mode: "Cash" })
      .set("Cookie", accounts);
    expect(paid.status).toBe(201);
    await ctx.db.update(suppliers).set({ status: "Inactive" }).where(eq(suppliers.id, hangzhou));

    const res = await get("/deposits");
    expect(res.body.orderDeposits).toEqual([
      expect.objectContaining({ id: paid.body.payment.id, supplierId: hangzhou, supplier: "Hangzhou Knits", payee: "Sino Freight", payeeRole: "agent", amountInr: 600 }),
    ]);
    expect(res.body.suppliers).toContainEqual({ id: hangzhou, name: "Hangzhou Knits" });
  });

  it("leaves the order figures alone: PAY-1 paid and balance ignore supplier deposits and their settlements", async () => {
    const order = await makeOrder(ctx, { lines: [{ item: "Denim jeans", quantity: 100, rateCny: 10 }] });
    const pay = await http
      .post("/payments", { orderId: order.id, kind: "Deposit", payeeRole: "supplier", agentId: null, amountCny: 300, paidOn: "2026-10-21", rateInr: 12, mode: "Cash" })
      .set("Cookie", accounts);
    expect(pay.status).toBe(201);
    const before = (await get("/payments")).body;
    const deposit = await opened(guangzhou, give({ amount: 5000 }));
    await settled(deposit.id, settlement({ amount: 4000 }));
    const after = (await get("/payments")).body;
    expect(after).toEqual(before);
    expect(after.orders).toEqual([expect.objectContaining({ orderId: order.id, paidCny: 300, paidInr: 3600, balanceCny: 700 })]);
    expect(after.payments).toHaveLength(1);
    expect((await get("/orders")).body[0]).toMatchObject({ id: order.id, paidCny: 300, paidInr: 3600 });
  });
});

describe("SD-4 DELETE /supplier-deposit-transactions/:id and SD-5 DELETE /supplier-deposits/:id", () => {
  it("deleting a transaction brings the deposit's settled, pending and status back; the deposit stays", async () => {
    const deposit = await opened(guangzhou);
    const { transaction } = await settled(deposit.id);
    const { transaction: other } = await settled(deposit.id, settlement({ amount: 700 }));
    expect((await get(`/suppliers/${guangzhou}/deposits`)).body.deposits[0]).toMatchObject({ status: "settled", pending: 0 });

    expect((await del(`/supplier-deposit-transactions/${other.id}`)).status).toBe(204);
    expect((await get(`/suppliers/${guangzhou}/deposits`)).body.deposits[0]).toMatchObject({ settled: 300, pending: 700, status: "partly settled", transactions: [{ id: transaction.id }] });
    expect((await del(`/supplier-deposit-transactions/${transaction.id}`)).status).toBe(204);
    expect((await get(`/suppliers/${guangzhou}/deposits`)).body.deposits[0]).toMatchObject({ settled: 0, pending: 1000, status: "open", transactions: [] });
    expect(await ctx.db.select().from(supplierDeposits)).toHaveLength(1);

    for (const id of [transaction.id, UNKNOWN, "x"]) {
      const res = await del(`/supplier-deposit-transactions/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.body.error.message).toBe("Transaction not found.");
    }
  });

  it("a deposit with transactions is refused (409 in_use, naming the count); one without goes", async () => {
    const deposit = await opened(guangzhou);
    const { transaction } = await settled(deposit.id);
    const one = await del(`/supplier-deposits/${deposit.id}`);
    expect(one.status).toBe(409);
    expect(one.body).toEqual({ error: { code: "in_use", message: "This deposit has 1 transaction, so it can't be deleted." } });
    const { transaction: second } = await settled(deposit.id, settlement({ amount: 100 }));
    expect((await del(`/supplier-deposits/${deposit.id}`)).body.error.message).toBe("This deposit has 2 transactions, so it can't be deleted.");
    expect(await ctx.db.select().from(supplierDeposits)).toHaveLength(1);

    expect((await del(`/supplier-deposit-transactions/${transaction.id}`)).status).toBe(204);
    expect((await del(`/supplier-deposit-transactions/${second.id}`)).status).toBe(204);
    expect((await del(`/supplier-deposits/${deposit.id}`)).status).toBe(204);
    expect(await ctx.db.select().from(supplierDeposits)).toHaveLength(0);
    expect((await get(`/suppliers/${guangzhou}/deposits`)).body.deposits).toEqual([]);
    for (const id of [deposit.id, UNKNOWN, "x"]) {
      const res = await del(`/supplier-deposits/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.body.error.message).toBe("Deposit not found.");
    }
  });
});
