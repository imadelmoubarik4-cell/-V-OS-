-- S84.1 trusted owner stock workflows.
--
-- S84 recorded owner confirmations only for owner_confirmed and
-- owner_confirmed_supplier_price, so owner prep batches (owner_confirmed_prep)
-- and owner physical counts (owner_verified_count) received no
-- source_confirmed_* evidence and resolved to Unknown.
--
-- The database is now the single place that decides which owner workflows may
-- create stock evidence. Runtime code (browser and Reports) trusts the
-- server-gated source_confirmed_* columns directly, and the staff catalogue
-- projects them without re-checking source_type.
-- No verified balance, count session/line, movement or updated_at is modified.

create or replace function private.is_trusted_owner_stock_source(p_source_type text, p_source_confidence numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(coalesce(p_source_type, '')) in (
      'owner_confirmed',
      'owner_confirmed_supplier_price',
      'owner_confirmed_prep',
      'owner_verified_count'
    )
    and p_source_confidence = 100;
$$;

revoke all on function private.is_trusted_owner_stock_source(text, numeric) from public, anon, authenticated;
grant execute on function private.is_trusted_owner_stock_source(text, numeric) to service_role;

comment on function private.is_trusted_owner_stock_source(text, numeric) is
  'Owner workflows whose confidence-100 quantity is physical stock evidence. Only the confirmation guard and backfills use it.';

-- Backfill newly trusted rows from the evidence S84 used for the original
-- workflows, without letting the write guards re-date the rows.
do $backfill$
declare
  trigger_name text;
  guarded text[] := array[]::text[];
begin
  for trigger_name in
    select tgname from pg_trigger
    where tgrelid = 'public.inventory_items'::regclass
      and not tgisinternal
      and tgenabled <> 'D'
      and tgname in (
        'inventory_items_phase1_write_guard',
        'inventory_items_s84_owner_confirmation',
        'trg_inventory_items_updated_at'
      )
  loop
    execute format('alter table public.inventory_items disable trigger %I', trigger_name);
    guarded := guarded || trigger_name;
  end loop;

  update public.inventory_items
  set source_confirmed_at = updated_at,
      source_confirmed_quantity = quantity
  where private.is_trusted_owner_stock_source(source_type, source_confidence)
    and source_confirmed_at is null
    and source_confirmed_quantity is null
    and updated_at is not null
    and quantity is not null
    and quantity >= 0;

  foreach trigger_name in array guarded loop
    execute format('alter table public.inventory_items enable trigger %I', trigger_name);
  end loop;
end;
$backfill$;

create or replace function private.inventory_owner_confirmation_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller_role text := coalesce((select auth.role()), '');
  trusted_server boolean := caller_role = 'service_role' or session_user = 'postgres';
  is_owner_row boolean := private.is_trusted_owner_stock_source(new.source_type, new.source_confidence);
  was_owner_row boolean := false;
  at_set boolean;
  quantity_set boolean;
begin
  if tg_op = 'INSERT' then
    at_set := new.source_confirmed_at is not null;
    quantity_set := new.source_confirmed_quantity is not null;
  else
    was_owner_row := private.is_trusted_owner_stock_source(old.source_type, old.source_confidence);
    at_set := new.source_confirmed_at is distinct from old.source_confirmed_at;
    quantity_set := new.source_confirmed_quantity is distinct from old.source_confirmed_quantity;
  end if;

  if (at_set or quantity_set) and not trusted_server then
    raise exception 'Owner stock confirmations are recorded by the trusted owner workflow only'
      using errcode = '42501';
  end if;

  -- Runtime trusts these columns without re-checking source_type, so new
  -- evidence may only be written for a trusted owner workflow. Clearing it
  -- (revocation) stays possible for trusted server paths.
  if (at_set or quantity_set)
     and not is_owner_row
     and (new.source_confirmed_at is not null or new.source_confirmed_quantity is not null) then
    raise exception 'Owner stock evidence requires a trusted owner workflow with confidence 100'
      using errcode = '42501';
  end if;

  -- A trusted owner confirmation is stamped when a row becomes owner-confirmed
  -- or when the owner re-confirms by setting either evidence column. Browser
  -- master edits and controlled movements never re-date it.
  if trusted_server and is_owner_row and (tg_op = 'INSERT' or not was_owner_row or at_set or quantity_set) then
    if not at_set then
      new.source_confirmed_at := now();
    end if;
    if not quantity_set then
      new.source_confirmed_quantity := new.quantity;
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function private.inventory_owner_confirmation_guard() from public, anon, authenticated;
grant execute on function private.inventory_owner_confirmation_guard() to service_role;

-- Staff receive exactly the server-gated evidence managers reconcile from.
-- Return type is unchanged, so public.inventory_catalog keeps its definition,
-- security_invoker setting and grants.
create or replace function private.read_inventory_catalog()
returns table (
  id uuid,
  name text,
  category text,
  quantity numeric,
  unit text,
  par_level numeric,
  sku text,
  barcode text,
  bin_location text,
  units_per_case numeric,
  size_ml numeric,
  active boolean,
  image_url text,
  sell_price numeric,
  package_size text,
  canonical_key text,
  brand text,
  subcategory text,
  needs_review boolean,
  updated_at timestamptz,
  owner_confirmed_quantity numeric,
  owner_confirmed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    item.id,
    item.name,
    item.category,
    item.quantity,
    item.unit,
    item.par_level,
    item.sku,
    item.barcode,
    item.bin_location,
    item.units_per_case,
    item.size_ml,
    item.active,
    item.image_url,
    item.sell_price,
    item.package_size,
    item.canonical_key,
    item.brand,
    item.subcategory,
    item.needs_review,
    item.updated_at,
    item.source_confirmed_quantity,
    item.source_confirmed_at
  from public.inventory_items as item
  where (select auth.uid()) is not null
    and (select private.is_active_staff());
$$;

revoke execute on function private.read_inventory_catalog() from public, anon, service_role;
grant execute on function private.read_inventory_catalog() to authenticated;
