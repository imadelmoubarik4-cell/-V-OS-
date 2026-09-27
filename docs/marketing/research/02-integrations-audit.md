# S94 audit 02: the S88 integrations architecture and how it extends to publishing

Scope: `supabase/functions/atlas-integrations/*`, `_shared/auth.mjs`, the integration migrations, `apps/web/assets/js/settings-workspace.js`, `marketing-workspace.js`, `docs/integrations/Atlas_Integrations.md` and `tests/node/integrations-oauth-s88.test.js`. I also ran read-only checks against production (dnefgcmjcgxlynycxkts). Paths are relative to the worktree `/home/user/-V-OS-/.claude/worktrees/s94`.

## 0. Headline facts
- **Deployed function:** `atlas-integrations` v3 is ACTIVE with `verify_jwt=false`. I downloaded its deployed files (index.ts, handler.mjs, oauth-core.mjs, providers.mjs, _shared/auth.mjs) and diffed them against the worktree. They are **byte-identical**.
- **Production data:** there are 6 integration rows. All have `status=not_connected` and `authorization_state=not_connected`. No row has a credential, an event or an OAuth state (0 each), so nobody has ever started a connection in production.
- **Production publishing state:** `publishing_permission_state` is `not_requested` for every provider except tripadvisor, which is `not_supported`. `analytics_permission_state` follows the same pattern.
- **Production RPCs:** they match the hardened signatures from `20260926106000`. `authenticated` has EXECUTE on none of them.
- **Secrets:** I could not list the secret names that are actually set, because the MCP has no secrets tool. The only signal is indirect: no event has ever been recorded. Check with `supabase secrets list` (names only).
- **Publishing is not built.** The function states this itself: `automatic_publishing_enabled:false` (handler.mjs:312), and the docs say "token use by any other Edge Function" is not built (docs/integrations/Atlas_Integrations.md:19-24).

## 1. Provider keys
There are six provider keys: `google-business-profile`, `google-drive`, `facebook`, `instagram`, `tiktok`, `tripadvisor`.
- **Where they are defined:** providers.mjs:40-216.
- **Where they are hardcoded:**
  - the SQL allow-list in `integration_assert_provider` (migration 20260926095000:165)
  - the status query (095000:233; 106000 `integration_status`)
  - the Marketing snapshot, which uses only the 4 social/GBP keys (checkpoint_d migration ~l.613: `instagram, facebook, tiktok, google-business-profile`)
- **Not provider keys:** there is no `meta` or `google_business` key. Facebook and Instagram are **separate connections that use the same Meta app**, which means two consents and two token sets.
- **Base table:** `integration_connections` comes from 20260803012704:133. In production it holds only the six rows. The preview-only rows (supabase, github, netlify, gmail, …) from system_checkpoint_i are not present.

## 2. OAuth flows (providers.mjs)
| Provider | Authorize | Token | Scopes requested now (verbatim) | `future_scopes` (not requested) | PKCE | Extra params |
|---|---|---|---|---|---|---|
| google-business-profile | `https://accounts.google.com/o/oauth2/v2/auth` (l.20) | `https://oauth2.googleapis.com/token` | `https://www.googleapis.com/auth/business.manage` (l.50) | [] | S256 | `access_type=offline, prompt=consent, include_granted_scopes=true` (l.54) |
| google-drive | same | same | `https://www.googleapis.com/auth/drive.file` (l.79) | [] | S256 | same |
| facebook | `https://www.facebook.com/{v}/dialog/oauth` (l.105), v=`ATLAS_META_GRAPH_VERSION` or `v25.0` (l.18,35-38) | `https://graph.facebook.com/{v}/oauth/access_token` | `pages_show_list`, `pages_read_engagement` (l.108), comma separator | `pages_manage_posts`, `read_insights`, `business_management` (l.109) | none | — |
| instagram | same Meta dialog | same | `instagram_basic`, `pages_show_list` (l.135) | `instagram_content_publish`, `instagram_manage_insights`, `pages_read_engagement`, `business_management` (l.136) | none | — |
| tiktok | `https://www.tiktok.com/v2/auth/authorize/` (l.161), param `client_key` | `https://open.tiktokapis.com/v2/oauth/token/` | `user.info.basic` (l.164) | `video.upload`, `video.publish`, `video.list` (l.165) | none | — |
| tripadvisor | API key (no OAuth) | — | — | — | — | — |

- **Authorize URL builder:** providers.mjs:263-278. It sets `client_id` (or `client_key`), `redirect_uri`, `response_type=code`, `scope`, `state`, and the PKCE parameters where the provider uses them.
- **Code exchange:**
  - Google: POST form with `code_verifier` (l.315-339). Scopes are taken from `body.scope`.
  - Meta: a GET short-lived exchange, then `grant_type=fb_exchange_token` for a long-lived user token of about 60 days (l.411-435). Scopes are stored as `[]` and filled later from `/me/permissions`. **Only the USER token is stored; no Page access token is stored.**
  - TikTok: POST form (l.501-525). It stores `open_id` as `external_account_id`.
- **Flow (handler.mjs):**
  1. `start` (l.318-357) makes a 256-bit state and stores only its sha256. For Google it also makes a PKCE pair and stores the verifier encrypted with AAD `pkce:<stateHash>`. It then calls `atlas_integration_begin` and returns an **Atlas authorize hop** URL rather than the provider URL.
  2. `GET /authorize/<provider>` (l.362-387) calls `atlas_integration_bind_browser`, which stores sha256 of a cookie nonce. It sets the cookie `__Host-atlas-oauth-<provider>` (Secure, HttpOnly, SameSite=Lax, Max-Age=600) and returns a 302 to the provider.
  3. `GET /callback/<provider>` (l.446-513) reads the cookie and calls `atlas_integration_consume_state(provider, state_hash, binding_hash)`. That RPC is single-use, checks expiry and the binding, and re-checks that the initiator is still an active manager/admin (106000:1126-1175). The callback then exchanges the code, calls `storeCredential`, then `verifyAndRecord`, and returns a 302 to `<APP_ORIGINS[0]>/?integration=&result=&reason=#<return_path>` (oauth-core.mjs:353-359).
- **Redirect URI:** `https://<host>/functions/v1/atlas-integrations/callback/<provider>` (oauth-core.mjs:252-264).
  - The host comes from `ATLAS_INTEGRATIONS_PUBLIC_URL`, falling back to `SUPABASE_URL`.
  - The host must be on the allow-list in `ATLAS_INTEGRATIONS_CALLBACK_HOSTS` (default `*.supabase.co`).
  - The status response exposes it as `redirect_uri_to_register`.
- **State storage:** table `integration_oauth_states` (095000:73-91, plus `browser_binding_hash` and `bound_at` added in 106000:952-963).
  - The PK is `state_hash bytea(32)`.
  - `expires_at` defaults to now()+10 min, and `STATE_TTL_SECONDS=600` (oauth-core.mjs:83).
  - Rows more than 1 day old are purged on each begin.

## 3. Credential encryption
- **Algorithm:** AES-256-GCM through WebCrypto, with a 12-byte random nonce and a 128-bit tag (oauth-core.mjs:204-242). The plaintext is the JSON token set.
- **AAD:** `atlas-integrations|<provider>|<credential_kind>` (l.219-221). The AAD does **not** include the account id.
- **Key source:**
  - `ATLAS_INTEGRATION_KEK_V<n>`: base64 of 32 bytes.
  - `ATLAS_INTEGRATION_KEK_CURRENT_VERSION`: selects the key for writes (default 1) (handler.mjs:220-239). Keys are cached per isolate.
- **Storage:** `integration_credentials` (095000:58-71).
  - Exactly **one row per provider_key (PK)**.
  - Columns: ciphertext bytea, nonce bytea(12), key_version, access_expires_at, refresh_expires_at, external_account_id, created_by, rotated_at.
  - The database never sees plaintext.
- **Where decryption happens:** only inside `atlas-integrations`.
  - `openCredential()` (handler.mjs:515-525) calls the `atlas_integration_read_credential(provider, role, actor_id)` RPC, which returns hex ciphertext, nonce and key_version (106000:1252-1281). It is used by test, refresh and revoke.
  - The callback decrypts the PKCE verifier (l.488-497).
- **Rotation:** reads use the row's `key_version`, and writes use the current version. **There is no re-encrypt job and no rotate action.** `rotated_at` is updated on every upsert, even when the key has not changed.

## 4. Token refresh and reconnect
- **Refresh happens only inside `test`**, when the token expires within 5 minutes (`REFRESH_MARGIN_MS`, handler.mjs:47, 541-552). A refresh re-stores the credential and records `refreshed`. A failure records `refresh_failed` with `needs_reauthorization=true`, which sets status `expired`.
  - Google refresh: providers.mjs:341-361.
  - TikTok refresh: l.527-550. It rotates the refresh token.
  - **Meta:** `refresh:null`, so there is no refresh. Once the ~60-day token expires, `connection_state=needs_reauthorization` (handler.mjs:253).
- **Reconnect** is just `start` again. The UI labels the button "Reconnect" (settings-workspace.js:822).
- **There is no scheduled refresh or health job** (docs:21). There is no lock around refresh, so concurrent callers could race, and TikTok's rotating refresh token makes that race harmful.

## 5. Connection health
- **What `connected` means:** it is written only by `integration_record_result('verified')` when a credential row exists (106000:~1283-1370; original 095000:437-526). `verified` is recorded only after a live `provider.verify()` call succeeds (handler.mjs:425-444).
- **Verify calls per provider:**
  - GBP: `GET mybusinessaccountmanagement.googleapis.com/v1/accounts`, takes the **first account** (providers.mjs:380-394).
  - Drive: `/drive/v3/about` (l.396-409).
  - Facebook: `/me/permissions` must include the requested scopes, then `/me/accounts?fields=id,name`. It takes the **first page's id** as account_id and labels the account with up to 3 page names (l.459-471).
  - Instagram: `/me/permissions`, then `/me/accounts?fields=name,instagram_business_account{id,username}`. It takes the **first linked IG account** (l.473-491).
  - TikTok: `/v2/user/info/?fields=open_id,display_name` (l.552-567).
- **Failure paths:**
  - `ProviderError.reauthorize` is true on HTTP 400/401 and on missing scopes. It leads to status `expired`; otherwise status is `degraded`.
  - A failed callback records `callback_failed`.
- **Health is manual.** It is checked only when a manager presses "Test connection". Nothing checks it on a schedule, and nothing checks `last_verified_at` before use.

## 6. Audit events and sanitisation
- **Table:** `integration_events` (095000:96-116).
  - `event_type` check: `connect_started, credential_stored, connected, callback_failed, verified, verify_failed, refreshed, refresh_failed, disconnected, api_key_saved`. I confirmed this constraint in production.
  - A second CHECK regex rejects any JSON key such as `access_token|refresh_token|id_token|token|code|code_verifier|verifier|client_secret|app_secret|api_key|secret|password|ciphertext|nonce|state` at any depth (l.110-112).
  - Grants: service_role gets select+insert only.
- **Payloads:** only `key_version`, `account_label`, `error`, `needs_reauthorization` and `credential_removed`.
- **Error sanitisation:** `sanitizeProviderError` (oauth-core.mjs:381-389) redacts any run of 24 or more token-like characters and `k=v` pairs for secret names, strips non-printable characters and caps the text at 240 characters. SQL applies the same cap and printable-only filter (record_result `v_error`).
- **Response guard:** `assertNoSecretFields` / `jsonResponse` (handler.mjs:90-111) blocks responses whose keys match `SECRET_KEY_PATTERN` (oauth-core.mjs:363-364) and returns a 500 instead.
- **RPC errors** map to fixed messages (handler.mjs:74-83), and index.ts:50-57 logs only the SQLSTATE.
- **Browser view of events:** the browser gets `recent_events` (last 5: event_type, actor_label, created_at). The Settings UI does not render them.

## 7. Env and secret names (names only)
- **Read by the function** (the deployed source matches the worktree):
  - `ATLAS_INTEGRATION_KEK_V1` (generically `ATLAS_INTEGRATION_KEK_V<n>`) and `ATLAS_INTEGRATION_KEK_CURRENT_VERSION`
  - `ATLAS_INTEGRATIONS_APP_ORIGINS`, `ATLAS_INTEGRATIONS_PUBLIC_URL`, `ATLAS_INTEGRATIONS_CALLBACK_HOSTS`
  - `ATLAS_GOOGLE_OAUTH_CLIENT_ID` and `ATLAS_GOOGLE_OAUTH_CLIENT_SECRET`
  - `ATLAS_META_APP_ID`, `ATLAS_META_APP_SECRET` and `ATLAS_META_GRAPH_VERSION`
  - `ATLAS_TIKTOK_CLIENT_KEY` and `ATLAS_TIKTOK_CLIENT_SECRET`
  - `ATLAS_TRIPADVISOR_VERIFY_URL` and `ATLAS_TRIPADVISOR_LOCATION_ID`
  - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
  - `ATLAS_AUTH_PROJECT_URL` and `ATLAS_AUTH_PUBLISHABLE_KEY` (through `_shared/auth.mjs`)
- **References:** index.ts:13-20 and docs §6. `apps/web/config.js:22` holds only `INTEGRATIONS_API`. A test enforces that there are no secret names in apps/web (test.js:580).

## 8. Resource selection and external account ids
- **No resource picker exists.** There is none for a Facebook Page, an Instagram account, a GBP account or location, or a TikTok account.
  - Every verify step picks the **first** result (index `[0]`).
  - GBP stores the *account* name (`accounts/…`), **not a location**, and no location is ever listed.
  - Facebook stores only one page id, even when there are several pages, and the label shows up to 3 names.
  - No Page access token is fetched.
- **Where external account ids are stored:**
  - `integration_connections.external_account_id` and `external_account_label`, written on `verified` (106000 record_result).
  - `integration_credentials.external_account_id`: TikTok's `open_id` at exchange, then overwritten with the verify `account_id`.
  - `disconnect` sets both to null.
- **One connection per provider.** The table design (provider_key PK on connections and credentials) cannot hold multiple Pages, multiple locations or multiple accounts per provider.

## 9. Connection status vocabulary
There are three vocabularies:
- **Database `status`:** `not_connected, authorization_required, pending_review, connected, degraded, expired, not_applicable`.
- **Database `authorization_state`:** `not_connected, waiting_authorization, authorized, expired`.
- **Database `publishing_permission_state` and `analytics_permission_state`:** `not_requested, pending, granted, missing, not_supported` (checkpoint_d:150-180).

Derived states:
- **Edge `connection_state`** (handler.mjs:244-289): `not_configured | ready | verifying | connected | verification_failed | needs_reauthorization | pending_review`.
- **Settings UI labels** (settings-workspace.js:66-74, captions l.810-819):

| `connection_state` | Label | Tone |
|---|---|---|
| not_configured | "Not set up yet" | neutral |
| ready | "Not connected" | neutral |
| verifying | "Checking" | warning |
| connected | "Connected" | positive |
| verification_failed | "Needs attention" | warning |
| needs_reauthorization | "Needs attention" | warning |
| pending_review | "Waiting for platform review" | info |

- **Callback reasons** mapped to messages (l.728-745): `browser_mismatch, not_authorized, provider_check_failed, provider_refresh_failed, credential_unreadable, not_configured, not_connected, forbidden, denied, invalid_request, network/timeout, verify_failed`.
- **Marketing `display_status`** (from `atlas_private.marketing_connection_display_status`, checkpoint_d:~383-409): `connection_expired, not_connected, waiting_for_authorization, missing_publishing_permission, missing_analytics_permission, connected`. marketing-workspace.js:247-253 uses only `display_status==='connected'`.

**BUG / GAP (confirmed in production):** S88 RPCs never write `publishing_permission_state`. After a successful verify, the state is `authorized` + `not_requested` + `not_requested`, and `marketing_connection_display_status` returns **`waiting_for_authorization`**. I tested this in production with `select …('authorized','not_requested','not_requested',null)`. So Marketing would never show a verified Facebook, Instagram, TikTok or GBP connection as "connected".

`pending_review` has no writer at all: no RPC or action sets it. The docs say "set by an admin" (docs:223), but no such action exists.

## 10. Role checks
- **Edge function:** `resolveActor` validates the JWT and the active profile (`_shared/auth.mjs:105-178`). `requireManager` then allows `admin` and `manager` only (handler.mjs:48, 132-136, 610-611).
- **SQL:** `integration_assert_actor(p_actor_id, p_actor_role)` requires the profile to be active with exactly that role, which must be manager or admin (106000:968-985). Every RPC except bind_browser and consume_state calls it.
- **Consume state:** `consume_state` re-derives the current role.
- **Grants:** every function is revoked from public, anon and authenticated, and granted to service_role (106000:1440-1480). Production shows `authenticated` with no EXECUTE.
- **Admin-only detail:** `setup_details` (secret names) appears only for `admin` (handler.mjs:282-284).
- **UI gates:** Settings shows the section to `roles:['admin','manager']` (settings-workspace.js:33). Marketing is manager-only.

## 11. Can another Edge Function (a publishing worker) get a decrypted token?
**Not today.** There is no existing helper or RPC built for this:
- `atlas_integration_read_credential(provider, role, actor_id)` requires an **active manager/admin actor id** (106000:1266). A queue worker has no human actor, although it could pass the scheduling manager's id.
- The decrypt code (`decryptJson`, `importAesKey`, `credentialAad`) is a pure module (`atlas-integrations/oauth-core.mjs`). It can be imported by another function if moved to or shared from `_shared/`, but then the **KEK secret must be set on that function as well**. Supabase secrets are project-wide, so it is already visible to every function in the project.
- Refresh logic lives in `providers.mjs` (`provider.refresh`), and `storeCredential`/`recordResult` are closures inside `createIntegrationsHandler`. They are not exported.
- `atlas-ai` reaches integrations only through `?action=status` with the user JWT (`_shared/ai-tools/services.mjs:457`).

**Recommended safe pattern**, based on existing precedent: atlas-ai uses an `ATLAS_AI_SERVICE_SECRET` header for background work (atlas-ai/handler.mjs:810).
1. Extract a `_shared/integrations/credentials.mjs` module that exports `openProviderCredential(provider, {rpc, env, fetchImpl, now})`. It would decrypt, refresh if needed under a lock, re-store and record, and return the token set to **server code only**.
2. Add a service RPC `atlas_integration_read_credential_for_job(provider, job_id)`. It would verify that a queued publish job exists, is approved, and was created by a still-active manager, instead of accepting an arbitrary actor. It would log an event such as `credential_used`, which needs a new event_type.
3. Alternative: add an internal `?action=publish` route on atlas-integrations itself, authenticated by a service secret, so tokens never leave that function. This is the smallest trust surface.

## 12. Tests and docs
- `tests/node/integrations-oauth-s88.test.js` has 36 tests. They cover PKCE, state, AES-GCM, allow-lists, the registry and scopes (l.170: "minimal scopes"), the full Drive flow, role gating, F7/F9/F10 hardening and source contracts.
- **Scope tests will need updating** when publish scopes are added (l.170-205).
- SQL verification: `scripts/verify_s88_integrations_preview.sql` and `.sh`.
- Docs: `docs/integrations/Atlas_Integrations.md`. §3 still lists the pre-hardening RPC signatures (for example `atlas_integration_status(p_actor_role)` and `consume_state(provider,state_hash)`). §4 is up to date.

## 13. Extension points for publishing
1. **Scopes** (providers.mjs `scopes`; move them out of `future_scopes`):
   - facebook: add `pages_manage_posts` and `pages_read_engagement` (already requested), plus `business_management` if the Page is owned through Business Manager.
   - instagram: add `instagram_content_publish` plus `pages_read_engagement` (and `business_management`).
   - tiktok: add `video.publish` (direct post) and/or `video.upload` (inbox/draft).
   - GBP: `business.manage` already covers localPosts. The API needed is `mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/localPosts`, which requires the API to be enabled and approved.
   - **Split the scope sets:** `verify` uses `requireScopes(granted, provider.scopes)` (l.452-457), so adding publish scopes to `scopes` makes verify **fail** until App Review grants them. Keep `scopes` (connect) separate from `publish_scopes`, and derive `publishing_permission_state` from `scopes_granted`.
2. **Publish-permission state:** write `publishing_permission_state` (`granted`/`missing`/`pending`) in `integration_record_result` from the granted scopes compared with the publish scopes. This also fixes the Marketing display bug in §9. For GBP (no separate scope) set `granted`, or `not_supported` for Drive.
3. **App-review state:** there is no column for it. Add `app_review_state` (for example `not_submitted|in_review|approved|rejected`), or reuse `status='pending_review'` with an admin action to set it, plus a Settings pill. Meta and TikTok review are per permission, so a JSON map from permission to state in `metadata` or `requirements` fits.
4. **Resource picker:**
   - Add a new action `list-resources` that runs server-side and returns only ids and names: Pages from `/me/accounts`, IG from `instagram_business_account`, GBP locations from `mybusinessbusinessinformation.googleapis.com/v1/{account}/locations`.
   - Add `select-resource` to store the choice.
   - Storage options: (a) keep one row per provider and add `selected_resource_id`, `selected_resource_label` and `resource_kind`; or (b) add a new `integration_resources` table (provider_key, resource_id, label, kind, selected, page-token ciphertext). The provider_key PK blocks multiple accounts.
   - **Facebook and Instagram need a Page access token.** It is fetched with `/me/accounts?fields=access_token` or `/{page-id}?fields=access_token` and is non-expiring when derived from a long-lived user token. It should be encrypted as its own credential kind; `credential_kind` currently allows only `oauth_token_set|api_key`, so a check constraint change is needed. Instagram publishing uses the Page token, or the user token with `instagram_content_publish`, on `/{ig-user-id}/media` followed by `/media_publish`.
5. **Server token access:** add a `_shared` credential module plus a job-scoped RPC (§11), with a refresh lock using `select … for update` on the credentials row or an advisory lock. Add event types `credential_used`, `published` and `publish_failed`, and `resource_selected`; this needs the event_type check to be widened.
6. **Meta disconnect coupling:** `revokeMeta` calls `DELETE /me/permissions` (providers.mjs:493-499), which removes **all** of the app's permissions for that user. Disconnecting Instagram therefore also silently kills the Facebook token, and the other way round. Consider merging them into one `meta` connection with sub-resources, or revoking specific permissions (`DELETE /me/permissions/{perm}`).
7. **Expiry monitoring:** Meta user tokens last ~60 days with no refresh. Add a scheduled health and refresh job, plus a warning N days before `credential_expires_at`.
8. **Other hardcoded allow-lists to update if a key is added (for example `meta`):**
   - the SQL `integration_assert_provider`
   - the `integration_status` IN list
   - the Marketing snapshot IN list
   - `integration_connections_category_check`
9. **KEK rotation:** add a re-encrypt action (read with the old version, write with the current one) before rotating with `KEK_V2`.
10. **UI:** Settings has no place for resource selection, publish-permission state, review state or `recent_events`. `scopes_granted`, `scopes_requested` and `scopes_not_requested_yet` are already in the payload but not rendered.
