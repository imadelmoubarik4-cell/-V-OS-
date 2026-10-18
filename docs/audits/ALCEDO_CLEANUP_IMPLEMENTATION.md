# ALCEDO — Cleanup Roadmap & Implementation Log

**Date:** 2026-10-18 · **Branch:** `claude/cleanup-audit` (off `main` @ `8cde4a7`)

Evidence-based classification from four read-only audits (frontend/performance, code-quality/dead-code, security, database/cost). Classification: **KEEP** / **CLEAN** (proven safe, no behaviour change) / **REVIEW** (needs confirmation) / **APPROVAL REQUIRED** (production/data/security/cost/user-facing).

## Implemented in this PR (safe, verified)
| Change | File | Why | Verification |
|---|---|---|---|
| Fix test 39 false failure (use `:visible`, not the 1.48-unsupported `filter({visible:true})`) | `tests/browser/atlas-ai.browser.test.mjs` | correctness of an access-control test; access control itself was already correct | test 39 green; full `atlas-ai` browser suite 30/30 |
| Six audit documents | `docs/audits/*.md` | the required deliverables | — |

That is the **entire** code change in this PR — deliberately minimal. Everything below is proposed, not applied.

## CLEAN (safe, proposed for a follow-up PR — behaviour-preserving)
- **Eager→lazy module loading** (`index.html` + `config.js`): `shifts`/`knowledge`/`training`/`bookings` workspaces are loaded **both** eagerly (static `<script>`) and lazily (config.js) — dedup-by-path means no double download, but the eager tags pull ~282 KB on every page for views reached by a nav click. Removing the eager tags (matching the proven marketing/accounting/settings lazy pattern) reclaims the weight. *REVIEW-tier because view-registration timing must be re-verified; ship behind a deep-link smoke test.*
- **Module CSS eager while JS lazy** (~70 KB): let the lazy loader inject each stylesheet (config.js already passes `stylesheetPath`).
- **Version-key drift**: `training-workspace.js` static `?v=20260930-polish1` vs config `?v=20261015-s98` (same file, stale key); `marketing-workspace` `s94b` vs CSS `s94c`. Align, and add a node guard test asserting index.html/config.js version parity.
- **Stale comment** in `s38-app-remediation.js` references a deleted `.css`.

## REVIEW (needs a decision; evidence gathered)
- **Eager heavy view modules** (`atlas-ai` 170 KB, `data-workspace` 108 KB, `atlas-purchasing` 98 KB, `flavor-map` 81 KB) load on every signed-in page though each is a single view (two are role-hidden). Convert to lazy like the others. Biggest perf win; needs view-registration + omni-search verification.
- **Background polling:** `team-unread-badge` 8s network poll (well-gated; raise to 15–30s or move to Realtime); `atlas-chrome` 2.5s in-memory timer (redundant with its own events; never cleared while hidden).
- **Live-voice `waveLoop`** (`atlas-ai.js:2200`) runs 60 fps with no `document.hidden` gate (bounded to the call; skip DOM writes when hidden).
- **Duplicate helpers:** `escapeHtml`/`escape` re-defined in ~19–27 modules, `icon()` in ~14, `formatDate` in ~7. Expose `AtlasShell.escape`/`icon` and migrate incrementally (public-menu.js must keep a local copy — no shell on `menu.html`).
- **Dead/scaffolding code:** `packages/inventory/index.js` (0 consumers); six code-less `packages/*` stub packages (namespace reservations); `s38-app-remediation.js` no-op shim (test-covered — retire the marker contract first).
- **Repo weight (not deployed):** `prototypes/` (4.6 MB, separate deploys), `releases/`, `supabase/s33/runtime-delta-audit.json` (667 KB provenance), sign-in intro `.mp4` (184 KB, 0 refs). Archival vs deletion is an owner call; none affect the production bundle.
- **Edge functions deployed but not in repo:** `atlas-import-worker` (intentionally inactive per cutover manifest), `atlas-backup-export-20260806` (DR — do not remove).
- **`ux-acceptance.browser.test.mjs:404`** uses the same 1.48-unsupported `filter({visible:true})`.

## APPROVAL REQUIRED (do not execute without sign-off)
- **S104 ledger row** — record `20261021090000` (idempotent INSERT; schema already correct). See `ALCEDO_S104_MIGRATION_AUDIT.md` / issue #124. Blocked by the production-write guard.
- **Pause/retire `atlas-pr30-validation`** — see `ALCEDO_COST_OPTIMIZATION.md`.
- **No dependency manifest/lockfile** — root `package.json` declares no deps; `node_modules` (153 MB) is undeclared/unpinned (`ffmpeg-static` appears orphaned). Add a declared+locked devDependencies set (reproducibility/supply-chain). Larger change.
- **Mascot poster PNGs** `alcedo-mascot-head-glass.png` (582 KB for a 176 px welcome) and `alcedo-mascot-head.png` (188 KB for ~20 px badges) — re-export at display size/WebP. User-facing visual asset → design sign-off.
- **Multi-tenancy & employee-management** — separate programs; see their dedicated reports.

## KEEP (verified correct — do not touch)
Mascot render loop gating (offscreen/hidden/idle/WebGL-context-loss); full RLS coverage (0 tables without RLS); Pattern A security; AI spend/rate caps; append-only audit tables; all feature flags (intentional); `s33` isolated import-worker candidate; centralized ISK/money helpers; brand-kit sources (test-anchored).

## How to verify / roll back any follow-up
`npm run test:node` + `npm run test:python` + `npm run test:browser` (note the env-sensitive atlas-bot suite, BUG-2). Every item is on git-tracked files; rollback = `git checkout -- <path>`. Ship CLEAN items in small, independent PRs with before/after measurements.
