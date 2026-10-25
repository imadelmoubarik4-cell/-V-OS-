-- KANEL × ALCEDO bookings — ROLLBACK of S111 (booking personal-data retention).
-- OWNER-APPROVED USE ONLY. One transaction, idempotent.
--
-- Stops the nightly clean-up: unschedules the pg_cron job, drops the purge function
-- and its run log, and clears the S111 ledger row (the reviewed bundle can re-apply it).
--
-- IMPORTANT: this does NOT restore personal data the clean-up already removed —
-- anonymised guest details are gone by design. Restore from a backup only if that
-- is ever required. pg_cron itself is left installed (other jobs may use it).

begin;

do $cron$
declare scheduled boolean;
begin
  -- Nested + dynamic so this also runs where pg_cron (and the cron schema) is absent.
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    execute 'select exists (select 1 from cron.job where jobname = $1)' into scheduled using 'kanel-booking-retention';
    if scheduled then
      execute 'select cron.unschedule($1)' using 'kanel-booking-retention';
    end if;
  end if;
end
$cron$;

drop function if exists atlas_private.booking_purge_personal_data(integer, boolean);
drop table if exists atlas_private.booking_retention_runs;

delete from supabase_migrations.schema_migrations where version = '20261028090000';

commit;
