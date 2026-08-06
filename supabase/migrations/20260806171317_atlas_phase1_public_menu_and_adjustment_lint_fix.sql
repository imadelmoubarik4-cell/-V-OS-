-- Phase 1 security-lint closure.
--
-- 1. Replace the owner-evaluated public_menu view with a security-invoker
--    projection backed by a dedicated non-exposed schema.
-- 2. Make adjust_inventory security-invoker so RLS, grants, the write guard and
--    the manager check all evaluate as the authenticated caller.

create schema if not exists public_menu_private;
revoke all on schema public_menu_private from public, anon, authenticated;
grant usage on schema public_menu_private to anon, service_role;
comment on schema public_menu_private is
  'Non-exposed backing schema for the anonymous four-column VÁ menu projection.';

create table if not exists public_menu_private.items (
  id uuid primary key,
  name text not null,
  type text,
  menu_price numeric,
  updated_at timestamptz not null default now()
);
alter table public_menu_private.items enable row level security;

drop policy if exists "anonymous read published menu projection" on public_menu_private.items;
create policy "anonymous read published menu projection"
  on public_menu_private.items
  for select
  to anon
  using (true);

revoke all on table public_menu_private.items from public, anon, authenticated;
grant select (id, name, type, menu_price) on table public_menu_private.items to anon;
grant all on table public_menu_private.items to service_role;
comment on table public_menu_private.items is
  'Trigger-maintained public menu projection. Only id, name, type and menu_price are granted to anon.';

create or replace function private.sync_public_menu_projection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    delete from public_menu_private.items where id = old.id;
    return old;
  end if;

  if new.active is true and new.show_on_menu is true then
    insert into public_menu_private.items (id, name, type, menu_price, updated_at)
    values (new.id, new.name, new.type, new.menu_price, now())
    on conflict (id) do update
    set name = excluded.name,
        type = excluded.type,
        menu_price = excluded.menu_price,
        updated_at = excluded.updated_at;
  else
    delete from public_menu_private.items where id = new.id;
  end if;

  return new;
end;
$function$;

revoke all on function private.sync_public_menu_projection() from public, anon, authenticated;
grant execute on function private.sync_public_menu_projection() to service_role;

drop trigger if exists recipes_sync_public_menu_projection on public.recipes;
create trigger recipes_sync_public_menu_projection
after insert or update of name, type, menu_price, show_on_menu, active or delete
on public.recipes
for each row execute function private.sync_public_menu_projection();

insert into public_menu_private.items (id, name, type, menu_price, updated_at)
select recipe.id, recipe.name, recipe.type, recipe.menu_price, now()
from public.recipes as recipe
where recipe.show_on_menu is true
  and recipe.active is true
on conflict (id) do update
set name = excluded.name,
    type = excluded.type,
    menu_price = excluded.menu_price,
    updated_at = excluded.updated_at;

delete from public_menu_private.items as projection
where not exists (
  select 1
  from public.recipes as recipe
  where recipe.id = projection.id
    and recipe.show_on_menu is true
    and recipe.active is true
);

drop view if exists public.public_menu;
create view public.public_menu
with (security_invoker = true, security_barrier = true)
as
select item.id, item.name, item.type, item.menu_price
from public_menu_private.items as item;

revoke all on table public.public_menu from public, anon, authenticated;
grant select on table public.public_menu to anon, service_role;
comment on view public.public_menu is
  'Intentional anonymous menu projection: security-invoker view exposing id, name, type and menu_price only.';

do $public_menu_shape$
declare
  actual_columns text[];
begin
  select array_agg(column_name order by ordinal_position)
    into actual_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'public_menu';

  if actual_columns is distinct from array['id', 'name', 'type', 'menu_price']::text[] then
    raise exception 'public_menu must expose exactly id, name, type and menu_price';
  end if;
end
$public_menu_shape$;

grant select, insert on table public.inventory_movements to authenticated;
drop policy if exists "active managers add inventory movements" on public.inventory_movements;
create policy "active managers add inventory movements"
  on public.inventory_movements
  for insert
  to authenticated
  with check (private.is_manager_or_admin());

create or replace function public.adjust_inventory(
  p_item_id uuid,
  p_quantity_change numeric,
  p_movement_type text,
  p_unit_cost numeric default null,
  p_supplier_id uuid default null,
  p_note text default null
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  item_row public.inventory_items;
begin
  if not private.is_manager_or_admin() then
    raise exception 'Controlled inventory adjustments require an active manager or administrator'
      using errcode = '42501';
  end if;

  if p_quantity_change = 0 then
    raise exception 'Quantity change cannot be zero';
  end if;
  if p_movement_type not in ('restock', 'sale', 'waste', 'adjustment', 'count', 'transfer') then
    raise exception 'Invalid movement type';
  end if;

  perform set_config('atlas.allow_inventory_quantity_change', 'on', true);

  update public.inventory_items
  set quantity = quantity + p_quantity_change,
      supplier_id = coalesce(p_supplier_id, supplier_id),
      cost_price = case when p_unit_cost is not null then p_unit_cost else cost_price end,
      updated_by = coalesce((select auth.uid())::text, updated_by)
  where id = p_item_id
    and quantity + p_quantity_change >= 0
  returning * into item_row;

  if item_row.id is null then
    raise exception 'Item not found or resulting quantity would be negative';
  end if;

  insert into public.inventory_movements (
    item_id,
    item_name,
    movement_type,
    quantity_change,
    unit_cost,
    total_cost,
    supplier_id,
    note,
    created_by
  ) values (
    item_row.id,
    item_row.name,
    p_movement_type,
    p_quantity_change,
    p_unit_cost,
    case when p_unit_cost is null then null else abs(p_quantity_change) * p_unit_cost end,
    p_supplier_id,
    left(p_note, 1000),
    (select auth.uid())
  );

  return item_row;
end;
$function$;

revoke all on function public.adjust_inventory(uuid, numeric, text, numeric, uuid, text)
  from public, anon, authenticated;
grant execute on function public.adjust_inventory(uuid, numeric, text, numeric, uuid, text)
  to authenticated, service_role;

notify pgrst, 'reload schema';
