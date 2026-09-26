// S94B publishing credential module (docs/marketing/S94_Publishing_Architecture.md §4).
//
// The publishing worker's only way to a provider token:
//
//   openPublishingCredential({ rpc, env, fetchImpl, now }, { deliveryId, claimToken })
//     -> { provider_key, access_token, resource: { kind, id, label }, expires_at }
//
// It calls the service-role RPC atlas_integration_read_credential_for_delivery,
// which hands out ciphertext only while the delivery is claimed with that
// token, its content is approved and the connection has publishing
// permission (it records credential_used). The token set is decrypted with
// the S88 key scheme (ATLAS_INTEGRATION_KEK_V<n>, AES-256-GCM, AAD per
// provider/kind; Page tokens per resource). Google and TikTok access tokens
// that expire within five minutes are refreshed under the database lease
// (atlas_integration_refresh_lock / _refresh_store / _refresh_release), so
// two workers never spend a rotating TikTok refresh token twice.
//
// The token lives in server memory only: the returned object's toJSON()
// omits it, errors carry codes and sanitised text, and nothing here logs.
//
// Dependencies are injected (Node tests pass fakes):
//   rpc(name, payload)   service-role PostgREST RPC
//   env(name)            function secrets
//   fetchImpl(url, init) provider HTTP
//   now()                epoch milliseconds
//   sleep(ms)            optional; waiting for another caller's refresh

import {
  createKeyring,
  credentialAad,
  decryptJson,
  encryptJson,
  resourceCredentialAad,
  sanitizeProviderError,
} from "./crypto.mjs";
import { ProviderError, TOKEN_REFRESHERS, readProviderJson } from "./provider-http.mjs";

export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const LEASE_SECONDS = 60;
const LOCK_ATTEMPTS = 4;
const TIKTOK_CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";

// Codes: not_claimed, not_found, delivery_closed, not_approved, not_connected,
// needs_reauthorization, publishing_permission_missing, no_resource_selected,
// resource_changed, publishing_not_installed, credential_unreadable,
// not_configured, refresh_failed, refresh_in_progress, refresh_lock_lost,
// provider_refused, unavailable.
export class CredentialError extends Error {
  constructor(code, { message = null, retryable = false, reauthorize = false } = {}) {
    super(message ? sanitizeProviderError(message) : `Publishing credential unavailable: ${code}.`);
    this.name = "CredentialError";
    this.code = code;
    this.retryable = retryable;
    this.reauthorize = reauthorize;
  }
}

const RETRYABLE = new Set(["refresh_in_progress", "refresh_lock_lost", "unavailable"]);
const REAUTHORIZE = new Set(["needs_reauthorization", "credential_unreadable"]);

export function needsRefresh(tokenSet, nowMs) {
  const expires = tokenSet?.access_expires_at ? Date.parse(tokenSet.access_expires_at) : null;
  return expires !== null && Number.isFinite(expires) && expires - REFRESH_MARGIN_MS <= nowMs;
}

function context(deps) {
  if (typeof deps?.rpc !== "function" || typeof deps?.env !== "function") {
    throw new CredentialError("not_configured");
  }
  const env = (name) => {
    const value = deps.env(name);
    return value === undefined || value === null ? undefined : String(value);
  };
  return {
    rpc: deps.rpc,
    env,
    fetchImpl: deps.fetchImpl ?? ((url, init) => fetch(url, init)),
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    keyring: deps.keyring ?? createKeyring(env),
    refreshers: deps.refreshers ?? TOKEN_REFRESHERS,
  };
}

async function open(ctx, sealed, aad) {
  let key;
  try {
    key = await ctx.keyring.key(Number(sealed?.key_version));
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    // A missing or invalid key is a setup problem, not a broken credential.
    if (error?.code === "key_missing" || error?.code === "key_invalid" || error?.status === 503) throw new CredentialError("not_configured");
    throw new CredentialError("credential_unreadable", { reauthorize: true });
  }
  try {
    return await decryptJson(key, sealed.ciphertext, sealed.nonce, aad);
  } catch {
    throw new CredentialError("credential_unreadable", { reauthorize: true });
  }
}

// How a failed token refresh is treated:
//   "reauthorize" - the provider refused the refresh token (invalid_grant,
//                   HTTP 400/401, no token issued): reconnect needed;
//   "transient"   - network failure, HTTP 5xx or 429: try again later;
//   "failed"      - anything else (e.g. 403, missing client secret).
export function refreshFailureKind(error) {
  if (!(error instanceof ProviderError)) return "transient";
  if (error.reauthorize) return "reauthorize";
  const status = Number(error.status) || 0;
  if (status === 429 || status >= 500) return "transient";
  return "failed";
}

// Refreshes a Google/TikTok token set under the database lease.
// lockArgs: { deliveryId, claimToken } (worker) or { actorId, actorLabel, actorRole } (a manager).
// Returns the fresh token set (possibly refreshed by another caller).
export async function refreshWithLock(deps, { providerKey, lockArgs = {} }) {
  const ctx = context(deps);
  const refresher = ctx.refreshers[providerKey];
  if (!refresher) throw new CredentialError("not_configured");
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const lock = await ctx.rpc("atlas_integration_refresh_lock", {
      p_provider_key: providerKey,
      p_delivery_id: lockArgs.deliveryId ?? null,
      p_claim_token: lockArgs.claimToken ?? null,
      p_actor_id: lockArgs.actorId ?? null,
      p_actor_label: lockArgs.actorLabel ?? null,
      p_actor_role: lockArgs.actorRole ?? null,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (!lock?.credential) throw new CredentialError("not_connected");
    const kind = lock.credential.credential_kind;
    const latest = await open(ctx, lock.credential, credentialAad(providerKey, kind));
    if (!needsRefresh(latest, ctx.now())) {
      if (lock.acquired) {
        await ctx.rpc("atlas_integration_refresh_release", { p_provider_key: providerKey, p_lock_token: lock.lock_token, p_error: null, p_needs_reauthorization: null });
      }
      return latest;
    }
    if (!lock.acquired) {
      // Another caller is refreshing: wait for its result.
      await ctx.sleep(500 * (attempt + 1));
      continue;
    }
    let refreshed;
    try {
      refreshed = await refresher(ctx.env, ctx.fetchImpl, latest, ctx.now());
      if (!refreshed?.access_token) throw new ProviderError("The provider did not return a new access token.", { reauthorize: true });
    } catch (error) {
      const failure = refreshFailureKind(error);
      const detail = error instanceof ProviderError ? error.message : "Token refresh failed: the provider could not be reached.";
      // Only a refused refresh token (invalid_grant, 400/401) expires the
      // connection. A transient failure (network, 5xx, 429) releases the
      // lease without touching the connection (p_needs_reauthorization
      // null: the event is recorded, the status is kept) and the delivery
      // retries through its normal backoff.
      await ctx.rpc("atlas_integration_refresh_release", {
        p_provider_key: providerKey,
        p_lock_token: lock.lock_token,
        p_error: sanitizeProviderError(detail),
        p_needs_reauthorization: failure === "reauthorize" ? true : failure === "transient" ? null : false,
      });
      if (failure === "reauthorize") throw new CredentialError("needs_reauthorization", { reauthorize: true });
      throw new CredentialError("refresh_failed", { retryable: failure === "transient" });
    }
    const version = ctx.keyring.currentVersion();
    const sealed = await encryptJson(await ctx.keyring.key(version), refreshed, credentialAad(providerKey, kind));
    const stored = await ctx.rpc("atlas_integration_refresh_store", {
      p_provider_key: providerKey,
      p_lock_token: lock.lock_token,
      p_ciphertext: sealed.ciphertextHex,
      p_nonce: sealed.nonceHex,
      p_key_version: version,
      p_access_expires_at: refreshed.access_expires_at ?? null,
      p_refresh_expires_at: refreshed.refresh_expires_at ?? null,
    });
    if (!stored?.stored) throw new CredentialError("refresh_lock_lost", { retryable: true });
    return refreshed;
  }
  throw new CredentialError("refresh_in_progress", { retryable: true });
}

function handle(providerKey, accessToken, resource, expiresAt) {
  const value = {
    provider_key: providerKey,
    access_token: accessToken,
    resource: resource ? { kind: resource.kind, id: resource.id, label: resource.label ?? null } : null,
    expires_at: expiresAt ?? null,
  };
  // JSON.stringify never includes the token (accidental logging, responses).
  Object.defineProperty(value, "toJSON", {
    enumerable: false,
    value() {
      return { provider_key: this.provider_key, resource: this.resource, expires_at: this.expires_at };
    },
  });
  return value;
}

export async function openPublishingCredential(deps, { deliveryId, claimToken } = {}) {
  const ctx = context(deps);
  if (!deliveryId || !claimToken) throw new CredentialError("not_claimed");
  const row = await ctx.rpc("atlas_integration_read_credential_for_delivery", {
    p_delivery_id: deliveryId,
    p_claim_token: claimToken,
  });
  if (!row || row.granted !== true || !row.credential) {
    const code = typeof row?.reason === "string" && /^[a-z_]{3,60}$/.test(row.reason) ? row.reason : "unavailable";
    throw new CredentialError(code, { retryable: RETRYABLE.has(code), reauthorize: REAUTHORIZE.has(code) });
  }
  const providerKey = row.provider_key;
  let tokenSet = await open(ctx, row.credential, credentialAad(providerKey, row.credential.credential_kind));
  if (ctx.refreshers[providerKey] && needsRefresh(tokenSet, ctx.now())) {
    tokenSet = await refreshWithLock(deps, { providerKey, lockArgs: { deliveryId, claimToken } });
  }
  let accessToken = tokenSet?.access_token ?? null;
  let expiresAt = tokenSet?.access_expires_at ?? null;
  const resource = row.resource ?? null;
  if (resource?.credential) {
    const page = await open(ctx, resource.credential, resourceCredentialAad(providerKey, resource.id));
    accessToken = page?.access_token ?? null;
    expiresAt = page?.expires_at ?? null;
  }
  if (typeof accessToken !== "string" || !accessToken) throw new CredentialError("credential_unreadable", { reauthorize: true });
  return handle(providerKey, accessToken, resource, expiresAt);
}

// Live TikTok creator info for the composer (manager/admin; nothing cached).
// Uses the actor credential read (S88) and the same refresh lease.
export async function readTikTokCreatorInfo(deps, { actorId, actorRole, actorLabel = null } = {}) {
  const ctx = context(deps);
  const stored = await ctx.rpc("atlas_integration_read_credential", { p_provider_key: "tiktok", p_actor_role: actorRole, p_actor_id: actorId });
  if (!stored) throw new CredentialError("not_connected");
  let tokenSet = await open(ctx, stored, credentialAad("tiktok", stored.credential_kind));
  if (needsRefresh(tokenSet, ctx.now())) {
    tokenSet = await refreshWithLock(deps, { providerKey: "tiktok", lockArgs: { actorId, actorRole, actorLabel } });
  }
  let body;
  try {
    const response = await ctx.fetchImpl(TIKTOK_CREATOR_INFO_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenSet.access_token}`, "content-type": "application/json; charset=UTF-8", accept: "application/json" },
      body: "{}",
    });
    body = await readProviderJson(response, "TikTok creator info failed");
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new CredentialError(error.status === 401 ? "needs_reauthorization" : "provider_refused", { message: error.message, reauthorize: error.status === 401 });
    }
    throw new CredentialError("unavailable", { retryable: true });
  }
  if (body?.error?.code && body.error.code !== "ok") {
    const code = String(body.error.code);
    throw new CredentialError(code === "access_token_invalid" ? "needs_reauthorization" : "provider_refused", {
      message: `TikTok creator info: ${code}`,
      reauthorize: code === "access_token_invalid",
    });
  }
  const data = body?.data ?? {};
  let directPostAllowed = false;
  try {
    const targets = await ctx.rpc("atlas_integration_publish_targets", {});
    const tiktok = Array.isArray(targets) ? targets.find((entry) => entry?.provider_key === "tiktok") : null;
    directPostAllowed = Array.isArray(tiktok?.target_kinds) && tiktok.target_kinds.includes("tiktok_video");
  } catch {
    directPostAllowed = false;
  }
  const text = (value) => (typeof value === "string" ? value.slice(0, 120) : null);
  return {
    creator_nickname: text(data.creator_nickname),
    creator_username: text(data.creator_username),
    privacy_level_options: Array.isArray(data.privacy_level_options)
      ? data.privacy_level_options.filter((option) => typeof option === "string" && /^[A-Z_]{3,40}$/.test(option))
      : [],
    comment_disabled: data.comment_disabled === true,
    duet_disabled: data.duet_disabled === true,
    stitch_disabled: data.stitch_disabled === true,
    max_video_post_duration_sec: Number.isFinite(Number(data.max_video_post_duration_sec)) ? Number(data.max_video_post_duration_sec) : null,
    direct_post_allowed: directPostAllowed,
  };
}

// Test seam: internals the Node tests assert directly.
export const __testing = Object.freeze({
  LEASE_SECONDS,
  LOCK_ATTEMPTS,
  TIKTOK_CREATOR_INFO_URL,
  needsRefresh,
  handle,
});
