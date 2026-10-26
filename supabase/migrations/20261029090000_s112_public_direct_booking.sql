-- S112 KANEL: immediately confirm public bookings with atomic adjacent stool allocation.
-- The legacy ?action=request path remains Requested with a temporary hold.
-- Apply migration before deploying the ?action=book Edge route and Netlify website.
-- Guest emails remain queued only; no provider is activated.

CREATE OR REPLACE FUNCTION public.atlas_public_booking_request(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  s atlas_private.booking_settings;
  tz text := coalesce(nullif(p->>'tz',''), 'Atlantic/Reykjavik');
  v_party integer := (p->>'party_size')::int;
  v_start timestamptz := (p->>'start_at')::timestamptz;
  v_dur integer := 120;
  v_end timestamptz;
  v_name text := nullif(p->>'guest_name','');
  v_phone text := nullif(p->>'guest_phone','');
  v_email text := nullif(p->>'guest_email','');
  v_requests text := nullif(p->>'guest_requests','');
  v_fingerprint text := nullif(p->>'fingerprint','');
  v_raw_idem text := nullif(p->>'idempotency_key','');
  v_idem text;
  v_mode text := coalesce(nullif(p->>'booking_mode',''), 'request');
  v_direct boolean := v_mode = 'direct';
  v_status text;
  v_area uuid;
  run uuid[];
  tid uuid;
  v_ref text;
  v_token text;
  v_id uuid := gen_random_uuid();
  existing atlas_private.reservations;
begin
  if v_mode not in ('request','direct') then
    raise exception 'Invalid booking mode.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select * into s from atlas_private.booking_settings where id = true;
  if not s.public_online_enabled then
    raise exception 'Online booking is not available right now.' using errcode = '22023', hint = 'atlas:disabled';
  end if;

  if v_party is null or v_start is null or v_name is null then
    raise exception 'A name, party size and time are required.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_party < 1 or v_party > coalesce(s.max_party_online, 4) then
    raise exception 'Online booking is for parties of 1 to %.', coalesce(s.max_party_online, 4) using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  if v_raw_idem is not null then
    v_idem := 'web:' || coalesce(v_fingerprint, 'anon') || ':' || v_raw_idem;
    select * into existing from atlas_private.reservations where idempotency_key = v_idem;
    if existing.id is not null then
      -- A replay must match the original request; a conflicting reuse is refused
      -- and never discloses the stored booking's token.
      if existing.party_size <> v_party or existing.start_at <> v_start then
        raise exception 'That request conflicts with an earlier one.' using errcode = '22023', hint = 'atlas:invalid_request';
      end if;
      return pg_catalog.jsonb_build_object('reference', existing.booking_reference,
        'public_token', existing.public_token, 'status', existing.status);
    end if;
  end if;

  if v_start < pg_catalog.now()
     or v_start > pg_catalog.now() + pg_catalog.make_interval(days => coalesce(s.advance_days, 90)) then
    raise exception 'That date is outside the booking window.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if not atlas_private.booking_within_hours(v_start, v_dur, tz) then
    raise exception 'That time is outside opening hours.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  if v_direct and pg_catalog.mod(atlas_private.booking_local_minutes(v_start, tz), coalesce(nullif(s.slot_interval_minutes,0),15)) <> 0 then
    raise exception 'Choose a valid booking interval.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select id into v_area from atlas_private.booking_areas
   where online_bookable and is_active order by display_order limit 1;
  if v_area is null then
    raise exception 'Online booking is not available right now.' using errcode = '22023', hint = 'atlas:disabled';
  end if;

  v_end := v_start + pg_catalog.make_interval(mins => v_dur);

  perform 1 from atlas_private.booking_tables t where t.area_id = v_area order by t.id for update;
  run := atlas_private.booking_find_contiguous_tables(v_area, v_party, v_start, v_end, null);
  if run is null then
    raise exception 'That time is no longer available.' using errcode = '23505', hint = 'atlas:conflict';
  end if;

  v_ref := atlas_private.booking_public_reference();
  v_token := atlas_private.booking_public_token();
  v_status := case when v_direct then 'confirmed' else 'requested' end;

  insert into atlas_private.reservations
    (id, source, status, start_at, end_at, party_size, guest_name, guest_phone, guest_email,
     guest_requests, booking_reference, idempotency_key, public_token, area_id)
  values (v_id, 'web', v_status, v_start, v_end, v_party, v_name, v_phone, v_email,
     v_requests, v_ref, v_idem, v_token, v_area);

  foreach tid in array run loop
    if v_direct then
      insert into atlas_private.reservation_tables (reservation_id, table_id, start_at, end_at)
      values (v_id, tid, v_start, v_end);
    else
      insert into atlas_private.booking_holds (table_id, reservation_id, start_at, end_at, reason, expires_at)
      values (tid, v_id, v_start, v_end, 'web_pending',
              pg_catalog.now() + pg_catalog.make_interval(mins => coalesce(s.public_hold_minutes, 15)));
    end if;
  end loop;

  insert into atlas_private.reservation_status_history (reservation_id, from_status, to_status, note)
  values (v_id, null, v_status, case when v_direct then 'public online confirmed booking' else 'public online request' end);
  insert into atlas_private.booking_events (event_type, reservation_id, payload)
  values ('reservation_created', v_id, pg_catalog.jsonb_build_object('party_size', v_party, 'source', 'web', 'channel', 'public', 'status', v_status));

  return pg_catalog.jsonb_build_object('reference', v_ref, 'public_token', v_token, 'status', v_status);
end
$function$;
revoke all on function public.atlas_public_booking_request(jsonb) from public, anon, authenticated;
grant execute on function public.atlas_public_booking_request(jsonb) to service_role;

CREATE OR REPLACE FUNCTION atlas_private.booking_lifecycle_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s atlas_private.booking_settings;
  from_email text;
  g text;
  m record;
  inbox_kind text;
  inbox_title text;
  inbox_body text;
  email_kind text;
  subject text;
  body text;
  dkey text;
begin
  -- Origin marker: only reservations created by the KANEL public-booking system
  -- carry a public_token. Legacy VÁ Bar / Sinna rows never do.
  if new.public_token is null then return new; end if;
  select * into s from atlas_private.booking_settings where id = true;
  from_email := coalesce(s.booking_email_from, 'kanel@kanel.is');
  g := nullif(new.guest_email, '');

  if tg_op = 'INSERT' and new.status = 'requested' then
    inbox_kind := 'request'; inbox_title := 'New booking request';
    inbox_body := pg_catalog.left(coalesce(new.guest_name,'A guest') || ' · party of ' || new.party_size, 480);
    email_kind := 'request_received'; subject := 'We’ve received your booking request';
    body := 'Thank you. Your request (' || new.booking_reference || ') is awaiting confirmation by our team.';
  elsif tg_op = 'INSERT' and new.status = 'confirmed' then
    inbox_kind := 'approved'; inbox_title := 'New confirmed website booking';
    inbox_body := pg_catalog.left(coalesce(new.guest_name,'A guest') || ' · party of ' || new.party_size, 480);
    email_kind := 'confirmed'; subject := 'Your booking is confirmed';
    body := 'Your booking ' || new.booking_reference || ' is confirmed. We look forward to welcoming you.';
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'confirmed' then
      inbox_kind := 'approved'; inbox_title := 'Booking approved';
      inbox_body := coalesce(new.guest_name,'A guest') || ' · ' || new.booking_reference;
      email_kind := 'confirmed'; subject := 'Your booking is confirmed';
      body := 'Your booking ' || new.booking_reference || ' is confirmed. We look forward to welcoming you.';
    elsif new.status = 'cancelled' and old.status = 'requested' then
      -- A pending request that staff turned down is a rejection, not a cancellation.
      inbox_kind := 'declined'; inbox_title := 'Request declined';
      inbox_body := coalesce(new.guest_name,'A guest') || ' · ' || new.booking_reference;
      email_kind := 'declined'; subject := 'About your booking request';
      body := 'We’re sorry — we couldn’t accommodate request ' || new.booking_reference || '. Please contact us for other times.';
    elsif new.status = 'cancelled' then
      inbox_kind := 'cancelled'; inbox_title := 'Booking cancelled';
      inbox_body := coalesce(new.guest_name,'A guest') || ' · ' || new.booking_reference;
      email_kind := 'cancelled'; subject := 'Your booking has been cancelled';
      body := 'Your booking ' || new.booking_reference || ' has been cancelled. Please contact us to rebook.';
    elsif new.status = 'no_show' then
      -- Staff record only; the guest is NOT emailed and it is not a cancellation.
      inbox_kind := 'no_show'; inbox_title := 'Marked no-show';
      inbox_body := coalesce(new.guest_name,'A guest') || ' · ' || new.booking_reference;
      email_kind := null;
    else
      return new;  -- intermediate staff statuses (arrived/seated) are not notified
    end if;
  elsif tg_op = 'UPDATE' and (new.start_at is distinct from old.start_at or new.party_size is distinct from old.party_size) then
    inbox_kind := 'changed'; inbox_title := 'Booking updated';
    inbox_body := coalesce(new.guest_name,'A guest') || ' · ' || new.booking_reference;
    email_kind := 'changed'; subject := 'Your booking has been updated';
    body := 'Your booking ' || new.booking_reference || ' has been updated. See the latest details with your reference.';
  else
    return new;
  end if;

  -- In-app inbox for every event (works without push delivery), plus an optional
  -- phone push for the actionable NEW REQUEST only — routed to 'bookings' so the
  -- service worker opens the booking, not Messages. Both target active
  -- managers/admins only.
  for m in select id from public.profiles where active and role in ('admin','manager') loop
    insert into atlas_private.booking_notifications (audience_user_id, reservation_id, kind, title, body, route)
    values (m.id, new.id, inbox_kind, inbox_title, inbox_body, 'bookings');
    if tg_op = 'INSERT' and new.status in ('requested','confirmed') then
      insert into atlas_private.push_notification_queue (audience_user_id, event_type, title, body, route, object_id)
      values (m.id, 'booking_request', inbox_title, inbox_body, 'bookings', new.id);
    end if;
  end loop;

  -- Guest email (queued only). De-duplicated so a repeated identical event can
  -- never enqueue a second copy; a genuine new change (new time/party/status)
  -- gets a distinct key and so a distinct email.
  if email_kind is not null and g is not null then
    dkey := pg_catalog.md5(new.id::text || ':' || email_kind || ':' || new.status || ':'
      || coalesce(new.start_at::text,'') || ':' || coalesce(new.party_size::text,''));
    insert into atlas_private.booking_email_outbox (reservation_id, kind, to_email, from_email, subject, body, dedupe_key)
    values (new.id, email_kind, g, from_email, subject, body, dkey)
    on conflict (dedupe_key) do nothing;
  end if;
  return new;
end
$function$;
revoke all on function atlas_private.booking_lifecycle_notify() from public, anon, authenticated;
