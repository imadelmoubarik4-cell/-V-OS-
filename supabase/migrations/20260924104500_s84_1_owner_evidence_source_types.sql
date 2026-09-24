-- S84.1: include all existing trusted owner stock workflows.
-- Re-applies the S84 evidence contract idempotently with prep/count source types included.

-- S84 owner-confirmed stock evidence.
--
-- An owner-confirmed physical count used to be dated by inventory_items.updated_at
-- and valued at the live quantity, so any later master edit (price, par, name)
-- re-dated it and could let an older owner count beat a newer manager count.
-- The confirmation is now recorded as its own evidence pair, written only by
-- trusted server paths, retained for audit, and projected to active staff.
-- No verified balance, count line, movement or live quantity is modified.

alter table public.inventory_items
  add column if not exists source_confirmed_at timestamptz,
  add column if not exists source_confirmed_quantity numeric;

alter table public.inventory_items drop constraint if exists inventory_items_source_confirmed_quantity_check;
alter table public.inventory_items add constraint inventory_items_source_confirmed_quantity_check
  check (source_confirmed_quantity is null or source_confirmed_quantity >= 0) not valid;
alter table public.inventory_items validate constraint inventory_items_source_confirmed_quantity_check;

comment on column public.inventory_items.source_confirmed_at is
  'When the owner physically confirmed source_confirmed_quantity. Written only by trusted server paths; never moved by master edits.';
comment on column public.inventory_items.source_confirmed_quantity is
  'Owner-confirmed physical quantity at source_confirmed_at. Audited movements after that time are applied on read.';

-- Backfill the existing confirmations from the evidence the previous rule used,
-- without letting the write guards re-date the rows.
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
      and tgname in ('inventory_items_phase1_write_guard', 'trg_inventory_items_updated_at')
  loop
    execute format('alter table public.inventory_items disable trigger %I', trigger_name);
    guarded := guarded || trigger_name;
  end loop;

  update public.inventory_items
  set source_confirmed_at = updated_at,
      source_confirmed_quantity = quantity
  where lower(coalesce(source_type, '')) in ('owner_confirmed', 'owner_confirmed_supplier_price', 'owner_confirmed_prep', 'owner_verified_count')
    and source_confidence = 100
    and source_confirmed_at is null
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
  owner_types constant text[] := array['owner_confirmed', 'owner_confirmed_supplier_price', 'owner_confirmed_prep', 'owner_verified_count'];
  is_owner_row boolean := lower(coalesce(new.source_type, '')) = any(owner_types)
    and new.source_confidence = 100;
  was_owner_row boolean := false;
  at_set boolean;
  quantity_set boolean;
begin
  if tg_op = 'INSERT' then
    at_set := new.source_confirmed_at is not null;
    quantity_set := new.source_confirmed_quantity is not null;
  else
    was_owner_row := lower(coalesce(old.source_type, '')) = any(owner_types)
      and old.source_confidence = 100;
    at_set := new.source_confirmed_at is distinct from old.source_confirmed_at;
    quantity_set := new.source_confirmed_quantity is distinct from old.source_confirmed_quantity;
  end if;

  if (at_set or quantity_set) and not trusted_server then
    raise exception 'Owner stock confirmations are recorded by the trusted owner workflow only'
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

drop trigger if exists inventory_items_s84_owner_confirmation on public.inventory_items;
create trigger inventory_items_s84_owner_confirmation
before insert or update on public.inventory_items
for each row execute function private.inventory_owner_confirmation_guard();

-- Active staff reconcile stock from the same evidence as managers. They receive
-- only the owner-confirmed baseline, never source type, confidence, files or hashes.
drop view if exists public.inventory_catalog;
drop function if exists private.read_inventory_catalog();

create function private.read_inventory_catalog()
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
    case
      when lower(coalesce(item.source_type, '')) in ('owner_confirmed', 'owner_confirmed_supplier_price', 'owner_confirmed_prep', 'owner_verified_count')
        and item.source_confidence = 100
      then item.source_confirmed_quantity
    end,
    case
      when lower(coalesce(item.source_type, '')) in ('owner_confirmed', 'owner_confirmed_supplier_price', 'owner_confirmed_prep', 'owner_verified_count')
        and item.source_confidence = 100
      then item.source_confirmed_at
    end
  from public.inventory_items as item
  where (select auth.uid()) is not null
    and (select private.is_active_staff());
$$;

revoke execute on function private.read_inventory_catalog() from public, anon, service_role;
grant execute on function private.read_inventory_catalog() to authenticated;

create view public.inventory_catalog
with (security_invoker = true)
as
select * from private.read_inventory_catalog();

revoke all on table public.inventory_catalog from anon, authenticated, service_role;
grant select on table public.inventory_catalog to authenticated;

comment on view public.inventory_catalog is
  'Active-staff inventory projection without supplier costs, private notes, or source files; exposes only the owner-confirmed stock baseline.';
