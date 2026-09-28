# S96 key architecture, legacy-key migration and rotation runbook

Status on 2026-09-28 (read-only inspection of project `dnefgcmjcgxlynycxkts`; no key was
rotated, disabled or used). Nothing in this file is a secret: keys are named, never shown.

## 1. Inventory and blast radius

Edge Function secrets are project-wide: every one of the 26 deployed functions can read every
secret below, so a code-execution or environment-disclosure bug in any function exposes all of
them. Keep third-party imports pinned (tests/node/security-supply-chain.test.js) and never add
env-dumping or dynamic-code paths.

| Secret (name only) | Who holds it | What it unlocks if leaked | Rotation |
| --- | --- | --- | --- |
| Legacy `service_role` JWT (`SUPABASE_SERVICE_ROLE_KEY`) | platform env; readers listed in `LEGACY_SERVICE_KEY_READERS` (tests/node/security-secrets-s96.test.js) plus deployed atlas-accounting and atlas-import-worker | Full database, Storage and Auth admin, RLS bypassed; exp in ~2036 | Only by revoking the legacy JWT secret (disables both legacy keys). Migrate first (section 2). |
| Legacy `anon` JWT (`SUPABASE_ANON_KEY`) | platform env only; **no Atlas code reads it** and the browser uses the publishable key | Public key; anon role only | Disabled together with service_role (section 2). |
| Legacy JWT secret (HS256, status `previously_used`) | Supabase; readable through the Management API by any account token | Mint any JWT (any user, `service_role`) that PostgREST/Storage/Auth still accept while the key is not revoked | Revoke after section 2 step 6. |
| `default` secret key (`sb_secret_…`, `SUPABASE_SECRET_KEYS`) | platform env; not yet read by Atlas code | Same privilege as service_role, but rejected from browsers (User-Agent) and individually revocable | Create a new secret key, switch `ATLAS_SERVICE_KEY_NAME`, redeploy, delete the old one. |
| `default` publishable key (`sb_publishable_…`) | browser (apps/web/config.js) and functions (`ATLAS_AUTH_PUBLISHABLE_KEY` / `SUPABASE_PUBLISHABLE_KEYS`) | Public by design | Create new, update config.js + functions, delete old. |
| ES256 signing key (in use) | Supabase Auth (JWKS public at /auth/v1/.well-known/jwks.json) | Private part is not extractable | Standby key -> rotate -> revoke old after the longest session lifetime. |
| `SUPABASE_DB_URL` | platform env; **no Atlas code reads it** | Direct Postgres login. Database network restrictions are currently 0.0.0.0/0, so a leaked URL is usable from anywhere | Reset the database password (dashboard) and enable network restrictions. |
| `ATLAS_INTEGRATION_KEK_V1` | atlas-integrations, atlas-marketing-workspace, atlas-marketing-publisher | Decrypts stored Google/Meta/TikTok OAuth tokens (AES-256-GCM, AAD per row) | Add `ATLAS_INTEGRATION_KEK_V2`, set `ATLAS_INTEGRATION_KEK_CURRENT_VERSION=2`, re-encrypt/reconnect, then remove V1. |
| `ATLAS_GOOGLE_OAUTH_CLIENT_SECRET`, `ATLAS_META_APP_SECRET`, `ATLAS_TIKTOK_CLIENT_SECRET` | atlas-integrations (+ publisher/workspace for refresh) | Impersonate the Atlas OAuth app; refresh stored tokens only together with the KEK | Rotate in each provider console, update the function secret, verify a refresh. |
| `OPENAI_API_KEY` | atlas-ai, atlas-accounting, atlas-inventory-recognition | Paid API spend | Create a new project-scoped key with a spend limit, update, revoke old. |
| `ATLAS_MARKETING_PUBLISHER_SECRET` (+ `_NEXT`), `ATLAS_PUSH_DISPATCH_TOKEN`, `ATLAS_AI_SERVICE_SECRET` | **not set in production** (features fail closed) | Trigger the publisher / push dispatch / AI background jobs | Independent per-purpose secrets, >= 32 random bytes; publisher supports overlap via `_NEXT`. |
| Supabase account access token (PAT) used by operators/agents | people and automation sessions | Everything above: the Management API returns the legacy service_role key and the legacy JWT secret to any holder | Use short-lived, least-scope tokens; revoke after each session; never store in repos or long-lived agent environments. |

## 2. Controlled migration off the legacy JWT keys (deadline: legacy keys stop working at the end of 2026)

Facts from the current Supabase docs (Migrating to publishable and secret API keys; JWT Signing Keys):
the new keys work alongside the legacy keys; an `sb_` key must be sent on the `apikey` header only
(in `Authorization: Bearer` it is rejected as "Invalid JWT"); `verify_jwt` only understands the legacy
JWT keys, so functions called with new keys use `verify_jwt = false` and authorise in code (24 of 26
Atlas functions already do); there is no automatic last-used indicator, so verify manually; deactivating
legacy keys is reversible; revoking the legacy JWT secret requires the legacy keys to be disabled first.

1. **Code (no behaviour change).** Merge the S96 helper `_shared/service-credentials.mjs`. Migrate each
   function in `LEGACY_SERVICE_KEY_READERS` to `serviceCredential(env)` + `serviceHeaders(...)` and remove it
   from the list (the ratchet test fails if a new direct reader appears or a migrated file stays listed).
   `atlas-team-profiles` uses supabase-js 2.45.4, which sends the key as a Bearer token: upgrade supabase-js
   there (and pin it) before switching it to a secret key. Apply the isolated patches for the deployed-only
   atlas-accounting and atlas-import-worker sources.
2. **Branch rehearsal.** On a Supabase preview branch, set `ATLAS_SERVICE_KEY_SOURCE=secret` and exercise
   every function's RPC, Storage upload/sign/delete and Auth admin path (team-profiles invite) with the new key.
3. **Production, per purpose.** Create one secret key per server component that must rotate independently
   (for example `atlas-ai`, `atlas-integrations`, `atlas-default`), set `ATLAS_SERVICE_KEY_NAME` accordingly
   (project-wide today; per-function names need a per-function variable in the helper) and
   `ATLAS_SERVICE_KEY_SOURCE=secret`, redeploy, and watch Edge Function logs for 401/"Invalid JWT".
   Note: separate secret keys give independent rotation and attribution, not containment, because every
   function can read the whole `SUPABASE_SECRET_KEYS` object.
4. **Frontend.** Already on the publishable key (live main f0f3f40 and PR103 preview: same key, verified by
   fingerprint against the project's publishable key). No change.
5. **verify_jwt=true functions** (`atlas-notifications`, disabled `atlas-backup-export-20260806`): callers send
   user JWTs; confirm on the branch that the platform JWT check still accepts ES256 session tokens, or move
   them to `verify_jwt = false` with the shared in-code check.
6. **Deactivate** the legacy anon and service_role keys in Settings > API Keys once every reader is migrated
   and a full working day of logs shows no failures. Re-activate immediately if anything breaks.
7. **Revoke** the legacy HS256 JWT secret (currently `previously_used`, i.e. still trusted) in
   Settings > JWT Keys. Existing HS256-signed user sessions end; users sign in again.

## 3. Routine rotation (at least yearly, and immediately on suspicion)

Order for any server secret: create the new value -> add it next to the old one where the code supports an
overlap (`_NEXT`, KEK versions, multiple secret keys) -> redeploy -> verify -> remove the old value -> record
the date. Never paste a secret into chat, tickets, commits, CI logs or test fixtures; secret scanning covers
apps/web and docs (tests/node/secret-scan-s89.test.js) and the whole Git history was scanned clean in S96.
