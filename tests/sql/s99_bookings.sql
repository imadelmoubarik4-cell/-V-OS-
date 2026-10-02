-- S99 Alcedo Bookings — schema, authorization and reservation integrity on a replayed
-- database (scripts/verify_full_migration_replay.sh stubs). Proves at the database
-- boundary (not the UI):
--   1. booking tables and RPCs are sealed from anon/authenticated; service_role executes;
--   2. a bartender cannot configure the room (save area/table) — 42501; a manager can;
--   3. the atomic check-and-reserve: a confirmed booking allocates a specific table, and a
--      second overlapping booking on that table (explicit or auto) is rejected — no double
--      booking; auto-assign picks the next free suitable table;
--   4. a large party over the approval threshold with no explicit table stays 'requested'
--      and allocates nothing; assigning a table confirms it;
--   5. cancelling releases the allocation immediately, freeing the table again;
--   6. the status lifecycle enforces allowed transitions; availability returns slots;
--   7. role forgery and inactive profiles fail closed; guest contact is only in the
--      staff RPC payloads (the tables themselves are unreachable by browser roles).
begin;

-- Actors (a profile row is created by the auth.users trigger, then given a role).
insert into auth.users(id, email, raw_user_meta_data) values
  ('99000000-0000-4000-8000-0000000000a1', 's99-admin@example.invalid', '{}'),
  ('99000000-0000-4000-8000-0000000000d1', 's99-manager@example.invalid', '{}'),
  ('99000000-0000-4000-8000-0000000000c1', 's99-bartender@example.invalid', '{}'),
  ('99000000-0000-4000-8000-0000000000e1', 's99-inactive@example.invalid', '{}');
update public.profiles set role='admin', active=true, display_name='S99 Admin' where id='99000000-0000-4000-8000-0000000000a1';
update public.profiles set role='manager', active=true, display_name='S99 Manager' where id='99000000-0000-4000-8000-0000000000d1';
update public.profiles set role='bartender', active=true, display_name='S99 Bartender' where id='99000000-0000-4000-8000-0000000000c1';
update public.profiles set role='bartender', active=false, display_name='S99 Inactive' where id='99000000-0000-4000-8000-0000000000e1';

-- 1. Tables and RPCs are sealed from browser roles; service_role can execute.
do $$
declare bad text;
begin
  select string_agg(t, ', ') into bad from unnest(array[
    'booking_areas','booking_tables','booking_table_combinations','booking_settings',
    'reservations','reservation_tables','reservation_status_history','booking_holds','booking_events']) t
  where has_table_privilege('authenticated', 'atlas_private.'||t, 'SELECT')
     or has_table_privilege('anon', 'atlas_private.'||t, 'SELECT');
  if bad is not null then raise exception 'browser roles can read booking tables: %', bad; end if;

  if has_function_privilege('authenticated', 'public.atlas_bookings_snapshot(uuid,text,date)', 'EXECUTE')
     or has_function_privilege('anon', 'public.atlas_bookings_create(uuid,text,jsonb)', 'EXECUTE') then
    raise exception 'browser roles can execute booking RPCs';
  end if;
  if not has_function_privilege('service_role', 'public.atlas_bookings_create(uuid,text,jsonb)', 'EXECUTE') then
    raise exception 'service_role must execute booking RPCs';
  end if;
end $$;

-- 2. A bartender cannot configure the room; a manager can, and there is exactly one
--    settings row seeded by the migration.
do $$
declare mgr uuid := '99000000-0000-4000-8000-0000000000d1';
begin
  begin
    perform public.atlas_bookings_save_area('99000000-0000-4000-8000-0000000000c1', 'bartender',
      jsonb_build_object('name','Bar'));
    raise exception 'bartender configured an area';
  exception when insufficient_privilege then null; end;

  if (select count(*) from atlas_private.booking_settings) <> 1 then
    raise exception 'exactly one booking_settings row must be seeded';
  end if;
  -- Role forgery: a real bartender claiming manager is rejected before any write.
  begin
    perform public.atlas_bookings_config('99000000-0000-4000-8000-0000000000c1', 'manager');
    raise exception 'role forgery accepted';
  exception when insufficient_privilege then null; end;
end $$;

-- 3-6. The core reservation flow.
do $$
declare
  mgr uuid := '99000000-0000-4000-8000-0000000000d1';
  bart uuid := '99000000-0000-4000-8000-0000000000c1';
  area jsonb; t1 uuid; t2 uuid;
  r1 jsonb; r2 jsonb; r_big jsonb; res_big uuid; r_after jsonb;
  avail jsonb;
  base timestamptz := '2026-11-03 18:00:00+00';
begin
  -- Manager builds a small room: two tables.
  area := public.atlas_bookings_save_area(mgr, 'manager', jsonb_build_object('name','Bar','section_colour','teal'));
  t1 := (public.atlas_bookings_save_table(mgr,'manager', jsonb_build_object(
    'area_id', area->>'id', 'label','Bar 1','seat_capacity',2,'min_party',0,'priority',1))->>'id')::uuid;
  t2 := (public.atlas_bookings_save_table(mgr,'manager', jsonb_build_object(
    'area_id', area->>'id', 'label','Bar 2','seat_capacity',4,'min_party',0,'priority',2))->>'id')::uuid;

  -- Bartender (service staff) creates a party-of-2 booking; auto-assigns the smallest
  -- suitable table (Bar 1, cap 2), confirmed.
  r1 := public.atlas_bookings_create(bart,'bartender', jsonb_build_object(
    'party_size',2,'start_at',base,'guest_name','Guest One','guest_phone','555-0001'));
  if (r1->'reservation'->>'status') <> 'confirmed' then raise exception 'first booking should confirm'; end if;
  if jsonb_array_length(r1->'reservation'->'tables') <> 1 then raise exception 'first booking should hold one table'; end if;
  if (r1->'reservation'->'tables'->0->>'label') <> 'Bar 1' then raise exception 'first booking should take the smallest suitable table (Bar 1)'; end if;
  -- Staff payload carries guest contact (never exposed to browser roles — tables are sealed).
  if (r1->'reservation'->>'guest_phone') <> '555-0001' then raise exception 'staff payload must include guest phone'; end if;

  -- An overlapping party-of-2 that explicitly asks for Bar 1 is rejected (no double book).
  begin
    perform public.atlas_bookings_create(bart,'bartender', jsonb_build_object(
      'party_size',2,'start_at', base + interval '30 minutes','table_ids', jsonb_build_array(t1)));
    raise exception 'a second overlapping booking on Bar 1 was allowed';
  exception when unique_violation then null; end;  -- errcode 23505 / atlas:conflict

  -- Auto-assign at the same overlapping time now picks Bar 2 (Bar 1 is busy).
  r2 := public.atlas_bookings_create(bart,'bartender', jsonb_build_object(
    'party_size',2,'start_at', base + interval '30 minutes','guest_name','Guest Two'));
  if (r2->'reservation'->'tables'->0->>'label') <> 'Bar 2' then raise exception 'auto-assign should fall through to Bar 2'; end if;

  -- A large party over the approval threshold (default 7) with no explicit table stays
  -- 'requested' and allocates nothing.
  r_big := public.atlas_bookings_create(bart,'bartender', jsonb_build_object(
    'party_size',8,'start_at', base + interval '3 hours','guest_name','Big Group'));
  if (r_big->'reservation'->>'status') <> 'requested' then raise exception 'a large party should stay requested'; end if;
  if jsonb_array_length(r_big->'reservation'->'tables') <> 0 then raise exception 'a requested booking must not hold a table'; end if;
  res_big := (r_big->'reservation'->>'id')::uuid;

  -- Confirming a requested booking without a table is refused; assigning one confirms it.
  begin
    perform public.atlas_bookings_set_status(mgr,'manager', res_big, 'confirmed', null);
    raise exception 'a requested booking confirmed without a table';
  exception when invalid_parameter_value then null; end;  -- 22023 / atlas:invalid_request
  r_after := public.atlas_bookings_assign(mgr,'manager', res_big, jsonb_build_array(t2));
  if (r_after->'reservation'->>'status') <> 'confirmed' then raise exception 'assigning a table should confirm the request'; end if;

  -- Idempotent create: same idempotency_key returns the original booking, not a new one.
  declare k text := 'idem-key-1'; a jsonb; b jsonb;
  begin
    a := public.atlas_bookings_create(bart,'bartender', jsonb_build_object(
      'party_size',2,'start_at', base + interval '5 hours','idempotency_key',k));
    b := public.atlas_bookings_create(bart,'bartender', jsonb_build_object(
      'party_size',2,'start_at', base + interval '5 hours','idempotency_key',k));
    if (a->'reservation'->>'id') <> (b->'reservation'->>'id') then raise exception 'idempotency key must return the same booking'; end if;
    if (b->>'replayed')::boolean is not true then raise exception 'second submit with same key must be a replay'; end if;
  end;

  -- 5. Cancelling the first booking releases Bar 1 immediately; a new booking can take it.
  perform public.atlas_bookings_set_status(bart,'bartender', (r1->'reservation'->>'id')::uuid, 'cancelled', 'guest called off');
  if exists (select 1 from atlas_private.reservation_tables rt
             where rt.reservation_id = (r1->'reservation'->>'id')::uuid and rt.released_at is null) then
    raise exception 'cancel must release the table allocation';
  end if;
  declare r3 jsonb;
  begin
    r3 := public.atlas_bookings_create(bart,'bartender', jsonb_build_object(
      'party_size',2,'start_at', base,'guest_name','Guest Three'));
    if (r3->'reservation'->'tables'->0->>'label') <> 'Bar 1' then raise exception 'Bar 1 should be free again after the cancel'; end if;
  end;

  -- 6. Availability returns a slots array for a window + party size.
  avail := public.atlas_bookings_availability(bart,'bartender', base, base + interval '2 hours', 4);
  if jsonb_typeof(avail->'slots') <> 'array' then raise exception 'availability must return a slots array'; end if;
  if (avail->>'party_size')::int <> 4 then raise exception 'availability must echo the party size'; end if;

  -- A disallowed status jump (confirmed -> completed is allowed; completed -> arrived is not).
  perform public.atlas_bookings_set_status(mgr,'manager', res_big, 'completed', null);
  begin
    perform public.atlas_bookings_set_status(mgr,'manager', res_big, 'arrived', null);
    raise exception 'an illegal status transition was allowed';
  exception when invalid_parameter_value then null; end;
end $$;

-- 7. Inactive profile fails closed on a read.
do $$ begin
  begin
    perform public.atlas_bookings_snapshot('99000000-0000-4000-8000-0000000000e1', 'bartender', null);
    raise exception 'inactive profile served';
  exception when insufficient_privilege then null; end;
end $$;

do $$ begin raise notice 'S99 bookings: all authorization and integrity checks passed'; end $$;
rollback;
