# ALCEDO — Option C Performance Optimization (background requests & cost)

**Branch:** `claude/perf-optimization` · **Base:** `main` @ `e14ccf6` (post-S105)
**Scope of this PR:** steady-state background work (timers / polling / Supabase
requests). The expensive team invitation lookup is addressed separately on the
Employee Management branch (PR #128) to avoid duplicating that feature's code —
see "Coordinated change" below.

Nothing here weakens authentication, RLS, audit trails, or any security control,
and no multi-tenancy is introduced. All changes are behavior-preserving: the same
data refreshes, just less wastefully.

---

## Baseline (before)

Measured by reading the shipped sources on `main`:

| Source | Mechanism | Rate (before) |
| --- | --- | --- |
| `team-unread-badge.js` | `POLL_MS = 8000` → authenticated `snapshot` fetch to the Messages edge function, app-wide while signed in | **1 request / 8s ≈ 450 req/hour** per visible tab |
| `atlas-chrome.js` | `state.pollTimer = setInterval(…, 2500)` → `syncBadges()` + read `AtlasSettings` snapshot | **1 wakeup / 2.5s ≈ 1,440 wakeups/hour** (no network) |
| `atlas-team-profiles/index.ts` `invitationStatuses` | `admin.auth.admin.listUsers` paged 20×200 | **up to 4,000 Auth reads per manager snapshot** |

The unread badge is a *secondary* indicator: the Messages view, when open, keeps
its own faster (~6s) snapshot and this worker reuses it, and `atlas-chrome` badges
are already event-driven via the `messages:unread` shell event. So neither needs a
high background cadence to stay correct.

## After

| Source | Change | Rate (after) | Reduction |
| --- | --- | --- | --- |
| `team-unread-badge.js` | `POLL_MS` 8000 → **30000** | **120 req/hour** per visible tab | **−73%** (≈330 fewer req/hr/tab) |
| `atlas-chrome.js` | reconcile timer 2500 → **15000** ms | **240 wakeups/hour** | **−83%** (≈1,200 fewer wakeups/hr) |
| `invitationStatuses` (PR #128) | scan → bounded `getUserById` over inactive profiles only, capped at 100 | typically **0–handful of reads**; hard cap 100 | from up to 4,000 → **≤ inactive-profile count** |

### Why this is safe (no behavior change)
- **Unread badge:** the count stays "live enough" for a badge at 30s; the poll
  still pauses when the tab is hidden (`visibilitychange` → `stopPolling`),
  refreshes immediately on `focus`/`online`/`SIGNED_IN`, and defers to the open
  Messages snapshot. Live updates inside Messages are unchanged.
- **Chrome reconcile timer:** badges are driven by the `messages:unread` event, so
  the interval is only a cheap safety net plus picking up a Settings venue-name
  edit. At 15s a venue rename still appears within 15s; it early-returns while the
  tab is hidden and makes **no network request**.
- **Invitation lookup:** only unconfirmed accounts can be live invites, and invited
  accounts are created `active = false` and flip to `active = true` on
  confirmation — so the candidate set is exactly the inactive profiles already
  loaded for the snapshot. The directory renders pills only for `pending`/`expired`,
  so the never-rendered `accepted` status is simply not emitted. Same pills, same UI.

## Cost impact (indicative)
- Fewer authenticated edge invocations: an idle signed-in tab drops from ~450 to
  ~120 Messages-snapshot calls/hour — a ~73% cut in that call volume (and the
  Supabase/Postgres reads behind it) for the most common steady state.
- The manager directory no longer makes up to 4,000 Auth Admin API reads per
  snapshot; it now scales with the (small) number of unconfirmed invites, not the
  total user base.
- `atlas-chrome`'s timer reduction is CPU/wakeup only (no network) but matters for
  battery and background-tab throttling behavior.

## What was investigated and deferred
Initial-load JS payload (~2.47 MB eager at boot) and lazy-loading the heavy
workspace modules were investigated. The `index.html` script list and
`config.js` deferred-load list are **contract-pinned** (`shell-contract-s88`),
so restructuring them is a larger, contract-touching change and is intentionally
**not** in this focused PR. It is recommended as a separate follow-up so the
contract update and the load reordering can be reviewed together. No partial /
risky load change was shipped here.

## Verification
- `node --test tests/node/*.test.js` → 1601 pass, 0 fail, 42 skipped.
- `tests/node/team-unread-badge.test.js` → updated `POLL_MS` pin (30000); all
  behavioral assertions (snapshot action, visibility/focus/auth guards, no badge
  markup, authenticated-API-only) unchanged and passing.
- Python contracts: unchanged by this branch (no edge-function or contract files
  touched here). The one local `test_sprint1_inventory` loader error is a
  pre-existing local `pdfplumber`/`pyo3` import panic, present on `main` too and
  absent in CI.

## Coordinated change (not in this PR)
`invitationStatuses` is part of the Employee Management feature, which lives on
PR #128 (`claude/employee-management`). To avoid duplicating that code, the
invitation-scan optimization was committed there, kept as a **draft** pending the
owner's approval to merge/deploy #128.
