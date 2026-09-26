# S94 publisher scheduler — owner runbook

The scheduler is an **optional, separate rollout stage** (stage S in
`S94_Rollout_Package.md`). S94 can ship, and be used for drafting, approval,
media and manual "Publish now" checks, with **no cron job and automatic
publishing off**. Do not run anything here until the owner approves stage S.

| Artifact | Purpose |
|---|---|
| `scripts/s94_publisher_schedule_install.sql` | Install / re-install the one tick job (idempotent) |
| `scripts/s94_publisher_schedule_uninstall.sql` | Kill switch: remove the job (safe to repeat) |
| `scripts/verify_s94_publisher_schedule.sh` | Local proof of the two scripts against real `pg_cron` (never production) |

## What the tick does

Every minute `pg_cron` runs `select atlas_private.marketing_publisher_tick('cron');`.
The function checks whether anything is due; if nothing is, it returns without
any network call. When something is due it sends one `pg_net` POST to
`<project URL>/functions/v1/atlas-marketing-publisher?action=tick` with the
`x-atlas-publisher-secret` header read from Vault.

"Due" means: a post already sent to a platform that needs its status checked
(`processing` / `verifying`), an expired worker lease, or — **only when the
Marketing setting "Automatic publishing" is on** — a queued or retrying post
whose time has come. With automatic publishing off, installing the scheduler
never publishes anything.

## Before running the install (owner, Supabase dashboard)

1. Stages 1–5 of the rollout are complete and verified (migrations, secrets,
   functions, web).
2. `ATLAS_MARKETING_PUBLISHER_SECRET` is set on the functions (same value as below).
3. Vault → add two secrets (type the values in the dashboard, never in chat):
   - `atlas_project_url` = `https://<project-ref>.supabase.co` (no path, no trailing slash)
   - `atlas_marketing_publisher_secret` = the publisher secret (≥ 32 characters)

## Install

Open the SQL editor, paste the whole of `scripts/s94_publisher_schedule_install.sql`,
run it once. It runs in one transaction and either completes fully or changes nothing.

It will stop with a clear message (and change nothing) if:
- `pg_net` or `pg_cron` cannot be enabled,
- the S94C migration is not applied,
- either Vault secret is missing, duplicated or malformed (values are never printed),
- another cron job already calls `marketing_publisher_tick`.

The final result row must show:

| column | expected |
|---|---|
| `jobname` | `atlas-marketing-publisher-tick` |
| `schedule` | `* * * * *` |
| `command` | `select atlas_private.marketing_publisher_tick('cron');` |
| `active` | `true` |
| `automatic_publishing_on` | `false` (until the owner switches it on in Marketing) |
| `due_for_worker_now` | `0` at launch |

## Re-running

Re-running the install is safe. `cron.schedule()` with an existing job name
updates that job in place, the script holds an advisory lock so concurrent
runs cannot interleave, and its verification step aborts the transaction if
more than one job calls the tick. Proven locally: 2 sequential and 3
concurrent re-runs leave exactly one job with the same `jobid`.

## Check it is running (read-only)

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'atlas-marketing-publisher-tick';
select status, return_message, start_time from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'atlas-marketing-publisher-tick')
 order by runid desc limit 5;
```

Runs should show `succeeded`. With automatic publishing off and nothing sent
yet, the `atlas-marketing-publisher` function logs show no tick calls.

## Kill switch

```sql
select cron.unschedule('atlas-marketing-publisher-tick');
```

or run `scripts/s94_publisher_schedule_uninstall.sql` (also checks that no
other job still calls the tick). Nothing else changes: posts, settings and
secrets stay as they are. Turning **Automatic publishing** off in Marketing is
the product-level stop and works with or without the job.

## Local proof (developers only)

```
# local PostgreSQL 16 with the real pg_cron package, configured with
#   shared_preload_libraries = 'pg_cron'
#   cron.database_name = 's94_cron'
#   cron.use_background_workers = on
PGPASSWORD=… bash scripts/verify_s94_publisher_schedule.sh
```

Last run (26 Sep 2026, pg_cron 1.6, PostgreSQL 16): all 9 checks passed —
refusals leave no job and no extension behind; one job created; 2 sequential +
3 concurrent re-runs keep one job; a second tick job is refused; automatic
publishing off: a due queued post is not sent by a direct tick or by a real
`pg_cron` run; automatic publishing on: the tick calls the worker with the
secret header; the kill switch removes the job and is safe to repeat.
`pg_net` and Vault are local stand-ins in this proof (they exist only on Supabase).
