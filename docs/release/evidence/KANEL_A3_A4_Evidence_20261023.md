# A2.9 / A3 / A4 — S106–S109 applied to production (23 Oct 2026)

**Approval:** the owner authorised A3 on 23 Oct 2026, scope confirmed as
"A3.1–A3.4 + A4 checks". Nothing else was approved: no merge, no edge deploy, and no
flag, secret, hours, website or email change.

Method: Supabase Management API (`/database/query`). Read-only for every check; a
write only for the four reviewed bundles from release commit `3ea337a`.

## A2.9 — fresh preflight (07:29 UTC, read-only)

- `KANEL_preflight_readonly.sql`: **17 PASS · 13 INFO · 0 WARN · 0 FAIL**. Ledger at
  S105, no S106–S109 rows, no conflicting or future bookings.
- Booking data: all 11 tables **byte-identical** to the A2 export (same md5), so the
  A2 backup is current.

## A3 — apply bundles (one transaction each, in order)

| Bundle | UTC | Result |
|---|---|---|
| `KANEL_apply_1_s106_bookings_engine.sql` | 07:31:18 | HTTP 201; ledger gained `20261023090000` |
| `KANEL_apply_2_s107_public_booking_api.sql` | 07:31:30 | HTTP 201 |
| `KANEL_apply_3_s108_booking_notifications.sql` | 07:31:31 | HTTP 201 |
| `KANEL_apply_4_s109_booking_notifications_inbox.sql` | 07:31:32 | HTTP 201 |

Ledger afterwards: `20261022090000`, `20261023090000`, `20261024090000`,
`20261025090000`, `20261026090000`.

## A4 — post-apply checks (read-only)

| Check | Result |
|---|---|
| `booking_settings` | `max_party_online 4`, `turnaround 15`, **`public_online_enabled false`**, hold 15 min |
| Areas | Bar online-bookable, circular off; Wine cellar / Ocean view / Long table staff-only |
| Reservations | 0 total; 0 web (`public_token`) rows |
| Lifecycle trigger | present; inbox 0 rows; email outbox 0 rows (nothing sent) |
| 17 release-touched functions vs the CI-tested S109 build | **17/17 identical** (body md5 + grants) |
| Queue constraints vs the CI-tested S109 build | **2/2 identical** |
| Guest and inbox RPCs | **service_role only**; `anon` and `authenticated` cannot execute (6/6) |

**Still to do by staff (part of A4, manual):** in Alcedo, open Bookings for today and
a future day. Create a test booking for 2, assign seats, change its status, then
cancel it. Confirm the Bar shows sections A/B/C, and that a two-stool booking across
Bar 8|9 is refused.

## State now

- Staff rules are live: 15-min turnaround, fixed Bar sections, online cap 4 (web
  only).
- **Guests cannot book.** The DB flag is off, `atlas-public-booking` is not
  deployed, and kanel.is is unchanged.
- `atlas-bookings` (deployed from `main`) and app.alcedo.is are unchanged and
  compatible: S106–S109 keep every staff RPC signature.
- `main` does not yet contain S106–S109. Merging PR #135 (A5) aligns the repo.
- Rollback, if needed: tier 1 (settings 30 / 0) or tier 2
  (`KANEL_S106_S109_rollback.sql`, CI-proven), each with owner approval.
