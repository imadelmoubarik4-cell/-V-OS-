-- S108 — Booking notifications, email outbox (prepared, not activated) and the
-- Phase 3 security hardening (KANEL × ALCEDO online bookings, Phase 5 + hardening).
--
-- Connects the booking lifecycle (new request, approval, rejection, change,
-- cancellation) to the Alcedo staff notification workflow and to a transactional
-- email OUTBOX that is prepared but never delivers (no provider configured; the
-- proposed sender is kanel@kanel.is). All sealed in atlas_private; no production
-- apply, and the public path stays behind its two off-by-default flags.
--
-- Also lands the previously identified public-API hardening that lives in the
-- database: KANEL-specific booking references and idempotency-key isolation (a
-- guest's idempotency key is namespaced to the public channel + their fingerprint,
-- so it can never collide with a staff booking or replay another guest's).

-- 1. Staff notification workflow: allow booking events + the bookings route ----
alter table atlas_private.push_notification_queue drop constraint if exists push_notification_queue_event_type_check;
alter table atlas_private.push_notification_queue add constraint push_notification_queue_event_type_check
  check (event_type in ('team_message','shift_update','marketing_attention','booking_request'));
alter table atlas_private.push_notification_queue drop constraint if exists push_notification_queue_route_check;
alter table atlas_private.push_notification_queue add constraint push_notification_queue_route_check
  check (route in ('team','shifts','marketing','bookings'));

-- 2. Email outbox — prepared, never delivered by this code --------------------
alter table atlas_private.booking_settings
  add column if not exists booking_email_from text not null default 'kanel@kanel.is';

create table if not exists atlas_private.booking_email_outbox (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid references atlas_private.reservations(id) on delete set null,
  kind text not null check (kind in ('request_received','confirmed','declined','changed','cancelled')),
  to_email text not null,
  from_email text not null,
  subject text not null,
  body text not null,
  -- queued until a future, owner-approved provider sends it. Nothing in this
  -- migration or the app moves a row out of 'queued'.
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','suppressed')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error text
);
alter table atlas_private.booking_email_outbox enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='atlas_private'
      and tablename='booking_email_outbox' and policyname='service role manages booking email') then
    create policy "service role manages booking email" on atlas_private.booking_email_outbox
      for all to service_role using (true) with check (true);
  end if;
end $$;
revoke all on atlas_private.booking_email_outbox from public, anon, authenticated;
grant all on atlas_private.booking_email_outbox to service_role;
create index if not exists booking_email_outbox_pending_idx
  on atlas_private.booking_email_outbox (status, created_at) where status = 'queued';

-- 3. KANEL booking reference ('KA-' prefix) -----------------------------------
create or replace function atlas_private.booking_public_reference()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- no ambiguous 0/O/1/I
  candidate text;
  i integer;
  tries integer := 0;
begin
  loop
    candidate := 'KA-';
    for i in 1..6 loop
      candidate := candidate || pg_catalog.substr(alphabet, 1 + pg_catalog.floor(pg_catalog.random() * pg_catalog.length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from atlas_private.reservations r where r.booking_reference = candidate);
    tries := tries + 1;
    if tries > 40 then
      raise exception 'Could not allocate a booking reference.' using errcode = 'P0001', hint = 'atlas:unavailable';
    end if;
  end loop;
  return candidate;
end
$function$;
revoke all on function atlas_private.booking_public_reference() from public, anon, authenticated;

-- 4. Lifecycle notifier: one trigger covers every channel + both actors -------
-- Fires for PUBLIC (source='web') bookings only. On a new request it alerts the
-- managers (in-app notification workflow) and queues the guest's "received" email;
-- on a status change it queues the matching guest email (confirmed / declined /
-- cancelled); on a time or party change it queues a "changed" email. Emails are
-- only QUEUED — never sent here. A missing guest email simply skips the email.
create or replace function atlas_private.booking_lifecycle_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  s atlas_private.booking_settings;
  from_email text;
  g text;
  m record;
  kind text;
  subject text;
  body text;
begin
  if coalesce(new.source,'') <> 'web' then return new; end if;
  select * into s from atlas_private.booking_settings where id = true;
  from_email := coalesce(s.booking_email_from, 'kanel@kanel.is');
  g := nullif(new.guest_email, '');

  if tg_op = 'INSERT' and new.status = 'requested' then
    -- Alert active managers/admins through the notification workflow.
    for m in select id from public.profiles where active and role in ('admin','manager') loop
      insert into atlas_private.push_notification_queue (audience_user_id, event_type, title, body, route, object_id)
      values (m.id, 'booking_request', 'New booking request',
        pg_catalog.left(coalesce(new.guest_name,'A guest') || ' · party of ' || new.party_size, 480),
        'bookings', new.id);
    end loop;
    kind := 'request_received';
    subject := 'We’ve received your booking request';
    body := 'Thank you. Your request (' || new.booking_reference || ') is awaiting confirmation by our team.';
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'confirmed' then
      kind := 'confirmed'; subject := 'Your booking is confirmed';
      body := 'Your booking ' || new.booking_reference || ' is confirmed. We look forward to welcoming you.';
    elsif new.status in ('cancelled','no_show') then
      kind := 'cancelled'; subject := 'Your booking has been cancelled';
      body := 'Your booking ' || new.booking_reference || ' has been cancelled. Please contact us to rebook.';
    else
      return new;  -- intermediate staff statuses (arrived/seated) are not emailed
    end if;
  elsif tg_op = 'UPDATE' and (new.start_at is distinct from old.start_at or new.party_size is distinct from old.party_size) then
    kind := 'changed'; subject := 'Your booking has been updated';
    body := 'Your booking ' || new.booking_reference || ' has been updated. See the latest details with your reference.';
  else
    return new;
  end if;

  if g is not null then
    insert into atlas_private.booking_email_outbox (reservation_id, kind, to_email, from_email, subject, body)
    values (new.id, kind, g, from_email, subject, body);
  end if;
  return new;
end
$function$;
revoke all on function atlas_private.booking_lifecycle_notify() from public, anon, authenticated;

drop trigger if exists booking_lifecycle_notify_trg on atlas_private.reservations;
create trigger booking_lifecycle_notify_trg
  after insert or update on atlas_private.reservations
  for each row execute function atlas_private.booking_lifecycle_notify();

-- 5. Harden the public request: KANEL reference + idempotency isolation --------
-- Re-creates atlas_public_booking_request (s107) with two changes: the KANEL
-- reference generator, and the idempotency key namespaced to the public channel +
-- the caller's fingerprint ('web:<fp>:<key>') so it can never collide with a staff
-- booking or let one guest replay another guest's key. Everything else is identical
-- to s107 (the lifecycle trigger now sends the staff alert + guest email).
create or replace function public.atlas_public_booking_request(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
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
  v_area uuid;
  run uuid[];
  tid uuid;
  v_ref text;
  v_token text;
  v_id uuid := gen_random_uuid();
  existing atlas_private.reservations;
begin
  select * into s from atlas_private.booking_settings where id = true;
  if not s.public_online_enabled then
    raise exception 'Online booking is not available right now.' using errcode = '22023', hint = 'atlas:disabled';
  end if;
  if not atlas_private.booking_public_rate_ok(v_fingerprint, 8, 600) then
    raise exception 'Too many requests. Please try again shortly.' using errcode = '53400', hint = 'atlas:rate_limited';
  end if;

  if v_party is null or v_start is null or v_name is null then
    raise exception 'A name, party size and time are required.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_party < 1 or v_party > coalesce(s.max_party_online, 4) then
    raise exception 'Online booking is for parties of 1 to %.', coalesce(s.max_party_online, 4) using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  -- Idempotency isolation: a public key is scoped to the web channel and the
  -- caller's fingerprint, so it is unique to this guest and never matches a staff
  -- booking. A blank fingerprint still isolates to the channel.
  if v_raw_idem is not null then
    v_idem := 'web:' || coalesce(v_fingerprint, 'anon') || ':' || v_raw_idem;
    select * into existing from atlas_private.reservations where idempotency_key = v_idem;
    if existing.id is not null then
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

  insert into atlas_private.reservations
    (id, source, status, start_at, end_at, party_size, guest_name, guest_phone, guest_email,
     guest_requests, booking_reference, idempotency_key, public_token, area_id)
  values (v_id, 'web', 'requested', v_start, v_end, v_party, v_name, v_phone, v_email,
     v_requests, v_ref, v_idem, v_token, v_area);

  foreach tid in array run loop
    insert into atlas_private.booking_holds (table_id, reservation_id, start_at, end_at, reason, expires_at)
    values (tid, v_id, v_start, v_end, 'web_pending',
            pg_catalog.now() + pg_catalog.make_interval(mins => coalesce(s.public_hold_minutes, 15)));
  end loop;

  insert into atlas_private.reservation_status_history (reservation_id, from_status, to_status, note)
  values (v_id, null, 'requested', 'public online request');
  insert into atlas_private.booking_events (event_type, reservation_id, payload)
  values ('reservation_created', v_id, pg_catalog.jsonb_build_object('party_size', v_party, 'source', 'web', 'channel', 'public'));

  return pg_catalog.jsonb_build_object('reference', v_ref, 'public_token', v_token, 'status', 'requested');
end
$function$;
revoke all on function public.atlas_public_booking_request(jsonb) from public, anon, authenticated;
grant execute on function public.atlas_public_booking_request(jsonb) to service_role;
