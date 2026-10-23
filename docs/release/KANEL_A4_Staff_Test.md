# A4 — staff booking test in Alcedo (production, S109)

Run by the owner or a manager in app.alcedo.is. It creates and cancels test
bookings only. Staff bookings do **not** trigger booking notifications or guest
emails (the trigger fires for web requests only). Use a date at least 2 days ahead,
the guest name `A4 TEST`, and no real contact details.

Record PASS/FAIL and the time for each step. Claude then confirms each step
read-only from the database.

| # | Step | Expected |
|---|---|---|
| 1 | Open **Bookings** for today and for the test date | Day view loads; the Bar shows stools 1–16 in sections A (1–8), B (9–12), C (13–16); no errors |
| 2 | **New booking**: 2 guests, test date 18:00, name `A4 TEST 1` | Saved; appears on the floor and in the list |
| 3 | **Assign** Bar 3 + Bar 4 | Saved; status Confirmed |
| 4 | Status: **Arrive**, then **Seat** | Each change is saved |
| 5 | **New booking** `A4 TEST 2`: 2 guests, same date 20:05, assign **Bar 3** | **Refused**: within 15 min of booking 1 ending (20:00) |
| 6 | Same booking, assign **Bar 8 + Bar 9** | **Refused**: crosses sections A and B |
| 7 | Same booking, assign **Bar 5 + Bar 6** | Saved |
| 8 | **Cancel** both test bookings | Both Cancelled; stools free again |
| 9 | Open Settings → Business hours | Values unchanged (hours change is step B1, not part of A4) |

Afterwards Claude checks (read-only): both test reservations exist with status
`cancelled`; history rows match steps 3–8; 0 web (`public_token`) rows; 0 inbox and
0 outbox rows; settings still 4 / 15 / `public_online_enabled=false`.
