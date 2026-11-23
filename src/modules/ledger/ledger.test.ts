import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  items,
  locations,
  orderLines,
  orders,
  payments,
  receiptLines,
  receipts,
  supplierAdvanceEntries,
  supplierLedgerEntries,
  supplierLedgerHolds,
  suppliers,
  users,
} from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { indiaDay } from "../stock/fixtures";
import { baselineChanges, BASELINE_FORMAT, backfillLedger, legacyDifferences, legacyRecords, parseExpectation, readBaseline, reconcileLedger, unexpectedDifferences, writeBaseline } from "./backfill";
import { assertLedgerLive, depositMilestone, inrOf, loadLedger, projectAccount } from "./ledger";

// The unified supplier ledger core (docs/unified-ledger.md): the FIFO projection, INR rounding, the milestone, the
// backfill of legacy records (exactly once, never the allocation/excess rows, never a held account), reconciliation,
// the append-only trigger, the write-state guard, and LED-1/2/3.

// ---------------------------------------------------------------------------------------------------------------------
// Pure

type Row = Parameters<typeof projectAccount>[0][number];
let seq = 0;
const at = (day: string) => new Date(`${day}T00:00:00Z`);
const entry = (entryType: Row["entryType"], amount: number, entryDate: string, extra: Partial<Row> = {}): Row => ({
  id: `00000000-0000-0000-0000-${String(++seq).padStart(12, "0")}`,
  supplierId: "s",
  currency: "CNY",
  entryType,
  amount,
  exchangeRate: 12,
  entryDate,
  createdKey: new Date(at(entryDate).getTime() + seq).toISOString(),
  paymentId: entryType.startsWith("payment") ? `p${seq}` : null,
  advanceEntryId: null,
  orderId: null,
  reversesId: null,
  ...extra,
});
const order = (id: string, orderDate: string) => ({ id, supplierId: "s", currency: "CNY", orderDate, createdKey: new Date(at(orderDate).getTime() + ++seq).toISOString() });
const debit = (orderId: string, value: number, day: string) => entry("order_debit", -value, day, { orderId, exchangeRate: null });

describe("projectAccount (FIFO, oldest order first)", () => {
  it("example 1: ₹40,000 then two orders then ₹30,000 leaves ₹50,000 and both orders paid", () => {
    const { settlements, account } = projectAccount(
      [entry("payment", 40_000, "2026-12-01"), debit("o1", 15_000, "2026-12-02"), debit("o2", 5_000, "2026-12-03"), entry("payment", 30_000, "2026-12-04")],
      [order("o1", "2026-12-02"), order("o2", "2026-12-03")],
    );
    expect(account.balanceCny).toBe(50_000);
    expect(settlements.get("o1")).toMatchObject({ settledCny: 15_000, outstandingCny: 0, paymentStatus: "paid" });
    expect(settlements.get("o2")).toMatchObject({ settledCny: 5_000, outstandingCny: 0, paymentStatus: "paid" });
  });

  it("example 2: a negative balance is payable, the order is partly paid and never negative", () => {
    const { settlements, account } = projectAccount([entry("payment", 10_000, "2026-12-01"), debit("o1", 15_000, "2026-12-02")], [order("o1", "2026-12-02")]);
    expect(account.balanceCny).toBe(-5_000);
    expect(settlements.get("o1")).toMatchObject({ settledCny: 10_000, outstandingCny: 5_000, paymentStatus: "partly" });
  });

  it("settles by order date, then the moment recorded (ties), whatever the posting order", () => {
    const late = order("late", "2026-12-05");
    const tieA = order("tieA", "2026-12-01");
    const tieB = order("tieB", "2026-12-01");
    const { settlements } = projectAccount(
      [debit("late", 100, "2026-12-05"), debit("tieB", 100, "2026-12-01"), debit("tieA", 100, "2026-12-01"), entry("payment", 150, "2026-12-06")],
      [late, tieB, tieA],
    );
    expect(settlements.get("tieA")!.settledCny).toBe(100);
    expect(settlements.get("tieB")!.settledCny).toBe(50);
    expect(settlements.get("late")!.settledCny).toBe(0);
    expect(settlements.get("late")!.paymentStatus).toBe("unpaid");
  });

  it("an empty pool, a zero-value order, and a pool larger than every debit", () => {
    const empty = projectAccount([debit("o1", 500, "2026-12-01"), debit("zero", 0, "2026-12-01")], [order("o1", "2026-12-01"), order("zero", "2026-12-02")]);
    expect(empty.settlements.get("o1")).toMatchObject({ settledCny: 0, outstandingCny: 500, paymentStatus: "unpaid" });
    expect(empty.settlements.get("zero")).toMatchObject({ valueCny: 0, settledCny: 0, outstandingCny: 0, paymentStatus: "paid" });
    const surplus = projectAccount([entry("payment", 1_000, "2026-12-01"), debit("o1", 400, "2026-12-02")], [order("o1", "2026-12-02")]);
    expect(surplus.account).toMatchObject({ balanceCny: 600, outstandingCny: 0, openOrders: 0 });
  });

  it("a void empties its own payment; order adjustments and cancels change the value", () => {
    const pay = entry("payment", 1_000, "2026-12-01");
    const rows = [
      pay,
      entry("payment", 300, "2026-12-02"),
      entry("payment_void", -1_000, "2026-12-03", { reversesId: pay.id, paymentId: pay.paymentId }),
      debit("o1", 500, "2026-12-01"),
      entry("order_adjustment", -200, "2026-12-02", { orderId: "o1", exchangeRate: null }),
    ];
    const { settlements, account } = projectAccount(rows, [order("o1", "2026-12-01")]);
    expect(account).toMatchObject({ creditsCny: 300, debitsCny: 700, balanceCny: -400 });
    expect(settlements.get("o1")).toMatchObject({ valueCny: 700, settledCny: 300, outstandingCny: 400 });
    expect(settlements.get("o1")!.slices.map((slice) => slice.amount)).toEqual([300]);
  });

  it("a negative adjustment takes the newest money first; a shortfall is payable from its date, settled oldest first with the orders", () => {
    const old = entry("payment", 100, "2026-12-01", { exchangeRate: 10 });
    const fresh = entry("payment", 100, "2026-12-02", { exchangeRate: 20 });
    const { settlements, shortfallCny } = projectAccount(
      [old, fresh, entry("adjustment", -150, "2026-12-03", { paymentId: null }), debit("o1", 100, "2026-12-01")],
      [order("o1", "2026-12-01")],
    );
    // o1 had the old lot when the adjustment was recorded: −150 takes the free newer lot (100) and is 50 short. o1 keeps
    // its settlement (no credit is taken twice).
    expect(settlements.get("o1")).toMatchObject({ settledCny: 100, outstandingCny: 0 });
    expect(settlements.get("o1")!.slices).toMatchObject([{ amount: 100, exchangeRate: 10, amountInr: 1_000 }]);
    expect(shortfallCny).toBe(50);
    // −¥80 with no credit before it: ¥80 payable from 1 Dec. The order (30 Nov) is older, so the ¥100 of 2 Dec settles
    // it first; the shortfall stays payable (the balance).
    const short = projectAccount(
      [entry("adjustment", -80, "2026-12-01", { paymentId: null }), entry("payment", 100, "2026-12-02"), debit("o1", 100, "2026-11-30")],
      [order("o1", "2026-11-30")],
    );
    expect(short.settlements.get("o1")).toMatchObject({ settledCny: 100, outstandingCny: 0 });
    expect(short.shortfallCny).toBe(80);
    expect(short.account.balanceCny).toBe(-80);
  });

  it("goods INR: each slice at its own credit's rate; a credit without a rate leaves the order's INR unknown", () => {
    const { settlements } = projectAccount(
      [entry("payment", 100, "2026-12-01", { exchangeRate: 12.5 }), entry("payment", 100, "2026-12-02", { exchangeRate: 13 }), debit("o1", 150, "2026-12-01"), debit("o2", 50, "2026-12-02")],
      [order("o1", "2026-12-01"), order("o2", "2026-12-02")],
    );
    expect(settlements.get("o1")!.settledInr).toBe(1_250 + 650);
    expect(settlements.get("o2")!.settledInr).toBe(650);
    const unknown = projectAccount([entry("payment", 100, "2026-12-01", { exchangeRate: null }), debit("o1", 100, "2026-12-01")], [order("o1", "2026-12-01")]);
    expect(unknown.settlements.get("o1")!.settledInr).toBeNull();
    expect(unknown.account.paidInrComplete).toBe(false);
  });

  it("an order with no debit posted has no figures", () => {
    const { settlements } = projectAccount([entry("payment", 100, "2026-12-01")], [order("o1", "2026-12-01")]);
    expect(settlements.get("o1")).toMatchObject({ posted: false, settledCny: null, outstandingCny: null, paymentStatus: null });
  });
});

describe("inrOf rounds like SQL round(amount * rate, 2)", () => {
  it("half away from zero, symmetric for voids, exact for large amounts", () => {
    expect(inrOf(100, 0.125)).toBe(0.13); // 0.125 -> 0.13
    expect(inrOf(-100, 0.125)).toBe(-0.13);
    expect(inrOf(862014, 102.25)).toBe(881409.32);
    expect(inrOf(123_450, 84.1234)).toBe(103_850.34); // 1,234.50 × 84.1234 = 103,850.3373
    expect(inrOf(100, null)).toBeNull();
  });
});

describe("depositMilestone (D11)", () => {
  const settled = (settledCny: number | null) => ({ settledCny }) as never;
  it("none, unmet, partly, met (exactly and above), and unknown while the order has no settlement", () => {
    expect(depositMilestone(null, settled(5)).depositStatus).toBe("none");
    expect(depositMilestone(100, settled(0))).toMatchObject({ depositStatus: "unmet", depositPendingCny: 100 });
    expect(depositMilestone(100, settled(40))).toMatchObject({ depositStatus: "partly", depositPendingCny: 60 });
    expect(depositMilestone(100, settled(100))).toMatchObject({ depositStatus: "met", depositPendingCny: 0 });
    expect(depositMilestone(100, settled(250))).toMatchObject({ depositStatus: "met", depositPendingCny: 0 });
    expect(depositMilestone(100, settled(null))).toMatchObject({ depositStatus: null, depositSettledCny: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Database

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let accounts = "";
let procurement = "";
let guangzhou = "";
let hangzhou = "";
let foshan = "";
let jeans = "";
let userId = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  accounts = await signInAs(ctx, SEEDED.accounts);
  procurement = await signInAs(ctx, SEEDED.procurement);
  const id = async (table: typeof suppliers | typeof items, name: string) => (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;
  guangzhou = await id(suppliers, "Guangzhou Textile Co.");
  hangzhou = await id(suppliers, "Hangzhou Knits");
  foshan = await id(suppliers, "Foshan Fabrics");
  jeans = await id(items, "Denim jeans");
  userId = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.management)))[0]!.id;
});

/** A legacy order written straight to the tables (as before 0017): value = quantity × rate. */
/** A legacy order of one piece at ¥value, received (so worth ¥value: received quantity x rate), written to the tables. */
async function legacyOrder(supplierId: string, po: string, value: number, orderDate: string, rate: number | null = 12) {
  const [row] = await ctx.db.insert(orders).values({ poNumber: po, supplierId, orderDate, deliveryDate: indiaDay(60), currency: "CNY", exchangeRate: rate }).returning();
  const [line] = await ctx.db.insert(orderLines).values({ orderId: row!.id, itemId: jeans, position: 0, quantity: 1, rateCny: value }).returning();
  const office = (await ctx.db.select({ id: locations.id }).from(locations).where(eq(locations.name, "Guangzhou office")))[0]!.id;
  const boss = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.management)))[0]!.id;
  const [receipt] = await ctx.db.insert(receipts).values({ orderId: row!.id, receivedOn: orderDate, locationId: office, receivedBy: boss, bundles: 1 }).returning();
  await ctx.db.insert(receiptLines).values({ receiptId: receipt!.id, orderLineId: line!.id, quantity: 1 });
  return row!;
}
const legacyPayment = async (orderId: string, amountCny: number, paidOn: string, extra: object = {}) =>
  (
    await ctx.db
      .insert(payments)
      .values({ orderId, kind: "Deposit", payee: "Supplier", payeeRole: "supplier", amountCny, status: "paid", paidOn, rateInr: 12, mode: "Bank", ...extra })
      .returning()
  )[0]!;
const legacyAdvance = async (supplierId: string, values: Partial<typeof supplierAdvanceEntries.$inferInsert>) =>
  (await ctx.db.insert(supplierAdvanceEntries).values({ supplierId, currency: "CNY", exchangeRate: 12, entryDate: indiaDay(-30), kind: "receipt", amount: 0, mode: "Bank", ...values }).returning())[0]!;

/**
 * The plan's example 9.2(b) for Guangzhou, plus the 9.2(a) excess pattern: receipt ¥40,000 → order A ¥15,000 and B
 * ¥5,000 (allocations), order C ¥10,000 paid ¥12,000 (¥2,000 excess lot). Also an agent payment, a due row, another
 * supplier with an unpaid order, and a held account (Foshan) with an order, a deposit and a receipt.
 */
async function seedLegacy() {
  const receipt = await legacyAdvance(guangzhou, { amount: 40_000, entryDate: "2026-10-01" });
  const a = await legacyOrder(guangzhou, "A-1", 15_000, "2026-10-02");
  const b = await legacyOrder(guangzhou, "B-1", 5_000, "2026-10-03");
  const c = await legacyOrder(guangzhou, "C-1", 10_000, "2026-10-04", null);
  const base = { supplierId: guangzhou, currency: "CNY", exchangeRate: 12, entryDate: "2026-10-05", mode: "" };
  await ctx.db.insert(supplierAdvanceEntries).values([
    { ...base, kind: "allocation", amount: 15_000, advanceId: receipt.id, orderId: a.id, poNumber: "A-1" },
    { ...base, kind: "allocation", amount: 5_000, advanceId: receipt.id, orderId: b.id, poNumber: "B-1" },
  ]);
  const paid = await legacyPayment(c.id, 12_000, "2026-10-06", { kind: "Balance" });
  await ctx.db.insert(supplierAdvanceEntries).values({ ...base, kind: "excess", amount: 2_000, orderId: c.id, poNumber: "C-1", paymentId: paid.id, mode: "Bank" });
  await legacyPayment(c.id, 700, "2026-10-06", { payeeRole: "agent", payee: "Sino Freight", kind: "Balance" });
  await ctx.db.insert(payments).values({ orderId: c.id, kind: "Balance", payee: "Supplier", payeeRole: "supplier", amountCny: 999, status: "due", dueDate: indiaDay(10) });
  const other = await legacyOrder(hangzhou, "H-1", 3_000, "2026-10-07");
  const held = await legacyOrder(foshan, "0000066", 189.4, "2026-10-08");
  await legacyPayment(held.id, 1_050, "2026-10-08");
  await legacyAdvance(foshan, { amount: 12_000, entryDate: "2026-10-09" });
  return { a, b, c, other, held, paid };
}
const holdFoshan = [{ supplierId: "", currency: "CNY", reason: "test hold" }];
const backfill = (apply = true) => backfillLedger(ctx.db, { apply, holds: holdFoshan.map((hold) => ({ ...hold, supplierId: foshan })) });

describe("backfill and reconciliation (plan 9)", () => {
  it("posts debits, supplier payments and receipts once; never allocations, excess, agent, due or held rows", async () => {
    const seeded = await seedLegacy();
    const before = await legacyRecords(ctx.db);
    expect(Object.values(before).map((rows) => Object.keys(rows).length)).toEqual([5, 5, 4, 5, 0, 0]); // the held account included
    const dry = await backfill(false);
    expect(dry.written).toBe(6); // 4 order debits (A, B, C, H) + 1 payment + 1 receipt
    expect(await ctx.db.select().from(supplierLedgerEntries)).toHaveLength(0);
    expect(await ctx.db.select().from(supplierLedgerHolds)).toHaveLength(0);

    const applied = await backfill(true);
    expect(applied.written).toBe(6);
    const ledger = await loadLedger(ctx.db);
    // Guangzhou: +40,000 + 12,000 − 15,000 − 5,000 − 10,000 = +22,000 (the legacy position); the excess lot is not posted.
    expect(ledger.account(guangzhou, "CNY")).toMatchObject({ balanceCny: 22_000, creditsCny: 52_000, debitsCny: 30_000, outstandingCny: 0, held: false });
    expect(ledger.account(hangzhou, "CNY")).toMatchObject({ balanceCny: -3_000, outstandingCny: 3_000, openOrders: 1 });
    expect(ledger.account(foshan, "CNY")).toMatchObject({ held: true, balanceCny: null });
    expect(ledger.order(seeded.held.id)).toMatchObject({ held: true, settledCny: null });
    expect(ledger.order(seeded.c.id)).toMatchObject({ settledCny: 10_000, paymentStatus: "paid" });

    const second = await backfill(true);
    expect(second.written).toBe(0);
    expect((await reconcileLedger(ctx.db)).ok).toBe(true);
    expect(baselineChanges(before, await legacyRecords(ctx.db))).toEqual([]);
    expect(await legacyDifferences(ctx.db)).toEqual([]);
  });

  it("finds a missing credit, a wrong debit and a posting into a held account", async () => {
    const seeded = await seedLegacy();
    await backfill(true);
    // A wrong debit: A's received quantity changes behind the ledger's back (its value is received x rate).
    const [aLine] = await ctx.db.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, seeded.a.id));
    await ctx.db.update(receiptLines).set({ quantity: 2 }).where(eq(receiptLines.orderLineId, aLine!.id));
    await legacyPayment(seeded.other.id, 100, "2026-10-08");
    await ctx.db.insert(supplierLedgerEntries).values({
      supplierId: foshan,
      currency: "CNY",
      entryType: "order_adjustment",
      amount: -1,
      entryDate: indiaDay(),
      origin: "app",
      orderId: seeded.held.id,
      poNumber: "0000066",
      idempotencyKey: "test:held",
    });
    const result = await reconcileLedger(ctx.db);
    const failed = Object.fromEntries(result.checks.filter((check) => !check.ok).map((check) => [check.id, check.problems.length]));
    expect(failed).toMatchObject({ orders: 1, payments: 1, held: 1 });
    expect(result.ok).toBe(false);
  });
});

describe("the owner's receipt exclusion list", () => {
  it("never posts a listed receipt and keeps its legacy row; its unlisted twin is posted once; reconciles only with the list", async () => {
    await legacyOrder(hangzhou, "H-1", 30_000, "2026-09-30");
    const genuine = await legacyAdvance(hangzhou, { amount: 25_000, entryDate: "2026-10-01", mode: "CASH" });
    const duplicate = await legacyAdvance(hangzhou, { amount: 25_000, entryDate: "2026-10-01", mode: "CASH" });
    const list = [{ advanceEntryId: duplicate.id, reason: "test duplicate" }];
    const before = await legacyRecords(ctx.db);
    const run = (apply: boolean) => backfillLedger(ctx.db, { apply, holds: [], excludedReceipts: list });

    expect(await run(false)).toMatchObject({ written: 2, unresolvedExclusions: [], excludedReceipts: [{ advanceEntryId: duplicate.id, currency: "CNY", amount: 25_000 }] });
    expect((await run(true)).written).toBe(2); // H-1's debit + the genuine receipt
    expect((await run(true)).written).toBe(0);
    const credits = await ctx.db.select({ advanceEntryId: supplierLedgerEntries.advanceEntryId }).from(supplierLedgerEntries).where(eq(supplierLedgerEntries.entryType, "payment"));
    expect(credits).toEqual([{ advanceEntryId: genuine.id }]);
    expect((await loadLedger(ctx.db)).account(hangzhou, "CNY")).toMatchObject({ balanceCny: -5_000, outstandingCny: 5_000 });

    const listed = await reconcileLedger(ctx.db, [], list);
    expect(listed.ok).toBe(true);
    expect(listed.checks.find((check) => check.id === "excluded-receipts")).toMatchObject({ ok: true });
    // Without the list the same journal fails: the duplicate has no credit.
    const unlisted = await reconcileLedger(ctx.db);
    expect(unlisted.checks.find((check) => check.id === "receipts")).toMatchObject({ ok: false, problems: [expect.stringContaining(duplicate.id)] });
    expect(baselineChanges(before, await legacyRecords(ctx.db))).toEqual([]); // every legacy row, the duplicate's included, is untouched
  });

  it("refuses to apply when a listed id is unknown, not a receipt or drawn from; flags a listed receipt that was posted", async () => {
    await seedLegacy();
    const kindOf = async (kind: "receipt" | "excess") =>
      (await ctx.db.select({ id: supplierAdvanceEntries.id }).from(supplierAdvanceEntries).where(and(eq(supplierAdvanceEntries.supplierId, guangzhou), eq(supplierAdvanceEntries.kind, kind))))[0]!.id;
    const drawn = await kindOf("receipt"); // ¥40,000, allocated to A-1 and B-1
    const excess = await kindOf("excess");
    const unknown = randomUUID();
    const list = [drawn, excess, unknown].map((advanceEntryId) => ({ advanceEntryId, reason: "test" }));
    const holds = holdFoshan.map((hold) => ({ ...hold, supplierId: foshan }));

    const dry = await backfillLedger(ctx.db, { apply: false, holds, excludedReceipts: list });
    expect(dry.unresolvedExclusions).toEqual([`${drawn}: money was applied from it`, `${excess}: excess row, not a receipt`, `${unknown}: no such advance entry`]);
    await expect(backfillLedger(ctx.db, { apply: true, holds, excludedReceipts: list })).rejects.toThrow(/unresolved receipt exclusion/);
    expect(await ctx.db.select().from(supplierLedgerEntries)).toHaveLength(0);

    // A listed receipt posted anyway (a run without the list) fails the reconciliation that has the list.
    await backfill(true);
    const result = await reconcileLedger(ctx.db, [], [{ advanceEntryId: drawn, reason: "test" }]);
    expect(result.checks.find((check) => check.id === "excluded-receipts")).toMatchObject({ ok: false, problems: [`excluded receipt ${drawn}: 1 posting(s)`] });
    expect(result.ok).toBe(false);
  });
});

describe("the cutover's approved baseline (docs/operator-commands.md)", () => {
  it("ignores non-financial order, line and payment changes; lists every financial record added, removed or changed", async () => {
    const seeded = await seedLegacy();
    const before = await legacyRecords(ctx.db);
    // Receiving, moving a stage, setting terms, renumbering a line, editing a payment's mode, reference or notes.
    await ctx.db.update(orders).set({ stage: 3, deliveryDate: indiaDay(90), terms: "CNF", updatedAt: new Date() }).where(eq(orders.id, seeded.a.id));
    await ctx.db.update(orderLines).set({ position: 5 }).where(eq(orderLines.orderId, seeded.a.id));
    await ctx.db.update(payments).set({ mode: "Cash", reference: "TX-1", notes: "late note" }).where(eq(payments.id, seeded.paid.id));
    expect(baselineChanges(before, await legacyRecords(ctx.db))).toEqual([]);

    await ctx.db.update(orderLines).set({ quantity: 2 }).where(eq(orderLines.orderId, seeded.b.id));
    await ctx.db.update(orders).set({ orderDate: "2026-09-01" }).where(eq(orders.id, seeded.other.id));
    await ctx.db.delete(payments).where(eq(payments.status, "due"));
    const receipt = await legacyAdvance(hangzhou, { amount: 500 });
    const changes = baselineChanges(before, await legacyRecords(ctx.db));
    expect(changes.map(({ table, change }) => `${table} ${change}`).sort()).toEqual(["order_lines changed", "orders changed", "payments removed", "supplier_advance_entries added"]);
    expect(changes.find((row) => row.table === "order_lines")).toMatchObject({ before: { quantity: 1 }, after: { quantity: 2 } });
    expect(changes.find((row) => row.table === "supplier_advance_entries")).toMatchObject({ id: receipt.id, before: null, after: { amount: 500, kind: "receipt" } });
  });

  it("backfill --apply is refused when anything differs from the approved baseline, and posts nothing", async () => {
    const seeded = await seedLegacy();
    const approved = await legacyRecords(ctx.db);
    const holds = holdFoshan.map((hold) => ({ ...hold, supplierId: foshan }));
    await legacyPayment(seeded.other.id, 100, "2026-10-10"); // entered after the rehearsal
    const dry = await backfillLedger(ctx.db, { apply: false, holds, baseline: approved });
    expect(dry.baselineChanges).toMatchObject([{ table: "payments", change: "added", after: { amount_cny: 100 } }]);
    await expect(backfillLedger(ctx.db, { apply: true, holds, baseline: approved })).rejects.toThrow("differ from the approved baseline (1 payments added)");
    expect(await ctx.db.select().from(supplierLedgerEntries)).toHaveLength(0);
    expect(await ctx.db.select().from(supplierLedgerHolds)).toHaveLength(0);
    // Re-approved (a new rehearsal of these records): posted.
    expect(await backfillLedger(ctx.db, { apply: true, holds, baseline: await legacyRecords(ctx.db) })).toMatchObject({ baselineChanges: [], written: 7 });
  });

  it("reads only the approved file of this format, and never overwrites a baseline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-baseline-"));
    const file = join(dir, "approved.json");
    const baseline = { format: BASELINE_FORMAT, database: "test", takenAt: new Date().toISOString(), records: await legacyRecords(ctx.db) };
    const sha256 = writeBaseline(file, baseline);
    expect(readBaseline(file, sha256)).toMatchObject({ sha256, records: baseline.records });
    expect(() => readBaseline(file, "0".repeat(64))).toThrow("is not the approved baseline");
    expect(() => writeBaseline(file, { ...baseline, takenAt: "later" })).toThrow(/EEXIST/);
    expect(readBaseline(file, sha256).takenAt).toBe(baseline.takenAt); // unchanged
    const old = join(dir, "before.json");
    const text = JSON.stringify({ orders: "41 2ecc9a472d4bb50f139dc76a04196bbd" }); // the whole-row format of before
    writeFileSync(old, text);
    expect(() => readBaseline(old, createHash("sha256").update(text).digest("hex"))).toThrow(`is not a ${BASELINE_FORMAT} file`);
  });

  it("--expect: the approved legacy differences must be exactly the ones found, both amounts included", () => {
    expect(parseExpectation("6423=0:4400")).toEqual({ po: "6423", legacySettled: 0, ledgerSettled: 4_400 });
    expect(parseExpectation("PO-1134647=0:270.14")).toEqual({ po: "PO-1134647", legacySettled: 0, ledgerSettled: 270.14 });
    for (const bad of ["6423", "6423=0", "6423=0:x", "=0:1", "6423=0:1:2", "6423=0:1.234"]) expect(() => parseExpectation(bad)).toThrow("<PO>=<legacy settled>:<ledger settled>");
    const found = [
      { po: "6422", currency: "USD", legacySettled: 0, ledgerSettled: 20_600 },
      { po: "6423", currency: "USD", legacySettled: 0, ledgerSettled: 4_400 },
    ];
    const list = (...items: string[]) => items.map(parseExpectation);
    expect(unexpectedDifferences(found, list("6422=0:20600", "6423=0:4400"))).toEqual([]);
    expect(unexpectedDifferences(found, list("6423=0:4400"))).toEqual(["6422: not expected (legacy 0, ledger 20600)"]);
    expect(unexpectedDifferences(found, list("6422=0:20600", "6423=0:4500"))).toEqual(["6423: expected legacy 0, ledger 4500; found legacy 0, ledger 4400"]);
    expect(unexpectedDifferences(found, list("6422=0:20600", "6423=0:4400", "6424=0:1"))).toEqual(["6424: expected difference did not occur"]);
    expect(unexpectedDifferences(found, list("6422=0:20600", "6423=0:4400", "6423=0:4400"))).toEqual(["6423: listed more than once"]);
    expect(unexpectedDifferences([{ ...found[0]!, ledgerSettled: null }], list("6422=0:20600"))).toEqual(["6422: expected legacy 0, ledger 20600; found legacy 0, ledger not posted"]);
  });
});

describe("rollback script scripts/rollback/0017-down.sql", () => {
  const script = readFileSync("scripts/rollback/0017-down.sql", "utf8");
  // Its body (psql's \set, begin and commit left out), run inside a transaction that is always rolled back here.
  const body = script
    .split("\n")
    .filter((line) => !/^(\\set |begin;|commit;)/.test(line))
    .join("\n");
  // What the database said (drizzle's error quotes the whole script, refusal texts included, so its message proves
  // nothing): the refusal, or "ran through" when the body completed (then rolled back here).
  const outcome = (prelude = "") =>
    ctx.db
      .transaction(async (tx) => {
        if (prelude) await tx.execute(sql.raw(prelude));
        await tx.execute(sql.raw(body));
        tx.rollback(); // it ran through: undo it
      })
      .then(
        () => "committed?",
        (error: { message: string; cause?: { message: string } }) => (error.message === "Rollback" ? "ran through" : (error.cause?.message ?? error.message)),
      );
  // The test database is migrated to the latest (0018 and on); this makes it look like 0017 is the last, in the same
  // transaction that is rolled back.
  const only0017 = "delete from drizzle.__drizzle_migrations where created_at > 1795155384570";

  it("psql stops at the first error (non-zero exit), and every table is locked before the guard reads it", () => {
    const statements = script.split("\n").filter((line) => line.trim() && !line.startsWith("--"));
    expect(statements.slice(0, 2)).toEqual(["\\set ON_ERROR_STOP on", "begin;"]);
    expect(script.indexOf("lock table ledger_state, supplier_ledger_holds, supplier_ledger_entries, payments in access exclusive mode")).toBeLessThan(script.indexOf("do $$"));
  });

  it("refuses unless the ledger is in maintenance, after an application write and after a later migration, and runs through otherwise", async () => {
    const seeded = await seedLegacy();
    await backfill(true);
    expect(await outcome(only0017)).toContain("the ledger is not in maintenance"); // the harness leaves it live
    await ctx.db.execute(sql`update ledger_state set state = 'maintenance'`);
    // 0017 only: the whole body runs (then undone); with a later migration applied it refuses.
    expect(await outcome(only0017)).toBe("ran through");
    expect(await outcome()).toContain("a migration after 0017 is applied");
    expect(await ctx.db.select().from(supplierLedgerEntries)).toHaveLength(6); // and was undone
    await ctx.db.insert(supplierLedgerEntries).values({ supplierId: hangzhou, currency: "CNY", entryType: "order_adjustment", amount: -1, entryDate: indiaDay(), origin: "app", orderId: seeded.other.id, poNumber: "H-1", idempotencyKey: "test:app" });
    expect(await outcome(only0017)).toContain("application-written records");
  });
});

describe("the journal is append-only", () => {
  it("refuses UPDATE and DELETE; ORD-6's foreign key may only clear order_id", async () => {
    const seeded = await seedLegacy();
    await backfill(true);
    await expect(ctx.db.update(supplierLedgerEntries).set({ amount: 1 }).where(eq(supplierLedgerEntries.orderId, seeded.a.id))).rejects.toThrow();
    await expect(ctx.db.delete(supplierLedgerEntries).where(eq(supplierLedgerEntries.orderId, seeded.a.id))).rejects.toThrow();
    // A payment that was posted can't disappear (RESTRICT on the journal, RESTRICT from payments to orders).
    await expect(ctx.db.delete(payments).where(eq(payments.id, seeded.paid.id))).rejects.toThrow();
    await expect(ctx.db.delete(orders).where(eq(orders.id, seeded.c.id))).rejects.toThrow();
    // An order without payments: deleting it sets its postings' order_id to null and keeps them.
    await ctx.db.delete(orders).where(eq(orders.id, seeded.other.id));
    const kept = await ctx.db.select().from(supplierLedgerEntries).where(eq(supplierLedgerEntries.poNumber, "H-1"));
    expect(kept).toMatchObject([{ orderId: null, amount: -3_000 }]);
  });
});

describe("write-state guard", () => {
  it("refuses financial writes (503) while maintenance and lets them through when live", async () => {
    await ctx.db.execute(sql`update ledger_state set state = 'maintenance'`);
    await expect(ctx.db.transaction((tx) => assertLedgerLive(tx))).rejects.toMatchObject({ status: 503, code: "ledger_maintenance" });
    const body = { currency: "CNY", amount: 10, entryDate: indiaDay(), rateInr: 12, reason: "x", idempotencyKey: randomUUID() };
    expect((await http.post(`/suppliers/${guangzhou}/ledger/adjustments`, body).set("Cookie", management)).status).toBe(503);
    expect((await http.get(`/suppliers/${guangzhou}/ledger`).set("Cookie", management)).status).toBe(200);
    await ctx.db.execute(sql`update ledger_state set state = 'live'`);
    expect((await http.post(`/suppliers/${guangzhou}/ledger/adjustments`, body).set("Cookie", management)).status).toBe(201);
  });
});

describe("LED-3 Management adjustments (D13)", () => {
  const adjustment = (overrides: object = {}) => ({ currency: "CNY", amount: -500, entryDate: indiaDay(-1), rateInr: 12.5, reason: "Supplier refund by bank", idempotencyKey: randomUUID(), ...overrides });
  const post = (body: object, cookie = management, supplierId = guangzhou) => http.post(`/suppliers/${supplierId}/ledger/adjustments`, body).set("Cookie", cookie);

  it("only Management (payments Full); Accounts (Enter), Procurement (View) and staff are refused", async () => {
    expect((await post(adjustment(), accounts)).status).toBe(403);
    expect((await post(adjustment(), procurement)).status).toBe(403);
    expect((await post(adjustment(), await signInAs(ctx, SEEDED.chinaStaff))).status).toBe(403);
    expect((await http.post(`/suppliers/${guangzhou}/ledger/adjustments`, adjustment())).status).toBe(401);
  });

  it("posts a signed entry with reason, actor, server time, rate and before/after; FIFO and outstanding follow", async () => {
    const seeded = await seedLegacy();
    await backfill(true);
    const down = await post(adjustment({ amount: -22_500 }));
    expect(down.status, JSON.stringify(down.body)).toBe(201);
    expect(down.body).toMatchObject({ balanceBefore: 22_000, balanceAfter: -500, entry: { entryType: "adjustment", amount: -22_500, exchangeRate: 12.5, notes: "Supplier refund by bank", recordedBy: expect.any(String) } });
    const [row] = await ctx.db.select().from(supplierLedgerEntries).where(eq(supplierLedgerEntries.entryType, "adjustment"));
    expect(row).toMatchObject({ createdBy: userId, origin: "app", balanceBefore: 22_000, balanceAfter: -500 });
    // ¥52,000 of credits, ¥30,000 settling A (15,000), B (5,000) and C (10,000): −¥22,500 takes the free ¥22,000 and is
    // ¥500 short. The orders keep their settlement; the ¥500 is payable.
    const ledger = await loadLedger(ctx.db);
    expect(ledger.order(seeded.c.id)).toMatchObject({ settledCny: 10_000, outstandingCny: 0, paymentStatus: "paid" });
    expect(ledger.account(seeded.c.supplierId, "CNY")).toMatchObject({ balanceCny: -500, outstandingCny: 0 });
    const up = await post(adjustment({ amount: 500, reason: "Correction of the refund" }));
    expect(up.body).toMatchObject({ balanceBefore: -500, balanceAfter: 0 });
    expect((await loadLedger(ctx.db)).order(seeded.c.id)).toMatchObject({ outstandingCny: 0, paymentStatus: "paid" });
  });

  it("same key + same details returns the entry (200); same key + other details is 409; nothing is written twice", async () => {
    const body = adjustment();
    expect((await post(body)).status).toBe(201);
    const again = await post(body);
    expect(again.status).toBe(200);
    expect((await post({ ...body, amount: -501 })).body.error.code).toBe("idempotency_conflict");
    expect(await ctx.db.select().from(supplierLedgerEntries)).toHaveLength(1);
  });

  it("refuses 0, a missing reason or rate, a future date, a client-supplied actor, a held account and a currency the supplier can't use", async () => {
    const fields = async (body: object) => (await post(body)).body.error.fields ?? {};
    expect(await fields(adjustment({ amount: 0 }))).toHaveProperty("amount");
    expect(await fields(adjustment({ reason: "  " }))).toHaveProperty("reason");
    expect(await fields(adjustment({ rateInr: undefined }))).toHaveProperty("rateInr");
    expect(await fields(adjustment({ entryDate: indiaDay(2) }))).toHaveProperty("entryDate");
    expect(await fields(adjustment({ currency: "USD" }))).toHaveProperty("currency");
    // Unknown keys are refused (400, the API's strict-body rule): the actor and the time can't come from the client.
    expect((await post({ ...adjustment(), createdBy: userId })).status).toBe(400);
    expect((await post({ ...adjustment(), createdAt: "2020-01-01" })).status).toBe(400);
    await seedLegacy();
    await backfill(true);
    expect((await post(adjustment(), management, foshan)).body.error.code).toBe("account_held");
    expect(await ctx.db.select().from(supplierLedgerEntries).where(eq(supplierLedgerEntries.supplierId, foshan))).toHaveLength(0);
  });

  it("INR takes rate 1; before/after stay exact under concurrent adjustments", async () => {
    await ctx.db.update(suppliers).set({ currency: "INR", exchangeRate: 1 }).where(eq(suppliers.id, hangzhou));
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => post(adjustment({ currency: "INR", rateInr: undefined, amount: n * 100 }), management, hangzhou)));
    expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
    const rows = (await ctx.db.select().from(supplierLedgerEntries).where(eq(supplierLedgerEntries.supplierId, hangzhou))).sort((x, y) => x.balanceBefore! - y.balanceBefore!);
    let running = 0;
    for (const row of rows) {
      expect(row.exchangeRate).toBe(1);
      expect(row.balanceBefore).toBe(running);
      running += row.amount;
      expect(row.balanceAfter).toBe(running);
    }
    expect(running).toBe(1_500);
  });
});

describe("LED-1 / LED-2", () => {
  it("LED-1: accounts, entries newest first with running balances, the projection, held records; LED-2 totals leave held out", async () => {
    const seeded = await seedLegacy();
    await backfill(true);
    const statement = (await http.get(`/suppliers/${guangzhou}/ledger`).set("Cookie", procurement)).body;
    expect(statement.accounts).toMatchObject([{ currency: "CNY", balanceCny: 22_000, held: false }]);
    expect(statement.entries.at(-1)).toMatchObject({ entryType: "payment", amount: 40_000, runningBalance: 40_000, advance: { mode: "Bank" } });
    expect(statement.entries[0].runningBalance).toBe(22_000);
    expect(statement.orders.map((row: { po: string; settledCny: number }) => [row.po, row.settledCny])).toEqual([
      ["A-1", 15_000],
      ["B-1", 5_000],
      ["C-1", 10_000],
    ]);
    const memo = statement.entries.find((row: { paymentId: string }) => row.paymentId === seeded.paid.id);
    expect(memo.payment).toMatchObject({ memoPo: "C-1", voided: false });
    const held = (await http.get(`/suppliers/${foshan}/ledger`).set("Cookie", procurement)).body;
    expect(held.accounts).toMatchObject([{ currency: "CNY", held: true, balanceCny: null }]);
    expect(held.held[0]).toMatchObject({ currency: "CNY", orders: [{ po: "0000066", valueCny: 189.4 }], payments: [{ amountCny: 1_050 }], advanceEntries: [{ amount: 12_000 }] });
    expect(held.currencyOptions).toEqual([]);
    const overview = (await http.get("/supplier-ledger").set("Cookie", procurement)).body;
    expect(overview.totals).toEqual([{ currency: "CNY", accounts: 2, balanceCny: 19_000, payableCny: 3_000, availableCny: 22_000, outstandingCny: 3_000 }]);
    expect(overview.accounts.find((row: { supplierId: string }) => row.supplierId === foshan)).toMatchObject({ held: true, balanceCny: null });
    const chen = await signInAs(ctx, SEEDED.chinaStaff);
    expect((await http.get("/supplier-ledger").set("Cookie", chen)).status).toBe(403);
  });
});
