-- S94 Marketing publisher: scheduler kill switch (OWNER-RUN).
--
-- Removes the 'atlas-marketing-publisher-tick' cron job. Nothing else changes:
-- the extensions, Vault secrets, deliveries and the Automatic publishing
-- setting stay as they are. Safe to run when the job does not exist.
-- Equivalent one-liner:  select cron.unschedule('atlas-marketing-publisher-tick');

begin;

select pg_advisory_xact_lock(hashtext('atlas-marketing-publisher-tick'));

do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 's94 scheduler: pg_cron is not installed; nothing to remove';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'atlas-marketing-publisher-tick') then
    perform cron.unschedule('atlas-marketing-publisher-tick');
  end if;
  if exists (select 1 from cron.job where command ilike '%marketing_publisher_tick%') then
    raise exception 's94 scheduler: another cron job still calls marketing_publisher_tick (select jobid, jobname from cron.job)';
  end if;
end;
$$;

commit;

select count(*) as remaining_tick_jobs
from cron.job
where command ilike '%marketing_publisher_tick%';
