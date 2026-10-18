# ALCEDO — Bug Audit

**Date:** 2026-10-18 · **Branch:** `claude/cleanup-audit` · **Baseline:** `main` @ `8cde4a7`
**Scope:** genuine Alcedo application bugs, reproduced with evidence. QuixBugs `bug-report.md` is a *separate* project (QuixBugs `python_programs`), not attached to this session and out of scope — see §QuixBugs.

## Test baselines (before any change)
- **Node/unit/contract:** `node --test tests/node/**/*.test.js` → **1612 tests, 0 fail, 42 skipped.** Clean.
- **Browser (Playwright, local `headless_shell`):** two failures — test 39 (`atlas-ai`) and test 88 (`atlas-bot`). Both investigated below.
- **Python contracts:** pass except `test_sprint1_inventory`, which errors at *import* on a native `cryptography` Rust panic — an environment issue in this sandbox, unrelated to app code (file untouched).

---

## BUG-1 — Browser test 39: false failure from an unsupported Playwright API — FIXED ✅

**Test:** `tests/browser/atlas-ai.browser.test.mjs` — *"a bartender sees manager-only proposals as waiting, with approve disabled"*.
**Symptom:** `AssertionError: no Decisions tab for staff — expected 0, actual 1` (line 195).

**This is NOT an authorization regression.** The same test's other assertions pass and prove access control holds for a bartender:
- Card shows "Waiting for a manager" / "Only a manager can approve this." ✅
- Approve button is `disabled` with the correct title. ✅
- A **forced** click produces **0** `execute-action` calls (server-gated). ✅

**Root cause (reproduced with a temporary diagnostic, since reverted):** the Decisions tab IS correctly hidden for staff — `renderList()` sets `el('modes').hidden = !isManager()` (`apps/web/assets/js/atlas-ai.js:759`); for a bartender the `.ai-list__modes` bar is `display:none`. Diagnostic measurements for a bartender:

| Method | Result | Correct? |
|---|---|---|
| element `getClientRects().length` | 0 | truly hidden |
| `locator(...).first().isVisible()` | false | ✅ |
| `locator('[data-ai-mode="decisions"]:visible').count()` | 0 | ✅ |
| `locator('[data-ai-mode="decisions"]').filter({ visible: true }).count()` | **1** | ❌ wrong |

The `visible` option of `locator.filter()` was introduced in **Playwright 1.51**; this repo runs **Playwright 1.48.0**, where the unknown option is **ignored**, so `filter({ visible: true })` filters nothing and counts the hidden node. Commit `cd98989` ("safer browser assertions") refactored the assertion into this form and silently broke it.

**Fix (minimal, non-weakening):** use the `:visible` pseudo, which works on 1.48 and matches the test's intent (and the pre-`cd98989` approach):
```diff
- assert.equal(await page.locator('[data-ai-mode="decisions"]').filter({ visible: true }).count(), 0, 'no Decisions tab for staff');
+ assert.equal(await page.locator('[data-ai-mode="decisions"]:visible').count(), 0, 'no Decisions tab for staff');
```
The assertion is still meaningful: `:visible` returns `0` only because the tab is genuinely hidden for staff; it returns `1` for a manager (the tab renders). Access control is unchanged; only the broken assertion is corrected.

**Verification:** test 39 passes in isolation and the **full `atlas-ai` browser suite is 30/30** after the change. Server-side enforcement is independently confirmed by the security audit (`pricing_require_manager`, AI `canApprove`/`MANAGER_ROLES`, service-role-only RPCs).

**Related latent issue (REVIEW, not fixed here):** the same unsupported API is used at `tests/browser/ux-acceptance.browser.test.mjs:404` (`getByRole(...).filter({ visible: true }).first().click()`) — a no-op filter on 1.48 that can target a hidden button. It is not currently in the failing set; flagged for a follow-up (fix the assertion, or pin/upgrade Playwright to ≥1.51 — the latter is a broader change out of scope for this cleanup).

---

## BUG-2 — Browser test 88: pre-existing, environment-sensitive atlas-bot failure — NOT a regression, NOT fixed here

**Test:** `tests/browser/atlas-bot.browser.test.mjs` — *"idle falls asleep (test hook): eyes close, Z → ZZ → ZZZ …"*.
**Symptom:** `Timed out waiting for falls asleep` — deterministic (3/3 runs) under both local browser binaries (`headless_shell` and full `chromium-1194`).

**Evidence & classification:**
- The test first waits for the **live** WebGL mascot scene (`.atlas-bot-live.is-live`, 15s) — which it passes, so WebGL partly works — then waits for the robot state to reach `sleeping` (10s), which never happens in this sandbox.
- The atlas-bot suite is the repo's **documented WebGL/idle-render instability** family; in CI it fails *non-deterministically* (different subtests per run — e.g. "WebGL context lost", "calm idle 54!=52" were the reds on the recent pricing PRs, not this one).
- **Unchanged by any work in this session** (no change touches `atlas-bot.js`/`atlas-mascot-scene.js`), and no code change of mine affects it.

**Honest classification:** a **pre-existing, environment-sensitive** failure of the idle→sleep state machine under this headless/software-rendering runner (no hardware GPU). It is **not** the role/security issue and **not** introduced by the cleanup. Per the "don't blanket-label as flake" rule: it is *deterministic in this local environment*, so the correct follow-up is to **reproduce it in CI's GPU/SwiftShader environment** to decide between (a) a real idle-sleep state-machine fix or (b) environment-gating the test. That is a focused, separate task — not bundled into this cleanup PR, and not "fixed" by weakening or skipping the test.

---

## Quality findings from the parallel audits (not defects, tracked for the roadmap)

From the frontend/performance and security sweeps (full detail in `ALCEDO_CLEANUP_IMPLEMENTATION.md`):
- **Mascot render loop is correctly gated** (pauses offscreen / tab-hidden / idle; WebGL context-loss → poster; adaptive fps). The documented instability is already handled in code — the remaining noise is the *test* environment (BUG-2).
- **Security posture strong** (Pattern A consistent, full RLS, no client secrets, AI spend/rate caps, append-only audits). Three low REVIEW items only (accounting export step-up parity; `style-src 'unsafe-inline'`; CORS `*` with bearer auth).
- **Performance opportunities** (eager→lazy module loading ~282KB; 8s unread poll; 2.5s shell timer; duplicate `escapeHtml`×19) — behaviour-preserving optimizations, proposed in the cleanup doc, **not** applied in this first PR to keep it minimal and reviewable.

## QuixBugs
`bug-report.md` was referenced but **not attached** (not in uploads or the repo). It describes the **QuixBugs `python_programs`** project (commit `4257f44`) — a separate algorithms corpus, unrelated to Alcedo, and not in this session's repo scope (`-V-OS-` only). Per your instruction it is **isolated and set aside**: no Alcedo code is treated as a QuixBugs bug, and no unrelated Python algorithms are modified. To action it, attach `bug-report.md` and grant access to the correct QuixBugs repository; that work would live in its own branch/PR.

## Summary
| ID | Area | Status | Risk |
|---|---|---|---|
| BUG-1 | test 39 false failure (Playwright 1.48 API) | **Fixed** (1-line, verified) | none — test-only |
| BUG-2 | test 88 atlas-bot idle-sleep | Pre-existing, env-sensitive; follow-up in CI env | n/a — not regressed |
| REVIEW | ux-acceptance:404 same broken API | Flagged | low |
