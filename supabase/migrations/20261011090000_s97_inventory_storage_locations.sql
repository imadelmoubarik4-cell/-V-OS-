-- S97 (inventory): managed Storage Locations for inventory items.
--
-- Before this migration the only "where is it kept" field was the free-text
-- public.inventory_items.bin_location. Managers had to type an arbitrary
-- string, there was no canonical list, an item could not be in two places, and
-- adding a storage area was a data-entry convention rather than a managed
-- entity. This migration adds a canonical, manager-managed location catalogue
-- and a many-to-many item<->location assignment, with an append-only audit.
--
-- Objects:
--   * public.inventory_locations           canonical catalogue (staff read; RPC-only writes)
--   * public.inventory_item_locations      item<->location assignment, >= 0 per item,
--                                          at most one Primary Location per item
--   * public.inventory_location_catalog    security_invoker staff view (catalogue + item counts)
--   * atlas_private.inventory_location_events  append-only audit (S96 audit_append_only trigger)
--   * public.atlas_inventory_location_save / _set_active / _delete   manager location CRUD
--   * public.atlas_inventory_item_locations_set                      manager item assignment
--   * private.inventory_location_log        audit helper (SECURITY DEFINER)
--
-- Security: reads follow normal Inventory visibility (private.is_active_staff);
-- every write is a SECURITY DEFINER RPC that re-checks private.is_manager_or_admin()
-- (browsers hold no INSERT/UPDATE/DELETE on the tables, matching the S89 direct-write
-- revokes on inventory_items). Location is NOT quantity: nothing here reads or writes
-- inventory_items.quantity or inventory_movements.
--
-- bin_location: left in place and unchanged for backward compatibility (stock-count
-- history snapshots it as text; item-master/reports/AI still read it). Existing
-- bin_location values that case-insensitively equal a seeded code or name are mapped
-- to a canonical assignment; anything else is preserved and surfaced for review by the
-- "No location assigned" filter (the item keeps its bin_location text). No item is
-- bulk-assigned without an exact-match evidence.

-- 1. Canonical location catalogue ------------------------------------------------
create table if not exists public.inventory_locations (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  description text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_locations_code_len check (char_length(code) between 1 and 16),
  constraint inventory_locations_name_len check (char_length(name) between 1 and 120)
);
create unique index if not exists inventory_locations_code_lower_uidx
  on public.inventory_locations (lower(code));
create index if not exists inventory_locations_active_sort_idx
  on public.inventory_locations (active, sort_order, lower(code));

drop trigger if exists trg_inventory_locations_updated_at on public.inventory_locations;
create trigger trg_inventory_locations_updated_at
  before update on public.inventory_locations
  for each row execute function public.set_updated_at();

-- 2. Item <-> location assignment ------------------------------------------------
create table if not exists public.inventory_item_locations (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  location_id uuid not null references public.inventory_locations(id) on delete restrict,
  is_primary boolean not null default false,
  sort_order integer not null default 0,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (inventory_item_id, location_id)
);
-- at most one Primary Location per item
create unique index if not exists inventory_item_locations_one_primary_uidx
  on public.inventory_item_locations (inventory_item_id) where is_primary;
create index if not exists inventory_item_locations_location_idx
  on public.inventory_item_locations (location_id);

drop trigger if exists trg_inventory_item_locations_updated_at on public.inventory_item_locations;
create trigger trg_inventory_item_locations_updated_at
  before update on public.inventory_item_locations
  for each row execute function public.set_updated_at();

-- 3. RLS: active staff read; browsers never write directly (RPC-only) -------------
alter table public.inventory_locations enable row level security;
alter table public.inventory_item_locations enable row level security;

revoke all on table public.inventory_locations from public, anon, authenticated;
revoke all on table public.inventory_item_locations from public, anon, authenticated;
grant select on table public.inventory_locations to authenticated;
grant select on table public.inventory_item_locations to authenticated;
grant select, insert, update, delete on table public.inventory_locations to service_role;
grant select, insert, update, delete on table public.inventory_item_locations to service_role;

drop policy if exists "active staff read locations" on public.inventory_locations;
create policy "active staff read locations" on public.inventory_locations
  for select to authenticated using ((select private.is_active_staff()));

drop policy if exists "active staff read item locations" on public.inventory_item_locations;
create policy "active staff read item locations" on public.inventory_item_locations
  for select to authenticated using ((select private.is_active_staff()));

-- 4. Append-only audit -----------------------------------------------------------
create table if not exists atlas_private.inventory_location_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'location_created','location_updated','location_archived','location_reactivated',
    'location_deleted','item_assigned','item_unassigned','primary_changed')),
  location_id uuid,
  item_id uuid,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists inventory_location_events_location_idx
  on atlas_private.inventory_location_events (location_id, created_at desc);
create index if not exists inventory_location_events_item_idx
  on atlas_private.inventory_location_events (item_id, created_at desc);

alter table atlas_private.inventory_location_events enable row level security;
revoke all on table atlas_private.inventory_location_events from public, anon, authenticated;
grant select, insert on table atlas_private.inventory_location_events to service_role;
revoke update, delete, truncate on table atlas_private.inventory_location_events from service_role, authenticated, anon;
drop policy if exists inventory_location_events_service_only on atlas_private.inventory_location_events;
create policy inventory_location_events_service_only on atlas_private.inventory_location_events
  for all to service_role using (true) with check (true);

-- Append-only via the S96 shared trigger (20261010096000_s96_audit_append_only.sql).
drop trigger if exists s96_append_only on atlas_private.inventory_location_events;
create trigger s96_append_only before update or delete on atlas_private.inventory_location_events
  for each row execute function private.audit_append_only('location_id', 'item_id');
drop trigger if exists s96_append_only_no_truncate on atlas_private.inventory_location_events;
create trigger s96_append_only_no_truncate before truncate on atlas_private.inventory_location_events
  for each statement execute function private.audit_append_only();

create or replace function private.inventory_location_log(
  p_event_type text, p_location_id uuid, p_item_id uuid, p_actor_id uuid, p_payload jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = ''
as $function$
declare
  actor_label text;
  actor_role text;
begin
  select profile.role::text,
         nullif(btrim(coalesce(profile.display_name, '')), '')
    into actor_role, actor_label
  from public.profiles as profile where profile.id = p_actor_id;
  insert into atlas_private.inventory_location_events(
    event_type, location_id, item_id, actor_id, actor_label, actor_role, payload)
  values (p_event_type, p_location_id, p_item_id, p_actor_id,
          coalesce(actor_label, 'A team member'), actor_role, coalesce(p_payload, '{}'::jsonb));
end
$function$;
revoke all on function private.inventory_location_log(text,uuid,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function private.inventory_location_log(text,uuid,uuid,uuid,jsonb) to service_role;

-- 5. Seed the canonical VÁ bar locations (codes preserved exactly) ----------------
insert into public.inventory_locations (code, name, description, sort_order) values
  ('S01','Main storage shelves','Dry stock, spare supplies and unopened shelf-stable products',10),
  ('S02','Storage One','Reserve beer and overflow stock',20),
  ('S03','White spirits cabinet','Reserve spirits and liqueurs',30),
  ('F01','Main soda fridges','Main stock of sodas and mixers',40),
  ('F02','Small soda fridge','Sodas and mixers ready for service',50),
  ('F03','Small alcoholic beverages fridge','Bottled and canned alcoholic drinks',60),
  ('F04','Cooler under coffee machine','Milks, defrosted juices and purées, mint and basil ready for use, and fruits ready for service',70),
  ('W01','Small wine fridge','Service wines and opened wine bottles',80),
  ('W02','Big wine cooler','Reserve wines: sparkling, white, rosé and red',90),
  ('B01','Upper bar section','Syrups, spirits and liqueurs used for service',100),
  ('B02','Beer section','Beer ready for service',110),
  ('B03','Backbar display shelves','Spirits and liqueurs displayed behind the bar',120),
  ('D01','Downstairs freezer','Frozen fruit, desserts and other frozen stock',130),
  ('D02','Downstairs Cooler One — Juices','Fruit juice stock',140),
  ('D03','Downstairs Cooler Two — Cakes & Open Items','Cakes, opened purées, juices, other opened bar ingredients and opened wines',150),
  ('D04','Downstairs dry storage shelves','Dry ingredients, unopened shelf-stable stock and spare bar supplies',160)
on conflict (lower(code)) do nothing;

-- 6. Staff-readable catalogue view (catalogue + assigned item counts) -------------
create or replace view public.inventory_location_catalog
with (security_invoker = true) as
  select loc.id, loc.code, loc.name, loc.description, loc.active, loc.sort_order,
         loc.created_at, loc.updated_at,
         (select count(*) from public.inventory_item_locations il
            join public.inventory_items it on it.id = il.inventory_item_id and it.active
          where il.location_id = loc.id) as item_count
  from public.inventory_locations loc
  where (select private.is_active_staff());
revoke all on table public.inventory_location_catalog from public, anon, service_role;
grant select on table public.inventory_location_catalog to authenticated;

-- 7. Management RPCs: public SECURITY INVOKER wrappers over manager-gated
--    private SECURITY DEFINER impls (the S88/S90 reviewed-browser-RPC shape, so
--    the phase-1 security gate keeps browser_function_exposure empty). Register
--    each wrapper/impl pair in scripts/verify_phase1_security_gate.sql.
create or replace function private.inventory_location_save(
  p_id uuid, p_code text, p_name text, p_description text, p_sort_order integer)
returns public.inventory_locations
language plpgsql security definer set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  code_norm text := nullif(btrim(coalesce(p_code, '')), '');
  name_norm text := nullif(btrim(coalesce(p_name, '')), '');
  desc_norm text := nullif(btrim(coalesce(p_description, '')), '');
  result public.inventory_locations;
  before_row public.inventory_locations;
  changes jsonb := '{}'::jsonb;
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Managing storage locations requires an active manager or administrator'
      using errcode='42501', hint = 'atlas:forbidden';
  end if;
  if code_norm is null or name_norm is null then
    raise exception 'A location needs a code and a name'
      using errcode = '22023', hint = 'atlas:missing_fields';
  end if;
  if char_length(code_norm) > 16 then
    raise exception 'Location code must be 16 characters or fewer'
      using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  if p_id is null then
    insert into public.inventory_locations(code, name, description, sort_order, created_by, updated_by)
    values (code_norm, name_norm, desc_norm,
            coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 10 from public.inventory_locations)),
            actor, actor)
    returning * into result;
    perform private.inventory_location_log('location_created', result.id, null, actor,
      pg_catalog.jsonb_build_object('code', result.code, 'name', result.name));
  else
    select * into before_row from public.inventory_locations where id = p_id;
    if before_row.id is null then
      raise exception 'That storage location no longer exists'
        using errcode = 'P0002', hint = 'atlas:not_found';
    end if;
    if before_row.code is distinct from code_norm then changes := changes || pg_catalog.jsonb_build_object('code', pg_catalog.jsonb_build_array(before_row.code, code_norm)); end if;
    if before_row.name is distinct from name_norm then changes := changes || pg_catalog.jsonb_build_object('name', pg_catalog.jsonb_build_array(before_row.name, name_norm)); end if;
    if before_row.description is distinct from desc_norm then changes := changes || pg_catalog.jsonb_build_object('description', pg_catalog.jsonb_build_array(before_row.description, desc_norm)); end if;
    update public.inventory_locations
       set code = code_norm, name = name_norm, description = desc_norm,
           sort_order = coalesce(p_sort_order, sort_order), updated_by = actor
     where id = p_id
    returning * into result;
    if changes <> '{}'::jsonb then
      perform private.inventory_location_log('location_updated', result.id, null, actor,
        pg_catalog.jsonb_build_object('changes', changes));
    end if;
  end if;
  return result;
exception when unique_violation then
  raise exception 'A storage location with this code already exists'
    using errcode = '23505', hint = 'atlas:duplicate_code';
end
$function$;

create or replace function public.atlas_inventory_location_save(
  p_id uuid, p_code text, p_name text, p_description text default null, p_sort_order integer default null)
returns public.inventory_locations
language sql security invoker set search_path = ''
as $function$
  select private.inventory_location_save(p_id, p_code, p_name, p_description, p_sort_order);
$function$;

create or replace function private.inventory_location_set_active(p_id uuid, p_active boolean)
returns public.inventory_locations
language plpgsql security definer set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  result public.inventory_locations;
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Managing storage locations requires an active manager or administrator'
      using errcode='42501', hint = 'atlas:forbidden';
  end if;
  update public.inventory_locations set active = coalesce(p_active, active), updated_by = actor
   where id = p_id returning * into result;
  if result.id is null then
    raise exception 'That storage location no longer exists' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  perform private.inventory_location_log(
    case when coalesce(p_active, false) then 'location_reactivated' else 'location_archived' end,
    result.id, null, actor, pg_catalog.jsonb_build_object('code', result.code));
  return result;
end
$function$;

create or replace function public.atlas_inventory_location_set_active(p_id uuid, p_active boolean)
returns public.inventory_locations
language sql security invoker set search_path = ''
as $function$
  select private.inventory_location_set_active(p_id, p_active);
$function$;

create or replace function private.inventory_location_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  loc public.inventory_locations;
  in_use integer;
  ever_used integer;
begin
  -- Manager gate (recognised by the security gate); permanent deletion is then
  -- narrowed to Administrator + never-used only.
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Managing storage locations requires an active manager or administrator'
      using errcode='42501', hint = 'atlas:forbidden';
  end if;
  if private.current_profile_role() <> 'admin' then
    raise exception 'Only an administrator can permanently delete a storage location'
      using errcode='42501', hint = 'atlas:forbidden';
  end if;
  select * into loc from public.inventory_locations where id = p_id;
  if loc.id is null then
    raise exception 'That storage location no longer exists' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  select count(*) into in_use from public.inventory_item_locations where location_id = p_id;
  select count(*) into ever_used from atlas_private.inventory_location_events
    where location_id = p_id and event_type in ('item_assigned', 'primary_changed');
  if in_use > 0 or ever_used > 0 then
    raise exception 'This location is in use. Reassign its items and archive it instead.'
      using errcode = '42501', hint = 'atlas:location_in_use';
  end if;
  perform private.inventory_location_log('location_deleted', null, null, actor,
    pg_catalog.jsonb_build_object('code', loc.code, 'name', loc.name));
  delete from public.inventory_locations where id = p_id;
end
$function$;

create or replace function public.atlas_inventory_location_delete(p_id uuid)
returns void
language sql security invoker set search_path = ''
as $function$
  select private.inventory_location_delete(p_id);
$function$;

-- 8. Item assignment: invoker wrapper over a manager-gated private definer -------
create or replace function private.inventory_item_locations_set(
  p_item_id uuid, p_location_ids uuid[], p_primary_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  loc_ids uuid[] := coalesce(p_location_ids, array[]::uuid[]);
  before_ids uuid[];
  before_primary uuid;
  added uuid[];
  removed uuid[];
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Assigning storage locations requires an active manager or administrator'
      using errcode='42501', hint = 'atlas:forbidden';
  end if;
  if not exists (select 1 from public.inventory_items where id = p_item_id) then
    raise exception 'That inventory item no longer exists' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  -- de-duplicate the requested set
  select coalesce(array_agg(distinct x), array[]::uuid[]) into loc_ids from unnest(loc_ids) as x;
  if exists (select 1 from unnest(loc_ids) as x(id)
             where not exists (select 1 from public.inventory_locations l where l.id = x.id)) then
    raise exception 'One of those storage locations no longer exists'
      using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  if p_primary_id is not null and not (p_primary_id = any (loc_ids)) then
    raise exception 'The Primary Location must be one of the assigned locations'
      using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  select coalesce(array_agg(location_id), array[]::uuid[]),
         (select location_id from public.inventory_item_locations
           where inventory_item_id = p_item_id and is_primary limit 1)
    into before_ids, before_primary
  from public.inventory_item_locations where inventory_item_id = p_item_id;

  -- remove assignments no longer requested
  delete from public.inventory_item_locations
   where inventory_item_id = p_item_id and not (location_id = any (loc_ids));
  -- add newly requested (never primary yet; primary set below in a second pass)
  insert into public.inventory_item_locations(inventory_item_id, location_id, is_primary, created_by)
    select p_item_id, x.id, false, actor from unnest(loc_ids) as x(id)
  on conflict (inventory_item_id, location_id) do nothing;
  -- clear then set the single primary (two statements avoid a transient dual-primary)
  update public.inventory_item_locations set is_primary = false
   where inventory_item_id = p_item_id and is_primary;
  if p_primary_id is not null then
    update public.inventory_item_locations set is_primary = true
     where inventory_item_id = p_item_id and location_id = p_primary_id;
  end if;

  -- audit: assignments added / removed / primary change
  select coalesce(array_agg(x), array[]::uuid[]) into added
    from unnest(loc_ids) as x where not (x = any (before_ids));
  select coalesce(array_agg(x), array[]::uuid[]) into removed
    from unnest(before_ids) as x where not (x = any (loc_ids));
  if array_length(added, 1) is not null then
    perform private.inventory_location_log('item_assigned', null, p_item_id, actor,
      pg_catalog.jsonb_build_object('location_ids', pg_catalog.to_jsonb(added)));
  end if;
  if array_length(removed, 1) is not null then
    perform private.inventory_location_log('item_unassigned', null, p_item_id, actor,
      pg_catalog.jsonb_build_object('location_ids', pg_catalog.to_jsonb(removed)));
  end if;
  if before_primary is distinct from p_primary_id then
    perform private.inventory_location_log('primary_changed', p_primary_id, p_item_id, actor,
      pg_catalog.jsonb_build_object('from', before_primary, 'to', p_primary_id));
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'location_id', il.location_id, 'code', l.code, 'name', l.name,
             'is_primary', il.is_primary, 'active', l.active)
             order by il.is_primary desc, l.sort_order, l.code)
    from public.inventory_item_locations il
    join public.inventory_locations l on l.id = il.location_id
    where il.inventory_item_id = p_item_id), '[]'::jsonb);
end
$function$;

create or replace function public.atlas_inventory_item_locations_set(
  p_item_id uuid, p_location_ids uuid[], p_primary_id uuid default null)
returns jsonb
language sql security invoker set search_path = ''
as $function$
  select private.inventory_item_locations_set(p_item_id, p_location_ids, p_primary_id);
$function$;

-- Grants: private impls run the write (definer), reachable by authenticated so the
-- invoker wrappers can delegate; anon can reach neither. Public wrappers self-gate
-- via the impl's manager check.
revoke all on function private.inventory_location_save(uuid,text,text,text,integer) from public, anon;
revoke all on function private.inventory_location_set_active(uuid,boolean) from public, anon;
revoke all on function private.inventory_location_delete(uuid) from public, anon;
revoke all on function private.inventory_item_locations_set(uuid,uuid[],uuid) from public, anon;
grant execute on function private.inventory_location_save(uuid,text,text,text,integer) to authenticated, service_role;
grant execute on function private.inventory_location_set_active(uuid,boolean) to authenticated, service_role;
grant execute on function private.inventory_location_delete(uuid) to authenticated, service_role;
grant execute on function private.inventory_item_locations_set(uuid,uuid[],uuid) to authenticated, service_role;

revoke all on function public.atlas_inventory_location_save(uuid,text,text,text,integer) from public, anon;
revoke all on function public.atlas_inventory_location_set_active(uuid,boolean) from public, anon;
revoke all on function public.atlas_inventory_location_delete(uuid) from public, anon;
revoke all on function public.atlas_inventory_item_locations_set(uuid,uuid[],uuid) from public, anon;
grant execute on function public.atlas_inventory_location_save(uuid,text,text,text,integer) to authenticated, service_role;
grant execute on function public.atlas_inventory_location_set_active(uuid,boolean) to authenticated, service_role;
grant execute on function public.atlas_inventory_location_delete(uuid) to authenticated, service_role;
grant execute on function public.atlas_inventory_item_locations_set(uuid,uuid[],uuid) to authenticated, service_role;

-- 9. Map existing exact-match bin_location values to canonical assignments ---------
-- Only where a live item's bin_location case-insensitively equals a seeded code or
-- name (explicit evidence). Everything else is preserved as-is (bin_location text is
-- left untouched) and surfaced by the "No location assigned" filter for owner review.
-- Historical stock-count snapshots (inventory_count_lines.bin_location) are never touched.
do $seed_map$
declare
  mapped record;
begin
  for mapped in
    select it.id as item_id, loc.id as location_id
    from public.inventory_items it
    join public.inventory_locations loc
      on lower(btrim(it.bin_location)) = lower(loc.code)
      or lower(btrim(it.bin_location)) = lower(loc.name)
    where it.bin_location is not null and btrim(it.bin_location) <> ''
  loop
    insert into public.inventory_item_locations(inventory_item_id, location_id, is_primary)
    values (mapped.item_id, mapped.location_id, true)
    on conflict (inventory_item_id, location_id) do nothing;
  end loop;
end
$seed_map$;

notify pgrst, 'reload schema';
