# Atlas integrations (S88): server-side OAuth and API keys

Status (S88): backend built and tested against the local replay database. S94B publishing
connections are in §10. Nothing is deployed. The
Settings/Marketing/Knowledge web integration will come later and will use the contract in §5.
Until the owner adds the function secrets in §6, every provider reports
`not_configured` with the exact requirement text, and no Connect button should appear.

## 1. Scope

| Provider key | Label | Auth | Atlas uses it for (once connected) |
| --- | --- | --- | --- |
| `google-business-profile` | Google Business Profile | OAuth 2.0 + PKCE | Checks that the Google account can see a Business Profile account and shows its name. |
| `google-drive` | Google Drive | OAuth 2.0 + PKCE | Checks the connected Drive user. Scope `drive.file` only (files the owner picks or Atlas creates). |
| `facebook` | Facebook Page | OAuth 2.0 (state + app secret) | Lists the Pages shared with Atlas and shows them. |
| `instagram` | Instagram | OAuth 2.0 via Facebook Login (state + app secret) | Finds the Instagram professional account linked to a shared Page. |
| `tiktok` | TikTok | OAuth 2.0 Login Kit web (state + client secret) | Reads the connected TikTok user's display name. |
| `tripadvisor` | Tripadvisor | API key (no OAuth) | One read of the VÁ location to confirm the key works. |

**Not built** (and not requested as scopes): posting to Facebook/Instagram/TikTok, reading
insights/analytics, replying to reviews, Business Profile posts or review replies, Drive file sync
into Knowledge, Tripadvisor review import, token use by any other Edge Function, scheduled token
refresh, KEK rotation job. The registry lists the extra scopes these would need in
`scopes_not_requested_yet`; adding them later means another consent and, for Meta and TikTok,
another app review.

## 2. Architecture

```
Browser (Settings, manager/admin)
   │  GET  ?action=status            ──► atlas-integrations (Edge Function, verify_jwt=false)
   │  POST ?action=start|test|disconnect|save-api-key      │ 1. validates the Atlas JWT against the
   │                                                        │    production Auth project + active profile
   │  ◄── { authorize_url }                                 │ 2. manager/admin only
   │                                                        │ 3. service-role RPC ► atlas_private.*
   ▼
Provider consent screen (Google / Meta / TikTok)
   │  302 to https://<project>.supabase.co/functions/v1/atlas-integrations/callback/<provider>?code&state
   ▼
atlas-integrations callback (no JWT; the stored state identifies the manager)
   consume state (single use) → exchange code (+ PKCE verifier, client secret) → AES-256-GCM
   encrypt token set → store ciphertext → live provider check → record result
   │  302 to <ATLAS_INTEGRATIONS_APP_ORIGINS[0]>/?integration=<key>&result=connected|error[&reason=…]#<return_path>
   ▼
Browser shows the result from the query string, then reloads status.
```

Files:

- `supabase/functions/atlas-integrations/index.ts`: Deno entry. Wires `Deno.env`, `fetch`,
  the service-role RPC and JWT/profile authentication into the handler.
- `supabase/functions/atlas-integrations/handler.mjs`: all request handling, with dependencies
  injected. Node tests import it directly.
- `supabase/functions/atlas-integrations/providers.mjs`: provider registry, configuration checks,
  authorize URL builder, code exchange, refresh, live check and revoke per provider.
- `supabase/functions/atlas-integrations/oauth-core.mjs`: pure helpers. PKCE S256, state
  generation and hashing, AES-256-GCM (WebCrypto), redirect/return allow-lists, output hygiene.
- `supabase/migrations/20260926095000_s88_integrations_oauth.sql`: tables and service-role RPCs.
- `supabase/config.toml`: `[functions.atlas-integrations] verify_jwt = false`. The S42 cutover
  manifest hash for `config.toml` is updated to match.

## 3. Data model (all `atlas_private`, RLS on, service-role-only)

`integration_connections` (existing, extended). New columns: `auth_kind` (`oauth2|api_key|none`),
`scopes_granted text[]`, `connected_by`, `connected_by_label`, `connected_at`, `disconnected_at`.
The existing `status`, `authorization_state`, `external_account_label`, `last_verified_at`,
`token_expires_at` and `last_connection_error` keep their meanings, so the Settings, Operations,
System and Marketing snapshots keep working. None of those snapshots read the new tables.

| Table | Columns (summary) | Notes |
| --- | --- | --- |
| `integration_credentials` | `provider_key` PK/FK, `credential_kind` (`oauth_token_set|api_key`), `ciphertext bytea`, `nonce bytea(12)`, `key_version`, `access_expires_at`, `refresh_expires_at`, `external_account_id`, `created_by`, `created_at`, `rotated_at` | One row per provider. Plaintext never reaches the database. |
| `integration_oauth_states` | `state_hash bytea(32)` PK, `provider_key`, `actor_id`, `actor_label`, `actor_role` (admin/manager), `verifier_ciphertext`, `verifier_nonce`, `key_version`, `return_path` (hash route only), `created_at`, `expires_at` (+10 min), `consumed_at` | Stores sha256(state), never the raw state. The PKCE verifier is encrypted. Rows older than 1 day are purged on each start. |
| `integration_events` | `id`, `provider_key`, `event_type`, `actor_id`, `actor_label`, `payload jsonb`, `created_at` | Types: `connect_started, credential_stored, connected, callback_failed, verified, verify_failed, refreshed, refresh_failed, disconnected, api_key_saved` and (S94B) `publish_scope_requested, resource_listed, resource_selected, credential_used, review_state_set`. A check constraint rejects credential-shaped keys at any depth. |
| `integration_resources` (S94B) | `provider_key`, `resource_kind` (`facebook_page, instagram_account, gbp_account, gbp_location, tiktok_account`), `resource_id`, `parent_resource_id`, `label`, `metadata` (non-secret), `selected`, `selected_at/by/by_label`, `refreshed_at` | Unique (provider, kind, id); at most one selected per (provider, kind) (partial unique index). |
| `integration_resource_credentials` (S94B) | `provider_key`, `resource_kind` (`facebook_page, instagram_account`), `resource_id` (FK to the resource), `ciphertext`, `nonce`, `key_version`, `created_by`, `created_at`, `rotated_at` | The selected Page's access token only. AAD `atlas-integrations|<provider>|resource|<resource_id>`. |

S94B also adds `integration_connections.publishing_review_state` (`not_required, unknown, required,
pending, approved, rejected`, default `unknown`), `integration_oauth_states.purpose`
(`connect|publishing`) and a refresh lease on `integration_credentials` (`refresh_lock_token`,
`refresh_locked_until`, `refresh_lock_actor_id`, `refresh_lock_actor_label`).

RPCs. Each is an `atlas_private.integration_*` function with a `public.atlas_integration_*`
wrapper, `search_path=''`. The S88 functions are security invoker; the S94B ones are security
definer. Execute is revoked from `public, anon, authenticated` and granted to `service_role` only.
Every function that acts for a person takes `p_actor_id` and `p_actor_role` and re-checks them
against the active profile (`integration_assert_actor`, S88 hardening 20260926106000):

| Wrapper (current signature) | Purpose |
| --- | --- |
| `atlas_integration_status(p_actor_role, p_actor_id)` | Status rows for the six providers: `has_credential` and expiry, `publishing_permission_state`, `publishing_review_state`, listed `resources` (ids, labels, metadata, `selected`, `has_resource_credential`), last 5 events. No credential columns. Manager/admin. |
| `atlas_integration_begin(p_provider_key, p_state_hash, p_verifier_ciphertext, p_verifier_nonce, p_key_version, p_return_path, p_actor_id, p_actor_label, p_actor_role)` | Stores the hashed state and logs `connect_started`. OAuth providers only. |
| `atlas_integration_set_state_purpose(p_provider_key, p_state_hash, p_purpose, p_actor_id, p_actor_label, p_actor_role)` (S94B) | Marks the actor's just-started, unbound state as `publishing`; logs `publish_scope_requested`. |
| `atlas_integration_bind_browser(p_provider_key, p_state_hash, p_binding_hash)` | Binds an unconsumed state to the browser once; returns `{bound, expires_at, purpose}`. |
| `atlas_integration_consume_state(p_provider_key, p_state_hash, p_binding_hash)` | Single use, bound browser only, initiating user still an active manager/admin. Returns null otherwise. |
| `atlas_integration_store_credential(p_provider_key, p_credential_kind, p_ciphertext, p_nonce, p_key_version, p_access_expires_at, p_refresh_expires_at, p_external_account_id, p_actor_id, p_actor_label, p_actor_role)` | Upserts ciphertext and sets `authorization_required` / `waiting_authorization`. Storing a credential never marks the provider connected. |
| `atlas_integration_read_credential(p_provider_key, p_actor_role, p_actor_id)` | Ciphertext for the function only, used by test, listing, Page-token fetch and revoke. |
| `atlas_integration_record_result(p_provider_key, p_event_type, p_account_id, p_account_label, p_scopes, p_access_expires_at, p_needs_reauthorization, p_error, p_actor_id, p_actor_label, p_actor_role)` | `verified` is the only way to reach `status='connected'` and needs a stored credential. `verify_failed`/`callback_failed`/`refresh_failed` set `degraded` or `expired`. S94B: derives `publishing_permission_state` after every result; `verified` prefers the selected resource as the external account. |
| `atlas_integration_disconnect(p_provider_key, p_actor_id, p_actor_label, p_actor_role)` | Deletes the credential, open states, listed resources and Page tokens, resets the status columns (publishing to `not_requested`; the review state is kept) and logs `disconnected`. |
| `atlas_integration_resources_store(p_provider_key, p_resources, p_actor_id, p_actor_label, p_actor_role)` (S94B) | Replaces the provider's listed resources with a live listing; selects nothing (the single TikTok account is selected because the token belongs to it); logs `resource_listed {resource_count}`. |
| `atlas_integration_resource_select(p_provider_key, p_resource_kind, p_resource_id, p_ciphertext, p_nonce, p_key_version, p_actor_id, p_actor_label, p_actor_role)` (S94B) | Selects one listed, selectable resource; Facebook Page / Instagram account require the Page-token ciphertext, other kinds refuse one; a location also selects its account; only the selected resource keeps a token; logs `resource_selected`. |
| `atlas_integration_read_resource_credential(p_provider_key, p_resource_kind, p_resource_id, p_actor_id, p_actor_role)` (S94B) | Page-token ciphertext for a manager/admin action in the function. |
| `atlas_integration_set_review_state(p_provider_key, p_review_state, p_actor_id, p_actor_label, p_actor_role)` (S94B) | **Administrator only**; logs `review_state_set {previous, review}`. |
| `atlas_integration_publish_targets()` (S94B, no actor) | Readiness for the Marketing gateway, composer and claim gate (§10). |
| `atlas_integration_read_credential_for_delivery(p_delivery_id, p_claim_token)` (S94B, no actor) | Worker only (§10). |
| `atlas_integration_refresh_lock(p_provider_key, p_delivery_id, p_claim_token, p_actor_id, p_actor_label, p_actor_role, p_lease_seconds)`, `atlas_integration_refresh_store(p_provider_key, p_lock_token, p_ciphertext, p_nonce, p_key_version, p_access_expires_at, p_refresh_expires_at)`, `atlas_integration_refresh_release(p_provider_key, p_lock_token, p_error, p_needs_reauthorization)` (S94B) | The refresh lease (§10). |

## 4. Security model

- **Tokens never reach the browser.** The browser receives only the fields listed in §5. Every JSON
  response passes `assertNoSecretFields()`, which withholds any payload containing keys such as
  `access_token`, `refresh_token`, `api_key`, `code`, `state`, `ciphertext`, `nonce` or `verifier`
  (HTTP 500 instead). Client secrets are read only from function secrets. `apps/web` contains no
  secret names; a Node test enforces this.
- **Encryption.** AES-256-GCM through WebCrypto in the Edge Function, with a random 96-bit nonce
  for every encryption and a 128-bit tag. The key comes from `ATLAS_INTEGRATION_KEK_V<n>`
  (base64, 32 bytes). `ATLAS_INTEGRATION_KEK_CURRENT_VERSION` selects the key for new writes, and
  reads use the row's `key_version`. The AAD is `atlas-integrations|<provider>|<kind>`, or
  `…|pkce:<state_hash>` for PKCE verifiers, so ciphertext cannot be moved between providers or
  states. A database dump alone cannot decrypt anything. Supabase Vault was not used because the
  replay database has no Vault and because it would put the key and the data behind the same
  service-role credential.
- **State.** 256-bit random value, base64url. Only its sha256 is stored. It is single-use,
  bound to one provider and valid for 10 minutes. The callback identity (manager id and label)
  comes from the state row, never from query parameters.
- **Browser binding (S88 hardening F10).** `start` returns an Atlas *authorize hop* on the
  functions domain (`…/atlas-integrations/authorize/<provider>?state=…&cc=…`), not the provider
  URL. When the browser opens it (a top-level navigation), the function binds the pending state
  to that browser once (`atlas_integration_bind_browser`: sha256 of a random 256-bit nonce) and
  sets the nonce in a `__Host-atlas-oauth-<provider>` cookie (`Secure; HttpOnly; SameSite=Lax;
  Path=/; Max-Age=600`), then redirects to the provider. The callback only consumes the state
  when the same cookie comes back (`atlas_integration_consume_state(provider, state_hash,
  binding_hash)`); the cookie is cleared on every callback. A copied `authorize_url` opened later
  in another browser is refused (`reason=invalid_state`), and a callback without the cookie is
  refused without consuming the state (`reason=browser_mismatch`). A cookie was chosen over a
  value returned to the app because the callback runs on the Supabase functions domain, which
  cannot read the app origin's storage; the cookie is first-party to the functions domain and
  `SameSite=Lax` is sent on the provider's top-level redirect back. Deployment check: the
  `Set-Cookie` header of the hop must reach the browser (if a proxy ever strips it, connections
  fail closed with `browser_mismatch`).
- **Initiator re-check (F10).** At the callback the database re-reads the initiating user's
  profile: it must still be active and `manager` or `admin` (the *current* role is used, not the
  role recorded at start). Otherwise the state is consumed, nothing is exchanged or stored, and
  the browser returns with `reason=not_authorized`.
- **PKCE.** S256 for Google (Business Profile and Drive). Meta's manual web login flow and
  TikTok's web Login Kit document a confidential client (state plus a server-side secret) and do
  not document PKCE for web, so PKCE is not sent to them. The flag is per provider in the registry.
- **Redirect URI.** Built only from `ATLAS_INTEGRATIONS_PUBLIC_URL` (defaults to `SUPABASE_URL`).
  It must be https, with no path, query, fragment or user info, on a host in
  `ATLAS_INTEGRATIONS_CALLBACK_HOSTS` (default `*.supabase.co`, one label deep). The result is
  `https://<host>/functions/v1/atlas-integrations/callback/<provider>`. Google and Meta require an
  exact match, so the owner registers that exact string.
- **Return target.** The first https origin in `ATLAS_INTEGRATIONS_APP_ORIGINS`, plus a
  validated hash route (`#settings`, `#marketing/connections`, …). A caller-supplied absolute URL
  is rejected by both the function and a database check.
- **Truthful status.** A provider is `connected` only after a live provider call succeeds
  (`verify`). A failed check sets `verification_failed` or `needs_reauthorization` and stores a
  sanitised error (no tokens, codes or long opaque strings, at most 240 characters). Provider
  response bodies are never forwarded to the browser.
- **Roles.** Every action except the authorize hop and the callback requires a valid Atlas JWT
  and an active profile with the `manager` or `admin` role. Every service-role RPC receives the
  actor id and re-checks it against `public.profiles` (active, exactly that role, manager/admin),
  so a claimed role alone is never trusted (`atlas_private.integration_assert_actor`, S88
  hardening F7).
- **Error text (F9).** Browser responses never carry PostgREST or provider text: RPC failures map
  to fixed messages by class (`forbidden`, `invalid_request`, `unavailable`), provider check
  failures return a fixed message with `error_code: "provider_check_failed"` or
  `"provider_refresh_failed"`, and the sanitised provider detail is kept only in the audit row
  (`last_error`, events). The SQLSTATE is logged server-side without payloads.
- **Disconnect.** Revokes at the provider where an endpoint exists (Google `oauth2.googleapis.com/revoke`,
  Meta `DELETE /me/permissions`, TikTok `/v2/oauth/revoke/`). This is best effort; the local
  credential is always deleted.
- **Residual risks.** The callback URL is public (mitigated by hashed single-use state, PKCE where
  supported and the exact redirect). Losing the KEK means every provider must be reconnected, so
  the owner must back up the key outside Supabase. Meta long-lived tokens last about 60 days and
  have no refresh token, so Facebook and Instagram need reconnecting when `credential_expires_at`
  passes.

## 5. API contract for the frontend

Base URL: `https://<auth project>.supabase.co/functions/v1/atlas-integrations` (add
`INTEGRATIONS_API` to `apps/web/config.js` when integrating). Send the Atlas session JWT as
`Authorization: Bearer <jwt>` and the publishable key as `apikey`. Every non-callback action is
**manager/admin only**; other roles get `403`.

### `GET ?action=status`

```json
{
  "providers": [
    {
      "provider_key": "google-drive",
      "label": "Google Drive",
      "auth_kind": "oauth2",
      "connection_state": "not_configured | ready | verifying | connected | verification_failed | needs_reauthorization | pending_review",
      "configured": false,
      "available_message": "Not set up yet.",
      "enables": "Lets Atlas save and open files you choose in Google Drive.",
      "missing_requirements": ["the integration encryption key", "a Google Cloud OAuth client ID"],
      "can_connect": false,
      "can_save_api_key": false,
      "can_test": false,
      "can_disconnect": false,
      "endpoint_evidence": "documented | unverified",
      "scopes_requested": ["https://www.googleapis.com/auth/drive.file"],
      "scopes_not_requested_yet": [],
      "scopes_granted": [],
      "account_label": null,
      "last_verified_at": null,
      "credential_expires_at": null,
      "last_error": null,
      "connected_by_label": null,
      "connected_at": null,
      "disconnected_at": null,
      "redirect_uri_to_register": "https://<project>.supabase.co/functions/v1/atlas-integrations/callback/google-drive",
      "setup_details": null,
      "recent_events": [{ "event_type": "verified", "actor_label": "…", "created_at": "…" }]
    }
  ],
  "policy": { "credentials_returned": false, "connected_requires_live_provider_check": true, "automatic_publishing_enabled": false },
  "staff": { "role": "manager", "can_manage_integrations": true }
}
```

S91: the status is owner copy. `available_message` is "Not set up yet." and `enables` is one short
sentence of what connecting gives; `missing_requirements` is plain language without secret names.
Only an administrator's response carries `setup_details`
`{ "summary": "Google Cloud project with the Drive API enabled, …", "requirements": [{ "name": "ATLAS_GOOGLE_OAUTH_CLIENT_ID", "label": "a Google Cloud OAuth client ID" }] }`
(function secret names, never values); Settings › Integrations shows it behind a closed
"Setup details" disclosure for administrators only. Managers get `setup_details: null`.

States:

| `connection_state` | Meaning | UI |
| --- | --- | --- |
| `not_configured` | Server prerequisites missing | "Not set up yet" and `enables`; administrators also get "Setup details"; no buttons. |
| `ready` | Configured, no credential | **Connect** (OAuth) or an API key field (`can_save_api_key`). |
| `verifying` | Credential stored, live check not yet successful | **Test**, **Disconnect**. |
| `connected` | Credential stored and the last live check succeeded | Account label, last verified, **Test**, **Disconnect**. |
| `verification_failed` | Last check failed (not an auth problem) | `last_error`, **Test**, **Disconnect**. |
| `needs_reauthorization` | Token expired, revoked or missing permissions | **Connect** again (or save a new key), **Disconnect**. |
| `pending_review` | Status set to `pending_review` by an admin while a platform review is open | Informational. |

### `POST ?action=start` — body `{ "provider_key": "google-drive", "return_path": "#settings" }`

`200 { "provider_key", "authorize_url", "expires_at" }`. Navigate with `location.assign(authorize_url)`
in the same browser (it is the Atlas authorize hop; it binds the flow to this browser and then
redirects to the provider). Do not open it in another window or share it.
`409 { "error": "Google Drive is not set up yet.", "error_code": "not_configured", "provider_key", "missing_requirements" }`.
`400` for an API-key provider or an invalid `return_path` (hash routes only, default `#settings`).

### Callback (provider → function → browser)

The function redirects to `<app origin>/?integration=<provider_key>&result=connected#<return_path>`, or
`…&result=error&reason=<reason>` where `reason` ∈ `invalid_state`, `denied`, `missing_code`,
`not_configured`, `exchange_failed`, `verify_failed`, `unknown_provider`, `method`,
`browser_mismatch` (the callback came without the binding cookie of the browser that started
it; start again in this browser) or `not_authorized` (the user who started it is no longer an
active manager or administrator). Show one notice, remove the query with
`history.replaceState`, then reload `status`. Details are in `last_error`.

### `POST ?action=test` — body `{ "provider_key": "…" }`

Refreshes the access token first when it expires within 5 minutes (Google, TikTok), then runs the
live check. Returns `200 { "provider": <status row>, "verified": true|false, "message": string|null }`
(plus `error_code` ∈ `provider_check_failed`, `provider_refresh_failed`, `credential_unreadable`
when `verified` is false; `message` is fixed text, never the provider's),
`409 error_code:"not_configured"` or `409 error_code:"not_connected"`.

Every error response is `{ "error": <fixed message>, "error_code": <code>, … }` with
`error_code` ∈ `invalid_request`, `unauthorized`, `forbidden`, `not_found`,
`method_not_allowed`, `conflict`, `too_large`, `not_configured`, `not_connected`,
`unavailable`, `internal`. JSON bodies over 16 KB are refused from `content-length` before they
are read, and streamed bodies are cut off at the limit.

### `POST ?action=disconnect` — body `{ "provider_key": "…" }`

`200 { "provider": <status row>, "revoked_at_provider": true|false }`. Always removes the local credential.

### `POST ?action=save-api-key` — body `{ "provider_key": "tripadvisor", "api_key": "…" }`

Encrypts and stores the key, then runs the live check. Returns the same shape as `test`. The key
is never returned. `409 not_configured` until the Tripadvisor settings in §6 exist.

### S94B additions (publishing connections; see §10)

- Every status row of a publishing provider (Facebook, Instagram, TikTok, Google Business
  Profile) carries `publishing`:
  `{ supported, permission_state, review_state, resource_kind, resource: {kind,id,label}|null,
  resource_count, ready, reason, direct_post, scopes_for_publishing, can_allow_publishing,
  can_choose_resource, can_set_review_state }` (`null` for Drive and Tripadvisor). `reason` uses
  the readiness vocabulary of §10 plus `not_configured`.
- `POST ?action=start` accepts `purpose: "connect" | "publishing"`; `publishing` (Allow publishing)
  asks for connect ∪ publish scopes (Meta also sends `auth_type=rerequest`). The response adds
  `purpose` and `scopes_requested`.
- `POST ?action=list-resources` `{provider_key}` → `{ provider, resource_kind, resources:
  [{resource_kind, resource_id, parent_resource_id, label, selected, selectable,
  unavailable_reason, details}], notes }`. Live provider call; nothing is selected by default.
- `POST ?action=select-resource` `{provider_key, resource_kind?, resource_id}` → `{ provider,
  selected: {kind, id, label} }`. `409 resource_not_listed | resource_not_selectable |
  provider_check_failed`.
- `POST ?action=set-review-state` `{provider_key, review_state}` → `{ provider }`.
  Administrators only (`403 forbidden` otherwise).
- `POST ?action=disconnect` adds `revoked_permissions` when only this provider's Meta
  permissions were revoked.
- `POST ?action=test` refreshes under the shared lease and may answer
  `error_code: "refresh_in_progress"`.

## 6. Function secrets (Supabase → Edge Functions → Secrets; never in `apps/web`)

| Secret | Needed for | Value |
| --- | --- | --- |
| `ATLAS_INTEGRATION_KEK_V1` | all | `openssl rand -base64 32`. Back it up outside Supabase. |
| `ATLAS_INTEGRATION_KEK_CURRENT_VERSION` | rotation | Optional; default `1`. |
| `ATLAS_INTEGRATIONS_APP_ORIGINS` | all | The https Atlas web origin (comma list; the first one is used for returns). |
| `ATLAS_INTEGRATIONS_PUBLIC_URL` | OAuth | Optional; defaults to `SUPABASE_URL`. |
| `ATLAS_INTEGRATIONS_CALLBACK_HOSTS` | OAuth | Optional; default `*.supabase.co`. |
| `ATLAS_GOOGLE_OAUTH_CLIENT_ID` / `ATLAS_GOOGLE_OAUTH_CLIENT_SECRET` | Business Profile, Drive | Google Cloud OAuth web client. |
| `ATLAS_META_APP_ID` / `ATLAS_META_APP_SECRET` | Facebook, Instagram | Meta app. |
| `ATLAS_META_GRAPH_VERSION` | Facebook, Instagram | Optional; default `v25.0`. |
| `ATLAS_TIKTOK_CLIENT_KEY` / `ATLAS_TIKTOK_CLIENT_SECRET` | TikTok | TikTok for Developers app. |
| `ATLAS_TRIPADVISOR_VERIFY_URL` | Tripadvisor | Confirmed Terra location-details URL on `https://terra.tripadvisor.com/…`; may contain `{location_id}`. |
| `ATLAS_TRIPADVISOR_LOCATION_ID` | Tripadvisor | VÁ location ID. |

## 7. Owner requirements per provider

The redirect URI to register is `https://<project-ref>.supabase.co/functions/v1/atlas-integrations/callback/<provider_key>`.
The status response also returns it as `redirect_uri_to_register`.

| Provider | Developer app / registration | Scopes Atlas requests now | Review / verification | Business prerequisites | Endpoints (evidence) |
| --- | --- | --- | --- | --- | --- |
| **Google Business Profile** | Google Cloud project; OAuth consent screen (External, In production); OAuth client type "Web application" with the exact redirect URI; after approval, enable the Business Profile APIs (My Business Account Management, Business Information; Performance and the v4 reviews/posts API only when those features are built). | `https://www.googleapis.com/auth/business.manage` | **Business Profile API access request** (GBP API contact form, "Application for Basic API Access", with the Cloud **project number**, sent from an email that is owner/manager on the profile). Until it is approved, the APIs are hidden or have zero quota, and Test reports `verification_failed`. `business.manage` is a **sensitive** scope, so Google OAuth app verification is needed (privacy policy, homepage, authorised and verified domain). | A verified, active Business Profile for VÁ; reports say Google expects it to be about 60+ days old with a website. The connecting Google account must be owner/manager of the location. | Authorize `https://accounts.google.com/o/oauth2/v2/auth`; token `https://oauth2.googleapis.com/token`; revoke `https://oauth2.googleapis.com/revoke`; check `GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts` (documented). |
| **Google Drive** (Knowledge) | Same Cloud project and client; enable the Google Drive API; add the redirect URI for `google-drive`. | `https://www.googleapis.com/auth/drive.file` | `drive.file` is **non-sensitive**, so only standard consent-screen setup is needed. `drive.readonly` would be **restricted** (verification plus a CASA security assessment) and is deliberately not used. | Owner decides which files/folders to share (Google Picker when the sync is built). | Google endpoints above; check `GET https://www.googleapis.com/drive/v3/about?fields=user(displayName,permissionId)` (documented). |
| **Facebook Page** | Meta developer account; **Business**-type app with **Facebook Login for Business**; add the Valid OAuth Redirect URI; privacy policy URL, terms URL, data-deletion instructions/callback; app icon and category. | `pages_show_list`, `pages_read_engagement` | **Business verification** in Meta Business Manager. **App Review** (Advanced Access) for every permission used with accounts that have no role on the app. App switched to **Live** mode. Publishing later needs `pages_manage_posts` (+ `read_insights` for insights, `business_management` when the Page is owned through Business Manager), each with its own review. | The VÁ Facebook Page, connected by a person with full control of it. | Dialog `https://www.facebook.com/v25.0/dialog/oauth`; token `https://graph.facebook.com/v25.0/oauth/access_token`, then `grant_type=fb_exchange_token` for a long-lived (~60 day) user token; check `GET /me/permissions` + `GET /me/accounts`; revoke `DELETE /me/permissions` (documented; v25.0 is current as of Feb 2026, and `ATLAS_META_GRAPH_VERSION` overrides it). |
| **Instagram** | Same Meta app (Instagram API with Facebook Login for Business). | `instagram_basic`, `pages_show_list` | Business verification + **App Review** for `instagram_basic` (and later `instagram_content_publish`, `instagram_manage_insights`, `pages_read_engagement`); app Live. Publishing is limited to 100 API posts per 24 h per account. | An Instagram **professional** (Business or Creator) account **linked to the VÁ Facebook Page**. | Same Meta endpoints; check `GET /me/accounts?fields=name,instagram_business_account{id,username}` (documented). Some Page setups also need `pages_read_engagement` or `business_management` to read the linked account; if Test says "not linked", request those (unverified for VÁ's setup). |
| **TikTok** | TikTok for Developers account and app; add **Login Kit** (web) and register the redirect URI; add terms of service and privacy policy URLs; verify URL properties (domain/URL-prefix) where required. | `user.info.basic` | **App review** before the app works for other users. Publishing later needs the **Content Posting API** with `video.upload`/`video.publish`. Until TikTok's **audit** passes, posts from unaudited clients are private (`SELF_ONLY`) and limited to a few users per day. `video.list` is needed for analytics. | The VÁ TikTok account (Business account recommended). | Authorize `https://www.tiktok.com/v2/auth/authorize/` (param `client_key`, comma-separated scopes); token `https://open.tiktokapis.com/v2/oauth/token/`; revoke `https://open.tiktokapis.com/v2/oauth/revoke/`; check `GET https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name` (documented; PKCE is documented for desktop/mobile only). |
| **Tripadvisor** | No OAuth. A Tripadvisor developer account and an API key. The legacy **Content API** (`api.content.tripadvisor.com/api/v1/location/{id}/details?key=…`, pay-as-you-go, domain/IP-restricted keys, up to 5 recent reviews per location) was reported as **sunset on 31 Aug 2026** in favour of the self-serve **Terra** API (`X-API-KEY` header on `terra.tripadvisor.com`; first 1,000 calls free, then pay-as-you-go; display attribution required: bubble rating, review date, Tripadvisor credit). | n/a | Accept the Terra/Content API terms, including the display and attribution rules and the ban on storing content beyond what the terms allow. Review **responses** stay manual in the Tripadvisor Management Center; no API is used for them. | Claimed VÁ listing (Management Center access); the VÁ **location ID**. | **Unverified.** The exact Terra location-details path could not be confirmed from primary docs (docs.terra.tripadvisor.com was unreachable from the build environment). The owner confirms it and sets `ATLAS_TRIPADVISOR_VERIFY_URL`; until then the provider stays `not_configured`. |
| Web push (not OAuth) | Unchanged; see the S87 health report §14.4. | | | | |

Engineering can build and test everything above without credentials. Status stays
`not_configured` until the owner adds the secrets, and `connected` appears only after a live
provider check passes.

## 8. Tests

- `tests/node/integrations-oauth-s88.test.js` (Node, `npm test`) covers:
  - PKCE against the RFC 7636 vector.
  - State hashing, single use and expiry.
  - AES-GCM round trip, and rejection of tampered ciphertext, a changed nonce, the wrong AAD or the wrong key.
  - The redirect and return allow-lists.
  - Registry endpoints and scopes.
  - "Not available yet" responses.
  - A full Google Drive flow against an in-memory database and a fake provider: PKCE verifier matches the challenge, the database never receives plaintext, replay is rejected, and a failed check never reports connected.
  - Role gating.
  - The response guard.
  - A source contract: no token fields in responses, no secret names in `apps/web`, table and RLS grants in the migration, and the `config.toml` entry.
- `scripts/verify_s88_integrations_preview.sql`, run by `scripts/verify_s88_integrations_previews.sh`
  and the `migration-replay` workflow, checks against the replayed database:
  - anon, authenticated and PUBLIC have no table or function privileges.
  - A manager JWT cannot read the credential, state or event tables and cannot call the reader or state RPCs.
  - State is single-use, provider-bound and expires.
  - Absolute return targets are rejected.
  - `connected` needs a credential.
  - A failed check sets expired, not connected.
  - Events reject nested token keys.
  - The settings, operations and marketing snapshots carry no credential keys.
  - Only integration RPCs reference the credential tables.
  - Disconnect clears the credential and resets status.

## 9. Sources checked (September 2026)

Several primary documentation hosts (developers.google.com, developers.facebook.com,
developers.tiktok.com, developer-tripadvisor.com, docs.terra.tripadvisor.com) were blocked by the
build environment's network proxy. The endpoints above were confirmed through search results that
quote those pages, plus long-standing documented values. Re-check each row against the live docs
when the owner registers the apps.

- Google OAuth web server flow, revoke endpoint and PKCE parameters: developers.google.com/identity/protocols/oauth2/web-server
- Business Profile API prerequisites and access request: developers.google.com/my-business/content/prereqs, …/basic-setup
- Drive scope classification: developers.google.com/workspace/drive/api/guides/api-specific-auth
- Meta manual login flow and Graph API versions: developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/, developers.facebook.com/docs/graph-api/changelog/versions/
- Instagram content publishing: developers.facebook.com/docs/instagram-platform/content-publishing/
- TikTok Login Kit web and token management: developers.tiktok.com/doc/login-kit-web, developers.tiktok.com/doc/oauth-user-access-token-management
- TikTok Content Posting API audit and private-only restriction: developers.tiktok.com/docs/en/content-posting-api-get-started
- Tripadvisor Content API and the Terra migration: tripadvisor-content-api.readme.io/reference/overview, docs.terra.tripadvisor.com/docs/overview

## 10. S94B publishing connections

Contract: `docs/marketing/S94_Publishing_Architecture.md` §4 (binding), research reports 02, 04–06
and 08 §12. Migration `supabase/migrations/20261004091000_s94b_publishing_connections.sql`.

### Scopes

| Provider | `scopes` (connect/verify) | `publish_scopes` (Allow publishing) |
| --- | --- | --- |
| facebook | `pages_show_list, pages_read_engagement` | `pages_show_list, pages_read_engagement, pages_manage_posts, business_management` |
| instagram | `instagram_basic, pages_show_list` | `instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement, business_management` |
| tiktok | `user.info.basic` | `video.upload, video.publish` |
| google-business-profile | `https://www.googleapis.com/auth/business.manage` | none extra (`business.manage` covers local posts) |

Verify still requires only `scopes`. `publishing_permission_state` is derived in SQL after every
verify, resource change and review change: `granted` when every publish scope is in
`scopes_granted` (Google Business Profile: `business.manage`, a selected location and a review
state that is not `required/pending/rejected`), `missing` when verified without them, `pending`
(Business Profile only) while the location or API access is not confirmed, `not_requested`
before a verified connection. A verified connection with publish permission therefore reads
`connected` in the Marketing display (report 02 §9 fixed).

### Resources (no `[0]` defaults)

| Kind | Listed from | `resource_id` | Selectable when |
| --- | --- | --- | --- |
| `facebook_page` | `GET graph.facebook.com/{v}/me/accounts?fields=id,name,category,tasks&limit=100` (paging.next followed on graph.facebook.com only, its `access_token` query parameter removed) | Page id | `tasks` contains `CREATE_CONTENT` |
| `instagram_account` | `GET …/me/accounts?fields=id,name,tasks,instagram_business_account{id,username,name}&limit=100` | IG user id; parent = Page id | its Page's `tasks` contains `CREATE_CONTENT` |
| `gbp_account` / `gbp_location` | `GET mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20`, then `GET mybusinessbusinessinformation.googleapis.com/v1/{account}/locations?readMask=name,title,storefrontAddress,metadata&pageSize=100` | `accounts/{a}` / `accounts/{a}/locations/{l}` (the v4 localPosts parent) | role is not `SITE_MANAGER` and `hasVoiceOfMerchant` is not false |
| `tiktok_account` | `GET open.tiktokapis.com/v2/user/info/?fields=open_id,display_name` (also recorded after every successful verify) | `open_id` | always (one account per token; selected automatically) |

Selecting a Facebook Page or an Instagram account fetches the Page access token with
`GET graph.facebook.com/{v}/{page-id}?fields=id,access_token` (the Instagram account's parent
Page), encrypts it (AAD `atlas-integrations|<provider>|resource|<resource_id>`) and stores it in
`integration_resource_credentials`. A Page token derived from a long-lived user token does not
expire; it is re-fetched whenever the Page is chosen again.

### Readiness: `atlas_integration_publish_targets()`

Array in the order instagram, facebook, tiktok, google-business-profile of
`{provider_key, connection_state, publishing_permission_state, publishing_review_state,
resource: {kind,id,label}|null, ready, reason, target_kinds}`. `reason` (first match):
`not_connected`, `review_pending` (status `pending_review`), `needs_reauthorization`
(expired, degraded or unverified; Meta tokens past expiry), Business Profile `pending` →
`no_resource_selected | review_pending | review_required`, `publishing_permission_missing`,
`review_required` (review `required/rejected`, not TikTok), `review_pending` (not TikTok),
`no_resource_selected`. `not_configured` depends on function secrets the database cannot see;
the gateways add it. `target_kinds` is what the review state allows: Instagram `ig_feed,
ig_carousel, ig_reel`; Facebook `fb_page_post, fb_page_photo, fb_page_video, fb_reel`; TikTok
`tiktok_inbox_video` (+ `tiktok_video` when review is `approved`); Google `gbp_local_post`.

### Worker token access: `_shared/integrations/credentials.mjs`

`openPublishingCredential({ rpc, env, fetchImpl, now, sleep? }, { deliveryId, claimToken })` →
`{ provider_key, access_token, resource: {kind, id, label}, expires_at }`. It calls
`atlas_integration_read_credential_for_delivery(p_delivery_id, p_claim_token)`, which returns
ciphertext only when the delivery is claimed with that token and `claimed_until > now()`, is not
closed, its content is `approved` or `scheduled`, the connection is `connected` with publishing
`granted`, and the delivery's `external_account_id` is the selected resource (otherwise
`{granted:false, reason}` with `not_claimed | not_found | delivery_closed | not_approved |
not_connected | needs_reauthorization | publishing_permission_missing | no_resource_selected |
resource_changed | publishing_not_installed`, no ciphertext, no event). A granted read records
`credential_used {delivery_id, resource_kind}`. Facebook and Instagram get the Page token; TikTok
and Google get the user token. `access_token` is kept out of `JSON.stringify` (`toJSON`).
Errors are `CredentialError { code, retryable, reauthorize }`; nothing is logged.

`atlas_private.marketing_deliveries` is created by the later S94C migration. The functions that
read it are plpgsql (resolved at run time) and check `to_regclass()` first, so the S94B migration
applies on its own and refuses with `publishing_not_installed` until S94C is applied.

Refresh (Google, TikTok) happens under a database lease because a PostgREST call cannot hold a
row lock across the provider call: `atlas_integration_refresh_lock` (a live delivery claim for
that provider, or an active manager/admin for Settings Test) gives one caller a 10–120 s lease and
returns the current ciphertext to everyone; the holder refreshes, then
`atlas_integration_refresh_store` (re-stores, logs `refreshed`, releases) or
`atlas_integration_refresh_release` (with an error: logs `refresh_failed`, marks the connection
expired/degraded). A caller without the lease waits and re-reads, so a rotating TikTok refresh
token is spent once. `readTikTokCreatorInfo(deps, {actorId, actorRole})` returns the composer's
creator info (`POST open.tiktokapis.com/v2/post/publish/creator_info/query/`) without the avatar
URL.

The AES-GCM helpers moved to `_shared/integrations/crypto.mjs` and the provider HTTP/refresh
helpers to `_shared/integrations/provider-http.mjs`; `atlas-integrations` re-exports them
unchanged. The publishing worker needs the same `ATLAS_INTEGRATION_KEK_V<n>` secrets (project-wide)
and, for refresh, the Google/TikTok client secrets.

### Meta disconnect coupling

Facebook and Instagram share one Meta app. Disconnecting one while the other still has a
credential revokes only its own permissions (`DELETE graph.facebook.com/{v}/me/permissions/{permission}`
for its connect ∪ publish scopes minus the other's); the last one revokes the app
(`DELETE /me/permissions`).

### Settings › Integrations

Per card: pill + status line + next step for Not set up yet, Ready to connect, Checking,
Connected, Publishing allowed, Publishing permission missing (**Allow publishing**), Needs
reconnecting (**Reconnect**), Verification failed, App review required, Platform review pending,
No Page / account / location chosen (**Choose …**, opens the picker sheet; also opened once after
returning from the provider when a target is missing). A capability list, "Recent activity"
(event labels only) and, for administrators, a "Platform review" control. The picker lists the
live accounts with none pre-selected, shows why an account cannot be used and confirms before
changing an existing choice. Tokens, secrets and provider URLs never reach the page.

### Tests

`tests/node/integrations-publishing-s94.test.js`, `tests/browser/settings-integrations-s94.browser.test.mjs`
and `scripts/verify_s94b_connections_preview.sql` (in `scripts/verify_s90_workflow_integrity_previews.sh`).

### UNVERIFIED (recheck on the live pages before the first real publication)

`auth_type=rerequest` on the Meta dialog; `DELETE /me/permissions/{permission}`; Meta paging and
`tasks` behaviour when `/me/accounts` is empty or Pages sit in a Business portfolio; whether IG
publishing needs the Page token or the user token per edge (Atlas uses the Page token);
`SITE_MANAGER` posting rights on Business Profile; TikTok `creator_info` field names
(`creator_username`) and error codes; TikTok rotating refresh token semantics.

