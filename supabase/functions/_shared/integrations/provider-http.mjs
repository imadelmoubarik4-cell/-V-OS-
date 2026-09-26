// Shared provider HTTP helpers and token refresh (extracted from
// atlas-integrations/providers.mjs in S94B so the publishing credential module
// can refresh Google and TikTok tokens with the same code). Behaviour is
// unchanged. Every call goes through an injected fetchImpl; nothing here logs
// or returns a token to a browser.

import { sanitizeProviderError } from "./crypto.mjs";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

export class ProviderError extends Error {
  constructor(message, { status = 0, reauthorize = false } = {}) {
    super(sanitizeProviderError(message));
    this.status = status;
    this.reauthorize = reauthorize;
  }
}

export async function readProviderJson(response, fallback) {
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

export function expiresAt(nowMs, seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(nowMs + value * 1000).toISOString() : null;
}

export function secret(env, name) {
  const value = String(env(name) ?? "").trim();
  if (!value) throw new ProviderError("Provider credentials are not configured.");
  return value;
}

export async function refreshGoogleTokenSet(env, fetchImpl, tokenSet, nowMs, tokenUrl = GOOGLE_TOKEN_URL) {
  if (!tokenSet.refresh_token) throw new ProviderError("Google did not issue a refresh token; reconnect.", { reauthorize: true });
  const response = await fetchImpl(tokenUrl, {
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

// TikTok rotates the refresh token: the returned one must be stored.
export async function refreshTikTokTokenSet(env, fetchImpl, tokenSet, nowMs, tokenUrl = TIKTOK_TOKEN_URL) {
  if (!tokenSet.refresh_token) throw new ProviderError("TikTok refresh token missing; reconnect.", { reauthorize: true });
  const response = await fetchImpl(tokenUrl, {
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

// Which providers refresh, by provider key.
export const TOKEN_REFRESHERS = Object.freeze({
  "google-business-profile": refreshGoogleTokenSet,
  "google-drive": refreshGoogleTokenSet,
  tiktok: refreshTikTokTokenSet,
});
