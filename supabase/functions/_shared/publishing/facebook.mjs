// S94C Facebook Page adapter (graph.facebook.com, selected Page's token).
//
// Target kinds (report 04 §7):
//   fb_page_post   POST /{page-id}/feed message[, link]                         [S]
//   fb_page_photo  one photo: POST /{page-id}/photos url, message              (field names UNVERIFIED)
//                  several: POST /{page-id}/photos url, published=false per photo
//                  (harmless, ids persisted), then POST /{page-id}/feed
//                  message, attached_media[i]={"media_fbid":id}               [S]
//   fb_page_video  POST /{page-id}/videos file_url, description               [S] (≤1 GB, ≤20 min)
//   fb_reel        POST /{page-id}/video_reels upload_phase=start -> video_id (persisted);
//                  POST rupload.facebook.com/video-upload/{v}/{video_id} with header
//                  file_url (signed URL) (header names UNVERIFIED);
//                  begin_submit; POST /{page-id}/video_reels upload_phase=finish,
//                  video_id, video_state=PUBLISHED, description            (phases [S])
//
// Facebook has no idempotency key (report 07 §4.3). Every create that makes
// something public runs after begin_submit. An uncertain outcome is verified
// with GET /{page-id}/published_posts (fields UNVERIFIED) matched on the exact
// message and created_time: one match -> published; more than one ->
// needs_attention; none on two reads at least 2 minutes apart -> verified
// absent -> at most ONE automatic retry per delivery (progress.verify_retry_used),
// a second ambiguity -> needs_attention. ATLAS_PUBLISHER_FB_AUTO_RETRY=false turns
// the automatic retry off. Reels are not matched through published_posts:
// the video's own state is read, and an unconfirmed reel goes to a human.
// Page videos (fb_page_video) are never retried automatically either: a video
// can stay out of published_posts while Facebook processes it, so empty reads
// are not proof of absence; Atlas keeps checking, then asks a human.

import { assertProviderUploadUrl } from "./http.mjs";
import { attentionOutcome, cadence, failedOutcome, mediaFailureOutcome, normalizeCaption, outcomeFor, providerRequest } from "./classify.mjs";
import { graphGet, graphPost, graphVersion, httpsOrNull, isoOrNull } from "./meta.mjs";
import { URL_TTL_SECONDS } from "./media-urls.mjs";

const VERIFY_CADENCE_S = [120, 120, 300];
const MAX_VERIFIES = 3;
const ABSENT_READ_GAP_MS = 2 * 60 * 1000;
const MATCH_WINDOW_MS = 2 * 60 * 1000;

const isVideo = (item) => /^video\//.test(String(item?.mime_type ?? ""));
const items = (d) => (d.payload.media ?? []).filter((item) => item.role !== "thumbnail");
const idOk = (value) => /^[0-9_]{1,80}$/.test(String(value ?? ""));

function autoRetryEnabled(ctx) {
  const value = typeof ctx.env === "function" ? ctx.env("ATLAS_PUBLISHER_FB_AUTO_RETRY") : undefined;
  return String(value ?? "true").toLowerCase() !== "false";
}

async function sign(ctx, item) {
  return ctx.mediaUrls.sign(item.storage_path, URL_TTL_SECONDS.facebook);
}

async function permalinkFor(ctx, objectId) {
  const r = await graphGet(ctx, "facebook", objectId, { fields: "permalink_url,created_time" });
  if (!r.ok) return { permalink: null, published_at: null };
  return { permalink: httpsOrNull(r.res.json?.permalink_url), published_at: isoOrNull(r.res.json?.created_time) };
}

async function published(ctx, postId, source) {
  const meta = await permalinkFor(ctx, postId);
  return { status: "published", post_id: postId, permalink: meta.permalink, published_at: meta.published_at ?? new Date(ctx.now()).toISOString(), source };
}

async function afterCreate(ctx, r, postId) {
  if (!idOk(postId)) return { status: "verifying", error: { class: "uncertain", code: "fb_no_post_id", message: "Facebook accepted the post but returned no id." } };
  await ctx.recordStep("submitted", { provider_post_id: postId }, { step: "created", http_status: r.res.status });
  return published(ctx, postId, "provider");
}

async function ensureUnpublishedPhotos(ctx, d, pageId, photos) {
  const ids = Array.isArray(d.progress?.child_media_ids) ? [...d.progress.child_media_ids] : [];
  for (let index = 0; index < photos.length; index += 1) {
    if (ids[index]) continue;
    let signed;
    try {
      signed = await sign(ctx, photos[index]);
    } catch (error) {
      return { fail: mediaFailureOutcome(error) };
    }
    const r = await graphPost(ctx, "facebook", `${pageId}/photos`, { url: signed.url, published: "false" });
    if (!r.ok) return { fail: r.outcome };
    const id = String(r.res.json?.id ?? "");
    if (!idOk(id)) return { fail: { status: "retrying", error: { class: "transient", code: "fb_photo_no_id", message: "Facebook did not return a photo id." } } };
    ids[index] = id;
    await ctx.recordStep(null, { progress: { child_media_ids: ids } }, { step: "unpublished_photo", detail: `position=${index + 1};url_expires_at=${signed.expires_at}` });
    d.progress = { ...(d.progress ?? {}), child_media_ids: ids };
  }
  return { ids };
}

async function publishFeedOrPhoto(ctx, d, pageId) {
  const caption = String(d.payload.caption ?? "");
  const media = items(d);
  if (d.target_kind === "fb_page_post") {
    if (!caption.trim()) return failedOutcome("provider_rejected", "fb_empty_post", "Facebook needs text for a post without media.");
    const link = String(d.payload.options?.link ?? "");
    await ctx.beginSubmit();
    const r = await graphPost(ctx, "facebook", `${pageId}/feed`, { message: caption, link: /^https:\/\//.test(link) ? link : undefined }, { afterSubmit: true });
    if (!r.ok) return r.outcome;
    return afterCreate(ctx, r, String(r.res.json?.id ?? ""));
  }
  const photos = media.filter((item) => !isVideo(item));
  if (!photos.length || photos.length !== media.length) return failedOutcome("media_invalid", "fb_photo_media", "Facebook photo posts need photos only.");
  if (photos.length === 1) {
    let signed;
    try {
      signed = await sign(ctx, photos[0]);
    } catch (error) {
      return mediaFailureOutcome(error);
    }
    await ctx.beginSubmit();
    const r = await graphPost(ctx, "facebook", `${pageId}/photos`, { url: signed.url, message: caption, published: "true" }, { afterSubmit: true });
    if (!r.ok) return r.outcome;
    return afterCreate(ctx, r, String(r.res.json?.post_id ?? r.res.json?.id ?? ""));
  }
  const children = await ensureUnpublishedPhotos(ctx, d, pageId, photos);
  if (children.fail) return children.fail;
  const params = { message: caption };
  children.ids.forEach((id, index) => {
    params[`attached_media[${index}]`] = { media_fbid: id };
  });
  await ctx.beginSubmit();
  const r = await graphPost(ctx, "facebook", `${pageId}/feed`, params, { afterSubmit: true });
  if (!r.ok) return r.outcome;
  return afterCreate(ctx, r, String(r.res.json?.id ?? ""));
}

async function publishVideo(ctx, d, pageId) {
  const video = items(d).find(isVideo);
  if (!video) return failedOutcome("media_invalid", "fb_video_missing", "Facebook video posts need one video.");
  let signed;
  try {
    signed = await sign(ctx, video);
  } catch (error) {
    return mediaFailureOutcome(error);
  }
  await ctx.beginSubmit();
  const r = await graphPost(ctx, "facebook", `${pageId}/videos`, { file_url: signed.url, description: String(d.payload.caption ?? "") }, { afterSubmit: true, timeoutMs: 60_000 });
  if (!r.ok) return r.outcome;
  return afterCreate(ctx, r, String(r.res.json?.id ?? ""));
}

async function publishReel(ctx, d, pageId) {
  const video = items(d).find(isVideo);
  if (!video) return failedOutcome("media_invalid", "fb_video_missing", "Facebook Reels need one video.");
  let videoId = d.container_id;
  let uploadUrl = null;
  if (!videoId) {
    const start = await graphPost(ctx, "facebook", `${pageId}/video_reels`, { upload_phase: "start" });
    if (!start.ok) return start.outcome;
    videoId = String(start.res.json?.video_id ?? "");
    if (!idOk(videoId)) return { status: "retrying", error: { class: "transient", code: "fb_reel_no_video_id", message: "Facebook did not return a video id." } };
    uploadUrl = typeof start.res.json?.upload_url === "string" ? start.res.json.upload_url : null;
    await ctx.recordStep("container_created", { provider_container_id: videoId }, { step: "reel_started" });
  }
  if (!d.progress?.reel_uploaded) {
    let target;
    try {
      target = assertProviderUploadUrl(uploadUrl ?? `https://rupload.facebook.com/video-upload/${graphVersion(ctx.env)}/${videoId}`, "meta").href;
    } catch {
      return failedOutcome("provider_rejected", "upload_url_rejected", "Facebook returned an upload address Atlas does not trust.");
    }
    let signed;
    try {
      signed = await sign(ctx, video);
    } catch (error) {
      return mediaFailureOutcome(error);
    }
    await ctx.heartbeat();
    // Hosted-file upload: Meta fetches the signed URL (header name UNVERIFIED).
    const up = await providerRequest(ctx, "facebook", target, {
      method: "POST",
      headers: { authorization: `OAuth ${ctx.credential.access_token}`, file_url: signed.url },
      timeoutMs: 60_000,
      upload: true,
    });
    if (!up.ok) return up.outcome;
    await ctx.recordStep("media_ready", { progress: { reel_uploaded: true } }, { step: "reel_uploaded", http_status: up.res.status, detail: `url_expires_at=${signed.expires_at}` });
  }
  await ctx.beginSubmit();
  const fin = await graphPost(ctx, "facebook", `${pageId}/video_reels`, {
    upload_phase: "finish",
    video_id: videoId,
    video_state: "PUBLISHED",
    description: String(d.payload.caption ?? ""),
  }, { afterSubmit: true, timeoutMs: 60_000 });
  if (!fin.ok) return fin.outcome;
  if (fin.res.json?.success === false) return { status: "verifying", error: { class: "uncertain", code: "fb_reel_finish_unconfirmed", message: "Facebook did not confirm the Reel." } };
  await ctx.recordStep("submitted", { provider_post_id: videoId }, { step: "reel_finished", http_status: fin.res.status });
  // Reel permalink format UNVERIFIED; the video's permalink_url is preferred.
  const meta = await permalinkFor(ctx, videoId);
  return { status: "published", post_id: videoId, permalink: meta.permalink ?? `https://www.facebook.com/reel/${videoId}`, published_at: new Date(ctx.now()).toISOString(), source: "provider" };
}

function verifyAgain(d, code, message, pollAfter) {
  if ((Number(d.verify_attempts) || 0) >= MAX_VERIFIES) return attentionOutcome("outcome_unknown", code, message, "uncertain");
  return { status: "verifying", poll_after_s: pollAfter ?? cadence(VERIFY_CADENCE_S, d.verify_attempts), error: { class: "uncertain", code, message } };
}

async function verifyReel(ctx, d) {
  if (!d.container_id) return attentionOutcome("outcome_unknown", "fb_reel_unknown", "Atlas could not confirm whether Facebook published this Reel.", "uncertain");
  // Video fields `published` and `status` are UNVERIFIED for Reels.
  const r = await graphGet(ctx, "facebook", d.container_id, { fields: "published,status,permalink_url" });
  if (r.ok && (r.res.json?.published === true || r.res.json?.status?.publishing_phase?.status === "complete")) {
    return { status: "published", post_id: d.container_id, permalink: httpsOrNull(r.res.json?.permalink_url), published_at: new Date(ctx.now()).toISOString(), source: "verification" };
  }
  return verifyAgain(d, "fb_reel_unconfirmed", "Facebook has not confirmed this Reel yet.");
}

async function verify(ctx, d, pageId) {
  if (d.target_kind === "fb_reel") return verifyReel(ctx, d);
  const started = Date.parse(d.submit_started_at ?? "");
  const since = Number.isFinite(started) ? Math.floor((started - MATCH_WINDOW_MS) / 1000) : undefined;
  const r = await graphGet(ctx, "facebook", `${pageId}/published_posts`, { since, fields: "id,message,created_time,permalink_url", limit: 25 });
  if (!r.ok) {
    if (r.classified?.class === "auth" && r.classified.definitive) return outcomeFor(r.classified);
    return verifyAgain(d, "fb_verify_unreachable", "Facebook could not be checked; Atlas will check again.");
  }
  const caption = normalizeCaption(d.payload.caption);
  const rows = Array.isArray(r.res.json?.data) ? r.res.json.data : [];
  const matches = rows.filter((row) => normalizeCaption(row.message) === caption
    && (!Number.isFinite(started) || Date.parse(row.created_time ?? "") >= started - MATCH_WINDOW_MS));
  await ctx.recordStep(null, {}, { step: "verify_read", detail: `matches=${matches.length}` });
  if (matches.length === 1) {
    const row = matches[0];
    return { status: "published", post_id: String(row.id), permalink: httpsOrNull(row.permalink_url), published_at: isoOrNull(row.created_time) ?? new Date(ctx.now()).toISOString(), source: "verification" };
  }
  if (matches.length > 1) return attentionOutcome("outcome_unknown", "fb_verify_ambiguous", "Facebook shows more than one matching post. Check the Page.", "uncertain");
  if (d.target_kind === "fb_page_video") {
    await ctx.recordStep(null, {}, { step: "verify_absent_read" });
    return verifyAgain(d, "fb_video_unconfirmed", "Facebook does not show this video yet. Atlas will check again, then ask you to check the Page.");
  }
  const reads = (Array.isArray(d.progress?.fb_absent_reads) ? d.progress.fb_absent_reads : []).concat(new Date(ctx.now()).toISOString());
  const first = Date.parse(reads[0]);
  if (reads.length < 2 || ctx.now() - first < ABSENT_READ_GAP_MS) {
    await ctx.recordStep(null, { progress: { fb_absent_reads: reads } }, { step: "verify_absent_read" });
    return { status: "verifying", poll_after_s: 120, error: { class: "uncertain", code: "fb_verify_absent_once", message: "Facebook does not show the post yet; Atlas will check again." } };
  }
  if (!d.progress?.verify_retry_used && autoRetryEnabled(ctx)) {
    await ctx.recordStep(null, { progress: { verify_retry_used: true, fb_absent_reads: [] } }, { step: "verified_absent" });
    return { status: "retrying", definitive: true, error: { class: "uncertain", code: "verified_absent", message: "Facebook confirmed the post was not created; Atlas will try once more." } };
  }
  return attentionOutcome("outcome_unknown", "fb_verify_absent_after_retry", "Atlas could not confirm whether Facebook published this post.", "uncertain");
}

export async function publish(ctx, d) {
  const pageId = String(ctx.credential?.resource?.id ?? "");
  if (!idOk(pageId)) return attentionOutcome("no_resource", "fb_page_missing", "No Facebook Page is chosen for publishing.");
  if (d.post_id) return { status: "published", post_id: d.post_id, permalink: d.permalink ?? null, source: "provider" };
  if (d.claim_kind === "verify") return verify(ctx, d, pageId);
  switch (d.target_kind) {
    case "fb_page_post":
    case "fb_page_photo":
      return publishFeedOrPhoto(ctx, d, pageId);
    case "fb_page_video":
      return publishVideo(ctx, d, pageId);
    case "fb_reel":
      return publishReel(ctx, d, pageId);
    default:
      return failedOutcome("provider_rejected", "fb_target_unsupported", "This Facebook format is not supported yet.");
  }
}
