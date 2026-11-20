import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { orders, supplierAdvanceEntries, supplierLedgerHolds, suppliers, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { indiaDay, makeOrder } from "../stock/fixtures";
import { MESSAGES } from "./advances.routes";

// The supplier advance account is a read-only archive since the unified ledger (docs/unified-ledger.md): ADV-1 lists
// the legacy entries as they are, ADV-5 is the Record payment supplier list, and ADV-2, ADV-3 and ADV-4 answer 410.
// The archive rows here are written straight to the table, as migration 0014's routes wrote them.

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
  const id = async (name: string) => (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, name)))[0]!.id;
  guangzhou = await id("Guangzhou Textile Co.");
  hangzhou = await id("Hangzhou Knits");
});

const get = (path: string, cookie = management) => http.get(path).set("Cookie", cookie);
const legacy = async (values: Partial<typeof supplierAdvanceEntries.$inferInsert>) =>
  (
    await ctx.db
      .insert(supplierAdvanceEntries)
      .values({ supplierId: guangzhou, kind: "receipt", amount: 10_000, currency: "CNY", exchangeRate: 12.5, entryDate: indiaDay(-10), mode: "Bank transfer", ...values })
      .returning()
  )[0]!;

describe("ADV-1 GET /suppliers/:supplierId/advances (archive)", () => {
  it("needs payments View: 401 signed out, 403 for staff, 200 for Procurement; 404 for an unknown supplier", async () => {
    expect((await http.get(`/suppliers/${guangzhou}/advances`)).status).toBe(401);
    expect((await get(`/suppliers/${guangzhou}/advances`, await signInAs(ctx, SEEDED.chinaStaff))).status).toBe(403);
    expect((await get(`/suppliers/${guangzhou}/advances`, procurement)).status).toBe(200);
    expect((await get(`/suppliers/${randomUUID()}/advances`)).status).toBe(404);
    expect((await get("/suppliers/not-an-id/advances")).status).toBe(404);
  });

  it("lists every legacy entry oldest first, with the order's current PO (a deleted order's stored one), INR and who recorded it", async () => {
    const anita = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, SEEDED.accounts)))[0]!.id;
    const order = await makeOrder(ctx, { lines: [{ item: "Denim jeans", quantity: 100, rateCny: 30 }] });
    const receipt = await legacy({ reference: "UTR-1", notes: "Season advance", createdBy: anita });
    const base = { kind: "allocation" as const, amount: 3000, advanceId: receipt.id, entryDate: indiaDay(-5), mode: "" };
    await legacy({ ...base, orderId: order.id, poNumber: order.po });
    await legacy({ ...base, amount: 500, poNumber: "PO-GONE" });
    await legacy({ supplierId: hangzhou, amount: 1 }); // another supplier's: not here
    await ctx.db.update(orders).set({ poNumber: "PO-RENAMED" }).where(eq(orders.id, order.id));

    const res = await get(`/suppliers/${guangzhou}/advances`, procurement);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["supplier", "entries"]);
    expect(res.body.supplier).toEqual({ id: guangzhou, name: "Guangzhou Textile Co.", currency: "CNY" });
    expect(res.body.entries).toEqual([
      {
        id: receipt.id,
        kind: "receipt",
        amount: 10_000,
        currency: "CNY",
        exchangeRate: 12.5,
        amountInr: 125_000,
        entryDate: indiaDay(-10),
        po: null,
        paymentId: null,
        advanceId: null,
        mode: "Bank transfer",
        reference: "UTR-1",
        notes: "Season advance",
        recordedAt: expect.any(String),
        recordedBy: "Anita Joseph",
      },
      expect.objectContaining({ kind: "allocation", amount: 3000, amountInr: 37_500, po: "PO-RENAMED", advanceId: receipt.id, recordedBy: "" }),
      expect.objectContaining({ kind: "allocation", amount: 500, po: "PO-GONE" }),
    ]);
  });
});

describe("ADV-5 GET /supplier-advances/suppliers (the Record payment supplier list)", () => {
  it("lists the active suppliers to payments Enter, with currency, rate, held, the currencies a payment may use and the balances", async () => {
    expect((await http.get("/supplier-advances/suppliers")).status).toBe(401);
    expect((await get("/supplier-advances/suppliers", await signInAs(ctx, SEEDED.chinaStaff))).status).toBe(403);
    // Procurement views payments only: it can't record one, so it gets no list.
    expect((await get("/supplier-advances/suppliers", procurement)).status).toBe(403);
    await makeOrder(ctx, { lines: [{ item: "Denim jeans", quantity: 100, rateCny: 10 }] }); // Guangzhou owes ¥1,000 in CNY
    await ctx.db.update(suppliers).set({ currency: "USD", exchangeRate: 84.25 }).where(eq(suppliers.id, guangzhou));
    await ctx.db.update(suppliers).set({ status: "Inactive" }).where(eq(suppliers.id, hangzhou));
    const foshan = (await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, "Foshan Fabrics")))[0]!.id;
    await ctx.db.insert(supplierLedgerHolds).values({ supplierId: foshan, currency: "CNY", reason: "test hold" });

    const res = await get("/supplier-advances/suppliers", accounts);
    expect(res.status).toBe(200);
    const list = res.body.suppliers as { id: string; name: string }[];
    const active = await ctx.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.status, "Active"));
    expect(list.map((s) => s.id).toSorted()).toEqual(active.map((s) => s.id).toSorted());
    expect(list.some((s) => s.id === hangzhou)).toBe(false);
    // The old CNY account still owes, so CNY stays on offer beside the supplier's USD (D10).
    expect(list.find((s) => s.id === guangzhou)).toEqual({
      id: guangzhou,
      name: "Guangzhou Textile Co.",
      currency: "USD",
      exchangeRate: 84.25,
      held: false,
      currencyOptions: ["CNY", "USD"],
      balances: [{ currency: "CNY", balanceCny: -1000 }],
    });
    // A held account is never offered and has no balance to show.
    expect(list.find((s) => s.id === foshan)).toMatchObject({ currency: "CNY", held: true, currencyOptions: [], balances: [] });
    for (const supplier of list) expect(Object.keys(supplier).toSorted()).toEqual(["balances", "currency", "currencyOptions", "exchangeRate", "held", "id", "name"]);
    expect((await get("/supplier-advances/suppliers", management)).body).toEqual(res.body);
  });

  it("sorts names in any letter case alphabetically (a lowercase name is not put after Z)", async () => {
    await ctx.db.insert(suppliers).values([{ name: "Zhejiang Silk" }, { name: "tango Fabrics" }, { name: "apex Trims" }]);
    const names = ((await get("/supplier-advances/suppliers", accounts)).body.suppliers as { name: string }[]).map((s) => s.name);
    expect(names.filter((name) => ["Zhejiang Silk", "tango Fabrics", "apex Trims"].includes(name))).toEqual(["apex Trims", "tango Fabrics", "Zhejiang Silk"]);
    expect(names).toEqual(names.toSorted((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
  });
});

describe("ADV-2, ADV-3, ADV-4 are retired", () => {
  it("answer 410 gone and write nothing", async () => {
    const order = await makeOrder(ctx, { lines: [{ item: "Denim jeans", quantity: 10, rateCny: 10 }] });
    const receipt = await legacy({});
    const requests = [
      () => http.post(`/suppliers/${guangzhou}/advances`, { amount: 100, paidOn: indiaDay(-1), rateInr: 12, mode: "Cash" }).set("Cookie", accounts),
      () => http.delete(`/supplier-advances/${receipt.id}`).set("Cookie", management),
      () => http.post(`/orders/${order.po}/advance`).set("Cookie", accounts),
    ];
    for (const request of requests) {
      const res = await request();
      expect(res.status).toBe(410);
      expect(res.body.error).toEqual({ code: "gone", message: MESSAGES.gone });
    }
    expect(await ctx.db.select().from(supplierAdvanceEntries)).toHaveLength(1);
  });

  it("a supplier with an advance record is not deleted (deactivate instead)", async () => {
    await legacy({ supplierId: hangzhou });
    const res = await http.delete(`/suppliers/${hangzhou}`).set("Cookie", management);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("1 advance record");
  });
});
