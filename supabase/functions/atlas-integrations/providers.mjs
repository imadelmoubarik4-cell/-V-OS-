// Provider registry for atlas-integrations.
//
// Endpoints and scopes were checked against each provider's public
// documentation in September 2026. `endpoint_evidence` records how sure we are:
//   "documented"  - stated in the provider's current developer documentation
//   "unverified"  - could not be confirmed from primary documentation; the
//                   provider stays "not available" until the owner confirms it
// Scopes (S94B, docs/marketing/S94_Publishing_Architecture.md §4):
//   `scopes`         connect + verify, the minimum; verify requires only these.
//   `publish_scopes` requested only when a manager presses "Allow publishing"
//                    (start with purpose "publishing" asks for scopes ∪
//                    publish_scopes). The database derives
//                    publishing_permission_state from the granted scopes.
//   `future_scopes`  insights etc., never requested.
//
// All network calls go through an injected `fetchImpl` so tests never reach a
// provider. No function here returns a token to a caller outside the Edge
// Function; the handler only exposes `publicProvider()` output.

import {
  GOOGLE_TOKEN_URL,
  ProviderError,
  TIKTOK_TOKEN_URL,
  expiresAt,
  readProviderJson,
  refreshGoogleTokenSet,
  refreshTikTokTokenSet,
  secret,
} from "../_shared/integrations/provider-http.mjs";

export { ProviderError };

export const DEFAULT_META_GRAPH_VERSION = "v25.0";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
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
    // business.manage already covers local posts (contract §4).
    publish_scopes: [],
    future_scopes: [],
    resource_kind: "gbp_location",
    scopeSeparator: " ",
    clientIdParam: "client_id",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    credentials: [
      { env: "ATLAS_GOOGLE_OAUTH_CLIENT_ID", label: "a Google Cloud OAuth client ID" },
      { env: "ATLAS_GOOGLE_OAUTH_CLIENT_SECRET", label: "its client secret" },
    ],
    extraRequirements: [],
    enables: "Shows your Google listing in Atlas and publishes approved Google posts.",
    owner_requirements_summary:
      "Google Cloud project, approved Business Profile API access, published OAuth consent screen (business.manage is a sensitive scope), OAuth web client.",
    verify: verifyGoogleBusinessProfile,
    listResources: listGoogleBusinessProfileResources,
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
    publish_scopes: null,
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
    publish_scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management"],
    future_scopes: ["read_insights"],
    resource_kind: "facebook_page",
    // Re-asks permissions the person declined earlier (Facebook Login
    // auth_type=rerequest; UNVERIFIED against the live page this session).
    publishAuthorizeParams: { auth_type: "rerequest" },
    scopeSeparator: ",",
    clientIdParam: "client_id",
    extraAuthorizeParams: {},
    credentials: [
      { env: "ATLAS_META_APP_ID", label: "a Meta app ID" },
      { env: "ATLAS_META_APP_SECRET", label: "its app secret" },
    ],
    extraRequirements: [],
    enables: "Lets Atlas publish approved posts to your Facebook Page.",
    owner_requirements_summary:
      "Meta Business app with Facebook Login for Business, business verification, App Review for Page permissions, app in Live mode.",
    verify: verifyFacebookPages,
    listResources: listFacebookPages,
    resourceCredential: facebookPageCredential,
    revokePermissions: revokeMetaPermissions,
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
    publish_scopes: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "business_management"],
    future_scopes: ["instagram_manage_insights"],
    resource_kind: "instagram_account",
    publishAuthorizeParams: { auth_type: "rerequest" },
    scopeSeparator: ",",
    clientIdParam: "client_id",
    extraAuthorizeParams: {},
    credentials: [
      { env: "ATLAS_META_APP_ID", label: "a Meta app ID" },
      { env: "ATLAS_META_APP_SECRET", label: "its app secret" },
    ],
    extraRequirements: [],
    enables: "Lets Atlas publish approved posts to your Instagram account.",
    owner_requirements_summary:
      "Instagram professional account linked to the VÁ Facebook Page; same Meta app; App Review for Instagram permissions.",
    verify: verifyInstagramAccount,
    listResources: listInstagramAccounts,
    resourceCredential: instagramPageCredential,
    revokePermissions: revokeMetaPermissions,
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
    tokenUrl: () => TIKTOK_TOKEN_URL,
    revokeUrl: () => "https://open.tiktokapis.com/v2/oauth/revoke/",
    scopes: ["user.info.basic"],
    // Inbox upload (video.upload) and Direct Post (video.publish).
    publish_scopes: ["video.upload", "video.publish"],
    future_scopes: ["video.list"],
    resource_kind: "tiktok_account",
    scopeSeparator: ",",
    clientIdParam: "client_key",
    extraAuthorizeParams: {},
    credentials: [
      { env: "ATLAS_TIKTOK_CLIENT_KEY", label: "a TikTok for Developers client key" },
      { env: "ATLAS_TIKTOK_CLIENT_SECRET", label: "its client secret" },
    ],
    extraRequirements: [],
    enables: "Lets Atlas send approved videos to your TikTok account.",
    owner_requirements_summary:
      "TikTok for Developers app with Login Kit, approved app review, registered redirect URI. Publishing needs Content Posting API audit.",
    verify: verifyTikTok,
    listResources: listTikTokAccount,
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
    publish_scopes: null,
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

// Publishing providers (S94B): the four that have a publish target.
export function supportsPublishing(provider) {
  return Array.isArray(provider?.publish_scopes);
}

// connect: `scopes`; publishing: `scopes` ∪ `publish_scopes`, in order.
export function requestedScopes(provider, purpose = "connect") {
  if (purpose !== "publishing" || !supportsPublishing(provider)) return [...provider.scopes];
  return [...new Set([...provider.scopes, ...provider.publish_scopes])];
}

export function buildAuthorizeUrl(provider, env, { redirectUri, state, codeChallenge, purpose = "connect" }) {
  const url = new URL(provider.authorizeUrl(env));
  const clientId = String(env(provider.credentials[0].env) ?? "").trim();
  url.searchParams.set(provider.clientIdParam, clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", requestedScopes(provider, purpose).join(provider.scopeSeparator));
  url.searchParams.set("state", state);
  if (provider.pkce === "S256") {
    if (!codeChallenge) throw new Error("PKCE challenge is required for this provider.");
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [name, value] of Object.entries(provider.extraAuthorizeParams)) url.searchParams.set(name, value);
  if (purpose === "publishing" && provider.publishAuthorizeParams) {
    for (const [name, value] of Object.entries(provider.publishAuthorizeParams)) url.searchParams.set(name, value);
  }
  return url.toString();
}

// ---------------------------------------------------------------- provider calls

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
  return refreshGoogleTokenSet(env, fetchImpl, tokenSet, nowMs, provider.tokenUrl(env));
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

// S94B: no first-account default. One account is named; several are counted
// and the owner picks the location in the resource picker.
async function verifyGoogleBusinessProfile(provider, env, fetchImpl, tokenSet) {
  const body = await googleGet(
    fetchImpl,
    "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
    tokenSet.access_token,
    "Business Profile account check failed",
  );
  const accounts = Array.isArray(body.accounts) ? body.accounts : [];
  if (!accounts.length) throw new ProviderError("The Google account has no Business Profile accounts.");
  const [only = null] = accounts.length === 1 ? accounts : [];
  return {
    account_id: only ? String(only.name ?? "").slice(0, 200) || null : null,
    account_label: only
      ? String(only.accountName ?? only.name ?? "Business Profile").slice(0, 200)
      : `${accounts.length}${body.nextPageToken ? "+" : ""} Business Profile accounts`,
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

function countLabel(names, noun) {
  const [only] = names;
  if (names.length === 1) return String(only ?? noun).slice(0, 200);
  return `${names.length} ${noun}s`;
}

// The id when there is exactly one (not a choice); otherwise none.
function soleId(values) {
  const [only] = values;
  return values.length === 1 && only !== undefined && only !== null ? String(only).slice(0, 200) || null : null;
}

// S94B: verify needs only the connect scopes; no first-Page default. The
// Page Atlas posts to is chosen in the picker (list-resources).
async function verifyFacebookPages(provider, env, fetchImpl, tokenSet) {
  const granted = await metaGrantedScopes(fetchImpl, env, tokenSet.access_token);
  requireScopes(granted, provider.scopes, "Facebook");
  const pages = await metaGetAll(fetchImpl, env, "me/accounts?fields=id,name&limit=100", tokenSet.access_token, "Facebook Page check failed");
  if (!pages.length) throw new ProviderError("No Facebook Page was shared with Atlas.", { reauthorize: true });
  return {
    account_id: soleId(pages.map((page) => page?.id)),
    account_label: countLabel(pages.map((page) => page?.name ?? "Page"), "Page"),
    scopes: granted,
    detail: { page_count: pages.length },
  };
}

async function verifyInstagramAccount(provider, env, fetchImpl, tokenSet) {
  const granted = await metaGrantedScopes(fetchImpl, env, tokenSet.access_token);
  requireScopes(granted, provider.scopes, "Instagram");
  const pages = await metaGetAll(
    fetchImpl, env, "me/accounts?fields=name,instagram_business_account{id,username}&limit=100",
    tokenSet.access_token, "Instagram account check failed",
  );
  const linked = pages.filter((page) => page?.instagram_business_account?.id);
  if (!linked.length) {
    throw new ProviderError("No Instagram professional account is linked to a shared Facebook Page.", { reauthorize: true });
  }
  const names = linked.map((page) => page.instagram_business_account.username ? `@${String(page.instagram_business_account.username).slice(0, 190)}` : "Instagram account");
  return {
    account_id: soleId(linked.map((page) => page.instagram_business_account.id)),
    account_label: countLabel(names, "Instagram account"),
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
  return refreshTikTokTokenSet(env, fetchImpl, tokenSet, nowMs, provider.tokenUrl(env));
}

async function tiktokUser(fetchImpl, tokenSet) {
  const response = await fetchImpl("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", {
    headers: { authorization: `Bearer ${tokenSet.access_token}`, accept: "application/json" },
  });
  const body = await readProviderJson(response, "TikTok account check failed");
  if (body?.error?.code && body.error.code !== "ok") {
    throw new ProviderError(`TikTok account check failed: ${body.error.message || body.error.code}`, { reauthorize: true });
  }
  const user = body?.data?.user;
  if (!user?.open_id) throw new ProviderError("TikTok did not return the connected user.");
  return user;
}

async function verifyTikTok(provider, env, fetchImpl, tokenSet) {
  const user = await tiktokUser(fetchImpl, tokenSet);
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

// ---------------------------------------------------------------- S94B resources

const MAX_PAGES = 5;
const GRAPH_HOST = "graph.facebook.com";

function cleanLabel(value, fallback) {
  const text = String(value ?? "").replace(/[^\x20-\x7E -￿]/g, " ").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 200);
}

function cleanId(value) {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9_.:\/-]{1,200}$/.test(text) ? text : null;
}

// Meta returns paging.next with the token in the query. Only a Graph API URL
// is followed, and the token is removed from the query (the bearer header
// carries it) so it can never end up anywhere else.
function nextGraphUrl(next) {
  if (typeof next !== "string" || !next) return null;
  try {
    const url = new URL(next);
    if (url.protocol !== "https:" || url.hostname !== GRAPH_HOST || url.username || url.password) return null;
    url.searchParams.delete("access_token");
    return url.toString();
  } catch {
    return null;
  }
}

async function metaGetAll(fetchImpl, env, path, accessToken, fallback) {
  const rows = [];
  let url = `https://${GRAPH_HOST}/${metaVersion(env)}/${path}`;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
    const body = await readProviderJson(response, fallback);
    if (Array.isArray(body.data)) rows.push(...body.data);
    url = nextGraphUrl(body?.paging?.next);
  }
  return rows;
}

function pageTasks(page) {
  return Array.isArray(page?.tasks) ? page.tasks.map((task) => String(task)).filter((task) => /^[A-Z_]{2,40}$/.test(task)).slice(0, 8) : null;
}

// A Page Atlas can post to: the person can perform CREATE_CONTENT on it
// (Pages API `tasks`). When Meta omits tasks, the Page is offered and the
// publish call decides.
function canCreateContent(tasks) {
  return tasks === null || tasks.includes("CREATE_CONTENT");
}

async function listFacebookPages(provider, env, fetchImpl, tokenSet) {
  const pages = await metaGetAll(fetchImpl, env, "me/accounts?fields=id,name,category,tasks&limit=100", tokenSet.access_token, "Facebook Page list failed");
  const resources = [];
  for (const page of pages) {
    const id = cleanId(page?.id);
    if (!id) continue;
    const tasks = pageTasks(page);
    const selectable = canCreateContent(tasks);
    resources.push({
      resource_kind: "facebook_page",
      resource_id: id,
      parent_resource_id: null,
      label: cleanLabel(page.name, "Facebook Page"),
      metadata: {
        category: page.category ? cleanLabel(page.category, "") || null : null,
        tasks,
        selectable,
        unavailable_reason: selectable ? null : "no_create_content",
      },
    });
  }
  return { resources, notes: { pages_total: pages.length } };
}

// Instagram professional accounts are found through the Pages the person
// manages (instagram_business_account). Pages without one are counted so the
// picker can explain an empty list.
async function listInstagramAccounts(provider, env, fetchImpl, tokenSet) {
  const pages = await metaGetAll(
    fetchImpl, env, "me/accounts?fields=id,name,tasks,instagram_business_account{id,username,name}&limit=100",
    tokenSet.access_token, "Instagram account list failed",
  );
  const resources = [];
  let unlinked = 0;
  for (const page of pages) {
    const account = page?.instagram_business_account;
    const id = cleanId(account?.id);
    const pageId = cleanId(page?.id);
    if (!id || !pageId) { unlinked += 1; continue; }
    const tasks = pageTasks(page);
    const selectable = canCreateContent(tasks);
    const username = account.username ? cleanLabel(account.username, "").replace(/^@/, "") : null;
    resources.push({
      resource_kind: "instagram_account",
      resource_id: id,
      parent_resource_id: pageId,
      label: username ? `@${username}` : cleanLabel(account.name, "Instagram account"),
      metadata: {
        username,
        page_name: cleanLabel(page.name, "Facebook Page"),
        tasks,
        selectable,
        unavailable_reason: selectable ? null : "no_create_content",
      },
    });
  }
  return { resources, notes: { pages_total: pages.length, pages_without_instagram: unlinked } };
}

function addressSummary(address) {
  if (!address || typeof address !== "object") return null;
  const lines = Array.isArray(address.addressLines) ? address.addressLines.slice(0, 1) : [];
  const place = [address.postalCode, address.locality].filter(Boolean).join(" ");
  const text = [...lines, place].filter(Boolean).join(", ");
  return text ? cleanLabel(text, "") : null;
}

async function googleGetAll(fetchImpl, baseUrl, accessToken, fallback, key) {
  const rows = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(baseUrl);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await googleGet(fetchImpl, url.toString(), accessToken, fallback);
    if (Array.isArray(body[key])) rows.push(...body[key]);
    pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
    if (!pageToken) break;
  }
  return rows;
}

// Accounts (Account Management v1) and their locations (Business Information
// v1, readMask required). A location's resource id is the v4 parent
// "accounts/{a}/locations/{l}" that localPosts need.
async function listGoogleBusinessProfileResources(provider, env, fetchImpl, tokenSet) {
  const accounts = (await googleGetAll(
    fetchImpl, "https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20",
    tokenSet.access_token, "Business Profile account list failed", "accounts",
  )).slice(0, 20);
  const resources = [];
  for (const account of accounts) {
    const accountName = cleanId(account?.name);
    if (!accountName || !/^accounts\/[A-Za-z0-9_-]+$/.test(accountName)) continue;
    const role = typeof account.role === "string" ? account.role.slice(0, 40) : null;
    resources.push({
      resource_kind: "gbp_account",
      resource_id: accountName,
      parent_resource_id: null,
      label: cleanLabel(account.accountName, "Business Profile account"),
      metadata: { type: typeof account.type === "string" ? account.type.slice(0, 40) : null, role },
    });
    const url = new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`);
    url.searchParams.set("readMask", "name,title,storefrontAddress,metadata");
    url.searchParams.set("pageSize", "100");
    const locations = await googleGetAll(fetchImpl, url.toString(), tokenSet.access_token, "Business Profile location list failed", "locations");
    for (const location of locations) {
      const locationName = cleanId(location?.name);
      if (!locationName || !/^locations\/[A-Za-z0-9_-]+$/.test(locationName)) continue;
      const voiceOfMerchant = typeof location.metadata?.hasVoiceOfMerchant === "boolean" ? location.metadata.hasVoiceOfMerchant : null;
      // Site managers cannot manage posts in the Business Profile UI
      // (UNVERIFIED for the API): not offered until tested.
      const reason = role === "SITE_MANAGER" ? "site_manager" : voiceOfMerchant === false ? "not_verified" : null;
      resources.push({
        resource_kind: "gbp_location",
        resource_id: `${accountName}/${locationName}`,
        parent_resource_id: accountName,
        label: cleanLabel(location.title, "Business Profile location"),
        metadata: {
          location_name: locationName,
          account_label: cleanLabel(account.accountName, "Business Profile account"),
          address: addressSummary(location.storefrontAddress),
          has_voice_of_merchant: voiceOfMerchant,
          selectable: reason === null,
          unavailable_reason: reason,
        },
      });
    }
  }
  return { resources, notes: { accounts_total: accounts.length } };
}

// A TikTok token belongs to one account; listing returns it (the database
// selects the single account).
async function listTikTokAccount(provider, env, fetchImpl, tokenSet) {
  const user = await tiktokUser(fetchImpl, tokenSet);
  return {
    resources: [{
      resource_kind: "tiktok_account",
      resource_id: cleanId(user.open_id) ?? (() => { throw new ProviderError("TikTok returned an unusable account id."); })(),
      parent_resource_id: null,
      label: cleanLabel(user.display_name, "TikTok account"),
      metadata: { selectable: true },
    }],
    notes: {},
  };
}

// The selected Page's access token (Pages API: GET /{page-id}?fields=access_token
// with the user token). From a long-lived user token it does not expire.
async function pageAccessToken(fetchImpl, env, userToken, pageId, nowMs) {
  const body = await metaGet(fetchImpl, env, `${encodeURIComponent(pageId)}?fields=id,access_token`, userToken, "Facebook Page access check failed");
  if (String(body?.id ?? "") !== String(pageId) || typeof body?.access_token !== "string" || !body.access_token) {
    throw new ProviderError("Meta did not allow Atlas to post to this Page. Check your role on the Page.");
  }
  return { access_token: body.access_token, token_type: "page", page_id: String(pageId), obtained_at: new Date(nowMs).toISOString() };
}

async function facebookPageCredential(provider, env, fetchImpl, tokenSet, resource, nowMs) {
  return pageAccessToken(fetchImpl, env, tokenSet.access_token, resource.resource_id, nowMs);
}

// Instagram publishing with Facebook Login uses the linked Page's token.
async function instagramPageCredential(provider, env, fetchImpl, tokenSet, resource, nowMs) {
  if (!resource.parent_resource_id) throw new ProviderError("This Instagram account is not linked to a Facebook Page.");
  return pageAccessToken(fetchImpl, env, tokenSet.access_token, resource.parent_resource_id, nowMs);
}

// Revokes only the named permissions (DELETE /me/permissions/{permission}),
// used when the other Meta connection shares the same app and must keep
// working. Returns true when every call succeeded.
async function revokeMetaPermissions(provider, env, fetchImpl, tokenSet, permissions) {
  if (!tokenSet.access_token) return false;
  let ok = true;
  for (const permission of permissions) {
    if (!/^[a-z_]{3,60}$/.test(permission)) continue;
    const response = await fetchImpl(`${provider.revokeUrl(env)}/${permission}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${tokenSet.access_token}` },
    });
    if (!response.ok) ok = false;
  }
  return ok;
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
