-- Canonicalize supplier names already present on inventory rows so Purchasing
-- can reference the required supplier UUID. This is deliberately limited to
-- existing, non-empty inventory evidence and is idempotent on replay.
do $migration$
declare
  legacy record;
  matching_ids uuid[];
  canonical_supplier_id uuid;
  canonical_supplier_name text;
begin
  for legacy in
    select
      lower(btrim(item.supplier)) as normalized_name,
      min(btrim(item.supplier)) as source_name
    from public.inventory_items item
    where item.supplier_id is null
      and nullif(btrim(item.supplier), '') is not null
    group by lower(btrim(item.supplier))
    order by lower(btrim(item.supplier))
  loop
    matching_ids := null;
    canonical_supplier_id := null;
    canonical_supplier_name := null;

    select array_agg(supplier.id order by supplier.created_at, supplier.id)
      into matching_ids
    from public.suppliers supplier
    where lower(btrim(supplier.name)) = legacy.normalized_name;

    if coalesce(cardinality(matching_ids), 0) > 1 then
      raise exception 'Multiple canonical suppliers match one legacy inventory supplier';
    elsif coalesce(cardinality(matching_ids), 0) = 1 then
      canonical_supplier_id := matching_ids[1];
      select supplier.name
        into canonical_supplier_name
      from public.suppliers supplier
      where supplier.id = canonical_supplier_id;
    else
      insert into public.suppliers (name, active, notes)
      values (
        legacy.source_name,
        true,
        'Canonicalized from an existing inventory supplier reference.'
      )
      returning id, name into canonical_supplier_id, canonical_supplier_name;
    end if;

    update public.inventory_items item
    set supplier_id = canonical_supplier_id,
        supplier = canonical_supplier_name,
        updated_at = now()
    where item.supplier_id is null
      and lower(btrim(item.supplier)) = legacy.normalized_name;
  end loop;
end
$migration$;
