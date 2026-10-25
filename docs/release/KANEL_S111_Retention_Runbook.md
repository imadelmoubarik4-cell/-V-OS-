# KANEL S111 — Automatic deletion of booking personal data

Migration: `supabase/migrations/20261028090000_s111_booking_personal_data_retention.sql`

## What it does

Every night at 03:17 UTC (pg_cron job `kanel-booking-retention`) Alcedo runs
`atlas_private.booking_purge_personal_data(90, false)`:

- Bookings whose visit ended **more than 90 days ago** are anonymised. Guest name,
  phone, email, requests, staff notes, the guest link token, idempotency key and
  provider reference are cleared. The row keeps date, party size, status, area, seats
  and the KA- reference, so totals still add up, but it no longer identifies anyone.
- Messages that repeat guest details are deleted: the staff booking inbox, the guest
  email outbox and booking push rows for those bookings, plus any older than 90 days.
- Each run writes one row with counts only to `atlas_private.booking_retention_runs`.
- No notifications or emails are sent by the clean-up.

The function refuses windows shorter than 30 days. Browser roles cannot run it or
read its log.

## Production impact at preflight (25 Oct 2026)

All checks PASS. 0 bookings are older than 90 days (the oldest visit is 2026-10-26),
so the first run that actually removes data falls around 24 Jan 2027.

## Apply (owner-approved only)

1. Run `docs/release/sql/KANEL_S111_preflight_readonly.sql`. Continue only if there
   are no FAIL rows; keep the output.
2. Run `docs/release/sql/KANEL_apply_6_s111_booking_personal_data_retention.sql`. It
   refuses unless S110 is recorded and S111 is not.
3. Verify:
   ```sql
   select jobname, schedule, command, active from cron.job where jobname = 'kanel-booking-retention';
   select atlas_private.booking_purge_personal_data(90, true);  -- dry run, changes nothing
   ```
4. Then restore the 90-day text on both privacy pages (see
   `KANEL_Booking_Privacy_Notice.md`).

## Rollback

`docs/release/sql/KANEL_S111_rollback.sql` stops the job and removes the function, the
run log and the ledger row. It does **not** bring back data that was already removed.

## Proof

- `tests/sql/s111_booking_personal_data_retention.sql` (via
  `scripts/verify_s111_booking_personal_data_retention.sh`): 100- and 91-day-old
  bookings are anonymised; 89-day-old and future bookings are untouched; linked and
  old messages are deleted, recent ones kept; a repeat run is a no-op; the log holds no
  guest details.
- `scripts/release/verify_kanel_bookings_rollback.sh`: the rollback runs twice and
  leaves nothing behind; bundle 6 re-applies and refuses a repeat run.
