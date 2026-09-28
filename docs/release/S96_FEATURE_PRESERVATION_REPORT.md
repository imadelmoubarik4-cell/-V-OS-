# S96 Feature Preservation Report

Basis: S96 `fbc880e`; combined-state proof from the disposable RC rehearsal `rc/s96-preservation-rehearsal`
(f1912da, local, never pushed to a protected branch). Regression on the RC: node **1506 tests / 1464 pass /
0 fail / 42 skipped**; full migration replay **155 migrations** (141 base + 12 S96 + 2 Accounting); Python
only the pre-existing pdfplumber env error; S96 security SQL 5/6 (the 6th correctly flags accounting 40001).
The combined RC is a NEW source state and was tested as such — S96's 07f9d28 pass alone is not treated as proof.

## Per-module preservation
| Module | Previous functionality (authoritative source) | S96 change | Conflict resolution | Positive regression | Negative security | Status |
|---|---|---|---|---|---|---|
| Accounting | admin doc workflow, upload, extraction, review, duplicate/PO checks, approvals, payments, reimbursements, exports, retention (PR#93 deployed) | none to accounting code; combined-state only | index.html/shell/DEPLOYMENT/S42/shell-test unioned; verify_jwt allowlist records accounting | shell-contract 19/19 on reconciled index; accounting node suite green in RC | verify_jwt=false proven authenticates in code (admin-only); **40001→PT409 fix required at integration** | PRESERVED (with integration requirement) |
| Integrations / OAuth (Google, Meta/FB/IG, TikTok, TripAdvisor) | connect/callback/state/PKCE, token encryption, refresh, disconnect, resource select (aioauth verified) | MFA step-up wraps connect/disconnect/save-key/select-resource | wrap, not replace | integrations-oauth-s88 + s94 suites pass | state single-use, PKCE, exact redirect, AES-256-GCM tokens (aioauth) | PRESERVED |
| Flavor Intelligence (PR#103) | flavor graph, candidates, substitutions, stock truth, manager cost, recipe.draft, human approval, Flavor Map | contained in S96; stock-count redaction adjacent | index union keeps flavor-map.js + recipes.js@fi1 | flavor-intelligence browser 13/13 serial | RLS/manager-cost gates verified | PRESERVED |
| Marketing (publisher/media/workspace) | drafts, media, publisher (posting disabled) | kill switch fail-closed; media unchanged | none | marketing-publisher-s94 + media suites pass | automatic posting still off (4 independent gates) | PRESERVED |
| Messages / sender identity | team messages, attachments, sender identity/avatar | error-text redaction; push payload note | none | atlas-bot / team-messages suites pass | IDOR clean; push delivery disabled | PRESERVED |
| Atlas AI | chat/voice/tools/proposals | store:false; Phase3 error redaction; tools already role-gated | none | ai-tools + ai-evals suites pass | tool authz server-side; RAG isolation | PRESERVED |
| Recipes | catalog, save, ingredients | atlas_save_recipe gated (unchanged logic) | none | recipes suites pass | manager-only save | PRESERVED |
| Inventory / recognition / import | items, movements, recognition, import-worker | browser INSERT on movements revoked; recognition upload checks | none | inventory + recognition suites pass | ledger only via reviewed RPCs | PRESERVED |
| Purchasing | PO command/detail/policy | receipt-price approval guard | none | purchasing preview suites pass | approval bypass fixed (DBRLS-04) | PRESERVED |
| Stock Count | count sessions, verify, summary | staff cost redaction | none | stock-count suites pass; s96 redaction SQL | staff see no cost | PRESERVED |
| Teams | profiles, invites, roles | MFA step-up + session revocation | none | team-profiles/team-login suites pass | role change gated; sessions revoked on demote | PRESERVED |
| Knowledge | articles, sources, search | error redaction | none | knowledge suites pass | search authz before retrieval | PRESERVED |
| Reports | report builds | role-shaped data unchanged | none | reports suites pass | no cross-role leakage | PRESERVED |
| Notifications | dispatch (disabled) | push allow-list + constant-time token | none | notifications suites pass | SSRF/token hardened; delivery off | PRESERVED |
| Settings | sections, hours, roles, prefs | save-role step-up | none | settings suites pass | role-permission change gated | PRESERVED |
| Login / recovery | password login, recovery, invite | token_hash recovery; session fixation fix; MFA | index/recovery reconciled | auth-sessions + email-links + fixation suites | fixation blocked; aal1 refused | PRESERVED |

## DB & Storage preservation proof
The 12 S96 migrations are **additive/security-only**: 2 new tables (`private.auth_policy`,
`atlas_private.security_audit_events`, both `if not exists` + RLS), `create policy`/`create or replace
function`/`grant`/`revoke`/trigger changes. **No** `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, or `DELETE FROM`
of any business table. The single `delete from` is the session-revocation trigger acting on `auth.sessions`
(auth state) only on access loss. Storage migration `094000` drops only the **unused** atlas-imports/atlas-media
UPDATE policies — no object is deleted; uploads/deletes still work (s96_storage_update_policies.sql). Combined
155-migration replay preserves all critical-table structures; production row-count baseline recorded in the
manifest for before/after comparison at rollout.

## Flavor Intelligence (PR #103) decision record — REQUIRES OWNER DECISION
S96 contains all of PR #103, so merging S96 to main **implicitly ships S95/Flavor**. Two options; do not let
Git choose:
- **A. Integrate S95 + S96 together** (accept Flavor ships with the security layer). Then PR #103 should be
  closed as "delivered via S96", not pretended independently merged.
- **B. Extract S96 without S95** (Flavor stays unmerged): rebuild an S96-only branch off `main` excluding the
  Flavor file set. Larger effort; only if Flavor must not ship yet.
Recommendation on record: **A**, since Flavor is verified PRESERVED and already the deployed backend (atlas-ai
v19). Owner must choose.

## Open-PR inventory (classification)
| PR | Title | Class |
|---|---|---|
| #103 Flavor Intelligence | contained in S96 | NEEDS OWNER DECISION (A/B above) |
| #93 Accounting | separate stream; deployed lineage | CANONICAL OUTSTANDING WORK (integrate with 40001 fix) |
| #87 S84.1 owner prep/verified stock | pre-S88 | NEEDS OWNER DECISION (verify superseded by deployed S88+) |
| #85 S84 stock-truth cache | pre-S88 | NEEDS OWNER DECISION |
| #63,#62,#61,#60,#59,#58 (codex S50-55) | system/brain/purchasing/import/recipes fixes | NEEDS OWNER DECISION (check unique work vs deployed) |
| #25,#23,#22,#21,#20,#15,#11,#9,#8,#7 | older phase/visual/interface drafts | HISTORICAL ONLY (verify represented before any deletion) |
Do not auto-merge or delete any; prove useful work is represented in the canonical release first.

## Rollback (per stream)
- Frontend: redeploy the previous Netlify commit (main f0f3f40).
- Edge Functions: redeploy prior versions (atlas-ai v18 from main; accounting prior deploy).
- DB: S96 migrations are additive — revert by dropping the added objects (each migration is self-contained);
  no business data to restore.
- Config/Auth: restore previous Supabase settings snapshot.

## Preservation status
Every canonical module: **PRESERVED**. One explicit integration requirement (not feature loss): the
accounting **40001→PT409** fix must be applied when Accounting (PR #93) is integrated, or the S96 security
suite fails on the combined state — which is the suite working as intended.
