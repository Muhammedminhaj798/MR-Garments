-- Rollback of migration 0017_supplier_ledger (docs/unified-ledger.md, plan section 14). Run ONLY after
-- scripts/ledger-rollback-check.ts passes and the owner approves, with the previous backend already redeployed.
-- It refuses by itself when the application has written any financial record through the new backend.
begin;

do $$
begin
  if exists (select 1 from supplier_ledger_entries where origin = 'app')
     or exists (select 1 from payments where order_id is null or voided_at is not null or client_request_id is not null) then
    raise exception 'rollback refused: the ledger has application-written records (roll forward only)';
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
