# PR #135 — browser CI failures: regression or baseline? (evidence)

Question: are the unresolved browser CI failures on PR #135 caused by the PR?
Note on wording: the browser workflow (`atlas-verify.yml`) runs on **pull requests
only**, never on pushes to `main`. "`main` evidence" below means CI runs of commits
that are now in `main`'s history (`6dea4ff`, `0babc4b`, `187f276`, `ce4f1be`, from
the `claude/employee-deletion` PR), plus runs of other branches that never contained
PR #135's code.

Method: compare failing assertions with (a) `main` CI runs from before PR #135
existed, (b) PR runs on different commits with identical code under test, and (c) the
PR diff. No test was changed, skipped, retried or loosened to get these results.

## Authoritative results (GitHub CI, `browser` job)

| Head | Result | Failing tests |
|---|---|---|
| `81877a6` (owner-verified) | 444 passed, 2 failed, 1 skipped | `atlas-bot.browser.test.mjs:578` ("timeout waiting for success to return to idle"); `ux-acceptance.browser.test.mjs:69` (`#data` header top 1, expected 0) |
| `af98362` (docs-only change vs `81877a6`) | 2 failed | `atlas-bot.browser.test.mjs:578` (same); `home-operations.browser.test.mjs:207` (`1 !== 2`). **`ux-acceptance` passed.** |
| `b26b82e` (release tooling + docs; app code unchanged) | 445 passed, 1 failed, 1 skipped | `ux-acceptance.browser.test.mjs:69` (`#data` header top 1, expected 0). **`atlas-bot` and `home-operations` passed.** |

**Release exception (owner decision, 22 Oct 2026):** the remaining
`ux-acceptance:69` failure is accepted as an identified release exception, on the
evidence that it fails on earlier `main` commits. This does not permit weakening the
test, and it is not approval to merge.

`af98362` changed only Markdown, and `b26b82e` changed only release SQL, scripts,
the replay workflow and docs. The code and tests the browser job runs are
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

## Update — `a788bf7` (23 Oct 2026): three `atlas-bot` failures

`a788bf7`: 447 tests, 443 pass, **3 fail**, 1 skip. All three failures are in
`tests/browser/atlas-bot.browser.test.mjs`, the live WebGL robot:

| Test | Error at `a788bf7` |
|---|---|
| `:85` live 3D robot draws, greets, follows, reacts | `page.screenshot: Timeout 10000ms exceeded` |
| `:368` WebGL context lost → restored | `Timed out waiting for the robot is drawn again after the restore` |
| `:734` answering never restarts | `it kept moving` (frame counter did not advance during 30 animation frames) |

### Evidence

1. **Identical code passes.** Between `b26b82e` and `a788bf7` only `docs/` changed.
   Browser CI on the same app and test code had a **fully green** browser job at
   `54491e9` (started 15 s before `a788bf7`; differs by one Markdown line),
   `6a1904c`, `2ae1d7f`, `98d59b2` and `a67364e`. Other runs on this code failed
   only `atlas-bot:578` (`3ea337a`, `7d06828`) or `ux-acceptance:69` (`b26b82e`).
2. **The PR does not touch this code.** PR #135 changes no atlas-bot code and no
   atlas-bot test. Its only shared-test change (`harness.mjs` `configOverrides`) is
   inert unless a test passes it, and atlas-bot never does.
3. **History of the same tests before PR #135** (19 CI logs; two rows re-verified by
   hand against the raw logs):

| Test | Failed before PR #135 (no PR #135 code) |
|---|---|
| `atlas-bot:85` | `0babc4b` (in `main` history), `b25363a` |
| `atlas-bot:368` | `b853fe0`, `3d3b6ec`, `4fc4b8c`, `b15bfb1` |
| `atlas-bot:734` | **not seen** in the 19 sampled runs |

   The atlas-bot suite as a whole fails intermittently across branches: lines 85,
   156, 264, 368, 488, 520, 578, 690 and 734 each fail in some runs, always as
   timeouts or frame/timing assertions in the WebGL render loop.
4. **Local repetition** (headless Chromium, the three tests only, 10 runs each):
   `main` `e14ccf6` **30/30 pass**; PR head `a788bf7` **30/30 pass**.

### Classification

- `atlas-bot:85` and `:368`: **demonstrated existing instability** (recorded by
  owner decision, 23 Oct 2026). They fail the same way on code without PR #135.
- `atlas-bot:734`: **intermittent, no regression identified, not proven pre-existing** (recorded by owner decision, 23 Oct 2026).
  It passes on `main` and the PR head locally (10/10 each) and in CI on five other
  heads with the same code, and the PR does not touch it. **Limit:** it has not been
  observed failing before PR #135, so it is **not proven** to be a pre-existing
  failure. It belongs to the same timing-sensitive WebGL suite as the proven ones.
- None of these is covered by the `ux-acceptance:69` exception. Each needs its own
  owner decision.

### Production-adoption dry run at `a788bf7`

Same blocker as documented: `security_lint_blockers: ['adjust_inventory is not a
caller-evaluated manager-only RPC']`, `controlled_adjustment.adjust_inventory_safe:
false`. It also fails on a clean `main` (S106 impact doc). This is the baseline issue.
