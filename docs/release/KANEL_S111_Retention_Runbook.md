# KANEL S111 — Automatic deletion of booking personal data

Migration: `supabase/migrations/20261028090000_s111_booking_personal_data_retention.sql`

## What it does

Every night at 03:17 UTC (pg_cron job `kanel-booking-retention`) Alcedo runs
`atlas_private.booking_purge_personal_data(90, false)`:

- Bookings whose visit ended **more than 90 days ago** have their personal details
  removed. Guest name, phone, email, requests, staff notes, the guest link token,
  idempotency key and provider reference are cleared. The row keeps date and time,
  party size, status, source, area, seats and the KA- reference, so totals still add
  up. It no longer holds a name or contact details.
- Messages that repeat guest details are deleted: the staff booking inbox, the guest
  email outbox and booking push rows for those bookings, plus any older than 90 days.
- Staff free-text notes typed on status changes (`reservation_status_history.note`)
  are cleared for those bookings. The history is append-only (S96), so the purge uses
  S96's transaction-local break-glass, which the guard honours only for session user
  `postgres`/`supabase_admin`. pg_cron jobs run as `postgres`. If the purge is ever run
  under another session user, it fails and changes nothing.
- Each run writes one row with counts only to `atlas_private.booking_retention_runs`.
- No notifications or emails are sent by the clean-up.

What stays after 90 days (no name or contact details, but **not claimed anonymous**):
the KA- reference, date and time, party size, status and status history (times and
which staff member), source, area and table/seat assignment, and booking events
(status changes, party size, source, table ids, staff labels). Supabase's routine
backups are outside this job.

Tables checked against production on 25 Oct 2026 (every table with a foreign key to
`reservations`, plus booking messages): `reservations`, `reservation_status_history`,
`booking_events`, `booking_holds` (system reason only), `reservation_tables`,
`booking_notifications`, `booking_email_outbox`, `push_notification_queue`. Booking
event payloads hold no guest fields. The edge function does not log guest data, and
the rate-limit table holds only salted hashes that expire within about an hour.

The function refuses windows shorter than 30 days. Browser roles cannot run it or
read its log.

## Production impact at preflight (25 Oct 2026, read-only)

All checks PASS (run before S110b was added; S111 now applies after S110b). Production was at S110 with no S111 row; pg_cron 1.6.4 is available
but not yet installed. Impact: 0 bookings, 0 inbox / 0 outbox rows, 0 push rows and
0 status notes older than 90 days, so the first dry run reports 0 everywhere. The
oldest visit is 2026-10-26, so the first run that actually removes data falls around
24 Jan 2027.

## pg_cron

The migration runs `create extension if not exists pg_cron` (it installs into
`pg_catalog` and creates the `cron` schema) and then `cron.schedule(...)`, which
upserts by job name. Proven locally on PostgreSQL 16 with pg_cron 1.6: the job is
created as user `postgres`; a per-minute copy executed by the pg_cron worker
anonymised a seeded 120-day-old booking and cleared its status note (run status
`succeeded`). CI uses stock postgres:17 without pg_cron, so it proves the
not-scheduled path.

## Apply (owner-approved only)

1. Run `docs/release/sql/KANEL_S111_preflight_readonly.sql`. Continue only if there
   are no FAIL rows; keep the output.
2. Run `docs/release/sql/KANEL_apply_7_s111_booking_personal_data_retention.sql`. It
   refuses unless S110b (`20261027120000`, bundle 6) is recorded and S111 is not.
3. Verify:
   ```sql
   select jobname, schedule, command, active from cron.job where jobname = 'kanel-booking-retention';
   select atlas_private.booking_purge_personal_data(90, true);  -- dry run: expect all counts 0
   -- (the dry run writes one counts-only row to atlas_private.booking_retention_runs)
   ```
4. Then restore the 90-day text on both privacy pages (see
   `KANEL_Booking_Privacy_Notice.md`).

## Rollback

`docs/release/sql/KANEL_S111_rollback.sql` stops the job and removes the function, the
run log and the ledger row. It does **not** bring back data that was already removed.
It refuses while S112 is recorded; run `KANEL_S112_rollback.sql` first.

## Proof

- `tests/sql/s111_booking_personal_data_retention.sql` (via
  `scripts/verify_s111_booking_personal_data_retention.sh`): 100- and 91-day-old
  bookings are anonymised; 89-day-old and future bookings are untouched; linked and
  old messages are deleted, recent ones kept; a repeat run is a no-op; the log holds no
  guest details.
- `scripts/release/verify_kanel_bookings_rollback.sh`: the rollback runs twice and
  leaves nothing behind; bundle 6 re-applies and refuses a repeat run.
