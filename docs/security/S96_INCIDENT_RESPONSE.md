# Atlas incident response runbooks (S96)

Author: opsrisk (S96). Scope: Supabase project `dnefgcmjcgxlynycxkts` (org `ydesmzffnmkqyunibier`, Pro), Netlify site `os-vabar`, GitHub `imadelmoubarik4-cell/-V-OS-`.

Conventions:
- `$REF` = `dnefgcmjcgxlynycxkts`.
- `$PAT` = a Management API token held by the owner. Never paste it into chat, tickets or logs.
- `$SECRET` = an `sb_secret_…` key, used only from the owner's machine.
- `<uuid>` = the affected user id.
- Dashboard paths assume https://supabase.com/dashboard/project/$REF/…
- Every command below is either read-only or an owner-approved containment action. Nothing here was executed against production during S96.

Current facts that shape every runbook (S96 evidence):
- Production has **2 auth users**: 1 active admin and 1 active bartender. Neither has MFA. Sessions have no expiry (timebox/inactivity 0).
- The org has **one member** (the Owner), with MFA off.
- The classic PAT `SUPABASE_ACCESS_TOKEN` has full account scope and is **not covered by org MFA enforcement**.
- Auth audit events are **not written to Postgres** (`auth.audit_log_entries` = 0 rows). They exist only in platform logs, and those logs keep **7 days**. **Evidence expires fast: export first.**
- Legacy `anon`/`service_role` JWT keys are enabled. The legacy HS256 secret is still trusted. 25 Edge Functions use `SUPABASE_SERVICE_ROLE_KEY` (the legacy JWT).
- `public.profiles` has trigger `profiles_preserve_active_admin`: **you cannot deactivate the last active admin**. Promote a trusted second admin first.
- Backups: daily physical backups, 7-day window, PITR off. **Storage objects are not included in DB backups.**

---

## 0. Owner hardening steps (do before an incident; each is reversible)

| # | Action | Where / how | Lock-out risk |
|---|---|---|---|
| 0.1 | Enrol TOTP on the owner's Supabase account (2 authenticator apps), then turn on **Require MFA to access organization** | Account → Security; then Org → Settings → Security (`/dashboard/org/ydesmzffnmkqyunibier/security`). Pro plan: available. | Members without MFA lose access immediately. PATs keep working, so do 0.2. |
| 0.2 | Replace the classic PAT with **scoped** PATs (public alpha): one read-only (Project Settings Read + Database Read + Logs) for audits and one deploy token (Edge Functions RW, Secrets RW) kept offline. Revoke the classic token. | `/dashboard/account/tokens` → Generate → choose permissions. Choose an expiry at creation if offered (not stated in current docs). | Automation using the old token stops. |
| 0.3 | Create a **second, personal admin** Atlas account with TOTP, separate from the acceptance-test account | Atlas → Team → invite; activate as admin | None. It removes the single-admin trap. |
| 0.4 | Re-enable auth audit writing to Postgres | Authentication → Configuration → Audit Logs → turn **off** "Disable writing auth audit logs to project database" | Small DB growth |
| 0.5 | Enable SSL enforcement | Database → Settings → SSL Configuration → "Enforce SSL on incoming connections" (or `PUT /v1/projects/$REF/ssl-enforcement {"requestedConfig":{"database":true}}`) | Fast DB reboot. Clients must use `sslmode=require`/`verify-full`. |
| 0.6 | Network restrictions only if the owner has static admin IPs | Database → Settings → Network Restrictions; add IPv4 **and** IPv6 CIDRs | Blocks `psql`/CLI from other IPs. Edge Functions do not use direct DB. |
| 0.7 | Move functions from `SUPABASE_SERVICE_ROLE_KEY` to `SUPABASE_SECRET_KEYS`, then disable legacy keys, then revoke the legacy JWT secret | Code change first. Then Settings → API Keys (check "last used"; disable anon/service_role). Then Settings → JWT Signing Keys → revoke the legacy HS256 key (wait ≥ 1 h 15 min after the last legacy-signed JWT). | Doing it out of order breaks 25 functions. |
| 0.8 | PITR (≈$100/mo for 7 days; requires ≥ Small compute) **or** a nightly off-site `supabase db dump` + bucket export | Database → Backups → Point in Time; or a scheduled job on the owner's machine | Cost |
| 0.9 | Auth: set `site_url` to `https://os-vabar.netlify.app` with exact redirect paths; add CAPTCHA or disable open sign-up | Authentication → URL Configuration; Authentication → Attack Protection | Old emailed links break |
| 0.10 | Delete stale preview branches and the validation project after archiving what is needed | Branches → delete `agent/sprint-4-atlas-brain-daily-briefing` and `agent/sprint-4-phase-3-atlas-brain`; project `atlas-pr30-validation` → Settings → General → Delete | PR #8 preview modules stop working |
| 0.11 | Add a DMARC record for vábar.is (`_dmarc.xn--vbar-5na.is TXT "v=DMARC1; p=none; rua=mailto:…"`, then move to `quarantine`) | DNS host for vábar.is | None at `p=none` |
| 0.12 | Stop the live PostgREST 40001 retry loop (OPSRISK-01), then deploy the fix | SQL editor: `select pid, backend_start from pg_stat_activity where application_name like 'PostgREST%' and state='active' and now()-xact_start < interval '5 seconds' and now()-backend_start > interval '1 hour';` then `select pg_terminate_backend(<pid>);` after checking it is the `atlas_accounting_command` call | One stuck request fails (it never completes anyway) |

---

## Common first hour (every incident)

1. **Open an incident log.** Record times in UTC, who did what, and the commands run. Keep it outside Atlas.
2. **Preserve evidence before changing anything.** Logs keep 7 days and the query window is ≤ 24 h per call.
   - Dashboard → Logs → Logs Explorer: run and **download CSV/JSON** for each day in scope:
     - `select timestamp, event_message from logs where source='auth_audit_logs' order by timestamp`
     - `source='auth_logs'`
     - `source='function_edge_logs'` (fields `request.path`, `response.status_code`)
     - `source='edge_logs'`
     - `source='postgres_logs'` (filter `parsed.error_severity`)
   - API (repeat per 24 h window): `curl -G "https://api.supabase.com/v1/projects/$REF/analytics/endpoints/logs" -H "Authorization: Bearer $PAT" --data-urlencode "sql=select timestamp, event_message from logs where source='auth_audit_logs'" --data-urlencode iso_timestamp_start=… --data-urlencode iso_timestamp_end=… > auth_audit_<day>.json`
   - DB state (read-only):
     - `select id, user_id, created_at, updated_at, not_after, user_agent, ip from auth.sessions order by updated_at desc;`
     - `select * from atlas_private.security_audit_events order by id desc limit 500;` (after the S96 patch)
     - `select * from atlas_private.team_profile_events order by created_at desc limit 200;`
     - `select * from atlas_private.integration_events order by created_at desc limit 200;`
     - `pg_stat_activity` snapshot.
   - Platform state:
     - `GET /v1/projects/$REF/functions` (slug, version, `ezbr_sha256`)
     - `GET /v1/projects/$REF/secrets` (names and digests only)
     - `GET /v1/projects/$REF/api-keys` (names and types)
     - `GET /v1/organizations/<org>/members`
     - Or run `node scripts/verify_s96_production_drift.mjs --project $REF --json > drift_<ts>.json` (read-only; S96 patch 03).
   - Logical snapshot to encrypted, owner-only storage: `supabase db dump --project-ref $REF -f atlas_<ts>.sql` and `supabase db dump --data-only …`. Store it encrypted (e.g. `age`/`gpg`), never in the repo or a public bucket.
3. **Classify:** identity (a user), secret (a key), platform (a PAT/owner), code (a deployment), third party (OAuth), or data exfiltration.
4. **Communicate.** The owner decides on staff notice. For a personal-data breach, assess GDPR Art. 33 (72 h to the Icelandic DPA, Persónuvernd) and Art. 34.

---

## RB-1 Stolen admin credentials (Atlas admin account)

Signals: logins from unknown IP or user agent in `auth_audit_logs`; unexpected `profile.role_changed` rows; accounting approvals or voids; integration changes.

**Containment (≤ 15 min)**
1. Promote a trusted second admin first (the last-admin guard blocks deactivating the only admin). In the SQL editor (postgres):
   `update public.profiles set role='admin', active=true where id='<trusted-uuid>';`
   The S96 trigger records this in `security_audit_events` with request role null (SQL editor).
2. Deactivate the compromised profile. This takes effect on the **next request** in every RLS policy and in every Edge Function (`_shared/auth.mjs` rejects `active=false`):
   `update public.profiles set active=false where id='<uuid>';`
3. Revoke all sessions and refresh tokens. Deleting sessions invalidates every refresh token, and `/auth/v1/user` (used by every Atlas function) rejects access tokens whose session is gone:
   `delete from auth.sessions where user_id='<uuid>';`
   Remaining risk: a still-valid access token (≤ `jwt_exp` = 3600 s) can reach PostgREST until it expires. Step 2 already makes RLS deny it.
4. Ban at the Auth level so the password cannot be used again. Dashboard → Authentication → Users → user → **Ban user**. Or from the owner's machine:
   `node -e "import('@supabase/supabase-js').then(async ({createClient})=>{const s=createClient('https://$REF.supabase.co', process.env.SECRET);console.log(await s.auth.admin.updateUserById('<uuid>',{ban_duration:'876000h'}))})"`
5. If the account is the acceptance-test admin whose password lives in automation environments: rotate that password and remove it from every agent/CI environment. Treat those environments as in scope.

**Eradication**
- Review what the actor did (time-boxed to the session window):
  - `security_audit_events`, `team_profile_events`
  - `accounting_document_events` (append-only)
  - `ai_actions` (`decided_by`)
  - `integration_events`
  - `settings_events`
  - `inventory_movements` (`created_by`)
  - `recipes.updated_by`, `catalog_events`, `marketing_content_approvals`
- Check for persistence:
  - new auth users (`select id, created_at from auth.users order by created_at desc`)
  - profiles activated or promoted
  - MFA factors enrolled on the account (`auth.mfa_factors`); delete unknown ones
  - identities linked (`auth.identities`)
  - OAuth connections (re)connected: run RB-5 if so
- Undo changes with the normal UI workflows so they are audited: accounting reopen/void, recipe revert, integration disconnect.

**Recovery**
- Reset the password (Auth → Users → Send password recovery), require TOTP enrolment, then lift the ban (`ban_duration: 'none'`) and reactivate only after review.
- Enable 0.1, 0.3 and 0.9 if not done.

**Evidence to keep:** auth_audit/auth logs for the window; the sessions snapshot taken before step 3; audit table extracts.

---

## RB-2 Leaked backend secret

Applies to: service_role or secret API key, the legacy JWT secret, `ATLAS_INTEGRATION_KEK_V<n>`, `OPENAI_API_KEY`, OAuth app secrets, `SUPABASE_DB_URL` / DB password, `ATLAS_MARKETING_PUBLISHER_SECRET` or `ATLAS_AI_SERVICE_SECRET` (both currently unset).

**Triage:** identify the exact secret name and where it leaked (repo, log, chat, screenshot, device). Search the repo history: `git log -p -S '<first 6 chars>'` locally. Never paste the full value.

| Secret | Blast radius | Containment | Rotation steps |
|---|---|---|---|
| New secret key (`sb_secret_…`) | Full PostgREST/Storage as service_role (bypasses RLS) | Settings → API Keys → create a new secret key, move consumers, **delete** the leaked key (instant) | Functions receive `SUPABASE_SECRET_KEYS` automatically. Update any external consumer. |
| Legacy `service_role` JWT | Same | It cannot be rotated alone. Either disable legacy keys (Settings → API Keys; **breaks the 25 functions that use `SUPABASE_SERVICE_ROLE_KEY`** until they move to secret keys), or roll the legacy JWT secret, which also invalidates `anon` and signs everyone out | Prepare the function change (0.7). In an emergency accept the downtime: disable legacy keys, deploy the functions switched to `SUPABASE_SECRET_KEYS`. |
| Legacy JWT secret (readable by any PAT holder via the Management API) | Mint any role, including service_role, for ≥ 10 years | Settings → JWT Signing Keys: the current key is already ES256, and the legacy HS256 key is "previously used". **Revoke** it. First disable the legacy anon/service_role keys (required by the platform). | Same prerequisite as the row above |
| `ATLAS_INTEGRATION_KEK_V1` | Decrypts stored OAuth tokens (only together with a DB read) | Treat stored OAuth tokens as exposed: run RB-5 for every connected provider | `supabase secrets set ATLAS_INTEGRATION_KEK_V2=<new 32-byte base64> ATLAS_INTEGRATION_KEK_CURRENT_VERSION=2 --project-ref $REF`. New seals use V2 and old rows still open with V1. Reconnect the providers, then unset V1 once `select key_version, count(*) from atlas_private.integration_credentials group by 1` shows no V1. |
| `OPENAI_API_KEY` | Spend; any prompts sent with the key | Revoke in the OpenAI dashboard (API keys) and set a project spend limit | `supabase secrets set OPENAI_API_KEY=… --project-ref $REF`. No redeploy is needed; new invocations read the new value. |
| OAuth app secrets (Google, Meta, TikTok) | App impersonation, token refresh | Rotate in the provider console: Google Cloud → Credentials → reset secret; Meta App → Settings → Basic → Reset; TikTok developer portal | `supabase secrets set ATLAS_…_CLIENT_SECRET=…` |
| DB password / `SUPABASE_DB_URL` | Full DB as postgres | Database → Settings → **Reset database password**. The auto-injected `SUPABASE_DB_URL` follows. No Atlas function uses it. | Apply 0.6 if static IPs are available |

**Eradication:** check the audit trail for service-role misuse:
- `postgres_logs` grouped by `parsed.user_name`
- new or changed rows in `security_audit_events` with `request_role='service_role'`
- `pg_stat_statements` for unusual statements (`select calls, query from extensions.pg_stat_statements order by calls desc limit 50`)

After the S96 patch, audit tables cannot be rewritten by service_role. Before it, compare the audit tables with the last backup.

**Recovery:** run the drift check (patch 03). Confirm function secret names with `GET /v1/projects/$REF/secrets` (names only).

---

## RB-3 Database compromise (unauthorized SQL, data tampering or ransom)

**Containment**
1. Cut attacker paths:
   - reset the DB password (RB-2)
   - revoke PATs (RB-4 step 1)
   - rotate secret keys (RB-2)
   - enable network restrictions to the owner's IP only (0.6), temporarily
2. If destruction is ongoing through the Data API, stop API writes: `alter role authenticator set default_transaction_read_only = on;` then `select pg_terminate_backend(pid) from pg_stat_activity where usename = 'authenticator';` PostgREST reconnects, and new API transactions are read-only. Undo with `alter role authenticator reset default_transaction_read_only;`. Rehearse this on a branch first; it is not a documented Supabase feature. As a last resort, **pause** the project (Settings → General → Pause, if the plan offers it; otherwise ask Supabase support). All of Atlas is down until it is restored.

**Assess**
- Take a logical dump immediately (evidence), then compare it with the last daily backup:
  - `supabase db dump --project-ref $REF --data-only -f now.sql`
  - restore the last backup into a **new** project (Database → Backups → Restore to new project / "Duplicate project") and diff key tables (inventory, accounting, profiles, audit tables)
- Integrity checks:
  - the append-only tables (`accounting_document_events`, `catalog_events`, `review_decisions`, S96 set) should only have grown
  - `select count(*) from atlas_private.security_audit_events where session_user_name not in ('authenticator')` shows direct-SQL changes
  - drift check (patch 03): unexpected functions, triggers, policies or grants (for example a new SECURITY DEFINER function or a dropped policy)

**Recovery**
- Restore options:
  - (a) Database → Backups → Scheduled → pick the last clean daily backup → **Restore**. Downtime; loses everything after the backup; Storage objects are not rolled back.
  - (b) With PITR (after 0.8): Database → Backups → Point in Time → choose a time just before the compromise. Or `POST /v1/projects/$REF/database/backups/restore-pitr {"recovery_time_target_unix": …}`.
  - (c) Surgical repair from the restored duplicate project for targeted tables.
- After a daily-backup restore, **reset passwords of custom roles**: daily backups do not store them. Atlas's custom role `atlas_recognition_definer` has no login.
- Replay legitimate changes made after the backup from the audit tables and exported logs.
- Local proof (S96): `pg_dump -Fc` → `pg_restore` of the full replayed schema reproduced identical fingerprints for 155 tables, all function definitions, ACLs, policies and triggers in 10 s, and the S96 security tests passed on the restored copy. The CI drill `scripts/verify_recovery_roundtrip.sh` covers RLS after restore.

---

## RB-4 Malicious deployment (function, migration or frontend)

Signals: drift check shows `function_changed_since_baseline` / `db_function_definition_differs`; unexpected Netlify deploy; unexpected GitHub merge; Supabase GitHub integration applied migrations.

**Containment**
1. Revoke the deploying credential:
   - PAT (`/dashboard/account/tokens` → Revoke)
   - Netlify personal access token / deploy key (Netlify → User settings → Applications)
   - GitHub tokens and deploy keys (repo → Settings → Deploy keys; org/user → Developer settings)
   - remove unknown org members (Supabase Org → Team; GitHub → Collaborators)
2. Frontend: Netlify → Deploys → pick the last known-good production deploy → **Publish deploy** (instant rollback). Then Netlify → Site configuration → Build & deploy → **Stop auto publishing** until main is trusted.
3. Edge Function: redeploy the known-good source from a clean checkout of the release commit (the production backend is PR #103 head 994fa5f; S96 archived the exact deployed sources): `git worktree add /tmp/atlas-good 994fa5f && cd /tmp/atlas-good && supabase functions deploy <slug> --project-ref $REF` (plus `--no-verify-jwt` exactly where `config.toml` says `verify_jwt = false`). To take a function offline instead: `supabase functions delete <slug> --project-ref $REF`. For `atlas-accounting` and `atlas-import-worker`, redeploy from the archived deployed source, not from PR #93.
4. Migration: Atlas uses forward-fix migrations. Existing tested rollbacks: `scripts/rollback_s95_flavor.sql` (S95), `docs/release/Atlas_S34_Rollback.md`. For a malicious migration, write a reviewed reverse migration: drop added functions and triggers, restore grants and policies from the replay fingerprint (drift check `--replay-db`). If data was altered, run RB-3.
5. Supabase GitHub integration: Project Settings → Integrations → GitHub. Disable **Deploy to production** / Automatic branching if enabled (S96 could not read this setting; the production branch shows `MIGRATIONS_FAILED` at 2026-09-25).

**Eradication:**
- `GET /v1/projects/$REF/functions` versions against the baseline (patch 03 `--baseline`)
- `supabase_migrations.schema_migrations` new rows
- `pg_event_trigger` (only Supabase's `ensure_rls` / `pgrst_*` / `issue_*` are expected)
- new secrets (`GET /secrets` names)
- GitHub branch protection on `main`
- Netlify build hooks

**Recovery:** record a new drift baseline after the clean redeploy: `node scripts/verify_s96_production_drift.mjs --project $REF --write-baseline releases/production-drift-baseline.json`.

---

## RB-5 OAuth compromise (Google Drive / Business Profile, Meta Facebook/Instagram, TikTok, TripAdvisor)

Currently connected (S96): facebook, instagram, tiktok, google-drive, tripadvisor. 5 encrypted credentials plus 2 resource credentials.

**Containment**
1. In Atlas (manager/admin): Settings → Integrations → provider → **Disconnect**. This calls `atlas-integrations` `disconnect`, which revokes at the provider (Google `oauth2.googleapis.com/revoke`; Meta `DELETE /me/permissions`), deletes the local credential and writes `integration_events`.
2. At the provider, always (in case the Atlas revoke failed or the token was copied):
   - Google: https://myaccount.google.com/permissions → remove the Atlas app. For Workspace: Admin console → Security → API controls.
   - Meta: Business Settings → Integrations → Business integrations → remove. Also Facebook Settings → Apps and websites.
   - TikTok: Settings → Security → Manage app permissions.
3. Stop scheduled publishing: marketing deliveries use the publisher, which is dormant while `ATLAS_MARKETING_PUBLISHER_SECRET` is unset. If it is set, unset it: `supabase secrets unset ATLAS_MARKETING_PUBLISHER_SECRET --project-ref $REF`.

**Eradication**
- Rotate the OAuth app secret (RB-2 table) if the app itself is suspected.
- Rotate the KEK if a DB dump may also have leaked.
- Review provider-side activity: posts, Drive access log, Business Profile edits.
- Review `integration_events` and `marketing_delivery_attempts` (append-only).

**Recovery:** reconnect with minimum scopes from the Atlas UI (this re-seals with the current KEK version). Verify the `integration_events` rows show `connected` by the expected actor.

---

## RB-6 Suspicious data export / mass exfiltration

Legitimate export paths:
- accounting export (`atlas-accounting ?action=export`, logged in `accounting_document_events`)
- accounting file access (logged)
- Reports
- PostgREST paging (`max_rows` 1000 per request) by managers on their RLS-visible tables
- Atlas AI tools (logged in `ai_tool_calls`)
- Storage signed URLs (5-minute media thumbnails)

**Detection queries (read-only)**
- `edge_logs`: requests per user agent/IP and per path, over 24 h windows: `select log_attributes['request.path'] p, count() n from logs where source='edge_logs' group by p order by n desc limit 50`. Look for bursts on `/rest/v1/profiles|staff_details|staff_documents|suppliers|recipes`.
- `function_edge_logs`: counts per function and status (e.g. many `atlas-accounting` export/file calls).
- `accounting_document_events` where the event is export or file read, grouped by actor.
- `ai_tool_calls` grouped by `user_id`, `tool_name` over the window.
- `storage_logs`: sign/download bursts per bucket.

**Containment:** run RB-1 containment for the user (deactivate + delete sessions + ban). If the key rather than a user is suspected, run RB-2.

**Assessment:** determine the data categories (staff PII, accounting documents with payer data, recipes/costs) and the time window. Personal data triggers the GDPR assessment (see Common first hour, step 4).

**Recovery:** rotate anything exported that works as a credential (tokens, signed URLs expire on their own); notify affected staff if required; consider disabling bulk paths temporarily (Netlify rollback or function delete).

---

## Recovery capability matrix (verified in S96)

| Capability | How | Verified |
|---|---|---|
| Disable a user | Deactivate the profile (Team Profiles UI: manager/admin, not self; or SQL) + delete `auth.sessions` + Auth ban | The deactivation path exists (`atlas-team-profiles` `updateProfileAccess` PATCHes `active=false` under the admin-only RLS policy and logs `active_status_changed` with `access_removed_on_next_request`). **Sessions are not revoked by the app.** Every function and RLS helper re-reads `active` per request (code + local test). The last active admin cannot be deactivated (trigger). |
| Revoke a PAT | `/dashboard/account/tokens` → Revoke | Documented (docs: PATs unaffected by org MFA) |
| Revoke an OAuth connection | Atlas disconnect (provider revoke + local delete + event) + provider console | Code reviewed (handler `handleDisconnect`) |
| Rotate an Edge Function secret | `supabase secrets set NAME=… --project-ref $REF` / `POST /v1/projects/$REF/secrets` | Documented. KEK versioning supported (`ATLAS_INTEGRATION_KEK_CURRENT_VERSION`). |
| Roll back a function | Redeploy from the release commit or the archived deployed source; delete the function to take it offline | Sources archived in `$S/s96/deployed` |
| Roll back a migration | Forward reverse-migration; `scripts/rollback_s95_flavor.sql` | Rollback script exists and is tested per its runbook |
| Restore the database | Dashboard daily-backup restore (downtime, RPO ≤ 24 h); PITR after 0.8 | Local pg_dump/pg_restore drill: identical fingerprints, security tests pass |
| Detect drift | `scripts/verify_s96_production_drift.mjs` (patch 03) | Ran read-only against production: 26 DB functions in production are not in Git (accounting, s63b/import), migration ledger differs structurally from repo versions, 13 policy failures |
