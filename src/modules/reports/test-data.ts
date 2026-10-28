import { eq } from "drizzle-orm";

import {
  clearingAgents,
  clearings,
  containerLines,
  containers,
  locations,
  orders,
  payments,
  shippingAgents,
  teams,
  transportCompanies,
  transports,
  users,
  warehouseReceiptLines,
  warehouseReceipts,
} from "../../db/schema";
import type { TestContext } from "../../test/harness";
import { moveOrdersToStage } from "../stages-shared";
import { idOf, indiaDay, makeOrder, receive } from "../stock/fixtures";

// Test-only lifecycle data for the landed cost and reports tests. Clearing, transport and warehouse rows are written
// straight to the database: their endpoints live in another module (section 5).
//
// A  Guangzhou Textile Co., 100 Polo shirts at ¥30 (¥3,000), ordered 40 days ago. Paid ¥2,000 at 12 and ¥1,000 at 13
//    (₹37,000) to the supplier and ¥100 at 12 (₹1,200) to the agent. Container C1 (FOB) with B.
// B  Shenzhen Apparel, 100 Men's shorts at ¥10 (¥1,000), ordered 35 days ago. Paid ¥1,000 at 12.5 (₹12,500).
//    C1 is arrived, cleared (₹2,000), unloaded (₹1,000) and stocked today: A takes 3/4, B 1/4. Both finished, final.
//    A: 37,000 + 1,200 + 1,500 + 750 = ₹40,450 (₹404.50 a piece: Retail 60, Online 40). B: ₹13,250 (Wholesale 100).
// C  Foshan Fabrics, 500 m Cotton fabric at ¥8 (¥4,000), ordered 20 days ago. Deposit ¥1,000 at 12 (₹12,000), ¥3,000
//    due in 10 days. In container C2 (CNF, at sea, ETA in 5 days): an estimate waiting for the supplier payment.
// D  Yiwu Trims Ltd., 50 Denim jeans at ¥20, ordered 10 days ago, due 2 days ago, stage 1: late, no cost.
// E  Hangzhou Knits, 200 Kids t-shirts at ¥4, ordered 15 days ago, due in 3 days, 150 received: short 50 (¥200).

export async function buildLifecycle(ctx: TestContext) {
  const one = async (table: typeof clearingAgents | typeof transportCompanies | typeof teams, name: string) =>
    (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0]!.id;
  const user = await idOf(ctx, users, "Suresh Menon");
  const authors = { createdBy: user, updatedBy: user };
  const order = async (supplier: string, item: string, quantity: number, rateCny: number, stage: number, orderedDaysAgo: number, dueInDays: number) => {
    const made = await makeOrder(ctx, { supplier, stage, lines: [{ item, quantity, rateCny }] });
    await ctx.db
      .update(orders)
      .set({ orderDate: indiaDay(-orderedDaysAgo), deliveryDate: indiaDay(dueInDays) })
      .where(eq(orders.id, made.id));
    return made;
  };
  const a = await order("Guangzhou Textile Co.", "Polo shirts", 100, 30, 3, 40, -10);
  const b = await order("Shenzhen Apparel", "Men's shorts", 100, 10, 3, 35, -10);
  const c = await order("Foshan Fabrics", "Cotton fabric", 500, 8, 3, 20, 0);
  const d = await order("Yiwu Trims Ltd.", "Denim jeans", 50, 20, 1, 10, -2);
  const e = await order("Hangzhou Knits", "Kids t-shirts", 200, 4, 2, 15, 3);
  for (const [made, quantity] of [[a, 100], [b, 100], [c, 500], [e, 150]] as const) {
    await receive(ctx, made.id, [{ orderLineId: made.lineIds[0]!, quantity }]);
  }

  const paid = { status: "paid", mode: "Bank" };
  await ctx.db.insert(payments).values([
    { ...paid, orderId: a.id, kind: "Deposit", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 2000, rateInr: 12, paidOn: indiaDay(-38) },
    { ...paid, orderId: a.id, kind: "Balance", payee: "Guangzhou Textile Co.", payeeRole: "supplier", amountCny: 1000, rateInr: 13, paidOn: indiaDay(-15) },
    { ...paid, orderId: a.id, kind: "Deposit", payee: "Sino Freight", payeeRole: "agent", amountCny: 100, rateInr: 12, paidOn: indiaDay(-30) },
    { ...paid, orderId: b.id, kind: "Balance", payee: "Shenzhen Apparel", payeeRole: "supplier", amountCny: 1000, rateInr: 12.5, paidOn: indiaDay(-20) },
    { ...paid, orderId: c.id, kind: "Deposit", payee: "Foshan Fabrics", payeeRole: "supplier", amountCny: 1000, rateInr: 12, paidOn: indiaDay(-19) },
    { orderId: c.id, kind: "Balance", payee: "Foshan Fabrics", payeeRole: "supplier", amountCny: 3000, status: "due", dueDate: indiaDay(10) },
  ]);

  const [c1, c2] = await ctx.db
    .insert(containers)
    .values([
      { number: "RPTU 1000001", shippingAgentId: await idOf(ctx, shippingAgents, "Sino Freight"), terms: "FOB", loadedOn: indiaDay(-30), eta: indiaDay(-10), status: "arrived" },
      { number: "RPTU 1000002", shippingAgentId: await idOf(ctx, shippingAgents, "Dragon Cargo"), terms: "CNF", loadedOn: indiaDay(-8), eta: indiaDay(5), status: "sea" },
    ])
    .returning({ id: containers.id });
  await ctx.db.insert(containerLines).values([
    { containerId: c1!.id, orderLineId: a.lineIds[0]!, bundles: 2, quantity: 100 },
    { containerId: c1!.id, orderLineId: b.lineIds[0]!, bundles: 2, quantity: 100 },
    { containerId: c2!.id, orderLineId: c.lineIds[0]!, bundles: 5, quantity: 500 },
  ]);
  await ctx.db.insert(clearings).values({
    ...authors,
    containerId: c1!.id,
    clearingAgentId: await one(clearingAgents, "Kochi Clearing Services"),
    arrivedOn: indiaDay(-9),
    dutyPaidOn: indiaDay(-7),
    clearedOn: indiaDay(-6),
    customsDutyInr: 1000,
    otherDutiesInr: 200,
    agentChargesInr: 300,
    portChargesInr: 500,
    status: "cleared",
  });
  const warehouse = await idOf(ctx, locations, "Main warehouse");
  const [trip] = await ctx.db
    .insert(transports)
    .values({
      ...authors,
      containerId: c1!.id,
      transportCompanyId: await one(transportCompanies, "Kerala Roadways"),
      destinationId: warehouse,
      lrNumber: "LR-1",
      vehicleNumber: "KL-07-1234",
      driverPhone: "9800000000",
      bundlesLoaded: 4,
      loadedOn: indiaDay(-5),
      unloadedOn: indiaDay(-1),
      bundlesReceived: 4,
      freightInr: 800,
      handlingInr: 200,
      status: "unloaded",
    })
    .returning({ id: transports.id });
  const [receipt] = await ctx.db
    .insert(warehouseReceipts)
    .values({ ...authors, transportId: trip!.id, locationId: warehouse, receivedOn: indiaDay(0), receivedBy: "Joseph M", bundlesReceived: 4, status: "stocked" })
    .returning({ id: warehouseReceipts.id });
  await ctx.db.insert(warehouseReceiptLines).values([
    { receiptId: receipt!.id, orderLineId: a.lineIds[0]!, teamId: await one(teams, "Retail team"), quantity: 60 },
    { receiptId: receipt!.id, orderLineId: a.lineIds[0]!, teamId: await one(teams, "Online team"), quantity: 40 },
    { receiptId: receipt!.id, orderLineId: b.lineIds[0]!, teamId: await one(teams, "Wholesale team"), quantity: 100 },
  ]);
  await moveOrdersToStage(ctx.db, c1!.id, 6);
  return { a, b, c, d, e, c1: { id: c1!.id, number: "RPTU 1000001" }, c2: { id: c2!.id, number: "RPTU 1000002" } };
}
