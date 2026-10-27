import { eq } from "drizzle-orm";

import { items, locations, orderLines, orders, receiptLines, receipts, shippingAgents, suppliers, users } from "../../db/schema";
import type { TestContext } from "../../test/harness";

// Test-only helpers: the orders endpoint lives in another module, so stock tests insert orders and receipts directly.

/** Today in India shifted by `days`, as YYYY-MM-DD. */
export const indiaDay = (days = 0) => new Date(Date.now() + 5.5 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);

export async function idOf(ctx: TestContext, table: typeof items | typeof locations | typeof suppliers | typeof shippingAgents | typeof users, name: string) {
  const row = (await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)))[0];
  if (!row) throw new Error(`No seeded ${name}`);
  return row.id;
}

let nextPo = 3000;

/** An order with lines in the given order (the first is the main line). Returns its id, PO and line ids. */
export async function makeOrder(
  ctx: TestContext,
  { stage = 1, supplier = "Guangzhou Textile Co.", lines }: { stage?: number; supplier?: string; lines: { item: string; quantity: number; rateCny: number }[] },
) {
  const po = `PO-${nextPo++}`;
  const order = (
    await ctx.db
      .insert(orders)
      .values({ poNumber: po, supplierId: await idOf(ctx, suppliers, supplier), orderDate: indiaDay(-30), deliveryDate: indiaDay(10), stage })
      .returning({ id: orders.id })
  )[0]!;
  const lineIds: string[] = [];
  for (const [position, line] of lines.entries()) {
    const created = await ctx.db
      .insert(orderLines)
      .values({ orderId: order.id, itemId: await idOf(ctx, items, line.item), position, quantity: line.quantity, rateCny: line.rateCny })
      .returning({ id: orderLines.id });
    lineIds.push(created[0]!.id);
  }
  return { id: order.id, po, lineIds };
}

/** A receipt written straight to the database (for container tests). */
export async function receive(ctx: TestContext, orderId: string, lines: { orderLineId: string; quantity: number }[]) {
  const receipt = (
    await ctx.db
      .insert(receipts)
      .values({
        orderId,
        receivedOn: indiaDay(-5),
        locationId: await idOf(ctx, locations, "Guangzhou office"),
        receivedBy: await idOf(ctx, users, "Wang Fang"),
        bundles: 1,
      })
      .returning({ id: receipts.id })
  )[0]!;
  await ctx.db.insert(receiptLines).values(lines.map((line) => ({ ...line, receiptId: receipt.id })));
}
