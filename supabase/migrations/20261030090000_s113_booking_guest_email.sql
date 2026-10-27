-- S113 — Guest booking emails from kanel@kanel.is (KANEL × ALCEDO online bookings).
--
-- Owner decisions, 26 Oct 2026:
--   * guest emails are sent through KANEL's own Google Workspace mailbox
--     (kanel@kanel.is over SMTP; the app password lives only in the Edge Function
--     secret BOOKING_EMAIL_SMTP_PASSWORD, never in the database or the repo);
--   * the emails queued before sending was switched on are discarded, never sent;
--   * each email is written in the language of the site the guest booked on.
--
-- What this migration does:
--   1. reservations.guest_language ('en' | 'is'), stored by the public request RPC.
--   2. booking_settings.guest_email_enabled — the owner switch, OFF by default.
--      While it is off the worker sends no guest email (a test email to the sender
--      address still goes, so delivery can be proven first) and the website does not
--      promise one. guest_email_since records when it was last switched on; emails
--      queued before that moment are discarded, never sent late.
--   3. Outbox: kind 'test', attempts / next_attempt_at (retry with back-off) and
--      claimed_at. Every row still 'queued' now is suppressed (owner decision).
--   4. booking_email_render: the plain-text email in the guest's language, rendered
--      when a row is claimed (stools are allocated after the lifecycle trigger fires).
--   5. Service-role RPCs for the atlas-booking-email-worker Edge Function: claim,
--      complete and the Vault-held worker secret. Each email is sent at most once:
--      a send interrupted mid-way is marked failed, never repeated.
--   6. booking_email_tick: pg_cron -> pg_net wake-up of the worker. Skips quietly
--      without pg_net or Vault, and when nothing is due. The schedule and the Vault
--      secrets are installed by scripts/kanel_booking_email_schedule_install.sql
--      (owner-run), not by this migration.
--   7. atlas_public_booking_request stores guest_language and answers
--      confirmation_email = true only while the switch is on and the guest gave a
--      deliverable address.
--
-- Production: apply with docs/release/sql/KANEL_apply_9_s113_booking_guest_email.sql
-- after KANEL_S113_preflight_readonly.sql; roll back with KANEL_S113_rollback.sql.

-- 1. Guest language ------------------------------------------------------------------
alter table atlas_private.reservations add column if not exists guest_language text;
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
      where conname = 'reservations_guest_language_check'
        and conrelid = 'atlas_private.reservations'::regclass) then
    alter table atlas_private.reservations add constraint reservations_guest_language_check
      check (guest_language is null or guest_language in ('en','is'));
  end if;
end $$;
comment on column atlas_private.reservations.guest_language is
  'Language of the website page the guest booked on (en | is). Guest emails use it; NULL = English.';

-- 2. Owner switch ----------------------------------------------------------------------
alter table atlas_private.booking_settings
  add column if not exists guest_email_enabled boolean not null default false;
alter table atlas_private.booking_settings
  add column if not exists guest_email_since timestamptz;
comment on column atlas_private.booking_settings.guest_email_enabled is
  'Owner switch: guest booking emails are sent from booking_email_from. OFF by default.';
comment on column atlas_private.booking_settings.guest_email_since is
  'When guest emails were last switched on. Emails queued before this are never sent.';

create or replace function atlas_private.booking_settings_guest_email_since()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.guest_email_enabled and not coalesce(old.guest_email_enabled, false) then
    new.guest_email_since := pg_catalog.now();
  end if;
  return new;
end
$function$;
revoke all on function atlas_private.booking_settings_guest_email_since() from public, anon, authenticated;
drop trigger if exists booking_settings_guest_email_since on atlas_private.booking_settings;
create trigger booking_settings_guest_email_since
  before update of guest_email_enabled on atlas_private.booking_settings
  for each row execute function atlas_private.booking_settings_guest_email_since();

-- 3. Outbox: test kind, retries, claim time; discard the backlog -----------------------
alter table atlas_private.booking_email_outbox drop constraint if exists booking_email_outbox_kind_check;
alter table atlas_private.booking_email_outbox add constraint booking_email_outbox_kind_check
  check (kind in ('request_received','confirmed','declined','changed','cancelled','test'));
alter table atlas_private.booking_email_outbox add column if not exists attempts integer not null default 0;
alter table atlas_private.booking_email_outbox add column if not exists next_attempt_at timestamptz not null default pg_catalog.now();
alter table atlas_private.booking_email_outbox add column if not exists claimed_at timestamptz;

update atlas_private.booking_email_outbox
set status = 'suppressed',
    error = 'Queued before guest emails were switched on; discarded (owner decision, 26 Oct 2026).'
where status = 'queued';

-- A deliverable address: one @, a dotted domain, no spaces, angle brackets or line breaks.
create or replace function atlas_private.booking_email_address_ok(p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select p_email is not null and pg_catalog.length(p_email) <= 254
    and p_email ~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$';
$function$;
revoke all on function atlas_private.booking_email_address_ok(text) from public, anon, authenticated;

-- 4. The email text ----------------------------------------------------------------------
-- Plain text, in the guest's language. Icelandic wording needs a native proofread.
create or replace function atlas_private.booking_email_render(p_outbox_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  o atlas_private.booking_email_outbox;
  r atlas_private.reservations;
  nl constant text := pg_catalog.chr(10);
  ice boolean;
  local_ts timestamp;
  seats integer[];
  day_text text;
  greeting text;
  intro text;
  outro text;
  details text;
  subject text;
  footer text;
begin
  select * into o from atlas_private.booking_email_outbox where id = p_outbox_id;
  if o.id is null then return null; end if;
  footer := 'KANEL' || nl || 'Hafnartorg Gallery, Geirsgata 17, 101 Reykjavík' || nl
    || o.from_email || ' · +354 692 0528';

  if o.kind = 'test' then
    return pg_catalog.jsonb_build_object('subject', 'KANEL booking email test',
      'body', 'This is a test email from Alcedo.' || nl
        || 'Guest booking emails from ' || o.from_email || ' are working.' || nl || nl || footer);
  end if;

  select * into r from atlas_private.reservations where id = o.reservation_id;
  if r.id is null or r.booking_reference is null or r.start_at is null then return null; end if;
  ice := r.guest_language = 'is';
  local_ts := r.start_at at time zone 'Atlantic/Reykjavik';
  seats := atlas_private.booking_public_reservation_seats(r.id);

  if ice then
    day_text := (array['sunnudagur','mánudagur','þriðjudagur','miðvikudagur','fimmtudagur','föstudagur','laugardagur'])[extract(dow from local_ts)::int + 1]
      || ' ' || extract(day from local_ts)::int || '. '
      || (array['janúar','febrúar','mars','apríl','maí','júní','júlí','ágúst','september','október','nóvember','desember'])[extract(month from local_ts)::int]
      || ' ' || extract(year from local_ts)::int;
  else
    day_text := pg_catalog.to_char(local_ts, 'FMDay FMDD FMMonth YYYY');
  end if;

  details := case when ice then 'Tilvísun: ' else 'Reference: ' end || r.booking_reference || nl
    || case when ice then 'Dagsetning: ' else 'Date: ' end || day_text || nl
    || case when ice then 'Tími: ' else 'Time: ' end || pg_catalog.to_char(local_ts, 'HH24:MI') || nl
    || case when ice then 'Gestir: ' else 'Guests: ' end || r.party_size
    || case when pg_catalog.cardinality(seats) = 1 then nl || case when ice then 'Sæti: ' else 'Stool: ' end || seats[1]
            when pg_catalog.cardinality(seats) > 1 then nl || case when ice then 'Sæti: ' else 'Stools: ' end
              || seats[1] || '–' || seats[pg_catalog.cardinality(seats)]
            else '' end;

  greeting := case when ice then 'Halló' else 'Hello' end
    || coalesce(' ' || nullif(pg_catalog.btrim(pg_catalog.left(r.guest_name, 80)), ''), '') || ',';
  outro := case when ice then 'Til að breyta eða afbóka skaltu svara þessum pósti eða hringja í +354 692 0528.'
                else 'To change or cancel, reply to this email or call +354 692 0528.' end;

  if o.kind = 'request_received' then
    subject := case when ice then 'Bókunarbeiðni móttekin' else 'Booking request received' end;
    intro := case when ice then 'Takk fyrir. Við höfum móttekið bókunarbeiðnina þína. Hún er ekki staðfest enn: starfsfólkið okkar fer yfir hana og svarar þér í tölvupósti.'
                  else 'Thank you. We’ve received your booking request. It is not confirmed yet: our team will review it and reply by email.' end;
  elsif o.kind = 'confirmed' then
    subject := case when ice then 'Bókunin þín er staðfest' else 'Your booking is confirmed' end;
    intro := case when ice then 'Bókunin þín á KANEL er staðfest. Við hlökkum til að taka á móti þér.'
                  else 'Your booking at KANEL is confirmed. We look forward to welcoming you.' end;
  elsif o.kind = 'changed' then
    subject := case when ice then 'Bókuninni þinni hefur verið breytt' else 'Your booking has been updated' end;
    intro := case when ice then 'Bókuninni þinni á KANEL hefur verið breytt. Hér eru nýju upplýsingarnar:'
                  else 'Your booking at KANEL has been updated. These are the new details:' end;
  elsif o.kind = 'declined' then
    subject := case when ice then 'Varðandi bókunarbeiðnina þína' else 'About your booking request' end;
    intro := case when ice then 'Því miður getum við ekki boðið þér sæti fyrir þessa beiðni. Þú getur valið annan tíma á kanel.is/is/bokanir eða svarað þessum pósti.'
                  else 'We’re sorry, we can’t offer you seats for this request. You’re welcome to choose another time at kanel.is/bookings or reply to this email.' end;
    outro := null;
  elsif o.kind = 'cancelled' then
    subject := case when ice then 'Bókuninni þinni hefur verið aflýst' else 'Your booking has been cancelled' end;
    intro := case when ice then 'Bókuninni þinni á KANEL hefur verið aflýst. Til að bóka aftur skaltu fara á kanel.is/is/bokanir eða svara þessum pósti.'
                  else 'Your booking at KANEL has been cancelled. To book again, visit kanel.is/bookings or reply to this email.' end;
    outro := null;
  else
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'subject', subject || ' · ' || r.booking_reference,
    'body', greeting || nl || nl || intro || nl || nl || details
      || coalesce(nl || nl || outro, '') || nl || nl || footer);
end
$function$;
revoke all on function atlas_private.booking_email_render(uuid) from public, anon, authenticated;

-- 5. Worker RPCs ------------------------------------------------------------------------
-- Claims up to p_limit due emails (status queued -> sending) and returns them rendered.
-- Guest emails only while the owner switch is on; test emails always.
create or replace function public.atlas_booking_email_claim(p_limit integer default 10)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  s atlas_private.booking_settings;
  on_ boolean;
  lim integer := least(greatest(coalesce(p_limit, 10), 1), 25);
  rec record;
  rendered jsonb;
  emails jsonb := '[]'::jsonb;
begin
  select * into s from atlas_private.booking_settings where id = true;
  on_ := coalesce(s.guest_email_enabled, false);

  -- At most once: a send that never reported back may already have been delivered.
  update atlas_private.booking_email_outbox
  set status = 'failed', error = 'Interrupted while sending; not repeated.', claimed_at = null
  where status = 'sending' and claimed_at < pg_catalog.now() - interval '10 minutes';

  -- Never send late, orphaned or undeliverable emails.
  update atlas_private.booking_email_outbox o
  set status = 'suppressed',
      error = case
        when not atlas_private.booking_email_address_ok(o.to_email) then 'Not a deliverable address.'
        when o.created_at < pg_catalog.now() - interval '24 hours' then 'Older than 24 hours; not sent.'
        when o.kind <> 'test' and s.guest_email_since is not null and o.created_at < s.guest_email_since
          then 'Queued before guest emails were switched on; not sent.'
        else 'The booking has passed or no longer exists; not sent.' end
  where o.status = 'queued'
    and (not atlas_private.booking_email_address_ok(o.to_email)
      or o.created_at < pg_catalog.now() - interval '24 hours'
      or (on_ and o.kind <> 'test' and s.guest_email_since is not null and o.created_at < s.guest_email_since)
      or (o.kind <> 'test' and not exists (select 1 from atlas_private.reservations r where r.id = o.reservation_id))
      or (o.kind in ('request_received','confirmed','changed') and exists (
            select 1 from atlas_private.reservations r where r.id = o.reservation_id and r.start_at < pg_catalog.now())));

  for rec in
    select o.id from atlas_private.booking_email_outbox o
    where o.status = 'queued' and o.next_attempt_at <= pg_catalog.now() and (on_ or o.kind = 'test')
    order by o.created_at
    limit lim
    for update skip locked
  loop
    rendered := atlas_private.booking_email_render(rec.id);
    if rendered is null then
      update atlas_private.booking_email_outbox set status = 'suppressed', error = 'Nothing to send.' where id = rec.id;
      continue;
    end if;
    update atlas_private.booking_email_outbox
    set status = 'sending', claimed_at = pg_catalog.now(), attempts = attempts + 1,
        subject = rendered->>'subject', body = rendered->>'body'
    where id = rec.id;
    emails := emails || (select pg_catalog.jsonb_build_object('id', o.id, 'to', o.to_email, 'from', o.from_email,
        'subject', o.subject, 'body', o.body)
      from atlas_private.booking_email_outbox o where o.id = rec.id);
  end loop;
  return pg_catalog.jsonb_build_object('enabled', on_, 'emails', emails);
end
$function$;
revoke all on function public.atlas_booking_email_claim(integer) from public, anon, authenticated;
grant execute on function public.atlas_booking_email_claim(integer) to service_role;

-- Records the result of one send: 'sent', 'retry' (temporary: back off 5, 10, 15, 20
-- minutes, then failed) or 'failed' (permanent). Only a row in 'sending' changes.
create or replace function public.atlas_booking_email_complete(p_id uuid, p_outcome text, p_error text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_status text;
begin
  if p_outcome not in ('sent','retry','failed') then
    raise exception 'Invalid outcome.' using errcode = '22023';
  end if;
  update atlas_private.booking_email_outbox
  set status = case when p_outcome = 'sent' then 'sent'
                    when p_outcome = 'retry' and attempts < 5 then 'queued'
                    else 'failed' end,
      sent_at = case when p_outcome = 'sent' then pg_catalog.now() end,
      next_attempt_at = case when p_outcome = 'retry'
                             then pg_catalog.now() + pg_catalog.make_interval(mins => 5 * attempts)
                             else next_attempt_at end,
      error = case when p_outcome = 'sent' then null
                   else pg_catalog.left(coalesce(nullif(p_error, ''), 'unknown'), 300) end,
      claimed_at = null
  where id = p_id and status = 'sending'
  returning status into v_status;
  return pg_catalog.jsonb_build_object('ok', v_status is not null, 'status', v_status);
end
$function$;
revoke all on function public.atlas_booking_email_complete(uuid, text, text) from public, anon, authenticated;
grant execute on function public.atlas_booking_email_complete(uuid, text, text) to service_role;

-- The worker secret lives only in Vault (created by the owner-run schedule install);
-- the worker reads it here with the service role and compares the caller's header.
create or replace function public.atlas_booking_email_worker_secret()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v text;
begin
  if to_regclass('vault.decrypted_secrets') is null then return null; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
    into v using 'kanel_booking_email_worker_secret';
  return v;
exception when others then
  return null;
end
$function$;
revoke all on function public.atlas_booking_email_worker_secret() from public, anon, authenticated;
grant execute on function public.atlas_booking_email_worker_secret() to service_role;

-- A test email to the sender address itself (no guest is ever emailed by it).
create or replace function atlas_private.booking_email_queue_test()
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_from text;
  v_id uuid;
begin
  select coalesce(booking_email_from, 'kanel@kanel.is') into v_from from atlas_private.booking_settings where id = true;
  insert into atlas_private.booking_email_outbox (reservation_id, kind, to_email, from_email, subject, body)
  values (null, 'test', v_from, v_from, 'KANEL booking email test', 'Rendered when sent.')
  returning id into v_id;
  return v_id;
end
$function$;
revoke all on function atlas_private.booking_email_queue_test() from public, anon, authenticated;

-- 6. Scheduler tick (pg_cron -> pg_net -> worker). Skips quietly without the extensions.
create or replace function atlas_private.booking_email_tick()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_on boolean;
  v_url text;
  v_secret text;
  v_request bigint;
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
     or to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;
  select coalesce(guest_email_enabled, false) into v_on from atlas_private.booking_settings where id = true;
  if not exists (
    select 1 from atlas_private.booking_email_outbox o
    where (o.status = 'queued' and o.next_attempt_at <= pg_catalog.now() and (coalesce(v_on, false) or o.kind = 'test'))
       or (o.status = 'sending' and o.claimed_at < pg_catalog.now() - interval '10 minutes')
  ) then
    return null;
  end if;
  begin
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_url using 'atlas_project_url';
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_secret using 'kanel_booking_email_worker_secret';
  exception when others then
    return null;
  end;
  if v_url is null or v_secret is null or v_url !~ '^https://' then
    raise warning 'booking email tick is not configured';
    return null;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)'
    into v_request
    using v_url || '/functions/v1/atlas-booking-email-worker',
          pg_catalog.jsonb_build_object('reason', 'cron'),
          pg_catalog.jsonb_build_object('content-type', 'application/json', 'x-atlas-worker-secret', v_secret);
  return v_request;
end
$function$;
revoke all on function atlas_private.booking_email_tick() from public, anon, authenticated;

-- 7. Public request: + guest_language, honest confirmation_email -----------------------
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
  v_lang text := case when p->>'language' in ('en','is') then p->>'language' end;
  v_idem text;
  v_mode text := coalesce(nullif(p->>'booking_mode',''), 'request');
  v_direct boolean;
  v_seats integer[];
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
  -- Direct confirmation only while the owner switch is on; otherwise a request.
  v_direct := v_mode = 'direct' and coalesce(s.public_instant_confirm, false);

  if v_party is null or v_start is null or v_name is null then
    raise exception 'A name, party size and time are required.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_party < 1 or v_party > coalesce(s.max_party_online, 4) then
    raise exception 'Online booking is for parties of 1 to %.', coalesce(s.max_party_online, 4) using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if p ? 'seats' and p->'seats' <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p->'seats') <> 'array' then
      raise exception 'Invalid stool selection.' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    select pg_catalog.array_agg((value #>> '{}')::int order by ordinality) into v_seats
    from pg_catalog.jsonb_array_elements(p->'seats') with ordinality;
    if coalesce(pg_catalog.cardinality(v_seats), 0) <> v_party then
      raise exception 'Choose one stool per guest.' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
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
        'public_token', existing.public_token, 'status', existing.status,
        'seats', pg_catalog.to_jsonb(atlas_private.booking_public_reservation_seats(existing.id)),
        'confirmation_email', coalesce(s.guest_email_enabled, false)
          and atlas_private.booking_email_address_ok(existing.guest_email));
    end if;
  end if;

  if v_start < pg_catalog.now()
     or v_start > pg_catalog.now() + pg_catalog.make_interval(days => coalesce(s.advance_days, 90)) then
    raise exception 'That date is outside the booking window.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if not atlas_private.booking_within_hours(v_start, v_dur, tz) then
    raise exception 'That time is outside opening hours.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if pg_catalog.mod(atlas_private.booking_local_minutes(v_start, tz), coalesce(nullif(s.slot_interval_minutes,0),15)) <> 0 then
    raise exception 'Choose a valid booking interval.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  select id into v_area from atlas_private.booking_areas
   where online_bookable and is_active order by display_order limit 1;
  if v_area is null then
    raise exception 'Online booking is not available right now.' using errcode = '22023', hint = 'atlas:disabled';
  end if;

  v_end := v_start + pg_catalog.make_interval(mins => v_dur);

  perform 1 from atlas_private.booking_tables t where t.area_id = v_area order by t.id for update;
  if v_seats is not null then
    run := atlas_private.booking_public_seat_ids(v_area, v_seats);
    begin
      perform atlas_private.booking_check_seat_group(run, v_area, v_party, v_start, v_end, null);
    exception when unique_violation then
      raise exception 'A chosen stool was just booked.' using errcode = '23505', hint = 'atlas:seat_taken';
    end;
  else
    run := atlas_private.booking_find_contiguous_tables(v_area, v_party, v_start, v_end, null);
    if run is null then
      raise exception 'That time is no longer available.' using errcode = '23505', hint = 'atlas:conflict';
    end if;
  end if;

  v_ref := atlas_private.booking_public_reference();
  v_token := atlas_private.booking_public_token();
  v_status := case when v_direct then 'confirmed' else 'requested' end;

  insert into atlas_private.reservations
    (id, source, status, start_at, end_at, party_size, guest_name, guest_phone, guest_email,
     guest_requests, booking_reference, idempotency_key, public_token, area_id, guest_language)
  values (v_id, 'web', v_status, v_start, v_end, v_party, v_name, v_phone, v_email,
     v_requests, v_ref, v_idem, v_token, v_area, v_lang);

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
  values ('reservation_created', v_id, pg_catalog.jsonb_build_object('party_size', v_party, 'source', 'web',
    'channel', 'public', 'status', v_status, 'guest_chose_seats', v_seats is not null));

  -- The lifecycle trigger queued the guest email; it is sent only while the owner
  -- switch is on, so the website promises an email only then.
  return pg_catalog.jsonb_build_object('reference', v_ref, 'public_token', v_token, 'status', v_status,
    'seats', pg_catalog.to_jsonb(atlas_private.booking_public_reservation_seats(v_id)),
    'confirmation_email', coalesce(s.guest_email_enabled, false) and atlas_private.booking_email_address_ok(v_email));
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid booking.' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;
revoke all on function public.atlas_public_booking_request(jsonb) from public, anon, authenticated;
grant execute on function public.atlas_public_booking_request(jsonb) to service_role;
