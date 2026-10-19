-- S106 Bookings engine corrections — database acceptance on a replayed DB
-- (KANEL × ALCEDO online bookings, Phase 2). Proves at the database boundary:
--   1. the approved settings values (max_party_online = 4, turnaround = 15);
--   2. the Bar is three fixed sections (A = 1-8, B = 9-12, C = 13-16), circular off;
--   3. booking_find_contiguous_tables never crosses a section and never wraps;
--   4. booking_tables_contiguous_segment rejects cross-section / gapped sets;
--   5. staff assign refuses a cross-section stool combination (correction 7);
--   6. booking_day_last_start_minutes derives the per-day last start from close.
-- Fixtures are created in one transaction and rolled back. Loopback only.
begin;

-- 1. Approved settings values ------------------------------------------------
do $$
declare s atlas_private.booking_settings;
begin
  select * into s from atlas_private.booking_settings where id = true;
  if s.max_party_online <> 4 then raise exception 's106: max_party_online must be 4, got %', s.max_party_online; end if;
  if s.turnaround_minutes <> 15 then raise exception 's106: turnaround_minutes must be 15, got %', s.turnaround_minutes; end if;
end $$;

-- 2. The Bar is three fixed sections, not a circle -------------------------
do $$
declare bar uuid := 'ba000000-0000-4000-8000-000000000001'; n integer;
begin
  if (select circular_adjacency from atlas_private.booking_areas where id = bar) then
    raise exception 's106: the Bar must no longer be circular';
  end if;
  select count(*) into n from atlas_private.booking_tables
   where area_id = bar and position_index between 1 and 8 and segment = 'A';
  if n <> 8 then raise exception 's106: section A must be Bar 1-8 (got % stools)', n; end if;
  select count(*) into n from atlas_private.booking_tables
   where area_id = bar and position_index between 9 and 12 and segment = 'B';
  if n <> 4 then raise exception 's106: section B must be Bar 9-12 (got % stools)', n; end if;
  select count(*) into n from atlas_private.booking_tables
   where area_id = bar and position_index between 13 and 16 and segment = 'C';
  if n <> 4 then raise exception 's106: section C must be Bar 13-16 (got % stools)', n; end if;
  if exists (select 1 from atlas_private.booking_tables where area_id = bar and segment is null) then
    raise exception 's106: every Bar stool must belong to a section';
  end if;
end $$;

-- 3. Contiguity never crosses a section and never wraps --------------------
do $$
declare
  bar uuid := 'ba000000-0000-4000-8000-000000000001';
  t0 timestamptz := '2027-01-04 18:00:00+00';  -- far future, no allocations
  t1 timestamptz := '2027-01-04 20:00:00+00';
  run uuid[];
  segs integer;
begin
  -- A party of 8 fits only section A (the only 8-stool section): it fills Bar 1-8
  -- and never spills into section B.
  run := atlas_private.booking_find_contiguous_tables(bar, 8, t0, t1, null);
  if run is null or pg_catalog.array_length(run, 1) <> 8 then
    raise exception 's106: a party of 8 should fill section A';
  end if;
  select count(distinct t.segment) into segs from atlas_private.booking_tables t where t.id = any(run);
  if segs <> 1 then raise exception 's106: a contiguous run must stay in ONE section'; end if;

  -- A party of 9 cannot be seated: no single section holds 9, and the ring no
  -- longer wraps 16 -> 1 to assemble one.
  if atlas_private.booking_find_contiguous_tables(bar, 9, t0, t1, null) is not null then
    raise exception 's106: a party of 9 must not be assembled across sections or by wrapping';
  end if;

  -- A party of 4 is seatable (section A 1-4 is first in order).
  run := atlas_private.booking_find_contiguous_tables(bar, 4, t0, t1, null);
  if run is null or pg_catalog.array_length(run, 1) <> 4 then
    raise exception 's106: a party of 4 should find a contiguous run';
  end if;
end $$;

-- 4. The section-contiguity validator --------------------------------------
do $$
declare
  bar1 uuid := 'bb000000-0000-4000-8000-000000000001';
  bar2 uuid := 'bb000000-0000-4000-8000-000000000002';
  bar3 uuid := 'bb000000-0000-4000-8000-000000000003';
  bar8 uuid := 'bb000000-0000-4000-8000-000000000008';
  bar9 uuid := 'bb000000-0000-4000-8000-000000000009';
  bar12 uuid := 'bb000000-0000-4000-8000-000000000012';
  bar13 uuid := 'bb000000-0000-4000-8000-000000000013';
  bar16 uuid := 'bb000000-0000-4000-8000-000000000016';
begin
  if not atlas_private.booking_tables_contiguous_segment(array[bar1]) then raise exception 's106: a single stool is valid'; end if;
  if not atlas_private.booking_tables_contiguous_segment(array[bar1, bar2]) then raise exception 's106: Bar 1+2 (section A, adjacent) is valid'; end if;
  if atlas_private.booking_tables_contiguous_segment(array[bar8, bar9]) then raise exception 's106: Bar 8+9 crosses A|B and must be rejected'; end if;
  if atlas_private.booking_tables_contiguous_segment(array[bar12, bar13]) then raise exception 's106: Bar 12+13 crosses B|C and must be rejected'; end if;
  if atlas_private.booking_tables_contiguous_segment(array[bar16, bar1]) then raise exception 's106: Bar 16+1 wraps and must be rejected'; end if;
  if atlas_private.booking_tables_contiguous_segment(array[bar1, bar3]) then raise exception 's106: Bar 1+3 is gapped and must be rejected'; end if;
end $$;

-- 5. Staff assign refuses a cross-section combination ----------------------
insert into auth.users(id, email, raw_user_meta_data) values
  ('a6000000-0000-4000-8000-0000000000d1', 's106-manager@example.invalid', '{}');
update public.profiles set role='manager', active=true, display_name='S106 Manager'
  where id='a6000000-0000-4000-8000-0000000000d1';

do $assign$
declare
  mgr uuid := 'a6000000-0000-4000-8000-0000000000d1';
  bar8 uuid := 'bb000000-0000-4000-8000-000000000008';
  bar9 uuid := 'bb000000-0000-4000-8000-000000000009';
  res jsonb; res_id uuid;
begin
  res := public.atlas_bookings_create(mgr, 'manager', jsonb_build_object(
    'party_size', 2, 'start_at', '2027-01-04 18:00:00+00', 'source', 'phone', 'guest_name', 'Corner Pair'));
  res_id := (res->'reservation'->>'id')::uuid;
  begin
    perform public.atlas_bookings_assign(mgr, 'manager', res_id, jsonb_build_array(bar8, bar9));
    raise exception 's106: assigning Bar 8 + Bar 9 across sections was allowed';
  exception when invalid_parameter_value then null; end;  -- 22023 / atlas:invalid_request
end $assign$;

-- 6. Per-day last start from closing time ----------------------------------
do $$
declare last_minutes integer;
begin
  insert into atlas_private.settings_business_hours(weekday, day_label, is_open, open_time, close_time, close_next_day)
  values (3, 'Wednesday', true, time '17:00', time '23:00', false)
  on conflict (weekday) do update set is_open = true, open_time = time '17:00', close_time = time '23:00', close_next_day = false;
  -- 23:00 close (1380 min) minus a 120-minute visit = 21:00 (1260 min).
  last_minutes := atlas_private.booking_day_last_start_minutes(3::smallint, 120);
  if last_minutes <> 1260 then raise exception 's106: last start for a 23:00 close should be 21:00 (1260), got %', last_minutes; end if;

  -- After-midnight close (01:00 next day = 1500 min) minus 120 = 23:00 (1380 min).
  insert into atlas_private.settings_business_hours(weekday, day_label, is_open, open_time, close_time, close_next_day)
  values (5, 'Friday', true, time '17:00', time '01:00', true)
  on conflict (weekday) do update set is_open = true, open_time = time '17:00', close_time = time '01:00', close_next_day = true;
  last_minutes := atlas_private.booking_day_last_start_minutes(5::smallint, 120);
  if last_minutes <> 1380 then raise exception 's106: last start for a 01:00 next-day close should be 23:00 (1380), got %', last_minutes; end if;

  -- A closed day has no last start.
  insert into atlas_private.settings_business_hours(weekday, day_label, is_open)
  values (1, 'Monday', false)
  on conflict (weekday) do update set is_open = false;
  if atlas_private.booking_day_last_start_minutes(1::smallint, 120) is not null then
    raise exception 's106: a closed day must have no last start';
  end if;
end $$;

do $$ begin raise notice 'S106 bookings engine: all checks passed'; end $$;
rollback;
