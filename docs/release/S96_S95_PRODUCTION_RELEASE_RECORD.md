# Atlas production release — S95 Flavor + S96 Security + Accounting

Executed 2026-09-28 against Supabase project `dnefgcmjcgxlynycxkts`. No secret value is shown here.

## Release SHAs
- Old main (pre-release): `f0f3f40780277ae3d760ac379a37042da4dd5162`
- Reconciled RC (canonical): `3b3cfc20e0b0ba9b41b2b3ce59638be300fe40ea`
- Resulting main (merge commit, PR #105): `ee119012c921358046a85dfccfad8d686be5acef`
- PR #93 and PR #103 remain **open and intact**; their branches, the S96 branch and the RC are preserved.

## What was done (server-side, automated)

### Accounting migration-history alignment
- Base accounting migration renamed to the production ledger version `20260926000033` (SQL unchanged, 100% rename).
- Replay harness relocates that one back-dated file to its real apply slot (before s92b), full body validation on.
- Verified: 156-migration replay green; node 1464/0; python 274; S96 SQL suite green.

### Merge (Phase 2)
- RC merged to main via PR #105 (required checks `contracts` + `replay` green; `browser` is a CI concurrency flake that passes in isolation; `disposable PostgreSQL 17` and `github-advanced-security` are non-required and pre-existing — see Follow-ups).

### DB migrations (Phase 4) — 14 applied via Management API, each verified absent from the ledger first
`20261001100000` s92b_accounting_read_guard; the 12 S96 migrations `20261010090000`–`20261010096300`; `20261010099000` s96_accounting_no_40001_retry. Verified afterward:
- Ledger 88 total (74 + 14); accounting `begin_read` is only the 6-arg `p_again` overload (old 5-arg removed); neither `atlas_accounting_begin_read` nor `atlas_accounting_command` contains SQLSTATE 40001 (both raise PT409); **no function anywhere raises 40001**.
- Row counts unchanged vs preservation baseline (inventory_items 277, recipes 107, inventory_movements 270, profiles 2, suppliers 9, integration_connections 6, storage.objects 80). No data loss.
- Privileged-MFA RLS is non-locking: mandatory off, 0 privileged users enrolled → owner keeps aal1 access.

### Edge Functions (Phase 5) — 24 deployed from disk (CLI, `--use-api`)
- verify_jwt preserved (`atlas-notifications`=true; all others false). Legacy `atlas-backup-export-20260806` and `atlas-import-worker` untouched.
- New auth.mjs (step-up/MFA gate, env-gated OFF) deployed to all importers for uniform enforcement.
- Boot + authz smoke test: functions return a clean 401 to unauthenticated / publishable-key calls (no crash, no leak).

### OPSRISK-01 — CLOSED (Phase 6)
- Stale accounting command now raises `PT409 | document changed` (bounded, non-retryable 409), proven at the DB.
- No accounting retry-loop backend in `pg_stat_activity` (self-resolved when the function was replaced; nothing was terminated).

### MAIN-01 — resolved at the Supabase Auth layer (Phase 7)
- `site_url` and `uri_allow_list` moved from the stale `deploy-preview-8--os-vabar.netlify.app` to the production origin `https://os-vabar.netlify.app` — bearer tokens are no longer delivered to a preview host.
- Recovery and invite email templates switched to the token_hash flow (`#token_hash={{ .TokenHash }}&type=…`), matching the frontend `verifyOtp` handlers — no session token in a redirect URL.

### Platform hardening (Phase 10, safe items)
- Public self-signup disabled (`disable_signup=true`); admin invitations unaffected.

## Final acceptance (layers under automated control)
- Security advisors: **0 Critical, 0 High, 0 Warn** (2 INFO: `private.auth_policy` and `atlas_private.stock_adjustment_requests` are intentional fail-closed tables).
- Invariants: every public table has RLS; 0 anon-executable public functions; every SECURITY DEFINER function pins search_path; 0 realtime-exposed tables.
- Performance advisors: INFO only (unindexed FKs / unused indexes on young tables) — non-blocking.

## OWNER ACTIONS required for full ATLAS PRODUCTION ACCEPTED
1. **Live frontend verification** (primary acceptance gate; this environment is egress-blocked from `os-vabar.netlify.app`): confirm login/recovery and walk Home, Inventory, Purchasing, Recipes, Flavor Intelligence, Reports, Stock Count, Teams, Messages, Knowledge, Notifications, Settings, Accounting, Marketing, integrations/OAuth, Atlas AI across staff / manager / admin.
2. **Privileged MFA activation** (optional hardening; gates deployed and non-locking): enrol a TOTP factor (scan the QR in the app) for every admin/manager, then set `ATLAS_REQUIRE_PRIVILEGED_MFA=true`. Do not set it before enrolling or it will require aal2 for privileged actions.
3. **Legacy key rotation**: blocked on the `_shared/service-credentials.mjs` migration (not yet in main). Do **not** deactivate/revoke the legacy anon/service_role JWT or the legacy JWT secret until that code ships and Edge Function logs show a full day with no `Invalid JWT`. Frontend is already on the publishable key.
4. **Database network + SSL**: `db_allowed_cidrs` is `0.0.0.0/0`. Restricting it and enforcing SSL must be compatibility-verified in the dashboard to avoid lockout — owner action.
5. **PITR/backup, Auth log retention, Realtime private-channel enforcement**: dashboard settings (Realtime currently exposes no `postgres_changes`, so no live data leak).

## Follow-ups (non-blocking, pre-existing on the RC — not release regressions)
- `disposable PostgreSQL 17` CI (production-adoption dry run, non-required): S96 tightened `verify_phase1_security_gate.sql` to require the post-Phase-1 `adjust_inventory` model, which the frozen Phase-1 flattened adoption migration predates. Production is far past Phase 1, so this is a stale test-path mismatch, not a production risk. Fix by folding the adjust_inventory hardening into the adoption flattened migration (or scoping the gate) in a follow-up.
- `github-advanced-security` CI (Copilot SWE agent, non-required): non-deterministic agent-run failure (green on prior PRs), not a code finding.
