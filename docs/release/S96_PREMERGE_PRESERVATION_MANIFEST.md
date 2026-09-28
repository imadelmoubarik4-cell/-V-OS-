# S96 Pre-Merge Preservation Manifest

Mandatory before any S96 merge, deploy, rebase, squash, cherry-pick, branch deletion or cleanup.
Nothing here merges, deploys, rotates, deletes a branch, or changes production. Production reads are read-only.

## Git topology (re-read at generation time)
| Ref | Branch | SHA | State |
|---|---|---|---|
| main | main | f0f3f40780277ae3d760ac379a37042da4dd5162 | frozen; LIVE WEB source |
| S96 | claude/s96-security-hardening | fbc880e78432d5724c8dee2cd1a330f100686246 | this security branch (contains all of PR #103 + main) |
| PR #103 | claude/flavor-intelligence | 994fa5f054ed3b3f1befe2c3b78d3f6a7d25d297 | open/draft; fully contained in S96 |
| PR #93 | claude/determined-brahmagupta-6ea5j6 | 68b3108d282e59c7d884d74ed4c57556c27eaeaf | open; branches from main; NOT contained in S96 |
| RC (rehearsal) | rc/s96-preservation-rehearsal | f1912da (local, disposable) | S96 + PR#93 reconciliation rehearsal; never pushed to protected branches |

Ancestry (verified): `main` and PR #103 are ancestors of S96; PR #93's merge-base with S96 is `main`.
**Merging S96 into main implicitly ships S95/Flavor** — see the Flavor decision record in
`S96_FEATURE_PRESERVATION_REPORT.md`. PR #93 (Accounting) is a separate stream.

## S96 vs PR #93 file overlap (both changed vs base main)
S96 changed 175 files; PR #93 changed 24; overlap = 5, all reconciled in the RC rehearsal (semantic, never
ours/theirs):
| File | Resolution |
|---|---|
| apps/web/index.html | union: atlas-app.js (S96 CSP) + flavor-map.js (Flavor) + atlas-palette.js & accounting nav (PR#93); latest cache-busts |
| apps/web/assets/js/atlas-shell.js | auto-merged; contains both accounting (5 refs) and flavor/recipes (9 refs) |
| docs/DEPLOYMENT.md | union: keep both the S95 (Flavor) and S92 (Accounting) sections |
| docs/release/Atlas_S42_Production_Cutover_Manifest.json | pin merged files: netlify.toml=S96 hardened CSP, config.toml=PR#93 (adds atlas-accounting) |
| tests/node/shell-contract-s88.test.js | assert the reconciled index (both feature sets) |
Additional reconciliation surfaced by the S96 suite on the combined state: `tests/node/s96-verify-jwt-policy.test.js`
allowlist now records `atlas-accounting` (verify_jwt=false; authenticates in code, admin-only), and the S96
`no-40001` SQL test correctly flags the accounting 40001 pattern — the accounting 40001→PT409 fix must be
applied when Accounting is integrated (OPSRISK-01).

## Production deployed backend (authoritative, from the deployed sources — Git alone is insufficient)
26 Edge Functions; full version/hash table in the S96 baseline evidence (`edge_functions.json`). Key facts:
- atlas-ai v19 (S95); atlas-accounting (PR#93 lineage, deployed) and atlas-import-worker (not in main) are
  production-only drift; atlas-backup-export-20260806 is a disabled stub.
- Production migration ledger: 74 rows at audit start (pre-S96). S96 adds 12 migrations; PR#93 adds 2. None
  applied to production.

## Production data baseline (read-only, non-secret; captured at generation time)
| Table | Rows |
|---|---|
| inventory_items | 277 |
| recipes | 107 |
| recipe_ingredients | 267 |
| suppliers | 9 |
| inventory_movements | 270 |
| purchase_orders | 0 |
| public_menu | 90 |
| profiles (active) | 2 (2) |
| atlas_private.flavor_ingredients | 229 |
| atlas_private.flavor_edges | 1026 |
| atlas_private.ai_actions | 7 |
| atlas_private.integration_connections | 6 |
Storage buckets: 6 (config in baseline). Re-capture and compare after each rollout group; never expose
credential values or private document contents.

## Authoritative source-of-truth per stream
- LIVE WEB frontend behaviour → `main` f0f3f40 (until S96/PR#93 deploy).
- S95/Flavor backend → deployed atlas-ai v19 (= PR#103 994fa5f = contained in S96).
- Accounting backend → deployed atlas-accounting (PR#93 lineage); its 40001 fix is a separate isolated patch.
- import-worker → deployed source (not in main).
- Platform config → Supabase/Netlify settings (see gate §7 owner checklist).
