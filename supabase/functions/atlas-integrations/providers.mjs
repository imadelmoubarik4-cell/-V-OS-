// Provider registry for atlas-integrations.
//
// Endpoints and scopes were checked against each provider's public
// documentation in September 2026. `endpoint_evidence` records how sure we are:
//   "documented"  - stated in the provider's current developer documentation
//   "unverified"  - could not be confirmed from primary documentation; the
//                   provider stays "not available" until the owner confirms it
// Scopes are the minimum Atlas needs for what is built today: connect and
// verify the account. Publishing/insights scopes are listed separately in
// `future_scopes` and are NOT requested.
//
// All network calls go through an injected `fetchImpl` so tests never reach a
// provider. No function here returns a token to a caller outside the Edge
// Function; the handler only exposes `publicProvider()` output.

import { sanitizeProviderError } from "./oauth-core.mjs";

export const DEFAULT_META_GRAPH_VERSION = "v25.0";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// Requirements: `env` is the function secret an administrator sets (its NAME
// is shown only in the admin-only setup details; values never leave the
// server); `label` is plain language without secret names (S91).
const INFRA_REQUIREMENTS = [
  { env: "ATLAS_INTEGRATION_KEK_V1", label: "the integration encryption key" },
  { env: "ATLAS_INTEGRATIONS_APP_ORIGINS", label: "the Atlas web address" },
];

// Owner-facing copy for a provider that is not set up (S91).
export const NOT_SET_UP_MESSAGE = "Not set up yet.";

function metaVersion(env) {
  const value = String(env("ATLAS_META_GRAPH_VERSION") ?? "").trim();
  return /^v\d{2}\.0$/.test(value) ? value : DEFAULT_META_GRAPH_VERSION;
}

export const PROVIDERS = Object.freeze({
  "google-business-profile": {
    key: "google-business-profile",
    label: "Google Business Profile",
    auth_kind: "oauth2",
    pkce: "S256",
    endpoint_evidence: "documented",
    authorizeUrl: () => GOOGLE_AUTHORIZE_URL,
    tokenUrl: () => GOOGLE_TOKEN_URL,
    revokeUrl: () => GOOGLE_REVOKE_URL,
    scopes: ["https://www.googleapis.com/auth/business.manage"],
    future_scopes: [],
    scopeSeparator: " ",
    clientIdParam: "client_id",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    credentials: [
      { env: "ATLAS_GOOGLE_OAUTH_CLIENT_ID", label: "a Google Cloud OAuth client ID" },
      { env: "ATLAS_GOOGLE_OAUTH_CLIENT_SECRET", label: "its client secret" },
    ],
    extraRequirements: [],
    enables: "Shows your Google reviews and business listing in Atlas.",
    owner_requirements_summary:
      "Google Cloud project, approved Business Profile API access, published OAuth consent screen (business.manage is a sensitive scope), OAuth web client.",
    verify: verifyGoogleBusinessProfile,
    refresh: refreshGoogle,
    revoke: revokeGoogle,
    exchange: exchangeGoogleCode,
  },
  "google-drive": {
    key: "google-drive",
    label: "Google Drive",
    auth_kind: "oauth2",
    pkce: "S256",
    endpoint_evidence: "documented",
    authorizeUrl: () => GOOGLE_AUTHORIZE_URL,
    tokenUrl: () => GOOGLE_TOKEN_URL,
    revokeUrl: () => GOOGLE_REVOKE_URL,
    // drive.file is non-sensitive: per-file access to files the owner picks
    // or Atlas creates. drive.readonly is restricted (security assessment).
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    future_scopes: [],
    scopeSeparator: " ",
    clientIdParam: "client_id",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    credentials: [
      { env: "ATLAS_GOOGLE_OAUTH_CLIENT_ID", label: "a Google Cloud OAuth client ID" },
      { env: "ATLAS_GOOGLE_OAUTH_CLIENT_SECRET", label: "its client secret" },
    ],
    extraRequirements: [],
    enables: "Lets Atlas save and open files you choose in Google Drive.",
    owner_requirements_summary:
      "Google Cloud project with the Drive API enabled, OAuth consent screen, OAuth web client. drive.file only (files the owner picks).",
    verify: verifyGoogleDrive,
    refresh: refreshGoogle,
    revoke: revokeGoogle,
    exchange: exchangeGoogleCode,
  },
  facebook: {
    key: "facebook",
    label: "Facebook Page",
    auth_kind: "oauth2",
    // Meta's manual web login flow documents state + server-side app secret;
    // PKCE is not documented for it, so it is not sent.
    pkce: "none",
    endpoint_evidence: "documented",
    authorizeUrl: (env) => `https://www.facebook.com/${metaVersion(env)}/dialog/oauth`,
    tokenUrl: (env) => `https://graph.facebook.com/${metaVersion(env)}/oauth/access_token`,
    revokeUrl: (env) => `https://graph.facebook.com/${metaVersion(env)}/me/permissions`,
    scopes: ["pages_show_list", "pages_read_engagement"],
    future_scopes: ["pages_manage_posts", "read_insights", "business_management"],
    scopeSeparator: ",",
    clientIdParam: "client_id",
    extraAuthorizeParams: {},
    credentials: [
      { env: "ATLAS_META_APP_ID", label: "a Meta app ID" },
      { env: "ATLAS_META_APP_SECRET", label: "its app secret" },
    ],
    extraRequirements: [],
    enables: "Shows your Facebook Page and its activity in Atlas.",
    owner_requirements_summary:
      "Meta Business app with Facebook Login for Business, business verification, App Review for Page permissions, app in Live mode.",
    verify: verifyFacebookPages,
    refresh: null,
    revoke: revokeMeta,
    exchange: exchangeMetaCode,
  },
  instagram: {
    key: "instagram",
    label: "Instagram",
    auth_kind: "oauth2",
    pkce: "none",
    endpoint_evidence: "documented",
    authorizeUrl: (env) => `https://www.facebook.com/${metaVersion(env)}/dialog/oauth`,
    tokenUrl: (env) => `https://graph.facebook.com/${metaVersion(env)}/oauth/access_token`,
    revokeUrl: (env) => `https://graph.facebook.com/${metaVersion(env)}/me/permissions`,
    scopes: ["instagram_basic", "pages_show_list"],
    future_scopes: ["instagram_content_publish", "instagram_manage_insights", "pages_read_engagement", "business_management"],
    scopeSeparator: ",",
    clientIdParam: "client_id",
    extraAuthorizeParams: {},
    credentials: [
      { env: "ATLAS_META_APP_ID", label: "a Meta app ID" },
      { env: "ATLAS_META_APP_SECRET", label: "its app secret" },
    ],
    extraRequirements: [],
    enables: "Shows your Instagram business account in Atlas.",
    owner_requirements_summary:
      "Instagram professional account linked to the VÁ Facebook Page; same Meta app; App Review for Instagram permissions.",
    verify: verifyInstagramAccount,
    refresh: null,
    revoke: revokeMeta,
    exchange: exchangeMetaCode,
  },
  tiktok: {
    key: "tiktok",
    label: "TikTok",
    auth_kind: "oauth2",
    // TikTok documents PKCE for desktop/mobile Login Kit; the web flow is a
    // confidential client using state + client secret.
    pkce: "none",
    endpoint_evidence: "documented",
    authorizeUrl: () => "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: () => "https://open.tiktokapis.com/v2/oauth/token/",
    revokeUrl: () => "https://open.tiktokapis.com/v2/oauth/revoke/",
    scopes: ["user.info.basic"],
    future_scopes: ["video.upload", "video.publish", "video.list"],
    scopeSeparator: ",",
    clientIdParam: "client_key",
    extraAuthorizeParams: {},
    credentials: [
      { env: "ATLAS_TIKTOK_CLIENT_KEY", label: "a TikTok for Developers client key" },
      { env: "ATLAS_TIKTOK_CLIENT_SECRET", label: "its client secret" },
    ],
    extraRequirements: [],
    enables: "Shows your TikTok account in Atlas.",
    owner_requirements_summary:
      "TikTok for Developers app with Login Kit, approved app review, registered redirect URI. Publishing needs Content Posting API audit.",
    verify: verifyTikTok,
    refresh: refreshTikTok,
    revoke: revokeTikTok,
    exchange: exchangeTikTokCode,
  },
  tripadvisor: {
    key: "tripadvisor",
    label: "Tripadvisor",
    auth_kind: "api_key",
    pkce: "none",
    // The legacy Content API (api.content.tripadvisor.com) is reported as
    // sunset on 31 Aug 2026 in favour of the Terra API (X-API-KEY header on
    // terra.tripadvisor.com). The exact Terra location-details path could not be
    // confirmed from primary documentation, so the owner supplies it.
    endpoint_evidence: "unverified",
    authorizeUrl: () => null,
    tokenUrl: () => null,
    revokeUrl: () => null,
    scopes: [],
    future_scopes: [],
    scopeSeparator: " ",
    clientIdParam: null,
    extraAuthorizeParams: {},
    credentials: [],
    extraRequirements: [
      {
        env: "ATLAS_TRIPADVISOR_VERIFY_URL",
        label: "a confirmed Tripadvisor Terra API location-details address (https://terra.tripadvisor.com/..., may contain {location_id})",
      },
      { env: "ATLAS_TRIPADVISOR_LOCATION_ID", label: "the VÁ Tripadvisor location ID" },
    ],
    enables: "Shows your Tripadvisor listing and rating in Atlas.",
    owner_requirements_summary:
      "Tripadvisor Terra API key (pay-as-you-go), the VÁ location ID and the confirmed location-details endpoint. Read-only.",
    verify: verifyTripadvisor,
    refresh: null,
    revoke: null,
    exchange: null,
  },
});

export const PROVIDER_KEYS = Object.freeze(Object.keys(PROVIDERS));

export function getProvider(key) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, key) ? PROVIDERS[key] : null;
}

function present(env, name) {
  return String(env(name) ?? "").trim().length > 0;
}

// Truthful configuration: which server-side prerequisites are missing.
// `missing` is plain language (any manager may see it); `missing_setup` adds
// the function secret NAMES for the admin-only setup details. No values.
export function providerConfiguration(provider, env) {
  const missingSetup = [];
  for (const requirement of INFRA_REQUIREMENTS) {
    if (!present(env, requirement.env)) missingSetup.push({ name: requirement.env, label: requirement.label });
  }
  for (const requirement of [...provider.credentials, ...provider.extraRequirements]) {
    if (!present(env, requirement.env)) missingSetup.push({ name: requirement.env, label: requirement.label });
  }
  if (provider.key === "tripadvisor" && present(env, "ATLAS_TRIPADVISOR_VERIFY_URL")) {
    if (!tripadvisorVerifyUrl(env, "0")) {
      missingSetup.push({ name: "ATLAS_TRIPADVISOR_VERIFY_URL", label: "an https Tripadvisor Terra API address on terra.tripadvisor.com" });
    }
  }
  return configurationResult(missingSetup);
}

export function configurationResult(missingSetup) {
  const configured = missingSetup.length === 0;
  return {
    configured,
    missing: missingSetup.map((entry) => entry.label),
    missing_setup: missingSetup,
    message: configured ? null : NOT_SET_UP_MESSAGE,
  };
}

export function notAvailableMessage() {
  return NOT_SET_UP_MESSAGE;
}

// ---------------------------------------------------------------- authorize

export function buildAuthorizeUrl(provider, env, { redirectUri, state, codeChallenge }) {
  const url = new URL(provider.authorizeUrl(env));
  const clientId = String(env(provider.credentials[0].env) ?? "").trim();
  url.searchParams.set(provider.clientIdParam, clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scopes.join(provider.scopeSeparator));
  url.searchParams.set("state", state);
  if (provider.pkce === "S256") {
    if (!codeChallenge) throw new Error("PKCE challenge is required for this provider.");
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [name, value] of Object.entries(provider.extraAuthorizeParams)) url.searchParams.set(name, value);
  return url.toString();
}

// ---------------------------------------------------------------- provider calls

export class ProviderError extends Error {
  constructor(message, { status = 0, reauthorize = false } = {}) {
    super(sanitizeProviderError(message));
    this.status = status;
    this.reauthorize = reauthorize;
  }
}

async function readProviderJson(response, fallback) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const detail = body?.error?.message || body?.error_description || body?.error?.code || body?.error || fallback;
    throw new ProviderError(`${fallback} (HTTP ${response.status}): ${typeof detail === "string" ? detail : fallback}`, {
      status: response.status,
      reauthorize: response.status === 400 || response.status === 401,
    });
  }
  return body ?? {};
}

function expiresAt(nowMs, seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(nowMs + value * 1000).toISOString() : null;
}

function secret(env, name) {
  const value = String(env(name) ?? "").trim();
  if (!value) throw new ProviderError("Provider credentials are not configured.");
  return value;
}

async function exchangeGoogleCode(provider, env, fetchImpl, { code, redirectUri, codeVerifier, nowMs }) {
  const response = await fetchImpl(provider.tokenUrl(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: secret(env, "ATLAS_GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: secret(env, "ATLAS_GOOGLE_OAUTH_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }).toString(),
  });
  const body = await readProviderJson(response, "Google token exchange failed");
  if (!body.access_token) throw new ProviderError("Google did not return an access token.");
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? null,
    token_type: body.token_type ?? "Bearer",
    scopes: String(body.scope ?? "").split(" ").filter(Boolean),
    access_expires_at: expiresAt(nowMs, body.expires_in),
    refresh_expires_at: expiresAt(nowMs, body.refresh_token_expires_in),
    obtained_at: new Date(nowMs).toISOString(),
  };
}

async function refreshGoogle(provider, env, fetchImpl, tokenSet, nowMs) {
  if (!tokenSet.refresh_token) throw new ProviderError("Google did not issue a refresh token; reconnect.", { reauthorize: true });
  const response = await fetchImpl(provider.tokenUrl(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: secret(env, "ATLAS_GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: secret(env, "ATLAS_GOOGLE_OAUTH_CLIENT_SECRET"),
      refresh_token: tokenSet.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });
  const body = await readProviderJson(response, "Google token refresh failed");
  return {
    ...tokenSet,
    access_token: body.access_token,
    scopes: body.scope ? String(body.scope).split(" ").filter(Boolean) : tokenSet.scopes,
    access_expires_at: expiresAt(nowMs, body.expires_in),
    obtained_at: new Date(nowMs).toISOString(),
  };
}

async function revokeGoogle(provider, env, fetchImpl, tokenSet) {
  const token = tokenSet.refresh_token || tokenSet.access_token;
  if (!token) return;
  await fetchImpl(provider.revokeUrl(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

async function googleGet(fetchImpl, url, accessToken, fallback) {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  return readProviderJson(response, fallback);
}

async function verifyGoogleBusinessProfile(provider, env, fetchImpl, tokenSet) {
  const body = await googleGet(
    fetchImpl,
    "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
    tokenSet.access_token,
    "Business Profile account check failed",
  );
  const accounts = Array.isArray(body.accounts) ? body.accounts : [];
  if (!accounts.length) throw new ProviderError("The Google account has no Business Profile accounts.");
  return {
    account_id: String(accounts[0].name ?? "").slice(0, 200) || null,
    account_label: String(accounts[0].accountName ?? accounts[0].name ?? "Business Profile").slice(0, 200),
    detail: { account_count: accounts.length },
  };
}

async function verifyGoogleDrive(provider, env, fetchImpl, tokenSet) {
  const body = await googleGet(
    fetchImpl,
    "https://www.googleapis.com/drive/v3/about?fields=user(displayName,permissionId)",
    tokenSet.access_token,
    "Google Drive account check failed",
  );
  if (!body.user) throw new ProviderError("Google Drive did not return the connected user.");
  return {
    account_id: String(body.user.permissionId ?? "").slice(0, 200) || null,
    account_label: String(body.user.displayName ?? "Google Drive").slice(0, 200),
    detail: {},
  };
}

async function exchangeMetaCode(provider, env, fetchImpl, { code, redirectUri, nowMs }) {
  const shortUrl = new URL(provider.tokenUrl(env));
  shortUrl.searchParams.set("client_id", secret(env, "ATLAS_META_APP_ID"));
  shortUrl.searchParams.set("client_secret", secret(env, "ATLAS_META_APP_SECRET"));
  shortUrl.searchParams.set("redirect_uri", redirectUri);
  shortUrl.searchParams.set("code", code);
  const short = await readProviderJson(await fetchImpl(shortUrl.toString(), { headers: { accept: "application/json" } }), "Meta token exchange failed");
  if (!short.access_token) throw new ProviderError("Meta did not return an access token.");
  // Exchange the short-lived user token for a long-lived one (about 60 days).
  const longUrl = new URL(provider.tokenUrl(env));
  longUrl.searchParams.set("grant_type", "fb_exchange_token");
  longUrl.searchParams.set("client_id", secret(env, "ATLAS_META_APP_ID"));
  longUrl.searchParams.set("client_secret", secret(env, "ATLAS_META_APP_SECRET"));
  longUrl.searchParams.set("fb_exchange_token", short.access_token);
  const long = await readProviderJson(await fetchImpl(longUrl.toString(), { headers: { accept: "application/json" } }), "Meta long-lived token exchange failed");
  return {
    access_token: long.access_token ?? short.access_token,
    refresh_token: null,
    token_type: "Bearer",
    scopes: [],
    access_expires_at: expiresAt(nowMs, long.expires_in ?? short.expires_in),
    refresh_expires_at: null,
    obtained_at: new Date(nowMs).toISOString(),
  };
}

async function metaGet(fetchImpl, env, path, accessToken, fallback) {
  const url = new URL(`https://graph.facebook.com/${metaVersion(env)}/${path}`);
  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  return readProviderJson(response, fallback);
}

async function metaGrantedScopes(fetchImpl, env, accessToken) {
  const body = await metaGet(fetchImpl, env, "me/permissions", accessToken, "Meta permission check failed");
  return (Array.isArray(body.data) ? body.data : [])
    .filter((row) => row?.status === "granted")
    .map((row) => String(row.permission));
}

function requireScopes(granted, required, label) {
  const missing = required.filter((scope) => !granted.includes(scope));
  if (missing.length) {
    throw new ProviderError(`${label} permissions were not granted: ${missing.join(", ")}.`, { reauthorize: true });
  }
}

async function verifyFacebookPages(provider, env, fetchImpl, tokenSet) {
  const granted = await metaGrantedScopes(fetchImpl, env, tokenSet.access_token);
  requireScopes(granted, provider.scopes, "Facebook");
  const body = await metaGet(fetchImpl, env, "me/accounts?fields=id,name", tokenSet.access_token, "Facebook Page check failed");
  const pages = Array.isArray(body.data) ? body.data : [];
  if (!pages.length) throw new ProviderError("No Facebook Page was shared with Atlas.", { reauthorize: true });
  return {
    account_id: String(pages[0].id ?? "").slice(0, 200) || null,
    account_label: pages.map((page) => String(page.name ?? "Page")).slice(0, 3).join(", ").slice(0, 200),
    scopes: granted,
    detail: { page_count: pages.length },
  };
}

async function verifyInstagramAccount(provider, env, fetchImpl, tokenSet) {
  const granted = await metaGrantedScopes(fetchImpl, env, tokenSet.access_token);
  requireScopes(granted, provider.scopes, "Instagram");
  const body = await metaGet(
    fetchImpl, env, "me/accounts?fields=name,instagram_business_account{id,username}",
    tokenSet.access_token, "Instagram account check failed",
  );
  const linked = (Array.isArray(body.data) ? body.data : []).filter((page) => page?.instagram_business_account?.id);
  if (!linked.length) {
    throw new ProviderError("No Instagram professional account is linked to a shared Facebook Page.", { reauthorize: true });
  }
  const account = linked[0].instagram_business_account;
  return {
    account_id: String(account.id).slice(0, 200),
    account_label: account.username ? `@${String(account.username).slice(0, 190)}` : "Instagram account",
    scopes: granted,
    detail: { linked_accounts: linked.length },
  };
}

async function revokeMeta(provider, env, fetchImpl, tokenSet) {
  if (!tokenSet.access_token) return;
  await fetchImpl(provider.revokeUrl(env), {
    method: "DELETE",
    headers: { authorization: `Bearer ${tokenSet.access_token}` },
  });
}

async function exchangeTikTokCode(provider, env, fetchImpl, { code, redirectUri, nowMs }) {
  const response = await fetchImpl(provider.tokenUrl(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_key: secret(env, "ATLAS_TIKTOK_CLIENT_KEY"),
      client_secret: secret(env, "ATLAS_TIKTOK_CLIENT_SECRET"),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }).toString(),
  });
  const body = await readProviderJson(response, "TikTok token exchange failed");
  if (!body.access_token) throw new ProviderError(`TikTok token exchange failed: ${body.error_description || body.error || "no token"}`);
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? null,
    token_type: "Bearer",
    scopes: String(body.scope ?? "").split(",").filter(Boolean),
    access_expires_at: expiresAt(nowMs, body.expires_in),
    refresh_expires_at: expiresAt(nowMs, body.refresh_expires_in),
    external_account_id: body.open_id ?? null,
    obtained_at: new Date(nowMs).toISOString(),
  };
}

async function refreshTikTok(provider, env, fetchImpl, tokenSet, nowMs) {
  if (!tokenSet.refresh_token) throw new ProviderError("TikTok refresh token missing; reconnect.", { reauthorize: true });
  const response = await fetchImpl(provider.tokenUrl(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_key: secret(env, "ATLAS_TIKTOK_CLIENT_KEY"),
      client_secret: secret(env, "ATLAS_TIKTOK_CLIENT_SECRET"),
      grant_type: "refresh_token",
      refresh_token: tokenSet.refresh_token,
    }).toString(),
  });
  const body = await readProviderJson(response, "TikTok token refresh failed");
  if (!body.access_token) throw new ProviderError("TikTok token refresh failed.", { reauthorize: true });
  return {
    ...tokenSet,
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? tokenSet.refresh_token,
    scopes: body.scope ? String(body.scope).split(",").filter(Boolean) : tokenSet.scopes,
    access_expires_at: expiresAt(nowMs, body.expires_in),
    refresh_expires_at: expiresAt(nowMs, body.refresh_expires_in) ?? tokenSet.refresh_expires_at,
    obtained_at: new Date(nowMs).toISOString(),
  };
}

async function verifyTikTok(provider, env, fetchImpl, tokenSet) {
  const response = await fetchImpl("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", {
    headers: { authorization: `Bearer ${tokenSet.access_token}`, accept: "application/json" },
  });
  const body = await readProviderJson(response, "TikTok account check failed");
  if (body?.error?.code && body.error.code !== "ok") {
    throw new ProviderError(`TikTok account check failed: ${body.error.message || body.error.code}`, { reauthorize: true });
  }
  const user = body?.data?.user;
  if (!user?.open_id) throw new ProviderError("TikTok did not return the connected user.");
  return {
    account_id: String(user.open_id).slice(0, 200),
    account_label: String(user.display_name ?? "TikTok account").slice(0, 200),
    detail: {},
  };
}

async function revokeTikTok(provider, env, fetchImpl, tokenSet) {
  if (!tokenSet.access_token) return;
  await fetchImpl(provider.revokeUrl(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: secret(env, "ATLAS_TIKTOK_CLIENT_KEY"),
      client_secret: secret(env, "ATLAS_TIKTOK_CLIENT_SECRET"),
      token: tokenSet.access_token,
    }).toString(),
  });
}

export function tripadvisorVerifyUrl(env, locationId) {
  const template = String(env("ATLAS_TRIPADVISOR_VERIFY_URL") ?? "").trim();
  if (!template) return null;
  const filled = template.replace("{location_id}", encodeURIComponent(String(locationId)));
  try {
    const url = new URL(filled);
    if (url.protocol !== "https:" || url.hostname !== "terra.tripadvisor.com" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function verifyTripadvisor(provider, env, fetchImpl, tokenSet) {
  const locationId = String(env("ATLAS_TRIPADVISOR_LOCATION_ID") ?? "").trim();
  const url = tripadvisorVerifyUrl(env, locationId);
  if (!url || !locationId) throw new ProviderError("Tripadvisor verification endpoint is not configured.");
  const response = await fetchImpl(url, {
    headers: { "x-api-key": tokenSet.api_key, accept: "application/json" },
  });
  const body = await readProviderJson(response, "Tripadvisor location check failed");
  const name = body?.name ?? body?.data?.name ?? body?.location?.name ?? null;
  return {
    account_id: locationId.slice(0, 200),
    account_label: name ? String(name).slice(0, 200) : `Tripadvisor location ${locationId.slice(0, 40)}`,
    detail: {},
  };
}
