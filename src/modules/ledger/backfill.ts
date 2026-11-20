import { eq, sql } from "drizzle-orm";

import type { Database } from "../../db/client";
import { suppliers, supplierLedgerHolds as holds } from "../../db/schema";
import { cents, fromCents, loadLedger } from "./ledger";

// The ledger backfill and reconciliation (docs/unified-ledger.md, plan section 9.4). History is posted exactly once with
// origin 'backfill': every live order's debit, every paid supplier payment's credit and every legacy advance receipt's
// credit, except the receipts on the owner's exclusion list (DEFAULT_RECEIPT_EXCLUSIONS). Allocation, reversal, excess and excess-return rows are never posted (they are internal transfers that cancel
// out), and neither are shipping-agent payments, due rows or anything in a held account. Every insert is set-based with
// `on conflict (idempotency_key) do nothing`, so a second run writes 0 rows. Legacy rows are only read, never changed.

export type Hold = { supplierId?: string; supplierCode?: string; currency: string; reason: string };

/** The owner's explicit exclusion list (D4): the whole SUP-010 CNY account. */
export const DEFAULT_HOLDS: Hold[] = [
  {
    supplierCode: "SUP-010",
    currency: "CNY",
    reason: "D4: opening balance pending owner review (order 0000066, its three deposits and the CNY 12,000 advance receipt).",
  },
];

/** One legacy advance receipt the owner ruled invalid (a duplicate, a test entry): never posted; its row stays as it is. */
export type ReceiptExclusion = { advanceEntryId: string; reason: string };

/**
 * The owner's receipt exclusion list (confirmed 2026-11-20 on the production snapshot of that day; docs/unified-ledger.md).
 * Production ids: the release scripts and LED-4 pass this list; the functions default to none (tests).
 */
export const DEFAULT_RECEIPT_EXCLUSIONS: ReceiptExclusion[] = [
  {
    advanceEntryId: "f2b7966a-0937-485b-94a6-e6a536bfeedc",
    reason: "Duplicate: SUP-004 USD 25,000 CASH receipt entered 2026-11-19 14:34Z, a second entry of receipt 547ef798 (14:03Z).",
  },
  {
    advanceEntryId: "6ab149cc-bd00-4ef9-90f3-dc6bac5ccb47",
    reason: "Test entry: SUP-009 CNY 1,212 Cash receipt entered 2026-11-20 04:54Z.",
  },
];

const excludedIds = (list: ReceiptExclusion[]) => sql`array[${sql.join(list.map((row) => sql`${row.advanceEntryId}`), sql`, `)}]::text[]`;

const notHeld = (supplier: string, currency: string) =>
  sql.raw(`not exists (select 1 from supplier_ledger_holds h where h.supplier_id = ${supplier} and h.currency = ${currency})`);

type Written = { supplier_id: string; currency: string; entry_type: string; amount: string };

class DryRun extends Error {}

/**
 * Writes the holds (when their supplier exists), then the postings, in one transaction. Without `apply` the same
 * statements run and the transaction is rolled back, so the dry run reports exactly what an apply would write.
 */
export async function backfillLedger(db: Database, options: { apply: boolean; holds?: Hold[]; excludedReceipts?: ReceiptExclusion[] }) {
  const excluded = options.excludedReceipts ?? [];
  const report = {
    holds: [] as { supplierId: string; code: string | null; currency: string; created: boolean }[],
    skippedHolds: [] as string[],
    excludedReceipts: [] as { advanceEntryId: string; code: string | null; currency: string | null; amount: number | null; problem?: string }[],
    unresolvedExclusions: [] as string[],
    rows: [] as Written[],
  };
  try {
    await db.transaction(async (tx) => {
      // Each listed receipt must exist, be a receipt and have nothing drawn from it (no allocation): a typo would post the
      // receipt it meant to exclude, and a drawn one would leave its allocations' orders settled in the legacy figures only.
      if (excluded.length > 0) {
        const found = await tx.execute<{ id: string; code: string | null; currency: string | null; amount: string | null; kind: string | null; drawn: boolean }>(sql`
          select x.id, s.code, a.currency, a.amount::text as amount, a.kind,
                 exists (select 1 from supplier_advance_entries d where d.advance_id = a.id) as drawn
          from unnest(${excludedIds(excluded)}) with ordinality as x(id, n)
          left join supplier_advance_entries a on a.id::text = x.id
          left join suppliers s on s.id = a.supplier_id
          order by x.n`);
        for (const row of found.rows) {
          const problem = row.kind === null ? "no such advance entry" : row.kind !== "receipt" ? `${row.kind} row, not a receipt` : row.drawn ? "money was applied from it" : undefined;
          report.excludedReceipts.push({ advanceEntryId: row.id, code: row.code, currency: row.currency, amount: row.amount === null ? null : Number(row.amount), ...(problem ? { problem } : {}) });
          if (problem) report.unresolvedExclusions.push(`${row.id}: ${problem}`);
        }
      }
      for (const hold of options.holds ?? DEFAULT_HOLDS) {
        const [supplier] = await tx
          .select({ id: suppliers.id, code: suppliers.code })
          .from(suppliers)
          .where(hold.supplierId ? eq(suppliers.id, hold.supplierId) : eq(suppliers.code, hold.supplierCode ?? ""));
        if (!supplier) {
          report.skippedHolds.push(`${hold.supplierId ?? hold.supplierCode} ${hold.currency}: no such supplier`);
          continue;
        }
        const created = await tx.insert(holds).values({ supplierId: supplier.id, currency: hold.currency, reason: hold.reason }).onConflictDoNothing().returning();
        report.holds.push({ supplierId: supplier.id, code: supplier.code, currency: hold.currency, created: created.length > 0 });
      }
      const debits = await tx.execute<Written>(sql`
        insert into supplier_ledger_entries (supplier_id, currency, entry_type, amount, exchange_rate, entry_date, origin, order_id, po_number, idempotency_key)
        select o.supplier_id, o.currency, 'order_debit', -round(coalesce(sum(l.quantity * l.rate_cny), 0), 2), o.exchange_rate, o.order_date,
               'backfill', o.id, o.po_number, 'order:' || o.id || ':debit'
        from orders o left join order_lines l on l.order_id = o.id
        where ${notHeld("o.supplier_id", "o.currency")}
        group by o.id
        order by o.order_date, o.created_at, o.id
        on conflict (idempotency_key) do nothing
        returning supplier_id, currency, entry_type, amount`);
      const credits = await tx.execute<Written>(sql`
        insert into supplier_ledger_entries (supplier_id, currency, entry_type, amount, exchange_rate, entry_date, origin, payment_id, idempotency_key)
        select coalesce(p.supplier_id, o.supplier_id), coalesce(p.currency, o.currency), 'payment', p.amount_cny, p.rate_inr, p.paid_on,
               'backfill', p.id, 'payment:' || p.id
        from payments p left join orders o on o.id = p.order_id
        where p.payee_role = 'supplier' and p.status = 'paid' and p.voided_at is null
          and ${notHeld("coalesce(p.supplier_id, o.supplier_id)", "coalesce(p.currency, o.currency)")}
        order by p.paid_on, p.created_at, p.id
        on conflict (idempotency_key) do nothing
        returning supplier_id, currency, entry_type, amount`);
      const receipts = await tx.execute<Written>(sql`
        insert into supplier_ledger_entries (supplier_id, currency, entry_type, amount, exchange_rate, entry_date, origin, advance_entry_id, idempotency_key)
        select a.supplier_id, a.currency, 'payment', a.amount, a.exchange_rate, a.entry_date, 'backfill', a.id, 'advance:' || a.id
        from supplier_advance_entries a
        where a.kind = 'receipt' and not (a.id::text = any(${excludedIds(excluded)})) and ${notHeld("a.supplier_id", "a.currency")}
        order by a.entry_date, a.created_at, a.id
        on conflict (idempotency_key) do nothing
        returning supplier_id, currency, entry_type, amount`);
      report.rows = [...debits.rows, ...credits.rows, ...receipts.rows];
      // A hold that names no supplier would post the account it meant to hold: never apply then (D4).
      if (options.apply && report.skippedHolds.length > 0) throw new Error(`Refusing to apply: unresolved hold(s): ${report.skippedHolds.join("; ")}`);
      if (options.apply && report.unresolvedExclusions.length > 0) {
        throw new Error(`Refusing to apply: unresolved receipt exclusion(s): ${report.unresolvedExclusions.join("; ")}`);
      }
      if (!options.apply) throw new DryRun();
    });
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }
  const byAccount = new Map<string, { supplierId: string; currency: string; debits: number; credits: number; amount: number }>();
  for (const row of report.rows) {
    const key = `${row.supplier_id} ${row.currency}`;
    const line = byAccount.get(key) ?? { supplierId: row.supplier_id, currency: row.currency, debits: 0, credits: 0, amount: 0 };
    if (row.entry_type === "order_debit") line.debits++;
    else line.credits++;
    line.amount = fromCents(cents(line.amount) + cents(Number(row.amount)));
    byAccount.set(key, line);
  }
  return {
    applied: options.apply,
    holds: report.holds,
    skippedHolds: report.skippedHolds,
    excludedReceipts: report.excludedReceipts,
    unresolvedExclusions: report.unresolvedExclusions,
    written: report.rows.length,
    accounts: [...byAccount.values()],
  };
}

/** Plan 9.4 step 0: rate coverage per supplier and currency (read-only). NULLs are posted as NULL, never invented. */
export async function rateCoverage(db: Database, excludedReceipts: ReceiptExclusion[] = []) {
  const [paymentRows, receiptRows, orderRows] = await Promise.all([
    db.execute(sql`
      select s.code, coalesce(p.currency, o.currency) as currency, p.payee_role, p.status, count(*)::int as rows, count(*) filter (where p.rate_inr is null)::int as null_rates
      from payments p left join orders o on o.id = p.order_id join suppliers s on s.id = coalesce(p.supplier_id, o.supplier_id)
      group by 1, 2, 3, 4 order by 1, 2, 3, 4`),
    db.execute(sql`
      select s.code, a.currency, count(*)::int as rows, count(*) filter (where a.exchange_rate is null)::int as null_rates
      from supplier_advance_entries a join suppliers s on s.id = a.supplier_id
      where a.kind = 'receipt' and not (a.id::text = any(${excludedIds(excludedReceipts)})) group by 1, 2 order by 1, 2`),
    db.execute(sql`
      select s.code, o.currency, count(*)::int as rows, count(*) filter (where o.exchange_rate is null)::int as null_rates
      from orders o join suppliers s on s.id = o.supplier_id group by 1, 2 order by 1, 2`),
  ]);
  return { payments: paymentRows.rows, advanceReceipts: receiptRows.rows, orders: orderRows.rows };
}

export type Check = { id: string; title: string; ok: boolean; problems: string[] };

const held = (supplier: string, currency: string) => sql.raw(`exists (select 1 from supplier_ledger_holds h where h.supplier_id = ${supplier} and h.currency = ${currency})`);

/**
 * Plan 4.6, invariants 1-6 and 8 (7, the legacy fingerprints, needs a baseline: `legacyFingerprints`). Read-only.
 * `expectedHolds` (the release script passes DEFAULT_HOLDS): each must name a supplier and exist as a hold row.
 * `excludedReceipts` (the release script and LED-4 pass DEFAULT_RECEIPT_EXCLUSIONS): never credited, and none may be.
 */
export async function reconcileLedger(
  db: Pick<Database, "execute">,
  expectedHolds: Hold[] = [],
  excludedReceipts: ReceiptExclusion[] = [],
): Promise<{ ok: boolean; checks: Check[] }> {
  const problems = async (query: ReturnType<typeof sql>) => (await db.execute<{ problem: string }>(query)).rows.map((row) => row.problem).slice(0, 50);
  const checks: Check[] = [];
  const add = async (id: string, title: string, query: ReturnType<typeof sql>) => {
    const found = await problems(query);
    checks.push({ id, title, ok: found.length === 0, problems: found });
  };

  await add(
    "payments",
    "Every paid supplier payment (voided or not) outside a held account has exactly one credit with its amount, currency and supplier",
    sql`select 'payment ' || p.id || ': ' || count(e.id) || ' credit(s)' ||
          coalesce(' amount ' || max(e.amount)::text || ' vs ' || p.amount_cny::text, '') as problem
        from payments p left join orders o on o.id = p.order_id
        left join supplier_ledger_entries e on e.payment_id = p.id and e.entry_type = 'payment'
        where p.payee_role = 'supplier' and p.status = 'paid' and not ${held("coalesce(p.supplier_id, o.supplier_id)", "coalesce(p.currency, o.currency)")}
        group by p.id, p.amount_cny, p.supplier_id, o.supplier_id, p.currency, o.currency
        having count(e.id) <> 1 or bool_or(e.amount <> p.amount_cny or e.currency <> coalesce(p.currency, o.currency) or e.supplier_id <> coalesce(p.supplier_id, o.supplier_id))`,
  );
  await add(
    "voids",
    "Every voided payment's credit has exactly one void equal to minus it; no payment that is not voided has one",
    sql`select 'payment ' || p.id || ': ' || count(v.id) || ' void(s), voided ' || (p.voided_at is not null)::text as problem
        from payments p join supplier_ledger_entries c on c.payment_id = p.id and c.entry_type = 'payment'
        left join supplier_ledger_entries v on v.reverses_id = c.id and v.entry_type = 'payment_void'
        group by p.id, p.voided_at, c.amount
        having (p.voided_at is not null and (count(v.id) <> 1 or bool_or(v.amount <> -c.amount))) or (p.voided_at is null and count(v.id) > 0)`,
  );
  await add(
    "not-posted",
    "No posting for shipping-agent payments, due rows, allocation/reversal/excess rows or held accounts",
    sql`select e.entry_type || ' ' || e.id || ' should not exist' as problem
        from supplier_ledger_entries e
        left join payments p on p.id = e.payment_id
        left join supplier_advance_entries a on a.id = e.advance_entry_id
        where (p.id is not null and (p.payee_role <> 'supplier' or p.status <> 'paid'))
           or (a.id is not null and a.kind <> 'receipt')
           or ${held("e.supplier_id", "e.currency")}`,
  );
  await add(
    "orders",
    "Every live order outside a held account has one debit and its postings equal minus its value",
    sql`with v as (select o.id, o.po_number, o.supplier_id, o.currency, round(coalesce(sum(l.quantity * l.rate_cny), 0), 2) as value
                   from orders o left join order_lines l on l.order_id = o.id group by o.id)
        select 'order ' || v.po_number || ': value ' || v.value::text || ', posted ' || coalesce(-sum(e.amount), 0)::text || ', debits ' ||
               count(e.id) filter (where e.entry_type = 'order_debit') as problem
        from v left join supplier_ledger_entries e on e.order_id = v.id and e.entry_type like 'order\\_%'
        where not ${held("v.supplier_id", "v.currency")}
        group by v.id, v.po_number, v.value
        having count(e.id) filter (where e.entry_type = 'order_debit') <> 1 or coalesce(-sum(e.amount), 0) <> v.value
            or bool_or(e.supplier_id <> v.supplier_id or e.currency <> v.currency)`,
  );
  await add(
    "deleted-orders",
    "Every deleted order's postings net to zero, with one cancellation",
    sql`select 'deleted order ' || split_part(e.idempotency_key, ':', 2) || ' (' || max(e.po_number) || '): net ' || sum(e.amount)::text as problem
        from supplier_ledger_entries e
        where e.entry_type like 'order\\_%' and e.order_id is null
        group by split_part(e.idempotency_key, ':', 2)
        having sum(e.amount) <> 0 or count(*) filter (where e.entry_type = 'order_cancel') <> 1`,
  );
  await add(
    "receipts",
    "Every legacy advance receipt outside a held account and the exclusion list has exactly one credit with its amount, currency and supplier",
    sql`select 'advance receipt ' || a.id || ': ' || count(e.id) || ' credit(s)' as problem
        from supplier_advance_entries a
        left join supplier_ledger_entries e on e.advance_entry_id = a.id and e.entry_type = 'payment'
        where a.kind = 'receipt' and not ${held("a.supplier_id", "a.currency")} and not (a.id::text = any(${excludedIds(excludedReceipts)}))
        group by a.id, a.amount, a.currency, a.supplier_id
        having count(e.id) <> 1 or bool_or(e.amount <> a.amount or e.currency <> a.currency or e.supplier_id <> a.supplier_id)`,
  );
  if (excludedReceipts.length > 0) {
    await add(
      "excluded-receipts",
      "No receipt on the owner's exclusion list has a posting",
      sql`select 'excluded receipt ' || e.advance_entry_id || ': ' || count(*) || ' posting(s)' as problem
          from supplier_ledger_entries e
          where e.advance_entry_id::text = any(${excludedIds(excludedReceipts)})
          group by e.advance_entry_id`,
    );
  }
  if (expectedHolds.length > 0) {
    const listed = expectedHolds.map((hold) => `${hold.supplierId ?? hold.supplierCode} ${hold.currency}`);
    await add(
      "expected-holds",
      "Every account on the exclusion list (D4) names a supplier and is held",
      sql`select 'not held: ' || item as problem
          from unnest(array[${sql.join(listed.map((key) => sql`${key}`), sql`, `)}]::text[]) as item
          where not exists (select 1 from suppliers s join supplier_ledger_holds h on h.supplier_id = s.id
                            where (s.id::text = split_part(item, ' ', 1) or s.code = split_part(item, ' ', 1)) and h.currency = split_part(item, ' ', 2))`,
    );
  }
  await add(
    "supplier-deposits",
    "No supplier deposit (0008) exists: they are never posted, so any one needs an owner decision (D8)",
    sql`select 'supplier deposit ' || d.id || ' (' || d.direction || ' ' || d.amount::text || ' ' || d.currency || ') is not in the ledger' as problem
        from supplier_deposits d`,
  );
  await add(
    "held",
    "Held accounts have no postings",
    sql`select 'held account ' || h.supplier_id || ' ' || h.currency || ': ' || count(e.id) || ' posting(s)' as problem
        from supplier_ledger_holds h join supplier_ledger_entries e on e.supplier_id = h.supplier_id and e.currency = h.currency
        group by h.supplier_id, h.currency`,
  );
  return { ok: checks.every((check) => check.ok), checks };
}

/**
 * Invariant 7: one fingerprint per legacy table (row count + md5 of every row, by id), and one of the held accounts'
 * own records. The held accounts come from the explicit list (not the holds table), so a baseline taken before 0017
 * compares with one taken after. Compared with a baseline by scripts/ledger-reconcile.ts.
 */
export async function legacyFingerprints(db: Pick<Database, "execute">, heldList: Hold[] = DEFAULT_HOLDS) {
  const tables = ["orders", "order_lines", "supplier_advance_entries", "supplier_deposits", "supplier_deposit_transactions"];
  const result: Record<string, string> = {};
  for (const table of tables) {
    const [row] = (await db.execute<{ fingerprint: string }>(sql.raw(`select count(*) || ' ' || coalesce(md5(string_agg(to_jsonb(t)::text, '|' order by t.id)), '') as fingerprint from ${table} t`))).rows;
    result[table] = row!.fingerprint;
  }
  // Payments: the columns 0017 added are left out, so a baseline taken before the migration still compares equal.
  const [payments] = (
    await db.execute<{ fingerprint: string }>(
      sql.raw(`select count(*) || ' ' || coalesce(md5(string_agg((to_jsonb(t) - 'supplier_id' - 'currency' - 'voided_at' - 'voided_by' - 'void_reason' - 'client_request_id')::text, '|' order by t.id)), '') as fingerprint from payments t`),
    )
  ).rows;
  result.payments = payments!.fingerprint;
  // The held accounts' own records (orders, their lines and payments, advance entries), row for row.
  const keys = heldList.map((hold) => `${hold.supplierId ?? hold.supplierCode} ${hold.currency}`);
  const [heldRows] = (
    await db.execute<{ fingerprint: string }>(sql`
      with listed as (select split_part(item, ' ', 1) as ref, split_part(item, ' ', 2) as currency from unnest(array[${sql.join(keys.map((key) => sql`${key}`), sql`, `)}]::text[]) as item),
           h as (select s.id as supplier_id, listed.currency from listed join suppliers s on s.id::text = listed.ref or s.code = listed.ref)
      select count(*) || ' ' || coalesce(md5(string_agg(r, '|' order by r)), '') as fingerprint from (
        select to_jsonb(o)::text as r from orders o join h on h.supplier_id = o.supplier_id and h.currency = o.currency
        union all select to_jsonb(l)::text from order_lines l join orders o on o.id = l.order_id join h on h.supplier_id = o.supplier_id and h.currency = o.currency
        union all select (to_jsonb(p) - 'supplier_id' - 'currency' - 'voided_at' - 'voided_by' - 'void_reason' - 'client_request_id')::text from payments p join orders o on o.id = p.order_id join h on h.supplier_id = o.supplier_id and h.currency = o.currency
        union all select to_jsonb(a)::text from supplier_advance_entries a join h on h.supplier_id = a.supplier_id and h.currency = a.currency
      ) x`)
  ).rows;
  result.heldAccounts = heldRows!.fingerprint;
  return result;
}

/**
 * Plan 9.4 step 3: each order's settled amount under the legacy rules (supplier payments net of excess, plus the
 * advance applied, capped at the value) against the projection's. Read-only; the accepted differences are listed by the
 * caller (PO-1134647 on the 2026-11-18 data).
 */
export async function legacyDifferences(db: Database) {
  const legacy = await db.execute<{ id: string; po: string; currency: string; value: string; settled: string }>(sql`
    with v as (select o.id, o.po_number, o.currency, o.supplier_id, round(coalesce((select sum(l.quantity * l.rate_cny) from order_lines l where l.order_id = o.id), 0), 2) as value from orders o),
         paid as (select p.order_id, sum(p.amount_cny) as paid from payments p where p.payee_role = 'supplier' and p.status = 'paid' and p.voided_at is null and p.order_id is not null group by 1),
         adv as (select a.order_id,
                        sum(case a.kind when 'allocation' then a.amount when 'reversal' then -a.amount else 0 end) as applied,
                        sum(case a.kind when 'excess' then a.amount when 'excess_return' then -a.amount else 0 end) as excess
                 from supplier_advance_entries a where a.order_id is not null group by 1)
    select v.id, v.po_number as po, v.currency, v.value::text,
           least(v.value, greatest(0, coalesce(paid.paid, 0) - coalesce(adv.excess, 0) + coalesce(adv.applied, 0)))::text as settled
    from v left join paid on paid.order_id = v.id left join adv on adv.order_id = v.id
    where not exists (select 1 from supplier_ledger_holds h where h.supplier_id = v.supplier_id and h.currency = v.currency)`);
  const ledger = await loadLedger(db);
  return legacy.rows
    .map((row) => ({ po: row.po, currency: row.currency, legacySettled: Number(row.settled), ledgerSettled: ledger.order(row.id)?.settledCny ?? null }))
    .filter((row) => row.ledgerSettled === null || cents(row.ledgerSettled) !== cents(row.legacySettled));
}
