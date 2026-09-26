-- S94 Marketing publisher: scheduler installation (OWNER-RUN, optional stage).
--
-- NOT a migration and NOT applied by any deploy. Run it by hand in the
-- Supabase SQL editor only after the owner approves the "Scheduler" rollout
-- stage (docs/marketing/S94_Rollout_Package.md, stage S). Runbook:
-- docs/marketing/S94_Scheduler_Runbook.md.
--
-- What it does, in one transaction:
--   1. Enables pg_net and pg_cron if missing, and verifies both.
--   2. Verifies the two Vault secrets exist and are well-formed (never prints them).
--   3. Refuses to continue if any other cron job already calls the tick.
--   4. Creates or updates exactly ONE job named 'atlas-marketing-publisher-tick'
--      running every minute: select atlas_private.marketing_publisher_tick('cron');
--   5. Verifies the job and reports whether anything could publish now.
--
-- Safe to re-run: cron.schedule() with an existing job name updates that job
-- in place (pg_cron >= 1.3), the script takes an advisory lock so two sessions
-- cannot interleave, and step 5 fails the transaction if more than one job
-- calls the tick. Re-running therefore never creates a duplicate job.
--
-- Kill switch (stops the scheduler immediately; nothing else changes):
--   select cron.unschedule('atlas-marketing-publisher-tick');
-- or run scripts/s94_publisher_schedule_uninstall.sql.
--
-- Installing the schedule does NOT turn on automatic publishing. While the
-- Marketing setting "Automatic publishing" is off, queued and retrying posts
-- are never due, so the tick never wakes the worker for them; it only wakes
-- the worker to re-check posts that were already sent (processing/verifying).

begin;

select pg_advisory_xact_lock(hashtext('atlas-marketing-publisher-tick'));

-- 1. Extensions -------------------------------------------------------------
create extension if not exists pg_net;
create extension if not exists pg_cron;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
     or to_regnamespace('net') is null then
    raise exception 's94 scheduler: pg_net is not available';
  end if;
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or to_regclass('cron.job') is null then
    raise exception 's94 scheduler: pg_cron is not available';
  end if;
  if to_regprocedure('atlas_private.marketing_publisher_tick(text)') is null then
    raise exception 's94 scheduler: the S94C migration is not applied (atlas_private.marketing_publisher_tick missing)';
  end if;
end;
$$;

-- 2. Vault secrets (values are checked, never returned) ---------------------
do $$
declare
  v_url text;
  v_secret text;
  v_url_count integer;
  v_secret_count integer;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 's94 scheduler: Supabase Vault is not available';
  end if;
  execute 'select count(*) from vault.decrypted_secrets where name = $1' into v_url_count using 'atlas_project_url';
  execute 'select count(*) from vault.decrypted_secrets where name = $1' into v_secret_count using 'atlas_marketing_publisher_secret';
  if v_url_count <> 1 then
    raise exception 's94 scheduler: expected exactly one Vault secret named atlas_project_url, found %', v_url_count;
  end if;
  if v_secret_count <> 1 then
    raise exception 's94 scheduler: expected exactly one Vault secret named atlas_marketing_publisher_secret, found %', v_secret_count;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'atlas_project_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_secret using 'atlas_marketing_publisher_secret';
  if v_url !~ '^https://[a-z0-9-]+\.supabase\.co$' then
    raise exception 's94 scheduler: atlas_project_url must be the project URL (https://<ref>.supabase.co, no path or trailing slash)';
  end if;
  if length(v_secret) < 32 then
    raise exception 's94 scheduler: atlas_marketing_publisher_secret must be at least 32 characters';
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
  where command ilike '%marketing_publisher_tick%'
    and coalesce(jobname, '') <> 'atlas-marketing-publisher-tick';
  if v_others > 0 then
    raise exception 's94 scheduler: % other cron job(s) already call marketing_publisher_tick; unschedule them first (select jobid, jobname, schedule from cron.job)', v_others;
  end if;
end;
$$;

-- 4. Exactly one schedule, every minute (insert or update by name) ----------
select cron.schedule(
  'atlas-marketing-publisher-tick',
  '* * * * *',
  $cmd$select atlas_private.marketing_publisher_tick('cron');$cmd$
);

-- 5. Verify -----------------------------------------------------------------
do $$
declare
  v_jobs integer;
  v_job record;
begin
  select count(*) into v_jobs from cron.job where command ilike '%marketing_publisher_tick%';
  if v_jobs <> 1 then
    raise exception 's94 scheduler: expected exactly one tick job, found %', v_jobs;
  end if;
  select * into v_job from cron.job where jobname = 'atlas-marketing-publisher-tick';
  if v_job.schedule <> '* * * * *'
     or v_job.command <> $cmd$select atlas_private.marketing_publisher_tick('cron');$cmd$
     or v_job.active is not true
     or v_job.database <> current_database() then
    raise exception 's94 scheduler: the tick job does not match the reviewed definition';
  end if;
end;
$$;

-- Report (no secrets): the job, and whether anything could be published now.
select
  j.jobid,
  j.jobname,
  j.schedule,
  j.command,
  j.active,
  atlas_private.marketing_automatic_publishing_enabled() as automatic_publishing_on,
  (select count(*) from atlas_private.marketing_deliveries d
    where d.status in ('queued', 'retrying') and d.claim_token is null
      and d.next_attempt_at <= pg_catalog.now()) as queued_posts_due,
  (select count(*) from atlas_private.marketing_deliveries d
    where d.next_attempt_at <= pg_catalog.now()
      and ((d.status in ('processing', 'verifying') and d.claim_token is null)
           or (d.status in ('queued', 'retrying') and d.claim_token is null
               and atlas_private.marketing_automatic_publishing_enabled())
           or (d.claim_token is not null and d.claimed_until < pg_catalog.now()))) as due_for_worker_now
from cron.job j
where j.jobname = 'atlas-marketing-publisher-tick';

commit;
