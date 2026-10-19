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
| `atlas-team-profiles/index.ts` `invitationStatuses` | `admin.auth.admin.listUsers` paged 20×200 | **up to ~20 Auth list HTTP requests, scanning up to ~4,000 user records**, every manager snapshot (note: records scanned ≠ HTTP requests) |

The unread badge is a *secondary* indicator: the Messages view, when open, keeps
its own faster (~6s) snapshot and this worker reuses it, and `atlas-chrome` badges
are already event-driven via the `messages:unread` shell event. So neither needs a
high background cadence to stay correct.

## After

| Source | Change | Rate (after) | Reduction |
| --- | --- | --- | --- |
| `team-unread-badge.js` | `POLL_MS` 8000 → **30000**, with a bounded fast warm-up and failure backoff | **120 req/hour** per visible tab (steady state) | **−73%** (≈330 fewer req/hr/tab) |
| `atlas-chrome.js` | reconcile timer 2500 → **15000** ms | **240 wakeups/hour** | **−83%** (≈1,200 fewer wakeups/hr) |
| `invitationStatuses` (PR #128) | `listUsers` scan → targeted `getUserById` over inactive profiles only; hard cap 100, concurrency 8, per-request 2s / total 4s time-box, newest-first | **≤1 HTTP request per inactive candidate** (typically a handful); never > 100; scales with unconfirmed invites, not the user base | from ~20 list requests over ~4,000 records → **a handful of targeted reads** |

### Measured (reproducible, not interval math)

Counted with the browser harness request recorder under controlled timers
(`page.clock` + `advanceTimers`), on `#dashboard` where the Messages page is
closed so every `atlas-team-messages` snapshot request is the badge's own. Rerun
by launching the badge on `#dashboard` and advancing the clock.

| Scenario | Before (`main` @ e14ccf6, 8s poll) | After (perf branch) |
| --- | --- | --- |
| Healthy API, 60 s window | **6** badge snapshot requests | **3** |
| Failing API (503), first 5 s | 1 | **2** (≤ 3 storm limit; the pre-fix warm-up sent 4) |
| Failing API (503), first 30 s | 3 | **3** (bounded by backoff; no storm) |

The 60 s healthy count roughly halves, and the gap widens over time (steady state
adds one request per 30 s vs one per 8 s). The failing-API counts show the fix:
equivalent to `main` over the storm window, where the un-backed-off warm-up had
briefly sent 4 requests in 5 s and tripped `runtime.browser.test.mjs`.

For the invitation lookup, the node tests measure the Auth-read count directly:
150 inactive profiles with `ATLAS_INVITE_LOOKUP_CAP=500` ⇒ exactly **100**
`getUserById` calls (hard cap holds); `=10` ⇒ **10**; concurrency never exceeds
**8** in flight; a hung read is abandoned at the 2 s per-request timeout without
blocking the rest.

### Why this is safe (no behavior change)
- **Unread badge:** the count stays "live enough" for a badge at 30s; the poll
  still pauses when the tab is hidden (`visibilitychange` → `stopPolling`),
  refreshes immediately on `focus`/`online`/`SIGNED_IN`, and defers to the open
  Messages snapshot. Live updates inside Messages are unchanged. A bounded fast
  warm-up (2s, only while no snapshot has loaded and no request has failed)
  restores a prompt first populate after sign-in; on an actual API failure the
  poll backs off (8s → 16s → 30s) instead of looping, so a down API is never hit
  in a tight storm.
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
- The manager directory no longer scans up to ~4,000 Auth user records (~20 list
  HTTP requests) per snapshot; it now issues at most one targeted read per inactive
  candidate (hard-capped at 100, concurrency 8, time-boxed), scaling with the small
  number of unconfirmed invites rather than the total user base.
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
- `tests/browser/unread-badge.browser.test.mjs` (new) → healthy initialization,
  backoff-under-failure (no storm), and recovery-on-heal.
- `tests/browser/runtime.browser.test.mjs` → the "does not retry in a loop while
  its API is failing" request-storm regression passes again (the warm-up backoff
  fix); the existing test was not relaxed.
- PR #128: `tests/node/team-invitation-lookup-s128.test.js` (new) → hard cap,
  concurrency bound, timeout isolation, recency prioritization, label correctness.
- Python contracts: unchanged by this branch (no edge-function or contract files
  touched here). The one local `test_sprint1_inventory` loader error is a
  pre-existing local `pdfplumber`/`pyo3` import panic, present on `main` too and
  absent in CI.

## Coordinated change (not in this PR)
`invitationStatuses` is part of the Employee Management feature, which lives on
PR #128 (`claude/employee-management`). To avoid duplicating that code, the
invitation-scan optimization was committed there, kept as a **draft** pending the
owner's approval to merge/deploy #128.
