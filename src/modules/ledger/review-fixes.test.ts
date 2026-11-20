import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, orderLines, orders, payments, shippingAgents, supplierDeposits, supplierLedgerEntries as entries, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { indiaDay } from "../stock/fixtures";
import { loadLandedCosts } from "../costs/landed-cost";
import { backfillLedger, reconcileLedger } from "./backfill";
import { loadLedger, projectAccount } from "./ledger";

// Regressions for the focused review of the unified ledger (docs/unified-ledger.md): held payments flagged, the backfill
// and reconciliation refusing an unresolved hold, supplier deposits flagged, LED-3 and PAY-2 replays that survive a
// change since the first submit, microsecond ordering of same-day credits, the trigger guarding live orders' postings,
// 4-decimal payment rates and held orders out of the order reports' value totals.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let accounts = "";
let guangzhou = "";
let hangzhou = "";
let jeans = "";
let sino = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  accounts = await signInAs(ctx, SEEDED.accounts);
  const id = async (table: typeof suppliers | typeof items | typeof shippingAgents, name: string) => (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;
  guangzhou = await id(suppliers, "Guangzhou Textile Co.");
  hangzhou = await id(suppliers, "Hangzhou Knits");
  jeans = await id(items, "Denim jeans");
  sino = await id(shippingAgents, "Sino Freight");
});

/** A legacy order (before 0017) with one supplier deposit, straight into the tables. */
async function legacyOrder(supplierId: string, po: string, value: number, deposit: number) {
  const [order] = await ctx.db.insert(orders).values({ poNumber: po, supplierId, orderDate: "2026-10-01", deliveryDate: "2026-12-01", currency: "CNY", exchangeRate: 12 }).returning();
  await ctx.db.insert(orderLines).values({ orderId: order!.id, itemId: jeans, position: 0, quantity: 1, rateCny: value });
  const [payment] = await ctx.db
    .insert(payments)
    .values({ orderId: order!.id, kind: "Deposit", payee: "Supplier", payeeRole: "supplier", amountCny: deposit, status: "paid", paidOn: "2026-10-02", rateInr: 12, mode: "Bank" })
    .returning();
  return { order: order!, payment: payment! };
}
const hold = (supplierId: string) => [{ supplierId, currency: "CNY", reason: "test hold" }];

describe("held accounts in payment lists, the backfill and reconciliation", () => {
  it("PAY-1 flags a held account's payment (listed, counted nowhere)", async () => {
    const held = await legacyOrder(hangzhou, "H-1", 189.4, 1_050);
    await legacyOrder(guangzhou, "G-1", 500, 200);
    await backfillLedger(ctx.db, { apply: true, holds: hold(hangzhou) });
    const list = (await http.get("/payments").set("Cookie", management)).body.payments as { id: string; held: boolean }[];
    expect(list.find((row) => row.id === held.payment.id)?.held).toBe(true);
    expect(list.filter((row) => row.held)).toHaveLength(1);
  });

  it("refuses to apply when a hold names no supplier; reconciliation fails until every expected hold exists", async () => {
    await legacyOrder(guangzhou, "G-1", 500, 200);
    const dry = await backfillLedger(ctx.db, { apply: false, holds: [{ supplierCode: "SUP-999", currency: "CNY", reason: "typo" }] });
    expect(dry.skippedHolds).toHaveLength(1);
    await expect(backfillLedger(ctx.db, { apply: true, holds: [{ supplierCode: "SUP-999", currency: "CNY", reason: "typo" }] })).rejects.toThrow(/unresolved hold/);
    expect(await ctx.db.select().from(entries)).toHaveLength(0);

    await backfillLedger(ctx.db, { apply: true, holds: [] });
    const expected = [{ supplierCode: "SUP-005", currency: "CNY", reason: "x" }];
    const missing = await reconcileLedger(ctx.db, expected);
    expect(missing.checks.find((check) => check.id === "expected-holds")).toMatchObject({ ok: false, problems: ["not held: SUP-005 CNY"] });
    await backfillLedger(ctx.db, { apply: true, holds: expected });
    expect((await reconcileLedger(ctx.db, expected)).ok).toBe(true);
  });

  it("reconciliation lists any supplier deposit (never posted: an owner decision, D8)", async () => {
    expect((await reconcileLedger(ctx.db)).ok).toBe(true);
    await ctx.db.insert(supplierDeposits).values({ supplierId: guangzhou, direction: "give", amount: 1_000, currency: "CNY", openedOn: "2026-10-20" });
    const result = await reconcileLedger(ctx.db);
    expect(result.checks.find((check) => check.id === "supplier-deposits")?.problems).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  it("the order reports' value totals leave held orders out, as settled and outstanding do", async () => {
    await legacyOrder(hangzhou, "H-1", 189.4, 1_050);
    await legacyOrder(guangzhou, "G-1", 500, 200);
    await backfillLedger(ctx.db, { apply: true, holds: hold(hangzhou) });
    const summary = (await http.get("/reports/orders").set("Cookie", management)).body.summary;
    expect(summary.byCurrency).toEqual([{ currency: "CNY", orderValueCny: 500, settledCny: 200, outstandingCny: 300 }]);
  });
});

describe("replays that survive a change since the first submit", () => {
  it("LED-3: a retry after the adjustment cleared an old currency's balance replays (200); other details 409", async () => {
    // A USD account of -100 left after the supplier moved back to CNY: USD is offered while it is not zero.
    await ctx.db.update(suppliers).set({ currency: "USD", exchangeRate: 84 }).where(eq(suppliers.id, guangzhou));
    const order = await http
      .post("/orders", { supplierId: guangzhou, orderDate: indiaDay(-3), deliveryDate: indiaDay(20), lines: [{ itemId: jeans, quantity: 100, rateCny: 1 }] })
      .set("Cookie", management);
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    await ctx.db.update(suppliers).set({ currency: "CNY", exchangeRate: 12 }).where(eq(suppliers.id, guangzhou));
    const body = { currency: "USD", amount: 100, entryDate: indiaDay(), rateInr: 84, reason: "Old USD balance written off", idempotencyKey: randomUUID() };
    const first = await http.post(`/suppliers/${guangzhou}/ledger/adjustments`, body).set("Cookie", management);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ balanceBefore: -100, balanceAfter: 0 });
    const again = await http.post(`/suppliers/${guangzhou}/ledger/adjustments`, body).set("Cookie", management);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.entry.id).toBe(first.body.entry.id);
    const other = await http.post(`/suppliers/${guangzhou}/ledger/adjustments`, { ...body, amount: 99 }).set("Cookie", management);
    expect(other.body.error.code).toBe("idempotency_conflict");
    expect(await ctx.db.select().from(entries).where(eq(entries.entryType, "adjustment"))).toHaveLength(1);
  });

  it("PAY-2: an agent payment replays after the agent was deactivated; a supplier payment after the supplier was renamed", async () => {
    const order = await http
      .post("/orders", { supplierId: guangzhou, orderDate: indiaDay(-3), deliveryDate: indiaDay(20), lines: [{ itemId: jeans, quantity: 100, rateCny: 1 }] })
      .set("Cookie", management);
    const agentBody = { orderId: order.body.order.id, payeeRole: "agent", agentId: sino, kind: "Deposit", amountCny: 50, paidOn: indiaDay(-1), rateInr: 12, mode: "Bank", clientRequestId: randomUUID() };
    const agentFirst = await http.post("/payments", agentBody).set("Cookie", accounts);
    expect(agentFirst.status, JSON.stringify(agentFirst.body)).toBe(201);
    await ctx.db.update(shippingAgents).set({ status: "Inactive" }).where(eq(shippingAgents.id, sino));
    const agentAgain = await http.post("/payments", agentBody).set("Cookie", accounts);
    expect(agentAgain.status, JSON.stringify(agentAgain.body)).toBe(200);
    expect(agentAgain.body.payment.id).toBe(agentFirst.body.payment.id);

    const supplierBody = { supplierId: guangzhou, amount: 60, paidOn: indiaDay(-1), rateInr: 12, mode: "Bank", clientRequestId: randomUUID() };
    const supplierFirst = await http.post("/payments", supplierBody).set("Cookie", accounts);
    expect(supplierFirst.status, JSON.stringify(supplierFirst.body)).toBe(201);
    await ctx.db.update(suppliers).set({ name: "Guangzhou Textile Group" }).where(eq(suppliers.id, guangzhou));
    const supplierAgain = await http.post("/payments", supplierBody).set("Cookie", accounts);
    expect(supplierAgain.status, JSON.stringify(supplierAgain.body)).toBe(200);
    expect(supplierAgain.body.payment.id).toBe(supplierFirst.body.payment.id);
  });

  it("PAY-2 refuses a rate with more than 4 decimals instead of rounding it silently", async () => {
    const res = await http.post("/payments", { supplierId: guangzhou, amount: 60, paidOn: indiaDay(-1), rateInr: 12.12345, mode: "Bank", clientRequestId: randomUUID() }).set("Cookie", accounts);
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toHaveProperty("rateInr");
  });
});

describe("the journal's order and its trigger", () => {
  it("same-day credits written in one transaction settle in the order they were recorded (microseconds), not by id", async () => {
    const [order] = await ctx.db.insert(orders).values({ poNumber: "G-9", supplierId: guangzhou, orderDate: "2026-10-01", deliveryDate: "2026-12-01", currency: "CNY" }).returning();
    await ctx.db.insert(orderLines).values({ orderId: order!.id, itemId: jeans, position: 0, quantity: 1, rateCny: 100 });
    const [first, second] = await ctx.db
      .insert(payments)
      .values([
        { supplierId: guangzhou, currency: "CNY", kind: "Payment", payee: "G", payeeRole: "supplier", amountCny: 100, status: "paid", paidOn: "2026-10-05", rateInr: 10, mode: "Bank" },
        { supplierId: guangzhou, currency: "CNY", kind: "Payment", payee: "G", payeeRole: "supplier", amountCny: 100, status: "paid", paidOn: "2026-10-05", rateInr: 20, mode: "Bank" },
      ])
      .returning();
    // Recorded 1 µs apart; the later one gets the smaller id, so an id tie-break would pick it first.
    const [low, high] = [randomUUID(), randomUUID()].sort();
    await ctx.db.execute(sql`
      insert into supplier_ledger_entries (id, supplier_id, currency, entry_type, amount, exchange_rate, entry_date, origin, payment_id, idempotency_key, created_at)
      values (${high}, ${guangzhou}, 'CNY', 'payment', 100, 10, '2026-10-05', 'backfill', ${first!.id}, ${`payment:${first!.id}`}, '2026-11-20 10:00:00.000001+00'),
             (${low}, ${guangzhou}, 'CNY', 'payment', 100, 20, '2026-10-05', 'backfill', ${second!.id}, ${`payment:${second!.id}`}, '2026-11-20 10:00:00.000002+00')`);
    await ctx.db.insert(entries).values({ supplierId: guangzhou, currency: "CNY", entryType: "order_debit", amount: -100, entryDate: "2026-10-01", origin: "backfill", orderId: order!.id, poNumber: "G-9", idempotencyKey: `order:${order!.id}:debit` });
    const settled = (await loadLedger(ctx.db)).order(order!.id)!;
    expect(settled.slices).toMatchObject([{ amount: 100, exchangeRate: 10, amountInr: 1_000 }]);
  });

  it("refuses clearing order_id on a live order's postings; only the deletion of the order may", async () => {
    const order = await http
      .post("/orders", { supplierId: guangzhou, orderDate: indiaDay(-3), deliveryDate: indiaDay(20), lines: [{ itemId: jeans, quantity: 100, rateCny: 1 }] })
      .set("Cookie", management);
    const orderId = order.body.order.id as string;
    await expect(ctx.db.update(entries).set({ orderId: null }).where(eq(entries.orderId, orderId))).rejects.toThrow();
    expect((await http.delete(`/orders/${encodeURIComponent(order.body.order.po)}`).set("Cookie", management)).status).toBe(204);
    const kept = await ctx.db.select().from(entries).where(eq(entries.poNumber, order.body.order.po));
    expect(kept.map((row) => [row.entryType, row.orderId])).toEqual([
      ["order_debit", null],
      ["order_cancel", null],
    ]);
  });
});

describe("final review: a held account counts in no figure; replays compare the agent; voids follow their payment", () => {
  it("a held order's agent payment and due row: no agent figures, no sea freight, outside the due windows and the KPIs' value", async () => {
    const held = await legacyOrder(hangzhou, "H-7", 900, 100);
    await ctx.db.insert(payments).values([
      { orderId: held.order.id, kind: "Balance", payee: "Sino Freight", payeeRole: "agent", amountCny: 70, status: "paid", paidOn: "2026-10-03", rateInr: 12, mode: "Bank" },
      { orderId: held.order.id, kind: "Balance", payee: "Supplier", payeeRole: "supplier", amountCny: 50, status: "due", dueDate: indiaDay(3) },
    ]);
    await backfillLedger(ctx.db, { apply: true, holds: hold(hangzhou) });
    const detail = (await http.get(`/orders/${encodeURIComponent("H-7")}`).set("Cookie", management)).body;
    expect(detail).toMatchObject({ held: true, agentPaidCny: null, agentPaidInr: null, settledCny: null });
    expect((await loadLandedCosts(ctx.db, [held.order.id])).get(held.order.id)!.seaFreightInr).toBe(0);
    const summary = (await http.get("/suppliers/summary").set("Cookie", management)).body;
    expect(summary.upcomingPayments.count).toBe(0);
    expect(summary.openPos.value).toEqual([]);
    const perSupplier = (await http.get("/reports/payments-per-supplier").set("Cookie", management)).body;
    // The currency of an open order is listed; its held due row (¥50) counts nothing.
    expect(perSupplier.dueNext30ByCurrency).toEqual([{ currency: "CNY", amount: 0 }]);
    const list = (await http.get("/suppliers").set("Cookie", management)).body as { id: string; ytdValue: unknown[]; heldCurrencies: string[] }[];
    expect(list.find((row) => row.id === hangzhou)).toMatchObject({ ytdValue: [], heldCurrencies: ["CNY"] });
  });

  it("PAY-2: replaying an agent payment's key with another agent is 409, nothing written", async () => {
    const order = await http
      .post("/orders", { supplierId: guangzhou, orderDate: indiaDay(-3), deliveryDate: indiaDay(20), lines: [{ itemId: jeans, quantity: 100, rateCny: 1 }] })
      .set("Cookie", management);
    const dragon = (await ctx.db.select({ id: shippingAgents.id }).from(shippingAgents).where(eq(shippingAgents.name, "Dragon Cargo")))[0]!.id;
    const body = { orderId: order.body.order.id, payeeRole: "agent", agentId: sino, kind: "Deposit", amountCny: 50, paidOn: indiaDay(-1), rateInr: 12, mode: "Bank", clientRequestId: randomUUID() };
    expect((await http.post("/payments", body).set("Cookie", accounts)).status).toBe(201);
    const other = await http.post("/payments", { ...body, agentId: dragon }).set("Cookie", accounts);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("idempotency_conflict");
    expect(await ctx.db.select().from(payments).where(eq(payments.payeeRole, "agent"))).toHaveLength(1);
  });

  it("a void dated before its own (future-dated) payment still empties that payment, never other credits", () => {
    const base = { supplierId: "s", currency: "CNY", advanceEntryId: null, orderId: null } as const;
    const early = { ...base, id: "e1", entryType: "payment" as const, amount: 100, exchangeRate: 10, entryDate: "2026-10-01", createdKey: "2026-10-01 00:00:00.000001", paymentId: "p1", reversesId: null };
    const future = { ...base, id: "e2", entryType: "payment" as const, amount: 100, exchangeRate: 20, entryDate: "2026-12-10", createdKey: "2026-10-02 00:00:00.000001", paymentId: "p2", reversesId: null };
    const voided = { ...base, id: "e3", entryType: "payment_void" as const, amount: -100, exchangeRate: 20, entryDate: "2026-11-20", createdKey: "2026-11-20 00:00:00.000001", paymentId: "p2", reversesId: "e2" };
    const debit = { ...base, id: "e4", entryType: "order_debit" as const, amount: -150, exchangeRate: null, entryDate: "2026-10-01", createdKey: "2026-10-01 00:00:00.000002", paymentId: null, reversesId: null, orderId: "o1" };
    const { settlements, account } = projectAccount([early, future, voided, debit], [{ id: "o1", supplierId: "s", currency: "CNY", orderDate: "2026-10-01", createdKey: "2026-10-01 00:00:00.000003" }]);
    expect(account.balanceCny).toBe(-50);
    expect(settlements.get("o1")!.slices.map((slice) => [slice.entryId, slice.amount])).toEqual([["e1", 100]]);
    expect(settlements.get("o1")).toMatchObject({ settledCny: 100, outstandingCny: 50 });
  });
});
