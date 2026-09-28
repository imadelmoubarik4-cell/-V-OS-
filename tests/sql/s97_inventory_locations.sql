-- S97 (inventory storage locations) authorization + integrity on a replayed
-- database (scripts/verify_full_migration_replay.sh stubs). Proves, at the
-- database boundary (not the UI):
--   1. the 16 canonical VÁ codes are seeded exactly;
--   2. read is for active staff only — anon reads nothing;
--   3. writes (save / set_active / delete / item_locations_set) refuse a
--      non-manager with 42501;
--   4. a manager may assign an item to several locations with at most one
--      primary, and reassigning the primary keeps exactly one;
--   5. permanent delete is Administrator-only and refuses a location in use;
--   6. assigning a location never changes an item's quantity;
--   7. every change is written to the append-only S97 audit trail.
begin;
create function pg_temp.as_user(uid uuid, extra jsonb default '{}') returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('sub', uid, 'role', 'authenticated') || extra)::text, true),
         set_config('request.jwt.claim.sub', uid::text, true), set_config('role', 'authenticated', true);
$$;

insert into auth.users(id, email, raw_user_meta_data) values ('97000000-0000-4000-8000-0000000000a1', 's97-admin@example.invalid', '{}');
update public.profiles set role = 'admin', active = true where id = '97000000-0000-4000-8000-0000000000a1';
insert into auth.users(id, email, raw_user_meta_data) values ('97000000-0000-4000-8000-0000000000d1', 's97-manager@example.invalid', '{}');
update public.profiles set role = 'manager', active = true where id = '97000000-0000-4000-8000-0000000000d1';
insert into auth.users(id, email, raw_user_meta_data) values ('97000000-0000-4000-8000-0000000000c1', 's97-staff@example.invalid', '{}');
update public.profiles set role = 'bartender', active = true where id = '97000000-0000-4000-8000-0000000000c1';
insert into public.inventory_items(name, unit) values ('S97 synthetic item', 'bottles');

-- 1. Seed: the 16 canonical codes, exactly, including the F04 service cooler.
do $$ begin
  if (select count(*) from public.inventory_locations
      where code in ('S01','S02','S03','F01','F02','F03','F04','W01','W02','B01','B02','B03','D01','D02','D03','D04')) <> 16 then
    raise exception 'S97 must seed the 16 canonical VA locations';
  end if;
  if not exists (select 1 from public.inventory_locations where code = 'F04' and name = 'Cooler under coffee machine') then
    raise exception 'F04 must be the service cooler under the coffee machine';
  end if;
end $$;

-- 2. Anonymous (no claims, role anon): reads nothing. Denial may be an empty
--    result (RLS) or an outright permission error (no grant) — both are correct.
set role anon;
do $$ begin
  begin
    if exists (select 1 from public.inventory_locations) then raise exception 'anon read inventory_locations'; end if;
  exception when insufficient_privilege then null; end;
  begin
    if exists (select 1 from public.inventory_location_catalog) then raise exception 'anon read the location catalogue'; end if;
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 3. Staff (bartender): reads the catalogue, but every write is refused with 42501.
select pg_temp.as_user('97000000-0000-4000-8000-0000000000c1');
do $$
declare item_id uuid := (select id from public.inventory_items where name = 'S97 synthetic item');
        loc_id uuid := (select id from public.inventory_locations where code = 'S01');
begin
  if (select count(*) from public.inventory_location_catalog) <> 16 then
    raise exception 'active staff must read the location catalogue';
  end if;
  begin perform public.atlas_inventory_location_save(null, 'X01', 'Staff cannot create'); raise exception 'staff created a location';
  exception when insufficient_privilege then null; end;
  begin perform public.atlas_inventory_location_set_active(loc_id, false); raise exception 'staff archived a location';
  exception when insufficient_privilege then null; end;
  begin perform public.atlas_inventory_location_delete(loc_id); raise exception 'staff deleted a location';
  exception when insufficient_privilege then null; end;
  begin perform public.atlas_inventory_item_locations_set(item_id, array[loc_id], loc_id); raise exception 'staff assigned a location';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 4. Manager: assign the item to several locations with one primary; reassigning
--    the primary keeps exactly one. Nothing here changes the item's quantity.
select pg_temp.as_user('97000000-0000-4000-8000-0000000000d1');
do $$
declare item_id uuid := (select id from public.inventory_items where name = 'S97 synthetic item');
        loc_a uuid := (select id from public.inventory_locations where code = 'B03');
        loc_b uuid := (select id from public.inventory_locations where code = 'S03');
        qty_before numeric := (select quantity from public.inventory_items where name = 'S97 synthetic item');
        primaries integer;
        primary_code text;
begin
  perform public.atlas_inventory_item_locations_set(item_id, array[loc_a, loc_b], loc_b);
  select count(*) into primaries from public.inventory_item_locations where inventory_item_id = item_id and is_primary;
  if primaries <> 1 then raise exception 'exactly one primary expected, saw %', primaries; end if;
  if (select count(*) from public.inventory_item_locations where inventory_item_id = item_id) <> 2 then
    raise exception 'the item should be stored in two locations';
  end if;
  select l.code into primary_code from public.inventory_item_locations il join public.inventory_locations l on l.id = il.location_id
    where il.inventory_item_id = item_id and il.is_primary;
  if primary_code <> 'S03' then raise exception 'S03 should be primary, saw %', primary_code; end if;
  -- Reassign the primary to B03: still exactly one primary, now B03.
  perform public.atlas_inventory_item_locations_set(item_id, array[loc_a, loc_b], loc_a);
  select count(*) into primaries from public.inventory_item_locations where inventory_item_id = item_id and is_primary;
  if primaries <> 1 then raise exception 'reassigning primary must keep exactly one, saw %', primaries; end if;
  select l.code into primary_code from public.inventory_item_locations il join public.inventory_locations l on l.id = il.location_id
    where il.inventory_item_id = item_id and il.is_primary;
  if primary_code <> 'B03' then raise exception 'B03 should now be primary, saw %', primary_code; end if;
  -- 6. Location is not quantity.
  if (select quantity from public.inventory_items where name = 'S97 synthetic item') is distinct from qty_before then
    raise exception 'assigning a location must never change an item quantity';
  end if;
end $$;
reset role;

-- 5. Delete is Administrator-only and refuses a location that is in use.
select pg_temp.as_user('97000000-0000-4000-8000-0000000000d1');
do $$
declare loc_a uuid := (select id from public.inventory_locations where code = 'B03');
begin
  begin perform public.atlas_inventory_location_delete(loc_a); raise exception 'a manager permanently deleted a location';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select pg_temp.as_user('97000000-0000-4000-8000-0000000000a1');
do $$
declare loc_in_use uuid := (select id from public.inventory_locations where code = 'B03');
        loc_free uuid;
begin
  -- An in-use location cannot be permanently deleted, even by an administrator.
  begin perform public.atlas_inventory_location_delete(loc_in_use); raise exception 'an in-use location was deleted';
  exception when insufficient_privilege then null; end;
  -- A never-used location the admin just created can be deleted.
  loc_free := (select id from public.atlas_inventory_location_save(null, 'Z99', 'Never used'));
  perform public.atlas_inventory_location_delete(loc_free);
  if exists (select 1 from public.inventory_locations where id = loc_free) then
    raise exception 'a never-used location should be permanently deletable by an admin';
  end if;
end $$;
reset role;

-- 7. The append-only audit trail recorded the assignment and primary changes.
do $$
declare v_item_id uuid := (select id from public.inventory_items where name = 'S97 synthetic item');
begin
  if (select count(*) from atlas_private.inventory_location_events where item_id = v_item_id and event_type = 'item_assigned') = 0 then
    raise exception 'item assignments must be audited';
  end if;
  if (select count(*) from atlas_private.inventory_location_events where item_id = v_item_id and event_type = 'primary_changed') = 0 then
    raise exception 'primary changes must be audited';
  end if;
  if (select count(*) from atlas_private.inventory_location_events where event_type = 'location_created') = 0 then
    raise exception 'location creation must be audited';
  end if;
end $$;

do $$ begin raise notice 'S97 inventory storage locations: all authorization and integrity checks passed'; end $$;
rollback;
