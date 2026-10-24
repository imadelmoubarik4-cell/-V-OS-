-- S108 Booking notifications + email outbox + hardening — database acceptance on
-- a replayed DB (KANEL × ALCEDO online bookings, Phase 5 + hardening). Proves:
--   1. the email outbox is sealed from browser roles; service_role manages it;
--   2. a public request alerts active managers/admins (not bartender/viewer)
--      through the notification workflow and queues the guest "received" email;
--   3. the reference is KANEL-prefixed (KA-);
--   4. approval queues a 'confirmed' email; a time/party change queues 'changed';
--      cancellation queues 'cancelled';
--   5. every outbox row stays 'queued' — nothing is ever sent;
--   6. no guest email => staff are still alerted, no outbox row;
--   7. idempotency isolation: same key+fingerprint returns the original; the same
--      key from a different fingerprint is a different booking (never shared).
-- Fixtures are created in one transaction and rolled back. Loopback only.
begin;

-- Actors.
insert into auth.users(id, email, raw_user_meta_data) values
  ('a8000000-0000-4000-8000-0000000000a1','s108-admin@example.invalid','{}'),
  ('a8000000-0000-4000-8000-0000000000d1','s108-manager@example.invalid','{}'),
  ('a8000000-0000-4000-8000-0000000000c1','s108-bartender@example.invalid','{}'),
  ('a8000000-0000-4000-8000-0000000000f1','s108-viewer@example.invalid','{}');
update public.profiles set role='admin', active=true, display_name='S108 Admin' where id='a8000000-0000-4000-8000-0000000000a1';
update public.profiles set role='manager', active=true, display_name='S108 Manager' where id='a8000000-0000-4000-8000-0000000000d1';
update public.profiles set role='bartender', active=true, display_name='S108 Bar' where id='a8000000-0000-4000-8000-0000000000c1';
update public.profiles set role='viewer', active=true, display_name='S108 Viewer' where id='a8000000-0000-4000-8000-0000000000f1';

-- 1. The outbox is sealed from browser roles.
do $$ begin
  if has_table_privilege('authenticated','atlas_private.booking_email_outbox','SELECT')
     or has_table_privilege('anon','atlas_private.booking_email_outbox','SELECT') then
    raise exception 's108: browser roles can read the email outbox';
  end if;
end $$;

-- Enable the server flag and give open hours; synthetic test hours, not KANEL's.
update atlas_private.booking_settings set public_online_enabled = true where id = true;
insert into atlas_private.settings_business_hours(weekday, day_label, is_open, open_time, close_time, close_next_day)
select g, 'Day '||g, true, time '17:00', time '23:00', false from generate_series(0,6) g
on conflict (weekday) do update set is_open=true, open_time=time '17:00', close_time=time '23:00', close_next_day=false;

do $s108$
declare
  mgr uuid := 'a8000000-0000-4000-8000-0000000000d1';
  d date := ((now() at time zone 'Atlantic/Reykjavik')::date + 2);
  tz text := 'Atlantic/Reykjavik';
  start_ts timestamptz;
  req jsonb; tok text; res_id uuid; ref text;
  n integer;
begin
  start_ts := (d::text || ' 18:00')::timestamp at time zone tz;

  -- 2 & 3. New request: KANEL reference, staff alerts to managers+admins only,
  -- a queued 'request_received' guest email.
  req := public.atlas_public_booking_request(jsonb_build_object(
    'party_size',2,'start_at',start_ts,'guest_name','Guest','guest_email','guest@example.invalid',
    'fingerprint','fpA','idempotency_key','k1'));
  ref := req->>'reference'; tok := req->>'public_token';
  if ref not like 'KA-%' then raise exception 's108: reference must be KANEL-prefixed, got %', ref; end if;
  select id into res_id from atlas_private.reservations where public_token = tok;

  select count(*) into n from atlas_private.push_notification_queue
   where object_id = res_id and event_type = 'booking_request' and route = 'bookings';
  if n <> 2 then raise exception 's108: expected 2 manager/admin alerts, got %', n; end if;
  if exists (select 1 from atlas_private.push_notification_queue q
      join public.profiles p on p.id = q.audience_user_id
      where q.object_id = res_id and p.role in ('bartender','viewer')) then
    raise exception 's108: non-managers were alerted';
  end if;

  select count(*) into n from atlas_private.booking_email_outbox
   where reservation_id = res_id and kind = 'request_received' and status = 'queued'
     and to_email = 'guest@example.invalid' and from_email = 'kanel@kanel.is';
  if n <> 1 then raise exception 's108: expected one queued request_received email, got %', n; end if;

  -- 4. Approval: staff assign the held stools -> confirmed -> queued 'confirmed'.
  perform public.atlas_bookings_assign(mgr,'manager',res_id,
    jsonb_build_array('bb000000-0000-4000-8000-000000000001','bb000000-0000-4000-8000-000000000002'));
  if (select status from atlas_private.reservations where id = res_id) <> 'confirmed' then
    raise exception 's108: assignment should confirm the request';
  end if;
  select count(*) into n from atlas_private.booking_email_outbox where reservation_id = res_id and kind = 'confirmed' and status = 'queued';
  if n <> 1 then raise exception 's108: expected one queued confirmed email, got %', n; end if;

  -- A time/party change queues a 'changed' email (the trigger fires on any update).
  update atlas_private.reservations set start_at = start_ts + interval '30 minutes', end_at = end_at + interval '30 minutes' where id = res_id;
  select count(*) into n from atlas_private.booking_email_outbox where reservation_id = res_id and kind = 'changed' and status = 'queued';
  if n <> 1 then raise exception 's108: expected one queued changed email, got %', n; end if;

  -- Cancellation queues a 'cancelled' email.
  perform public.atlas_bookings_set_status(mgr,'manager',res_id,'cancelled','guest cancelled');
  select count(*) into n from atlas_private.booking_email_outbox where reservation_id = res_id and kind = 'cancelled' and status = 'queued';
  if n <> 1 then raise exception 's108: expected one queued cancelled email, got %', n; end if;
end $s108$;

-- 5. Nothing is ever sent: every outbox row is still 'queued'.
do $$ begin
  if exists (select 1 from atlas_private.booking_email_outbox where status <> 'queued') then
    raise exception 's108: an email left the queue — outbound delivery must be inert';
  end if;
end $$;

-- 6. No guest email => staff alerted, no outbox row.
do $noemail$
declare
  d date := ((now() at time zone 'Atlantic/Reykjavik')::date + 4);
  tz text := 'Atlantic/Reykjavik';
  start_ts timestamptz;
  req jsonb; res_id uuid; emails integer; alerts integer;
begin
  start_ts := (d::text || ' 18:00')::timestamp at time zone tz;
  req := public.atlas_public_booking_request(jsonb_build_object(
    'party_size',2,'start_at',start_ts,'guest_name','No Email','fingerprint','fpB','idempotency_key','k2'));
  select id into res_id from atlas_private.reservations where public_token = (req->>'public_token');
  select count(*) into emails from atlas_private.booking_email_outbox where reservation_id = res_id;
  select count(*) into alerts from atlas_private.push_notification_queue where object_id = res_id;
  if emails <> 0 then raise exception 's108: no email address must mean no outbox row'; end if;
  if alerts < 1 then raise exception 's108: staff must still be alerted without a guest email'; end if;
end $noemail$;

-- 7. Idempotency isolation across fingerprints.
do $idem$
declare
  d date := ((now() at time zone 'Atlantic/Reykjavik')::date + 5);
  tz text := 'Atlantic/Reykjavik';
  start_ts timestamptz;
  a jsonb; a2 jsonb; b jsonb;
begin
  start_ts := (d::text || ' 18:00')::timestamp at time zone tz;
  a  := public.atlas_public_booking_request(jsonb_build_object('party_size',2,'start_at',start_ts,'guest_name','A','fingerprint','fpX','idempotency_key','shared'));
  a2 := public.atlas_public_booking_request(jsonb_build_object('party_size',2,'start_at',start_ts,'guest_name','A','fingerprint','fpX','idempotency_key','shared'));
  b  := public.atlas_public_booking_request(jsonb_build_object('party_size',2,'start_at',start_ts + interval '90 minutes','guest_name','B','fingerprint','fpY','idempotency_key','shared'));
  if (a2->>'public_token') <> (a->>'public_token') then raise exception 's108: same key+fingerprint must return the original'; end if;
  if (b->>'public_token') = (a->>'public_token') then raise exception 's108: the same key from another fingerprint must NOT return the first guest''s booking'; end if;
end $idem$;

do $$ begin raise notice 'S108 booking notifications: all checks passed'; end $$;
rollback;
