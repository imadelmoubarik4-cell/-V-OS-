-- S113 KANEL guest booking emails: scheduler removal (OWNER-RUN kill switch).
-- Stops the every-minute wake-up at once. Queued emails stay queued (and are never
-- sent late: anything older than 24 hours is discarded when sending resumes). The
-- Vault secret, the switch and the Edge Function are left as they are.
select cron.unschedule(jobid)
from cron.job
where jobname = 'kanel-booking-email';

select count(*) as remaining_email_jobs
from cron.job
where command ilike '%booking_email_tick%';
