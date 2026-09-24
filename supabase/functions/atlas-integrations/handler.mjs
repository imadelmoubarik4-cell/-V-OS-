// Request handling for atlas-integrations, with every side effect injected:
//   env(name)            -> string | undefined   (Deno.env.get in production)
//   fetchImpl(url, init) -> Response             (provider HTTP calls only)
//   rpc(name, payload)   -> parsed JSON          (service-role PostgREST RPC)
//   authenticate(req)    -> { user: {id}, profile: {role, display_name, email} }
//   now()                -> epoch milliseconds
// index.ts wires these for the Edge runtime; Node tests pass fakes.
//
// Browser-facing responses carry status and metadata only. Tokens, API keys,
// PKCE verifiers, OAuth state and ciphertext never leave this module: every
// JSON response passes assertNoSecretFields() before it is sent.

import {
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
  isWellFormedState,
  normalizeReturnPath,
  parseAllowedOrigins,
  sanitizeProviderError,
} from "./oauth-core.mjs";
import {
  PROVIDER_KEYS,
  ProviderError,
  buildAuthorizeUrl,
  getProvider,
  providerConfiguration,
} from "./providers.mjs";

export const FUNCTION_VERSION = "0.1.0";
const MAX_BODY_BYTES = 16 * 1024;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MANAGER_ROLES = new Set(["admin", "manager"]);

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

function redirectResponse(location) {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function actorLabel(profile) {
  return String(profile?.display_name || profile?.email || "Atlas manager").trim().slice(0, 200);
}

function requireManager(context) {
  if (!MANAGER_ROLES.has(context?.profile?.role)) {
    throw new ApiError(403, "Integrations can be managed by managers and administrators only.");
  }
}

async function readJson(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.");
  if (!text) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new ApiError(400, "Request body must be valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "Request body must be a JSON object.");
  return parsed;
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
      const missing = [...config.missing, "an https function URL on an allow-listed host (ATLAS_INTEGRATIONS_PUBLIC_URL / ATLAS_INTEGRATIONS_CALLBACK_HOSTS)"];
      return { configured: false, missing, message: `Not available yet — requires ${missing.join(", ")}.` };
    }
    if (config.configured && !appOrigin()) {
      return { configured: false, missing: ["a valid https ATLAS_INTEGRATIONS_APP_ORIGINS value"], message: "Not available yet — requires a valid https ATLAS_INTEGRATIONS_APP_ORIGINS value." };
    }
    return config;
  }

  function requireConfigured(provider) {
    const config = configurationFor(provider);
    if (!config.configured) {
      throw new ApiError(409, config.message, { error_code: "not_configured", provider_key: provider.key, missing_requirements: config.missing });
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
    if (!material) throw new ApiError(503, `Not available yet — requires the integration encryption key ATLAS_INTEGRATION_KEK_V${version}.`);
    let key;
    try {
      key = await importAesKey(material);
    } catch {
      throw new ApiError(503, `The integration encryption key ATLAS_INTEGRATION_KEK_V${version} is not a base64 32-byte key.`);
    }
    keyCache.set(version, key);
    return key;
  }

  function publicProvider(provider, row, config) {
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
      owner_requirements_summary: provider.owner_requirements_summary,
      recent_events: Array.isArray(row?.recent_events)
        ? row.recent_events.map((event) => ({ event_type: event.event_type, actor_label: event.actor_label ?? null, created_at: event.created_at }))
        : [],
    };
  }

  async function statusRows(role) {
    const rows = await deps.rpc("atlas_integration_status", { p_actor_role: role });
    return new Map((Array.isArray(rows) ? rows : []).map((row) => [row.provider_key, row]));
  }

  async function providerView(provider, role) {
    const rows = await statusRows(role);
    return publicProvider(provider, rows.get(provider.key), configurationFor(provider));
  }

  async function handleStatus(context) {
    const rows = await statusRows(context.profile.role);
    return {
      providers: PROVIDER_KEYS.map((key) => {
        const provider = getProvider(key);
        return publicProvider(provider, rows.get(key), configurationFor(provider));
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
    return {
      provider_key: provider.key,
      authorize_url: buildAuthorizeUrl(provider, env, { redirectUri, state, codeChallenge: pkce?.challenge ?? null }),
      expires_at: begun?.expires_at ?? null,
    };
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
      return { verified: true };
    } catch (error) {
      const message = error instanceof ProviderError ? error.message : "The provider check failed.";
      await recordResult(provider, "verify_failed", actor, {
        error: message,
        needs_reauthorization: error instanceof ProviderError ? error.reauthorize : false,
      });
      return { verified: false, message };
    }
  }

  async function handleCallback(request, url, providerKey) {
    const origin = appOrigin();
    if (!origin) return textResponse("This integration callback is not configured.", 503);
    const provider = getProvider(providerKey);
    const back = (result, reason, returnPath) => {
      return redirectResponse(buildReturnUrl(origin, returnPath ?? "#settings", provider ? provider.key : "unknown", result, reason));
    };
    if (!provider || provider.auth_kind !== "oauth2") return back("error", "unknown_provider");
    if (request.method !== "GET") return back("error", "method");
    const state = url.searchParams.get("state") ?? "";
    if (!isWellFormedState(state)) return back("error", "invalid_state");
    const consumed = await deps.rpc("atlas_integration_consume_state", {
      p_provider_key: provider.key,
      p_state_hash: await hashState(state),
    });
    if (!consumed || consumed.provider_key !== provider.key) return back("error", "invalid_state");
    const actor = { id: consumed.actor_id, label: consumed.actor_label ?? "Atlas manager", role: consumed.actor_role };
    const returnPath = consumed.return_path;

    const denied = url.searchParams.get("error");
    const code = url.searchParams.get("code") ?? "";
    if (denied || !code || code.length > 4096) {
      await recordResult(provider, "callback_failed", actor, {
        error: denied ? `Provider returned ${sanitizeProviderError(denied)}` : "The provider did not return an authorization code.",
      });
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

  async function openCredential(provider, role) {
    const stored = await deps.rpc("atlas_integration_read_credential", { p_provider_key: provider.key, p_actor_role: role });
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
      credential = await openCredential(provider, actor.role);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      await recordResult(provider, "verify_failed", actor, { error: "Stored credential could not be decrypted; reconnect.", needs_reauthorization: true });
      return { provider: await providerView(provider, actor.role), verified: false, message: "Stored credential could not be decrypted; reconnect." };
    }
    if (!credential) throw new ApiError(409, `${provider.label} is not connected.`, { error_code: "not_connected" });
    let secretValue = credential.value;
    const expiresAt = secretValue.access_expires_at ? Date.parse(secretValue.access_expires_at) : null;
    if (provider.refresh && expiresAt !== null && expiresAt - REFRESH_MARGIN_MS <= now()) {
      try {
        secretValue = await provider.refresh(provider, env, deps.fetchImpl, secretValue, now());
        await storeCredential(provider, credential.kind, secretValue, secretValue, actor);
        await recordResult(provider, "refreshed", actor, { access_expires_at: secretValue.access_expires_at });
      } catch (error) {
        const message = error instanceof ProviderError ? error.message : "Token refresh failed.";
        await recordResult(provider, "refresh_failed", actor, { error: message, needs_reauthorization: true });
        return { provider: await providerView(provider, actor.role), verified: false, message };
      }
    }
    const outcome = await verifyAndRecord(provider, secretValue, actor);
    return { provider: await providerView(provider, actor.role), verified: outcome.verified, message: outcome.message ?? null };
  }

  async function handleDisconnect(context, body) {
    const provider = providerFrom(body.provider_key);
    const role = context.profile.role;
    let revokedAtProvider = false;
    if (provider.revoke && configurationFor(provider).configured) {
      try {
        const credential = await openCredential(provider, role);
        if (credential) {
          await provider.revoke(provider, env, deps.fetchImpl, credential.value);
          revokedAtProvider = true;
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
    return { provider: await providerView(provider, role), revoked_at_provider: revokedAtProvider };
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
    return { provider: await providerView(provider, actor.role), verified: outcome.verified, message: outcome.message ?? null };
  }

  return async function handle(request) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    const url = new URL(request.url);
    const callback = url.pathname.match(/\/callback\/([a-z0-9-]{1,60})\/?$/);
    try {
      if (callback) return await handleCallback(request, url, callback[1]);

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
        default: throw new ApiError(404, "Unknown integrations action.");
      }
    } catch (error) {
      if (callback) {
        const origin = appOrigin();
        return origin
          ? redirectResponse(buildReturnUrl(origin, "#settings", callback[1], "error"))
          : textResponse("This integration callback could not complete.", 500);
      }
      if (error instanceof ApiError) return jsonResponse({ error: error.message, ...error.extra }, error.status);
      return jsonResponse({ error: "The integrations service could not complete this request." }, 500);
    }
  };
}
