# S110 — booking seat integrity: production impact and release plan

**Status: implemented and tested on the draft branch only. Not applied to
production.** Applying S110 needs the owner's separate approval and fresh
pre-apply checks (checklist A3b).

## What changes

| Area | Before (S109, live) | After S110 |
|---|---|---|
| Staff create, **auto-assign** | adjacent group within a section (S106 finder) | unchanged result; now also passes the full seat-group rule |
| Staff create, **chosen seats** | capacity, location and turnaround only; **no adjacency or section check**; unavailable seats not refused | full seat-group rule |
| Staff **assign / move** | section check and turnaround only; **no capacity check**; duplicates and unavailable seats not refused | full seat-group rule; moving to another booking area is refused |
| `booking_table_json` | no section field | adds read-only `segment` |
| Public guest booking | unchanged (uses the S106 finder; still switched off) | unchanged |

**The seat-group rule** (`atlas_private.booking_check_seat_group`, new and sealed)
refuses with 22023 / `atlas:invalid_request` unless:
- there is at least one seat and no duplicates;
- every seat exists, in one location;
- the location is active and seat-based (not pooled), and on create it is the
  requested location;
- every seat is bookable, not temporarily unavailable and outside its
  `unavailable_from`–`unavailable_until` window;
- the seats are one adjacent group within a single section;
- total seat capacity is at least the party size.

Finally, each seat must be free for the window **including the 15-minute
turnaround**, checked under row locks; otherwise it refuses with 23505 /
`atlas:conflict`.

**Not changed:**
- staff authorisation (`booking_require_staff`) and grants (`service_role` only;
  `anon` and `authenticated` denied);
- tables, columns and data;
- the S106 rules (cap 4, 15 min, sections);
- online booking and notifications.

Function count: **4**. That is the two behaviour replacements (create, assign), plus
`booking_table_json` (one added read-only field) and the new rule helper. The
original proposal said two; the extra two keep a single implementation of the rule
and let the UI explain section refusals.

## Effect on existing bookings

- Existing allocations are **not modified**. The rule applies when a booking is
  created or moved.
- A future allocation that already breaks the rule keeps its seats. Moving it again
  needs a valid group. Production currently has **0 future bookings** (A2.9
  preflight, 23 Oct 2026). The S110 preflight (`impact` rows) lists any that exist
  at apply time.

## Staff UI (ships with the PR #135 merge; web app only, no flag)

- **Add booking:** a "Seats" choice. **Auto-assign adjacent seats** is the default
  and sends no seats. **Choose seats** shows each stool by section with a
  time-aware state ("Free", "Taken 16:00–18:00", "Held", "Unavailable").
- **Move:** the same picker with the booking's current seats pre-ticked. Moves
  stay inside the reservation's existing area; cross-area relocation is not part
  of this release. **Save seats** sends the whole group.
- **Time-aware:** availability is computed for the booking's own window, with the
  15-minute gap on both sides. It uses `snapshot.rules.turnaround_minutes` when the
  server provides it, otherwise the approved 15. The day-wide floor-plan status no
  longer decides which seats can be chosen, so Bar 3+4 booked 16:00–18:00 can be
  chosen again from 18:15.
- **Before any request**, clear messages for: too few seats ("Choose seats for 2
  guests — the seats chosen hold 1"), different sections ("Bar 8 and Bar 9 are in
  different sections…") and gaps. Focus returns to the seats.
- **Server refusals** (for example a seat taken meanwhile) are explained in the
  sheet, which stays open. The server is authoritative.
- Seats can be chosen only for the day that's open, so availability is never stale.
  If staff choose manual seats for another date or an unavailable picker, submission
  is blocked with an inline explanation; it never silently falls back to auto-assign.
  Auto-assign works for any date.
- 44 px seat targets, keyboard Tab/Space, phone layout with two columns.
- Fixed in the same change: on a phone, a Bar with positioned stools widened the
  whole page (the floor grid's parent did not shrink). Found by the new phone
  test; this was not caused by S110.
- Known limit: the snapshot's holds don't carry a reservation id. When moving a web
  request, a hold covering exactly its own time window is treated as its own hold
  (the server ignores a booking's own holds anyway).

## Release order (each step separately approved)

1. **A3b — S110 apply:** run `KANEL_S110_preflight_readonly.sql` (0 FAIL, owner
   reviews WARN), then `KANEL_apply_5_s110_booking_seat_integrity.sql`, then the
   read-only post-checks. It must come **before** the merge, so that the new UI
   (which sends multi-seat groups) always meets the full server rule.
2. **A4a — staff test, auto-assign part** (on the live UI; possible today).
3. **A5 — merge PR #135** (Netlify deploys the staff UI).
4. **A4b — mandatory post-deploy gate:** the full multi-stool UI test immediately
   after the deploy, before A6 or any further rollout. If it fails, roll back the
   web deploy (Netlify: publish the previous deploy); S110 can stay.

## Rollback

- **Web:** Netlify → publish the previous deploy (the old UI works on S110).
- **Database:** `KANEL_S110_rollback.sql`. One transaction, idempotent; restores the
  exact S109 bodies of the three rewritten functions, drops the helper, clears the
  S110 ledger row; no data change.
- **Order:** S110 rollback first. `KANEL_S106_S109_rollback.sql` now **refuses while
  S110 is recorded**, because S110's rule uses an S106 function.

## Tests

| Test | Result (local) |
|---|---|
| `tests/sql/s110_booking_seat_integrity.sql` | pass on S110; **fails on S109** at "create on Bar 8+9 was allowed" (proves it catches the gap) |
| Existing booking acceptances on S110 (S99, S106–S109) | all pass |
| Replay gate (`verify_kanel_bookings_rollback.sh`) | S110 rollback → S106–S109 rollback refused first, then rolled back → re-apply S106→S110 → acceptances: **pass** |
| `tests/browser/bookings-seats.browser.test.mjs` (new, 8 tests) | 8/8 |
| `tests/browser/bookings.browser.test.mjs` | 8/8; two tests now drive the new controls with **unchanged assertions** |
| `tests/browser/bookings-notifications.browser.test.mjs` | 5/5 |
| Node contracts | 1628 pass, 0 fail |
| Python contracts (`test_kanel_release_tooling.py` 10/10) | all pass, apart from the known local `pdfplumber` gap |

SQL coverage:
- parties 1–4 auto-assign into one section;
- explicit Bar 3+4 for 16:00–18:00, then 18:00 refused and 18:15 accepted;
- 13:45 accepted and 14:00 refused;
- Bar 8+9 and Bar 1+3 refused, on create and on move;
- one stool for 2 refused; 3 stools for 4 refused;
- duplicate, unknown, temporarily unavailable, unavailable-window and non-bookable
  stools refused;
- a move to a different booking area is refused, and the original area is unchanged;
  seats from two locations are refused;
- a viewer can neither create nor move;
- grants sealed; `segment` exposed.
