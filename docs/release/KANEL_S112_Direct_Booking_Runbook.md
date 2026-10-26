# KANEL S112 — Direct website booking with guest-chosen stools

Migration: `supabase/migrations/20261029090000_s112_public_direct_booking.sql`
Edge function: `supabase/functions/atlas-public-booking/handler.mjs` (version 0.3.0)

## Owner decisions (26 Oct 2026)

- Website bookings are confirmed directly, with no staff step.
- Guests pick their exact stools on a map of the bar (kanel.is).
- One numbering everywhere, staff and guests:
  - 1–4 along the left side, from the bottom up
  - 5–12 along the top, left to right
  - 13–16 down the right side, from the top
- A group sits on one side only: never across a corner (4|5, 12|13), and never across
  the gap in the top row between stools 10 and 11.

## What it does

- **Stool numbers.** The 16 Bar stools are renumbered to the owner's numbering. Each
  stool keeps its id and floor position: same physical stool, new number. Existing
  allocations and holds stay on the same stools, but staff will see new numbers (for
  example, old "Bar 13" at the bottom left is now "Bar 1").
- **Sections.** L = 1–4, T1 = 5–10, T2 = 11–12, R = 13–16. Auto-assignment, staff
  assign/move and guest choices all use the existing one-section, consecutive-numbers
  rule, so the rule is the same for everyone.
- **Owner switch.** `booking_settings.public_instant_confirm` is **off by default**.
  While it is off, `?action=book` behaves like `?action=request`: the booking is
  'requested' and the stools are held for staff Confirm.
- **Availability.** The response gains `booking_mode` ('instant' or 'request') and
  `seat_map`, which lists the free stool numbers for each offered start time. A time
  is offered only while a run of the party's size is free inside one section.
  Staff-only (`block_online`) and unavailable stools are never offered.
- **Booking.** `?action=book` / `?action=request` accept optional `seats` (stool
  numbers).
  - With the switch on, `book` confirms on exactly those stools, or on an adjacent run
    if none were chosen.
  - A stool taken in the meantime returns 409 `seat_taken`.
  - The response adds `seats` and `confirmation_email`, which stays `false` because the
    S108 outbox queues guest emails but no provider delivers them yet.
- **Staff alerts.** Confirmed website bookings now also create an inbox item and a
  push row for managers.

## Apply (owner-approved only)

1. Run `docs/release/sql/KANEL_S112_preflight_readonly.sql`. Continue only if there are
   no FAIL rows, and keep the output. The 'impact' rows show how many future bookings
   will display new stool numbers.
2. Run `docs/release/sql/KANEL_apply_8_s112_public_direct_booking.sql`. It refuses
   unless S111 (`20261028090000`, bundle 7) is recorded and S112 is not.
3. Deploy the `atlas-public-booking` edge function (0.3.0).
4. Check that availability answers with `booking_mode: "request"` and a `seat_map`. The
   kanel.is site (`…_direct-r9`) then shows the stool map and still sends requests.
5. When the owner is ready for direct booking:
   ```sql
   update atlas_private.booking_settings set public_instant_confirm = true where id = true;
   ```
   The site then switches to "Book table / Confirmed instantly" by itself. To go back
   to requests, set it to `false`.
6. Before switching on, update the booking privacy notice: it currently says no
   automatic confirmation emails are sent, which stays true until an email provider is
   connected.

## Rollback

Run `docs/release/sql/KANEL_S112_rollback.sql`. It:

- restores the three functions S112 rewrote to their exact S111 definitions
- drops the four public-seat helpers
- gives the stools their pre-S112 numbers, labels and sections back (same physical
  stools)
- turns the switch off
- removes the ledger row

Bookings already confirmed stay confirmed. The column stays unless its commented line
is enabled. `KANEL_S111_rollback.sql` refuses to run while S112 is recorded.

## Proof

- `tests/sql/s112_public_direct_booking.sql` (via `scripts/verify_s112_public_direct_booking.sh`)
- `tests/node/public-booking-s112.test.js`: action → mode, stool validation before any
  RPC, and `seat_taken`
- The S106, S107 and S110 acceptances now use the owner numbering
- `scripts/release/verify_kanel_bookings_rollback.sh`:
  - the S112 rollback applies twice and matches `kanel_pre_s112_expected.json` and the
    pre-S112 stools
  - the S111 rollback refuses while S112 is recorded
  - bundles 1–8 re-apply in order and refuse repeats
