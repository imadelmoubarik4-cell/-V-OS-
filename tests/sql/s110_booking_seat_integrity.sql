-- S110 acceptance — booking seat integrity (staff create + assign/move).
-- Runs on a replayed database at S110. Seeds its own actors and bookings in ONE
-- transaction and rolls back. Bar = 16 one-seat stools, sections A 1–8, B 9–12,
-- C 13–16; turnaround 15 min (S106). Every refusal is checked by SQLSTATE:
-- 22023 invalid_parameter_value (atlas:invalid_request), 23505 unique_violation
-- (atlas:conflict), 42501 insufficient_privilege (atlas:forbidden).
begin;

insert into auth.users(id, email, raw_user_meta_data) values
  ('a7000000-0000-4000-8000-0000000000a1', 's110-manager@example.invalid', '{}'),
  ('a7000000-0000-4000-8000-0000000000b1', 's110-bartender@example.invalid', '{}'),
  ('a7000000-0000-4000-8000-0000000000c1', 's110-viewer@example.invalid', '{}');
update public.profiles set role='manager', active=true, display_name='S110 Manager' where id='a7000000-0000-4000-8000-0000000000a1';
update public.profiles set role='bartender', active=true, display_name='S110 Bartender' where id='a7000000-0000-4000-8000-0000000000b1';
update public.profiles set role='viewer', active=true, display_name='S110 Viewer' where id='a7000000-0000-4000-8000-0000000000c1';

-- 0. Grants: the RPCs and the rule helper stay sealed ---------------------------
do $$
begin
  if has_function_privilege('anon', 'public.atlas_bookings_create(uuid,text,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.atlas_bookings_create(uuid,text,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.atlas_bookings_assign(uuid,text,uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.atlas_bookings_assign(uuid,text,uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'atlas_private.booking_check_seat_group(uuid[],uuid,integer,timestamptz,timestamptz,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'atlas_private.booking_check_seat_group(uuid[],uuid,integer,timestamptz,timestamptz,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'atlas_private.booking_table_json(uuid)', 'EXECUTE') then
    raise exception 's110: a booking RPC or helper is executable by a browser role';
  end if;
  if not has_function_privilege('service_role', 'public.atlas_bookings_create(uuid,text,jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.atlas_bookings_assign(uuid,text,uuid,jsonb)', 'EXECUTE') then
    raise exception 's110: service_role lost execute on the staff RPCs';
  end if;
  if (atlas_private.booking_table_json('bb000000-0000-4000-8000-000000000001')->>'segment') is distinct from 'A'
     or (atlas_private.booking_table_json('bb000000-0000-4000-8000-000000000009')->>'segment') is distinct from 'B' then
    raise exception 's110: table JSON must expose the section (segment)';
  end if;
end $$;

do $t$
declare
  mgr uuid := 'a7000000-0000-4000-8000-0000000000a1';
  bart uuid := 'a7000000-0000-4000-8000-0000000000b1';
  viewer uuid := 'a7000000-0000-4000-8000-0000000000c1';
  bar uuid := 'ba000000-0000-4000-8000-000000000001';
  b uuid[];
  d date := date '2027-02-03';
  d_auto date := date '2027-02-04';  -- auto-assign cases run on their own day
  r jsonb; rid uuid; r1 uuid; r4 uuid;
  seats text; n integer; area_after uuid;
  other_area uuid := 'ba000000-0000-4000-8000-0000000000ff';
  other_tbl uuid := 'bb000000-0000-4000-8000-0000000000ff';

begin
  for i in 1..16 loop b[i] := ('bb000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid; end loop;

  -- 1. Parties 1–4, auto-assign: N adjacent stools inside one section, confirmed.
  for k in 1..4 loop
    r := public.atlas_bookings_create(bart, 'bartender', jsonb_build_object(
      'party_size', k, 'start_at', (d_auto::text || ' 11:00')::timestamptz + make_interval(hours => (k - 1) * 3),
      'source', 'phone', 'area_id', bar, 'guest_name', 'S110 auto ' || k));
    rid := (r->'reservation'->>'id')::uuid;
    if r->'reservation'->>'status' <> 'confirmed' then raise exception 's110: auto party % should confirm', k; end if;
    select count(*), string_agg(t.label, '+' order by t.position_index) into n, seats
      from atlas_private.reservation_tables rt join atlas_private.booking_tables t on t.id = rt.table_id
      where rt.reservation_id = rid and rt.released_at is null;
    if n <> k then raise exception 's110: auto party % got % stools (%)', k, n, seats; end if;
    if not atlas_private.booking_tables_contiguous_segment(
         (select array_agg(table_id) from atlas_private.reservation_tables where reservation_id = rid and released_at is null)) then
      raise exception 's110: auto party % got a non-adjacent / cross-section group (%)', k, seats;
    end if;
  end loop;

  -- 2. Explicit adjacent group: party 2 on Bar 3+4, 16:00–18:00.
  r := public.atlas_bookings_create(mgr, 'manager', jsonb_build_object(
    'party_size', 2, 'start_at', d::text || ' 16:00', 'source', 'phone', 'area_id', bar,
    'guest_name', 'S110 B1', 'table_ids', jsonb_build_array(b[3], b[4])));
  r1 := (r->'reservation'->>'id')::uuid;
  if r->'reservation'->>'status' <> 'confirmed' or jsonb_array_length(r->'reservation'->'tables') <> 2 then
    raise exception 's110: explicit Bar 3+4 for 2 should confirm with two stools';
  end if;
  if (r->'reservation'->>'end_at')::timestamptz <> (d::text || ' 18:00')::timestamptz then
    raise exception 's110: a party of 2 should run 16:00–18:00';
  end if;

  -- 3. Same-day reuse and the 15-minute buffer on both sides.
  begin
    perform public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 18:00',
      'source', 'phone', 'area_id', bar, 'table_ids', jsonb_build_array(b[3], b[4])));
    raise exception 's110: 18:00 on Bar 3+4 was allowed inside the 15-minute turnaround';
  exception when unique_violation then null; end;
  begin
    perform public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 14:00',
      'source', 'phone', 'area_id', bar, 'table_ids', jsonb_build_array(b[3], b[4])));
    raise exception 's110: 14:00–16:00 on Bar 3+4 was allowed with no buffer before 16:00';
  exception when unique_violation then null; end;
  r := public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 18:15',
    'source', 'phone', 'area_id', bar, 'guest_name', 'S110 B3', 'table_ids', jsonb_build_array(b[3], b[4])));
  if r->'reservation'->>'status' <> 'confirmed' then raise exception 's110: 18:15 on Bar 3+4 should be allowed (same-day reuse)'; end if;
  r := public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 13:45',
    'source', 'phone', 'area_id', bar, 'guest_name', 'S110 B0', 'table_ids', jsonb_build_array(b[3], b[4])));
  if r->'reservation'->>'status' <> 'confirmed' then raise exception 's110: 13:45–15:45 on Bar 3+4 should be allowed (15 min before 16:00)'; end if;

  -- 4. Explicit create refusals: sections, gaps, capacity, duplicates, unknown seat.
  begin
    perform public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 21:00',
      'source', 'phone', 'area_id', bar, 'table_ids', jsonb_build_array(b[8], b[9])));
    raise exception 's110: create on Bar 8+9 (crosses A|B) was allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 21:00',
      'source', 'phone', 'area_id', bar, 'table_ids', jsonb_build_array(b[1], b[3])));
    raise exception 's110: create on non-adjacent Bar 1+3 was allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 21:00',
      'source', 'phone', 'area_id', bar, 'table_ids', jsonb_build_array(b[6])));
    raise exception 's110: one stool for a party of 2 was allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 21:00',
      'source', 'phone', 'area_id', bar, 'table_ids', jsonb_build_array(b[6], b[6])));
    raise exception 's110: a duplicated stool counted twice for capacity';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 1, 'start_at', d::text || ' 21:00',
      'source', 'phone', 'area_id', bar, 'table_ids', jsonb_build_array(gen_random_uuid())));
    raise exception 's110: an unknown seat id was accepted';
  exception when invalid_parameter_value then null; end;

  -- 5. Unavailable seats never produce an allocation (explicit, window, auto).
  update atlas_private.booking_tables set temporarily_unavailable = true where id = b[6];
  begin
    perform public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 21:00',
      'source', 'phone', 'area_id', bar, 'table_ids', jsonb_build_array(b[5], b[6])));
    raise exception 's110: a temporarily unavailable stool was allocated';
  exception when invalid_parameter_value then null; end;
  update atlas_private.booking_tables set temporarily_unavailable = false,
    unavailable_from = (d::text || ' 20:00')::timestamptz, unavailable_until = (d::text || ' 23:00')::timestamptz where id = b[6];
  begin
    perform public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 21:00',
      'source', 'phone', 'area_id', bar, 'table_ids', jsonb_build_array(b[5], b[6])));
    raise exception 's110: a stool inside its unavailable window was allocated';
  exception when invalid_parameter_value then null; end;
  update atlas_private.booking_tables set unavailable_from = null, unavailable_until = null where id = b[6];
  update atlas_private.booking_tables set is_bookable = false where id = b[7];
  begin
    perform public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 21:00',
      'source', 'phone', 'area_id', bar, 'table_ids', jsonb_build_array(b[7], b[8])));
    raise exception 's110: a non-bookable stool was allocated';
  exception when invalid_parameter_value then null; end;
  update atlas_private.booking_tables set is_bookable = true where id = b[7];

  -- 6. Assign / move: valid group, sections, capacity, duplicates, taken seats.
  perform public.atlas_bookings_assign(mgr, 'manager', r1, jsonb_build_array(b[5], b[6]));
  select string_agg(t.label, '+' order by t.position_index) into seats
    from atlas_private.reservation_tables rt join atlas_private.booking_tables t on t.id = rt.table_id
    where rt.reservation_id = r1 and rt.released_at is null;
  if seats <> 'Bar 5+Bar 6' then raise exception 's110: move to Bar 5+6 should hold exactly Bar 5+6 (got %)', seats; end if;
  begin
    perform public.atlas_bookings_assign(mgr, 'manager', r1, jsonb_build_array(b[8], b[9]));
    raise exception 's110: move to Bar 8+9 (crosses A|B) was allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.atlas_bookings_assign(mgr, 'manager', r1, jsonb_build_array(b[16]));
    raise exception 's110: move of a party of 2 onto one stool was allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.atlas_bookings_assign(mgr, 'manager', r1, jsonb_build_array(b[10], b[10]));
    raise exception 's110: a duplicated stool was accepted on move';
  exception when invalid_parameter_value then null; end;
  begin
    -- Bar 3 is taken by B3 (18:15–20:15); B1 runs 16:00–18:00 — 18:00 + 15 overlaps.
    perform public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 18:30',
      'source', 'phone', 'area_id', bar, 'table_ids', jsonb_build_array(b[11], b[12])));
    perform public.atlas_bookings_assign(mgr, 'manager', r1, jsonb_build_array(b[11], b[12]));
    -- r1 (16:00–18:00) on Bar 11+12 vs the 18:30 booking: 18:00 + 15 < 18:30 → allowed.
  exception when others then raise exception 's110: a move that respects the buffer was refused (%)', sqlerrm; end;
  begin
    perform public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 18:00',
      'source', 'phone', 'area_id', bar, 'table_ids', jsonb_build_array(b[13], b[14])));
    perform public.atlas_bookings_assign(mgr, 'manager', r1, jsonb_build_array(b[13], b[14]));
    raise exception 's110: a move onto stools booked from 18:00 (inside the buffer) was allowed';
  exception when unique_violation then null; end;
  -- A party of 4 needs 4 adjacent stools in one section.
  r := public.atlas_bookings_create(mgr, 'manager', jsonb_build_object('party_size', 4, 'start_at', d::text || ' 23:00',
    'source', 'phone', 'area_id', bar, 'guest_name', 'S110 four', 'table_ids', jsonb_build_array(b[9], b[10], b[11], b[12])));
  r4 := (r->'reservation'->>'id')::uuid;
  begin
    perform public.atlas_bookings_assign(mgr, 'manager', r4, jsonb_build_array(b[13], b[14], b[15]));
    raise exception 's110: three stools for a party of 4 were allowed';
  exception when invalid_parameter_value then null; end;
  perform public.atlas_bookings_assign(mgr, 'manager', r4, jsonb_build_array(b[13], b[14], b[15], b[16]));

  -- 7. A move to another seat-based location records that location.
  insert into atlas_private.booking_areas (id, name, section_colour, display_order, is_active, allocation_mode)
  values (other_area, 'S110 Terrace', 'sage', 99, true, 'tables');
  insert into atlas_private.booking_tables (id, area_id, label, seat_capacity, min_party, priority, is_bookable, block_online)
  values (other_tbl, other_area, 'Terrace 1', 4, 0, 1, true, false);
  perform public.atlas_bookings_assign(mgr, 'manager', r4, jsonb_build_array(other_tbl));
  select area_id into area_after from atlas_private.reservations where id = r4;
  if area_after <> other_area then raise exception 's110: a move to another location must record that location'; end if;
  begin
    perform public.atlas_bookings_assign(mgr, 'manager', r4, jsonb_build_array(other_tbl, b[1]));
    raise exception 's110: seats from two locations were accepted';
  exception when invalid_parameter_value then null; end;

  -- 8. Authorisation unchanged: a viewer can neither create nor move.
  begin
    perform public.atlas_bookings_create(viewer, 'viewer', jsonb_build_object('party_size', 2, 'start_at', d::text || ' 12:00',
      'source', 'phone', 'area_id', bar));
    raise exception 's110: a viewer created a booking';
  exception when insufficient_privilege then null; end;
  begin
    perform public.atlas_bookings_assign(viewer, 'viewer', r1, jsonb_build_array(b[5], b[6]));
    raise exception 's110: a viewer moved a booking';
  exception when insufficient_privilege then null; end;

  raise notice 's110 booking seat integrity: all checks passed';
end $t$;

rollback;
