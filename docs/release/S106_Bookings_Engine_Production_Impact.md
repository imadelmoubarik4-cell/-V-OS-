# S106 Bookings Engine — Production Impact, Prerequisites & Rollback

Status: **not applied to production.** S106 is an additive migration on the
`claude/kanel-online-bookings` branch (PR #135). It must not be applied to the
production database without the owner's explicit approval. This document records
what it changes, what it needs, and how to roll it back, because — as the owner
noted — **S106 changes staff booking behaviour even while public bookings stay
disabled.**

## 1. Staff-facing behaviour changes (apply the moment S106 is applied)

These take effect for staff/phone/walk-in bookings as soon as the migration runs,
independently of `PUBLIC_BOOKING_ENABLED`:

| Change | Effect on existing staff behaviour |
|---|---|
| `turnaround_minutes` 0 → **15** (global) | **Most impactful.** Every source now needs a 15-minute gap between two reservations on the *same* stool. Back-to-back same-stool bookings that were allowed at 0 buffer are now rejected as a conflict. Applies to phone/walk-in/web alike. |
| Bar `circular_adjacency` true → **false** + segment model + `booking_find_contiguous_tables` rewrite | Auto-assignment of adjacent Bar stools no longer wraps 16→1 and never crosses a section boundary (8–9, 12–13, 16–1). A run that previously spanned a corner is no longer offered; auto-assign stays within one section (A 1-8, B 9-12, C 13-16). |
| `atlas_bookings_assign` section guard | A staff member assigning **multiple** Bar stools across a corner (e.g. Bar 8 + Bar 9) is now refused (`atlas:invalid_request`). Single-stool and within-section contiguous assignments are unaffected. |
| `max_party_online` 30 → **4** | Affects only the `web` source path in `atlas_bookings_create`. Staff phone/walk-in creation is **not** capped by this value. No public/web traffic exists yet (public path is flag-off), so no live effect today; it pre-sets the online rule. |

The staff Bookings workspace renders unchanged: the Bar floor grid now keys off
each stool's `position_index` instead of the retired `circular_adjacency` flag.

No reservation rows, statuses, allocations or holds are modified by S106. It adds
one nullable column (`booking_tables.segment`), updates the single settings row,
re-seeds the Bar stools' section, and replaces three function definitions.

## 2. Operating hours (unverified for KANEL)

The per-day last-start helper (`booking_day_last_start_minutes`) derives the last
bookable start from `settings_business_hours` (open/close/`close_next_day`) — the
configurable, authoritative venue hours, computed in the venue's local day. **The
current `settings_business_hours` rows may still reflect the previous venue's
schedule.** S106 does not change them and does not assert any hours as KANEL's.
Before the public path is enabled, the owner must review/confirm the venue hours;
until then no hours are described as "confirmed for KANEL." The helper reads
whatever is configured — it hardcodes nothing.

## 3. Migration prerequisites

- Apply order: after `20261020090000_s103_bookings.sql` (it `create or replace`s
  s103's functions and alters s103's tables). The timestamp (20261023) places it
  after s103/s104/s105, which is correct.
- Purely additive/idempotent DDL: `add column if not exists`, `update … where id`,
  `on conflict`-free seed updates by id, `create or replace function`. No data
  backfill, no destructive drop.
- Full 167-migration replay applies it cleanly on PostgreSQL 17 (CI `replay`
  gate, and a local replay on PostgreSQL 16).

## 4. Rollback plan

- **Before applying:** simply do not apply S106; production keeps running the
  s103 engine. The branch/PR carries no production effect.
- **After applying, to revert:** apply a down-migration that
  (a) `update booking_settings set max_party_online = 30, turnaround_minutes = 0`,
  (b) `update booking_areas set circular_adjacency = true` for the Bar,
  (c) restores the s103 definitions of `booking_find_contiguous_tables` and
  `atlas_bookings_assign` verbatim (re-run their s103 `create or replace`), and
  (d) optionally `alter table booking_tables drop column segment` (safe; nothing
  outside S106 reads it). No reservation data is touched by either direction, so
  rollback is non-destructive. The down-migration is prepared only if/when the
  owner approves applying S106.

## 5. CI — "Production adoption dry run" (disposable PostgreSQL 17) is RED

Investigated per the owner's request. **It is a pre-existing baseline failure,
unrelated to this PR**, and must not be worked around by weakening a test.

Evidence (both runs on a disposable local PostgreSQL, same harness as CI):

- On this branch (with S106) the `verify_production_adoption_dry_run.sh` step
  fails with:
  `security_lint_blockers: ['adjust_inventory is not a caller-evaluated manager-only RPC']`,
  `controlled_adjustment.adjust_inventory_safe: false`.
- On a clean `origin/main` worktree (no S106) the **identical** assertion fails
  with the **same** blocker and fingerprint.

The failure is in the Phase-1 production-adoption security lint for the
`adjust_inventory` RPC — a path S106 does not touch (bookings add no
`adjust_inventory`, no purchase-order, no inventory-movement code). The dry-run
only *runs* on this PR because it watches `supabase/migrations/**`; S106 does not
cause the red. The required gates for this PR — `contracts` and `replay` — are
green. Fixing the pre-existing `adjust_inventory` lint is out of scope for the
bookings work and left for a separate change unless the owner directs otherwise.
