import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { items, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { indiaDay } from "../stock/fixtures";
import { loadLedger, projectAccount } from "./ledger";

// The approved rule for negative Management adjustments (owner, 2026-11-20): newest credits first (LIFO). A negative
// adjustment takes, at its own date, from the newest credits that exist then; each credit keeps its own currency and
// rate; any shortfall is a deficit the next credits fill first. Orders are then settled oldest first (FIFO) from what
// is left, so goods INR follows the credits that really remain. Nothing is stored: the projection recomputes it.

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

describe("negative adjustments take the newest credits first (LIFO)", () => {
  it("partial: −¥150 empties C and half of B; the order (¥120) is settled from A, then B, at their own rates", () => {
    const { settlements, account } = projectAccount([...credits(), adjust(-150, "2026-10-10"), debit("o1", 120, "2026-10-02")], [order("o1", "2026-10-02")]);
    expect(account).toMatchObject({ creditsCny: 150, balanceCny: 30 });
    expect(settlements.get("o1")!.slices.map((slice) => [slice.amount, slice.exchangeRate])).toEqual([
      [100, 10],
      [20, 11],
    ]);
    expect(settlements.get("o1")).toMatchObject({ settledCny: 120, outstandingCny: 0, settledInr: 1_000 + 220 });
  });

  it("complete: −¥300 takes every credit; the order is unpaid and the account payable", () => {
    const { settlements, account } = projectAccount([...credits(), adjust(-300, "2026-10-10"), debit("o1", 120, "2026-10-02")], [order("o1", "2026-10-02")]);
    expect(account).toMatchObject({ creditsCny: 0, balanceCny: -120, outstandingCny: 120 });
    expect(settlements.get("o1")).toMatchObject({ settledCny: 0, outstandingCny: 120, paymentStatus: "unpaid", slices: [] });
  });

  it("beyond every credit: the ¥50 shortfall is filled by the next credit first (D, ¥100 @13 on 12 Oct)", () => {
    const { settlements } = projectAccount(
      [...credits(), adjust(-350, "2026-10-10"), pay(100, "2026-10-12", 13), debit("o1", 120, "2026-10-02")],
      [order("o1", "2026-10-02")],
    );
    expect(settlements.get("o1")!.slices.map((slice) => [slice.amount, slice.exchangeRate])).toEqual([[50, 13]]);
    expect(settlements.get("o1")).toMatchObject({ settledCny: 50, outstandingCny: 70, settledInr: 650 });
  });

  it("at its own date: a −¥150 adjustment dated 6 Oct takes B, then A; C (9 Oct, later) is untouched", () => {
    const { settlements } = projectAccount([...credits(), adjust(-150, "2026-10-06"), debit("o1", 120, "2026-10-02")], [order("o1", "2026-10-02")]);
    expect(settlements.get("o1")!.slices.map((slice) => [slice.amount, slice.exchangeRate])).toEqual([
      [50, 10],
      [70, 12],
    ]);
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

describe("LIFO through the API", () => {
  it("partial then complete consumption, rates kept, goods INR recomputed, and the USD account untouched", async () => {
    // A USD account first (an older currency of the supplier), then the supplier moves to CNY.
    await ctx.db.update(suppliers).set({ currency: "USD", exchangeRate: 84 }).where(eq(suppliers.id, guangzhou));
    const usdOrder = await placeOrder(100, indiaDay(-20));
    await supplierPay(100, indiaDay(-19), 84);
    await ctx.db.update(suppliers).set({ currency: "CNY", exchangeRate: 12 }).where(eq(suppliers.id, guangzhou));

    await supplierPay(100, indiaDay(-9), 10);
    await supplierPay(100, indiaDay(-5), 11);
    await supplierPay(100, indiaDay(-2), 12);
    const cnyOrder = await placeOrder(120, indiaDay(-8));
    expect((await slicesOf(cnyOrder.po)).slices).toEqual([
      [100, 10, 1_000],
      [20, 11, 220],
    ]);

    // −¥150: the newest credit (@12) and half of the one before (@11) go; the order still settles from @10 then @11.
    expect(await adjustBy(-150, "CNY", 12)).toMatchObject({ balanceBefore: 180, balanceAfter: 30 });
    const partial = await slicesOf(cnyOrder.po);
    expect(partial.slices).toEqual([
      [100, 10, 1_000],
      [20, 11, 220],
    ]);
    expect(partial.body).toMatchObject({ settledCny: 120, outstandingCny: 0, settledInr: 1_220 });

    // −¥100 more: what was left of @11 (50) and half of @10: the order is now ¥70 short and its goods INR follows.
    expect(await adjustBy(-100, "CNY", 12)).toMatchObject({ balanceBefore: 30, balanceAfter: -70 });
    const mostly = await slicesOf(cnyOrder.po);
    expect(mostly.slices).toEqual([[50, 10, 500]]);
    expect(mostly.body).toMatchObject({ settledCny: 50, outstandingCny: 70, paymentStatus: "partly", settledInr: 500 });

    // −¥50: complete consumption; nothing settles the order.
    await adjustBy(-50, "CNY", 12);
    const none = await slicesOf(cnyOrder.po);
    expect(none.slices).toEqual([]);
    expect(none.body).toMatchObject({ settledCny: 0, outstandingCny: 120, paymentStatus: "unpaid" });

    // The USD account (its own credit @84) never moved.
    const usd = await slicesOf(usdOrder.po);
    expect(usd.slices).toEqual([[100, 84, 8_400]]);
    const ledger = await loadLedger(ctx.db, { supplierIds: [guangzhou] });
    expect(ledger.account(guangzhou, "USD")).toMatchObject({ balanceCny: 0, creditsCny: 100 });
    expect(ledger.account(guangzhou, "CNY")).toMatchObject({ balanceCny: -120, creditsCny: 0 });
  });
});
