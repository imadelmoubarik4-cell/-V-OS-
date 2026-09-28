# S96 Atlas Security Hardening — consolidated gate report

Branch: `claude/s96-security-hardening` (based on S95 head 994fa5f, which production runs).
Production was **read-only** throughout. No production deploy, no secret rotation, no config change,
no merge. PR #93 and PR #103 untouched. Benchmarks: OWASP ASVS 5.0, OWASP API Top 10 2023,
NIST SP 800-63B, CIS, current Supabase security docs.

## Production deployment matrix (drift is real; no single commit is "production")
| Surface | What runs | Audited from |
|---|---|---|
| LIVE WEB | apps/web at `main` f0f3f40 (os-vabar.netlify.app) | `git show f0f3f40` + deploy-preview-103 (live host blocked by this session's egress) |
| PRODUCTION BACKEND | Edge Functions + migrations from PR #103 994fa5f (S95) | deployed sources downloaded from the project |
| ACCOUNTING DEPLOYED SOURCE | atlas-accounting (PR #93 lineage; differs even from #93 head) | deployed source |
| IMPORT WORKER | atlas-import-worker (not in main) | deployed source |
| PR103 PREVIEW | apps/web at 994fa5f (deploy-preview-103) | live preview |
| PLATFORM CONFIG | Supabase + Netlify settings | Management API (read-only) + drift script |

## Findings totals
2 High, 19 Medium, 39 Low, 25 Informational (85 total). Full per-finding JSON in the S96 evidence set.
Git-typed Medium/High findings are FIXED ON THE BRANCH with negative regression tests; they remain LIVE
IN PRODUCTION until the owner deploys the branch. Owner-action findings need a platform change only the
owner can make.

## Verdict: OWNER ACTION REQUIRED
Two High findings cannot be closed from Git alone, and several could-be-High items are UNVERIFIED due to
this session's network policy or missing owner access. Details and the exact owner steps are below.

### Attack classes C1–C44

| Item | Disposition (by agent) |
|---|---|
| C1 CSRF | edgea:CONTROL VERIFIED; aioauth:CONTROL VERIFIED |
| C10 exposed preview/test/staging environments | opsrisk:VULNERABLE |
| C11 default credentials / sample accounts / bootstrap secrets | opsrisk:VULNERABLE |
| C12 webhook-like routes | edgea:CONTROL VERIFIED |
| C12 webhooks (enumeration of all inbound unauthenticated-by-design rou | aioauth:CONTROL VERIFIED |
| C13 payment/billing/entitlement enforcement | secsupply:NOT APPLICABLE |
| C14 IDOR/BOLA | dbrls:VULNERABLE; dbrls:CONTROL VERIFIED (DB layer by review; live exercise not possible: objects absent from repo replay); edgea:VULNERABLE (Medium:  |
| C15 client-supplied audit fields (mass assignment) | opsrisk:VULNERABLE |
| C15 client-supplied role/ids/prices/approval/ownership | dbrls:VULNERABLE; dbrls:CONTROL VERIFIED (review) |
| C15 client-supplied sensitive fields | edgea:VULNERABLE (Low: EDGEA-05 stock-count evidence); others CONTROL VERIFIED |
| C15 trusting client-supplied security fields / mass assignment | aioauth:CONTROL VERIFIED |
| C16 secrets/PII in logs | edgea:CONTROL VERIFIED (Informational EDGEA-16) |
| C16 sensitive data in logs | opsrisk:CONTROL VERIFIED |
| C16 sensitive data in logs (AI and integrations code) | aioauth:CONTROL VERIFIED |
| C17 source maps / build metadata | secsupply:CONTROL VERIFIED; secsupply:CONTROL VERIFIED |
| C17 source maps / build metadata (live site) | secsupply:UNVERIFIED (egress policy: CONNECT to os-vabar.netlify.app returns 403 from this session's proxy) |
| C17 source maps/debug bundles/stack traces/build metadata | secsupply:CONTROL VERIFIED |
| C17 stack traces / internal detail in function error responses | secsupply:CONTROL VERIFIED |
| C18 authenticated-response caching | edgea:CONTROL VERIFIED |
| C19 stale-preview takeover (auth side) | authn:VULNERABLE pending host verification |
| C19 subdomain / stale-preview takeover | opsrisk:UNVERIFIED (netlify.app and chatgpt.site HTTP blocked by egress policy; DNS resolves for all) |
| C2 insecure uploads | edgea:CONTROL VERIFIED; edgea:CONTROL VERIFIED; edgea:VULNERABLE (Low: body parsed before size check, EDGEA-06); type control verified; edgea:CONTROL  |
| C2 insecure uploads (inventory recognition; also atlas-ai upload) | aioauth:CONTROL VERIFIED |
| C20 prototype pollution | edgea:CONTROL VERIFIED |
| C20 prototype pollution / unsafe merge | aioauth:CONTROL VERIFIED |
| C3 path traversal / object keys | aioauth:CONTROL VERIFIED |
| C3 path/object-key manipulation | edgea:CONTROL VERIFIED |
| C4 SSRF | edgea:VULNERABLE (latent, Low: EDGEA-03 push endpoint); others CONTROL VERIFIED; aioauth:VULNERABLE |
| C44 dedicated SSRF / outbound-network gate (ADDENDUM 8; extends C4/C29 | ssrf:CONTROL VERIFIED (with one dormant VULNERABLE: SSRF-01 push endpoint, = EDGEA-03/AIOAUTH-05, delivery disabled, fixed by edgea patch 03) |
| C5 reset/invite/magic/email-change | authn:VULNERABLE (Low/Medium, config) |
| C6 session management | authn:VULNERABLE (Low) |
| C7 JWT | authn:CONTROL VERIFIED |
| C7 JWT: legacy/weak secrets and key rotation (legacy-key portion) | secsupply:VULNERABLE |
| C8 CORS | edgea:CONTROL VERIFIED; aioauth:CONTROL VERIFIED |
| C9 Auth rate limits | authn:UNVERIFIED (not probed per rules; vendor limits documented) |
| C9 rate limits | edgea:VULNERABLE (Low: EDGEA-07) |
| C9 rate limits (AI and integrations) | aioauth:VULNERABLE |
| C9 rate limits (DB-side primitives) | dbrls:NOT APPLICABLE (not my class) |
| C9 rate limits (DoS via PostgREST retry) | opsrisk:VULNERABLE |
| Phase 11: supply chain (npm, Deno, CI, CDN) | secsupply:VULNERABLE |
| Phase 6: secrets in Git history (all refs) | secsupply:CONTROL VERIFIED |

### Hardening controls 1–30

| Item | Disposition (by agent) |
|---|---|
| 10 Server-authoritative financial values (accounting) | edgea:ALREADY VERIFIED |
| 10 Server-authoritative prices/financial values | dbrls:REQUIRED |
| 10 Server-authoritative prices/financial values — payments portion | secsupply:NOT APPLICABLE |
| 12 AI usage caps | aioauth:REQUIRED |
| 13 Request-body limits | edgea:REQUIRED |
| 13 Request-body limits (AI, integrations, recognition) | aioauth:ALREADY VERIFIED |
| 15 Input validation | edgea:ALREADY VERIFIED |
| 15 Input validation (AI and integrations) | aioauth:ALREADY VERIFIED |
| 15 Input validation (DB-side) | dbrls:ALREADY VERIFIED |
| 16 CORS lockdown | edgea:ALREADY VERIFIED |
| 16 CORS lockdown (AI and integrations) | aioauth:ALREADY VERIFIED |
| 17 Directory/index exposure | secsupply:ALREADY VERIFIED; secsupply:OWNER ACTION REQUIRED |
| 18 Default-admin / maintenance surfaces (AI maintenance routes) | aioauth:ALREADY VERIFIED |
| 18 Default-admin / maintenance surfaces (functions) | edgea:ALREADY VERIFIED |
| 18 Default-admin surfaces (default routes, demo logins, test creds, bo | opsrisk:OWNER ACTION REQUIRED |
| 2 HTTPS everywhere (integration URLs) | aioauth:ALREADY VERIFIED |
| 20 Security-event logging | opsrisk:REQUIRED |
| 22 Database least privilege | dbrls:REQUIRED |
| 26 Secret rotation & blast radius | secsupply:REQUIRED |
| 27 Backup & restore proof | opsrisk:OWNER ACTION REQUIRED |
| 29 Egress/SSRF allow-listing | edgea:REQUIRED |
| 29 Egress/SSRF allow-listing (AI and integrations) | aioauth:REQUIRED |
| 30 Tamper-resistant audit history | opsrisk:REQUIRED; dbrls:REQUIRED |
| 4 CSRF inventory | edgea:ALREADY VERIFIED |
| 4 CSRF inventory (AI and integrations) | aioauth:ALREADY VERIFIED |
| 8 Upload allow-list | edgea:REQUIRED |
| 8 Upload allow-list (inventory recognition) | aioauth:ALREADY VERIFIED |
| 9 Webhook verification | aioauth:ALREADY VERIFIED |
| N1 Realtime/WebSocket authorization | dbrls:CONTROL VERIFIED (data) / UNVERIFIED live channel join |
| N10 CI/CD and deployment takeover — GitHub Actions | secsupply:VULNERABLE |
| N10 CI/CD and deployment takeover — Netlify deploy tokens and PR previ | secsupply:UNVERIFIED (no Netlify API access) |
| N10 CI/CD and deployment takeover — Supabase tokens / who can deploy E | secsupply:VULNERABLE |
| N10 CI/CD and deployment takeover — artifact retention | secsupply:UNVERIFIED (artifact contents not downloaded) |
| N10 CI/CD and deployment takeover — branch protection / who can merge  | secsupply:UNVERIFIED (protection rule details not readable with available read-only tools) |
| N11 Data export / mass-exfiltration controls | opsrisk:VULNERABLE |
| N11 Export endpoints / mass exfiltration | edgea:CONTROL VERIFIED |
| N12 Backup confidentiality | opsrisk:VULNERABLE |
| N13 Search/index leakage (Atlas AI, Knowledge search, Reports) | aioauth:CONTROL VERIFIED |
| N14 Notification privacy | edgea:VULNERABLE (latent, Low: EDGEA-08) |
| N15 Domain and email security | opsrisk:VULNERABLE |
| N16 Migration/production drift detection | opsrisk:VULNERABLE |
| N18 Delete/disable semantics (Auth side) | authn:VULNERABLE (Low) -> fixed by patch 04. Data access loss was already CONTROL VERIFIED. |
| N18 Delete/disable semantics (DB side) | dbrls:CONTROL VERIFIED |
| N19 Error-message/data leakage | edgea:VULNERABLE (Low: EDGEA-04) |
| N19 Error/data leakage (AI) | aioauth:VULNERABLE |
| N2 Cron, queues, background workers | edgea:CONTROL VERIFIED |
| N20 Denial-of-wallet | edgea:VULNERABLE (Low: EDGEA-07) |
| N20 Denial-of-wallet (AI chat, voice, recognition, flavor) | aioauth:VULNERABLE |
| N3 Venue/tenant isolation | dbrls:NOT APPLICABLE (single-tenant by design; documented risk) |
| N4 Race conditions/TOCTOU | dbrls:VULNERABLE (fixed in patch) |
| N5 Idempotency of dangerous writes | edgea:CONTROL VERIFIED |
| N5 Idempotency of dangerous writes (DB) | dbrls:CONTROL VERIFIED (except v1 adjust_inventory) |
| N6 CSV/Excel formula injection (server exports) | edgea:CONTROL VERIFIED |
| N7 Archive/document/image bombs | edgea:CONTROL VERIFIED |
| N7 Image/decompression bombs (inventory recognition; also atlas-ai upl | aioauth:CONTROL VERIFIED |
| N9 MFA recovery / break-glass admin recovery | authn:UNVERIFIED (no recovery process exists yet; nobody is enrolled, so nothing to recover today) |

### Whole-system controls N1–N20

| Item | Disposition (by agent) |
|---|---|
| N1 Realtime/WebSocket authorization | dbrls:CONTROL VERIFIED (data) / UNVERIFIED live channel join |
| N10 CI/CD and deployment takeover — GitHub Actions | secsupply:VULNERABLE |
| N10 CI/CD and deployment takeover — Netlify deploy tokens and PR previ | secsupply:UNVERIFIED (no Netlify API access) |
| N10 CI/CD and deployment takeover — Supabase tokens / who can deploy E | secsupply:VULNERABLE |
| N10 CI/CD and deployment takeover — artifact retention | secsupply:UNVERIFIED (artifact contents not downloaded) |
| N10 CI/CD and deployment takeover — branch protection / who can merge  | secsupply:UNVERIFIED (protection rule details not readable with available read-only tools) |
| N11 Data export / mass-exfiltration controls | opsrisk:VULNERABLE |
| N11 Export endpoints / mass exfiltration | edgea:CONTROL VERIFIED |
| N12 Backup confidentiality | opsrisk:VULNERABLE |
| N13 Search/index leakage (Atlas AI, Knowledge search, Reports) | aioauth:CONTROL VERIFIED |
| N14 Notification privacy | edgea:VULNERABLE (latent, Low: EDGEA-08) |
| N15 Domain and email security | opsrisk:VULNERABLE |
| N16 Migration/production drift detection | opsrisk:VULNERABLE |
| N18 Delete/disable semantics (Auth side) | authn:VULNERABLE (Low) -> fixed by patch 04. Data access loss was already CONTROL VERIFIED. |
| N18 Delete/disable semantics (DB side) | dbrls:CONTROL VERIFIED |
| N19 Error-message/data leakage | edgea:VULNERABLE (Low: EDGEA-04) |
| N19 Error/data leakage (AI) | aioauth:VULNERABLE |
| N2 Cron, queues, background workers | edgea:CONTROL VERIFIED |
| N20 Denial-of-wallet | edgea:VULNERABLE (Low: EDGEA-07) |
| N20 Denial-of-wallet (AI chat, voice, recognition, flavor) | aioauth:VULNERABLE |
| N3 Venue/tenant isolation | dbrls:NOT APPLICABLE (single-tenant by design; documented risk) |
| N4 Race conditions/TOCTOU | dbrls:VULNERABLE (fixed in patch) |
| N5 Idempotency of dangerous writes | edgea:CONTROL VERIFIED |
| N5 Idempotency of dangerous writes (DB) | dbrls:CONTROL VERIFIED (except v1 adjust_inventory) |
| N6 CSV/Excel formula injection (server exports) | edgea:CONTROL VERIFIED |
| N7 Archive/document/image bombs | edgea:CONTROL VERIFIED |
| N7 Image/decompression bombs (inventory recognition; also atlas-ai upl | aioauth:CONTROL VERIFIED |
| N9 MFA recovery / break-glass admin recovery | authn:UNVERIFIED (no recovery process exists yet; nobody is enrolled, so nothing to recover today) |

## The two High findings (gate blockers)

### MAIN-01 — High — PLATFORM CONFIG — Auth sessions routed to stale deploy-preview-8
GoTrue `site_url` and the redirect allow-list are `https://deploy-preview-8--os-vabar.netlify.app/**`.
Recovery, invite, magic-link, sign-up-confirm and email-change all fall back there and, in the implicit
flow, place `#access_token`+`#refresh_token` in the URL fragment consumed by JS on that host. If that host
is not under owner control, this is session theft / account takeover of any user (admins included).
- Git mitigation committed: recovery links are now consumed via a single-use `token_hash` on Atlas's own
  origin (b4425f8), so recovery no longer depends on the redirect.
- UNVERIFIED (network policy blocks the host from this session): whether deploy-preview-8 is live, under
  owner control, or claimable. **could_be_high=true** until proven.
- OWNER ACTIONS: (1) confirm the Netlify site `os-vabar` (and its deploy-preview aliases) is under your
  account, and delete/replace the PR #8 preview; (2) set Site URL = https://os-vabar.netlify.app and
  Redirect URLs to the exact recovery.html/invitation.html on the production origin (no wildcards);
  (3) update invite/magic-link/email-change/confirmation email templates to token_hash on the production
  origin. Until (1)+(2) are done the finding stays open.

### OPSRISK-01 — High — ACCOUNTING DEPLOYED SOURCE — PostgREST retry loop on stale accounting command
`public.atlas_accounting_command` raises SQLSTATE 40001 on a stale/state-conflict edit; PostgREST treats
40001 as retryable and retries indefinitely, pinning a pooled DB connection. The **vulnerability is present**
in the deployed source (multiple `ERRCODE='40001'` paths) and **remains High until its production fix is
deployed and verified**. Whether a backend is *currently stuck* is a separate, time-varying fact: at the
latest read there was **no non-idle backend older than ~5 minutes**, so no termination is warranted right now.
- Git fix committed for the in-repo catalogue/marketing variants (PT409, 450b7c7). The accounting variant is
  prepared as an ISOLATED patch (not applied; PR #93 untouched) — `isolated-ACCOUNTING-01-no-40001-retry-loop.diff`.
- OWNER ACTIONS (single authoritative runbook):
  1. Re-query `pg_stat_activity` for a non-idle backend older than ~5 min running `atlas_accounting_command`.
  2. Prove it is the accounting retry loop (query text + `state='active'` + long `xact_start`), not other work.
  3. Terminate **only that exact PID** with `pg_terminate_backend(<pid>)` **if one is present**. Never terminate
     an unrelated backend. (At the latest read: none present.)
  4. Deploy the accounting 40001 fix via the separately approved integration path (PR #93 not modified here).
  5. Verify a stale-command request returns a bounded HTTP 409 with no runaway retry (no growing error count,
     no pinned connection).

## Could-be-High UNVERIFIED (must be resolved or owner-accepted before READY)
- **deploy-preview-8 host ownership (MAIN-01)** — this session's egress policy blocks the host, so whether
  it is live / owner-controlled / claimable is UNVERIFIED. Owner must confirm. This is the one genuine
  could-be-High UNVERIFIED item.
- Live production response headers / source maps (C17) and older-preview downgrade (N17) — deploy-preview-103
  is verified clean (no maps, .env/.git/config all 404, strict headers), but the live os-vabar.netlify.app
  host is egress-blocked here; owner should re-check headers after deploying this branch. Not could-be-High
  (preview verified).
- CI/CD: GitHub branch protection, Netlify deploy-token/fork-preview policy, artifact retention (N10) —
  not readable with available tooling; owner to confirm. Not could-be-High (no exposure observed).

## Frontend / storage now covered (webstore delivered; no Critical/High)
XSS sweep 3,459 payloads across 118 states → 0 executions; prototype pollution clean; postMessage has no
HTML-rendering handlers (C36); no redirect params (C32); recovery uses token_hash + detectSessionInUrl off
(C33); third-party JS limited + SRI, no analytics, and the strict CSP now drops 'unsafe-inline'/blob:
(C37); private buckets and accounting docs unreachable even by admin directly, signed tokens bound to one
object (storage isolation). Residual Low: login tokens in localStorage are XSS-gated — mitigated by the
committed escaping + strict CSP. C32–C37 disposition: CONTROL VERIFIED (consolidated).

## Git-only fixes committed on this branch (fixed + regression-tested; awaiting owner deploy)
- b4425f8 recovery token_hash consumption (MAIN-01 mitigation)
- 2395f55 privileged MFA step-up + session-fixation fix + aal2 RLS gate (AUTHN-02/03)
- 67e9347 revoke Auth sessions on deactivate/demote (AUTHN N18)
- 4da5e2e MFA step-up requires recent second factor; wired into integrations + role changes
- e776b4d RLS ownership, purchasing/ledger integrity, last-admin race (DBRLS-01..06)
- 450b7c7 append-only audit history + profile-access audit + no-40001 pattern + drift script (OPSRISK-01/02/06/07/08)
- 6bf47dd stock-count cost redaction, push allow-list, edge error-leakage, verify_jwt policy (EDGEA-01..06)
- 9c459db AI no-retention, Phase 3 error redaction, AI/RAG negative tests (AIOAUTH-02/04)
- ae3b4d2 supply-chain pinning, SSRF egress negative tests, key-rotation runbook (SECSUPPLY/C44)
- 99d822b public-menu output escaping (webstore)

## Owner-action findings (platform; not Git-fixable)
Public sign-up enabled (AUTHN-01); org/admin MFA off + unscoped PAT (OPSRISK-03/10, SECSUPPLY-02);
legacy JWT keys still trusted (OPSRISK-04/SECSUPPLY-01, see S96_KEY_ROTATION_RUNBOOK.md); stale preview
projects/branches with production data (OPSRISK-05); auth events not persisted + 7-day log retention
(OPSRISK-09); PITR off + Storage not backed up (OPSRISK-11); SSL enforcement off + DB network 0.0.0.0/0
(Low, credentials still required); Realtime private-channels setting (DBRLS-10); apply the two release-gated
revokes (DBRLS-07); SPF/DKIM/DMARC (OPSRISK-14/N15). Deploy of every Git fix above is itself an owner action.

## Regression status
Node (`npm run test:node` @ 07f9d28): 1484 tests, 1442 pass, 0 fail, 42 skipped. Python: 275 run, 1 environment-only error (pdfplumber missing). Migration replay: 153 migrations passed. CSP browser 3/3, flavor browser 13/13 (serial).
Full migration replay (147+) passes with all S96 migrations. New negative SQL/Node suites listed per commit.
Rollback: each change is an additive migration or guarded code path; revert the branch commits to restore.

---
# RECONCILIATION (canonical, HEAD 07f9d28)

## 1. Commit enumeration — 16 commits since S95 994fa5f
| # | Commit | Type |
|---|---|---|
| 1 | b4425f8 recovery token_hash | production-code fix + test |
| 2 | 2395f55 privileged MFA/session-fixation/aal2 gate | production-code fix + migration(091000) + tests |
| 3 | 4da5e2e MFA step-up wired into integrations/roles | production-code fix + tests |
| 4 | 67e9347 revoke sessions on deactivate/demote | migration(091100) + test |
| 5 | e776b4d RLS ownership/purchasing/last-admin race | migrations(090000-090300) + tests/scripts |
| 6 | 450b7c7 audit append-only/profile audit/no-40001/drift | migrations(096000-096300) + script + tests |
| 7 | 6bf47dd stock-count redaction/push/error-leak/verify_jwt | production-code fix + migration(092000) + tests |
| 8 | 9c459db AI no-retention/Phase3 redaction/AI-RAG tests | production-code fix + tests |
| 9 | ae3b4d2 supply-chain pinning/SSRF tests/rotation runbook | production-code fix(CI/pins) + tests + doc |
| 10 | 99d822b public-menu escaping | production-code fix + test |
| 11 | d9ac538 gate report + coverage matrix + A-ADMIN-01 | documentation/gate-only |
| 12 | 7d555c0 threat model + incident-response | documentation/evidence-only |
| 13 | **7321f68 strict CSP / CSV neutralisation / storage UPDATE lockdown** | production-code fix + migration(094000) + tests |
| 14 | d379f1e fold webstore into gate report | gate-report only |
| 15 | 07f9d28 reconcile Python contracts (netlify repin, menu client relocated) | regression-test/manifest change |
| 16 | 4f38a61 canonical reconciliation report (commit list, test numbers, master matrix, rollout, checklist) | documentation/gate-only |
Documentation/gate-only: #11 (d9ac538), #12 (7d555c0), #14 (d379f1e), #16 (4f38a61). Test/manifest reconciliation: #15 (07f9d28). Commits #1–#10 and #13 carry production code, migrations, or tests. (This canonical-cleanup pass is a further documentation-only commit beyond #16.)

## 2. Canonical test numbers (supersede any earlier figure)
- `npm run test:node` @ 07f9d28 → **1484 tests, 1442 pass, 0 fail, 42 skipped**.
- `python3 -m unittest discover -s tests/python` → **275 run, 1 error** (`test_sprint1_inventory`: `ModuleNotFoundError: pdfplumber`, environment-only; fails identically on the pre-S96 checkout).
- Full migration replay (`scripts/verify_full_migration_replay.sh`) → **153 migrations, passed** (141 pre-S96 + 12 S96).
- Browser: `csp-s96` 3/3, `flavor-intelligence` 13/13 run serially. The full parallel browser suite has pre-existing atlas-ai load-timing flakiness (documented, not S96-introduced).

## 5. OPSRISK-01 accounting — see the single authoritative runbook above
The OPSRISK-01 section under "The two High findings" is the one authoritative source: vulnerability present
and **High until the production fix is deployed and verified**; re-query `pg_stat_activity` and terminate only
an exact proven accounting-retry-loop PID **if present** (none at the latest read); deploy the isolated
accounting fix via the approved path; verify a bounded 409. No separate or superseding instruction exists.

## 7. Owner-only platform actions — individual checklist (each with a verification)
1. Disable public sign-up → GET /config/auth shows `disable_signup:true`.
2. Enrol Administrator + Manager application MFA (TOTP) → factors present; then set `ATLAS_REQUIRE_PRIVILEGED_MFA` and `private.auth_policy.require_privileged_mfa=true`; verify aal1 admin refused (s96_aal2_direct_backend behaviour in prod).
3. Enforce Supabase organization MFA → org setting on; all members enrolled.
4. Enforce Netlify + GitHub infra MFA → account settings show required.
5. Replace/revoke the unscoped Supabase PAT with short-lived scoped tokens → old token revoked; new token scoped.
6. Migrate off legacy JWT/service-role keys (S96_KEY_ROTATION_RUNBOOK.md) → `ATLAS_SERVICE_KEY_SOURCE=secret` on a branch, then prod, then disable legacy keys + revoke HS256 secret.
7. Delete/lock stale Supabase preview projects & branches holding production data → they no longer accept prod logins.
8. Enable persistent Auth security logs → auth.audit_log_entries populated.
9. Extend platform log retention beyond 7 days → retention setting raised.
10. Enable PITR → backups.pitr_enabled true.
11. Enable Storage backups → Storage objects covered by a backup.
12. Apply the two release-gated DB revokes (`scripts/rollout_s87_s90.sh revokes`) → managers cannot write inventory_items directly.
13. Add SPF record → dig TXT shows hardfail policy.
14. Add DKIM → selector resolves.
15. Add DMARC → dig TXT _dmarc shows policy.
16. Set Realtime to private channels only → public channel join refused.
17. Enable Postgres SSL enforcement → causes a DB restart; verify clients still connect over SSL first.
18. Apply direct DB network restrictions (least-privilege CIDR) → only required callers reach the pooler.
19. Confirm Netlify branch protection / deploy-token posture + GitHub branch protection → rules present; no fork PR secret exposure.
20. Verify live production security headers after deploy → curl -I os-vabar.netlify.app matches netlify.toml CSP/HSTS.

## 8. Ordered production rollout (do NOT execute yet — owner-run, per group)
Each group is independently reversible. Do not merge groups into one release.
- **A. App/Git deploy (Netlify frontend)** — prereq: branch reviewed. Change: deploy apps/web from this branch (strict CSP, moved scripts, escaping). Service: Netlify. Interruption: none (static). Rollback: redeploy previous. Verify: app boots, CSP has no unsafe-inline, headers match. Next: enables B.
- **B. DB migrations** — prereq: A deployed (frontend no longer writes inventory_items directly). Change: apply the 12 S96 migrations in order via Management API. Service: Postgres. Interruption: none (additive; triggers/policies). Rollback: revert migrations (each is additive; drop the added objects). Verify: 153-migration replay parity + s96 SQL suites. Next: enables C.
- **C. Edge Function deploys** — prereq: B applied (functions depend on new RLS/redaction). Change: deploy the changed functions (atlas-ai, atlas-integrations, atlas-settings, atlas-team-profiles, atlas-notifications, atlas-stock-counts, atlas-inventory-scanner, atlas-team-profile-photos, marketing-publisher) with verify_jwt unchanged (false). Service: Edge Functions. Interruption: per-function cold start. Rollback: redeploy prior versions. Verify: unauth probes 401; bartender manager-routes 403; stock-count staff redaction. Next: independent of D.
- **D. Auth configuration (MAIN-01)** — prereq: A deployed (token_hash pages live). Change: Site URL + exact Redirect URLs to production origin; update recovery/invite/magic-link/confirm/email-change templates to token_hash; remove deploy-preview-8. Service: Supabase Auth. Interruption: in-flight email links must be reissued. Rollback: restore previous URL config. Verify: recovery/invite end-to-end on production; no bearer token in any redirect. Next: independent.
- **E. Key/token rotation** — prereq: C deployed with `ATLAS_SERVICE_KEY_SOURCE` support. Change: switch to secret keys, disable legacy keys, revoke HS256 + the audit PAT. Service: all functions + API. Interruption: brief if a caller still uses legacy. Rollback: re-enable legacy keys. Verify: privileged paths work on new keys; legacy rejected. Next: independent.
- **F. Netlify/GitHub configuration** — prereq: none. Change: branch protection, deploy-token scope, fork-preview policy, delete stale previews. Service: CI/CD. Interruption: none. Rollback: restore settings. Verify: protected branch rejects direct push; previews use non-privileged config.
- **G. Backup/network/SSL** — prereq: inventory of all direct-Postgres callers proven. Change: enable PITR + Storage backup; apply network restrictions; enable SSL enforcement (DB restart). Service: Postgres/Storage. Interruption: SSL enforcement restarts the DB. Rollback: relax the setting. Verify: PITR active; only allow-listed CIDRs connect; clients use SSL.

## Canonical production status (single source of truth)
- Git security package: **complete and tested** (tests executed at commit `07f9d28`).
- Production security rollout: **not performed**.
- MAIN-01 (deploy-preview-8 Auth redirect): **High / open**.
- OPSRISK-01 (accounting 40001): **High / open**.
- Current stuck accounting connection: **none observed at latest read**; re-check `pg_stat_activity` before any termination.
- S96 production migrations: **not applied**.
- S96 Edge Function fixes: **not deployed**.
- Auth / platform owner actions: **outstanding** (gate §7 checklist).
- Documentation HEAD of this canonical package: `claude/s96-security-hardening` tip (this cleanup commit).
- **Gate: OWNER ACTION REQUIRED.**
