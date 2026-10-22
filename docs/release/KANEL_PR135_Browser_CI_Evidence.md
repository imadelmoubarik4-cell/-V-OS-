# PR #135 — browser CI failures: regression or baseline? (evidence)

Question: are the unresolved browser CI failures on PR #135 caused by the PR?
Method: compare failing assertions with (a) `main` CI runs from before PR #135
existed, (b) PR runs on different commits with identical code under test, and (c) the
PR diff. No test was changed, skipped, retried or loosened to get these results.

## Authoritative results (GitHub CI, `browser` job)

| Head | Result | Failing tests |
|---|---|---|
| `81877a6` (owner-verified) | 444 passed, 2 failed, 1 skipped | `atlas-bot.browser.test.mjs:578` ("timeout waiting for success to return to idle"); `ux-acceptance.browser.test.mjs:69` (`#data` header top 1, expected 0) |
| `af98362` (docs-only change vs `81877a6`) | 2 failed | `atlas-bot.browser.test.mjs:578` (same); `home-operations.browser.test.mjs:207` (`1 !== 2`). **`ux-acceptance` passed.** |

`af98362` changed only Markdown. The code and tests the browser job runs are
byte-identical between the two heads, yet the set of failing tests differs.

Local results in this environment are **not** CI evidence and are not used here.

## Per-test findings

### 1. `atlas-bot.browser.test.mjs:578` — success → idle timeout — **baseline (pre-existing on `main`)**
- The same assertion fails on `main` CI at `6dea4ff`, `0babc4b` and `187f276`. Those
  commits predate PR #135 and do not contain any of its files.
- The PR does not touch `atlas-bot`, its test, or the shared shell code the test
  waits on. (The PR's `atlas-shell.js` change only adds the `#bookings/res/<id>`
  route.)
- The test waits for a timed success animation to return to idle, so the failure
  is timing-sensitive.
- **Conclusion: not a PR #135 regression.**

### 2. `ux-acceptance.browser.test.mjs:69` — header top offset 1 vs 0 — **baseline (pre-existing on `main`), non-deterministic**
- The same assertion fails on `main` CI at `ce4f1be` and `0babc4b`, there on
  `#reports/overview`.
- On the PR it failed once on `#data` (`81877a6`) and **passed** on `af98362` with
  identical code.
- A 1 px offset that comes and goes with identical code points to a layout-timing
  race (measuring before fonts or layout settle). The PR makes no change to
  `#data`, `#reports` or header CSS.
- **Conclusion: not a PR #135 regression.**

### 3. `home-operations.browser.test.mjs:207` — `1 !== 2` — **non-deterministic; no PR #135 cause found**
- It passed at `81877a6` and failed at `af98362`. The code under test is the same, so
  the PR's code cannot be what flips it.
- Likely mechanism, from reading the test: its `settle()` helper waits for a 50 ms
  quiet window. Two sequential storage writes can straddle that window, so the
  assertion sometimes sees the first write only (`1`) instead of both (`2`).
- **Limit of the evidence:** this failure was not seen in the `main` runs sampled,
  so it is not proven to be a `main` baseline. What is proven is that it is
  non-deterministic on identical code.
- The PR does not modify Home operations, its test or the storage helpers it uses.

## Other red check (not a browser test)

`disposable PostgreSQL 17` ("Production adoption dry run") fails with
`adjust_inventory is not a caller-evaluated manager-only RPC`. The **identical**
assertion fails on a clean `main` worktree without S106, so it is baseline
(`S106_Bookings_Engine_Production_Impact.md`). It only runs on this PR because the PR
touches `supabase/migrations/**`.

## What the PR does change in the browser surface

`apps/web/config.js` (two flags, both off), `bookings-notifications.js` (inert while
`BOOKING_NOTIFICATIONS_ENABLED:false`), `bookings-workspace.js` (floor grid
condition, two events, deep link), `atlas-shell.js` (one route), and
`service-worker.js` (bookings push route). Its own browser test,
`bookings-notifications.browser.test.mjs`, passes in CI.

## Recommendation

- Do **not** paper over these in PR #135. No retries, no skips, no larger
  tolerances.
- Fix them in a separate stabilisation PR off `main`, with deterministic waits:
  - `atlas-bot`: wait on the state transition event or attribute rather than a timer.
  - `ux-acceptance`: measure after `document.fonts.ready` plus two animation
    frames.
  - `home-operations`: wait for the expected write count rather than a quiet window.
  The assertions stay exactly as strict as they are now.
- Merge gate for PR #135: the owner accepts these documented failures as
  not caused by the PR, **or** waits for the stabilisation PR. Owner decision.
- Re-check browser CI on the final head before merging. The failing set has varied
  between runs.
