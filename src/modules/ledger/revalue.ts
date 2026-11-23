import { eq, sql } from "drizzle-orm";

import type { Database } from "../../db/client";
import { ledgerState } from "../../db/schema";
import { guardFinalSettlements } from "../costs/landed-cost";
import { cents, fromCents, syncAccountOrders } from "./ledger";

// The historical revaluation (owner rules of 2026-11-23, docs/unified-ledger.md "Order value"): every order's value
// becomes its received quantity x rate. Each order whose journal value differs gets one `order_adjustment` (the existing
// syncOrderValue mechanism, key order:<id>:adj:<n>), dated the day it runs, never backdated; nothing earlier is changed.
// A preview by default: everything is computed in one transaction that is rolled back. --apply commits, only while the
// ledger is in maintenance (no money write can land meanwhile) and only when no final landed-cost order's settlement
// changes (M8: never silently). A held account (D4) is listed with its pending value and posted nothing: run again
// once its hold is released. Fix-forward only: a committed revaluation is not rolled back.

class Preview extends Error {}

export type RevaluationRow = {
  po: string;
  supplier: string;
  currency: string;
  held: boolean;
  ordered: number;
  received: number;
  poValue: number;
  /** What the journal held for the order before (null: never posted, a held account's). */
  postedBefore: number | null;
  /** Received quantity x rate. */
  value: number;
  /** value - postedBefore: + the supplier is owed more, - less (the posting is minus this). 0 while held. */
  valueChange: number;
  idempotencyKey: string | null;
};

export async function revalueToReceived(db: Database, options: { apply: boolean; note: string }) {
  let report: {
    applied: boolean;
    state: string;
    refused: string | null;
    postings: number;
    deferred: number;
    finalChanges: { supplier: string; currency: string; orders: string[] }[];
    orders: RevaluationRow[];
  } | null = null;
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx.select({ state: ledgerState.state }).from(ledgerState).where(eq(ledgerState.id, "ledger")).for("update");
      const state = row?.state ?? "missing";
      const before = await valuation(tx);
      const finalChanges: { supplier: string; currency: string; orders: string[] }[] = [];
      const keys = new Map<string, string>();
      const accounts = [...new Map(before.filter((order) => !order.held).map((order) => [`${order.supplierId} ${order.currency}`, order])).values()];
      for (const account of accounts) {
        const check = await guardFinalSettlements(tx, account.supplierId, account.currency);
        const changes = await syncAccountOrders(tx, account.supplierId, account.currency, null, `Revaluation to received quantity (owner rule of 2026-11-23): ${options.note}`);
        for (const change of changes) keys.set(change.orderId, change.idempotencyKey!);
        const changed = await check();
        if (changed.length > 0) finalChanges.push({ supplier: account.supplier, currency: account.currency, orders: changed });
      }
      const orders = before.map((order) => ({
        po: order.po,
        supplier: order.supplier,
        currency: order.currency,
        held: order.held,
        ordered: order.ordered,
        received: order.received,
        poValue: order.poValue,
        postedBefore: order.posted,
        value: order.value,
        valueChange: order.held ? 0 : fromCents(cents(order.value) - cents(order.posted ?? 0)),
        idempotencyKey: keys.get(order.id) ?? null,
      }));
      const refused =
        options.apply && state !== "maintenance"
          ? `Refusing to apply: the ledger is ${state}; close it first (scripts/ledger-reconcile.ts --close).`
          : options.apply && finalChanges.length > 0
            ? "Refusing to apply: final landed-cost settlements would change (finalChanges); they need the owner's separate approval."
            : null;
      report = { applied: options.apply && !refused, state, refused, postings: keys.size, deferred: orders.filter((order) => order.held && order.value !== 0).length, finalChanges, orders };
      if (!options.apply || refused) throw new Preview();
    });
  } catch (error) {
    if (!(error instanceof Preview)) throw error;
  }
  return report!;
}

/** Every order with its ordered and received quantities, PO value, value now (received x rate) and what the journal holds. */
async function valuation(db: Pick<Database, "execute">) {
  const result = await db.execute<{
    id: string; po: string; supplier_id: string; supplier: string; currency: string; held: boolean;
    ordered: string; received: string; po_value: string; value: string; posted: string | null;
  }>(sql`
    with l as (
      select l.order_id, l.quantity, l.rate_cny, coalesce((select sum(r.quantity) from receipt_lines r where r.order_line_id = l.id), 0) as received
      from order_lines l)
    select o.id, o.po_number as po, o.supplier_id, s.code as supplier, o.currency,
           exists (select 1 from supplier_ledger_holds h where h.supplier_id = o.supplier_id and h.currency = o.currency) as held,
           coalesce((select sum(quantity) from l where l.order_id = o.id), 0) as ordered,
           coalesce((select sum(received) from l where l.order_id = o.id), 0) as received,
           round(coalesce((select sum(quantity * rate_cny) from l where l.order_id = o.id), 0), 2) as po_value,
           round(coalesce((select sum(received * rate_cny) from l where l.order_id = o.id), 0), 2) as value,
           (select -sum(e.amount) from supplier_ledger_entries e where e.order_id = o.id and e.entry_type like 'order\\_%') as posted
    from orders o join suppliers s on s.id = o.supplier_id
    order by s.code, o.currency, o.order_date, o.created_at, o.id`);
  return result.rows.map((row) => ({
    id: row.id,
    po: row.po,
    supplierId: row.supplier_id,
    supplier: row.supplier,
    currency: row.currency,
    held: row.held,
    ordered: Number(row.ordered),
    received: Number(row.received),
    poValue: Number(row.po_value),
    value: Number(row.value),
    posted: row.posted === null ? null : Number(row.posted),
  }));
}

