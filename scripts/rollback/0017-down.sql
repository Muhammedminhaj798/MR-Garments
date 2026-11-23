-- Rollback of migration 0017_supplier_ledger (docs/operator-commands.md, "Rollback"; plan section 14). Run ONLY with
-- the new backend stopped, after scripts/ledger-rollback-check.ts passes and the owner approves; the previous backend is
-- redeployed after it. It refuses by itself (psql exits non-zero, nothing is changed) while the ledger is not in
-- maintenance, and once the application has written any financial record through the new backend.
\set ON_ERROR_STOP on
begin;

-- Everything the guard reads or the rollback drops is locked before the guard reads it, so nothing can be written
-- between the check and the drop. Give up rather than wait behind a long transaction (and block everyone behind us).
set local lock_timeout = '10s';
lock table ledger_state, supplier_ledger_holds, supplier_ledger_entries, payments in access exclusive mode;

do $$
begin
  if (select state from ledger_state where id = 'ledger') is distinct from 'maintenance' then
    raise exception 'rollback refused: the ledger is not in maintenance (close it first: ledger-reconcile.ts --close)';
  end if;
  if exists (select 1 from supplier_ledger_entries where origin = 'app')
     or exists (select 1 from payments where order_id is null or voided_at is not null or client_request_id is not null) then
    raise exception 'rollback refused: the ledger has application-written records (roll forward only)';
  end if;
  -- This script reverts 0017 only: with a later migration applied (0018 final_cost_protections, ...) it would leave the
  -- migrator's history broken.
  if exists (select 1 from drizzle.__drizzle_migrations where created_at > 1795155384570) then
    raise exception 'rollback refused: a migration after 0017 is applied (roll forward only)';
  end if;
end
$$;

drop trigger if exists supplier_ledger_append_only on supplier_ledger_entries;
drop function if exists supplier_ledger_append_only();
drop table supplier_ledger_entries;
drop table supplier_ledger_holds;
drop table ledger_state;

alter table payments drop constraint payments_document_check;
alter table payments drop constraint payments_currency_check;
alter table payments drop constraint payments_void_check;
alter table payments drop constraint payments_kind_check;
alter table payments add constraint payments_kind_check check (kind in ('Deposit', 'Balance'));
alter table payments drop constraint payments_supplier_id_suppliers_id_fk;
alter table payments drop constraint payments_order_id_orders_id_fk;
drop index payments_supplier_idx;
drop index payments_client_request_unique;
alter table payments drop column supplier_id, drop column currency, drop column voided_at, drop column voided_by, drop column void_reason, drop column client_request_id;
alter table payments alter column order_id set not null;
alter table payments add constraint payments_order_id_orders_id_fk foreign key (order_id) references orders(id) on delete cascade;

-- The migrator's record of 0017 (drizzle decides by created_at, the journal's "when").
delete from drizzle.__drizzle_migrations where created_at = 1795155384570;

commit;
