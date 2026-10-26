-- S106 Bookings engine corrections — database acceptance on a replayed DB
-- (KANEL × ALCEDO online bookings, Phase 2). Proves at the database boundary:
--   1. the approved settings values (max_party_online = 4, turnaround = 15);
--   2. the Bar's fixed sections, circular off. Since S112 the stools carry the owner's
--      numbers: L = 1-4 (left), T1 = 5-10 and T2 = 11-12 (top, split by the gap), R = 13-16;
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

-- 2. The Bar is four fixed sections (owner numbering, S112), not a circle ----
do $$
declare bar uuid := 'ba000000-0000-4000-8000-000000000001'; n integer;
begin
  if (select circular_adjacency from atlas_private.booking_areas where id = bar) then
    raise exception 's106: the Bar must no longer be circular';
  end if;
  select count(*) into n from atlas_private.booking_tables
   where area_id = bar and position_index between 1 and 4 and segment = 'L' and label = 'Bar ' || position_index;
  if n <> 4 then raise exception 's106: section L must be Bar 1-4 (got % stools)', n; end if;
  select count(*) into n from atlas_private.booking_tables
   where area_id = bar and position_index between 5 and 10 and segment = 'T1' and label = 'Bar ' || position_index;
  if n <> 6 then raise exception 's106: section T1 must be Bar 5-10 (got % stools)', n; end if;
  select count(*) into n from atlas_private.booking_tables
   where area_id = bar and position_index between 11 and 12 and segment = 'T2' and label = 'Bar ' || position_index;
  if n <> 2 then raise exception 's106: section T2 must be Bar 11-12 (got % stools)', n; end if;
  select count(*) into n from atlas_private.booking_tables
   where area_id = bar and position_index between 13 and 16 and segment = 'R' and label = 'Bar ' || position_index;
  if n <> 4 then raise exception 's106: section R must be Bar 13-16 (got % stools)', n; end if;
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
  -- A party of 6 fits only section T1 (the only 6-stool section): it fills Bar 5-10
  -- and never spills into the neighbouring sections.
  run := atlas_private.booking_find_contiguous_tables(bar, 6, t0, t1, null);
  if run is null or pg_catalog.array_length(run, 1) <> 6 then
    raise exception 's106: a party of 6 should fill section T1';
  end if;
  select count(distinct t.segment) into segs from atlas_private.booking_tables t where t.id = any(run);
  if segs <> 1 then raise exception 's106: a contiguous run must stay in ONE section'; end if;

  -- A party of 7 cannot be seated: no single section holds 7, and the ring no
  -- longer wraps 16 -> 1 to assemble one.
  if atlas_private.booking_find_contiguous_tables(bar, 7, t0, t1, null) is not null then
    raise exception 's106: a party of 7 must not be assembled across sections or by wrapping';
  end if;

  -- A party of 4 is seatable (section L 1-4 is first in order).
  run := atlas_private.booking_find_contiguous_tables(bar, 4, t0, t1, null);
  if run is null or pg_catalog.array_length(run, 1) <> 4 then
    raise exception 's106: a party of 4 should find a contiguous run';
  end if;
end $$;

-- 4. The section-contiguity validator (owner numbering) ----------------------
do $$
declare
  bar uuid := 'ba000000-0000-4000-8000-000000000001';
  b uuid[];
begin
  select pg_catalog.array_agg(id order by position_index) into b
  from atlas_private.booking_tables where area_id = bar and position_index between 1 and 16;
  -- b[n] is Bar n.
  if not atlas_private.booking_tables_contiguous_segment(array[b[1]]) then raise exception 's106: a single stool is valid'; end if;
  if not atlas_private.booking_tables_contiguous_segment(array[b[1], b[2]]) then raise exception 's106: Bar 1+2 (section L, adjacent) is valid'; end if;
  if not atlas_private.booking_tables_contiguous_segment(array[b[8], b[9]]) then raise exception 's106: Bar 8+9 (section T1, adjacent) is valid'; end if;
  if atlas_private.booking_tables_contiguous_segment(array[b[4], b[5]]) then raise exception 's106: Bar 4+5 crosses the L|T1 corner and must be rejected'; end if;
  if atlas_private.booking_tables_contiguous_segment(array[b[10], b[11]]) then raise exception 's106: Bar 10+11 crosses the T1|T2 gap and must be rejected'; end if;
  if atlas_private.booking_tables_contiguous_segment(array[b[12], b[13]]) then raise exception 's106: Bar 12+13 crosses the T2|R corner and must be rejected'; end if;
  if atlas_private.booking_tables_contiguous_segment(array[b[16], b[1]]) then raise exception 's106: Bar 16+1 wraps and must be rejected'; end if;
  if atlas_private.booking_tables_contiguous_segment(array[b[1], b[3]]) then raise exception 's106: Bar 1+3 is gapped and must be rejected'; end if;
end $$;
-- 5. Staff assign refuses a cross-section combination ----------------------
insert into auth.users(id, email, raw_user_meta_data) values
  ('a6000000-0000-4000-8000-0000000000d1', 's106-manager@example.invalid', '{}');
update public.profiles set role='manager', active=true, display_name='S106 Manager'
  where id='a6000000-0000-4000-8000-0000000000d1';

do $assign$
declare
  mgr uuid := 'a6000000-0000-4000-8000-0000000000d1';
  bar10 uuid := (select id from atlas_private.booking_tables where label = 'Bar 10');
  bar11 uuid := (select id from atlas_private.booking_tables where label = 'Bar 11');
  res jsonb; res_id uuid;
begin
  res := public.atlas_bookings_create(mgr, 'manager', jsonb_build_object(
    'party_size', 2, 'start_at', '2027-01-04 18:00:00+00', 'source', 'phone', 'guest_name', 'Corner Pair'));
  res_id := (res->'reservation'->>'id')::uuid;
  begin
    perform public.atlas_bookings_assign(mgr, 'manager', res_id, jsonb_build_array(bar10, bar11));
    raise exception 's106: assigning Bar 10 + Bar 11 across sections was allowed';
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
