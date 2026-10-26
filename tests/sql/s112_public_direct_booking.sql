-- S112 Direct website booking with guest-chosen stools — database acceptance on a
-- replayed DB (KANEL × ALCEDO online bookings). Proves at the database boundary:
--   1. the new helpers are sealed from browser roles; the public RPCs stay service_role-only;
--   2. the owner numbering: every seeded stool keeps its id and floor position and now
--      carries the owner's number, label and section (L 1-4, T1 5-10, T2 11-12, R 13-16);
--   3. the owner switch public_instant_confirm defaults OFF; availability reports
--      booking_mode 'request', then 'instant' once it is on;
--   4. seat_map is keyed by exactly the slot strings and lists only free, online stools;
--      a slot without a run of party_size free stools in one section is not offered;
--   5. with the switch OFF a 'direct' booking is still 'requested' (hold, no seat);
--   6. with it ON: direct + chosen stools = 'confirmed' on exactly those stools; direct
--      without stools = 'confirmed' on an adjacent run; confirmation_email is false;
--   7. a chosen stool already taken is refused with hint atlas:seat_taken (23505);
--   8. corners (4|5, 12|13), the 10|11 gap, gaps, wrong counts, duplicates, unknown and
--      staff-only (block_online) stools are refused as invalid (22023);
--   9. a request with chosen stools holds exactly those stools for staff Confirm;
--  10. idempotent replay returns the same status and stools;
--  11. a confirmed website booking alerts every active manager (kind 'approved').
-- Fixtures are created in one transaction and rolled back. Loopback only.
begin;

-- 1. Sealed helpers ---------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'atlas_private.booking_public_free_seats(uuid,timestamptz,timestamptz)',
    'atlas_private.booking_public_has_run(uuid,integer[],integer)',
    'atlas_private.booking_public_seat_ids(uuid,integer[])',
    'atlas_private.booking_public_reservation_seats(uuid)',
    'public.atlas_public_booking_request(jsonb)',
    'public.atlas_public_booking_availability(date,integer,text)'] loop
    if has_function_privilege('anon', fn, 'EXECUTE') or has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 's112: % is executable by a browser role', fn;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.atlas_public_booking_request(jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.atlas_public_booking_availability(date,integer,text)', 'EXECUTE') then
    raise exception 's112: service_role must execute the public booking RPCs';
  end if;
end $$;

-- 2. Owner numbering ------------------------------------------------------------------
do $$
declare
  bar uuid := 'ba000000-0000-4000-8000-000000000001';
  rec record;
  bad text;
begin
  with want(seed, n, fx, fy, seg) as (values
    (13, 1, 1, 5, 'L'), (14, 2, 1, 4, 'L'), (15, 3, 1, 3, 'L'), (16, 4, 1, 2, 'L'),
    (1, 5, 1, 1, 'T1'), (2, 6, 2, 1, 'T1'), (3, 7, 3, 1, 'T1'), (4, 8, 4, 1, 'T1'), (5, 9, 5, 1, 'T1'), (6, 10, 6, 1, 'T1'),
    (7, 11, 7, 1, 'T2'), (8, 12, 8, 1, 'T2'),
    (9, 13, 8, 2, 'R'), (10, 14, 8, 3, 'R'), (11, 15, 8, 4, 'R'), (12, 16, 8, 5, 'R'))
  select string_agg('seed ' || w.seed || ' -> ' || coalesce(t.label, 'missing'), '; ') into bad
  from want w
  left join atlas_private.booking_tables t
    on t.id = ('bb000000-0000-4000-8000-0000000000' || lpad(w.seed::text, 2, '0'))::uuid
  where t.id is null or t.area_id <> bar or t.position_index <> w.n or t.label <> 'Bar ' || w.n
     or t.segment <> w.seg or t.floor_x <> w.fx or t.floor_y <> w.fy;
  if bad is not null then raise exception 's112: stool numbering is wrong: %', bad; end if;
  if (select circular_adjacency from atlas_private.booking_areas where id = bar) then
    raise exception 's112: the Bar must not wrap';
  end if;
end $$;

-- Test setup: online booking on, every day open 17:00-23:00 (synthetic test hours),
-- two managers to receive alerts.
update atlas_private.booking_settings set public_online_enabled = true where id = true;
insert into atlas_private.settings_business_hours(weekday, day_label, is_open, open_time, close_time, close_next_day)
select g, 'Day '||g, true, time '17:00', time '23:00', false from generate_series(0,6) g
on conflict (weekday) do update set is_open=true, open_time=time '17:00', close_time=time '23:00', close_next_day=false;
insert into auth.users(id, email, raw_user_meta_data) values
  ('a8000000-0000-4000-8000-0000000000a1', 's112-manager@example.invalid', '{}');
update public.profiles set role='manager', active=true, display_name='S112 Manager'
  where id='a8000000-0000-4000-8000-0000000000a1';

do $t$
declare
  bar uuid := 'ba000000-0000-4000-8000-000000000001';
  tz text := 'Atlantic/Reykjavik';
  d date := ((now() at time zone 'Atlantic/Reykjavik')::date + 3);
  s18 timestamptz;
  s20 timestamptz;
  avail jsonb;
  r jsonb;
  r2 jsonb;
  k text;
  n integer;
  seats text;
  h text;
  rid uuid;
  b uuid[];
  try_seats int[];
  bad_sets int[][] := array[[4,5],[10,11],[12,13],[1,3]];
  i integer;
  mgr uuid := 'a8000000-0000-4000-8000-0000000000a1';
begin
  select array_agg(id order by position_index) into b
    from atlas_private.booking_tables where area_id = bar and position_index between 1 and 16;
  s18 := (d::text || ' 18:00')::timestamp at time zone tz;
  s20 := (d::text || ' 20:00')::timestamp at time zone tz;

  -- 3. Switch defaults off -> 'request'.
  if (select public_instant_confirm from atlas_private.booking_settings where id = true) then
    raise exception 's112: public_instant_confirm must default to false';
  end if;
  avail := public.atlas_public_booking_availability(d, 2, tz);
  if avail->>'booking_mode' <> 'request' then raise exception 's112: booking_mode must be request while the switch is off'; end if;

  -- 4. seat_map: same keys as slots, all 16 stools free on an empty day.
  if jsonb_typeof(avail->'seat_map') <> 'object' or jsonb_array_length(avail->'slots') = 0 then
    raise exception 's112: availability must return slots and a seat_map';
  end if;
  select count(*) into n from jsonb_array_elements_text(avail->'slots') sl where not (avail->'seat_map' ? sl);
  if n <> 0 or (select count(*) from jsonb_object_keys(avail->'seat_map')) <> jsonb_array_length(avail->'slots') then
    raise exception 's112: seat_map keys must be exactly the slot strings';
  end if;
  if jsonb_array_length(avail->'seat_map'->(avail->'slots'->>0)) <> 16 then
    raise exception 's112: every stool should be free on an empty day (got %)', avail->'seat_map'->(avail->'slots'->>0);
  end if;
  -- A staff-only stool is never offered online.
  update atlas_private.booking_tables set block_online = true where id = b[16];
  avail := public.atlas_public_booking_availability(d, 2, tz);
  if avail->'seat_map'->(avail->'slots'->>0) @> '[16]'::jsonb then raise exception 's112: a block_online stool was offered'; end if;

  -- 5. Switch OFF: a direct booking is still a request (hold, no permanent seat).
  r := public.atlas_public_booking_request(jsonb_build_object('booking_mode','direct','party_size',2,'start_at',s18,
    'guest_name','Off Switch','seats',jsonb_build_array(5,6),'fingerprint','fp-112','idempotency_key','s112-off'));
  if r->>'status' <> 'requested' then raise exception 's112: direct with the switch off must be requested, got %', r->>'status'; end if;
  if r->'seats' <> '[5,6]'::jsonb then raise exception 's112: a request must report its held stools, got %', r->'seats'; end if;
  if (r->>'confirmation_email')::boolean then raise exception 's112: confirmation_email must be false without a provider'; end if;
  select count(*) into n from atlas_private.booking_holds hh join atlas_private.reservations rr on rr.id = hh.reservation_id
   where rr.public_token = r->>'public_token' and hh.table_id = any(array[b[5], b[6]]) and hh.reason = 'web_pending';
  if n <> 2 then raise exception 's112: 9. a request must hold exactly the chosen stools (got % holds)', n; end if;
  if exists (select 1 from atlas_private.reservation_tables rt join atlas_private.reservations rr on rr.id = rt.reservation_id
              where rr.public_token = r->>'public_token') then
    raise exception 's112: a requested booking must not take a permanent seat';
  end if;

  -- 6. Switch ON.
  update atlas_private.booking_settings set public_instant_confirm = true where id = true;
  if public.atlas_public_booking_availability(d, 2, tz)->>'booking_mode' <> 'instant' then
    raise exception 's112: booking_mode must be instant once the switch is on';
  end if;
  r := public.atlas_public_booking_request(jsonb_build_object('booking_mode','direct','party_size',3,'start_at',s20,
    'guest_name','Chosen Three','guest_email','three@example.invalid','seats',jsonb_build_array(7,8,9),
    'fingerprint','fp-112','idempotency_key','s112-chosen'));
  if r->>'status' <> 'confirmed' then raise exception 's112: direct + switch on must confirm, got %', r->>'status'; end if;
  if r->'seats' <> '[7,8,9]'::jsonb then raise exception 's112: confirmed booking must report stools 7-9, got %', r->'seats'; end if;
  if (r->>'confirmation_email')::boolean then raise exception 's112: confirmation_email must be false without a provider'; end if;
  select string_agg(t.label, '+' order by t.position_index) into seats
    from atlas_private.reservation_tables rt join atlas_private.booking_tables t on t.id = rt.table_id
    join atlas_private.reservations rr on rr.id = rt.reservation_id
   where rr.public_token = r->>'public_token' and rt.released_at is null;
  if seats <> 'Bar 7+Bar 8+Bar 9' then raise exception 's112: confirmed booking must sit on Bar 7-9, got %', seats; end if;
  -- 10. Idempotent replay: same status and stools, no second booking.
  r2 := public.atlas_public_booking_request(jsonb_build_object('booking_mode','direct','party_size',3,'start_at',s20,
    'guest_name','Chosen Three','seats',jsonb_build_array(7,8,9),'fingerprint','fp-112','idempotency_key','s112-chosen'));
  if r2->>'public_token' <> r->>'public_token' or r2->>'status' <> 'confirmed' or r2->'seats' <> '[7,8,9]'::jsonb then
    raise exception 's112: idempotent replay must return the original confirmed booking and stools';
  end if;
  -- 11. Managers are alerted to the confirmed website booking (and the text is clean UTF-8).
  select count(*) into n from atlas_private.booking_notifications bn join atlas_private.reservations rr on rr.id = bn.reservation_id
   where rr.public_token = r->>'public_token' and bn.audience_user_id = mgr and bn.kind = 'approved'
     and bn.body = 'Chosen Three · party of 3';
  if n <> 1 then raise exception 's112: a confirmed website booking must alert the manager once'; end if;

  -- Direct without chosen stools: confirmed on one adjacent run inside one section.
  r := public.atlas_public_booking_request(jsonb_build_object('booking_mode','direct','party_size',4,'start_at',s20,
    'guest_name','Auto Four','fingerprint','fp-112','idempotency_key','s112-auto'));
  if r->>'status' <> 'confirmed' or jsonb_array_length(r->'seats') <> 4 then
    raise exception 's112: direct without stools must confirm four adjacent stools, got % %', r->>'status', r->'seats';
  end if;
  if not atlas_private.booking_tables_contiguous_segment(
       (select array_agg(rt.table_id) from atlas_private.reservation_tables rt join atlas_private.reservations rr on rr.id = rt.reservation_id
         where rr.public_token = r->>'public_token' and rt.released_at is null)) then
    raise exception 's112: auto-assigned stools must be one adjacent group in one section';
  end if;

  -- 7. A taken stool -> seat_taken (stool 8 is booked at 20:00).
  begin
    perform public.atlas_public_booking_request(jsonb_build_object('booking_mode','direct','party_size',2,'start_at',s20,
      'guest_name','Right Side','seats',jsonb_build_array(13,14),'fingerprint','fp-112b','idempotency_key','s112-ok1314'));
  exception when others then raise exception 's112: stools 13+14 at 20:00 should still be free (%)', sqlerrm; end;
  begin
    perform public.atlas_public_booking_request(jsonb_build_object('booking_mode','direct','party_size',1,'start_at',s20,
      'guest_name','Too Late','seats',jsonb_build_array(8),'fingerprint','fp-112b','idempotency_key','s112-taken'));
    raise exception 's112: a taken stool was booked twice';
  exception when unique_violation then
    get stacked diagnostics h = pg_exception_hint;
    if h <> 'atlas:seat_taken' then raise exception 's112: a taken stool must be refused as atlas:seat_taken, got %', h; end if;
  end;

  -- 8. Invalid stool choices.
  for i in 1..array_length(bad_sets, 1) loop
    try_seats := array[bad_sets[i][1], bad_sets[i][2]];
    begin
      perform public.atlas_public_booking_request(jsonb_build_object('booking_mode','direct','party_size',2,
        'start_at',(d::text || ' 21:00')::timestamp at time zone tz,'guest_name','Bad Pair','seats',to_jsonb(try_seats),
        'fingerprint','fp-112c','idempotency_key','s112-bad-' || i));
      raise exception 's112: stools % were accepted', try_seats;
    exception when invalid_parameter_value then null; end;
  end loop;
  foreach k in array array['[1]','[1,1]','[99,1]','[16,15]'] loop  -- wrong count, duplicate, unknown, staff-only
    begin
      perform public.atlas_public_booking_request(jsonb_build_object('booking_mode','direct','party_size',2,
        'start_at',(d::text || ' 21:00')::timestamp at time zone tz,'guest_name','Bad Pick','seats',k::jsonb,
        'fingerprint','fp-112d','idempotency_key','s112-pick-' || k));
      raise exception 's112: stool choice % was accepted', k;
    exception when invalid_parameter_value then null; end;
  end loop;
  -- 5–6–7 in one section is fine (next day, nothing booked).
  r := public.atlas_public_booking_request(jsonb_build_object('booking_mode','direct','party_size',3,
    'start_at',((d + 1)::text || ' 18:00')::timestamp at time zone tz,'guest_name','Good Three','seats',jsonb_build_array(5,6,7),
    'fingerprint','fp-112e','idempotency_key','s112-567'));
  if r->>'status' <> 'confirmed' then raise exception 's112: stools 5-6-7 should confirm'; end if;

  -- 4b. A slot is offered only while a run of party_size free stools exists in one section.
  -- Hold every stool at 18:00 except 10, 12 and 15 (bookings from 20:00 already make
  -- their stools busy at 18:00 through the 15-minute turnaround).
  insert into atlas_private.booking_holds(table_id, start_at, end_at, reason, expires_at)
  select t.id, s18, s18 + interval '120 minutes', 'staff', now() + interval '1 day'
    from atlas_private.booking_tables t
   where t.area_id = bar and t.position_index not in (10, 12, 15) and t.position_index between 1 and 16;
  avail := public.atlas_public_booking_availability(d, 2, tz);
  if avail->'slots' @> to_jsonb(array[to_jsonb(s18) #>> '{}']) then
    raise exception 's112: 18:00 was offered for 2 although no two adjacent free stools share a section';
  end if;
  avail := public.atlas_public_booking_availability(d, 1, tz);
  if avail->'seat_map'->(to_jsonb(s18) #>> '{}') <> '[10,12,15]'::jsonb then
    raise exception 's112: 18:00 for 1 should offer exactly stools 10, 12, 15, got %', avail->'seat_map'->(to_jsonb(s18) #>> '{}');
  end if;

  -- The no-stools request path is unchanged: requested with a hold.
  update atlas_private.booking_settings set public_instant_confirm = false where id = true;
  r := public.atlas_public_booking_request(jsonb_build_object('party_size',1,'start_at',(d::text || ' 17:00')::timestamp at time zone tz,
    'guest_name','Plain Request','fingerprint','fp-112f','idempotency_key','s112-plain'));
  if r->>'status' <> 'requested' or jsonb_array_length(r->'seats') <> 1 then
    raise exception 's112: a plain request must stay requested with one held stool, got % %', r->>'status', r->'seats';
  end if;

  raise notice 'S112 direct booking: all checks passed';
end $t$;

rollback;
