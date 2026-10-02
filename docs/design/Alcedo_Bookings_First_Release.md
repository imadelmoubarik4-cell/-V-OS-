# Alcedo Bookings — First Release Design (for review)

Status: **Draft for review. Not implemented. No production system changed.**

This document turns the Alcedo Bookings brief into a concrete engineering design
for the first release: table/area configuration, a staff booking workspace, an
embeddable website booking form sharing one authoritative availability service,
and a provider‑independent path for Dineout and other channels. It reuses the
existing app conventions (Supabase Postgres + RLS, edge functions, the
`atlas-*` frontend modules, per‑venue scoping and time zones, the `integrations`
registry) and preserves all internal identifiers.

Delivery is gated: per the brief, step 1 (finish + review the current Alcedo UI)
must land first — that is PR #113, still under review. Nothing here begins until
the owner approves and supplies the data listed in *Decisions before
implementation*.

---

## 1. Scope

**In the first release**
- Per‑venue configuration of areas, tables (number/label + seat capacity),
  permitted table combinations, and temporarily‑unavailable tables.
- Staff workspace: Today view, calendar, table timeline, reservation details
  panel; add phone bookings and walk‑ins; assign/move tables; update arrival
  status.
- One authoritative availability + reservation service shared by staff and web.
- Embeddable Alcedo website booking form.
- Booking reference on screen, email confirmations (when an email is supplied),
  and staff notifications for new/changed reservations.
- Visual floor plan with sections, colours, table numbers and status; plus a
  list alternative with text status labels.

**Explicitly out of the first release** (per brief)
- Payments, deposits, POS bill linking, promotional campaigns.
- SMS delivery (a later step, after a provider is selected).
- Automatic external‑provider synchronisation (only after documentation and
  account access are verified).

---

## 2. Current‑state audit (what exists today)

- **No bookings/reservations module exists** in the app. The only trace is a
  `dineout` connector seeded in the `integrations` registry as
  `not_connected` with metadata `"Dineout bookings are not connected to Atlas
  runtime."` (`supabase/migrations/…checkpoint_i.sql`;
  `supabase/functions/atlas-phase3-intelligence/index.ts`). So Dineout is a
  known‑but‑unconnected channel, consistent with the brief.
- **Reusable foundations already in the codebase**: per‑venue data + RLS with
  `private.is_active_staff()` / role checks; edge functions under
  `supabase/functions/*` with the `_shared/auth.mjs` actor/resolver pattern;
  venue settings + time‑zone handling; the notifications surface; the IIFE
  frontend modules (`window.Atlas*`) + `atlas-tokens.css` design system + the
  `node --test` harness.
- Implication: Bookings is greenfield **inside** the app but should be built on
  these existing primitives, not new infrastructure.

---

## 3. Data model (proposed)

All tables are per‑venue and RLS‑scoped. Names are proposals; final names follow
the repo's existing conventions at implementation. **No seat counts, table
numbers, combinations, durations or thresholds are invented here** — they are
owner inputs (see §12).

- `booking_areas` — id, venue_id, name, **section_colour** (from the brand
  palette), display_order. Seeds for VÁ pilot: Wine cellar, Ocean, Long table
  (proposed labels only).
- `booking_tables` — id, venue_id, area_id, **table_number/label** (unique per
  venue), seat_capacity, min_party?, is_bookable, temporarily_unavailable
  (bool + optional window), floor position (x, y, shape) for the map.
- `booking_table_combinations` — id, venue_id, member table_ids[], combined
  capacity, is_permitted. Only listed combinations may be auto‑assigned.
- `reservations` — id, venue_id, source (`web` | `phone` | `walk_in` |
  `dineout` | …), status (see §5), date, start_time, expected_end_time,
  party_size, guest_name, **guest_phone**, **guest_email**, guest_requests,
  **staff_notes** (private), booking_reference (public), provider_ref
  (nullable), created_by, timestamps, time zone resolved from the venue.
- `reservation_tables` — reservation_id → table_id (or a combination), the
  **internal** allocation even when the guest never sees a table number.
- `reservation_status_history` — reservation_id, from_status, to_status,
  changed_by, changed_at, note. Satisfies "who changed what, when".
- `booking_holds` — explicit, short‑lived, **expiring** holds (staff hold or
  in‑flight web request) so requests awaiting approval never silently block
  tables.
- Availability rules live in **venue settings** (not a per‑row table): booking
  hours, holiday exceptions, booking intervals, duration by party size,
  turnaround buffer, last bookable start time, advance‑booking limit, and the
  party‑size / request‑type thresholds that require staff approval.

---

## 4. Availability & concurrency (the core correctness requirement)

- **One authoritative schedule.** Every channel (staff, web form, future
  providers) calls the same availability + reservation service. No separate
  pools.
- **Atomic check‑and‑reserve on the server.** Availability check and allocation
  happen inside a single Postgres transaction that takes a row/advisory lock on
  the affected table(s)/time window, re‑reads current reservations and holds,
  and only then inserts the allocation. Two concurrent attempts for the same
  table+time therefore cannot both confirm — the second sees the first's
  committed allocation (or hold) and is rejected. (Implementation via
  `SELECT … FOR UPDATE` over the candidate tables + a serializable/locked path,
  or a transactional advisory lock keyed by venue+table+slot.)
- **Enforced constraints** for both staff and web: seat capacity, permitted
  combinations, booking hours, duration by party size, turnaround buffer,
  last‑start, advance limit.
- **A confirmed booking always reserves a specific table or a valid configured
  combination internally**, even when the guest is not shown a table number.
- **Holds are explicit and expire**; cancelled reservations release their
  allocation immediately; requests awaiting approval do not block tables beyond
  an explicit expiring hold.
- **Idempotency.** Repeated form submissions or integration events carry an
  idempotency key / provider_ref and **update the original reservation** rather
  than creating duplicates.
- Staff table moves use the **same** conflict checks as web bookings.

---

## 5. Status model

`requested → confirmed → arrived → seated → completed`, plus `cancelled` and
`no_show`. **`requested` and `confirmed` are visibly and semantically distinct**:
a requested booking has *no guaranteed allocation the guest can rely on* and must
**never** be shown as confirmed anywhere (screen, email, or the guest's booking
link). Ordinary reservations may auto‑confirm under the venue's configured rules;
large groups / special requests stay `requested` until staff confirm suitable
capacity. Every transition writes to `reservation_status_history`.

---

## 6. Permissions, privacy & multi‑venue

- **Venue isolation:** RLS ensures one venue cannot read or change another
  venue's bookings, tables, or settings.
- **Guest contact + staff notes are restricted** to authorised staff of the
  correct venue. They are **never** returned by the public availability/booking
  endpoints or the guest booking‑link view.
- **Walk‑ins** require no unnecessary guest data. **Online bookings** require a
  name and at least one contact method.
- **Roles:** managers configure areas/tables/rules; authorised service staff
  manage reservations and arrivals within their venue. Reuses the existing
  role/`is_active_staff` model.
- **History/audit** retained for every change (who + when).

---

## 7. Server API (edge functions, proposed)

Built on the existing `supabase/functions/*` + `_shared/auth.mjs` pattern.

- **Public (no PII in, minimal out):**
  - `GET availability` — venue, party size, date → bookable time slots. Returns
    only slot availability, never table numbers, other guests' data, or notes.
  - `POST booking` — party size, date, time, guest name + contact, requests →
    runs the atomic check‑and‑reserve; returns the exact result (confirmed vs
    requested) + a booking reference. Idempotent per submission key.
  - `GET/POST booking-link` — a private, unguessable link lets the guest view,
    cancel, or request a change; **changes recheck availability** before taking
    effect. Exposes only that guest's own booking.
- **Staff (authenticated, venue‑scoped):** list/detail reservations, create
  phone/walk‑in, assign/move tables, change status, manage holds, configure
  areas/tables/combinations/rules. All mutations reuse the shared availability
  service and write history.
- **Integration intake (guarded, later):** provider webhook/event endpoint that
  maps provider_ref → reservation with idempotent upsert and records
  failed/delayed sync for reconciliation.

---

## 8. Website booking flow (matches the brief)

1. Guest picks party size, date, time on the restaurant website (embedded Alcedo
   form).
2. Server checks booking hours, capacities, duration, turnaround buffer and
   current reservations.
3. Saved only if suitable capacity can still be reserved; ordinary bookings may
   auto‑confirm per venue rules, large/special go to staff as `requested`.
4. Guest sees the exact result + reference. **A requested booking is never shown
   as confirmed.**
5. Staff calendar + table timeline update; the applicable notification is sent.
6. Private booking link allows cancel/change; changes recheck availability.

---

## 9. Notifications

- Booking **reference shown on screen** always.
- **Email confirmation** when an email is supplied; **staff notification** on new
  or changed reservations (reuses the existing notifications surface).
- **SMS is deferred** until a provider is chosen.
- **Delivery is decoupled from the saved booking:** a notification failure never
  erases a saved booking and never causes a duplicate on retry; failed/delayed
  deliveries are visible to staff and retryable.

---

## 10. Floor plan & staff UI

- **Visual floor plan** grouped into section labels (e.g. Bar, Main dining,
  Window/terrace, Private dining, Outdoor — venue‑configurable), each table with
  a **unique visible number** and a **consistent section colour** reused on the
  booking screen for fast scanning.
- **Table status indicators:** available / booked / seated / unavailable, with
  **text status labels** (not colour alone).
- **Easy reassignment** (drag or select‑and‑move) using the same conflict checks.
- **A list alternative** to the map conveying the same information; **keyboard
  controls**; **reduced‑motion** support; a **usable phone layout**; compact,
  legible during service.
- **Brand system:** teal / ivory / sage surfaces, restrained orange actions,
  readable typography, subtle borders (the Alcedo design system from PR #113).

---

## 11. Dineout & other channels (provider‑independent)

- VÁ BAR's existing **Dineout workflow stays supported during transition**.
- **Synchronisation is treated as unverified** until Dineout's API docs, event
  delivery and permissions are confirmed with account access. Embedding a
  Dineout form on a website does **not** put those bookings into Alcedo.
- **Single online authority:** before running two online channels at once, decide
  which system owns availability, table assignments, edits, cancellations and
  guest notifications. Without verified sync, keep **one** online booking
  authority — not two pools selling the same seats.
- A verified integration will retain **provider reservation IDs**, handle repeated
  events **without duplication**, surface **failed/delayed** sync, and reconcile
  missed changes. The module stays independent of any single provider.

---

## 12. VÁ BAR pilot

- Time zone **Atlantic/Reykjavik**.
- Proposed area labels reused from the current workflow: **Wine cellar, Ocean,
  Long table** (labels only).
- Pilot runs on real configuration only **after owner approval**.

### 12.1 Owner-supplied reference (current system — to confirm)

The owner shared the current VÁ floor-plan designer + table list. Captured here
as the pilot's source data; **treated as reference to confirm, not final**:

- One room shown, **"VÁ"** (the "Select room" dropdown implies other rooms may
  exist).
- **16 tables named Bar 1 – Bar 16**, arranged around the room **perimeter** (a
  row along the top, columns down both sides) — a bar‑seating layout.
- Each table currently shows **Name "1"** and **Min/Max guests mostly 1/1**
  (single bar seats), with a **"Block online"** flag and a **priority** selector
  per table.

**Owner clarifications received:**
- The tables are **single bar stools** — one seat each.
- **Bar 6** = **Min 0 / Max 1** (min 0 = no minimum; corrects the earlier
  Min 2/Max 1 misread).
- **Other rooms exist for the VÁ location** — the room dropdown is real; Bar is
  one room of several.
- **2 Oct 2026 floor-plan screenshot confirms the VÁ room geometry:** 16 individual
  table/stool positions around the perimeter of one rectangular room, with
  **8 positions across the top, 4 down the left side, and 4 down the right side**;
  the centre remains open.
- **Owner confirmed the numbering order on 2 Oct 2026:** **Bar 1 is the top-left
  position and Bar 1 → Bar 16 continue clockwise**. Therefore the coordinate
  mapping is: **Bar 1–8 left-to-right across the top; Bar 9–12 top-to-bottom down
  the right side; Bar 13–16 bottom-to-top up the left side**. This numbering and
  geometry are now approved source data for the VÁ Bar room.

**Owner clarification — 2 Oct 2026: non-Bar booking locations are location-level, not table-level.**
For **Wine cellar, Ocean and Long table**, Alcedo does **not** need a floor/table map.
A booking for one of these locations only needs:
- **Location**
- **Guests: 0–30**
- **Time**
- **Name of the person**

The **Bar** remains the only seat-level area, using the confirmed Bar 1–Bar 16
clockwise layout. Non-Bar locations should therefore be represented as
location-level booking resources rather than invented tables.

**Owner confirmation — 2 Oct 2026: shared-capacity location bookings are allowed.**
**Wine cellar, Ocean and Long table may each hold multiple bookings at the same
time**, provided the combined guest count for overlapping bookings in that
location does **not exceed 30**. These are therefore pooled-capacity booking
locations, not exclusive table allocations. Their configured minimum is **0**
(no minimum) and maximum/capacity is **30**; an actual reservation still records
a positive guest count.

**Owner confirmation — 2 Oct 2026: adjacent Bar stools may be grouped.**
Bar 1–Bar 16 are single-seat stools, and **adjacent stools may be combined for
larger parties**. Grouping must follow the confirmed physical clockwise layout;
Alcedo must never combine non-adjacent stools automatically. The exact maximum
number of stools allowed in one grouped Bar booking is still owner-configurable
and must not be invented.

**Owner confirmation — 2 Oct 2026: Bar grouping may use the full bar.**
A Bar booking may combine **any contiguous run of adjacent stools up to all 16
Bar seats**. The grouping engine must preserve physical adjacency and may wrap
across the Bar 16 ↔ Bar 1 boundary because the confirmed layout is one continuous
clockwise perimeter.

**Still to confirm before real production activation:**
1. Per-Bar-seat **priority** meaning and the **Block online** defaults.

A test‑data **floor‑plan Designer prototype** on the Alcedo brand system (rooms,
colour‑coded tables by section, unique numbers, seat capacity, status indicators,
block‑online, drag‑to‑move, plus a list alternative) has been built for review,
seeded with this VÁ layout as **test data only** — no production system or real
pilot data is wired.

---

## 13. Acceptance checks → how the design meets them

| Brief acceptance check | Mechanism |
| - | - |
| Web booking appears once in the right venue's calendar with allocation + guest details | Single service writes one reservation + `reservation_tables`; venue‑scoped RLS; idempotency key prevents duplicates |
| Two concurrent same‑table/time attempts can't both confirm | Atomic locked check‑and‑reserve in one transaction (§4) |
| Capacity, combinations, hours, duration, buffers enforced for staff + web | Shared availability service used by every channel (§4, §7) |
| Large group stays requested until staff confirm | Status model + approval thresholds (§5) |
| Move/cancel/repeat preserves availability + history | Same conflict checks on moves; cancel releases allocation; idempotent upsert; status history (§4–§6) |
| Notification failure doesn't erase/duplicate; staff can retry | Delivery decoupled from save; failed deliveries visible + retryable (§9) |
| Public callers can't get other guests' contacts/notes; venue isolation | Public endpoints omit PII; RLS venue scoping (§6–§7) |
| Phone, keyboard, reduced‑motion; map + list parity | UI requirements (§10) |
| Existing auth/messaging/inventory/purchasing/AI regressions still pass | Build on existing primitives; run full regression suite before/after each step |

---

## 14. Delivery order (per brief)

1. **Finish + review the current Alcedo UI** — PR #113 (in review).
2. Audit existing booking‑related code + permissions (done here), then build the
   **staff booking workspace + table configuration against test data**.
3. Connect the **Alcedo website form** to the same reservation/availability
   service, with confirmations + staff notifications.
4. Add **verified** external booking integrations + reminder delivery.
5. **Pilot with VÁ BAR's real table configuration after owner approval.**

Each step ends with the full `node --test` (+ SQL/browser) suites green,
including the existing auth/messaging/inventory/purchasing/AI regressions.

---

## 15. Decisions before implementation (owner inputs needed)

Nothing below is invented; implementation is blocked until these are supplied:

1. **Table list & capacities** — every table's number/label + seat count.
2. **Areas** — final section names + which tables belong to each.
3. **Permitted table combinations** — which tables may be joined, and combined
   capacity.
4. **Booking durations by party size**, **turnaround buffer**, booking
   **intervals**, **last bookable start**, **advance‑booking limit**.
5. **Approval threshold** — party size / conditions that force `requested`.
6. **Booking hours + holiday exceptions** (VÁ time zone Atlantic/Reykjavik).
7. **Online authority decision** — does VÁ BAR keep **Dineout** as the online
   booking authority initially, or move to the **Alcedo form**? (Two live online
   pools are not enabled without verified sync.)
8. **Dineout integration documentation + account access** — required before any
   automatic synchronisation is promised.

Out of first‑release scope (confirmed): payments, deposits, POS bill linking,
promotional campaigns.

---

*This is a design for review only. No migrations, edge functions, or frontend
code have been written for Bookings, and no production system has been changed.*
