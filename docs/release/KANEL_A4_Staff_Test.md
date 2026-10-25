# A4 — staff booking test (production) — revised 23 Oct 2026

Two parts, at two points in the release:

- **A4a (before the merge, on today's live UI):** the auto-assign part, Part A1.
- **A4b (MANDATORY gate immediately after the PR #135 Netlify deploy, before A6 or any
  further rollout):** the multi-stool part, Part A2. It needs the new seat picker
  (ships on merge) and S110 (applied at A3b, before the merge).

Common setup: a test date at least 2 days ahead, guest names `A4 TEST …`, no real
contact details, times on the 15-minute grid. In the day view, open the test date
first; seats can be chosen only for the open day. Staff bookings trigger no
notifications or guest emails. **Cancel every successful test booking at the end.**

## Part A — staff UI verification (app.alcedo.is, by the owner or a manager)

### A1 — auto-assign (A4a, before the merge)

| # | Step | Expected |
|---|---|---|
| A1.1 | Open Bookings for today and for the test date | Loads; the Bar shows stools 1–16 |
| A1.2 | Add booking: 2 guests, 16:00, `A4 TEST 1`, seats left on auto-assign | Saved **Confirmed**; two adjacent stools in one section (A 1–8, B 9–12 or C 13–16); 16:00–18:00 |
| A1.3 | Open it: **Arrive**, then **Seat** | Each status saved |
| A1.4 | **Cancel** `A4 TEST 1` | Cancelled; stools free |
| A1.5 | Settings → Business hours | Unchanged |

### A2 — multi-stool groups (A4b, mandatory post-deploy gate)

| # | Step | Expected |
|---|---|---|
| A2.1 | Add booking `A4 TEST 1`: 2 guests, 16:00 → Seats: **Choose seats** → tick **Bar 3 + Bar 4** → Save | Confirmed on Bar 3 + Bar 4, 16:00–18:00 |
| A2.2 | Add booking `A4 TEST 2`: 2 guests, **18:00** → Choose seats | Bar 3 and Bar 4 are shown **"Taken 16:00–18:00"** and can't be ticked (15-minute turnaround) |
| A2.3 | Change the time to **18:15** | Bar 3 and Bar 4 show **Free**; tick both → Save → **Confirmed** (same-day reuse) |
| A2.4 | Open `A4 TEST 2` → Seats: untick Bar 3 + 4, tick **Bar 8 + Bar 9** → Save seats | **Refused** in the sheet: "Bar 8 and Bar 9 are in different sections…"; nothing changes |
| A2.5 | Untick 8 + 9, tick **Bar 5 + Bar 6** → Save seats | Saved; the booking shows Bar 5, Bar 6 |
| A2.6 | Add booking: 2 guests, Choose seats, tick only one stool → Save | Inline "Choose seats for 2 guests — the seats chosen hold 1"; nothing saved |
| A2.7 | `A4 TEST 1`: **Arrive → Seat**; `A4 TEST 2` stays Confirmed | Each change saved |
| A2.8 | **Cancel** `A4 TEST 1` and `A4 TEST 2` | Both Cancelled; stools free |
| A2.9 | On a phone: open Add booking → Choose seats | Seats in two columns, easy to tap, no sideways scrolling |

If any A2 step fails: **stop**. Roll back the web deploy (Netlify → publish the
previous deploy) and report it. S110 can stay; the old UI works on it.

## Part B — database rule verification (Claude; read-only unless approved)

- **After A1 and after A2 (read-only):** confirm each test reservation, its stools,
  times and status history, with `cancelled` as the end state. Also confirm 0 web
  (`public_token`) rows, 0 inbox and 0 outbox rows, and settings unchanged at
  4 / 15 / `public_online_enabled=false`.
- **Rules:** proven by `tests/sql/s110_booking_seat_integrity.sql` in CI, on the
  same function bodies applied at A3b. A3b.3 confirms production matches the
  CI-tested build.
- **Optional, needs approval:** run the rule probe in production inside one
  transaction that is rolled back. No data persists; the booking-reference counter
  may advance.
