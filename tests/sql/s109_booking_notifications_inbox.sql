-- S109 In-app booking notification inbox + lifecycle/security corrections —
-- database acceptance on a replayed DB (KANEL × ALCEDO online bookings, Phase 5
-- completion + hardening; owner review of PR #135). Proves the ACTUAL end-to-end
-- flow, not merely that queue rows exist:
--   1. A public request writes a real in-app INBOX row for every active
--      manager/admin (not bartender/viewer); atlas_bookings_notifications returns
--      them with an unread count and a 'bookings' deep-link route; marking read
--      (by id and all) is permission-gated to managers.
--   3. The lifecycle workflow is gated on the public_token origin marker: a legacy
--      (null public_token) reservation triggers NO inbox row, NO email, NO push —
--      KANEL-branded mail is never queued for VÁ Bar / Sinna bookings.
--   4. A rejected pending request (requested->cancelled) => 'declined' (distinct
--      email + inbox kind); a cancelled confirmed booking (confirmed->cancelled)
--      => 'cancelled'; no_show writes the inbox only and NEVER a guest email.
--   5a. The status RPC enforces the database feature flag (off => disabled).
--   5f. A conflicting idempotency payload is refused and never returns the stored
--       guest's private token; a matching replay returns the original.
--   6.  Outbox de-duplication: a repeated identical lifecycle event cannot enqueue
--       a second guest email.
-- Fixtures are created in one transaction and rolled back. Loopback only.
begin;

-- Actors: an admin, a manager, a bartender, a viewer.
insert into auth.users(id, email, raw_user_meta_data) values
  ('a9000000-0000-4000-8000-0000000000a1','s109-admin@example.invalid','{}'),
  ('a9000000-0000-4000-8000-0000000000d1','s109-manager@example.invalid','{}'),
  ('a9000000-0000-4000-8000-0000000000c1','s109-bartender@example.invalid','{}'),
  ('a9000000-0000-4000-8000-0000000000f1','s109-viewer@example.invalid','{}');
update public.profiles set role='admin', active=true, display_name='S109 Admin' where id='a9000000-0000-4000-8000-0000000000a1';
update public.profiles set role='manager', active=true, display_name='S109 Manager' where id='a9000000-0000-4000-8000-0000000000d1';
update public.profiles set role='bartender', active=true, display_name='S109 Bar' where id='a9000000-0000-4000-8000-0000000000c1';
update public.profiles set role='viewer', active=true, display_name='S109 Viewer' where id='a9000000-0000-4000-8000-0000000000f1';

-- The inbox is sealed from browser roles (service_role manages it).
do $$ begin
  if has_table_privilege('authenticated','atlas_private.booking_notifications','SELECT')
     or has_table_privilege('anon','atlas_private.booking_notifications','SELECT') then
    raise exception 's109: browser roles can read the in-app notification inbox';
  end if;
end $$;

-- Enable the server flag and give open hours; synthetic test hours, not KANEL's.
update atlas_private.booking_settings set public_online_enabled = true where id = true;
insert into atlas_private.settings_business_hours(weekday, day_label, is_open, open_time, close_time, close_next_day)
select g, 'Day '||g, true, time '17:00', time '23:00', false from generate_series(0,6) g
on conflict (weekday) do update set is_open=true, open_time=time '17:00', close_time=time '23:00', close_next_day=false;

-- 1. In-app inbox + the staff RPCs (list, unread count, mark read, permissions).
do $inbox$
declare
  admin_id uuid := 'a9000000-0000-4000-8000-0000000000a1';
  mgr uuid := 'a9000000-0000-4000-8000-0000000000d1';
  bar uuid := 'a9000000-0000-4000-8000-0000000000c1';
  d date := ((now() at time zone 'Atlantic/Reykjavik')::date + 2);
  tz text := 'Atlantic/Reykjavik';
  start_ts timestamptz;
  req jsonb; tok text; res_id uuid;
  listing jsonb; n integer; first_id uuid; denied boolean;
begin
  start_ts := (d::text || ' 18:00')::timestamp at time zone tz;
  req := public.atlas_public_booking_request(jsonb_build_object(
    'party_size',2,'start_at',start_ts,'guest_name','Inbox Guest','guest_email','inbox@example.invalid',
    'fingerprint','fp-inbox','idempotency_key','inbox-1'));
  tok := req->>'public_token';
  select id into res_id from atlas_private.reservations where public_token = tok;

  -- A real inbox row for each active manager/admin, kind 'request', bookings route.
  select count(*) into n from atlas_private.booking_notifications
   where reservation_id = res_id and kind = 'request' and route = 'bookings';
  if n <> 2 then raise exception 's109: expected 2 manager/admin inbox rows, got %', n; end if;
  if exists (select 1 from atlas_private.booking_notifications bn
      join public.profiles p on p.id = bn.audience_user_id
      where bn.reservation_id = res_id and p.role in ('bartender','viewer')) then
    raise exception 's109: bartender/viewer must not receive booking inbox rows';
  end if;

  -- The manager RPC returns the item with a deep link + an unread count.
  listing := public.atlas_bookings_notifications(mgr, 'manager', 30);
  if (listing->>'unread')::int < 1 then raise exception 's109: unread count must be >= 1'; end if;
  if jsonb_array_length(listing->'items') < 1 then raise exception 's109: inbox listing is empty for the manager'; end if;
  if (listing->'items'->0->>'reservation_id')::uuid <> res_id then raise exception 's109: inbox item must deep-link the reservation'; end if;
  if (listing->'items'->0->>'route') <> 'bookings' then raise exception 's109: inbox item must route to bookings'; end if;
  if (listing->'items'->0->>'read')::boolean <> false then raise exception 's109: a new item must be unread'; end if;
  first_id := (listing->'items'->0->>'id')::uuid;

  -- A bartender may NOT read the booking inbox (manager/admin only).
  denied := false;
  begin
    perform public.atlas_bookings_notifications(bar, 'bartender', 30);
  exception when others then denied := true;
  end;
  if not denied then raise exception 's109: a bartender must not be able to read the booking inbox'; end if;

  -- Mark one read by id -> unread drops; then mark all read -> zero unread.
  if (public.atlas_bookings_notification_read(mgr, 'manager', jsonb_build_array(first_id::text), false)->>'updated')::int <> 1 then
    raise exception 's109: marking one notification read should update exactly one row';
  end if;
  listing := public.atlas_bookings_notifications(mgr, 'manager', 30);
  if (listing->'items'->0->>'read')::boolean <> true then raise exception 's109: the marked item must now read as read'; end if;

  -- The admin still has their own unread copy (per-user inbox), unaffected.
  if (public.atlas_bookings_notifications(admin_id, 'admin', 30)->>'unread')::int < 1 then
    raise exception 's109: the admin keeps an independent unread copy';
  end if;

  -- Mark-all clears the manager's remaining unread.
  perform public.atlas_bookings_notification_read(mgr, 'manager', null, true);
  if (public.atlas_bookings_notifications(mgr, 'manager', 30)->>'unread')::int <> 0 then
    raise exception 's109: mark-all must clear the manager unread count';
  end if;

  -- A new request must also queue the actionable phone push to managers/admins,
  -- routed to bookings so the service worker opens the reservation.
  select count(*) into n from atlas_private.push_notification_queue
   where object_id = res_id and event_type = 'booking_request' and route = 'bookings';
  if n <> 2 then raise exception 's109: expected 2 booking_request pushes, got %', n; end if;
end $inbox$;

-- 3. Origin marker: a LEGACY reservation (no public_token) triggers nothing.
do $legacy$
declare
  d date := ((now() at time zone 'Atlantic/Reykjavik')::date + 3);
  tz text := 'Atlantic/Reykjavik';
  start_ts timestamptz;
  legacy_id uuid := gen_random_uuid();
begin
  start_ts := (d::text || ' 18:00')::timestamp at time zone tz;
  insert into atlas_private.reservations
    (id, source, status, start_at, end_at, party_size, guest_name, guest_email, booking_reference, public_token)
  values (legacy_id, 'phone', 'requested', start_ts, start_ts + interval '120 minutes', 2,
          'Legacy VA Bar Guest', 'legacy@example.invalid', 'VA-LEGACY1', null);
  -- A full lifecycle on the legacy row: confirm, change, cancel.
  update atlas_private.reservations set status='confirmed' where id = legacy_id;
  update atlas_private.reservations set start_at = start_ts + interval '30 minutes',
         end_at = start_ts + interval '150 minutes' where id = legacy_id;
  update atlas_private.reservations set status='cancelled' where id = legacy_id;

  if exists (select 1 from atlas_private.booking_notifications where reservation_id = legacy_id) then
    raise exception 's109: a legacy (null public_token) booking must not write the inbox';
  end if;
  if exists (select 1 from atlas_private.booking_email_outbox where reservation_id = legacy_id) then
    raise exception 's109: a legacy booking must never queue a KANEL guest email';
  end if;
  if exists (select 1 from atlas_private.push_notification_queue where object_id = legacy_id) then
    raise exception 's109: a legacy booking must not push staff notifications';
  end if;
end $legacy$;

-- 4. Rejection vs cancellation vs no_show.
do $lifecycle$
declare
  tz text := 'Atlantic/Reykjavik';
  d1 date := ((now() at time zone 'Atlantic/Reykjavik')::date + 4);
  d2 date := ((now() at time zone 'Atlantic/Reykjavik')::date + 5);
  d3 date := ((now() at time zone 'Atlantic/Reykjavik')::date + 6);
  reject_id uuid; cancel_id uuid; noshow_id uuid;
  req jsonb;
  n integer;
begin
  -- (a) A pending request that staff turn down => 'declined', not 'cancelled'.
  req := public.atlas_public_booking_request(jsonb_build_object(
      'party_size',2,'start_at',(d1::text||' 18:00')::timestamp at time zone tz,
      'guest_name','Reject Me','guest_email','reject@example.invalid',
      'fingerprint','fp-reject','idempotency_key','reject-1'));
  select id into reject_id from atlas_private.reservations where public_token = (req->>'public_token');
  update atlas_private.reservations set status='cancelled' where id = reject_id;  -- from 'requested'
  select count(*) into n from atlas_private.booking_email_outbox where reservation_id = reject_id and kind = 'declined' and status = 'queued';
  if n <> 1 then raise exception 's109: a rejected request must queue exactly one declined email, got %', n; end if;
  if exists (select 1 from atlas_private.booking_email_outbox where reservation_id = reject_id and kind = 'cancelled') then
    raise exception 's109: a rejected pending request must NOT be emailed as a cancellation';
  end if;
  if not exists (select 1 from atlas_private.booking_notifications where reservation_id = reject_id and kind = 'declined') then
    raise exception 's109: a rejected request must write a declined inbox row';
  end if;

  -- (b) A confirmed booking later cancelled => 'cancelled'.
  req := public.atlas_public_booking_request(jsonb_build_object(
      'party_size',2,'start_at',(d2::text||' 18:00')::timestamp at time zone tz,
      'guest_name','Cancel Me','guest_email','cancel@example.invalid',
      'fingerprint','fp-cancel','idempotency_key','cancel-1'));
  select id into cancel_id from atlas_private.reservations where public_token = (req->>'public_token');
  update atlas_private.reservations set status='confirmed' where id = cancel_id;
  update atlas_private.reservations set status='cancelled' where id = cancel_id;  -- from 'confirmed'
  select count(*) into n from atlas_private.booking_email_outbox where reservation_id = cancel_id and kind = 'cancelled' and status = 'queued';
  if n <> 1 then raise exception 's109: a cancelled confirmed booking must queue exactly one cancelled email, got %', n; end if;
  if exists (select 1 from atlas_private.booking_email_outbox where reservation_id = cancel_id and kind = 'declined') then
    raise exception 's109: a cancelled confirmed booking must NOT be emailed as a rejection';
  end if;

  -- (c) no_show: inbox only, never a guest email.
  req := public.atlas_public_booking_request(jsonb_build_object(
      'party_size',2,'start_at',(d3::text||' 18:00')::timestamp at time zone tz,
      'guest_name','No Show','guest_email','noshow@example.invalid',
      'fingerprint','fp-noshow','idempotency_key','noshow-1'));
  select id into noshow_id from atlas_private.reservations where public_token = (req->>'public_token');
  -- Clear the request_received email so the assertion isolates the no_show step.
  delete from atlas_private.booking_email_outbox where reservation_id = noshow_id;
  update atlas_private.reservations set status='no_show' where id = noshow_id;  -- from 'requested'
  if not exists (select 1 from atlas_private.booking_notifications where reservation_id = noshow_id and kind = 'no_show') then
    raise exception 's109: a no_show must write a no_show inbox row';
  end if;
  if exists (select 1 from atlas_private.booking_email_outbox where reservation_id = noshow_id) then
    raise exception 's109: a no_show must never queue a guest email';
  end if;
end $lifecycle$;

-- 6. Outbox de-duplication: a repeated identical event cannot send twice.
do $dedup$
declare
  tz text := 'Atlantic/Reykjavik';
  d date := ((now() at time zone 'Atlantic/Reykjavik')::date + 7);
  res_id uuid; req jsonb; n integer;
begin
  req := public.atlas_public_booking_request(jsonb_build_object(
      'party_size',2,'start_at',(d::text||' 18:00')::timestamp at time zone tz,
      'guest_name','Dedup Guest','guest_email','dedup@example.invalid',
      'fingerprint','fp-dedup','idempotency_key','dedup-1'));
  select id into res_id from atlas_private.reservations where public_token = (req->>'public_token');
  -- Confirm (queues one 'confirmed'); bounce through an intermediate status and
  -- back to confirmed — an identical 'confirmed' event with the same dedupe key.
  update atlas_private.reservations set status='confirmed' where id = res_id;
  update atlas_private.reservations set status='arrived'   where id = res_id;  -- not notified
  update atlas_private.reservations set status='confirmed' where id = res_id;  -- duplicate confirmed
  select count(*) into n from atlas_private.booking_email_outbox where reservation_id = res_id and kind = 'confirmed';
  if n <> 1 then raise exception 's109: a repeated identical event must not enqueue a duplicate email, got %', n; end if;
end $dedup$;

-- 5a. The status RPC enforces the database feature flag (off => disabled).
do $flag$
declare tok text; raised text := '';
begin
  select public_token into tok from atlas_private.reservations where public_token is not null limit 1;
  update atlas_private.booking_settings set public_online_enabled = false where id = true;
  begin
    perform public.atlas_public_booking_status(tok);
  exception when others then raised := coalesce(nullif(sqlerrm,''),'raised');
  end;
  if raised = '' then raise exception 's109: the status RPC must refuse while the DB flag is off'; end if;
  -- And the request RPC is likewise gated.
  raised := '';
  begin
    perform public.atlas_public_booking_request(jsonb_build_object(
      'party_size',2,'start_at',(now() + interval '2 days'),'guest_name','Flag Off'));
  exception when others then raised := 'blocked';
  end;
  if raised = '' then raise exception 's109: the request RPC must refuse while the DB flag is off'; end if;
  update atlas_private.booking_settings set public_online_enabled = true where id = true;  -- restore
end $flag$;

-- 5f. A conflicting idempotency payload is refused; a matching replay is returned.
do $idem$
declare
  tz text := 'Atlantic/Reykjavik';
  d date := ((now() at time zone 'Atlantic/Reykjavik')::date + 8);
  start_ts timestamptz;
  a jsonb; replay jsonb; conflicted boolean := false;
begin
  start_ts := (d::text || ' 18:00')::timestamp at time zone tz;
  a := public.atlas_public_booking_request(jsonb_build_object(
    'party_size',2,'start_at',start_ts,'guest_name','Idem A','guest_email','idem@example.invalid',
    'fingerprint','fp-idem','idempotency_key','idem-key'));
  -- Same key + fingerprint + same party/time => the original is returned.
  replay := public.atlas_public_booking_request(jsonb_build_object(
    'party_size',2,'start_at',start_ts,'guest_name','Idem A','guest_email','idem@example.invalid',
    'fingerprint','fp-idem','idempotency_key','idem-key'));
  if (replay->>'public_token') <> (a->>'public_token') then
    raise exception 's109: a matching idempotency replay must return the original token';
  end if;
  -- Same key + fingerprint but a CONFLICTING party size => refused, no token leaked.
  begin
    perform public.atlas_public_booking_request(jsonb_build_object(
      'party_size',3,'start_at',start_ts,'guest_name','Idem A','guest_email','idem@example.invalid',
      'fingerprint','fp-idem','idempotency_key','idem-key'));
  exception when others then conflicted := true;
  end;
  if not conflicted then
    raise exception 's109: a conflicting idempotency reuse must be refused, never return the stored token';
  end if;
end $idem$;

do $$ begin raise notice 'S109 booking notifications inbox: all checks passed'; end $$;
rollback;
