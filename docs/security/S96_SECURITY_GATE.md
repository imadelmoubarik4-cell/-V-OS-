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

### OPSRISK-01 — High — ACCOUNTING DEPLOYED SOURCE — live PostgREST retry loop
`public.atlas_accounting_command` raises SQLSTATE 40001 on a stale edit; PostgREST treats it as retryable
and retries forever, pinning a pooled DB connection (observed active since 2026-09-26; ~8.3–8.6M errors/day
from one connection). A few such stale commands take the Data API down.
- Git fix committed for the in-repo catalogue/marketing variants (PT409, 450b7c7). The accounting variant
  is prepared as an ISOLATED patch (not applied; PR #93 untouched) — `isolated-ACCOUNTING-01-no-40001-retry-loop.diff`.
- OWNER ACTIONS: (1) terminate the stuck backend now (pg_terminate_backend on the active
  atlas_accounting_command PID); (2) decide the integration path for the accounting fix and deploy it
  (this is production accounting code of PR #93 lineage — I did not modify or deploy it).

## Could-be-High UNVERIFIED (must be resolved or owner-accepted before READY)
- C17 live-site source maps / C19 stale-host takeover / deploy-preview-8 ownership — blocked by this
  session's egress policy (os-vabar.netlify.app CONNECT 403). Owner or an unrestricted network must verify.
- Frontend classes C35 (token exposure), C36 (postMessage), C37 (third-party JS) and storage-serving/N8
  signed-URL/N17 downgrade — the webstore specialist did not deliver a full report; these are UNVERIFIED
  and could_be_high until completed. (netlify.toml already ships a strict CSP, HSTS, frame-ancestors,
  nosniff, Referrer-Policy, Permissions-Policy; AI output escaping is CONTROL VERIFIED by aioauth.)
- N10 CI/CD: GitHub branch protection, Netlify deploy tokens/fork-preview policy, artifact retention —
  not readable with available tooling; owner must confirm.

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
Node: 1435 pass / 0 fail. Python: only the pre-existing pdfplumber-missing environment error.
Full migration replay (147+) passes with all S96 migrations. New negative SQL/Node suites listed per commit.
Rollback: each change is an additive migration or guarded code path; revert the branch commits to restore.
