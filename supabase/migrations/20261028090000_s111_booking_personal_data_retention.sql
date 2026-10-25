-- S111 — Booking personal-data retention (KANEL × ALCEDO online bookings).
--
-- Guests' personal details are kept for 90 days after their visit, then removed
-- automatically every night:
--   * reservations whose visit ended more than p_days ago are ANONYMISED — guest
--     name, phone, email, requests, staff notes and the private guest token /
--     idempotency key / provider reference are cleared. The row itself (date,
--     party size, status, area, seats, KA- reference) stays for business totals;
--     it no longer identifies anyone.
--   * messages that repeat those details are DELETED: the staff booking inbox
--     (booking_notifications), the guest email outbox (booking_email_outbox) and
--     booking web-push rows (push_notification_queue) — for purged reservations
--     and anything else older than the window.
--   * every run is recorded in atlas_private.booking_retention_runs (counts only).
-- The append-only status history and booking events hold no guest details (status
-- changes, party size, source, seat ids, staff labels) and are left untouched.
-- Anonymising never fires guest or staff notifications: the lifecycle trigger
-- acts only on a status change, and the cleared public_token ends it early anyway.
--
-- Scheduling: pg_cron, daily at 03:17 UTC, where the extension is available (it
-- is on Supabase). Databases without pg_cron (local / CI replays) get the function
-- only, with a NOTICE. Idempotent.

-- 1. Run log (sealed) ---------------------------------------------------------
create table if not exists atlas_private.booking_retention_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default pg_catalog.now(),
  retention_days integer not null,
  cutoff timestamptz not null,
  dry_run boolean not null,
  counts jsonb not null check (pg_catalog.jsonb_typeof(counts) = 'object')
);
alter table atlas_private.booking_retention_runs enable row level security;
revoke all on atlas_private.booking_retention_runs from public, anon, authenticated;
grant all on atlas_private.booking_retention_runs to service_role;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'atlas_private'
      and tablename = 'booking_retention_runs' and policyname = 'service role reads retention runs') then
    create policy "service role reads retention runs" on atlas_private.booking_retention_runs
      for all to service_role using (true) with check (true);
  end if;
end $$;

-- 2. The purge ----------------------------------------------------------------
create or replace function atlas_private.booking_purge_personal_data(
  p_days integer default 90, p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  cutoff timestamptz;
  targets uuid[];
  n_res integer := 0;
  n_inbox integer := 0;
  n_outbox integer := 0;
  n_push integer := 0;
  result jsonb;
begin
  -- Guard against an accidental short window wiping current bookings.
  if p_days is null or p_days < 30 then
    raise exception 'Retention must be at least 30 days.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  cutoff := pg_catalog.now() - pg_catalog.make_interval(days => p_days);

  select coalesce(pg_catalog.array_agg(r.id), '{}') into targets
  from atlas_private.reservations r
  where r.end_at < cutoff
    and (r.guest_name is not null or r.guest_phone is not null or r.guest_email is not null
         or r.guest_requests is not null or r.staff_notes is not null or r.public_token is not null
         or r.idempotency_key is not null or r.provider_ref is not null);
  n_res := pg_catalog.cardinality(targets);

  if p_dry_run then
    select pg_catalog.count(*) into n_inbox from atlas_private.booking_notifications n
      where n.reservation_id = any(targets) or n.created_at < cutoff;
    select pg_catalog.count(*) into n_outbox from atlas_private.booking_email_outbox o
      where o.reservation_id = any(targets) or o.created_at < cutoff;
    select pg_catalog.count(*) into n_push from atlas_private.push_notification_queue q
      where (q.event_type = 'booking_request' or q.route = 'bookings')
        and (q.object_id = any(targets) or q.created_at < cutoff);
  else
    delete from atlas_private.booking_notifications n
      where n.reservation_id = any(targets) or n.created_at < cutoff;
    get diagnostics n_inbox = row_count;
    delete from atlas_private.booking_email_outbox o
      where o.reservation_id = any(targets) or o.created_at < cutoff;
    get diagnostics n_outbox = row_count;
    delete from atlas_private.push_notification_queue q
      where (q.event_type = 'booking_request' or q.route = 'bookings')
        and (q.object_id = any(targets) or q.created_at < cutoff);
    get diagnostics n_push = row_count;
    update atlas_private.reservations
       set guest_name = null, guest_phone = null, guest_email = null, guest_requests = null,
           staff_notes = null, public_token = null, idempotency_key = null, provider_ref = null
     where id = any(targets);
  end if;

  result := pg_catalog.jsonb_build_object(
    'reservations_anonymised', n_res, 'inbox_deleted', n_inbox,
    'outbox_deleted', n_outbox, 'push_deleted', n_push);
  insert into atlas_private.booking_retention_runs (retention_days, cutoff, dry_run, counts)
  values (p_days, cutoff, coalesce(p_dry_run, false), result);
  return result || pg_catalog.jsonb_build_object('cutoff', cutoff, 'dry_run', coalesce(p_dry_run, false));
end
$function$;
revoke all on function atlas_private.booking_purge_personal_data(integer, boolean)
  from public, anon, authenticated;

-- 3. Nightly schedule (pg_cron where available) -------------------------------
do $cron$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron';  -- pg_cron installs into its fixed schema
    -- cron.schedule upserts by job name, so re-running keeps one job.
    perform cron.schedule('kanel-booking-retention', '17 3 * * *',
      'select atlas_private.booking_purge_personal_data(90, false)');
  else
    raise notice 'S111: pg_cron is not available here; booking_purge_personal_data is installed but not scheduled.';
  end if;
end
$cron$;
