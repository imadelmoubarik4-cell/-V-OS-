# S96 Master Security Matrix (canonical)

- **Canonical documentation HEAD:** `4f38a61` and later doc-only commits on `claude/s96-security-hardening`.
- **Tests were executed at commit `07f9d28`** (the last commit that changed code/tests/manifests). Doc-only
  commits after it did not change any executable code, so the results below still hold; they were **not** re-run
  at the documentation HEAD.
- One row per control. Status is normalized to exactly one of: **CONTROL VERIFIED**, **VULNERABLE**,
  **NOT APPLICABLE**, **UNVERIFIED**. A fixed-but-undeployed issue is **VULNERABLE (in production; fixed on
  branch)** — the branch carries the fix and its test, but production still has the flaw until deployed.
- `could_be_high` is TRUE only where an unresolved item could still prove High.

## A. Attack classes
C21–C30 were never defined as attack-class IDs (those numbers belong to the "hardening controls 1–30" list in
section B); every attack-class ID that WAS defined (C1–C20, C31–C44) has a row here.

| ID | Class | Surface | Status | could_be_high | Evidence / final disposition |
|---|---|---|---|---|---|
| C1 | CSRF | WEB/FUNC | CONTROL VERIFIED | false | Bearer-token auth, no cookies; verified edgea+aioauth. No meaningless tokens added. |
| C2 | Insecure file uploads | FUNC/STORAGE | VULNERABLE (fixed on branch) | false | EDGEA-06 photo body parsed before size check → fixed 6bf47dd; recognition MIME/magic/size CV. |
| C3 | Path traversal / object-key manipulation | FUNC/STORAGE | CONTROL VERIFIED | false | Storage keys server-generated; traversal rejected (edgea, aioauth, webstore probes). |
| C4 | SSRF | FUNC/AI | CONTROL VERIFIED | false | Consolidated in C44; only dormant push endpoint (fixed on branch 6bf47dd). |
| C5 | Reset / invite / magic-link / email-change | AUTH | VULNERABLE (fixed on branch + owner) | false | Recovery → token_hash on our origin (b4425f8); invite/magic/confirm/email-change templates = owner action (MAIN-01 §D). |
| C6 | Session management | AUTH/WEB | VULNERABLE (fixed on branch + owner) | false | Fixation fixed 2395f55; session revocation on deactivate/demote 67e9347; timebox/inactivity = owner action. |
| C7 | JWT / signing secrets | PLATFORM | VULNERABLE (owner action) | false | Forged-token battery rejected (CV); legacy HS256+anon/service_role keys still trusted → rotation owner action (runbook). |
| C8 | CORS | FUNC | CONTROL VERIFIED | false | `*` with no credentials on bearer-only APIs; verified edgea+aioauth. |
| C9 | Rate limits / abuse | FUNC/AI/AUTH | VULNERABLE (partly fixed on branch; owner) | false | DoS-via-retry fixed 450b7c7; per-user AI/upload/message limits missing (EDGEA-07/AIOAUTH) = owner; Auth limits vendor-managed. |
| C10 | Exposed preview/test/staging | PLATFORM | VULNERABLE (owner action) | false | OPSRISK-05 stale preview projects hold prod data and accept prod logins. |
| C11 | Default credentials / test accounts | PLATFORM | VULNERABLE (owner action) | false | OPSRISK-10 sole admin is the acceptance-test account; AUTHN-01 public signup. |
| C12 | Unsigned / unverified webhooks | FUNC | CONTROL VERIFIED | false | All 26 functions enumerated; no inbound third-party webhook exists. |
| C13 | Frontend-only payment/entitlement | — | NOT APPLICABLE | false | No billing/subscription boundary in Atlas (secsupply). |
| C14 | IDOR / BOLA | DB/FUNC | VULNERABLE (fixed on branch) | false | DBRLS-01..03, EDGEA-01 fixed (e776b4d/6bf47dd); core RLS/IDOR CV. |
| C15 | Client-supplied security-sensitive fields | DB/FUNC | VULNERABLE (fixed on branch) | false | DBRLS-04/05, OPSRISK-08 fixed; service-role actor from verified session (CV). |
| C16 | Sensitive data in logs | FUNC/AI | CONTROL VERIFIED | false | No secrets/PII/tokens logged across 26 functions + frontend. |
| C17 | Source maps / build artifacts | WEB | CONTROL VERIFIED (preview) / UNVERIFIED (live) | false | preview-103 + backend clean; live os-vabar egress-blocked here → owner re-check post-deploy. |
| C18 | Cache poisoning / authenticated caching | WEB/FUNC | CONTROL VERIFIED | false | Functions no-store + Vary: authorization; pages max-age=0. |
| C19 | Stale preview / subdomain takeover | PLATFORM | UNVERIFIED | **true** | deploy-preview-8 host ownership egress-blocked (MAIN-01); owner must verify. |
| C20 | Prototype pollution / unsafe merge | WEB/FUNC/AI | CONTROL VERIFIED | false | Clean (webstore, edgea, aioauth). |
| C31 | Netlify/Supabase infrastructure | PLATFORM | VULNERABLE (owner action) | false | SSL-off, DB network 0.0.0.0/0, org MFA off, PITR off — owner checklist (gate §7); rated per credential requirement. |
| C32 | Auth-link poisoning / open redirects | AUTH/WEB | CONTROL VERIFIED | false | No open-redirect params; redirectTo exact; the Auth-config redirect is MAIN-01 (tracked separately). |
| C33 | Email scanner / link prefetch safety | AUTH | CONTROL VERIFIED | false | Recovery/invite via single-use token_hash; detectSessionInUrl off; no session created by a GET prefetch. |
| C34 | Password hardening | PLATFORM | CONTROL VERIFIED | false | min 10, HIBP on, reauth+current-password on. NIST composition rules are Informational (AUTHN-11). |
| C35 | Session / token exposure | WEB | CONTROL VERIFIED | false | No token in URL/history/referrer/logs; localStorage tokens are XSS-gated, mitigated by strict CSP + escaping. |
| C36 | postMessage / cross-window | WEB | CONTROL VERIFIED | false | No postMessage handler renders HTML or trusts `*` (webstore). |
| C37 | Third-party JavaScript / browser supply chain | WEB/CI | VULNERABLE (fixed on branch) | false | CSP 'unsafe-inline'/blob: dropped 7321f68; actions pinned + SRI ae3b4d2; live-header verify = owner. |
| C38 | Indirect AI prompt injection | AI | CONTROL VERIFIED | false | Tool authz server-side; injection.mjs; approval re-validated (aioauth). |
| C39 | AI / RAG cross-role leakage | AI | CONTROL VERIFIED | false | Retrieval authorized before generation; verify_s96_knowledge_search_visibility.sql. |
| C40 | Alternate Supabase interfaces | PLATFORM | CONTROL VERIFIED | false | REST/RPC/Storage/Realtime reviewed; no S3/db-webhooks; GraphQL schema public — owner may restrict if unused. |
| C41 | Postgres extensions / privileged capabilities | DB | CONTROL VERIFIED | false | vault empty; pg_net/pg_cron absent; no outbound-capable ext reachable by anon/authenticated. |
| C42 | Non-production data isolation | PLATFORM | VULNERABLE (owner action) | false | OPSRISK-05 stale preview projects hold real data. |
| C43 | Security detection / alerting | PLATFORM | VULNERABLE (owner action) | false | OPSRISK-09 auth events not persisted; no alerting. security_audit_events added 450b7c7 (DB side). |
| C44 | SSRF incl. stored & AI-assisted | FUNC/AI | CONTROL VERIFIED | false | 23 sinks; only dormant push endpoint (fixed on branch 6bf47dd); s96-ssrf-egress-gate. |

## B. Hardening controls 1–30 (all 30 present)

| # | Control | Surface | Status | could_be_high | Evidence / test | Fix or owner action |
|---|---|---|---|---|---|---|
| 1 | Password-change security (reauth, notifications, session survival) | AUTH | CONTROL VERIFIED | false | reauth+current-password on; recovery global sign-out | owner: enable change/MFA email notifications |
| 2 | HTTPS everywhere | WEB/PLATFORM | CONTROL VERIFIED | false | all endpoints https; no mixed content | — |
| 3 | HSTS | WEB | VULNERABLE (fixed on branch) | false | netlify.toml HSTS; includeSubDomains removed 7321f68 | deploy; owner verify live header |
| 4 | CSRF | WEB/FUNC | CONTROL VERIFIED | false | bearer-only; edgea/aioauth | — |
| 5 | Session revocation after credential change | AUTH/DB | VULNERABLE (fixed on branch) | false | s96_session_revocation.sql; 67e9347 | deploy |
| 6 | Reset-link expiry / one-time use | AUTH | CONTROL VERIFIED | false | GoTrue single-use + token_hash flow | — |
| 7 | User enumeration | AUTH | CONTROL VERIFIED | false | neutral responses (code+config); prod not probed by rule | — |
| 8 | Upload allow-list (MIME/magic/size/name) | FUNC/STORAGE | VULNERABLE (fixed on branch) | false | 6bf47dd + storage 7321f68; recognition CV | deploy |
| 9 | Webhook verification | FUNC | CONTROL VERIFIED | false | no inbound webhook exists | — |
| 10 | Server-authoritative financial values | DB/FUNC | CONTROL VERIFIED | false | accounting/RPC server-side; payments NA | — |
| 11 | XSS / CSP defense in depth | WEB | VULNERABLE (fixed on branch) | false | menu escaping 99d822b; strict CSP 7321f68; 3,459-payload sweep clean | deploy |
| 12 | AI usage caps | AI | VULNERABLE (partly fixed; owner) | false | recognition capped (CV); voice metering bypass AIOAUTH-01 | owner: OpenAI project budget; server-held voice call |
| 13 | Request-body limits | FUNC/AI | VULNERABLE (fixed on branch) | false | photo size fixed 6bf47dd; AI/integrations CV | deploy |
| 14 | Password-reset rate limiting | AUTH | UNVERIFIED | false | vendor limits; not probed per rules | owner: confirm GoTrue limits / add captcha |
| 15 | Input validation | DB/FUNC/AI | CONTROL VERIFIED | false | type/length/format; output-context encoding | — |
| 16 | CORS lockdown | FUNC | CONTROL VERIFIED | false | bearer-only; narrow methods | — |
| 17 | Directory / index exposure | WEB | CONTROL VERIFIED (preview) / UNVERIFIED (live) | false | preview-103 .env/.git/config 404 | owner: verify live host post-deploy |
| 18 | Default-admin / maintenance surfaces | PLATFORM/FUNC | VULNERABLE (owner action) | false | OPSRISK-10 test admin; maintenance routes CV | owner: replace acceptance-admin account |
| 19 | Failed-login abuse protection | AUTH | UNVERIFIED | false | Supabase vendor limits; no DoS-lockout by design | owner: confirm limits / captcha |
| 20 | Security-event logging | DB/PLATFORM | VULNERABLE (fixed on branch + owner) | false | profile-access audit 450b7c7 | owner: persist auth events, extend retention |
| 21 | Cookie hardening | WEB | NOT APPLICABLE | false | bearer-only, no auth cookie; OAuth binding cookie is __Host- Secure HttpOnly (CV) | — |
| 22 | Database least privilege | DB | VULNERABLE (fixed on branch + owner) | false | dbrls revokes e776b4d | owner: apply 2 release-gated revokes (DBRLS-07) |
| 23 | MFA for privileged accounts | AUTH/DB | VULNERABLE (fixed on branch) | false | 2395f55; s96_aal2_direct_backend.sql | deploy; owner enrol + set mandatory |
| 24 | Reauthentication for dangerous actions | FUNC | VULNERABLE (fixed on branch) | false | 4da5e2e; s96-mfa-step-up | deploy; owner set ATLAS_REQUIRE_STEP_UP |
| 25 | Security headers | WEB | VULNERABLE (fixed on branch) | false | 7321f68 CSP/COOP/HSTS | deploy; owner verify live |
| 26 | Secret rotation & blast radius | PLATFORM | VULNERABLE (owner action) | false | S96_KEY_ROTATION_RUNBOOK.md | owner: rotate legacy keys + PAT |
| 27 | Backup & restore proof | PLATFORM | VULNERABLE (owner action) | false | restore drill done; PITR off, Storage unbacked | owner: enable PITR + Storage backup |
| 28 | Privileged session controls | AUTH | VULNERABLE (owner action) | false | timebox/inactivity 0 | owner: set inactivity 12h / timebox 7d |
| 29 | Egress / SSRF allow-listing | FUNC/AI | CONTROL VERIFIED | false | C44 gate; s96-ssrf-egress-gate | — |
| 30 | Tamper-resistant audit history | DB | VULNERABLE (fixed on branch) | false | append-only 450b7c7; s96_audit_append_only_test.sql | deploy |

## C. Whole-system controls N1–N20 (all 20 present)

| # | Control | Surface | Status | could_be_high | Evidence / fix or owner action |
|---|---|---|---|---|---|
| N1 | Realtime / WebSocket authorization | DB | CONTROL VERIFIED (data) | false | supabase_realtime publication empty; owner: set private channels (DBRLS-10) |
| N2 | Cron / queues / background workers | FUNC | CONTROL VERIFIED | false | import-worker 503, publisher gated, AI-maint secret unset |
| N3 | Venue / tenant isolation | DB | NOT APPLICABLE | false | single-tenant; no venue column; do not add a 2nd venue to this project |
| N4 | Race conditions / TOCTOU | DB | VULNERABLE (fixed on branch) | false | last-admin race 090300; verify_s96_races.sh 4/4 |
| N5 | Idempotency of dangerous writes | DB/FUNC | CONTROL VERIFIED | false | request-id dedupe; single approval |
| N6 | CSV / Excel formula injection | FUNC/WEB | VULNERABLE (fixed on branch) | false | exports neutralised 7321f68; csv-formula-injection-s96 |
| N7 | Archive / document / image bombs | FUNC | CONTROL VERIFIED | false | recognition never server-decodes; size-capped |
| N8 | Signed URL security | STORAGE | CONTROL VERIFIED (Low residual) | false | tokens bound to one object; profile-photo TTL 6h (owner may shorten) |
| N9 | MFA recovery / break-glass | PLATFORM | UNVERIFIED | false | no process yet; 0 enrolled; owner: define per runbook |
| N10 | CI/CD & deployment takeover | CI | VULNERABLE (partly fixed; owner) | false | actions pinned ae3b4d2; branch-protection/Netlify tokens owner-confirm |
| N11 | Data export / mass exfiltration | FUNC/PLATFORM | VULNERABLE (owner action) | false | export endpoints CV; volume/audit controls owner action (OPSRISK-N11) |
| N12 | Backup confidentiality | PLATFORM | VULNERABLE (owner action) | false | OPSRISK-N12; owner: protect backups/no public artifacts |
| N13 | Search / index leakage | AI | CONTROL VERIFIED | false | verify_s96_knowledge_search_visibility.sql |
| N14 | Notification privacy | FUNC | VULNERABLE (latent; owner) | false | EDGEA-08 push payload full text; delivery disabled; push-policy 6bf47dd |
| N15 | Domain / email security (SPF/DKIM/DMARC) | PLATFORM | VULNERABLE (owner action) | false | no DMARC, SPF softfail (OPSRISK-14) |
| N16 | Migration / production drift detection | PLATFORM | VULNERABLE (owner action) | false | drift script added 450b7c7; owner: run in CI |
| N17 | Security downgrade / old clients | WEB | CONTROL VERIFIED (server) / UNVERIFIED (old previews) | false | server boundary enforces; old previews egress-blocked |
| N18 | Delete / disable semantics | DB/AUTH | VULNERABLE (fixed on branch) | false | session revocation 67e9347; s96_session_revocation.sql |
| N19 | Error-message / data leakage | FUNC/AI | VULNERABLE (fixed on branch) | false | 6bf47dd/9c459db; s96-edge-db-error-leakage, s96-phase3-db-errors |
| N20 | Denial-of-wallet | FUNC/AI | VULNERABLE (partly fixed; owner) | false | recognition capped; voice AIOAUTH-01; owner: provider budget |

## D. Named scenarios and the two open Highs

| Item | Surface | Status | could_be_high | Evidence / action |
|---|---|---|---|---|
| A-ADMIN-01 low-priv → admin | ALL | CONTROL VERIFIED | false | every boundary proven — docs/security/S96_A-ADMIN-01.md |
| MAIN-01 deploy-preview-8 Auth redirect | PLATFORM | VULNERABLE / **High / open** | **true** | recovery mitigated b4425f8; owner: verify host + fix Site URL/redirects/templates end-to-end |
| OPSRISK-01 accounting 40001 loop | ACCOUNTING DEPLOYED | VULNERABLE / **High / open** | n/a (present in prod) | catalogue/mktg fixed 450b7c7; accounting = isolated patch; owner: deploy via approved path + verify bounded 409 (see gate §5) |

## Reconciliation notes
- **16 commits** since 994fa5f. Documentation/gate-only: `d9ac538`, `7d555c0`, `d379f1e`, `4f38a61`.
  Test/manifest reconciliation: `07f9d28`. The other 11 carry production code, migrations and tests. Full
  classified list in `docs/security/S96_SECURITY_GATE.md` §1.
- **Tests executed at `07f9d28`** (not re-run for later doc-only commits): node 1484 total / 1442 pass / 0 fail
  / 42 skipped; Python 275 run / 1 environment-only error (pdfplumber missing); migration replay 153 passed;
  CSP browser 3/3; flavor browser 13/13 serial.
