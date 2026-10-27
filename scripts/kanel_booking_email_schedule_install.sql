-- S113 KANEL guest booking emails: scheduler installation (OWNER-RUN).
--
-- NOT a migration and NOT applied by any deploy. Run it in the Supabase SQL editor
-- only after the S113 apply bundle, with the owner's approval. Runbook:
-- docs/release/KANEL_S113_Guest_Email_Runbook.md.
--
-- What it does, in one transaction:
--   1. Enables pg_net and pg_cron if missing, and verifies both and S113.
--   2. Verifies the Vault secret atlas_project_url (https://<ref>.supabase.co) and
--      creates the worker secret kanel_booking_email_worker_secret if it is missing:
--      64 random hex characters generated inside the database. Nobody ever sees or
--      copies it: the tick reads it from Vault and the worker reads it through the
--      service-role RPC atlas_booking_email_worker_secret.
--   3. Refuses to continue if any other cron job already calls the tick.
--   4. Creates or updates exactly ONE job named 'kanel-booking-email' running every
--      minute: select atlas_private.booking_email_tick();
--   5. Verifies the job and reports (no secrets) whether guest emails are switched on.
--
-- Safe to re-run: cron.schedule() with an existing job name updates it in place, an
-- advisory lock keeps two sessions apart, an existing worker secret is kept.
--
-- Installing the schedule does NOT switch guest emails on. While
-- booking_settings.guest_email_enabled is off the tick wakes the worker only for a
-- test email (atlas_private.booking_email_queue_test()).
--
-- Kill switch (stops all sending at once; nothing else changes):
--   select cron.unschedule('kanel-booking-email');
-- or scripts/kanel_booking_email_schedule_uninstall.sql.

begin;

select pg_advisory_xact_lock(hashtext('kanel-booking-email'));

-- 1. Extensions -------------------------------------------------------------
create extension if not exists pg_net;
create extension if not exists pg_cron;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
     or to_regnamespace('net') is null then
    raise exception 's113 schedule: pg_net is not available';
  end if;
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or to_regclass('cron.job') is null then
    raise exception 's113 schedule: pg_cron is not available';
  end if;
  if to_regprocedure('atlas_private.booking_email_tick()') is null then
    raise exception 's113 schedule: the S113 migration is not applied (atlas_private.booking_email_tick missing)';
  end if;
end;
$$;

-- 2. Vault secrets (values are checked or generated, never returned) ---------
do $$
declare
  v_url text;
  v_count integer;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 's113 schedule: Supabase Vault is not available';
  end if;
  execute 'select count(*) from vault.decrypted_secrets where name = $1' into v_count using 'atlas_project_url';
  if v_count <> 1 then
    raise exception 's113 schedule: expected exactly one Vault secret named atlas_project_url, found % (create it first, see the runbook)', v_count;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'atlas_project_url';
  if v_url !~ '^https://[a-z0-9-]+\.supabase\.co$' then
    raise exception 's113 schedule: atlas_project_url must be the project URL (https://<ref>.supabase.co, no path or trailing slash)';
  end if;
  execute 'select count(*) from vault.decrypted_secrets where name = $1' into v_count using 'kanel_booking_email_worker_secret';
  if v_count = 0 then
    perform vault.create_secret(
      pg_catalog.replace(gen_random_uuid()::text, '-', '') || pg_catalog.replace(gen_random_uuid()::text, '-', ''),
      'kanel_booking_email_worker_secret',
      'KANEL guest booking emails (S113): pg_cron tick -> atlas-booking-email-worker');
  elsif v_count > 1 then
    raise exception 's113 schedule: more than one Vault secret named kanel_booking_email_worker_secret';
  end if;
end;
$$;

-- 3. No other job may call the tick ----------------------------------------
do $$
declare
  v_others integer;
begin
  select count(*) into v_others
  from cron.job
  where command ilike '%booking_email_tick%'
    and coalesce(jobname, '') <> 'kanel-booking-email';
  if v_others > 0 then
    raise exception 's113 schedule: % other cron job(s) already call booking_email_tick; unschedule them first', v_others;
  end if;
end;
$$;

-- 4. Exactly one schedule, every minute (insert or update by name) ----------
select cron.schedule(
  'kanel-booking-email',
  '* * * * *',
  $cmd$select atlas_private.booking_email_tick();$cmd$
);

-- 5. Verify -----------------------------------------------------------------
do $$
declare
  v_job record;
begin
  if (select count(*) from cron.job where command ilike '%booking_email_tick%') <> 1 then
    raise exception 's113 schedule: expected exactly one tick job';
  end if;
  select * into v_job from cron.job where jobname = 'kanel-booking-email';
  if v_job.schedule <> '* * * * *'
     or v_job.command <> $cmd$select atlas_private.booking_email_tick();$cmd$
     or v_job.active is not true
     or v_job.database <> current_database() then
    raise exception 's113 schedule: the tick job does not match the reviewed definition';
  end if;
end;
$$;

-- Report (no secrets).
select
  j.jobname,
  j.schedule,
  j.active,
  (select guest_email_enabled from atlas_private.booking_settings where id = true) as guest_emails_on,
  (select booking_email_from from atlas_private.booking_settings where id = true) as sender,
  (select count(*) from atlas_private.booking_email_outbox where status = 'queued') as queued_now
from cron.job j
where j.jobname = 'kanel-booking-email';

commit;
