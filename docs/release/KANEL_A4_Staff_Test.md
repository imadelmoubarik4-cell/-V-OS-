# A4 — staff booking test (production, S109) — revised 23 Oct 2026

**Status: BLOCKED for the multi-stool steps.** The deployed UI can't choose or move
specific stool groups ([`KANEL_A4_Blocker_Multi_Seat.md`](KANEL_A4_Blocker_Multi_Seat.md)).
Part A1 below can run today. Parts A2 and B wait for the approved correction.

Common setup: a date at least 2 days ahead, guest names `A4 TEST …`, no real contact
details, times on the 15-minute grid. Staff bookings trigger no notifications or
guest emails. Cancel every successful test booking at the end.

## Part A — staff UI verification (app.alcedo.is, by the owner or a manager)

### A1. Possible with today's UI

| # | Step | Expected |
|---|---|---|
| A1.1 | Open Bookings for today and the test date | Loads; Bar shows stools 1–16 in sections A (1–8), B (9–12), C (13–16) |
| A1.2 | New booking: 2 guests, 16:00, `A4 TEST 1`, seats left on **Auto-assign** | Saved **Confirmed**, two adjacent stools in one section, 16:00–18:00 |
| A1.3 | Detail: **Arrive**, then **Seat** | Each status saved |
| A1.4 | **Cancel** `A4 TEST 1` | Cancelled; stools free |
| A1.5 | Settings → Business hours | Unchanged |

### A2. After the correction (multi-stool selection)

| # | Step | Expected |
|---|---|---|
| A2.1 | New booking `A4 TEST 1`: 2 guests, 16:00, choose **Bar 3 + Bar 4** | Confirmed, Bar 3+4, 16:00–18:00 |
| A2.2 | New booking `A4 TEST 2`: 2 guests, **18:00**, choose Bar 3 + Bar 4 | **Refused**: 15-minute turnaround |
| A2.3 | Change `A4 TEST 2` to **18:15**, Bar 3 + Bar 4 | **Accepted** |
| A2.4 | Move `A4 TEST 2` to **Bar 8 + Bar 9** | **Refused**: crosses sections A/B |
| A2.5 | Move `A4 TEST 2` to **Bar 5 + Bar 6** | **Accepted** |
| A2.6 | With one stool ticked for a party of 2 | Inline "Choose at least 2 seats"; nothing sent |
| A2.7 | `A4 TEST 1`: Arrive → Seat; `A4 TEST 2`: stays Confirmed | Each change saved |
| A2.8 | **Cancel** both | Cancelled; stools free |

## Part B — database rule verification (Claude, read-only unless approved)

- **B-read (no approval needed):** after Part A, confirm the test reservations, their
  stools, times and status history, with `cancelled` as the end state. Also confirm
  0 web (`public_token`) rows, 0 inbox and 0 outbox rows, and settings unchanged at
  4 / 15 / `public_online_enabled=false`.
- **B-rules (local, done 23 Oct 2026):** the probe on a local S109 database confirmed
  B1–B4 as listed in the blocker document.
- **B-rules in production (optional, needs approval):** run the same probe in
  production inside one transaction that is rolled back. No data persists; the
  booking-reference counter may advance.
