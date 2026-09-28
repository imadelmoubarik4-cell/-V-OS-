# S96 Master Security Matrix

Canonical at HEAD `07f9d28` (branch `claude/s96-security-hardening`). One row per control from the
master reconciliation. Status is the strongest disposition across agents; VULNERABLE items are fixed
on-branch at the listed commit unless marked owner-action. `could_be_high` shown only where an agent set it.

Legend: CV=CONTROL VERIFIED, V=VULNERABLE(→fixed on-branch), NA=NOT APPLICABLE, UNV=UNVERIFIED.


## A. Attack classes C1–C44

| Control | Disposition (agent:status) | could_be_high | Fix commit(s) |
|---|---|---|---|
| C1 CSRF | edgea:CONTROL VERIFIED; aioauth:CONTROL VERIFIED | - | - |
| C1 CSRF (frontend) | webstore:CONTROL VERIFIED | False | - |
| C10 exposed preview/test/staging environments | opsrisk:VULNERABLE | - | 450b7c7 |
| C11 XSS (stored/reflected/DOM, AI output) | webstore:VULNERABLE | False | 99d822b/7321f68 |
| C11 default credentials / sample accounts / bootstrap secrets | opsrisk:VULNERABLE | - | 450b7c7 |
| C12 webhook-like routes | edgea:CONTROL VERIFIED | - | - |
| C12 webhooks (enumeration of all inbound unauthenticated-by-design | aioauth:CONTROL VERIFIED | - | - |
| C13 payment/billing/entitlement enforcement | secsupply:NOT APPLICABLE | - | - |
| C14 IDOR/BOLA | dbrls:VULNERABLE; dbrls:CONTROL VERIFIED (DB layer by review; live exercise not possible: objects absent from repo replay); edgea:VULNERABLE (Medium:  | - | e776b4d |
| C15 client-supplied audit fields (mass assignment) | opsrisk:VULNERABLE | - | 450b7c7 |
| C15 client-supplied role/ids/prices/approval/ownership | dbrls:VULNERABLE; dbrls:CONTROL VERIFIED (review) | - | e776b4d |
| C15 client-supplied sensitive fields | edgea:VULNERABLE (Low: EDGEA-05 stock-count evidence); others CONTROL VERIFIED | - | 6bf47dd |
| C15 trusting client-supplied security fields / mass assignment | aioauth:CONTROL VERIFIED | - | - |
| C16 secrets/PII in logs | edgea:CONTROL VERIFIED (Informational EDGEA-16) | - | - |
| C16 sensitive data in logs | opsrisk:CONTROL VERIFIED | - | - |
| C16 sensitive data in logs (AI and integrations code) | aioauth:CONTROL VERIFIED | - | - |
| C17 source maps / build metadata | secsupply:CONTROL VERIFIED; secsupply:CONTROL VERIFIED | - | - |
| C17 source maps / build metadata (live site) | secsupply:UNVERIFIED (egress policy: CONNECT to os-vabar.netlify.app returns 403 from this session's proxy) | False | - |
| C17 source maps/debug bundles/stack traces/build metadata | secsupply:CONTROL VERIFIED | - | - |
| C17 stack traces / internal detail in function error responses | secsupply:CONTROL VERIFIED | - | - |
| C18 authenticated-response caching | edgea:CONTROL VERIFIED | - | - |
| C18 cache poisoning / authenticated caching | webstore:CONTROL VERIFIED | False | - |
| C19 stale-preview takeover (auth side) | authn:VULNERABLE pending host verification | False | 2395f55/4da5e2e/67e9347 |
| C19 subdomain / stale-preview takeover | opsrisk:UNVERIFIED (netlify.app and chatgpt.site HTTP blocked by egress policy; DNS resolves for all) | True | - |
| C2 insecure uploads | edgea:CONTROL VERIFIED; edgea:CONTROL VERIFIED; edgea:VULNERABLE (Low: body parsed before size check, EDGEA-06); type control verified; edgea:CONTROL  | - | 6bf47dd |
| C2 insecure uploads (inventory recognition; also atlas-ai upload) | aioauth:CONTROL VERIFIED | - | - |
| C2 insecure uploads (storage policies/serving) | webstore:VULNERABLE | False | 99d822b/7321f68 |
| C20 prototype pollution | edgea:CONTROL VERIFIED | - | - |
| C20 prototype pollution (frontend) | webstore:CONTROL VERIFIED | False | - |
| C20 prototype pollution / unsafe merge | aioauth:CONTROL VERIFIED | - | - |
| C3 object-key / path manipulation | webstore:VULNERABLE | False | 99d822b/7321f68 |
| C3 path traversal / object keys | aioauth:CONTROL VERIFIED | - | - |
| C3 path/object-key manipulation | edgea:CONTROL VERIFIED | - | - |
| C32-C37 | webstore:UNVERIFIED (class text not provided to webstore) | False | - |
| C4 SSRF | edgea:VULNERABLE (latent, Low: EDGEA-03 push endpoint); others CONTROL VERIFIED; aioauth:VULNERABLE | - | 6bf47dd |
| C44 dedicated SSRF / outbound-network gate (ADDENDUM 8; extends C4 | ssrf:CONTROL VERIFIED (with one dormant VULNERABLE: SSRF-01 push endpoint, = EDGEA-03/AIOAUTH-05, delivery disabled, fixed by edgea patch 03) | - | (covered by 6bf47dd) |
| C5 reset/invite/magic/email-change | authn:VULNERABLE (Low/Medium, config) | False | 2395f55/4da5e2e/67e9347 |
| C6 session management | authn:VULNERABLE (Low) | False | 2395f55/4da5e2e/67e9347 |
| C7 JWT | authn:CONTROL VERIFIED | False | - |
| C7 JWT: legacy/weak secrets and key rotation (legacy-key portion) | secsupply:VULNERABLE | - | ae3b4d2 |
| C8 CORS | edgea:CONTROL VERIFIED; aioauth:CONTROL VERIFIED | - | - |
| C9 Auth rate limits | authn:UNVERIFIED (not probed per rules; vendor limits documented) | False | - |
| C9 rate limits | edgea:VULNERABLE (Low: EDGEA-07) | False | 6bf47dd |
| C9 rate limits (AI and integrations) | aioauth:VULNERABLE | - | 9c459db |
| C9 rate limits (DB-side primitives) | dbrls:NOT APPLICABLE (not my class) | - | - |
| C9 rate limits (DoS via PostgREST retry) | opsrisk:VULNERABLE | - | 450b7c7 |
| Phase 11: supply chain (npm, Deno, CI, CDN) | secsupply:VULNERABLE | - | ae3b4d2 |
| Phase 6: secrets in Git history (all refs) | secsupply:CONTROL VERIFIED | - | - |

## B. Hardening controls 1–30

| Control | Disposition (agent:status) | could_be_high | Fix commit(s) |
|---|---|---|---|
| 10 Server-authoritative financial values (accounting) | edgea:ALREADY VERIFIED | - | - |
| 10 Server-authoritative prices/financial values | dbrls:REQUIRED | False | - |
| 10 Server-authoritative prices/financial values — payments portion | secsupply:NOT APPLICABLE | False | - |
| 11 XSS incl. AI/imported content; CSP | webstore:REQUIRED | False | - |
| 12 AI usage caps | aioauth:REQUIRED | False | - |
| 13 Request-body limits | edgea:REQUIRED | False | - |
| 13 Request-body limits (AI, integrations, recognition) | aioauth:ALREADY VERIFIED | False | - |
| 15 Input validation | edgea:ALREADY VERIFIED | - | - |
| 15 Input validation (AI and integrations) | aioauth:ALREADY VERIFIED | False | - |
| 15 Input validation (DB-side) | dbrls:ALREADY VERIFIED | False | - |
| 16 CORS lockdown | edgea:ALREADY VERIFIED | - | - |
| 16 CORS lockdown (AI and integrations) | aioauth:ALREADY VERIFIED | False | - |
| 17 Directory/index exposure | secsupply:ALREADY VERIFIED; secsupply:OWNER ACTION REQUIRED | False; False | - |
| 18 Default-admin / maintenance surfaces (AI maintenance routes) | aioauth:ALREADY VERIFIED | False | - |
| 18 Default-admin / maintenance surfaces (functions) | edgea:ALREADY VERIFIED | - | - |
| 18 Default-admin surfaces (default routes, demo logins, test creds | opsrisk:OWNER ACTION REQUIRED | False | - |
| 2 HTTPS everywhere | webstore:ALREADY VERIFIED | False | - |
| 2 HTTPS everywhere (integration URLs) | aioauth:ALREADY VERIFIED | False | - |
| 20 Security-event logging | opsrisk:REQUIRED | False | - |
| 21 Cookie hardening | webstore:NOT APPLICABLE | False | - |
| 22 Database least privilege | dbrls:REQUIRED | False | - |
| 25 Security headers | webstore:REQUIRED | False | - |
| 26 Secret rotation & blast radius | secsupply:REQUIRED | False | - |
| 27 Backup & restore proof | opsrisk:OWNER ACTION REQUIRED | False | - |
| 29 Egress/SSRF allow-listing | edgea:REQUIRED | False | - |
| 29 Egress/SSRF allow-listing (AI and integrations) | aioauth:REQUIRED | False | - |
| 3 HSTS on production domain | webstore:REQUIRED | False | - |
| 30 Tamper-resistant audit history | opsrisk:REQUIRED; dbrls:REQUIRED | False; False | - |
| 4 CSRF inventory | edgea:ALREADY VERIFIED | - | - |
| 4 CSRF inventory (AI and integrations) | aioauth:ALREADY VERIFIED | False | - |
| 4 CSRF inventory (frontend) | webstore:ALREADY VERIFIED | False | - |
| 8 Upload allow-list | edgea:REQUIRED | False | - |
| 8 Upload allow-list (buckets) | webstore:REQUIRED | False | - |
| 8 Upload allow-list (inventory recognition) | aioauth:ALREADY VERIFIED | False | - |
| 9 Webhook verification | aioauth:ALREADY VERIFIED | False | - |
| N1 Realtime/WebSocket authorization | dbrls:CONTROL VERIFIED (data) / UNVERIFIED live channel join | False | - |
| N10 CI/CD and deployment takeover — GitHub Actions | secsupply:VULNERABLE | False | ae3b4d2 |
| N10 CI/CD and deployment takeover — Netlify deploy tokens and PR p | secsupply:UNVERIFIED (no Netlify API access) | False | - |
| N10 CI/CD and deployment takeover — Supabase tokens / who can depl | secsupply:VULNERABLE | False | ae3b4d2 |
| N10 CI/CD and deployment takeover — artifact retention | secsupply:UNVERIFIED (artifact contents not downloaded) | False | - |
| N10 CI/CD and deployment takeover — branch protection / who can me | secsupply:UNVERIFIED (protection rule details not readable with available read-only tools) | False | - |
| N11 Data export / mass-exfiltration controls | opsrisk:VULNERABLE | False | 450b7c7 |
| N11 Export endpoints / mass exfiltration | edgea:CONTROL VERIFIED | - | - |
| N12 Backup confidentiality | opsrisk:VULNERABLE | False | 450b7c7 |
| N13 Browser search caches | webstore:UNVERIFIED (code review only; no attack test) | False | - |
| N13 Search/index leakage (Atlas AI, Knowledge search, Reports) | aioauth:CONTROL VERIFIED | False | - |
| N14 Notification privacy | edgea:VULNERABLE (latent, Low: EDGEA-08) | False | 6bf47dd |
| N15 Domain and email security | opsrisk:VULNERABLE | False | 450b7c7 |
| N16 Migration/production drift detection | opsrisk:VULNERABLE | False | 450b7c7 |
| N17 Security downgrade (old frontends / stale previews) | webstore:UNVERIFIED (egress policy blocks all previews except 103 and production) | False | - |
| N18 Delete/disable semantics (Auth side) | authn:VULNERABLE (Low) -> fixed by patch 04. Data access loss was already CONTROL VERIFIED. | False | 2395f55/4da5e2e/67e9347 |
| N18 Delete/disable semantics (DB side) | dbrls:CONTROL VERIFIED | False | - |
| N19 Error-message/data leakage | edgea:VULNERABLE (Low: EDGEA-04) | False | 6bf47dd |
| N19 Error/data leakage (AI) | aioauth:VULNERABLE | False | 9c459db |
| N2 Cron, queues, background workers | edgea:CONTROL VERIFIED | - | - |
| N20 Denial-of-wallet | edgea:VULNERABLE (Low: EDGEA-07) | False | 6bf47dd |
| N20 Denial-of-wallet (AI chat, voice, recognition, flavor) | aioauth:VULNERABLE | False | 9c459db |
| N3 Venue/tenant isolation | dbrls:NOT APPLICABLE (single-tenant by design; documented risk) | False | - |
| N4 Race conditions/TOCTOU | dbrls:VULNERABLE (fixed in patch) | False | e776b4d |
| N5 Idempotency of dangerous writes | edgea:CONTROL VERIFIED | - | - |
| N5 Idempotency of dangerous writes (DB) | dbrls:CONTROL VERIFIED (except v1 adjust_inventory) | False | - |
| N6 CSV formula injection (frontend CSV builders) | webstore:VULNERABLE | False | 99d822b/7321f68 |
| N6 CSV/Excel formula injection (server exports) | edgea:CONTROL VERIFIED | - | - |
| N7 Archive/document/image bombs | edgea:CONTROL VERIFIED | - | - |
| N7 Image/decompression bombs (inventory recognition; also atlas-ai | aioauth:CONTROL VERIFIED | False | - |
| N8 Signed URL security | webstore:VULNERABLE | False | 99d822b/7321f68 |
| N9 MFA recovery / break-glass admin recovery | authn:UNVERIFIED (no recovery process exists yet; nobody is enrolled, so nothing to recover today) | False | - |

## C. Whole-system controls N1–N20

| Control | Disposition (agent:status) | could_be_high | Fix commit(s) |
|---|---|---|---|
| N1 Realtime/WebSocket authorization | dbrls:CONTROL VERIFIED (data) / UNVERIFIED live channel join | False | - |
| N10 CI/CD and deployment takeover — GitHub Actions | secsupply:VULNERABLE | False | ae3b4d2 |
| N10 CI/CD and deployment takeover — Netlify deploy tokens and PR p | secsupply:UNVERIFIED (no Netlify API access) | False | - |
| N10 CI/CD and deployment takeover — Supabase tokens / who can depl | secsupply:VULNERABLE | False | ae3b4d2 |
| N10 CI/CD and deployment takeover — artifact retention | secsupply:UNVERIFIED (artifact contents not downloaded) | False | - |
| N10 CI/CD and deployment takeover — branch protection / who can me | secsupply:UNVERIFIED (protection rule details not readable with available read-only tools) | False | - |
| N11 Data export / mass-exfiltration controls | opsrisk:VULNERABLE | False | 450b7c7 |
| N11 Export endpoints / mass exfiltration | edgea:CONTROL VERIFIED | - | - |
| N12 Backup confidentiality | opsrisk:VULNERABLE | False | 450b7c7 |
| N13 Browser search caches | webstore:UNVERIFIED (code review only; no attack test) | False | - |
| N13 Search/index leakage (Atlas AI, Knowledge search, Reports) | aioauth:CONTROL VERIFIED | False | - |
| N14 Notification privacy | edgea:VULNERABLE (latent, Low: EDGEA-08) | False | 6bf47dd |
| N15 Domain and email security | opsrisk:VULNERABLE | False | 450b7c7 |
| N16 Migration/production drift detection | opsrisk:VULNERABLE | False | 450b7c7 |
| N17 Security downgrade (old frontends / stale previews) | webstore:UNVERIFIED (egress policy blocks all previews except 103 and production) | False | - |
| N18 Delete/disable semantics (Auth side) | authn:VULNERABLE (Low) -> fixed by patch 04. Data access loss was already CONTROL VERIFIED. | False | 2395f55/4da5e2e/67e9347 |
| N18 Delete/disable semantics (DB side) | dbrls:CONTROL VERIFIED | False | - |
| N19 Error-message/data leakage | edgea:VULNERABLE (Low: EDGEA-04) | False | 6bf47dd |
| N19 Error/data leakage (AI) | aioauth:VULNERABLE | False | 9c459db |
| N2 Cron, queues, background workers | edgea:CONTROL VERIFIED | - | - |
| N20 Denial-of-wallet | edgea:VULNERABLE (Low: EDGEA-07) | False | 6bf47dd |
| N20 Denial-of-wallet (AI chat, voice, recognition, flavor) | aioauth:VULNERABLE | False | 9c459db |
| N3 Venue/tenant isolation | dbrls:NOT APPLICABLE (single-tenant by design; documented risk) | False | - |
| N4 Race conditions/TOCTOU | dbrls:VULNERABLE (fixed in patch) | False | e776b4d |
| N5 Idempotency of dangerous writes | edgea:CONTROL VERIFIED | - | - |
| N5 Idempotency of dangerous writes (DB) | dbrls:CONTROL VERIFIED (except v1 adjust_inventory) | False | - |
| N6 CSV formula injection (frontend CSV builders) | webstore:VULNERABLE | False | 99d822b/7321f68 |
| N6 CSV/Excel formula injection (server exports) | edgea:CONTROL VERIFIED | - | - |
| N7 Archive/document/image bombs | edgea:CONTROL VERIFIED | - | - |
| N7 Image/decompression bombs (inventory recognition; also atlas-ai | aioauth:CONTROL VERIFIED | False | - |
| N8 Signed URL security | webstore:VULNERABLE | False | 99d822b/7321f68 |
| N9 MFA recovery / break-glass admin recovery | authn:UNVERIFIED (no recovery process exists yet; nobody is enrolled, so nothing to recover today) | False | - |

## D. Named scenarios and infrastructure (one row each)

| Item | Surface | Status | Sev | Attack path / evidence | Negative test | Fix commit | Production action | could_be_high |
|---|---|---|---|---|---|---|---|---|
| A-ADMIN-01 low-priv→admin | ALL | CONTROL VERIFIED | — | every boundary proven (docs/security/S96_A-ADMIN-01.md) | s96_aal2_direct_backend.sql, s96_authn_gates.sql, s96_rls_ownership.sql, s96-aioauth-security | e776b4d/2395f55/6bf47dd | deploy branch | false |
| MFA/AAL2 for admin/manager | PROD BACKEND+DB | V→fixed | Med | AUTHN-02: no aal check; enrolled aal1 refused after fix | s96-mfa-step-up, s96_aal2_direct_backend.sql, s96_authn_gates.sql | 2395f55 | deploy + owner enrol MFA, then set mandatory | false |
| Step-up for dangerous actions | PROD BACKEND | V→fixed | Low | AUTHN-05: role/integration/secret changes | s96-mfa-step-up | 4da5e2e | deploy + set ATLAS_REQUIRE_STEP_UP | false |
| MFA recovery / break-glass | PLATFORM | UNVERIFIED | Low | AUTHN N9: no process yet; 0 enrolled today | — (runbook) | S96_KEY_ROTATION + IR runbook | owner: define recovery, add 2nd org owner | false |
| Public sign-up exposure | PLATFORM | V (owner) | Med | AUTHN-01: signup creates inactive viewer only (proven); email-budget/junk-profile abuse | s96_authn_gates.sql (signup→viewer) | — | owner: disable_signup=true | false |
| Venue/tenant isolation | DB | NOT APPLICABLE | — | DBRLS N3: no venue/tenant column; single-tenant by design | — | — | do not add a 2nd venue to this project | false |
| Race / TOCTOU | DB | V→fixed | Low | DBRLS-06 last-admin race; approvals/stock/idempotency | verify_s96_races.sh (4/4) | e776b4d | deploy | false |
| Idempotency of dangerous writes | DB+FUNC | CONTROL VERIFIED | — | request-id dedupe; approvals single | verify_s96_races.sh, edgea tests | — | — | false |
| Realtime authorization | DB | CV (data) / owner | Low | publication empty (no postgres_changes exposed); DBRLS-10 | dbrls replay | — | owner: set Realtime private channels | false |
| Background workers / cron | FUNC | CONTROL VERIFIED | — | EDGEA N2: import-worker 503, publisher gated, AI maint secret unset | edgea probes | — | — | false |
| CSV/Excel formula injection | FUNC+WEB | V→fixed | Low | WEBSTORE-05/N6: exports neutralised | csv-formula-injection-s96 | 7321f68 | deploy | false |
| Archive/decompression bombs | FUNC | CONTROL VERIFIED | — | recognition never server-decodes; size-capped | s96-aioauth-security | — | — | false |
| Signed URL security | STORAGE | CV (Low residual) | Low | WEBSTORE-09: profile-photo URL 6h (others 2-15m) | webstore probes | — | owner: shorten photo signed-URL TTL (optional) | false |
| CI/CD takeover | CI | V (Actions) / UNV | Med | SECSUPPLY N10: unpinned actions→pinned; branch-protection/Netlify tokens unreadable here | security-supply-chain | ae3b4d2 | owner: confirm branch protection, Netlify/PAT posture | false |
| Backups / recovery | PLATFORM | V (owner) | Med | OPSRISK-11: PITR off, Storage not backed up | restore drill (opsrisk) | — | owner: enable PITR + Storage backup | false |
| Search/index leakage (AI/Knowledge/Reports) | AI | CONTROL VERIFIED | — | AIOAUTH N13: bartender retrieves no manager data | verify_s96_knowledge_search_visibility.sql | — | — | false |
| Notification privacy | FUNC | V (latent) | Low | EDGEA-08: push carries full text (delivery disabled today) | edgea review | (push-policy 6bf47dd) | owner: keep push disabled until payload minimised | false |
| Domain / email security | PLATFORM | V (owner) | Low | OPSRISK-14/N15: no DMARC, SPF softfail | dig evidence | — | owner: add SPF/DKIM/DMARC | false |
| Downgrade / old clients | WEB | CV / UNV(old previews) | Low | server boundary enforces regardless; older previews egress-blocked | — | — | owner: retire stale previews | false |
| Deletion/disable session semantics | DB+AUTH | V→fixed | Low | AUTHN N18: sessions now revoked on deactivate/demote | s96_session_revocation.sql | 67e9347 | deploy | false |
| Error-message/data leakage | FUNC+AI | V→fixed | Low | EDGEA-04/AIOAUTH-04: raw DB text redacted | s96-edge-db-error-leakage, s96-phase3-db-errors | 6bf47dd/9c459db | deploy | false |
| AI prompt injection / tool authority | AI | CONTROL VERIFIED | — | tools role-gated server-side; injection.mjs; approval re-validated | s96-aioauth-security, s96-aioauth-n-controls | — | — | false |
| AI/RAG cross-role isolation | AI | CONTROL VERIFIED | — | retrieval authz before generation | verify_s96_knowledge_search_visibility.sql | — | — | false |
| Alternate Supabase interfaces (C40) | PLATFORM | CV / documented | — | REST/RPC/Storage/Realtime reviewed; GraphQL exposed schema public,graphql_public; S3/webhooks none | dbrls/opsrisk baseline | — | owner: consider restricting GraphQL if unused | false |
| Postgres extensions (C41) | DB | CONTROL VERIFIED | — | vault empty; pg_net/pg_cron absent; no outbound-capable ext abusable by anon/authenticated | baseline extensions.json | — | — | false |
| Non-production data isolation (C42) | PLATFORM | V (owner) | Med | OPSRISK-05: stale preview projects hold real VÁ data + accept prod logins | opsrisk read-only | — | owner: delete/lock stale preview projects & branches | false |
| Security detection / alerting (C43) | PLATFORM | V (owner) | Med | OPSRISK-09: auth events not persisted; no alerting | — | (security_audit_events 450b7c7) | owner: enable auth audit persistence + alerts | false |
| SSRF incl. stored & AI-assisted (C44) | FUNC+AI | CONTROL VERIFIED | Low(dormant) | ssrf gate: 23 sinks; only push endpoint (dormant) | s96-ssrf-egress-gate | (push-policy 6bf47dd) | keep push disabled until deployed | false |
| MAIN-01 deploy-preview-8 Auth redirect | PLATFORM | UNVERIFIED / High | High | session theft if host not owner-controlled; host egress-blocked here | s96-auth-email-links (recovery mitig.) | b4425f8 (mitigation only) | owner: verify host + fix Site URL/redirects/templates | **true** |
| OPSRISK-01 accounting 40001 loop | ACCOUNTING DEPLOYED | VULNERABLE / High | High | stale command → infinite PostgREST retry, pins DB conn | s96_no_serialization_failure_sqlstate_test.sql (catalogue/mktg); accounting variant isolated | 450b7c7 (catalogue/mktg); accounting = isolated patch | owner: deploy accounting fix via approved path; terminate the exact stuck PID only if present | (High, present in prod) |

## Reconciliation notes
- 15 commits since 994fa5f (see S96_SECURITY_GATE.md for the classified list). 3 are documentation/gate-only
  (d9ac538, 7d555c0, d379f1e); 07f9d28 is a test/manifest reconciliation; the rest carry code+migration+tests.
- Canonical tests at 07f9d28: `npm run test:node` → 1484 tests, 1442 pass, 0 fail, 42 skipped; Python 275 run,
  1 environment-only error (pdfplumber missing); full migration replay 153 migrations passed; CSP browser 3/3,
  flavor browser 13/13 (serial). Full parallel browser suite has pre-existing atlas-ai timing flakiness.
