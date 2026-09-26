// S94C: provider error classification and outcome mapping (report 07 §5.1).
//
// classifyResponse(provider, res, { afterSubmit, secrets, nowMs }) turns an
// HTTP response (status + parsed body) into
//   { class, code, message, definitive, retry_after_s, http_status }
// classifyFailure(error, ...) does the same for a thrown HttpError
// (network, timeout, blocked). outcomeFor(classified, { afterSubmit })
// turns a classification into the complete() outcome.
//
// Classes: transient, rate_limited, auth, permanent, uncertain, stale, policy.
// Rules (binding):
//   before the submit marker: transient -> retrying; rate_limited -> retrying
//     with cooldown; auth -> needs_attention(auth_expired); permanent ->
//     failed(provider_rejected|media_invalid); policy -> needs_attention.
//   after the marker: only a DEFINITIVE provider rejection (a 4xx with a
//     well-formed provider error body) may become retrying/failed/
//     needs_attention; everything else (5xx, timeout, reset, unparseable
//     body) is uncertain -> verifying. Never a blind retry.
// Unknown error shapes default to the safer class: transient before the
// marker, uncertain after it.
//
// Provider codes below are from reports 04-06; most are UNVERIFIED on the
// providers' own pages (blocked in research) and must be rechecked (§12).

import { sanitizeMessage, retryAfterSeconds } from "./http.mjs";

// Meta Graph codes. 4/17/32/613 and the 8000x business-use-case range are
// rate limits ([S] for 4, 32, 80001; others UNVERIFIED). 190/102 auth
// (UNVERIFIED, well known); 10 and 200-299 permission (200 [S], 10
// UNVERIFIED). 1/2 transient (UNVERIFIED). 9007 / subcode 2207027 "media not
// ready" (UNVERIFIED). IG publishing limit: code 9 / subcode 2207042 (UNVERIFIED).
const META_RATE_CODES = new Set([4, 17, 32, 613]);
const META_AUTH_CODES = new Set([190, 102, 10]);
const META_TRANSIENT_CODES = new Set([1, 2]);
const META_MEDIA_CODES = new Set([9004, 36000, 36001, 36003, 36004]);
const META_MEDIA_SUBCODES = new Set([2207026, 2207052, 2207004, 2207005, 2207009, 2207010, 2207023, 2207050]);
const META_NOT_READY_SUBCODES = new Set([2207027]);

// TikTok v2 error.code strings (report 05 §12; UNVERIFIED except
// rate_limit_exceeded and the error envelope shape).
const TIKTOK_AUTH = new Set(["access_token_invalid", "scope_not_authorized", "scope_permission_missed", "token_not_authorized_for_specified_url"]);
const TIKTOK_RATE = new Set(["rate_limit_exceeded"]);
const TIKTOK_MEDIA = new Set(["file_format_check_failed", "duration_check_failed", "frame_rate_check_failed", "picture_size_check_failed", "video_size_check_failed"]);
const TIKTOK_POLICY = new Set([
  "spam_risk_too_many_posts",
  "spam_risk_user_banned_from_posting",
  "spam_risk_too_many_pending_share",
  "spam_risk",
  "spam_risk_text",
  "reached_active_user_cap",
  "unaudited_client_can_only_post_to_private_accounts",
  "privacy_level_option_mismatch",
  "url_ownership_unverified",
]);
const TIKTOK_TRANSIENT = new Set(["internal_error", "internal"]);

function withText(classified, text, secrets) {
  return { ...classified, message: sanitizeMessage(text, secrets) };
}

function metaClassify(status, body) {
  const error = body && typeof body === "object" ? body.error : null;
  if (!error || typeof error !== "object") return null;
  const code = Number(error.code);
  const sub = Number(error.error_subcode);
  const text = error.error_user_msg || error.message || "";
  const tag = `meta_${Number.isFinite(code) ? code : "error"}${Number.isFinite(sub) ? `_${sub}` : ""}`;
  if (META_NOT_READY_SUBCODES.has(sub) || code === 9007) return { class: "transient", code: "media_not_ready", text, notReady: true };
  if (META_RATE_CODES.has(code) || (code >= 80000 && code <= 80099) || sub === 2207042 || (code === 9 && sub === 2207042)) {
    return { class: "rate_limited", code: tag, text };
  }
  if (META_AUTH_CODES.has(code) || (code >= 200 && code <= 299) || error.type === "OAuthException" && code === 190) {
    return { class: "auth", code: tag, text };
  }
  if (error.is_transient === true || META_TRANSIENT_CODES.has(code)) return { class: "transient", code: tag, text };
  if (META_MEDIA_CODES.has(code) || META_MEDIA_SUBCODES.has(sub)) return { class: "permanent", code: tag, text, attention: "media_invalid" };
  if (code === 368) return { class: "permanent", code: tag, text, attention: "provider_rejected" };
  if (status >= 500) return { class: "transient", code: tag, text };
  return { class: "permanent", code: tag, text, attention: "provider_rejected" };
}

function tiktokClassify(status, body) {
  const error = body && typeof body === "object" ? body.error : null;
  if (!error || typeof error !== "object" || typeof error.code !== "string") return null;
  const code = error.code;
  if (code === "ok") return null;
  const text = error.message || "";
  const tag = `tiktok_${code}`.slice(0, 80);
  if (TIKTOK_AUTH.has(code)) return { class: "auth", code: tag, text };
  if (TIKTOK_RATE.has(code)) return { class: "rate_limited", code: tag, text };
  if (TIKTOK_MEDIA.has(code)) return { class: "permanent", code: tag, text, attention: "media_invalid" };
  if (TIKTOK_POLICY.has(code)) return { class: "policy", code: tag, text, attention: "provider_rejected" };
  if (TIKTOK_TRANSIENT.has(code) || status >= 500) return { class: "transient", code: tag, text };
  return { class: "permanent", code: tag, text, attention: "provider_rejected" };
}

function googleClassify(status, body) {
  const error = body && typeof body === "object" ? body.error : null;
  if (!error || typeof error !== "object") return null;
  const grpc = String(error.status || "");
  const text = error.message || "";
  const tag = `google_${grpc || status}`.toLowerCase().slice(0, 80);
  if (status === 401 || grpc === "UNAUTHENTICATED") return { class: "auth", code: tag, text };
  if (status === 429 || grpc === "RESOURCE_EXHAUSTED") return { class: "rate_limited", code: tag, text };
  if (status === 403 || grpc === "PERMISSION_DENIED") return { class: "policy", code: tag, text, attention: "provider_rejected" };
  if (status === 404 || grpc === "NOT_FOUND") return { class: "policy", code: tag, text, attention: "no_resource" };
  if (status >= 500 || grpc === "UNAVAILABLE" || grpc === "DEADLINE_EXCEEDED" || grpc === "INTERNAL") return { class: "transient", code: tag, text };
  if (status === 409 || grpc === "FAILED_PRECONDITION") return { class: "policy", code: tag, text, attention: "provider_rejected" };
  return { class: "permanent", code: tag, text, attention: "provider_rejected" };
}

const PROVIDER_CLASSIFIERS = {
  instagram: metaClassify,
  facebook: metaClassify,
  meta: metaClassify,
  tiktok: tiktokClassify,
  "google-business-profile": googleClassify,
  google: googleClassify,
};

// res: { status, json, text, header(name) } from http.request().
export function classifyResponse(provider, res, { afterSubmit = false, secrets = [], nowMs } = {}) {
  const status = Number(res?.status) || 0;
  const body = res?.json ?? null;
  const parsed = (PROVIDER_CLASSIFIERS[provider] ?? (() => null))(status, body);
  const retryAfter = retryAfterSeconds(res?.header?.("retry-after"), nowMs);
  // A 4xx with a well-formed provider error body is a definitive rejection:
  // the provider refused the request, so nothing was created.
  const definitive = Boolean(parsed) && status >= 400 && status < 500;
  let result;
  if (parsed) {
    result = { class: parsed.class, code: parsed.code, attention: parsed.attention ?? null, notReady: Boolean(parsed.notReady), text: parsed.text };
  } else if (status === 429) {
    result = { class: "rate_limited", code: "http_429", attention: null, text: "" };
  } else if (status === 401) {
    result = { class: "auth", code: "http_401", attention: null, text: "" };
  } else if (status >= 500 || status === 408 || status === 0) {
    result = { class: "transient", code: `http_${status}`, attention: null, text: "" };
  } else {
    // Unknown shape: the safer class.
    result = { class: afterSubmit ? "uncertain" : "transient", code: `http_${status}`, attention: null, text: "" };
  }
  if (status === 429 && result.class !== "rate_limited") result.class = "rate_limited";
  return withText(
    { class: result.class, code: result.code, attention: result.attention, notReady: result.notReady ?? false, definitive: definitive || (status === 429 && Boolean(parsed)), retry_after_s: retryAfter, http_status: status },
    result.text || `${provider} request failed (${status || "no status"})`,
    secrets,
  );
}

// A thrown HttpError (or anything else): never definitive.
export function classifyFailure(error, { afterSubmit = false } = {}) {
  if (error?.blocked) return { class: "permanent", code: "blocked_host", attention: "provider_rejected", definitive: true, retry_after_s: null, http_status: 0, message: "A provider address was refused by the worker's allowlist." };
  if (error?.redirect) return { class: afterSubmit ? "uncertain" : "transient", code: "redirect_refused", attention: null, definitive: false, retry_after_s: null, http_status: error.status ?? 0, message: "The provider answered with a redirect, which the worker does not follow." };
  const timeout = Boolean(error?.timeout);
  return {
    class: afterSubmit ? "uncertain" : "transient",
    code: timeout ? "timeout" : "network_error",
    attention: null,
    definitive: false,
    retry_after_s: null,
    http_status: 0,
    message: timeout ? "The provider did not answer in time." : "The provider could not be reached.",
  };
}

function errorOf(c) {
  return { class: c.class, code: String(c.code ?? "error").slice(0, 80), message: String(c.message ?? "").slice(0, 240) };
}

// complete() outcome for a classified failure.
export function outcomeFor(c, { afterSubmit = false } = {}) {
  const error = errorOf(c);
  if (afterSubmit && !c.definitive) {
    return { status: "verifying", error: { ...error, class: "uncertain" } };
  }
  const out = outcomeByClass(c, error, afterSubmit);
  // After the marker, a definitive rejection is flagged so complete() may
  // accept `retrying` (the provider proved nothing was created).
  if (afterSubmit && c.definitive) out.definitive = true;
  return out;
}

function outcomeByClass(c, error, afterSubmit) {
  switch (c.class) {
    case "rate_limited": {
      const out = { status: "retrying", error };
      if (c.retry_after_s !== null && c.retry_after_s !== undefined) out.retry_after_s = c.retry_after_s;
      out.cooldown_s = Math.max(60, Number(c.retry_after_s) || 0);
      return out;
    }
    case "auth":
      return { status: "needs_attention", error, attention_reason: "auth_expired" };
    case "permanent":
      return { status: "failed", error, attention_reason: c.attention || "provider_rejected" };
    case "policy":
      return { status: "needs_attention", error, attention_reason: c.attention || "provider_rejected" };
    case "stale":
      return { status: "needs_attention", error, attention_reason: "stale_schedule" };
    case "uncertain":
      return afterSubmit ? { status: "verifying", error } : { status: "retrying", error: { ...error, class: "transient" } };
    case "transient":
    default:
      return afterSubmit ? { status: "verifying", error: { ...error, class: "uncertain" } } : { status: "retrying", error: { ...error, class: "transient" } };
  }
}

export function attentionOutcome(reason, code, message, errorClass = "policy") {
  return { status: "needs_attention", attention_reason: reason, error: { class: errorClass, code: String(code).slice(0, 80), message: String(message).slice(0, 240) } };
}

export function failedOutcome(reason, code, message) {
  return { status: "failed", attention_reason: reason, error: { class: "permanent", code: String(code).slice(0, 80), message: String(message).slice(0, 240) } };
}

// ---- worker control flow ---------------------------------------------------

// The claim was lost (fenced RPC answered lease_lost): stop touching the row.
export class LeaseLostError extends Error {
  constructor() {
    super("lease_lost");
    this.name = "LeaseLostError";
  }
}

// begin_submit refused (cancel requested, edited, stale, disabled, not ready,
// rate budget). The RPC already moved the row and released the claim: the
// worker makes no provider call and does not call complete.
export class SubmitRefusedError extends Error {
  constructor(reason, status) {
    super(`submit_refused:${reason}`);
    this.name = "SubmitRefusedError";
    this.reason = String(reason ?? "refused");
    this.status = status ?? null;
  }
}

function providerBodyError(provider, res) {
  // TikTok v2 answers {error:{code:"ok"}} on success; anything else is an error
  // even with a 2xx status.
  if (provider === "tiktok") {
    const code = res.json?.error?.code;
    return typeof code === "string" && code !== "ok";
  }
  return false;
}

// One provider request through the allowlisted client, classified.
// -> { ok: true, res } | { ok: false, outcome, classified, res? }
export async function providerRequest(ctx, provider, url, init = {}, { afterSubmit = false } = {}) {
  let res;
  try {
    res = await ctx.http.request(url, init);
  } catch (error) {
    const classified = classifyFailure(error, { afterSubmit });
    return { ok: false, classified, outcome: outcomeFor(classified, { afterSubmit }) };
  }
  if (res.ok && !providerBodyError(provider, res)) return { ok: true, res };
  const classified = classifyResponse(provider, res, { afterSubmit, secrets: ctx.secrets ?? [], nowMs: ctx.now() });
  return { ok: false, res, classified, outcome: outcomeFor(classified, { afterSubmit }) };
}

// A Storage/media failure before the submit marker.
export function mediaFailureOutcome(error) {
  const code = error?.code || "media_error";
  if (error?.transient) return { status: "retrying", error: { class: "transient", code, message: String(error?.message ?? "Media storage failed.").slice(0, 240) } };
  return failedOutcome("media_invalid", code, error?.message || "A media file could not be used.");
}

// Next poll delay from a cadence list, by poll count.
export function cadence(list, count) {
  const index = Math.max(0, Math.min(list.length - 1, Number(count) || 0));
  return list[index];
}

export function normalizeCaption(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}
