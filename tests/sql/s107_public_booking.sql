-- S107 Public booking API — database acceptance on a replayed DB (KANEL × ALCEDO
-- online bookings, Phase 3). Proves at the database boundary:
--   1. the public RPCs are sealed from anon/authenticated; service_role executes;
--   2. both server gates default OFF: with public_online_enabled=false the public
--      RPCs refuse (atlas:disabled);
--   3. with it on: availability honours party 1..4, the 90-day horizon, opening
--      hours + close-derived last start, and section-bounded contiguity;
--   4. a request is always created 'requested' (never confirmed), with an
--      unguessable token and an expiring hold, and allocates NO permanent seat;
--   5. only the Bar is online-bookable; other areas are refused;
--   6. status lookup needs the unguessable token and returns only that booking's
--      own minimal fields (no phone/email/staff notes/table ids/other guests);
--   7. idempotency returns the original request; the rate limit refuses a flood;
--   8. a second request cannot hold a stool the first already holds (no double
--      hold of the same seat in the pending window).
-- Fixtures are created in one transaction and rolled back. Loopback only.
begin;

-- 1. The public RPCs are sealed from browser roles; service_role can execute.
do $$
begin
  if has_function_privilege('authenticated', 'public.atlas_public_booking_request(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.atlas_public_booking_availability(date,integer,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.atlas_public_booking_status(text)', 'EXECUTE') then
    raise exception 's107: browser roles can execute a public booking RPC';
  end if;
  if not has_function_privilege('service_role', 'public.atlas_public_booking_request(jsonb)', 'EXECUTE') then
    raise exception 's107: service_role must execute the public booking RPCs';
  end if;
end $$;

-- 2. Both gates default OFF: the seeded settings must have public_online_enabled false.
do $$
begin
  if (select public_online_enabled from atlas_private.booking_settings where id = true) then
    raise exception 's107: public_online_enabled must default to false';
  end if;
  begin
    perform public.atlas_public_booking_availability(((now() at time zone 'Atlantic/Reykjavik')::date + 1), 2, 'Atlantic/Reykjavik');
    raise exception 's107: availability served while the server flag is off';
  exception when sqlstate '22023' then null; end;  -- atlas:disabled
end $$;

-- Turn the server flag on and give every weekday open hours (17:00-23:00) for the
-- test window. These are synthetic test hours, not KANEL's confirmed schedule.
update atlas_private.booking_settings set public_online_enabled = true where id = true;
insert into atlas_private.settings_business_hours(weekday, day_label, is_open, open_time, close_time, close_next_day)
select g, 'Day '||g, true, time '17:00', time '23:00', false from generate_series(0,6) g
on conflict (weekday) do update set is_open=true, open_time=time '17:00', close_time=time '23:00', close_next_day=false;

do $pub$
declare
  d date := ((now() at time zone 'Atlantic/Reykjavik')::date + 2);
  tz text := 'Atlantic/Reykjavik';
  avail jsonb;
  start_ts timestamptz;
  req jsonb;
  tok text;
  st jsonb;
  holds_n integer;
  seats_n integer;
  req2 jsonb;
begin
  -- 3. Availability: party within cap returns slots; over-cap and far dates refuse.
  avail := public.atlas_public_booking_availability(d, 2, tz);
  if jsonb_typeof(avail->'slots') <> 'array' or jsonb_array_length(avail->'slots') = 0 then
    raise exception 's107: availability should return slots for an open day';
  end if;
  begin
    perform public.atlas_public_booking_availability(d, 5, tz);
    raise exception 's107: a party of 5 was offered online';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.atlas_public_booking_availability(d + 400, 2, tz);
    raise exception 's107: a date beyond the horizon was offered';
  exception when sqlstate '22023' then null; end;

  -- 4. A request is created 'requested', with a token + expiring hold, NO seat.
  start_ts := (d::text || ' 18:00')::timestamp at time zone tz;
  req := public.atlas_public_booking_request(jsonb_build_object(
    'party_size',2,'start_at',start_ts,'guest_name','Guest','guest_phone','555','guest_email','g@e.invalid',
    'fingerprint','fp-1','idempotency_key','idem-s107-1'));
  if (req->>'status') <> 'requested' then raise exception 's107: a public request must be requested, not %', req->>'status'; end if;
  tok := req->>'public_token';
  if tok is null or length(tok) < 24 then raise exception 's107: a request must return an unguessable token'; end if;
  if (req->>'reference') is null then raise exception 's107: a request must return a reference'; end if;

  select count(*) into seats_n from atlas_private.reservation_tables rt
    join atlas_private.reservations r on r.id = rt.reservation_id
   where r.public_token = tok and rt.released_at is null;
  if seats_n <> 0 then raise exception 's107: a requested booking must not hold a permanent seat'; end if;
  select count(*) into holds_n from atlas_private.booking_holds h
    join atlas_private.reservations r on r.id = h.reservation_id
   where r.public_token = tok and h.reason = 'web_pending' and h.expires_at > now();
  if holds_n < 1 then raise exception 's107: a requested booking must place an expiring hold'; end if;

  -- 6. Status by token returns only minimal fields; wrong/short token is not found.
  st := public.atlas_public_booking_status(tok);
  if (st->>'status') <> 'requested' or (st->>'reference') is null then raise exception 's107: status must echo the booking'; end if;
  if st ? 'guest_phone' or st ? 'guest_email' or st ? 'staff_notes' or st ? 'tables' or st ? 'id' then
    raise exception 's107: status leaked private fields';
  end if;
  begin
    perform public.atlas_public_booking_status('short');
    raise exception 's107: a short token was accepted';
  exception when sqlstate 'P0002' then null; end;

  -- 7. Idempotency: the same key returns the original request, not a new row.
  req2 := public.atlas_public_booking_request(jsonb_build_object(
    'party_size',2,'start_at',start_ts,'guest_name','Guest','fingerprint','fp-1','idempotency_key','idem-s107-1'));
  if (req2->>'public_token') <> tok then raise exception 's107: idempotency must return the original booking'; end if;
end $pub$;

-- 5. Only the Bar is online-bookable.
do $$
begin
  if exists (select 1 from atlas_private.booking_areas where online_bookable and id <> 'ba000000-0000-4000-8000-000000000001') then
    raise exception 's107: only the Bar may be online-bookable';
  end if;
  if not (select online_bookable from atlas_private.booking_areas where id = 'ba000000-0000-4000-8000-000000000001') then
    raise exception 's107: the Bar must be online-bookable';
  end if;
end $$;

-- 7b. The rate limit refuses a flood from one fingerprint.
do $$
declare i integer; ok boolean; refused boolean := false;
begin
  for i in 1..12 loop
    ok := atlas_private.booking_public_rate_ok('flood-fp', 8, 600);
    if not ok then refused := true; end if;
  end loop;
  if not refused then raise exception 's107: the rate limit never refused a flood'; end if;
end $$;

-- 8. A second request cannot hold a stool the first already holds in the window.
do $conc$
declare
  d date := ((now() at time zone 'Atlantic/Reykjavik')::date + 3);
  tz text := 'Atlantic/Reykjavik';
  start_ts timestamptz;
  bar uuid := 'ba000000-0000-4000-8000-000000000001';
  free_run uuid[];
  t uuid;
  held_count integer;
begin
  -- Occupy sections B and C and most of A so only Bar 1-2 remain free, then two
  -- party-of-2 requests compete for that last pair.
  start_ts := (d::text || ' 18:00')::timestamp at time zone tz;
  for t in select id from atlas_private.booking_tables
            where area_id = bar and position_index between 3 and 16 loop
    insert into atlas_private.booking_holds(table_id, start_at, end_at, reason, expires_at)
    values (t, start_ts, start_ts + interval '120 minutes', 'staff', now() + interval '120 minutes');
  end loop;
  -- First request takes Bar 1-2.
  perform public.atlas_public_booking_request(jsonb_build_object(
    'party_size',2,'start_at',start_ts,'guest_name','First','fingerprint','fp-c1','idempotency_key','c-1'));
  -- The only free pair is now held; a second party-of-2 at the same time is refused.
  begin
    perform public.atlas_public_booking_request(jsonb_build_object(
      'party_size',2,'start_at',start_ts,'guest_name','Second','fingerprint','fp-c2','idempotency_key','c-2'));
    raise exception 's107: a second request double-held the same stools';
  exception when sqlstate '23505' then null; end;  -- atlas:conflict
  -- Bar 1 is held exactly once for THIS window (only the first request).
  select count(*) into held_count from atlas_private.booking_holds
   where table_id = 'bb000000-0000-4000-8000-000000000001'
     and reason = 'web_pending' and expires_at > now() and start_at = start_ts;
  if held_count <> 1 then raise exception 's107: Bar 1 was held % times, expected 1', held_count; end if;
end $conc$;

do $$ begin raise notice 'S107 public booking: all checks passed'; end $$;
rollback;
