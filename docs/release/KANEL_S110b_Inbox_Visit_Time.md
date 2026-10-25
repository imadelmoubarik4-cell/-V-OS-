# KANEL S110b — Website requests reach staff with their details

## Problem (25 Oct 2026)

Website requests were stored in Alcedo with the guest's name, phone, email, note and
time, but staff could not see them:

- A booking notification opened Bookings on **today** and looked for the reservation
  there. Every web request so far is for another day, so nothing opened.
- A web request has no seats until staff confirm it. On a seat-by-seat area (the Bar)
  it was listed nowhere; its held stools only said "Booked", with no name or time,
  and tapping them did nothing.

## Fix

- **Database (S110b, `20261027120000`)**: `public.atlas_bookings_notifications` also
  returns `start_at` and `visit_date` (Atlantic/Reykjavik) for each row. Same
  signature, grants, manager gate, ordering and limit. Nothing else changes.
- **App**: a notification opens `#bookings/res/<id>/<visit date>`, so the right day
  loads and the booking's detail sheet opens (name, phone, email, requests, reference,
  Confirm / Cancel / seats). The day view lists **Requests waiting** with name, time,
  party size, phone and email. A held stool reads **Requested** with the guest's
  name and opens the request. A link to a booking on another day says so instead of
  doing nothing. If Bookings is already open on another day, the right day is loaded.

The old app ignores the two extra keys, so S110b can be applied before the app
change is deployed.

## Apply (production)

1. `docs/release/sql/KANEL_S110b_preflight_readonly.sql`: every row PASS.
2. `docs/release/sql/KANEL_apply_6_s110b_booking_inbox_visit_time.sql`.
3. Rollback if needed: `docs/release/sql/KANEL_S110b_rollback.sql` (refuses while S111
   is recorded; restores the exact S109 function).

## Proof

- `tests/sql/s110b_booking_inbox_visit_time.sql`, run by
  `scripts/verify_s110b_booking_inbox_visit_time.sh`.
- `scripts/release/verify_kanel_bookings_rollback.sh`: the S110b rollback refuses while
  S111 is recorded, restores the S109 definition (md5 `ad9b5f66…`) and is idempotent;
  bundle 7 (S111) refuses before bundle 6 (S110b).
- `tests/browser/bookings-requests.browser.test.mjs`: notification → request's own
  day and detail sheet; Requests waiting row; held stool says Requested.
