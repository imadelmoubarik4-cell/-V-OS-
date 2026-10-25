# A4 functional blocker — staff cannot choose or move multi-stool seating (23 Oct 2026)

**Status (23 Oct 2026): correction IMPLEMENTED on the draft branch** (S110 + staff UI; see [`KANEL_S110_Seat_Integrity_Impact.md`](KANEL_S110_Seat_Integrity_Impact.md)). **Not applied to production, not merged, not deployed.** The original finding follows. Raised by
the owner's review of the A4 script. Verified from the code and by a probe of the S109
functions on a local S109 database, inside a transaction that was rolled back.
Production runs the same function bodies: 17/17 release functions match the
CI-tested S109 build, and `atlas_bookings_create` is unchanged since S103.

## Findings

### Staff UI (`apps/web/assets/js/bookings-workspace.js`, deployed today from `main`; PR #135 does not change this)

| Control | What it can do | Effect for a party of 2–4 at the Bar (16 stools × 1 seat) |
|---|---|---|
| New booking → "Specific Bar seat" (`#bk-add-table`) | **one** stool (`body.table_ids = [tableId]`) | Choosing a stool for a party of 2 is refused ("Choose enough seats for this party"). Specific stools **cannot** be chosen. |
| New booking → "Auto-assign adjacent seats" (default) | the server picks stools | **Works.** The S106 finder picks N adjacent stools inside one section (probe: party 2 got Bar 1 + Bar 2, 120 min). Staff can't choose which ones. |
| Detail → Move (`[data-bookings-assign-select]`) | **one** stool (`assignTable(id, [value])`) | A party of 2–4 **cannot** be moved to a group. Moving it to one stool is **accepted** by the server (see B1), leaving the party on fewer seats than guests. |
| Time field | `type="time" step="900"` | 15-minute steps, so the old 20:05 step was invalid. |

### Backend (S109 in production)

| # | Rule | Create, explicit stools | Create, auto-assign | Assign / Move |
|---|---|---|---|---|
| B1 | Allocated seats ≥ party size | ✅ enforced | ✅ | ❌ **not enforced**: probe moved a party of 2 to Bar 16 alone and it was accepted |
| B2 | One adjacent group within one section (S106) | ❌ **not enforced**: Bar 8+9 and gapped Bar 11+13 were accepted | ✅ | ✅ (Bar 8+9 refused) |
| B3 | 15-min turnaround | ✅ (18:00 after 16:00–18:00 refused; 18:15 accepted) | ✅ | ✅ |
| B4 | Same location | ✅ | ✅ | not checked (all stools are in the Bar today) |

**Origin:** B1 and B2 are **not regressions from PR #135.** The S105 assign (restored
by the rollback) also has no capacity check, and the explicit-stool create path has
not changed since S103. But S106's approved rule ("multi-stool never crosses a
section") is only partly enforced: it is missing on the explicit create path. Today
that path can only be reached through the API, because the UI sends at most one
stool.

**Conclusion:** the A4 steps "assign Bar 3+4", "Bar 8+9 refused" and "Bar 5+6
accepted" **cannot be performed in the deployed UI.** This is an **A4 functional
blocker**, not a test the owner should attempt.

## Proposed smallest safe correction (needs approval before any change)

### 1. Database: S110 `s110_booking_seat_integrity` (two `CREATE OR REPLACE`, grants unchanged)
- `public.atlas_bookings_assign`: after the section check, refuse unless every stool
  is in the reservation's area and `sum(seat_capacity) >= party_size` ("Choose enough
  seats for this party."). Pooled areas are unaffected; they have no stools.
- `public.atlas_bookings_create`, explicit-stool path: when more than one stool is
  given, apply `booking_tables_contiguous_segment` (same message as assign). The
  existing capacity, area and turnaround checks stay.
- No table, column, grant or data change. Rollback: `KANEL_S110_rollback.sql`,
  generated the same way as S106–S109 (restores both S109 bodies), proven in the
  replay gate.

### 2. Staff UI: `bookings-workspace.js` only
- New booking: replace the single "Specific Bar seat" select with an optional
  **"Choose seats"** checkbox group of free stools for the chosen location.
  "Auto-assign adjacent seats" stays the default. If any stools are ticked, send
  all of them as `table_ids`.
- Move: replace the single select with the same checkbox group, current stools
  pre-ticked. **Save seats** sends all ticked stools.
- Client hint only (the server stays the authority): with fewer seats than guests,
  show the inline error "Choose at least N seats" and send nothing. Server refusals
  (section, adjacency, turnaround, taken) show their existing message in the sheet.
- 44 px touch targets and keyboard operation, as in the rest of the workspace. No
  new endpoint and no flag.

### 3. Automated tests (none weakened)
- **SQL** `tests/sql/s110_booking_seat_integrity.sql` + `scripts/verify_s110_*.sh`,
  added to the replay gate. It checks:
  - a party of 2 assigned to 1 stool is refused; 2 adjacent stools in a section are
    accepted;
  - explicit create with Bar 8+9 or a gapped Bar 11+13 is refused; Bar 3+4 is
    accepted;
  - 18:00 after a 16:00–18:00 booking is refused, 18:15 is accepted;
  - non-staff are denied; anon cannot execute;
  - existing S99/S106–S109 acceptances still pass.
- **Browser** `bookings.browser.test.mjs` (mocked backend), new cases:
  - New booking with Bar 3+4 ticked sends `table_ids` with both ids;
  - a party of 2 with one stool ticked shows the inline error and sends no request;
  - Move pre-ticks the current stools and sends Bar 5+6;
  - a mocked 400 (cross-section) shows the server message and keeps the sheet open;
  - auto-assign (nothing ticked) sends no `table_ids`;
  - phone 390 px: no sideways scroll, 44 px targets.
- **Contracts:** S42 pin unaffected (config.js unchanged); the release-tooling
  contract is extended to the S110 bundle and rollback.

### Release order (each step separately approved)
1. Implement in PR #135 (draft) and get CI green, apart from the documented exceptions.
2. A3b: apply the S110 bundle (guarded, one transaction), then read-only checks.
3. A4 staff test (revised, below) on the corrected UI. This needs A5, because the UI
   ships on merge. Before that, only the database part of A4 can be verified.

Alternative, if you prefer not to widen PR #135: S110 plus the UI change in a
separate PR merged straight after PR #135. A4 then waits for both.
