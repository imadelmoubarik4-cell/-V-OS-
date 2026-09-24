# Atlas integrations (S88): server-side OAuth and API keys

Status: backend built and tested against the local replay database. Nothing is deployed. The
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
| `integration_events` | `id`, `provider_key`, `event_type`, `actor_id`, `actor_label`, `payload jsonb`, `created_at` | Types: `connect_started, credential_stored, connected, callback_failed, verified, verify_failed, refreshed, refresh_failed, disconnected, api_key_saved`. A check constraint rejects credential-shaped keys at any depth. |

RPCs. Each is an `atlas_private.integration_*` function (security invoker, `search_path=''`) with a
`public.atlas_integration_*` wrapper. Execute is revoked from `public, anon, authenticated` and
granted to `service_role` only:

| Wrapper | Purpose |
| --- | --- |
| `atlas_integration_status(p_actor_role)` | Status rows for the six providers: `has_credential` and expiry, with no credential columns. Manager/admin. |
| `atlas_integration_begin(provider, state_hash, verifier_ciphertext, verifier_nonce, key_version, return_path, actor…)` | Stores the hashed state and logs `connect_started`. OAuth providers only. |
| `atlas_integration_consume_state(provider, state_hash)` | Single use: `update … set consumed_at=now() where … consumed_at is null and expires_at > now() returning …`. Returns null otherwise. |
| `atlas_integration_store_credential(…)` | Upserts ciphertext and sets `authorization_required` / `waiting_authorization`. Storing a credential never marks the provider connected. |
| `atlas_integration_read_credential(provider, role)` | Ciphertext for the function only, used by test, refresh and revoke. |
| `atlas_integration_record_result(provider, event, …)` | `verified` is the only way to reach `status='connected'` and needs a stored credential. `verify_failed`/`callback_failed`/`refresh_failed` set `degraded` or `expired`. |
| `atlas_integration_disconnect(provider, actor…)` | Deletes the credential and any open states, resets the status columns and logs `disconnected`. |

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
  bound to one provider and valid for 10 minutes. The callback identity (manager id, label and
  role at start time) comes from the state row, never from query parameters.
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
- **Roles.** Every action except the callback requires a valid Atlas JWT and an active profile
  with the `manager` or `admin` role. The RPCs check the role again.
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
      "available_message": "Not available yet — requires … and ….",
      "missing_requirements": ["…"],
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
      "owner_requirements_summary": "…",
      "recent_events": [{ "event_type": "verified", "actor_label": "…", "created_at": "…" }]
    }
  ],
  "policy": { "credentials_returned": false, "connected_requires_live_provider_check": true, "automatic_publishing_enabled": false },
  "staff": { "role": "manager", "can_manage_integrations": true }
}
```

States:

| `connection_state` | Meaning | UI |
| --- | --- | --- |
| `not_configured` | Server prerequisites missing | Show `available_message`; no buttons. |
| `ready` | Configured, no credential | **Connect** (OAuth) or an API key field (`can_save_api_key`). |
| `verifying` | Credential stored, live check not yet successful | **Test**, **Disconnect**. |
| `connected` | Credential stored and the last live check succeeded | Account label, last verified, **Test**, **Disconnect**. |
| `verification_failed` | Last check failed (not an auth problem) | `last_error`, **Test**, **Disconnect**. |
| `needs_reauthorization` | Token expired, revoked or missing permissions | **Connect** again (or save a new key), **Disconnect**. |
| `pending_review` | Status set to `pending_review` by an admin while a platform review is open | Informational. |

### `POST ?action=start` — body `{ "provider_key": "google-drive", "return_path": "#settings" }`

`200 { "provider_key", "authorize_url", "expires_at" }`. Navigate with `location.assign(authorize_url)`.
`409 { "error": "Not available yet — requires …", "error_code": "not_configured", "provider_key", "missing_requirements" }`.
`400` for an API-key provider or an invalid `return_path` (hash routes only, default `#settings`).

### Callback (provider → function → browser)

The function redirects to `<app origin>/?integration=<provider_key>&result=connected#<return_path>`, or
`…&result=error&reason=<reason>` where `reason` ∈ `invalid_state`, `denied`, `missing_code`,
`not_configured`, `exchange_failed`, `verify_failed`, `unknown_provider`, `method`. Show one
notice, remove the query with `history.replaceState`, then reload `status`. Details are in
`last_error`.

### `POST ?action=test` — body `{ "provider_key": "…" }`

Refreshes the access token first when it expires within 5 minutes (Google, TikTok), then runs the
live check. Returns `200 { "provider": <status row>, "verified": true|false, "message": string|null }`,
`409 error_code:"not_configured"` or `409 error_code:"not_connected"`.

### `POST ?action=disconnect` — body `{ "provider_key": "…" }`

`200 { "provider": <status row>, "revoked_at_provider": true|false }`. Always removes the local credential.

### `POST ?action=save-api-key` — body `{ "provider_key": "tripadvisor", "api_key": "…" }`

Encrypts and stores the key, then runs the live check. Returns the same shape as `test`. The key
is never returned. `409 not_configured` until the Tripadvisor settings in §6 exist.

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
