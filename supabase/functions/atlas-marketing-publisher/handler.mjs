// atlas-marketing-publisher: the S94C delivery worker (contract §5.4, report 07 §1.5).
//
// createPublisherHandler({ env, fetchImpl, rpc?, now, random, credentials, sleep? })
//   env(name) | env object     configuration (Deno.env.get in production)
//   fetchImpl(url, init)       outbound HTTP (providers + our Storage/PostgREST)
//   rpc(name, payload)         service-role PostgREST RPC (default: built from
//                              SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
//   now() / random()           clock and randomness (tests inject both)
//   credentials                { openPublishingCredential(deps, {deliveryId, claimToken}) }
//                              from _shared/integrations/credentials.mjs (S94B)
//   sleep(ms)                  inline poll waits (tests inject a fake clock)
//
// Request contract: POST only (?action=tick or ?action=kick, same code path),
// header x-atlas-publisher-secret compared in constant time over SHA-256
// digests with ATLAS_MARKETING_PUBLISHER_SECRET (≥ 32 bytes; unset/short ->
// 503 and nothing runs; ATLAS_MARKETING_PUBLISHER_SECRET_NEXT is accepted
// during rotation). No CORS, body ≤ 4 KB and ignored (the database is the
// only source of truth about what is due), response = counts only.
//
// Loop: claim a batch (worker id per invocation), run each claimed delivery
// through its provider adapter - sequentially per provider account, accounts
// in parallel - with every provider id persisted by record_step before the
// next call, begin_submit committed before every non-idempotent call,
// heartbeats before long steps, and a classified outcome sent to complete().
// Every write is fenced on the claim token: lease_lost stops all work on that
// delivery. Work budget 45 s per invocation (Edge limits: 150 s idle, 150/400 s
// wall clock); a TikTok upload may run to the upload budget (120 s), measured
// from the moment that upload starts and never past the invocation's wall
// budget (140 s): an upload that could not get a useful share of it is not
// started (the delivery retries before anything is sent).
//
// After complete(): media that reached a platform (published / processing) is
// recorded with atlas_marketing_media_record_use (pins it against deletion);
// a provider auth failure marks the connection "Needs reconnecting" through
// the claim-fenced atlas_integration_mark_auth_failed before complete().
//
// This module never logs. Tokens and signed URLs stay in memory: RPC payloads
// carry ids, phases, sanitised codes/messages (≤ 240 chars) and url_expires_at.

import * as instagram from "../_shared/publishing/instagram.mjs";
import * as facebook from "../_shared/publishing/facebook.mjs";
import * as tiktok from "../_shared/publishing/tiktok.mjs";
import * as gbp from "../_shared/publishing/gbp.mjs";
import { createHttp, sanitizeMessage } from "../_shared/publishing/http.mjs";
import { createMediaUrls } from "../_shared/publishing/media-urls.mjs";
import { LeaseLostError, SubmitRefusedError, attentionOutcome } from "../_shared/publishing/classify.mjs";

export const FUNCTION_VERSION = "s94c.1";
export const SECRET_HEADER = "x-atlas-publisher-secret";
const MIN_SECRET_BYTES = 32;
const MAX_BODY_BYTES = 4096;
const CLAIM_LIMIT = 4;
const LEASE_SECONDS = 300;
const HEARTBEAT_BELOW_MS = 90_000;
const DEFAULT_BUDGET_MS = 45_000;
const DEFAULT_UPLOAD_BUDGET_MS = 120_000;
const DEFAULT_WALL_BUDGET_MS = 140_000;
const STOP_CLAIMING_BEFORE_MS = 10_000;
const MAX_BATCHES = 8;

export const RPC = Object.freeze({
  claim: "atlas_marketing_delivery_claim",
  heartbeat: "atlas_marketing_delivery_heartbeat",
  recordStep: "atlas_marketing_delivery_record_step",
  beginSubmit: "atlas_marketing_delivery_begin_submit",
  complete: "atlas_marketing_delivery_complete",
  markAuthFailed: "atlas_integration_mark_auth_failed",
  recordUse: "atlas_marketing_media_record_use",
});

export const ADAPTERS = Object.freeze({
  instagram,
  facebook,
  tiktok,
  "google-business-profile": gbp,
});

const OUTCOME_STATUSES = new Set(["published", "processing", "retrying", "verifying", "failed", "needs_attention"]);
const ERROR_CLASSES = new Set(["transient", "rate_limited", "auth", "permanent", "uncertain", "stale", "policy"]);
const ATTENTION_REASONS = new Set(["outcome_unknown", "auth_expired", "rate_limit_exhausted", "max_attempts", "stale_schedule", "provider_rejected", "media_invalid", "manual_hold", "no_resource", "provider_not_ready"]);
const STEP_KEYS = ["step", "http_status", "provider_request_id", "outcome", "code", "message", "poll_status", "detail"];
const ID_KEYS = ["provider_container_id", "provider_publish_id", "provider_post_id", "provider_permalink"];

const RESPONSE_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
});

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function envReader(env) {
  if (typeof env === "function") return (name) => env(name);
  return (name) => env?.[name];
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ---- secret check ------------------------------------------------------------

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text))));
}

// Constant-time comparison of two strings over their SHA-256 digests (fixed
// length, so neither content nor length leaks through timing).
export async function secretMatches(provided, expected) {
  const [a, b] = await Promise.all([sha256(provided ?? ""), sha256(expected ?? "")]);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export function secretConfigured(value) {
  return typeof value === "string" && new TextEncoder().encode(value).length >= MIN_SECRET_BYTES;
}

// ---- sanitising RPC payloads ---------------------------------------------------

function cleanText(value, secrets, limit = 240) {
  if (value === undefined || value === null) return undefined;
  return sanitizeMessage(String(value), secrets).slice(0, limit);
}

function cleanStep(step, secrets) {
  const out = {};
  for (const key of STEP_KEYS) {
    const value = step?.[key];
    if (value === undefined || value === null) continue;
    out[key] = key === "http_status" ? (Number.isFinite(Number(value)) ? Number(value) : undefined) : cleanText(value, secrets);
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

function cleanProgress(progress, secrets) {
  if (!progress || typeof progress !== "object") return undefined;
  // Progress holds ids, counters, flags and timestamps only; any string that
  // looks like a URL or secret is refused rather than stored.
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    if (typeof value === "string") {
      if (/https?:\/\//i.test(value) || secrets.some((s) => s && value.includes(s))) return null;
      return value.slice(0, 200);
    }
    return value;
  };
  return walk(progress);
}

// A provider permalink is public (GBP searchUrl carries a query string), but
// never one of our Storage URLs or anything carrying a token.
function isPublicPermalink(value) {
  const text = String(value ?? "");
  return /^https:\/\/[^\s]+$/.test(text) && text.length <= 500 && !/\/storage\/v1\/|[?&](token|access_token|upload_token|signature)=/i.test(text);
}

function cleanIds(ids, secrets) {
  const out = {};
  for (const key of ID_KEYS) {
    const value = ids?.[key];
    if (value === undefined || value === null) continue;
    if (key === "provider_permalink") {
      if (isPublicPermalink(value)) out[key] = String(value).slice(0, 500);
      continue;
    }
    out[key] = String(value).slice(0, 200);
  }
  if (ids?.progress) out.progress = cleanProgress(ids.progress, secrets);
  if (ids?.reset_container === true) out.reset_container = true;
  return out;
}

export function cleanOutcome(outcome, secrets) {
  const status = OUTCOME_STATUSES.has(outcome?.status) ? outcome.status : "verifying";
  if (status === "published") {
    const out = { status, post_id: String(outcome.post_id ?? "").slice(0, 200) };
    if (isPublicPermalink(outcome.permalink)) out.permalink = String(outcome.permalink).slice(0, 500);
    if (outcome.published_at) out.published_at = String(outcome.published_at);
    out.source = outcome.source === "verification" ? "verification" : "provider";
    return out;
  }
  if (status === "processing") {
    const out = { status };
    const ids = cleanIds(outcome.ids ?? {}, secrets);
    if (Object.keys(ids).length) out.ids = ids;
    if (Number.isFinite(Number(outcome.poll_after_s))) out.poll_after_s = Math.max(5, Math.min(86_400, Math.floor(Number(outcome.poll_after_s))));
    return out;
  }
  const error = outcome?.error ?? {};
  const out = {
    status,
    error: {
      class: ERROR_CLASSES.has(error.class) ? error.class : status === "verifying" ? "uncertain" : "transient",
      code: cleanText(error.code ?? "error", secrets, 80),
      message: cleanText(error.message ?? "", secrets, 240),
    },
  };
  if (ATTENTION_REASONS.has(outcome.attention_reason)) out.attention_reason = outcome.attention_reason;
  for (const key of ["retry_after_s", "cooldown_s", "poll_after_s"]) {
    if (Number.isFinite(Number(outcome[key])) && outcome[key] !== null && outcome[key] !== undefined) out[key] = Math.max(0, Math.min(86_400, Math.floor(Number(outcome[key]))));
  }
  if (outcome.definitive === true) out.definitive = true;
  return out;
}

// Keeps an adapter outcome inside the legal transitions for the claim kind
// (report 07 §2.3): a verify claim (status verifying) may only end published,
// retrying (proven absence, `definitive`), verifying or needs_attention; a poll
// claim (status processing) never goes to retrying.
export function coerceForClaim(outcome, claimKind) {
  if (!outcome || typeof outcome !== "object") return outcome;
  if (claimKind === "verify") {
    if (outcome.status === "processing") {
      return { status: "verifying", poll_after_s: outcome.poll_after_s ?? 60, error: { class: "uncertain", code: "still_processing", message: "The platform is still processing this post; Atlas will check again." } };
    }
    if (outcome.status === "failed") return { ...outcome, status: "needs_attention" };
    if (outcome.status === "retrying" && outcome.definitive !== true) {
      return { ...outcome, status: "verifying", error: { ...(outcome.error ?? {}), class: "uncertain" } };
    }
  }
  if (claimKind === "poll" && outcome.status === "retrying") {
    return { status: "processing", poll_after_s: Math.max(60, Number(outcome.retry_after_s) || 0) };
  }
  return outcome;
}

// ---- claim normalisation -------------------------------------------------------

export function normalizeClaim(claim) {
  const row = claim?.delivery ?? {};
  const payload = claim?.payload_snapshot ?? {};
  const provider = String(row.provider_key ?? payload.provider_key ?? "");
  const po = payload.platform_options && typeof payload.platform_options === "object" ? payload.platform_options : {};
  const options = po[provider] && typeof po[provider] === "object" ? po[provider] : po;
  const media = (Array.isArray(payload.media) ? payload.media : []).slice().sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  return {
    id: String(row.id ?? ""),
    content_id: String(row.content_id ?? payload.content_id ?? ""),
    claim_token: String(claim?.claim_token ?? ""),
    claim_kind: String(claim?.claim_kind ?? "publish"),
    lease_until: claim?.lease_until ?? null,
    provider_key: provider,
    external_account_id: String(row.external_account_id ?? payload.external_account_id ?? ""),
    target_kind: String(row.target_kind ?? payload.target_kind ?? ""),
    status: String(row.status ?? ""),
    phase: String(row.phase ?? "none"),
    attempt_count: Number(row.attempt_count) || 0,
    poll_count: Number(row.poll_count) || 0,
    verify_attempts: Number(row.verify_attempts) || 0,
    latest_acceptable_at: row.latest_acceptable_at ?? null,
    submit_started_at: row.submit_started_at ?? null,
    cancel_requested_at: row.cancel_requested_at ?? null,
    container_id: row.provider_container_id ?? null,
    publish_id: row.provider_publish_id ?? null,
    post_id: row.provider_post_id ?? null,
    permalink: row.provider_permalink ?? null,
    progress: row.progress && typeof row.progress === "object" ? { ...row.progress } : {},
    payload: {
      title: payload.title ?? null,
      caption: String(payload.caption ?? options?.caption ?? ""),
      media,
      options,
      scheduled_for: payload.scheduled_for ?? null,
      event_starts_at: payload.event_starts_at ?? null,
      venue_timezone: payload.venue_timezone ?? null,
    },
  };
}

// ---- credential failures ----------------------------------------------------------

// CredentialError codes from _shared/integrations/credentials.mjs (S94B):
// not_claimed, not_found, delivery_closed, not_approved, not_connected,
// needs_reauthorization, publishing_permission_missing, no_resource_selected,
// resource_changed, publishing_not_installed, credential_unreadable,
// not_configured, refresh_failed, refresh_in_progress, refresh_lock_lost,
// provider_refused, unavailable; plus the flags `reauthorize` and `retryable`.
const CREDENTIAL_LEASE_CODES = new Set(["not_claimed", "not_found", "delivery_closed"]);
const CREDENTIAL_AUTH_CODES = new Set(["needs_reauthorization", "credential_unreadable"]);
const CREDENTIAL_RESOURCE_CODES = new Set(["no_resource_selected", "resource_changed"]);
const CREDENTIAL_RETRY_CODES = new Set(["refresh_in_progress", "refresh_lock_lost", "unavailable"]);

export function credentialFailure(error) {
  const raw = String(error?.code ?? "unavailable").toLowerCase();
  const code = /^[a-z_]{3,60}$/.test(raw) ? raw : "unavailable";
  const tag = `credential_${code}`.slice(0, 80);
  if (CREDENTIAL_LEASE_CODES.has(code)) return { leaseLost: true };
  if (error?.reauthorize === true || CREDENTIAL_AUTH_CODES.has(code) || (code === "refresh_failed" && error?.retryable !== true)) {
    return attentionOutcome("auth_expired", tag, "The connection needs reconnecting in Settings › Integrations before Atlas can post.", "auth");
  }
  if (CREDENTIAL_RESOURCE_CODES.has(code)) return attentionOutcome("no_resource", tag, "Choose which account Atlas posts to in Settings › Integrations, then approve the post again.");
  if (error?.retryable === true || CREDENTIAL_RETRY_CODES.has(code) || code === "refresh_failed") {
    return { status: "retrying", error: { class: "transient", code: tag, message: "The connection could not be opened; Atlas will try again." } };
  }
  if (code === "not_approved") return attentionOutcome("manual_hold", tag, "This post is no longer approved for publishing.");
  // not_connected, publishing_permission_missing, publishing_not_installed,
  // not_configured, provider_refused and anything unknown.
  return attentionOutcome("provider_not_ready", tag, "Publishing isn't allowed for this connection yet. Check Settings › Integrations.");
}

// ---- default RPC over PostgREST ---------------------------------------------------

function defaultRpc(readEnv, fetchImpl) {
  return async function rpc(name, payload) {
    const base = String(readEnv("SUPABASE_URL") ?? "").replace(/\/+$/, "");
    const key = String(readEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    if (!base || !key) throw new Error("rpc_not_configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json", "cache-control": "no-store" },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: "manual",
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error("rpc_failed");
        error.status = response.status;
        throw error;
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---- the handler --------------------------------------------------------------------

export function createPublisherHandler({ env, fetchImpl, rpc, now = () => Date.now(), random = Math.random, credentials, sleep, adapters = ADAPTERS } = {}) {
  const readEnv = envReader(env);
  const fetcher = fetchImpl ?? ((input, init) => fetch(input, init));
  const callRpc = rpc ?? defaultRpc(readEnv, fetcher);
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const serviceKey = String(readEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  function workerId() {
    let hex = "";
    for (let index = 0; index < 4; index += 1) hex += Math.floor(random() * 0x10000).toString(16).padStart(4, "0");
    return `publisher-${hex}`;
  }

  async function runDelivery(claim, counts, budget) {
    const d = normalizeClaim(claim);
    if (!d.id || !d.claim_token) return;
    const lease = { until: Date.parse(d.lease_until ?? "") || now() + LEASE_SECONDS * 1000 };
    const secrets = [serviceKey];
    let submitted = false;
    let uploadStartedAt = null;
    let providerOutcome = false;

    const fenced = (result) => {
      if (!result || result.lease_lost === true || result.ok === false) throw new LeaseLostError();
      if (result.lease_until) lease.until = Date.parse(result.lease_until) || lease.until;
      return result;
    };

    const http = createHttp({ fetchImpl: fetcher, supabaseUrl: readEnv("SUPABASE_URL") });
    const ctx = {
      env: readEnv,
      http,
      now,
      sleep: wait,
      secrets,
      provider: d.provider_key,
      credential: null,
      mediaUrls: createMediaUrls({ http, supabaseUrl: readEnv("SUPABASE_URL"), serviceKey, now }),
      // Upload time counts from the upload's own start (startUpload), capped by
      // the invocation's wall budget; before it starts, this is what an upload
      // started now could get.
      timeLeftMs: ({ upload = false } = {}) => (upload
        ? Math.min((uploadStartedAt ?? now()) + budget.uploadMs, budget.wallDeadline)
        : budget.deadline) - now(),
      uploadBudgetMs: budget.uploadMs,
      startUpload() {
        if (uploadStartedAt === null) uploadStartedAt = now();
      },
      async heartbeat({ force = false } = {}) {
        if (!force && lease.until - now() > HEARTBEAT_BELOW_MS) return;
        fenced(await callRpc(RPC.heartbeat, { p_delivery_id: d.id, p_claim_token: d.claim_token, p_seconds: LEASE_SECONDS }));
      },
      async recordStep(phase, ids = {}, step = {}) {
        const payload = {
          p_delivery_id: d.id,
          p_claim_token: d.claim_token,
          p_phase: phase ?? null,
          p_ids: cleanIds(ids, secrets),
          p_step: cleanStep(step, secrets),
        };
        fenced(await callRpc(RPC.recordStep, payload));
        if (ids.provider_container_id) d.container_id = ids.provider_container_id;
        if (ids.provider_publish_id) d.publish_id = ids.provider_publish_id;
        if (ids.progress) d.progress = { ...d.progress, ...ids.progress };
        if (phase) d.phase = phase;
      },
      async beginSubmit() {
        const result = await callRpc(RPC.beginSubmit, { p_delivery_id: d.id, p_claim_token: d.claim_token });
        if (result?.refused === true) throw new SubmitRefusedError(result.reason, result.status);
        fenced(result);
        submitted = true;
        d.phase = "submitting";
        d.submit_started_at = result.submit_started_at ?? new Date(now()).toISOString();
        return result;
      },
    };

    let outcome;
    try {
      const adapter = adapters[d.provider_key];
      const stale = Date.parse(d.latest_acceptable_at ?? "");
      if (!adapter) {
        outcome = attentionOutcome("provider_not_ready", "provider_unsupported", "Atlas cannot publish to this platform yet.");
      } else if (d.claim_kind === "publish" && Number.isFinite(stale) && now() > stale && !["submitting", "submitted"].includes(d.phase)) {
        // Stale guard (SQL enforces it at claim and begin_submit too).
        outcome = attentionOutcome("stale_schedule", "stale_schedule", "The planned time passed long ago, so Atlas did not post it.", "stale");
      } else {
        let credential;
        try {
          credential = await credentials.openPublishingCredential({ rpc: callRpc, env: readEnv, fetchImpl: fetcher, now }, { deliveryId: d.id, claimToken: d.claim_token });
        } catch (error) {
          const failure = credentialFailure(error);
          if (failure.leaseLost) throw new LeaseLostError();
          outcome = failure;
        }
        if (!outcome) {
          if (!credential?.access_token) {
            outcome = attentionOutcome("provider_not_ready", "credential_missing", "The connection has no usable access. Check Settings › Integrations.");
          } else if (credential.provider_key && credential.provider_key !== d.provider_key) {
            outcome = attentionOutcome("provider_not_ready", "credential_provider_mismatch", "The connection does not match this platform.");
          } else if (d.external_account_id && d.external_account_id !== "pending" && credential.resource?.id && String(credential.resource.id) !== d.external_account_id) {
            outcome = attentionOutcome("no_resource", "resource_changed", "The chosen account changed after approval. Approve the post again.");
          } else {
            secrets.push(String(credential.access_token));
            ctx.credential = credential;
            outcome = await adapter.publish(ctx, d);
            providerOutcome = true;
          }
        }
      }
    } catch (error) {
      if (error instanceof LeaseLostError) {
        counts.lease_lost += 1;
        return;
      }
      if (error instanceof SubmitRefusedError) {
        counts.refused += 1;
        return;
      }
      // Unexpected failure: after the marker the outcome is unknown.
      outcome = submitted
        ? { status: "verifying", error: { class: "uncertain", code: "worker_error", message: "The worker stopped unexpectedly after sending; Atlas will check the platform." } }
        : { status: "retrying", error: { class: "transient", code: "worker_error", message: "The worker stopped unexpectedly; Atlas will try again." } };
    }

    const cleaned = cleanOutcome(coerceForClaim(outcome, d.claim_kind), secrets);
    // The provider refused the connection itself: mark it "Needs reconnecting"
    // while this claim is still live (fenced in SQL). A failure here never
    // stops complete().
    if (providerOutcome && cleaned.error?.class === "auth" && ["needs_attention", "failed"].includes(cleaned.status)) {
      try {
        await callRpc(RPC.markAuthFailed, { p_delivery_id: d.id, p_claim_token: d.claim_token, p_error: cleaned.error.message || cleaned.error.code });
        counts.auth_marked = (counts.auth_marked ?? 0) + 1;
      } catch {
        counts.errors += 1;
      }
    }
    let result;
    try {
      result = await callRpc(RPC.complete, { p_delivery_id: d.id, p_claim_token: d.claim_token, p_outcome: cleaned });
    } catch {
      // The lease expires and SQL recovery decides (publishing+submitting -> verifying).
      counts.errors += 1;
      return;
    }
    if (!result || result.lease_lost === true || result.ok === false) {
      counts.lease_lost += 1;
      return;
    }
    const status = OUTCOME_STATUSES.has(result.status) ? result.status : cleaned.status;
    counts[status] = (counts[status] ?? 0) + 1;
    if (status === "published" || (status === "processing" && d.claim_kind === "publish")) await recordMediaUse(d, status, cleaned, counts);
  }

  // One publication-use row per media item that reached the platform, so the
  // library keeps it (delete/purge refused) even if the post is cancelled
  // after a partial publish. Ids only, never a URL.
  async function recordMediaUse(d, status, cleaned, counts) {
    if (!d.content_id) return;
    const postId = status === "published" ? cleaned.post_id : (cleaned.ids?.provider_publish_id ?? cleaned.ids?.provider_container_id ?? d.publish_id ?? d.container_id);
    for (const item of d.payload.media) {
      if (!item?.asset_id || item.role === "thumbnail") continue;
      try {
        await callRpc(RPC.recordUse, {
          p_use: {
            asset_id: String(item.asset_id),
            variant_id: item.variant_id ? String(item.variant_id) : null,
            content_id: d.content_id,
            publication_job_id: d.id,
            platform: d.provider_key,
            fetch_method: d.provider_key === "tiktok" ? "file_upload" : "signed_url",
            provider_media_id: postId ? String(postId).slice(0, 200) : null,
            outcome: status,
          },
        });
        counts.media_uses = (counts.media_uses ?? 0) + 1;
      } catch {
        counts.errors += 1;
      }
    }
  }

  async function tick() {
    const started = now();
    const budget = {
      deadline: started + clampInt(readEnv("ATLAS_PUBLISHER_BUDGET_MS"), DEFAULT_BUDGET_MS, 5_000, 120_000),
      uploadMs: clampInt(readEnv("ATLAS_PUBLISHER_UPLOAD_BUDGET_MS"), DEFAULT_UPLOAD_BUDGET_MS, 30_000, 300_000),
      wallDeadline: started + clampInt(readEnv("ATLAS_PUBLISHER_WALL_BUDGET_MS"), DEFAULT_WALL_BUDGET_MS, 60_000, 380_000),
    };
    const counts = { claimed: 0, published: 0, processing: 0, retrying: 0, verifying: 0, needs_attention: 0, failed: 0, refused: 0, lease_lost: 0, errors: 0 };
    const id = workerId();
    for (let batch = 0; batch < MAX_BATCHES && now() < budget.deadline - STOP_CLAIMING_BEFORE_MS; batch += 1) {
      let claims;
      try {
        claims = await callRpc(RPC.claim, { p_worker_id: id, p_limit: CLAIM_LIMIT, p_lease_seconds: LEASE_SECONDS });
      } catch {
        counts.errors += 1;
        break;
      }
      const list = Array.isArray(claims) ? claims : Array.isArray(claims?.claims) ? claims.claims : [];
      if (!list.length) break;
      counts.claimed += list.length;
      // Sequential per provider account (GBP: 10 edits/min per location;
      // TikTok/IG per-token limits); accounts run in parallel.
      const groups = new Map();
      for (const claim of list) {
        const key = `${claim?.delivery?.provider_key ?? ""}|${claim?.delivery?.external_account_id ?? ""}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(claim);
      }
      await Promise.all([...groups.values()].map(async (group) => {
        for (const claim of group) await runDelivery(claim, counts, budget);
      }));
    }
    return counts;
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") ?? "tick";
    if (request.method !== "POST" || !["tick", "kick"].includes(action)) return json(404, { error: "not_found" });
    const expected = readEnv("ATLAS_MARKETING_PUBLISHER_SECRET");
    const next = readEnv("ATLAS_MARKETING_PUBLISHER_SECRET_NEXT");
    if (!secretConfigured(expected)) return json(503, { error: "not_configured" });
    const provided = request.headers.get(SECRET_HEADER) ?? "";
    const matches = await secretMatches(provided, expected);
    const matchesNext = secretConfigured(next) ? await secretMatches(provided, next) : false;
    if (!provided || !(matches || matchesNext)) return json(401, { error: "unauthorized" });
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return json(413, { error: "too_large" });
    const body = await request.text().catch(() => "");
    if (body.length > MAX_BODY_BYTES) return json(413, { error: "too_large" });
    if (String(readEnv("ATLAS_MARKETING_PUBLISHER_ENABLED") ?? "true").toLowerCase() === "false") return json(200, { ok: true, disabled: true });
    if (!credentials || typeof credentials.openPublishingCredential !== "function") return json(503, { error: "not_configured" });
    try {
      const counts = await tick();
      return json(200, { ok: true, ...counts });
    } catch {
      return json(500, { error: "worker_error" });
    }
  };
}
