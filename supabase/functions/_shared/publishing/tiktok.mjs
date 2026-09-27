// S94C TikTok adapter (Content Posting API, open.tiktokapis.com/v2).
//
// Target kinds:
//   tiktok_inbox_video  POST /v2/post/publish/inbox/video/init/ (scope video.upload):
//                       the video lands in the creator's TikTok inbox; they finish
//                       the post in the TikTok app. Body shape UNVERIFIED (report 05 §3).
//   tiktok_video        Direct Post (scope video.publish; audit needed for public
//                       posts): creator_info first, then POST /v2/post/publish/video/init/.
// Media goes by FILE_UPLOAD from the worker (PULL_FROM_URL needs a verified
// domain, which *.supabase.co cannot be): chunks are read from Storage with
// ranged reads and PUT to the returned upload_url (host checked against the
// allowlist first). Chunk rules [V]: 5-64 MB per chunk, final chunk may be up
// to 128 MB, total_chunk_count = floor(size / chunk_size), a video under 5 MB
// is sent whole; chunks sequential; upload_url valid 1 h. The upload_url is a
// bearer URL: it is never stored, so an upload runs within one invocation
// (heartbeats keep the lease). A cut-off upload never re-inits: the status
// poll reports FAILED and the delivery goes to a human.
//
// Idempotency (report 07 §4.2): init creates the post. begin_submit is
// committed before init; publish_id is persisted immediately after. A lost
// init response has no lookup (no video.list scope is requested), so the
// verify step goes straight to needs_attention(outcome_unknown). Atlas
// never re-inits after the submit marker.
//
// Status (POST /v2/post/publish/status/fetch/, 30/min per token [V]):
// PROCESSING_UPLOAD | PROCESSING_DOWNLOAD | SEND_TO_USER_INBOX | PUBLISH_COMPLETE |
// FAILED (names UNVERIFIED except FAILED); publicaly_available_post_id [V, sic].
// Poll cadence 30 s, 1, 2, 5, 10, 15 min, then every 15 min; give up at 24 h.

import { assertProviderUploadUrl } from "./http.mjs";
import { attentionOutcome, cadence, failedOutcome, mediaFailureOutcome, outcomeFor, providerRequest } from "./classify.mjs";

const API = "https://open.tiktokapis.com/v2";
const MIN_CHUNK = 5 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;
const DEFAULT_CHUNK = 16 * 1024 * 1024;
const POLL_CADENCE_S = [30, 60, 120, 300, 600, 900];
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
const CHUNK_RETRIES = 2;
const PRIVACY_LEVELS = new Set(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]);
const MEDIA_FAIL_REASONS = new Set(["file_format_check_failed", "duration_check_failed", "frame_rate_check_failed", "picture_size_check_failed", "video_size_check_failed"]);

const isVideo = (item) => /^video\//.test(String(item?.mime_type ?? ""));

function headers(ctx) {
  return { authorization: `Bearer ${ctx.credential.access_token}`, "content-type": "application/json; charset=UTF-8", accept: "application/json" };
}

function post(ctx, path, body, options = {}) {
  return providerRequest(ctx, "tiktok", `${API}${path}`, { method: "POST", headers: headers(ctx), body: JSON.stringify(body) }, options);
}

function chunkSize(ctx) {
  const raw = Number(typeof ctx.env === "function" ? ctx.env("ATLAS_PUBLISHER_TIKTOK_CHUNK_BYTES") : undefined);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CHUNK;
  return Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Math.floor(raw)));
}

// Time an upload must be able to get before TikTok's init is sent.
export const UPLOAD_MIN_START_MS = 60_000;

// Upload plan per TikTok's FILE_UPLOAD rules.
export function uploadPlan(size, preferredChunk = DEFAULT_CHUNK) {
  const total = Math.floor(Number(size));
  if (!Number.isFinite(total) || total <= 0) return null;
  const chunk = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, preferredChunk));
  if (total <= chunk) return { video_size: total, chunk_size: total, total_chunk_count: 1, ranges: [[0, total - 1]] };
  const count = Math.floor(total / chunk);
  const ranges = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * chunk;
    const end = index === count - 1 ? total - 1 : start + chunk - 1;
    ranges.push([start, end]);
  }
  // Final chunk absorbs the remainder (≤ 2 × chunk ≤ 128 MB).
  return { video_size: total, chunk_size: chunk, total_chunk_count: count, ranges };
}

export function tiktokOptions(options) {
  const nested = options?.tiktok;
  if (nested && typeof nested === "object") return nested;
  return options && typeof options === "object" ? options : {};
}

async function creatorInfo(ctx) {
  const r = await post(ctx, "/post/publish/creator_info/query/", {});
  if (!r.ok) return { fail: r.outcome };
  return { info: r.res.json?.data ?? {} };
}

// Direct Post checks against fresh creator_info (TikTok UX rules, report 05 §8).
function directPostInfo(d, info, opts) {
  const options = Array.isArray(info.privacy_level_options) ? info.privacy_level_options.map(String) : [];
  const privacy = String(opts.privacy_level ?? "");
  if (!PRIVACY_LEVELS.has(privacy)) return { fail: attentionOutcome("provider_rejected", "tiktok_privacy_missing", "Choose who can see this TikTok video before it can be posted.") };
  if (!options.includes(privacy)) {
    const privateOnly = options.length > 0 && options.every((value) => value === "SELF_ONLY");
    return {
      fail: attentionOutcome(
        "provider_rejected",
        privateOnly ? "tiktok_private_only" : "tiktok_privacy_not_allowed",
        privateOnly
          ? "Until TikTok approves Atlas, TikTok posts can only be private (Only me). Change who can see it, or post it by hand."
          : "TikTok no longer offers the chosen privacy option for this account. Choose it again.",
      ),
    };
  }
  if (opts.brand_content_toggle === true && privacy === "SELF_ONLY") {
    return { fail: attentionOutcome("provider_rejected", "tiktok_branded_private", "Branded content can't be private on TikTok.") };
  }
  if (!opts.consent_confirmed_at) {
    return { fail: attentionOutcome("provider_rejected", "tiktok_consent_missing", "TikTok posting needs the music-usage consent confirmed in Atlas first.") };
  }
  const maxSec = Number(info.max_video_post_duration_sec);
  const video = (d.payload.media ?? []).find(isVideo);
  if (Number.isFinite(maxSec) && maxSec > 0 && video && Number(video.duration_ms) > maxSec * 1000) {
    return { fail: failedOutcome("media_invalid", "tiktok_video_too_long", `This TikTok account can post videos up to ${Math.floor(maxSec / 60)} min ${maxSec % 60} s.`) };
  }
  return {
    post_info: {
      title: String(d.payload.caption ?? ""),
      privacy_level: privacy,
      // Interactions are off unless chosen, and off when the creator disabled them.
      disable_comment: info.comment_disabled === true || opts.disable_comment !== false,
      disable_duet: info.duet_disabled === true || opts.disable_duet !== false,
      disable_stitch: info.stitch_disabled === true || opts.disable_stitch !== false,
      // Commercial-content toggle names UNVERIFIED (report 05 §3).
      brand_content_toggle: opts.brand_content_toggle === true,
      brand_organic_toggle: opts.brand_organic_toggle === true,
    },
  };
}

async function uploadChunks(ctx, video, plan, uploadUrl) {
  let target;
  try {
    target = assertProviderUploadUrl(uploadUrl, "tiktok").href;
  } catch {
    return { ok: false, code: "upload_url_rejected" };
  }
  // The upload budget counts from here, not from the start of the tick.
  ctx.startUpload?.();
  for (let index = 0; index < plan.ranges.length; index += 1) {
    const [start, end] = plan.ranges[index];
    if (ctx.timeLeftMs({ upload: true }) < 20_000) return { ok: false, code: "upload_budget_exhausted" };
    await ctx.heartbeat();
    let bytes;
    try {
      bytes = await ctx.mediaUrls.readRange(video.storage_path, start, end);
    } catch (error) {
      return { ok: false, code: error?.code || "storage_read_failed" };
    }
    let sent = false;
    for (let attempt = 0; attempt <= CHUNK_RETRIES && !sent; attempt += 1) {
      // Re-PUT of the same chunk to the same upload_url is safe (report 05 §11).
      const r = await providerRequest(ctx, "tiktok", target, {
        method: "PUT",
        headers: {
          "content-type": String(video.mime_type || "video/mp4"),
          "content-length": String(bytes.length),
          "content-range": `bytes ${start}-${end}/${plan.video_size}`,
        },
        body: bytes,
        timeoutMs: 90_000,
        upload: true,
      });
      sent = r.ok;
    }
    bytes = null;
    if (!sent) return { ok: false, code: "chunk_upload_failed" };
    await ctx.recordStep(null, { progress: { uploaded_chunks: index + 1, total_chunks: plan.total_chunk_count } }, { step: "chunk_uploaded", detail: `chunk=${index + 1}/${plan.total_chunk_count}` });
  }
  return { ok: true };
}

async function startPublish(ctx, d) {
  const video = (d.payload.media ?? []).filter((item) => item.role !== "thumbnail");
  if (video.length !== 1 || !isVideo(video[0])) return failedOutcome("media_invalid", "tiktok_one_video", "TikTok posts from Atlas need exactly one video.");
  const item = video[0];
  const plan = uploadPlan(item.byte_size, chunkSize(ctx));
  if (!plan) return failedOutcome("media_invalid", "tiktok_video_size_unknown", "The video size is unknown.");
  const opts = tiktokOptions(d.payload.options);
  let body;
  let path;
  if (d.target_kind === "tiktok_video") {
    const ci = await creatorInfo(ctx);
    if (ci.fail) return ci.fail;
    const checked = directPostInfo(d, ci.info, opts);
    if (checked.fail) return checked.fail;
    await ctx.recordStep(null, {}, { step: "creator_info", detail: `privacy=${checked.post_info.privacy_level}` });
    body = { post_info: checked.post_info, source_info: { source: "FILE_UPLOAD", video_size: plan.video_size, chunk_size: plan.chunk_size, total_chunk_count: plan.total_chunk_count } };
    path = "/post/publish/video/init/";
  } else if (d.target_kind === "tiktok_inbox_video") {
    body = { source_info: { source: "FILE_UPLOAD", video_size: plan.video_size, chunk_size: plan.chunk_size, total_chunk_count: plan.total_chunk_count } };
    path = "/post/publish/inbox/video/init/";
  } else {
    return failedOutcome("provider_rejected", "tiktok_target_unsupported", "This TikTok format is not supported yet.");
  }
  // Storage must answer before the non-idempotent init: a missing object is a
  // safe failure now, and an unexpected one after init.
  try {
    await ctx.mediaUrls.readRange(item.storage_path, 0, 0);
  } catch (error) {
    return mediaFailureOutcome(error);
  }
  // A large upload is only started when this invocation can still give it a
  // useful share of the upload budget: an init whose upload is cut short
  // leaves TikTok with a broken post. Before the marker nothing was sent, so
  // the delivery simply retries in a fresh invocation.
  const needed = Math.min(UPLOAD_MIN_START_MS, 20_000 + plan.total_chunk_count * 20_000, Number(ctx.uploadBudgetMs) || Infinity);
  if (typeof ctx.timeLeftMs === "function" && ctx.timeLeftMs({ upload: true }) < needed) {
    return { status: "retrying", retry_after_s: 5, error: { class: "transient", code: "upload_deferred", message: "Not enough time left in this run to upload the video; Atlas will try again right away." } };
  }
  await ctx.beginSubmit();
  const init = await post(ctx, path, body, { afterSubmit: true });
  if (!init.ok) {
    // A lost init is never retried (TikTok has no lookup for it).
    if (init.outcome.status === "verifying") return attentionOutcome("outcome_unknown", init.classified?.code ?? "tiktok_init_unknown", "Atlas could not confirm whether TikTok received this video. Check TikTok before trying again.", "uncertain");
    return init.outcome;
  }
  const publishId = String(init.res.json?.data?.publish_id ?? "");
  const uploadUrl = init.res.json?.data?.upload_url;
  if (!publishId || publishId.length > 200) return attentionOutcome("outcome_unknown", "tiktok_no_publish_id", "TikTok accepted the request but returned no id.", "uncertain");
  await ctx.recordStep("submitted", { provider_publish_id: publishId, progress: { uploaded_chunks: 0, total_chunks: plan.total_chunk_count } }, { step: "init", http_status: init.res.status });
  const uploaded = await uploadChunks(ctx, item, plan, uploadUrl);
  if (!uploaded.ok) {
    await ctx.recordStep(null, {}, { step: "upload_stopped", code: uploaded.code });
    if (uploaded.code === "upload_url_rejected") return attentionOutcome("provider_rejected", "upload_url_rejected", "TikTok returned an upload address Atlas does not trust. Nothing was uploaded.");
  }
  await ctx.recordStep("remote_processing", {}, { step: "uploaded" });
  return { status: "processing", ids: {}, poll_after_s: cadence(POLL_CADENCE_S, 0) };
}

async function pollStatus(ctx, d) {
  const r = await post(ctx, "/post/publish/status/fetch/", { publish_id: d.publish_id });
  const started = Date.parse(d.submit_started_at ?? "");
  const tooOld = Number.isFinite(started) && ctx.now() - started > GIVE_UP_MS;
  if (!r.ok) {
    if (r.classified?.definitive && (r.classified.class === "auth" || r.classified.class === "policy")) return outcomeFor(r.classified, { afterSubmit: true });
    if (tooOld) return attentionOutcome("outcome_unknown", "tiktok_status_timeout", "TikTok did not confirm this post within a day.", "uncertain");
    const out = { status: "processing", ids: {}, poll_after_s: cadence(POLL_CADENCE_S, d.poll_count) };
    if (r.classified?.class === "rate_limited" && r.classified.retry_after_s) out.poll_after_s = Math.max(out.poll_after_s, r.classified.retry_after_s);
    return out;
  }
  const data = r.res.json?.data ?? {};
  const status = String(data.status ?? "").toUpperCase();
  await ctx.recordStep(null, {}, { step: "status", poll_status: status || "UNKNOWN" });
  const ids = Array.isArray(data.publicaly_available_post_id) ? data.publicaly_available_post_id.map(String).filter(Boolean) : [];
  if (status === "PUBLISH_COMPLETE" || (status === "SEND_TO_USER_INBOX" && d.target_kind === "tiktok_inbox_video")) {
    // SELF_ONLY and inbox posts never get a public id (UNVERIFIED): the
    // publish_id stands in as the provider id; there is no public permalink.
    return { status: "published", post_id: ids[0] ?? d.publish_id, permalink: null, published_at: new Date(ctx.now()).toISOString(), source: "provider" };
  }
  if (status === "FAILED") {
    const reason = String(data.fail_reason ?? "unknown").slice(0, 60);
    if (MEDIA_FAIL_REASONS.has(reason)) return failedOutcome("media_invalid", `tiktok_${reason}`, "TikTok could not use this video.");
    return attentionOutcome("provider_rejected", `tiktok_failed_${reason}`, "TikTok did not publish this video. Check TikTok, then retry or post it by hand.");
  }
  if (tooOld) return attentionOutcome("outcome_unknown", "tiktok_status_timeout", "TikTok did not confirm this post within a day.", "uncertain");
  return { status: "processing", ids: {}, poll_after_s: cadence(POLL_CADENCE_S, d.poll_count) };
}

export async function publish(ctx, d) {
  if (d.post_id) return { status: "published", post_id: d.post_id, permalink: d.permalink ?? null, source: "provider" };
  if (d.publish_id) return pollStatus(ctx, d);
  // A verify claim without publish_id means the init response was lost. (A
  // publish claim after the marker exists only after a manager attested that
  // nothing was posted, so it may init again.)
  if (d.claim_kind === "verify") {
    // Init may have created a post; TikTok offers no lookup without video.list.
    return attentionOutcome("outcome_unknown", "tiktok_init_outcome_unknown", "Atlas could not confirm whether TikTok received this video. Check TikTok before trying again.", "uncertain");
  }
  return startPublish(ctx, d);
}
