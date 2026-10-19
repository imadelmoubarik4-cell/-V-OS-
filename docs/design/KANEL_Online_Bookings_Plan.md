# KANEL × ALCEDO — Online Bookings Implementation Plan

Status: **planning + Phase 1**. Nothing here is deployed. No production database
change, no edge-function deploy, no website publish is authorised. The public
booking path is gated behind `PUBLIC_BOOKING_ENABLED` (config.js), **false by
default**, and stays off until the owner approves at Phase 7.

This plan maps the approved business handoff onto the **existing** Alcedo
bookings system (migration `supabase/migrations/20261020090000_s103_bookings.sql`,
edge function `supabase/functions/atlas-bookings/`, staff UI
`apps/web/assets/js/bookings-workspace.js`). Per the handoff, Alcedo stays the
single authoritative system — no separate booking database, no replacement of the
staff interface.

> Note on the live definitions: several RPCs in the migration are defined twice —
> a generic version first, then **overwritten** by the production (VÁ) version in
> §6 (lines ~1190–1794). The §6 copy is the live one; corrections patch §6.

## Current state (baseline) vs. target

| Rule | Where (file · symbol) | Current | Target |
|---|---|---|---|
| Online party cap | `booking_settings.max_party_online`; read in `atlas_bookings_create` web path | **30** | **4** |
| Buffer between reservations on a stool | `booking_settings.turnaround_minutes`; used in `booking_table_free` | **0** | **15** |
| Reservation duration | `booking_settings.default_duration_minutes` + `_create` cap | **120** (cap `least(120, …)`) | 120 (keep; align `_availability`, which omits the cap) |
| Slot interval | `booking_settings.slot_interval_minutes` | 15 | 15 (no change) |
| Booking horizon | `booking_settings.advance_days` | 90 | 90 (no change) |
| Max online party guests | — | 1–4 stools, one guest each | enforce via cap=4 + Bar-only area |
| Last bookable time | `booking_settings.last_start_local` (single global `'20:30'`); `_create` web check | **one fixed clock time** | **per-day = that day's close − 120 min** |
| Weekly hours source | `booking_settings.hours` jsonb | **declared but dormant** (never read) | store + enforce Sun–Thu / Fri–Sat, Atlantic/Reykjavik |
| Bar adjacency | `booking_find_contiguous_tables` + `booking_areas.circular_adjacency` (Bar seeded `true`) | **circular ring, wraps 16→1** | **three independent segments** 1–8, 9–12, 13–16; never cross 8–9, 12–13, 16–1 |
| Contiguous multi-stool availability | `_availability` | per-table only | recognise runs of adjacent single stools within a segment |
| Segment enforcement on staff assign/approve/reassign | `_assign`, `_set_status` | not segment-aware | enforce the same three segments |
| Public (guest) endpoint | `atlas-bookings/handler.mjs` | **none** (staff-only) | new scoped guest availability / request / status |
| Reservation lifecycle | `reservations.status`; `_create`/`_assign`/`_set_status` | requested→confirmed on allocation | web → `requested`; confirmed only after staff allocates valid adjacent stools; expiring hold, no permanent block |
| Double-book safety | `FOR UPDATE` on candidate `booking_tables` + partial unique index `reservation_tables_active_uniq` | present | keep + extend to the segment-aware path |

## Phase plan

**Phase 1 — Preparation (this PR).**
- Isolated branch `claude/kanel-online-bookings` off `main`.
- `PUBLIC_BOOKING_ENABLED: false` added to `config.js` (disabled by default).
- This plan + baseline table + rollback (below).
- No schema/edge/UI behaviour change yet; staff bookings unchanged.

**Phase 2 — Booking engine (new migration, NOT applied to production).**
- New migration updates `booking_settings` (`max_party_online=4`, `turnaround_minutes=15`)
  and stores the weekly schedule.
- Replace circular adjacency with three segments: add a segment concept (a
  `segment` key on `booking_tables`, or an area split) since only `position_index`
  + an area-level boolean exist today; rewrite `booking_find_contiguous_tables` to
  never cross a segment boundary and to stop wrapping.
- Replace the global `last_start_local` check with a per-day last-start derived
  from each day's closing time (close − 120 min), from the stored schedule.
- Correct `_availability` to surface contiguous runs of adjacent single stools and
  to apply the same day/segment/duration rules as `_create`.
- Apply the segment rule in `_assign` / `_set_status` (staff assign, approve,
  reassign) too.
- Additive tests for the new values and the segment/day-cutoff behaviour.

**Phase 3 — Guest API (edge, behind the flag). DONE (s107 + s109 hardening).**
- A separate, narrowly scoped public edge function `atlas-public-booking`:
  availability (read), reservation-request (create as `requested`), and guest
  status-by-token — with idempotency, rate protection, and **no** staff
  credentials, service keys or other guests' PII exposed. Honours an expiring
  hold; never presents a pending request as confirmed; allocation stays
  transaction-safe. An **independent server flag** (`PUBLIC_BOOKING_ENABLED`),
  separate from the DB flag (`public_online_enabled`, re-checked by every RPC)
  and the frontend flag, keeps the endpoint inert by default.
- s109 security hardening (owner review): the status RPC re-checks the DB flag;
  rate budget is consumed in its own committed transaction at the edge
  (`atlas_public_booking_rate`) so failed requests still count, and it gates
  availability/status/request alike; X-Forwarded-For is read from the trusted
  (rightmost) hop, never a spoofable leftmost entry; a strong `PUBLIC_BOOKING_SALT`
  is mandatory (fails safe, never falls back to a raw IP); a conflicting
  idempotency reuse is refused rather than returning the stored guest's token;
  the status token can travel in a header/POST body instead of the URL; CORS is
  restrictive by default (the KANEL origins, never `*`).

**Phase 4 — Website integration. BLOCKED — see below.**

**Phase 5 — Staff notifications. DONE (s108 + s109).**
- A real in-app notification **inbox** (`atlas_private.booking_notifications`,
  sealed) written by the booking lifecycle trigger for every active
  manager/admin, with per-user read/unread, surfaced in the app-wide bell by a
  small event-driven (no-poll) client worker (`bookings-notifications.js`) and
  reachable through the authenticated staff edge (`?action=notifications` /
  `notifications-read`). It works whether or not `ATLAS_PUSH_DELIVERY_ENABLED`
  is set. Clicking a notification deep-links the exact reservation
  (`#bookings/res/<id>`); the service worker routes booking pushes there too,
  even when the app was closed.
- The workflow fires **only** for KANEL online bookings — gated on the
  `public_token` origin marker, never `source` — so legacy VÁ Bar / Sinna
  reservations never trigger KANEL-branded mail or alerts.
- Correct lifecycle semantics: a rejected pending request (`requested→cancelled`)
  is `declined` (distinct guest email); a cancelled confirmed booking is
  `cancelled`; `no_show` writes the inbox only and never emails the guest.
- A sealed, inert email **outbox** (`booking_email_outbox`), sender
  `kanel@kanel.is`, with a de-dupe key so repeated lifecycle events cannot later
  send duplicate guest mail. **No email is ever sent** by the current code;
  activation waits on an owner-approved provider (see
  `docs/release/KANEL_Booking_Email_Readiness.md`).

**Phase 6 — Verification.** Automated db/concurrency/security/browser/mobile/a11y
tests in staging; all 30 verification cases documented.

**Phase 7 — Release approval.** Demonstrate the full flow; obtain explicit owner
authorisation before any deploy or publish. The flag flips on only here.

## Open decision — Phase 4 website (BLOCKER)

The handoff targets "KANEL's Moss & Stone website … V10 menus." **That website is
not in this repository, and no KANEL website repository is available to this
session.** In `-V-OS-`, "KANEL" is only the pricing module. The public restaurant
site present here is `prototypes/vabar-website/` (VÁ Bar, React), whose booking is
currently an external **Sinna** link (`src/content.ts` `bookingUrl: null`), not
wired to Alcedo. There are also `alcedo-website` and `atlas-website` prototypes.

Phases 1–3, 5 and the engine/API acceptance criteria do **not** depend on the
site and will proceed. Phase 4 needs one of:
1. the KANEL website repository added to this session (`add_repo`), or
2. confirmation the target is `prototypes/vabar-website` (or another prototype
   here), or
3. deferring Phase 4 until the site is available.

## Rollback

- All Phase 2+ schema changes ship as a **new, additive** migration that is NOT
  applied to production until approved; production keeps running the current
  `s103` migration. Rollback before approval = do not apply the new migration.
- The public path is inert while `PUBLIC_BOOKING_ENABLED` is false; flipping it
  back to false fully disables the guest flow with no data change.
- The staff bookings workspace, its RPCs and the staff/phone/walk-in flows are
  unchanged by Phase 1 and remain the fallback at every phase.
