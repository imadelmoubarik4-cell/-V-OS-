begin;

-- Older inventory imports stored a supplier name on the item without creating
-- the corresponding supplier record. Reconcile those factual names so they can
-- be selected by workflows that correctly require a supplier_id foreign key.
with legacy_suppliers as (
  select min(trim(i.supplier)) as name
  from public.inventory_items i
  where i.supplier_id is null
    and nullif(trim(i.supplier), '') is not null
  group by lower(trim(i.supplier))
), missing_suppliers as (
  select legacy.name
  from legacy_suppliers legacy
  where not exists (
    select 1
    from public.suppliers existing
    where lower(trim(existing.name)) = lower(legacy.name)
  )
)
insert into public.suppliers (name, active, notes)
select name, true, 'Reconciled from the inventory item supplier field.'
from missing_suppliers;

update public.inventory_items item
set supplier_id = supplier.id,
    updated_at = now()
from public.suppliers supplier
where item.supplier_id is null
  and nullif(trim(item.supplier), '') is not null
  and lower(trim(supplier.name)) = lower(trim(item.supplier));

commit;
