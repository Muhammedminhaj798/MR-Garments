import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { items, suppliers } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { indiaDay } from "../stock/fixtures";

// ORD-2's `ledgerBalance` and ORD-3's / ORD-5's `ledger` are money: only with payments View (docs/unified-ledger.md).
// No seeded role can open or edit orders without payments View (Management, Procurement and Accounts all have it), so
// this file takes payments away from Procurement in the permission matrix (its orders rights unchanged) to prove the
// gate through the routes. A real role with orders access and no payments View needs the same check by hand.
vi.mock("../../permissions/matrix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../permissions/matrix")>();
  return {
    ...actual,
    effectiveAccess: (...args: Parameters<typeof actual.effectiveAccess>) =>
      args[0] === "Procurement" && args[2] === "payments" ? "None" : actual.effectiveAccess(...args),
  };
});

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

let management = "";
let procurement = "";
let guangzhou = "";
let jeans = "";
beforeEach(async () => {
  await resetData(ctx);
  management = await signInAs(ctx, SEEDED.management);
  procurement = await signInAs(ctx, SEEDED.procurement);
  guangzhou = (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, "Guangzhou Textile Co.")))[0]!.id;
  jeans = (await ctx.db.select({ id: items.id }).from(items).where(eq(items.name, "Denim jeans")))[0]!.id;
});

const newOrder = (quantity: number) => ({ supplierId: guangzhou, orderDate: indiaDay(-2), deliveryDate: indiaDay(20), lines: [{ itemId: jeans, quantity, rateCny: 1 }] });

describe("supplier balances on ORD-2/3/5 need payments View", () => {
  it("without payments View: ORD-2 ledgerBalance null, ORD-3 and ORD-5 ledger null (the writes themselves still work)", async () => {
    expect((await http.get("/payments").set("Cookie", procurement)).status).toBe(403); // the mock took payments away

    const options = (await http.get("/orders/options").set("Cookie", procurement)).body;
    expect(options.suppliers.find((row: { id: string }) => row.id === guangzhou)).toMatchObject({ held: false, ledgerBalance: null });

    const created = await http.post("/orders", newOrder(100)).set("Cookie", procurement);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.ledger).toBeNull();

    const edited = await http.patch(`/orders/${encodeURIComponent(created.body.order.po)}`, { lines: [{ itemId: jeans, quantity: 150, rateCny: 1 }] }).set("Cookie", procurement);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.ledger).toBeNull();
  });

  it("with payments View (Management): the same routes carry the balances", async () => {
    const options = (await http.get("/orders/options").set("Cookie", management)).body;
    expect(options.suppliers.find((row: { id: string }) => row.id === guangzhou).ledgerBalance).toEqual([]);

    const created = await http.post("/orders", newOrder(100)).set("Cookie", management);
    expect(created.body.ledger).toMatchObject({ currency: "CNY", debitCny: 100, balanceBefore: 0, balanceAfter: -100 });

    const edited = await http.patch(`/orders/${encodeURIComponent(created.body.order.po)}`, { lines: [{ itemId: jeans, quantity: 150, rateCny: 1 }] }).set("Cookie", management);
    expect(edited.body.ledger).toMatchObject({ changeCny: -50, balanceBefore: -100, balanceAfter: -150 });
    expect((await http.get("/orders/options").set("Cookie", management)).body.suppliers.find((row: { id: string }) => row.id === guangzhou).ledgerBalance).toEqual([
      { currency: "CNY", balanceCny: -150 },
    ]);
  });
});
