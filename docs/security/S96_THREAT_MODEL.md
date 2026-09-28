# Atlas threat model (S96)

Author: opsrisk (S96 security audit). Date: 2026-09-28.
Basis: the deployed production code and configuration, not the intended design.
Sources: `supabase/functions/_shared/auth.mjs`; the 141 replayed migrations; `supabase/config.toml`; `netlify.toml`; `apps/web/config.js` (main f0f3f40); the deployed function sources in `$S/s96/deployed`; the production baseline in `$S/s96/baseline`; and read-only production queries made during S96 (catalogue, aggregate counts, count-only log queries). No secret values appear in this document.

---

## 1. Production deployment matrix

| Surface | What runs | Source of truth | Talks to |
|---|---|---|---|
| **LIVE WEB** | Static SPA on Netlify, https://os-vabar.netlify.app | `main` f0f3f40, `apps/web` | Production Supabase: `config.js` has the project URL and the `sb_publishable_…` key. The Supabase UMD library comes from cdn.jsdelivr/unpkg (pinned and SRI-checked). OpenAI Realtime is called from the browser only with ephemeral client secrets. |
| **PRODUCTION BACKEND** | 26 Edge Functions: 24 with `verify_jwt=false`, plus `atlas-notifications` and the `atlas-backup-export-20260806` stub (410). Postgres 17.6 schema with 74 ledger rows. | PR #103 head 994fa5f (= this checkout). The deployed copies in `$S/s96/deployed` are authoritative. | Postgres through PostgREST, with the service role, on the RPC pattern. OpenAI. Google, Meta and TikTok OAuth and APIs. TripAdvisor. |
| **ACCOUNTING DEPLOYED SOURCE** | `atlas-accounting` v15, `public.atlas_accounting_*` RPCs, `atlas_private.accounting_documents`/`_events`, bucket `atlas-accounting-documents` | As deployed (PR #93 lineage; differs even from 68b3108) | Service-role RPCs; OpenAI for document reading |
| **IMPORT WORKER** | `atlas-import-worker` v17 | As deployed (not in main) | Dormant: `ATLAS_IMPORT_ENABLED` is not set in production function secrets |
| **PR103 PREVIEW** | https://deploy-preview-103--os-vabar.netlify.app (994fa5f web) | PR #103 | Production Supabase (same `config.js`) |
| **PLATFORM CONFIG** | Supabase org `ydesmzffnmkqyunibier` (**Pro**, one member: the Owner, **MFA off**); project `dnefgcmjcgxlynycxkts` (eu-west-1, Micro compute); Netlify site | Dashboard / Management API | — |

### Non-production surfaces that reach production identity or data (C10)

| Surface | State (read-only S96 evidence) |
|---|---|
| Netlify deploy previews for ~24 open PRs (#2–#103) | Each preview serves the `apps/web` of that PR head. `config.js` at PR #2 head (749d418) and PR #8 head (dab991b) points at **production Supabase**. Old frontend code therefore runs against production Auth and Data API. Server-side RLS and function gates still apply. Only deploy-preview-103 was reachable from this session; the rest are UNVERIFIED because of network policy. |
| **deploy-preview-8** (PR #8, draft, open since 2026-08-08) | This is the production Auth `site_url` and the **only** `uri_allow_list` entry, so every production invite and recovery link lands here. Its `config.js` sends every module API (review, briefing, Brain, operations, scanner, stock counts, team messages, marketing, team profiles, shifts, knowledge, reports, system, settings, connections) to the **stale branch `uhbamqetppqmygesoeeh`**. Main session tracks this as MAIN-01; opsrisk treats it only as an input. |
| Supabase branch `cwazoxupbwxnixpmmlhx` (PR #4) | ACTIVE_HEALTHY. 5 functions: `atlas-sprint3-review` and `-sprint4-briefing` have `verify_jwt=false`; the 3 `*-transfer/export-once` functions are retired (410). The DB holds **2,251 rows of real VÁ import/review data** (1,087 review items, 747 entity rows, 357 inventory rows, 34 batches, 10 decisions labelled with staff **email addresses**). |
| Supabase branch `uhbamqetppqmygesoeeh` (PR #5; target of preview-8) | ACTIVE_HEALTHY. 20+ Atlas functions (Aug-era code, `verify_jwt=false`), plus `atlas-connections` and `atlas-p20-transfer-import-once`. The DB holds the same real VÁ review graph (copied "server-to-server" per the PR #8 body), 145 Brain snapshots and 3 storage objects. |
| Project `atlas-pr30-validation` (`atlas-pr30-validation` / `atialqebqxcquzdkezln`) | ACTIVE_HEALTHY, same org. 20+ functions including `atlas-import-worker`, all `verify_jwt=false`. 4 auth users (3 test-like), all with passwords and signed in within 14 days. Auth `site_url` and redirect point at `atlas-s32-rehearsal.coffee-cockt-8589.chatgpt.site`, a third-party host. |

The old branch functions authenticate callers against **production** Auth. `AUTH_PROJECT_URL` falls back to the production URL and the production publishable key (verified in the `atlas-sprint3-review` source on cwazox). They then act with their **own branch service role** on branch data. A production session therefore works on these stale surfaces, and their code is not patched with production.

---

## 2. Assets

| Asset | Where | Sensitivity | Who can read or write (production today) |
|---|---|---|---|
| Business data: inventory items, stock, par levels, counts, movements | `public.inventory_items`, `public.inventory_movements` (270 rows), `atlas_private.inventory_count_*`, `inventory_verified_balances` | Commercial integrity (stock value, shrinkage) | Browser: SELECT for managers. Writes go through guarded RPCs and triggers (`inventory_item_write_guard`, S84 owner confirmation, S87 delete guard). **Managers can also INSERT raw movements (OPSRISK-08).** |
| Recipes, costs, suppliers, purchase orders | `public.recipes`, `recipe_ingredients`, `suppliers`, `purchase_orders*` | Trade secrets and margins | Recipes and suppliers: browser read/write under RLS (manager). Purchase orders: RPC only. |
| Accounting documents (invoices/receipts: supplier, totals, VAT, payer) | `atlas_private.accounting_documents` (15), `_events` (147, append-only), bucket `atlas-accounting-documents` (private, 15 MB, images/PDF) | Financial records with legal retention; PII of payers | Admin only (`atlas-accounting` requires `role === "admin"`); service-role RPCs; retention guard triggers block delete/truncate |
| Staff PII: names, emails, phone, emergency contacts, availability, shifts, profile photos, documents | `public.profiles`, `staff_details`, `staff_documents`, `atlas_private.team_profile_details`, `team_emergency_contacts`, `shift_*`, bucket `atlas-profile-photos` | GDPR personal data | RLS self-or-manager; functions `atlas-team-profiles` and `-photos` |
| Messages / knowledge | `atlas_private.team_messages`, `knowledge_*` | Internal communications | Functions only |
| Integration tokens (Google Drive, Facebook, Instagram, TikTok connected; TripAdvisor) | `atlas_private.integration_credentials` (5), `integration_resource_credentials` (2): AES-256-GCM ciphertext + nonce + `key_version` | Account takeover of VÁ's social and Drive accounts | Service role can read the ciphertext. Decryption needs the `ATLAS_INTEGRATION_KEK_V<n>` function secret. A DB dump alone is not enough. |
| OAuth app secrets | Function secrets `ATLAS_GOOGLE_OAUTH_CLIENT_SECRET`, `ATLAS_META_APP_SECRET`, `ATLAS_TIKTOK_CLIENT_SECRET` | App impersonation | Function runtime; PAT holders (secret names only; values write-only) |
| AI keys and spend | `OPENAI_API_KEY` (function secret); `ai_runs` cost records | Direct cost; data exfiltration to model provider | atlas-ai, atlas-accounting, atlas-inventory-recognition |
| Supabase keys | Publishable key (public, in `config.js`); secret key `default`; **legacy `anon`/`service_role` JWT keys still enabled**; the legacy HS256 JWT secret is still trusted (`previously_used`); ES256 is in use | Service role bypasses RLS. The legacy secret can mint any role. | 25 deployed functions use `SUPABASE_SERVICE_ROLE_KEY` (legacy JWT) |
| Database password / `SUPABASE_DB_URL` | Owner dashboard; auto-injected into every function's env (**no deployed function uses it**) | Full DB (postgres role) | Owner; any code running in a function |
| Audit history | `*_events`, `ai_actions`, `ai_tool_calls`, `review_decisions`, `catalog_events`, `accounting_document_events` | Non-repudiation, incident forensics | See §6. Most tables are mutable by service_role today. |
| Management plane | Supabase org/project, classic PAT `SUPABASE_ACCESS_TOKEN`, Netlify, GitHub repo, Supabase GitHub integration (branching enabled) | Total compromise | Owner (no MFA), PAT holders (automation/agents) |

---

## 3. Trust boundaries and privilege transitions

```
 Browser (untrusted) ──TLS──► Netlify static (os-vabar / deploy previews)       [B1]
 Browser ──TLS, publishable key + user JWT──► Supabase gateway                  [B2]
      ├─ /auth/v1 (GoTrue)          sign-up ON, email+password, TOTP optional
      ├─ /rest/v1 (PostgREST)       role=authenticated, RLS + grants; exposed schemas public, graphql_public (pg_graphql not installed)
      ├─ /storage/v1                bucket policies (atlas-media public-read; others private)
      ├─ /realtime/v1               no publications; presence off; broadcast only
      └─ /functions/v1/*            verify_jwt=false → each handler calls _shared/auth.mjs
 Edge Function ──service role (legacy JWT)──► PostgREST RPC as service_role      [B3]  ← main privilege transition
 Edge Function ──► OpenAI / Google / Meta / TikTok / TripAdvisor                 [B4]
 Supabase GoTrue ──► SMTP (smtp.gmail.com, sender no-reply@vábar.is)            [B5]
 Owner / agents ──PAT──► Management API (SQL, secrets, deploy, keys, branches)   [B6]
 GitHub ──Supabase GitHub integration──► branch projects (and possibly prod)     [B7]
 Stale branches / pr30 project ──accept production user JWTs──► own service role [B8]
```

**B2 → B3 is the Atlas authorization boundary.** `resolveActor()` checks the bearer token with `GET /auth/v1/user`, then reads the caller's own `profiles` row with that JWT under RLS. It requires `profile.id === user.id`, a known role and `active === true`, and fails closed on any error (401/403/500/503). The service-role RPCs trust the `p_actor_id` and `p_actor_role` the gateway passes. Every gateway that skips `resolveActor` or passes a client-supplied actor is a full bypass (edgea/aioauth own that check). Roles come from `public.profiles`, never from `user_metadata`. Verified: 0 users have a `role` in app or user metadata.

**Self-registration boundary.** Sign-up is enabled. `handle_new_user()` (production md5 = replay md5) creates the profile as `viewer`, `active=false`. The column defaults match. Tested locally (S96): a freshly registered user sees 0 profiles, inventory, recipes, suppliers and movements, and cannot promote itself (UPDATE 0).

**Privileged transitions inside the DB.** SECURITY DEFINER RPCs (the dbrls agent inspects all of them), `private.*` helper functions, and triggers that stamp `updated_by` from `auth.uid()`.

---

## 4. Attack surfaces

1. 24 anonymous-reachable Edge Function URLs (`verify_jwt=false`). They depend only on in-code auth. The OAuth callback (`atlas-integrations`) and `atlas-marketing-publisher` (shared-secret header; secret unset, so it returns 503) are unauthenticated by design.
2. PostgREST `public` schema: 21 tables and 6 views granted to `authenticated` (see `effective_table_privs.json`); RPCs granted to authenticated (dbrls).
3. Storage: 6 buckets. `atlas-media` is public-read. Marketing media allows up to 1 GB; S3 protocol and image transformation are enabled.
4. Auth endpoints: sign-up, token (password), recover, OTP, verify, MFA. Rate limits: `rate_limit_email_sent` 30, verify/otp 30, `token_refresh` 150 (IP buckets). CAPTCHA off. HIBP on. Minimum length 10 with all character classes.
5. Realtime: `private_only` unset, presence disabled, no publications. Anonymous broadcast on public channels is possible but carries no Atlas data.
6. Netlify: production plus every PR deploy preview, all wired to production Supabase.
7. Management plane: classic PAT, owner account, Supabase↔GitHub integration, Netlify↔GitHub.
8. Supply chain: two CDN scripts (pinned + SRI), Deno `jsr:`/`npm:` imports in functions, GitHub Actions (no secrets, no deploy).
9. Old branch functions and the pr30 project (B8).

---

## 5. Actor analysis

Legend: **Path** = most likely route; **Controls** = existing, verified where marked ✔; **Gaps** = S96 finding IDs.

| Actor | Likely paths | Existing controls | Gaps |
|---|---|---|---|
| **Anonymous internet** | Call function URLs without a JWT; PostgREST with the publishable key; public bucket; sign-up/recover spam; stale preview URLs | `resolveActor` 401 on a missing or invalid bearer; anon has SELECT only on `public.public_menu`; no anon table grants; buckets private except `atlas-media`; Auth rate limits | Email-sending abuse through sign-up/recover (Gmail SMTP reputation, 30/h); stale branches reachable (OPSRISK-05) |
| **Self-registered user** (sign-up ON) | Sign up, confirm email, obtain a valid JWT, call functions and RPCs | Inactive viewer by default ✔ (local test); `resolveActor` rejects inactive; RLS helpers require `active` | Any RPC or function that checks only "is authenticated" (dbrls/edgea scope). Old branch functions check `active` too (verified in the sprint3 source). |
| **Compromised bartender** | Use own JWT against manager actions; mass-assignment of actor/role; upload abuse; AI tool abuse | `requireRole` in gateways; RPCs re-check `p_actor_role` from the gateway; AI tool registry levels | Can read the public `atlas-media` bucket; cannot reach the 40001 loop paths (all manager+). DoS by AI/upload volume (aioauth/edgea) |
| **Compromised manager** | Direct PostgREST writes where RLS allows (recipes, suppliers, staff docs, `inventory_movements` INSERT); stale RPCs; marketing publish; integration connect/disconnect | Triggers stamp `updated_by`; S87 delete guards; approval flows; last-admin guard | **Forged, backdated movement rows attributed to others (OPSRISK-08)**; **infinite PostgREST retry by stale catalogue/marketing commands, which pins pool connections and can take the Data API down (OPSRISK-02)**; audit rows the manager creates stay mutable by the backend (OPSRISK-07) |
| **Compromised admin** (the only admin is the acceptance-test account; no MFA) | Direct `PATCH /rest/v1/profiles` (role/active/email of anyone); accounting approve/void/pay; integrations; settings | `preserve_active_admin` (keeps ≥1 admin); accounting events append-only | **No DB-level audit of role/active changes (OPSRISK-06)**; admin credential shared with automation, 29 non-expiring sessions (OPSRISK-10); the stale-accounting infinite loop is live (OPSRISK-01) |
| **Stolen session / JWT** | Replay the access token for ≤1 h; use the refresh token indefinitely (timebox/inactivity 0) | Refresh rotation with reuse detection (10 s); profile deactivation takes effect on the next request everywhere (RLS + `resolveActor`) | No session timebox; deactivation does not revoke sessions (runbook: ban + delete `auth.sessions`); `/auth/v1/user` in functions rejects deleted sessions |
| **Malicious browser extension** | Read localStorage session and page DOM (inventory, recipes, PII); call APIs as the user | CSP limits exfiltration from page scripts, but not from extensions | Extensions sit outside the web threat boundary. MFA does not help once the session exists. Short session timebox would limit it (authn). |
| **Compromised OAuth token** (Meta/Google/TikTok) | Post as VÁ, read Drive | Tokens encrypted with a versioned KEK; disconnect revokes at the provider (`atlas-integrations` handleDisconnect: Google revoke, Meta permission revoke); `integration_events` | `integration_events` are mutable by service_role (OPSRISK-07); no alerting |
| **Leaked publishable key** | It is public by design | RLS + grants; function auth | None beyond anonymous |
| **Leaked backend secret** (service_role/secret key, legacy JWT secret, KEK, OpenAI key, OAuth app secrets) | Service role gives full PostgREST access that bypasses RLS: read all PII and accounting, rewrite or erase audit history; the legacy JWT secret can mint any role | Accounting events append-only; catalog/marketing-attempt/review/recognition append-only | **22 audit tables mutable/truncatable by service_role (OPSRISK-07)**; legacy JWT keys still trusted, and 25 functions depend on them, which blocks quick revocation (OPSRISK-04); no network restriction on the Data API (by design) |
| **Compromised CI/deploy token** (`SUPABASE_ACCESS_TOKEN`: a classic PAT = every permission on every org/project of the owner) | Management API: run SQL as postgres, read `jwt_secret` via `GET /v1/projects/{ref}/postgrest` (observed: the field is returned; value not recorded), set or replace function secrets, deploy functions, delete the project, restore backups | GitHub Actions hold no Supabase secrets and do not deploy | Classic, unscoped PAT; **not covered by org MFA enforcement** (docs); single Owner without MFA (OPSRISK-03); the legacy secret is readable (OPSRISK-04) |
| **Insider** (owner/agents with PAT, repo collaborators) | Same as the CI token; pushing to the PR #8 branch changes the page receiving production recovery links (MAIN-01) | Git history; S96 audit tables after the patch | No append-only protection against the postgres/superuser role except the S96 trigger (break-glass is logged by design only as a session setting); no log drain |
| **Supply chain** | CDN script swap (blocked by SRI); malicious `npm:`/`jsr:` dependency in functions; malicious PR merged to main (Netlify auto-deploys LIVE WEB; Supabase GitHub integration may auto-deploy migrations: OPSRISK-15) | SRI, pinned versions, no secrets in Actions | secsupply owns the detail |
| **Malicious upload** | Active content (SVG/HTML/PDF-JS) in buckets; oversized marketing media (1 GB); parser bugs in the accounting/recognition AI path | Bucket MIME allow-lists (no SVG/HTML); size limits | webstore/edgea own C2 |
| **Replay** | Replay a signed upload token, OAuth state, AI action approval, stock adjust | One-time OAuth state (`integration_consume_state`); idempotency keys (`adjust_inventory_v2`, messages); AI action state machine | aioauth/edgea verify |
| **Credential stuffing** | `/auth/v1/token?grant_type=password` | IP token bucket; HIBP; strong password policy | No CAPTCHA; no MFA requirement for admin (authn) |
| **API abuse / DoS** | Stale RPCs trigger PostgREST 40001 infinite retry (**observed live**); AI cost; uploads; pool exhaustion (Micro compute: 60 direct / 200 pooler connections) | Per-isolate rate limits (weak); AI budgets | **OPSRISK-01/02**; the log flood (8.6 M ERROR lines/day) drowns security signals and would dominate log-drain cost |

---

## 6. Auditability summary (Phase 13)

| Sensitive operation | Attributable record (actor, role, time, action, target, outcome) | Tamper resistance (before S96 patch) |
|---|---|---|
| Role / active changes | `team_profile_events` only when made through `atlas-team-profiles`, written **after** the PATCH, best-effort. **A direct admin PATCH leaves nothing.** Only `profiles.updated_at` changes. | Mutable by service_role. S96 patch: DB trigger into append-only `atlas_private.security_audit_events` |
| Auth events (login, logout, reset, MFA) | **Not in Postgres**: `audit_log_disable_postgres = true`, and `auth.audit_log_entries` has **0 rows** (production count). Available only in platform logs (`auth_audit_logs`/`auth_logs`), which hold nothing older than 7 days (observed). | Platform-controlled; expires after 7 days |
| Accounting actions | `accounting_document_events` (147) | Append-only + no-truncate triggers; service_role `arm` only ✔ |
| Inventory corrections / movements | `inventory_movements` (`created_by`, `created_at`); item change audit trigger (S89) into `catalog_events` | Browser managers can INSERT forged rows; service_role full rights. S96 patch: revoke browser INSERT; append-only |
| Stock counts | `inventory_count_events`, `inventory_count_publications` | Events mutable by service_role. S96 patch: append-only |
| Recipe approvals | `recipes.updated_by` trigger; AI `recipe.draft` through `ai_actions` | `updated_by` is overwritten on every edit (no history) |
| AI approvals | `ai_actions` (`user_id`, `role_at_proposal`, `decided_by`, `decided_by_role`, status, result); `ai_tool_calls` (669; role, decision, redacted args); `ai_runs` | `ai_actions` is a mutable state machine by design; `ai_tool_calls` was mutable. S96 patch: `ai_tool_calls` append-only |
| Integration connect / disconnect | `integration_events` (71) (`actor_id`, `actor_label`; **no actor_role**) | Mutable by service_role; FK cascade on delete of connection. S96 patch: append-only |
| Settings / security changes | `settings_events` (14), `system_events` | Mutable. S96 patch: append-only |
| Catalogue, review, recognition, marketing delivery attempts | `catalog_events`, `review_decisions`, `recognition_*`, `marketing_delivery_attempts` | Already append-only ✔ |

---

## 7. Infrastructure posture (Phase 14): classification by real exposure

The table below is a summary. INCIDENT_RESPONSE.md §0 has the exact owner steps.

| Setting | Current | Real exposure | Recommended | Lock-out risk |
|---|---|---|---|---|
| Org MFA enforcement | Off; sole Owner `mfa_enabled:false` | Owner password = full control of every project, backup and secret | Owner enrols 2 TOTP apps, then Org → Security → "Require MFA to access organization" (Pro: available) | Members without MFA lose access immediately. PATs are **not** affected, so rotate the PAT separately. |
| Dashboard SSO | None | — | SAML SSO needs Team/Enterprise; not available on Pro | — |
| PAT | Classic token in automation | Account-wide, never scoped | Replace with a **scoped** PAT (public alpha: project-only, Database read, etc.). Choose an expiry at creation if offered (not stated in current docs; verify in dashboard). Revoke the classic token after the S96 audit. | Automation breaks until it is re-issued |
| SSL enforcement | Off | Only matters for direct/pooler Postgres clients that hold the DB password and connect with `sslmode=disable/allow/prefer` through a hostile network. No deployed function uses `SUPABASE_DB_URL`. HTTP APIs always enforce TLS (docs). | Enable (Database Settings → SSL Configuration), then use `sslmode=verify-full` with the Supabase CA | Brief DB reboot; old clients without TLS fail |
| Network restrictions | 0.0.0.0/0, ::/0 | Postgres/pooler reachable by anyone with the DB password (SCRAM). Does not apply to PostgREST/Auth/Storage/Edge. Direct DB access from Edge Functions is always blocked when restrictions are enabled; Atlas has none. | Restrict to the owner's static IPs if they exist; otherwise leave it and rely on a strong, rotated DB password | Blocks the owner's `psql`/CLI from new IPs. Management-API SQL is not covered by the docs; verify before relying on it. |
| API keys | Legacy anon + service_role enabled; HS256 legacy secret `previously_used` (still trusted) | Legacy secret can be read via the Management API and mints any role | 1. Switch functions to `SUPABASE_SECRET_KEYS`/`sb_secret_…` (code change). 2. Check "last used" on the legacy keys. 3. Disable legacy keys (Settings → API Keys). 4. Revoke the legacy JWT secret (Settings → JWT Signing Keys). | 25 functions break if keys are disabled before step 1. `atlas-notifications` has `verify_jwt=true`, so test it. |
| Backups | Daily physical, 7-day window (8 listed), PITR off, `walg_enabled` | RPO ≤ 24 h. **Storage objects (accounting documents, photos, media) are not in DB backups.** | PITR add-on (~$100/mo for 7 days; requires ≥ Small compute, currently Micro), or at least a scheduled `supabase db dump` plus a bucket export to off-site storage | Restore = downtime; project unavailable during restore |
| Auth audit | Postgres writing disabled | 7-day retention only | Re-enable Postgres audit writing (Auth → Audit Logs), or add a log drain ($60/mo + events; fix the 40001 flood first) | DB storage growth (small at 2 users) |
| Realtime | `private_only` null, presence off, no publications | Anonymous broadcast channels only | Set "Allow public access" off (private channels only) | None: Atlas uses no Realtime |
| Storage | 50 MB global; per-bucket limits; S3 protocol on; image transformation on | S3 protocol uses S3 access keys (none listed) | Disable S3 protocol if unused | None |
| Auth rate limits | email 30/h, verify/otp 30, token_refresh 150 | Brute force limited per IP only | CAPTCHA (hCaptcha/Turnstile) on sign-up/recover/sign-in, or disable sign-up (invite-only). The app already invites. | Sign-up form must pass the CAPTCHA token |
| Auth redirect URLs | `site_url` and the allow-list = deploy-preview-8 only | All production recovery/invite links land on stale PR #8 code (MAIN-01) | `site_url` = https://os-vabar.netlify.app; allow-list only exact production paths | Links in already-sent emails break |
| Stale branches / pr30 project | Active, with real VÁ data | See §1 | Export what is needed, then delete branches cwazox/uhbam and project atialq | PR #8 preview modules stop working (intended) |
