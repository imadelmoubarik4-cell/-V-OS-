// Request handling for atlas-integrations, with every side effect injected:
//   env(name)            -> string | undefined   (Deno.env.get in production)
//   fetchImpl(url, init) -> Response             (provider HTTP calls only)
//   rpc(name, payload)   -> parsed JSON          (service-role PostgREST RPC)
//   authenticate(req)    -> { user: {id}, profile: {role, display_name} }
//   now()                -> epoch milliseconds
// index.ts wires these for the Edge runtime; Node tests pass fakes.
//
// Browser-facing responses carry status and metadata only. Tokens, API keys,
// PKCE verifiers, OAuth state and ciphertext never leave this module: every
// JSON response passes assertNoSecretFields() before it is sent.
//
// S94B (publishing connections): start with purpose "publishing" asks for
// connect ∪ publish scopes; list-resources / select-resource manage the Page,
// Instagram account, Business Profile location or TikTok account Atlas posts
// to (the selected Page token is encrypted here, AAD per resource);
// set-review-state is administrator-only; Test refreshes under the shared
// database lease; disconnecting one Meta provider while the other is
// connected revokes only its own permissions.

import { actorLabel as canonicalActorLabel } from "../_shared/auth.mjs";
import {
  bindingClearCookie,
  bindingCookieName,
  bindingSetCookie,
  buildAuthorizeHopUrl,
  buildRedirectUri,
  buildReturnUrl,
  createOAuthState,
  createPkcePair,
  credentialAad,
  decryptJson,
  encryptJson,
  findSecretKeys,
  hashState,
  importAesKey,
  isWellFormedChallenge,
  isWellFormedState,
  normalizeReturnPath,
  parseAllowedOrigins,
  readCookie,
  resourceCredentialAad,
  sanitizeProviderError,
} from "./oauth-core.mjs";
import {
  PROVIDER_KEYS,
  ProviderError,
  buildAuthorizeUrl,
  getProvider,
  providerConfiguration,
  configurationResult,
  requestedScopes,
  supportsPublishing,
} from "./providers.mjs";
import { CredentialError, needsRefresh, refreshWithLock } from "../_shared/integrations/credentials.mjs";

export const FUNCTION_VERSION = "0.1.0";
const MAX_BODY_BYTES = 16 * 1024;
const MANAGER_ROLES = new Set(["admin", "manager"]);
const REVIEW_STATES = new Set(["not_required", "unknown", "required", "pending", "approved", "rejected"]);
const META_KEYS = ["facebook", "instagram"];
// Metadata keys the picker may show (the listing stores nothing else).
const RESOURCE_META_KEYS = ["category", "tasks", "username", "page_name", "account_label", "address", "has_voice_of_merchant", "type", "role"];

export const CORS_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  vary: "authorization",
});

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Stable error codes for browser responses (F9): every error carries one.
const STATUS_CODES = { 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 409: "conflict", 413: "too_large" };
function errorCodeFor(error) {
  return error.extra?.error_code ?? STATUS_CODES[error.status] ?? "unavailable";
}

// A failed service-role RPC: fixed wording by class, never the database text.
export function rpcFailure(status, sqlstate, message) {
  const text = String(message ?? "");
  if (status === 403 || sqlstate === "42501" || /managers and administrators/i.test(text)) {
    return new ApiError(403, "Integrations can be managed by active managers and administrators only.", { error_code: "forbidden" });
  }
  if (sqlstate === "22023" || sqlstate === "23514" || sqlstate === "22P02" || (status >= 400 && status < 500)) {
    return new ApiError(400, "The integration request was not valid.", { error_code: "invalid_request" });
  }
  return new ApiError(503, "The private integrations service is unavailable. Please try again.", { error_code: "unavailable" });
}

// Friendly, fixed text for a failed provider check; the provider's own
// message is sanitised into the stored audit row only.
const PROVIDER_CHECK_FAILED = "The provider did not accept the connection. Reconnect, or check the provider account.";
const PROVIDER_REFRESH_FAILED = "The provider did not renew access. Reconnect to continue.";

export function assertNoSecretFields(value) {
  const hits = findSecretKeys(value);
  if (hits.length) throw new Error(`Refusing to return credential-shaped fields: ${hits.join(", ")}`);
}

export function jsonResponse(value, status = 200) {
  try {
    assertNoSecretFields(value);
  } catch {
    value = { error: "The integration response was withheld because it contained credential fields." };
    status = 500;
  }
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-integrations-version": FUNCTION_VERSION,
    },
  });
}

function redirectResponse(location, cookies = []) {
  const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

// Stored connection/event labels use the canonical staff label: the display
// name or a neutral fallback, never an email address (S87).
function actorLabel(profile) {
  return canonicalActorLabel(profile).slice(0, 200);
}

function requireManager(context) {
  if (!MANAGER_ROLES.has(context?.profile?.role)) {
    throw new ApiError(403, "Integrations can be managed by managers and administrators only.");
  }
}

// Body read with a byte limit: a declared length over the limit is refused
// before reading, a streamed body is cut off at the limit.
async function readJson(request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.");
  const chunks = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* closed */ }
        throw new ApiError(413, "Request body is too large.");
      }
      chunks.push(value);
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(joined);
  if (!text) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new ApiError(400, "Request body must be valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "Request body must be a JSON object.");
  return parsed;
}

function requireAdmin(context) {
  if (context?.profile?.role !== "admin") {
    throw new ApiError(403, "Only administrators can change this.", { error_code: "forbidden" });
  }
}

function publishingProviderFrom(value) {
  const provider = providerFrom(value);
  if (!supportsPublishing(provider)) throw new ApiError(400, `${provider.label} does not publish posts.`, { error_code: "invalid_request" });
  return provider;
}

// Browser shape of a listed resource: ids, labels and whitelisted metadata.
function publicResource(row) {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const details = {};
  for (const key of RESOURCE_META_KEYS) {
    if (metadata[key] !== undefined && metadata[key] !== null) details[key] = metadata[key];
  }
  return {
    resource_kind: row.resource_kind,
    resource_id: row.resource_id,
    parent_resource_id: row.parent_resource_id ?? null,
    label: row.label,
    selected: row.selected === true,
    selectable: metadata.selectable !== false,
    unavailable_reason: typeof metadata.unavailable_reason === "string" ? metadata.unavailable_reason : null,
    details,
  };
}

function providerFrom(value) {
  const key = String(value ?? "").trim();
  const provider = getProvider(key);
  if (!provider) throw new ApiError(404, "Unknown integration provider.");
  return provider;
}

export function createIntegrationsHandler(deps) {
  const env = (name) => {
    const value = deps.env(name);
    return value === undefined || value === null ? undefined : String(value);
  };
  const now = deps.now ?? (() => Date.now());
  const keyCache = new Map();

  function publicBaseUrl() {
    return env("ATLAS_INTEGRATIONS_PUBLIC_URL") || env("SUPABASE_URL") || "";
  }

  function callbackHosts() {
    return String(env("ATLAS_INTEGRATIONS_CALLBACK_HOSTS") || "*.supabase.co").split(",").map((entry) => entry.trim()).filter(Boolean);
  }

  function redirectUriFor(provider) {
    return buildRedirectUri(publicBaseUrl(), provider.key, callbackHosts());
  }

  function appOrigin() {
    return parseAllowedOrigins(env("ATLAS_INTEGRATIONS_APP_ORIGINS"))[0] ?? null;
  }

  function configurationFor(provider) {
    const config = providerConfiguration(provider, env);
    if (provider.auth_kind === "oauth2" && !redirectUriFor(provider)) {
      return configurationResult([...config.missing_setup,
        { name: "ATLAS_INTEGRATIONS_PUBLIC_URL / ATLAS_INTEGRATIONS_CALLBACK_HOSTS", label: "a public https address for the connection service" }]);
    }
    if (config.configured && !appOrigin()) {
      return configurationResult([{ name: "ATLAS_INTEGRATIONS_APP_ORIGINS", label: "a valid https Atlas web address" }]);
    }
    return config;
  }

  function requireConfigured(provider) {
    const config = configurationFor(provider);
    if (!config.configured) {
      throw new ApiError(409, `${provider.label} is not set up yet.`, { error_code: "not_configured", provider_key: provider.key, missing_requirements: config.missing });
    }
    return config;
  }

  function currentKeyVersion() {
    const version = Number(env("ATLAS_INTEGRATION_KEK_CURRENT_VERSION") || "1");
    return Number.isInteger(version) && version > 0 && version < 1000 ? version : 1;
  }

  async function keyFor(version) {
    if (keyCache.has(version)) return keyCache.get(version);
    const material = env(`ATLAS_INTEGRATION_KEK_V${version}`);
    // Owner-facing text only; the administrator's setup details name the
    // function secret (S91).
    if (!material) throw new ApiError(503, "Integrations are not set up yet.", { error_code: "not_configured" });
    let key;
    try {
      key = await importAesKey(material);
    } catch {
      throw new ApiError(503, "Integrations are not set up correctly yet. An administrator can check the setup details.", { error_code: "not_configured" });
    }
    keyCache.set(version, key);
    return key;
  }

  // S91: owner-facing copy for everyone ("Not set up yet." plus what it
  // enables); the technical setup list (function secret names, never values)
  // only for administrators.
  function publicProvider(provider, row, config, role = null) {
    const hasCredential = Boolean(row?.has_credential);
    const status = row?.status ?? "not_connected";
    const expiresAt = row?.credential_access_expires_at ?? row?.token_expires_at ?? null;
    const expired = expiresAt ? Date.parse(expiresAt) <= now() : false;
    let connectionState;
    if (!config.configured) connectionState = "not_configured";
    else if (status === "pending_review") connectionState = "pending_review";
    else if (!hasCredential) connectionState = "ready";
    else if (status === "expired" || (expired && !provider.refresh)) connectionState = "needs_reauthorization";
    else if (status === "connected" && row?.last_verified_at) connectionState = "connected";
    else if (status === "degraded") connectionState = "verification_failed";
    else connectionState = "verifying";
    return {
      provider_key: provider.key,
      label: provider.label,
      auth_kind: provider.auth_kind,
      connection_state: connectionState,
      configured: config.configured,
      available_message: config.message,
      enables: provider.enables ?? null,
      missing_requirements: config.missing,
      can_connect: config.configured && provider.auth_kind === "oauth2",
      can_save_api_key: config.configured && provider.auth_kind === "api_key",
      can_test: config.configured && hasCredential,
      can_disconnect: hasCredential || status !== "not_connected",
      endpoint_evidence: provider.endpoint_evidence,
      scopes_requested: [...provider.scopes],
      scopes_not_requested_yet: [...provider.future_scopes],
      scopes_granted: Array.isArray(row?.scopes_granted) ? row.scopes_granted : [],
      account_label: row?.external_account_label ?? null,
      last_verified_at: row?.last_verified_at ?? null,
      credential_expires_at: expiresAt,
      last_error: row?.last_connection_error ?? null,
      connected_by_label: row?.connected_by_label ?? null,
      connected_at: row?.connected_at ?? null,
      disconnected_at: row?.disconnected_at ?? null,
      redirect_uri_to_register: provider.auth_kind === "oauth2" ? redirectUriFor(provider) : null,
      setup_details: role === "admin" && !config.configured
        ? { summary: provider.owner_requirements_summary, requirements: config.missing_setup.map((entry) => ({ name: entry.name, label: entry.label })) }
        : null,
      recent_events: Array.isArray(row?.recent_events)
        ? row.recent_events.map((event) => ({ event_type: event.event_type, actor_label: event.actor_label ?? null, created_at: event.created_at }))
        : [],
      publishing: publishingView(provider, row, connectionState, config, role),
    };
  }

  // S94B readiness for one provider, the same rules as the SQL
  // atlas_integration_publish_targets() plus `not_configured` (function
  // secrets the database cannot see).
  function publishingView(provider, row, connectionState, config, role) {
    if (!supportsPublishing(provider)) return null;
    const permission = row?.publishing_permission_state ?? "not_requested";
    const review = row?.publishing_review_state ?? "unknown";
    const resources = (Array.isArray(row?.resources) ? row.resources : []).filter((entry) => entry?.resource_kind === provider.resource_kind);
    const selected = resources.find((entry) => entry.selected) ?? null;
    const needsPageToken = provider.resource_kind === "facebook_page" || provider.resource_kind === "instagram_account";
    const resourceOk = Boolean(selected) && (!needsPageToken || selected.has_resource_credential === true);
    const gbp = provider.key === "google-business-profile";
    let reason = null;
    if (connectionState === "not_configured") reason = "not_configured";
    else if (connectionState === "ready") reason = "not_connected";
    else if (connectionState === "pending_review") reason = "review_pending";
    else if (connectionState !== "connected") reason = "needs_reauthorization";
    else if (gbp && permission === "pending") reason = !selected ? "no_resource_selected" : review === "pending" ? "review_pending" : "review_required";
    else if (permission !== "granted") reason = "publishing_permission_missing";
    else if (provider.key !== "tiktok" && (review === "required" || review === "rejected")) reason = "review_required";
    else if (provider.key !== "tiktok" && review === "pending") reason = "review_pending";
    else if (!resourceOk) reason = "no_resource_selected";
    const connected = connectionState === "connected";
    return {
      supported: true,
      permission_state: permission,
      review_state: review,
      resource_kind: provider.resource_kind,
      resource: selected ? { kind: selected.resource_kind, id: selected.resource_id, label: selected.label } : null,
      resource_count: resources.length,
      ready: reason === null,
      reason,
      // TikTok: inbox upload always; Direct Post once TikTok approved Atlas.
      direct_post: provider.key === "tiktok" ? review === "approved" : null,
      scopes_for_publishing: requestedScopes(provider, "publishing"),
      can_allow_publishing: config.configured && provider.publish_scopes.length > 0 && connected && permission !== "granted",
      can_choose_resource: config.configured && connected,
      can_set_review_state: role === "admin",
    };
  }

  // The service-role RPCs re-check this actor against the active profile.
  async function statusRows(actor) {
    const rows = await deps.rpc("atlas_integration_status", { p_actor_role: actor.role, p_actor_id: actor.id });
    return new Map((Array.isArray(rows) ? rows : []).map((row) => [row.provider_key, row]));
  }

  async function providerView(provider, actor) {
    const rows = await statusRows(actor);
    return publicProvider(provider, rows.get(provider.key), configurationFor(provider), actor.role);
  }

  async function handleStatus(context) {
    const rows = await statusRows({ id: context.user.id, role: context.profile.role });
    return {
      providers: PROVIDER_KEYS.map((key) => {
        const provider = getProvider(key);
        return publicProvider(provider, rows.get(key), configurationFor(provider), context.profile.role);
      }),
      policy: {
        credentials_returned: false,
        connected_requires_live_provider_check: true,
        automatic_publishing_enabled: false,
      },
      staff: { role: context.profile.role, can_manage_integrations: true },
    };
  }

  async function handleStart(context, body) {
    const provider = providerFrom(body.provider_key);
    if (provider.auth_kind !== "oauth2") throw new ApiError(400, `${provider.label} does not use OAuth. Save an API key instead.`);
    const purpose = body.purpose === undefined || body.purpose === null || body.purpose === "connect" ? "connect" : String(body.purpose);
    if (purpose !== "connect" && !(purpose === "publishing" && supportsPublishing(provider))) {
      throw new ApiError(400, "Connection purpose must be connect or publishing.", { error_code: "invalid_request" });
    }
    requireConfigured(provider);
    const returnPath = normalizeReturnPath(body.return_path);
    if (!returnPath) throw new ApiError(400, "Return path must be an Atlas route such as #settings.");
    const redirectUri = redirectUriFor(provider);
    const state = createOAuthState();
    const stateHash = await hashState(state);
    let pkce = null;
    let verifier = { ciphertextHex: null, nonceHex: null };
    const version = currentKeyVersion();
    if (provider.pkce === "S256") {
      pkce = await createPkcePair();
      verifier = await encryptJson(await keyFor(version), { v: pkce.verifier }, credentialAad(provider.key, `pkce:${stateHash}`));
    } else {
      await keyFor(version); // fail before the owner leaves Atlas if the key is missing
    }
    const begun = await deps.rpc("atlas_integration_begin", {
      p_provider_key: provider.key,
      p_state_hash: stateHash,
      p_verifier_ciphertext: verifier.ciphertextHex,
      p_verifier_nonce: verifier.nonceHex,
      p_key_version: pkce ? version : null,
      p_return_path: returnPath,
      p_actor_id: context.user.id,
      p_actor_label: actorLabel(context.profile),
      p_actor_role: context.profile.role,
    });
    if (purpose === "publishing") {
      // The hop reads the purpose back from the bound state (records
      // publish_scope_requested).
      await deps.rpc("atlas_integration_set_state_purpose", {
        p_provider_key: provider.key,
        p_state_hash: stateHash,
        p_purpose: purpose,
        p_actor_id: context.user.id,
        p_actor_label: actorLabel(context.profile),
        p_actor_role: context.profile.role,
      });
    }
    // authorize_url is the Atlas hop on the functions domain (same host as
    // the callback): opening it binds the state to this browser, then
    // redirects to the provider. A copied URL opened later is refused.
    const hop = buildAuthorizeHopUrl(redirectUri, provider.key, state, pkce?.challenge ?? null);
    if (!hop) throw new ApiError(409, "This integration callback is not configured.", { error_code: "not_configured" });
    return {
      provider_key: provider.key,
      authorize_url: hop,
      expires_at: begun?.expires_at ?? null,
      purpose,
      scopes_requested: requestedScopes(provider, purpose),
    };
  }

  // GET …/authorize/<provider>?state=…&cc=… (no JWT: a top-level navigation).
  // Binds the pending state to this browser once, sets the binding cookie
  // and redirects to the provider's consent screen.
  async function handleAuthorize(request, url, providerKey) {
    const origin = appOrigin();
    if (!origin) return textResponse("This integration is not configured.", 503);
    const provider = getProvider(providerKey);
    const back = (reason) => redirectResponse(buildReturnUrl(origin, "#settings", provider ? provider.key : "unknown", "error", reason));
    if (!provider || provider.auth_kind !== "oauth2") return back("unknown_provider");
    if (request.method !== "GET") return back("method");
    const state = url.searchParams.get("state") ?? "";
    const challenge = url.searchParams.get("cc");
    if (!isWellFormedState(state)) return back("invalid_state");
    if (provider.pkce === "S256" && !isWellFormedChallenge(challenge)) return back("invalid_state");
    if (!configurationFor(provider).configured) return back("not_configured");
    const nonce = createOAuthState();
    const bound = await deps.rpc("atlas_integration_bind_browser", {
      p_provider_key: provider.key,
      p_state_hash: await hashState(state),
      p_binding_hash: await hashState(nonce),
    });
    if (!bound) return back("invalid_state");
    const target = buildAuthorizeUrl(provider, env, {
      redirectUri: redirectUriFor(provider),
      state,
      codeChallenge: provider.pkce === "S256" ? challenge : null,
      purpose: bound.purpose === "publishing" ? "publishing" : "connect",
    });
    return redirectResponse(target, [bindingSetCookie(provider.key, nonce)]);
  }

  async function storeCredential(provider, kind, secretValue, meta, actor) {
    const version = currentKeyVersion();
    const sealed = await encryptJson(await keyFor(version), secretValue, credentialAad(provider.key, kind));
    await deps.rpc("atlas_integration_store_credential", {
      p_provider_key: provider.key,
      p_credential_kind: kind,
      p_ciphertext: sealed.ciphertextHex,
      p_nonce: sealed.nonceHex,
      p_key_version: version,
      p_access_expires_at: meta.access_expires_at ?? null,
      p_refresh_expires_at: meta.refresh_expires_at ?? null,
      p_external_account_id: meta.external_account_id ?? null,
      p_actor_id: actor.id,
      p_actor_label: actor.label,
      p_actor_role: actor.role,
    });
  }

  async function recordResult(provider, eventType, actor, fields = {}) {
    await deps.rpc("atlas_integration_record_result", {
      p_provider_key: provider.key,
      p_event_type: eventType,
      p_account_id: fields.account_id ?? null,
      p_account_label: fields.account_label ?? null,
      p_scopes: fields.scopes ?? null,
      p_access_expires_at: fields.access_expires_at ?? null,
      p_needs_reauthorization: fields.needs_reauthorization ?? null,
      p_error: fields.error ? sanitizeProviderError(fields.error) : null,
      p_actor_id: actor.id,
      p_actor_label: actor.label,
      p_actor_role: actor.role,
    });
  }

  // Verify with a real provider call. Only this path can record "verified",
  // which is the only way the database marks a provider "connected".
  async function verifyAndRecord(provider, secretValue, actor) {
    try {
      const result = await provider.verify(provider, env, deps.fetchImpl, secretValue);
      await recordResult(provider, "verified", actor, {
        account_id: result.account_id,
        account_label: result.account_label,
        scopes: result.scopes ?? secretValue.scopes ?? null,
        access_expires_at: secretValue.access_expires_at ?? null,
      });
      if (provider.key === "tiktok" && result.account_id) {
        // A TikTok token belongs to exactly one account: record it as the
        // publishing target (the database selects the single account).
        await deps.rpc("atlas_integration_resources_store", {
          p_provider_key: provider.key,
          p_resources: [{ resource_kind: "tiktok_account", resource_id: result.account_id, parent_resource_id: null, label: result.account_label, metadata: { selectable: true } }],
          p_actor_id: actor.id,
          p_actor_label: actor.label,
          p_actor_role: actor.role,
        }).catch(() => undefined);
      }
      return { verified: true };
    } catch (error) {
      // The sanitised provider text goes to the audit row only.
      const detail = error instanceof ProviderError ? error.message : "The provider check failed.";
      await recordResult(provider, "verify_failed", actor, {
        error: detail,
        needs_reauthorization: error instanceof ProviderError ? error.reauthorize : false,
      });
      return { verified: false, message: PROVIDER_CHECK_FAILED, error_code: "provider_check_failed" };
    }
  }

  async function handleCallback(request, url, providerKey) {
    const origin = appOrigin();
    if (!origin) return textResponse("This integration callback is not configured.", 503);
    const provider = getProvider(providerKey);
    const clear = provider ? [bindingClearCookie(provider.key)] : [];
    const back = (result, reason, returnPath) => {
      return redirectResponse(buildReturnUrl(origin, returnPath ?? "#settings", provider ? provider.key : "unknown", result, reason), clear);
    };
    if (!provider || provider.auth_kind !== "oauth2") return back("error", "unknown_provider");
    if (request.method !== "GET") return back("error", "method");
    const state = url.searchParams.get("state") ?? "";
    if (!isWellFormedState(state)) return back("error", "invalid_state");
    // The state is only accepted from the browser that opened the authorize
    // hop (binding cookie), and only while the initiating user is still an
    // active manager or administrator (checked in SQL, current role used).
    const nonce = readCookie(request.headers.get("cookie"), bindingCookieName(provider.key));
    if (!nonce || !isWellFormedState(nonce)) return back("error", "browser_mismatch");
    const consumed = await deps.rpc("atlas_integration_consume_state", {
      p_provider_key: provider.key,
      p_state_hash: await hashState(state),
      p_binding_hash: await hashState(nonce),
    });
    if (!consumed || consumed.provider_key !== provider.key) return back("error", "invalid_state");
    if (consumed.actor_allowed !== true) return back("error", "not_authorized", consumed.return_path);
    const actor = { id: consumed.actor_id, label: consumed.actor_label ?? "Atlas manager", role: consumed.actor_role };
    const returnPath = consumed.return_path;

    const denied = url.searchParams.get("error");
    const code = url.searchParams.get("code") ?? "";
    if (denied || !code || code.length > 4096) {
      await recordResult(provider, "callback_failed", actor, {
        error: denied ? `Provider returned ${sanitizeProviderError(denied)}` : "The provider did not return an authorization code.",
      }).catch(() => undefined);
      return back("error", denied ? "denied" : "missing_code", returnPath);
    }
    if (!configurationFor(provider).configured) {
      await recordResult(provider, "callback_failed", actor, { error: "Provider configuration was removed during sign-in." });
      return back("error", "not_configured", returnPath);
    }

    try {
      let codeVerifier = null;
      if (provider.pkce === "S256") {
        if (!consumed.verifier_ciphertext) throw new ProviderError("PKCE verifier is missing.");
        const opened = await decryptJson(
          await keyFor(Number(consumed.key_version)),
          consumed.verifier_ciphertext,
          consumed.verifier_nonce,
          credentialAad(provider.key, `pkce:${await hashState(state)}`),
        );
        codeVerifier = opened.v;
      }
      const tokenSet = await provider.exchange(provider, env, deps.fetchImpl, {
        code,
        redirectUri: redirectUriFor(provider),
        codeVerifier,
        nowMs: now(),
      });
      await storeCredential(provider, "oauth_token_set", tokenSet, tokenSet, actor);
      const outcome = await verifyAndRecord(provider, tokenSet, actor);
      return back(outcome.verified ? "connected" : "error", outcome.verified ? null : "verify_failed", returnPath);
    } catch (error) {
      await recordResult(provider, "callback_failed", actor, {
        error: error instanceof ProviderError ? error.message : "Token exchange failed.",
      }).catch(() => undefined);
      return back("error", "exchange_failed", returnPath);
    }
  }

  async function openCredential(provider, actor) {
    const stored = await deps.rpc("atlas_integration_read_credential", { p_provider_key: provider.key, p_actor_role: actor.role, p_actor_id: actor.id });
    if (!stored) return null;
    const value = await decryptJson(
      await keyFor(Number(stored.key_version)),
      stored.ciphertext,
      stored.nonce,
      credentialAad(provider.key, stored.credential_kind),
    );
    return { kind: stored.credential_kind, value };
  }

  async function handleTest(context, body) {
    const provider = providerFrom(body.provider_key);
    requireConfigured(provider);
    const actor = { id: context.user.id, label: actorLabel(context.profile), role: context.profile.role };
    let credential;
    try {
      credential = await openCredential(provider, actor);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      await recordResult(provider, "verify_failed", actor, { error: "Stored credential could not be decrypted; reconnect.", needs_reauthorization: true });
      return { provider: await providerView(provider, actor), verified: false, message: "Stored credential could not be decrypted; reconnect.", error_code: "credential_unreadable" };
    }
    if (!credential) throw new ApiError(409, `${provider.label} is not connected.`, { error_code: "not_connected" });
    let secretValue = credential.value;
    if (provider.refresh && needsRefresh(secretValue, now())) {
      // S94B: the same database lease as the publishing worker, so a manual
      // test and a publish never spend a rotating refresh token twice. The
      // lease RPCs record refreshed / refresh_failed.
      try {
        secretValue = await refreshForActor(provider, actor);
      } catch (error) {
        if (!(error instanceof CredentialError)) throw error;
        if (error.retryable && error.code !== "refresh_failed") {
          return { provider: await providerView(provider, actor), verified: false, message: "Atlas is renewing access right now. Try again in a minute.", error_code: "refresh_in_progress" };
        }
        return { provider: await providerView(provider, actor), verified: false, message: PROVIDER_REFRESH_FAILED, error_code: "provider_refresh_failed" };
      }
    }
    const outcome = await verifyAndRecord(provider, secretValue, actor);
    return {
      provider: await providerView(provider, actor), verified: outcome.verified, message: outcome.message ?? null,
      ...(outcome.error_code ? { error_code: outcome.error_code } : {}),
    };
  }

  async function handleDisconnect(context, body) {
    const provider = providerFrom(body.provider_key);
    const role = context.profile.role;
    const actor = { id: context.user.id, role };
    let revokedAtProvider = false;
    let revokedPermissions = null;
    if (provider.revoke && configurationFor(provider).configured) {
      try {
        const credential = await openCredential(provider, actor);
        if (credential) {
          // Facebook and Instagram share one Meta app (and usually one user
          // token): while the other is connected, revoke only this
          // provider's own permissions instead of every permission.
          const otherKey = META_KEYS.includes(provider.key) ? META_KEYS.find((key) => key !== provider.key) : null;
          const otherConnected = otherKey ? Boolean((await statusRows(actor)).get(otherKey)?.has_credential) : false;
          if (otherConnected && provider.revokePermissions) {
            const other = getProvider(otherKey);
            const keep = new Set([...other.scopes, ...(other.publish_scopes ?? [])]);
            revokedPermissions = requestedScopes(provider, "publishing").filter((permission) => !keep.has(permission));
            revokedAtProvider = await provider.revokePermissions(provider, env, deps.fetchImpl, credential.value, revokedPermissions);
          } else {
            await provider.revoke(provider, env, deps.fetchImpl, credential.value);
            revokedAtProvider = true;
          }
        }
      } catch {
        revokedAtProvider = false; // the local credential is still deleted below
      }
    }
    await deps.rpc("atlas_integration_disconnect", {
      p_provider_key: provider.key,
      p_actor_id: context.user.id,
      p_actor_label: actorLabel(context.profile),
      p_actor_role: role,
    });
    return {
      provider: await providerView(provider, actor),
      revoked_at_provider: revokedAtProvider,
      ...(revokedPermissions ? { revoked_permissions: revokedPermissions } : {}),
    };
  }

  // ---------------------------------------------------------------- S94B

  function keyring() {
    return { key: keyFor, currentVersion: currentKeyVersion };
  }

  // Refresh under the shared lease for a manager/admin action.
  async function refreshForActor(provider, actor) {
    return refreshWithLock(
      { rpc: deps.rpc, env, fetchImpl: deps.fetchImpl, now, keyring: keyring(), sleep: deps.sleep },
      { providerKey: provider.key, lockArgs: { actorId: actor.id, actorLabel: actor.label, actorRole: actor.role } },
    );
  }

  async function connectedTokenSet(provider, actor) {
    let credential;
    try {
      credential = await openCredential(provider, actor);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(409, `Atlas can’t read the saved ${provider.label} connection. Disconnect, then connect again.`, { error_code: "credential_unreadable" });
    }
    if (!credential) throw new ApiError(409, `${provider.label} is not connected.`, { error_code: "not_connected" });
    let value = credential.value;
    if (provider.refresh && needsRefresh(value, now())) {
      try {
        value = await refreshForActor(provider, actor);
      } catch (error) {
        if (!(error instanceof CredentialError)) throw error;
        throw new ApiError(409, PROVIDER_REFRESH_FAILED, { error_code: "provider_refresh_failed" });
      }
    }
    return value;
  }

  // Live listing from the provider (server-side); stores ids, labels and
  // non-secret metadata, returns them. Nothing is selected by default.
  async function handleListResources(context, body) {
    const provider = publishingProviderFrom(body.provider_key);
    requireConfigured(provider);
    const actor = { id: context.user.id, label: actorLabel(context.profile), role: context.profile.role };
    const tokenSet = await connectedTokenSet(provider, actor);
    let listing;
    try {
      listing = await provider.listResources(provider, env, deps.fetchImpl, tokenSet);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      throw new ApiError(409, `${provider.label} didn’t return the accounts. Try again, or reconnect.`, { error_code: "provider_check_failed" });
    }
    const stored = await deps.rpc("atlas_integration_resources_store", {
      p_provider_key: provider.key,
      p_resources: listing.resources,
      p_actor_id: actor.id,
      p_actor_label: actor.label,
      p_actor_role: actor.role,
    });
    const rows = Array.isArray(stored?.resources) ? stored.resources : [];
    return {
      provider: await providerView(provider, actor),
      resource_kind: provider.resource_kind,
      resources: rows.filter((row) => row.resource_kind === provider.resource_kind).map(publicResource),
      notes: listing.notes ?? {},
    };
  }

  async function handleSelectResource(context, body) {
    const provider = publishingProviderFrom(body.provider_key);
    requireConfigured(provider);
    const actor = { id: context.user.id, label: actorLabel(context.profile), role: context.profile.role };
    const resourceId = typeof body.resource_id === "string" ? body.resource_id.trim() : "";
    if (!/^[A-Za-z0-9_.:\/-]{1,200}$/.test(resourceId)) throw new ApiError(400, "Choose one of the listed accounts.", { error_code: "invalid_request" });
    if (body.resource_kind !== undefined && body.resource_kind !== provider.resource_kind) {
      throw new ApiError(400, "Choose one of the listed accounts.", { error_code: "invalid_request" });
    }
    const row = (await statusRows(actor)).get(provider.key);
    const listed = (Array.isArray(row?.resources) ? row.resources : [])
      .find((entry) => entry.resource_kind === provider.resource_kind && entry.resource_id === resourceId);
    if (!listed) throw new ApiError(409, "That account isn’t in the latest list. Refresh the list and choose again.", { error_code: "resource_not_listed" });
    if (listed.metadata?.selectable === false) throw new ApiError(409, "That account can’t be used for publishing.", { error_code: "resource_not_selectable" });
    let sealed = { ciphertextHex: null, nonceHex: null };
    let version = null;
    if (provider.resourceCredential) {
      const tokenSet = await connectedTokenSet(provider, actor);
      let pageToken;
      try {
        pageToken = await provider.resourceCredential(provider, env, deps.fetchImpl, tokenSet, listed, now());
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        throw new ApiError(409, `${provider.label} didn’t allow Atlas to post there. Check your role, or reconnect.`, { error_code: "provider_check_failed" });
      }
      version = currentKeyVersion();
      sealed = await encryptJson(await keyFor(version), pageToken, resourceCredentialAad(provider.key, listed.resource_id));
    }
    const selected = await deps.rpc("atlas_integration_resource_select", {
      p_provider_key: provider.key,
      p_resource_kind: provider.resource_kind,
      p_resource_id: listed.resource_id,
      p_ciphertext: sealed.ciphertextHex,
      p_nonce: sealed.nonceHex,
      p_key_version: version,
      p_actor_id: actor.id,
      p_actor_label: actor.label,
      p_actor_role: actor.role,
    });
    return {
      provider: await providerView(provider, actor),
      selected: selected?.selected
        ? { kind: selected.selected.kind, id: selected.selected.id, label: selected.selected.label }
        : { kind: provider.resource_kind, id: listed.resource_id, label: listed.label },
    };
  }

  // Platform review is not readable by API: an administrator records it.
  async function handleSetReviewState(context, body) {
    requireAdmin(context);
    const provider = publishingProviderFrom(body.provider_key);
    const review = String(body.review_state ?? "");
    if (!REVIEW_STATES.has(review)) throw new ApiError(400, "Choose one of the review states.", { error_code: "invalid_request" });
    const actor = { id: context.user.id, label: actorLabel(context.profile), role: context.profile.role };
    await deps.rpc("atlas_integration_set_review_state", {
      p_provider_key: provider.key,
      p_review_state: review,
      p_actor_id: actor.id,
      p_actor_label: actor.label,
      p_actor_role: actor.role,
    });
    return { provider: await providerView(provider, actor) };
  }

  async function handleSaveApiKey(context, body) {
    const provider = providerFrom(body.provider_key);
    if (provider.auth_kind !== "api_key") throw new ApiError(400, `${provider.label} connects with OAuth, not an API key.`);
    requireConfigured(provider);
    const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
    if (!/^[\x21-\x7E]{8,256}$/.test(apiKey)) throw new ApiError(400, "API key must be 8-256 printable characters without spaces.");
    const actor = { id: context.user.id, label: actorLabel(context.profile), role: context.profile.role };
    const secretValue = { api_key: apiKey, obtained_at: new Date(now()).toISOString() };
    await storeCredential(provider, "api_key", secretValue, {}, actor);
    const outcome = await verifyAndRecord(provider, secretValue, actor);
    return {
      provider: await providerView(provider, actor), verified: outcome.verified, message: outcome.message ?? null,
      ...(outcome.error_code ? { error_code: outcome.error_code } : {}),
    };
  }

  return async function handle(request) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    const url = new URL(request.url);
    const callback = url.pathname.match(/\/callback\/([a-z0-9-]{1,60})\/?$/);
    const authorize = url.pathname.match(/\/authorize\/([a-z0-9-]{1,60})\/?$/);
    try {
      if (callback) return await handleCallback(request, url, callback[1]);
      if (authorize) return await handleAuthorize(request, url, authorize[1]);

      const context = await deps.authenticate(request);
      requireManager(context);
      const body = request.method === "POST" ? await readJson(request) : {};
      const action = url.searchParams.get("action") || String(body.action ?? "");
      if (action === "status" && request.method === "GET") return jsonResponse(await handleStatus(context));
      if (request.method !== "POST") throw new ApiError(405, "Use POST for integration changes.");
      switch (action) {
        case "start": return jsonResponse(await handleStart(context, body));
        case "test": return jsonResponse(await handleTest(context, body));
        case "disconnect": return jsonResponse(await handleDisconnect(context, body));
        case "save-api-key": return jsonResponse(await handleSaveApiKey(context, body));
        case "list-resources": return jsonResponse(await handleListResources(context, body));
        case "select-resource": return jsonResponse(await handleSelectResource(context, body));
        case "set-review-state": return jsonResponse(await handleSetReviewState(context, body));
        default: throw new ApiError(404, "Unknown integrations action.");
      }
    } catch (error) {
      if (callback || authorize) {
        const origin = appOrigin();
        return origin
          ? redirectResponse(buildReturnUrl(origin, "#settings", (callback ?? authorize)[1], "error"))
          : textResponse("This integration callback could not complete.", 500);
      }
      if (error instanceof ApiError) return jsonResponse({ error: error.message, error_code: errorCodeFor(error), ...error.extra }, error.status);
      console.warn("[atlas-integrations] request failed", error?.name ?? "Error");
      return jsonResponse({ error: "The integrations service could not complete this request.", error_code: "internal" }, 500);
    }
  };
}
