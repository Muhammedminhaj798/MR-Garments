import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, supplierLedgerEntries as entries, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { indiaDay } from "../stock/fixtures";
import { loadLedger, projectAccount } from "./ledger";

// The approved rules for negative Management adjustments (owner: LIFO 2026-11-20; M7 and "oldest obligation first"
// 2026-11-21). A negative adjustment's take is worked out as of when it was recorded: from the credits dated on or
// before it and recorded before it, after the orders and earlier shortfalls of its date have settled the oldest of
// them, it takes what is free, newest first; each credit keeps its own currency and rate. No credit is taken twice: it
// never takes money that settled an order or a shortfall dated on or before it, nor a credit dated after it or
// recorded after it. What it can't cover stays payable from its date (a shortfall). Later credits reduce it through
// ordinary settlement: orders and shortfalls together, oldest obligation first. A void cancels its payment where it
// stands, and every adjustment is recalculated without it. Nothing is stored: the projection recomputes it.

type Row = Parameters<typeof projectAccount>[0][number];
let seq = 0;
const row = (entryType: Row["entryType"], amount: number, entryDate: string, extra: Partial<Row> = {}): Row => ({
  id: `00000000-0000-0000-0000-${String(++seq).padStart(12, "0")}`,
  supplierId: "s",
  currency: "CNY",
  entryType,
  amount,
  exchangeRate: null,
  entryDate,
  createdKey: `${entryDate} 00:00:00.${String(seq).padStart(6, "0")}`,
  paymentId: entryType === "payment" ? `p${seq}` : null,
  advanceEntryId: null,
  orderId: null,
  reversesId: null,
  ...extra,
});
const pay = (amount: number, day: string, rate: number) => row("payment", amount, day, { exchangeRate: rate });
const adjust = (amount: number, day: string) => row("adjustment", amount, day, { exchangeRate: 12 });
const debit = (orderId: string, value: number, day: string) => row("order_debit", -value, day, { orderId });
const order = (id: string, day: string) => ({ id, supplierId: "s", currency: "CNY", orderDate: day, createdKey: `${day} 00:00:00.${String(++seq).padStart(6, "0")}` });

// Three credits on different days at different rates: A ¥100 @10 (1 Oct), B ¥100 @11 (5 Oct), C ¥100 @12 (9 Oct).
const credits = () => [pay(100, "2026-10-01", 10), pay(100, "2026-10-05", 11), pay(100, "2026-10-09", 12)];

const sliced = (settlement: { slices: { amount: number; exchangeRate: number | null; amountInr: number | null }[] } | undefined) =>
  settlement!.slices.map((slice) => [slice.amount, slice.exchangeRate, slice.amountInr]);

describe("negative adjustments take only free credits available at their date; oldest obligation first", () => {
  it("sufficient credits: o1 (¥120) has A and ¥20 of B; −¥150 takes the free C and ¥50 of B, newest first", () => {
    const { settlements, account, shortfallCny } = projectAccount([...credits(), adjust(-150, "2026-10-10"), debit("o1", 120, "2026-10-02")], [order("o1", "2026-10-02")]);
    expect(account).toMatchObject({ creditsCny: 150, debitsCny: 120, balanceCny: 30, paidInr: 1_000 + 1_100 + 1_200 });
    expect(shortfallCny).toBe(0);
    expect(sliced(settlements.get("o1"))).toEqual([
      [100, 10, 1_000],
      [20, 11, 220],
    ]);
    expect(settlements.get("o1")).toMatchObject({ settledCny: 120, outstandingCny: 0, settledInr: 1_220 });
  });

  it("more than the free credits: −¥300 takes the free ¥180; o1 keeps A and B (no credit is taken twice); ¥120 is payable", () => {
    const { settlements, account, shortfallCny } = projectAccount([...credits(), adjust(-300, "2026-10-10"), debit("o1", 120, "2026-10-02")], [order("o1", "2026-10-02")]);
    expect(account).toMatchObject({ creditsCny: 0, balanceCny: -120, outstandingCny: 0 });
    expect(shortfallCny).toBe(120);
    expect(sliced(settlements.get("o1"))).toEqual([
      [100, 10, 1_000],
      [20, 11, 220],
    ]);
    expect(settlements.get("o1")).toMatchObject({ settledCny: 120, paymentStatus: "paid" });
  });

  it("future-dated credits are not taken: −¥150 on 6 Oct takes B's free ¥80 and is ¥70 short; C (9 Oct) settles that shortfall", () => {
    const { settlements, account, shortfallCny } = projectAccount([...credits(), adjust(-150, "2026-10-06"), debit("o1", 120, "2026-10-02")], [order("o1", "2026-10-02")]);
    expect(sliced(settlements.get("o1"))).toEqual([
      [100, 10, 1_000],
      [20, 11, 220],
    ]);
    expect(shortfallCny).toBe(0);
    expect(account).toMatchObject({ balanceCny: 30, outstandingCny: 0 });
  });

  it("insufficient credits: −¥350 takes the free ¥180; ¥170 stays payable from 10 Oct, and nothing later is taken", () => {
    const { settlements, account, shortfallCny } = projectAccount([...credits(), adjust(-350, "2026-10-10"), debit("o1", 120, "2026-10-02")], [order("o1", "2026-10-02")]);
    expect(account).toMatchObject({ creditsCny: -50, balanceCny: -170, outstandingCny: 0, openOrders: 0 });
    expect(shortfallCny).toBe(170);
    expect(settlements.get("o1")).toMatchObject({ settledCny: 120, outstandingCny: 0, paymentStatus: "paid" });
  });

  it("later credits reduce the negative balance through ordinary settlement, oldest obligation first", () => {
    // −¥350 on 10 Oct is ¥170 short. o2 (¥80, 11 Oct) is newer than the shortfall. D @13 (12 Oct), E @14 (14 Oct).
    const base = [...credits(), adjust(-350, "2026-10-10"), debit("o1", 120, "2026-10-02"), debit("o2", 80, "2026-10-11")];
    const orders = () => [order("o1", "2026-10-02"), order("o2", "2026-10-11")];
    const d = pay(100, "2026-10-12", 13);
    const withD = projectAccount([...base, d], orders());
    // D goes to the shortfall (10 Oct, older than o2): ¥70 still short; o2 waits.
    expect(withD.shortfallCny).toBe(70);
    expect(withD.settlements.get("o2")).toMatchObject({ settledCny: 0, outstandingCny: 80 });
    expect(withD.account).toMatchObject({ balanceCny: -150, outstandingCny: 80 });
    const withE = projectAccount([...base, d, pay(100, "2026-10-14", 14)], orders());
    // E: the shortfall's last ¥70, then ¥30 of o2, at E's own rate.
    expect(withE.shortfallCny).toBe(0);
    expect(sliced(withE.settlements.get("o2"))).toEqual([[30, 14, 420]]);
    expect(sliced(withE.settlements.get("o1"))).toEqual([
      [100, 10, 1_000],
      [20, 11, 220],
    ]);
    expect(withE.account).toMatchObject({ balanceCny: -50, outstandingCny: 50, paidInr: 1_000 + 1_100 + 1_200 + 1_300 + 1_400 });
  });

  it("the owner's example: the 5 Oct credit settles the 2 Oct shortfall, then the 3 Oct order; the 6 Oct adjustment can't take it again", () => {
    const c = pay(100, "2026-10-05", 12);
    const entries = [adjust(-50, "2026-10-02"), debit("o", 120, "2026-10-03"), c, adjust(-100, "2026-10-06")];
    const orders = () => [order("o", "2026-10-03")];
    const { settlements, account, shortfallCny } = projectAccount(entries, orders());
    // Payable ¥170: the 6 Oct shortfall ¥100 and the order's ¥70.
    expect(shortfallCny).toBe(100);
    expect(sliced(settlements.get("o"))).toEqual([[50, 12, 600]]);
    expect(settlements.get("o")).toMatchObject({ settledCny: 50, outstandingCny: 70, paymentStatus: "partly" });
    expect(account).toMatchObject({ balanceCny: -170, outstandingCny: 70 });
    // A later credit (D ¥100 @13, 8 Oct) goes to the oldest obligation first: the order's ¥70, then ¥30 of the shortfall.
    const later = projectAccount([...entries, pay(100, "2026-10-08", 13)], orders());
    expect(sliced(later.settlements.get("o"))).toEqual([
      [50, 12, 600],
      [70, 13, 910],
    ]);
    expect(later.shortfallCny).toBe(70);
    expect(later.account).toMatchObject({ balanceCny: -70, outstandingCny: 0 });
  });

  it("an adjustment recorded later but dated earlier can't take what an adjustment recorded before it took", () => {
    // A ¥100 (1 Oct). −¥50 dated 8 Oct takes ¥50 of A. Then, recorded on 12 Oct but dated 4 Oct, −¥80: only A's other
    // ¥50 is left to take; ¥30 is short from 4 Oct.
    const { account, shortfallCny } = projectAccount(
      [pay(100, "2026-10-01", 10), adjust(-50, "2026-10-08"), { ...adjust(-80, "2026-10-04"), createdKey: "2026-10-12 00:00:00.000001" }],
      [],
    );
    expect(shortfallCny).toBe(30);
    expect(account).toMatchObject({ creditsCny: -30, balanceCny: -30 });
  });

  it("a later credit never changes what the adjustment took: o1 still settles from A and B, the new credit is left over", () => {
    const { settlements, account } = projectAccount(
      [...credits(), adjust(-150, "2026-10-10"), pay(100, "2026-10-12", 15), debit("o1", 120, "2026-10-02")],
      [order("o1", "2026-10-02")],
    );
    expect(sliced(settlements.get("o1"))).toEqual([
      [100, 10, 1_000],
      [20, 11, 220],
    ]);
    expect(account).toMatchObject({ balanceCny: 130 });
  });

  it("a credit recorded after the adjustment never changes its take, even dated before it", () => {
    // o ¥200 (3 Oct) has Z1 ¥100 @11 (6 Oct) and Z2 ¥100 @12 (8 Oct) when −¥100 is recorded on 10 Oct: nothing is free,
    // so it is ¥100 short. Later, X ¥200 @10 dated 5 Oct is recorded (15 Oct), and o2 ¥100 (11 Oct) is placed.
    const x = { ...pay(200, "2026-10-05", 10), createdKey: "2026-10-15 00:00:00.000001" };
    const { settlements, account, shortfallCny } = projectAccount(
      [debit("o", 200, "2026-10-03"), pay(100, "2026-10-06", 11), pay(100, "2026-10-08", 12), adjust(-100, "2026-10-10"), x, debit("o2", 100, "2026-10-11")],
      [order("o", "2026-10-03"), order("o2", "2026-10-11")],
    );
    // Its take stays "¥100 short" (it never takes Z2, freed by X): X settles o, Z1 the shortfall, Z2 o2.
    expect(sliced(settlements.get("o"))).toEqual([[200, 10, 2_000]]);
    expect(shortfallCny).toBe(0);
    expect(sliced(settlements.get("o2"))).toEqual([[100, 12, 1_200]]);
    expect(account).toMatchObject({ balanceCny: 0, outstandingCny: 0 });
  });

  it("a credit recorded after the adjustment on its own day, or backdated before it, is not taken by it: it settles the shortfall", () => {
    // A settled o1 (2 Oct) before −¥100 (10 Oct) was recorded: nothing free, ¥100 short. B ¥100 @11 (dated 5 Oct,
    // recorded 15 Oct) settles the shortfall; S ¥50 @12 (10 Oct, recorded after the adjustment) is left over.
    const a = pay(100, "2026-10-01", 10);
    const { settlements, account, shortfallCny } = projectAccount(
      [
        a,
        adjust(-100, "2026-10-10"),
        { ...pay(100, "2026-10-05", 11), createdKey: "2026-10-15 00:00:00.000001" },
        { ...pay(50, "2026-10-10", 12), createdKey: "2026-10-10 23:59:59.000001" },
        debit("o1", 100, "2026-10-02"),
      ],
      [order("o1", "2026-10-02")],
    );
    expect(sliced(settlements.get("o1"))).toEqual([[100, 10, 1_000]]);
    expect(settlements.get("o1")!.slices[0]!.entryId).toBe(a.id);
    expect(shortfallCny).toBe(0);
    expect(account).toMatchObject({ balanceCny: 50, outstandingCny: 0 });
  });

  it("a void after a negative adjustment: recalculated without C, it takes B's free ¥80 and is ¥70 short; D (after it) settles that", () => {
    const [a, b, c] = credits();
    const voidC = row("payment_void", -100, "2026-10-15", { exchangeRate: 12, paymentId: c!.paymentId, reversesId: c!.id });
    const { settlements, account, shortfallCny } = projectAccount(
      [a!, b!, c!, adjust(-150, "2026-10-10"), pay(100, "2026-10-12", 13), voidC, debit("o1", 120, "2026-10-02")],
      [order("o1", "2026-10-02")],
    );
    expect(sliced(settlements.get("o1"))).toEqual([
      [100, 10, 1_000],
      [20, 11, 220],
    ]);
    expect(settlements.get("o1")).toMatchObject({ settledCny: 120, outstandingCny: 0, paymentStatus: "paid", settledInr: 1_220 });
    expect(shortfallCny).toBe(0);
    // Balances in the account's currency and the INR paid (payments less their voids, each at its own rate).
    expect(account).toMatchObject({ creditsCny: 150, debitsCny: 120, balanceCny: 30, outstandingCny: 0, paidInr: 1_000 + 1_100 + 1_300 });
  });

  it("a void that leaves nothing free: −¥150 is all short from 10 Oct; o1 (older) takes D first, then the shortfall D and E", () => {
    const [a, b] = credits();
    const voidB = row("payment_void", -100, "2026-10-15", { exchangeRate: 11, paymentId: b!.paymentId, reversesId: b!.id });
    const { settlements, account, shortfallCny } = projectAccount(
      [a!, b!, adjust(-150, "2026-10-10"), pay(100, "2026-10-12", 13), pay(100, "2026-10-14", 14), voidB, debit("o1", 120, "2026-10-02")],
      [order("o1", "2026-10-02")],
    );
    expect(sliced(settlements.get("o1"))).toEqual([
      [100, 10, 1_000],
      [20, 13, 260],
    ]);
    expect(shortfallCny).toBe(0);
    expect(account).toMatchObject({ creditsCny: 150, balanceCny: 30, outstandingCny: 0, paidInr: 1_000 + 1_300 + 1_400 });
  });

  it("a void of a payment dated after the adjustment leaves what the adjustment took as it was", () => {
    const d = pay(100, "2026-10-12", 13);
    const { settlements, account } = projectAccount(
      [...credits(), adjust(-150, "2026-10-10"), d, row("payment_void", -100, "2026-10-15", { exchangeRate: 13, paymentId: d.paymentId, reversesId: d.id }), debit("o1", 120, "2026-10-02")],
      [order("o1", "2026-10-02")],
    );
    expect(sliced(settlements.get("o1"))).toEqual([
      [100, 10, 1_000],
      [20, 11, 220],
    ]);
    expect(account).toMatchObject({ balanceCny: 30, paidInr: 1_000 + 1_100 + 1_200 });
  });

  it("a positive adjustment after a shortfall is a credit like any other: it settles the oldest open obligation, at its own rate", () => {
    const { settlements, account, shortfallCny } = projectAccount(
      [pay(100, "2026-10-01", 10), adjust(-150, "2026-10-10"), row("adjustment", 80, "2026-10-12", { exchangeRate: 14 }), debit("o1", 100, "2026-10-02")],
      [order("o1", "2026-10-02")],
    );
    // A settled o1 before the adjustment, so all ¥150 is short; the +¥80 reduces it to ¥70.
    expect(settlements.get("o1")!.slices.map((slice) => [slice.entryType, slice.amount, slice.exchangeRate, slice.amountInr])).toEqual([["payment", 100, 10, 1_000]]);
    expect(shortfallCny).toBe(70);
    expect(account).toMatchObject({ balanceCny: -70, outstandingCny: 0 });
  });

  it("a void larger than its payment (never written by the app) still leaves the lots matching the balance", () => {
    const paid = pay(100, "2026-10-05", 11);
    const { settlements, account, shortfallCny } = projectAccount(
      [pay(100, "2026-10-01", 10), paid, row("payment_void", -150, "2026-10-15", { exchangeRate: 11, paymentId: paid.paymentId, reversesId: paid.id }), debit("o1", 120, "2026-10-02")],
      [order("o1", "2026-10-02")],
    );
    expect(account).toMatchObject({ creditsCny: 50, balanceCny: -70, outstandingCny: 20 });
    expect(shortfallCny).toBe(50);
    expect(settlements.get("o1")).toMatchObject({ settledCny: 100, outstandingCny: 20 });
  });

  it("a deleted order stays in the view of an adjustment recorded while it existed: the delete doesn't change its take", () => {
    // A ¥100 @10 (1 Oct), B ¥100 @11 (2 Oct); o1 ¥200 (3 Oct) has both when −¥100 is recorded on 10 Oct: ¥100 short.
    // o1 is deleted on 15 Oct (ORD-6: its postings keep the PO, order_id null). o2 ¥100 (11 Oct).
    const { settlements, account, shortfallCny } = projectAccount(
      [
        pay(100, "2026-10-01", 10),
        pay(100, "2026-10-02", 11),
        row("order_debit", -200, "2026-10-03", { idempotencyKey: "order:o1:debit" }),
        adjust(-100, "2026-10-10"),
        row("order_cancel", 200, "2026-10-15", { idempotencyKey: "order:o1:cancel" }),
        debit("o2", 100, "2026-10-11"),
      ],
      [order("o2", "2026-10-11")],
    );
    // The take stays "¥100 short": the shortfall (10 Oct) gets A, o2 (11 Oct) gets B.
    expect(sliced(settlements.get("o2"))).toEqual([[100, 11, 1_100]]);
    expect(shortfallCny).toBe(0);
    expect(account).toMatchObject({ balanceCny: 0, outstandingCny: 0 });
  });

  it("two shortfalls recorded out of date order settle by date: a later credit pays the earlier-dated one first", () => {
    // −¥50 dated 8 Oct (recorded 8 Oct) and −¥30 dated 4 Oct (recorded 12 Oct), no credits: both short. C ¥50 (14 Oct).
    const { account, shortfallCny } = projectAccount(
      [adjust(-50, "2026-10-08"), { ...adjust(-30, "2026-10-04"), createdKey: "2026-10-12 00:00:00.000001" }, pay(50, "2026-10-14", 12)],
      [],
    );
    // C: the 4 Oct shortfall (¥30), then ¥20 of the 8 Oct one.
    expect(shortfallCny).toBe(30);
    expect(account).toMatchObject({ balanceCny: -30 });
  });

  it("a void ripples through two adjustments: each is recalculated from the credits of its own date", () => {
    // A ¥100 (1 Oct), B ¥100 (3 Oct). −¥100 (5 Oct) takes B (newest); −¥100 (7 Oct) takes A. o ¥50 (9 Oct).
    const b = pay(100, "2026-10-03", 11);
    const base = [pay(100, "2026-10-01", 10), b, adjust(-100, "2026-10-05"), adjust(-100, "2026-10-07"), debit("o", 50, "2026-10-09")];
    const before = projectAccount(base, [order("o", "2026-10-09")]);
    expect(before.shortfallCny).toBe(0);
    expect(before.account).toMatchObject({ balanceCny: -50, outstandingCny: 50 });
    // Voiding B: the first now takes A, the second finds nothing and is ¥100 short (7 Oct). D ¥100 (10 Oct) goes to that
    // shortfall first (older than o).
    const voidB = row("payment_void", -100, "2026-10-12", { exchangeRate: 11, paymentId: b.paymentId, reversesId: b.id });
    const after = projectAccount([...base, voidB], [order("o", "2026-10-09")]);
    expect(after.shortfallCny).toBe(100);
    expect(after.account).toMatchObject({ balanceCny: -150, outstandingCny: 50 });
    const paid = projectAccount([...base, voidB, pay(100, "2026-10-10", 13)], [order("o", "2026-10-09")]);
    expect(paid.shortfallCny).toBe(0);
    expect(paid.settlements.get("o")).toMatchObject({ settledCny: 0, outstandingCny: 50 });
    expect(paid.account).toMatchObject({ balanceCny: -50 });
  });

  it("a backdated adjustment is older than an order dated after it: it takes the credit that order had (oldest obligation first)", () => {
    // A ¥100 @10 (1 Oct) settles o (5 Oct). −¥100 dated 3 Oct is recorded on 20 Oct: on 3 Oct A was free.
    const { settlements, account, shortfallCny } = projectAccount(
      [pay(100, "2026-10-01", 10), debit("o", 100, "2026-10-05"), { ...adjust(-100, "2026-10-03"), createdKey: "2026-10-20 00:00:00.000001" }],
      [order("o", "2026-10-05")],
    );
    expect(shortfallCny).toBe(0);
    expect(settlements.get("o")).toMatchObject({ settledCny: 0, outstandingCny: 100, paymentStatus: "unpaid" });
    expect(account).toMatchObject({ balanceCny: -100 });
  });

  it("a positive adjustment is a credit of its own, at its own rate, settled in date order", () => {
    const { settlements } = projectAccount(
      [pay(100, "2026-10-01", 10), row("adjustment", 50, "2026-10-03", { exchangeRate: 14 }), debit("o1", 150, "2026-10-02")],
      [order("o1", "2026-10-02")],
    );
    expect(settlements.get("o1")!.slices.map((slice) => [slice.entryType, slice.amount, slice.exchangeRate])).toEqual([
      ["payment", 100, 10],
      ["adjustment", 50, 14],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Through the routes: PAY-2 credits, ORD-3 debits, LED-3 adjustments, ORD-4's slices; each currency apart.

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let accounts = "";
let guangzhou = "";
let jeans = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  accounts = await signInAs(ctx, SEEDED.accounts);
  guangzhou = (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, "Guangzhou Textile Co.")))[0]!.id;
  jeans = (await ctx.db.select({ id: items.id }).from(items).where(eq(items.name, "Denim jeans")))[0]!.id;
});

const supplierPay = async (amount: number, paidOn: string, rateInr: number, currency?: string) => {
  const res = await http
    .post("/payments", { supplierId: guangzhou, amount, paidOn, rateInr, mode: "Bank", clientRequestId: randomUUID(), ...(currency ? { currency } : {}) })
    .set("Cookie", accounts);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.payment as { id: string };
};
const placeOrder = async (value: number, orderDate: string) => {
  const res = await http
    .post("/orders", { supplierId: guangzhou, orderDate, deliveryDate: indiaDay(30), lines: [{ itemId: jeans, quantity: value, rateCny: 1 }] })
    .set("Cookie", management);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.order as { id: string; po: string };
};
const adjustBy = async (amount: number, currency: string, rateInr: number, entryDate = indiaDay()) => {
  const res = await http
    .post(`/suppliers/${guangzhou}/ledger/adjustments`, { currency, amount, entryDate, rateInr, reason: "Supplier refund", idempotencyKey: randomUUID() })
    .set("Cookie", management);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { balanceBefore: number; balanceAfter: number };
};
const slicesOf = async (po: string) => {
  const body = (await http.get(`/orders/${encodeURIComponent(po)}`).set("Cookie", management)).body;
  return { body, slices: (body.slices as { amount: number; exchangeRate: number; amountInr: number }[]).map((slice) => [slice.amount, slice.exchangeRate, slice.amountInr]) };
};

describe("negative adjustments through the API", () => {
  const ledgerOf = async (currency = "CNY") => (await loadLedger(ctx.db, { supplierIds: [guangzhou] })).account(guangzhou, currency);

  it("rates kept; an adjustment never takes money that settled an order: the excess is payable; the USD account is untouched", async () => {
    // A USD account first (an older currency of the supplier), then the supplier moves to CNY.
    await ctx.db.update(suppliers).set({ currency: "USD", exchangeRate: 84 }).where(eq(suppliers.id, guangzhou));
    const usdOrder = await placeOrder(100, indiaDay(-20));
    await supplierPay(100, indiaDay(-19), 84);
    await ctx.db.update(suppliers).set({ currency: "CNY", exchangeRate: 12 }).where(eq(suppliers.id, guangzhou));

    await supplierPay(100, indiaDay(-9), 10);
    await supplierPay(100, indiaDay(-5), 11);
    await supplierPay(100, indiaDay(-2), 12);
    const cnyOrder = await placeOrder(120, indiaDay(-8));
    const settled = [
      [100, 10, 1_000],
      [20, 11, 220],
    ];
    expect((await slicesOf(cnyOrder.po)).slices).toEqual(settled);

    // −¥150: the free @12 credit and ¥50 of the @11 one (newest first); the order keeps @10 and ¥20 of @11.
    expect(await adjustBy(-150, "CNY", 12)).toMatchObject({ balanceBefore: 180, balanceAfter: 30 });
    expect((await slicesOf(cnyOrder.po)).body).toMatchObject({ settledCny: 120, outstandingCny: 0, settledInr: 1_220 });
    // −¥100: only ¥30 is free; ¥70 is payable. The order's credits are never taken: it stays paid at the same rates.
    expect(await adjustBy(-100, "CNY", 12)).toMatchObject({ balanceBefore: 30, balanceAfter: -70 });
    expect(await adjustBy(-50, "CNY", 12)).toMatchObject({ balanceBefore: -70, balanceAfter: -120 });
    const after = await slicesOf(cnyOrder.po);
    expect(after.slices).toEqual(settled);
    expect(after.body).toMatchObject({ settledCny: 120, outstandingCny: 0, paymentStatus: "paid" });
    expect(await ledgerOf()).toMatchObject({ balanceCny: -120, creditsCny: 0, outstandingCny: 0 });

    // The USD account (its own credit @84) never moved.
    expect((await slicesOf(usdOrder.po)).slices).toEqual([[100, 84, 8_400]]);
    expect(await ledgerOf("USD")).toMatchObject({ balanceCny: 0, creditsCny: 100 });
  });

  it("the owner's example: the 5th's credit settles the 2nd's shortfall, then the 3rd's order; the 6th's adjustment can't take it again; retries post once", async () => {
    const adjustment = (amount: number, entryDate: string) => ({ currency: "CNY", amount, entryDate, rateInr: 12, reason: "Supplier refund", idempotencyKey: randomUUID() });
    const postAdjustment = (body: object) => http.post(`/suppliers/${guangzhou}/ledger/adjustments`, body).set("Cookie", management);
    const first = adjustment(-50, indiaDay(-10));
    expect((await postAdjustment(first)).status).toBe(201);
    const order = await placeOrder(120, indiaDay(-9));
    const payment = { supplierId: guangzhou, amount: 100, paidOn: indiaDay(-7), rateInr: 12, mode: "Bank", clientRequestId: randomUUID() };
    expect((await http.post("/payments", payment).set("Cookie", accounts)).status).toBe(201);
    const second = adjustment(-100, indiaDay(-6));
    expect((await postAdjustment(second)).status).toBe(201);

    // Retries (the same keys and details) answer 200 and write nothing.
    expect((await http.post("/payments", payment).set("Cookie", accounts)).status).toBe(200);
    const retried = await postAdjustment(second);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ balanceBefore: -70, balanceAfter: -170 });
    expect((await postAdjustment(first)).status).toBe(200);
    expect(await ctx.db.select().from(entries).where(and(eq(entries.supplierId, guangzhou), eq(entries.entryType, "adjustment")))).toHaveLength(2);
    expect(await ctx.db.select().from(entries).where(and(eq(entries.supplierId, guangzhou), eq(entries.entryType, "payment")))).toHaveLength(1);

    // Payable ¥170: the 6th's shortfall ¥100 and the order's ¥70.
    const now = await slicesOf(order.po);
    expect(now.slices).toEqual([[50, 12, 600]]);
    expect(now.body).toMatchObject({ settledCny: 50, outstandingCny: 70, paymentStatus: "partly" });
    expect(await ledgerOf()).toMatchObject({ balanceCny: -170, outstandingCny: 70 });

    // A later credit goes to the oldest obligation first: the order's ¥70, then ¥30 of the shortfall.
    await supplierPay(100, indiaDay(-5), 13);
    const later = await slicesOf(order.po);
    expect(later.slices).toEqual([
      [50, 12, 600],
      [70, 13, 910],
    ]);
    expect(later.body).toMatchObject({ settledCny: 120, outstandingCny: 0, paymentStatus: "paid", settledInr: 1_510 });
    expect(await ledgerOf()).toMatchObject({ balanceCny: -70, outstandingCny: 0, paidInr: 1_200 + 1_300 });
  });

  it("a void recalculates the adjustment from the credits of its date; the payment can't be voided twice", async () => {
    const order = await placeOrder(120, indiaDay(-8));
    await supplierPay(100, indiaDay(-9), 10);
    const voidable = await supplierPay(100, indiaDay(-6), 11);
    expect(await adjustBy(-150, "CNY", 12, indiaDay(-4))).toMatchObject({ balanceBefore: 80, balanceAfter: -70 });
    // −¥150 took the @11 credit's free ¥80 (the order has @10 and ¥20 of @11) and is ¥70 short.
    expect((await slicesOf(order.po)).slices).toEqual([
      [100, 10, 1_000],
      [20, 11, 220],
    ]);

    const voidIt = () => http.delete(`/payments/${voidable.id}`, { reason: "Recorded twice" }).set("Cookie", management);
    const voided = await voidIt();
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.ledger).toMatchObject({ balanceBefore: -70, balanceAfter: -170 });
    // Without @11, nothing was free when the adjustment was recorded: all ¥150 is short, and the order keeps only @10.
    const after = await slicesOf(order.po);
    expect(after.slices).toEqual([[100, 10, 1_000]]);
    expect(after.body).toMatchObject({ settledCny: 100, outstandingCny: 20, paymentStatus: "partly" });
    const again = await voidIt();
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_voided");
    expect(await ctx.db.select().from(entries).where(eq(entries.entryType, "payment_void"))).toHaveLength(1);
    expect((await slicesOf(order.po)).slices).toEqual([[100, 10, 1_000]]);
    expect(await ledgerOf()).toMatchObject({ balanceCny: -170, outstandingCny: 20, paidInr: 1_000 });
  });

  it("a credit recorded after the adjustment with an earlier date never changes what the adjustment took", async () => {
    const order = await placeOrder(200, indiaDay(-10));
    await supplierPay(100, indiaDay(-6), 11);
    await supplierPay(100, indiaDay(-5), 12);
    // The order has both credits: −¥100 finds nothing free and is ¥100 short.
    expect(await adjustBy(-100, "CNY", 12, indiaDay(-4))).toMatchObject({ balanceBefore: 0, balanceAfter: -100 });
    // Recorded now, dated the −8th: it settles the order (oldest), the @11 credit then the shortfall, the @12 one o2.
    await supplierPay(200, indiaDay(-8), 10);
    const o2 = await placeOrder(100, indiaDay(-3));
    expect((await slicesOf(order.po)).slices).toEqual([[200, 10, 2_000]]);
    expect((await slicesOf(o2.po)).slices).toEqual([[100, 12, 1_200]]);
    expect(await ledgerOf()).toMatchObject({ balanceCny: 0, outstandingCny: 0 });
  });

  it("each currency settles apart: a USD credit never touches the CNY shortfall; a CNY credit settles it in date order", async () => {
    await ctx.db.update(suppliers).set({ currency: "USD", exchangeRate: 84 }).where(eq(suppliers.id, guangzhou));
    const usdOrder = await placeOrder(100, indiaDay(-20));
    await ctx.db.update(suppliers).set({ currency: "CNY", exchangeRate: 12 }).where(eq(suppliers.id, guangzhou));
    const cnyOrder = await placeOrder(120, indiaDay(-8));
    await supplierPay(100, indiaDay(-9), 10);
    expect(await adjustBy(-150, "CNY", 12, indiaDay(-4))).toMatchObject({ balanceAfter: -170 });
    // A USD payment: the USD order only.
    await supplierPay(100, indiaDay(-3), 84, "USD");
    expect((await slicesOf(usdOrder.po)).slices).toEqual([[100, 84, 8_400]]);
    expect((await slicesOf(cnyOrder.po)).body).toMatchObject({ settledCny: 100, outstandingCny: 20 });
    expect(await ledgerOf()).toMatchObject({ balanceCny: -170, outstandingCny: 20 });
    expect(await ledgerOf("USD")).toMatchObject({ balanceCny: 0, outstandingCny: 0 });
    // A CNY payment: the CNY order's ¥20 (older), then ¥80 of the ¥150 shortfall.
    await supplierPay(100, indiaDay(-2), 13);
    expect((await slicesOf(cnyOrder.po)).slices).toEqual([
      [100, 10, 1_000],
      [20, 13, 260],
    ]);
    expect(await ledgerOf()).toMatchObject({ balanceCny: -70, outstandingCny: 0 });
    expect(await ledgerOf("USD")).toMatchObject({ balanceCny: 0, paidInr: 8_400 });
  });
});
