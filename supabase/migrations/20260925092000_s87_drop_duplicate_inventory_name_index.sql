-- S87 duplicate index cleanup (Supabase performance advisor: duplicate_index).
--
-- Production has two identical btree indexes on public.inventory_items(name):
-- inventory_items_name_idx (never scanned) and inventory_items_name_idx1
-- (in use). Every insert/update maintains both. Drop the unused copy only when
-- an identical index remains, so databases built from migrations alone keep
-- their single name index. Neither index backs a constraint.

do $cleanup$
begin
  if exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and tablename = 'inventory_items'
      and indexname = 'inventory_items_name_idx1'
      and indexdef = 'CREATE INDEX inventory_items_name_idx1 ON public.inventory_items USING btree (name)'
  ) and exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and tablename = 'inventory_items'
      and indexname = 'inventory_items_name_idx'
      and indexdef = 'CREATE INDEX inventory_items_name_idx ON public.inventory_items USING btree (name)'
  ) then
    drop index public.inventory_items_name_idx;
  end if;
end
$cleanup$;
