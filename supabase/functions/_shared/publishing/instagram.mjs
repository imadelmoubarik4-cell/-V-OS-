// S94C Instagram adapter (Instagram API with Facebook Login, graph.facebook.com).
//
// Target kinds: ig_feed (one JPEG), ig_carousel (2-10 images/videos, order
// preserved), ig_reel (one video, media_type=REELS).
//
// Flow (report 04 §8, report 07 §4.1):
//   1. containers: POST /{ig-user-id}/media (image_url | video_url signed
//      Storage URL, caption) -> container id, persisted with record_step
//      BEFORE the first status poll. Carousel children are created in order
//      (is_carousel_item=true), each id persisted as soon as it is known,
//      then the CAROUSEL parent with children=<ids in order>.
//      Containers are private and expire after 24 h, so creating one is
//      harmless; a lost create response just leaves an orphan.
//   2. wait: GET /{container}?fields=status_code -> IN_PROGRESS | FINISHED |
//      ERROR | EXPIRED | PUBLISHED (PUBLISHED is UNVERIFIED on Meta's page).
//      Inline polls within the invocation budget, then `processing` with
//      poll_after_s (report 07 §5.3).
//   3. publish: begin_submit (committed marker), then
//      POST /{ig-user-id}/media_publish creation_id=<container> -> media id.
//      One container yields at most one media (widely reported; UNVERIFIED).
//   4. verify (uncertain publish): container status PUBLISHED -> find the
//      media in GET /{ig-user-id}/media (caption + timestamp); FINISHED ->
//      proven not published -> retrying, and the retry publishes the SAME
//      container. Before every media_publish the container status is read
//      again, so a container that is already PUBLISHED is never re-published.

import { attentionOutcome, cadence, failedOutcome, mediaFailureOutcome, normalizeCaption, outcomeFor } from "./classify.mjs";
import { graphGet, graphPost, httpsOrNull, isoOrNull } from "./meta.mjs";
import { URL_TTL_SECONDS } from "./media-urls.mjs";

const IMAGE_INLINE_POLLS_MS = [2_000, 4_000, 8_000];
const VIDEO_INLINE_POLLS_MS = [5_000, 10_000];
const IMAGE_POLL_CADENCE_S = [60, 60, 120, 300, 300, 600];
const VIDEO_POLL_CADENCE_S = [60, 120, 300, 300, 600];
const IMAGE_GIVE_UP_MS = 60 * 60 * 1000;
const VIDEO_GIVE_UP_MS = 2 * 60 * 60 * 1000;
const VERIFY_CADENCE_S = [60, 120, 300];
const MAX_VERIFIES = 3;
const MATCH_WINDOW_MS = 2 * 60 * 1000;

const isVideo = (item) => /^video\//.test(String(item?.mime_type ?? ""));

function publishItems(d) {
  return (d.payload.media ?? []).filter((item) => item.role !== "thumbnail");
}

function statusStep(step, code, extra = {}) {
  return { step, poll_status: code ?? null, ...extra };
}

async function containerStatus(ctx, id) {
  const r = await graphGet(ctx, "instagram", id, { fields: "status_code" });
  if (!r.ok) return { fail: r };
  return { code: String(r.res.json?.status_code ?? "").toUpperCase() || "UNKNOWN" };
}

async function signFor(ctx, item) {
  return ctx.mediaUrls.sign(item.storage_path, isVideo(item) ? URL_TTL_SECONDS.instagram_video : URL_TTL_SECONDS.instagram_image);
}

function processingOutcome(d, video, ids) {
  const list = video ? VIDEO_POLL_CADENCE_S : IMAGE_POLL_CADENCE_S;
  return { status: "processing", ids: ids ?? {}, poll_after_s: cadence(list, d.poll_count) };
}

function givenUp(ctx, d, video) {
  const created = Date.parse(d.progress?.container_created_at ?? "");
  if (!Number.isFinite(created)) return false;
  return ctx.now() - created > (video ? VIDEO_GIVE_UP_MS : IMAGE_GIVE_UP_MS);
}

// Polls a container inline while the invocation budget allows it.
async function waitInline(ctx, id, delays) {
  let last = null;
  for (const delay of delays) {
    if (ctx.timeLeftMs() < delay + 15_000) break;
    await ctx.sleep(delay);
    const st = await containerStatus(ctx, id);
    if (st.fail) return st;
    last = st;
    if (st.code !== "IN_PROGRESS") return st;
  }
  return last ?? { code: "IN_PROGRESS" };
}

async function createContainer(ctx, d, igUserId, params) {
  const r = await graphPost(ctx, "instagram", `${igUserId}/media`, params);
  if (!r.ok) return { fail: r.outcome };
  const id = String(r.res.json?.id ?? "");
  if (!/^\d{1,40}$/.test(id)) return { fail: { status: "retrying", error: { class: "transient", code: "ig_container_missing_id", message: "Instagram did not return a container id." } } };
  return { id };
}

// Creates (or resumes) carousel children in order; persists each id at once.
async function ensureChildren(ctx, d, igUserId, items) {
  const ids = Array.isArray(d.progress?.children_container_ids) ? [...d.progress.children_container_ids] : [];
  for (let index = 0; index < items.length; index += 1) {
    if (ids[index]) continue;
    const item = items[index];
    let signed;
    try {
      signed = await signFor(ctx, item);
    } catch (error) {
      return { fail: mediaFailureOutcome(error) };
    }
    const params = isVideo(item)
      ? { is_carousel_item: "true", media_type: "VIDEO", video_url: signed.url }
      : { is_carousel_item: "true", image_url: signed.url };
    const created = await createContainer(ctx, d, igUserId, params);
    if (created.fail) return { fail: created.fail };
    ids[index] = created.id;
    await ctx.recordStep(null, { progress: { children_container_ids: ids } }, statusStep("carousel_child_created", null, { detail: `position=${index + 1};url_expires_at=${signed.expires_at}` }));
    d.progress = { ...(d.progress ?? {}), children_container_ids: ids };
  }
  // Video children must finish processing before the parent is created.
  for (let index = 0; index < items.length; index += 1) {
    if (!isVideo(items[index])) continue;
    let st = await containerStatus(ctx, ids[index]);
    if (st.fail) return { fail: st.fail.outcome };
    if (st.code === "IN_PROGRESS") st = await waitInline(ctx, ids[index], VIDEO_INLINE_POLLS_MS);
    if (st.fail) return { fail: st.fail.outcome };
    if (st.code === "IN_PROGRESS") return { fail: processingOutcome(d, true) };
    if (st.code === "ERROR") return { fail: failedOutcome("media_invalid", "ig_child_error", `Instagram could not process item ${index + 1} of the carousel.`) };
    if (st.code === "EXPIRED") {
      // Unpublished child expired: recreate it on the next run.
      const fresh = ids.slice();
      fresh[index] = null;
      await ctx.recordStep(null, { progress: { children_container_ids: fresh } }, statusStep("carousel_child_expired", "EXPIRED"));
      return { fail: { status: "retrying", error: { class: "transient", code: "ig_child_expired", message: "An Instagram carousel item expired before publishing; it will be prepared again." } } };
    }
  }
  return { ids };
}

async function createMainContainer(ctx, d, igUserId) {
  const items = publishItems(d);
  const caption = String(d.payload.caption ?? "");
  if (d.target_kind === "ig_carousel") {
    if (items.length < 2 || items.length > 10) return { fail: failedOutcome("media_invalid", "ig_carousel_count", "Instagram carousels need 2 to 10 photos or videos.") };
    const children = await ensureChildren(ctx, d, igUserId, items);
    if (children.fail) return children;
    return createContainer(ctx, d, igUserId, { media_type: "CAROUSEL", children: children.ids.join(","), caption });
  }
  const item = d.target_kind === "ig_reel" ? items.find(isVideo) : items[0];
  if (!item) return { fail: failedOutcome("media_invalid", "ig_media_missing", "Instagram needs a photo or video.") };
  let signed;
  try {
    signed = await signFor(ctx, item);
  } catch (error) {
    return { fail: mediaFailureOutcome(error) };
  }
  const params = d.target_kind === "ig_reel"
    // share_to_feed is UNVERIFIED (report 04 §8); REELS is [S].
    ? { media_type: "REELS", video_url: signed.url, caption, share_to_feed: "true" }
    : { image_url: signed.url, caption };
  const created = await createContainer(ctx, d, igUserId, params);
  if (created.fail) return created;
  return { ...created, expires_at: signed.expires_at };
}

async function findPublishedMedia(ctx, d, igUserId) {
  const r = await graphGet(ctx, "instagram", `${igUserId}/media`, { fields: "id,caption,timestamp,permalink", limit: 10 });
  if (!r.ok) return { fail: r };
  const since = Date.parse(d.submit_started_at ?? "") - MATCH_WINDOW_MS;
  const caption = normalizeCaption(d.payload.caption);
  const rows = Array.isArray(r.res.json?.data) ? r.res.json.data : [];
  const matches = rows.filter((row) => normalizeCaption(row.caption) === caption && (!Number.isFinite(since) || Date.parse(row.timestamp ?? "") >= since));
  return { matches };
}

async function publishedWithPermalink(ctx, mediaId, source) {
  let permalink = null;
  let publishedAt = null;
  const r = await graphGet(ctx, "instagram", mediaId, { fields: "permalink,timestamp" });
  if (r.ok) {
    permalink = httpsOrNull(r.res.json?.permalink);
    publishedAt = isoOrNull(r.res.json?.timestamp);
  }
  return { status: "published", post_id: mediaId, permalink, published_at: publishedAt ?? new Date(ctx.now()).toISOString(), source };
}

function verifyAgain(d, code, message) {
  if ((Number(d.verify_attempts) || 0) >= MAX_VERIFIES) {
    return attentionOutcome("outcome_unknown", code, message, "uncertain");
  }
  return { status: "verifying", poll_after_s: cadence(VERIFY_CADENCE_S, d.verify_attempts), error: { class: "uncertain", code, message } };
}

async function verify(ctx, d, igUserId) {
  if (!d.container_id) return attentionOutcome("outcome_unknown", "ig_no_container", "Instagram publish outcome is unknown and no container was recorded.", "uncertain");
  const st = await containerStatus(ctx, d.container_id);
  if (st.fail) {
    if (st.fail.classified?.class === "auth" && st.fail.classified.definitive) return outcomeFor(st.fail.classified);
    return verifyAgain(d, "ig_verify_unreachable", "Instagram could not be checked; Atlas will check again.");
  }
  await ctx.recordStep(null, {}, statusStep("verify_container", st.code));
  if (st.code === "PUBLISHED") {
    const found = await findPublishedMedia(ctx, d, igUserId);
    if (found.fail) return verifyAgain(d, "ig_verify_unreachable", "Instagram could not be checked; Atlas will check again.");
    if (found.matches.length === 1) return publishedWithPermalink(ctx, String(found.matches[0].id), "verification");
    return verifyAgain(d, found.matches.length > 1 ? "ig_verify_ambiguous" : "ig_verify_media_not_found", "Instagram shows the post as published but Atlas could not match it yet.");
  }
  if (st.code === "FINISHED") {
    // Proven not published: the same container may be published again.
    return { status: "retrying", definitive: true, error: { class: "uncertain", code: "verified_absent", message: "Instagram confirmed the post was not published; Atlas will publish it again." } };
  }
  if (st.code === "IN_PROGRESS") return verifyAgain(d, "ig_verify_in_progress", "Instagram is still processing this post.");
  if (st.code === "ERROR") return failedOutcome("media_invalid", "ig_container_error", "Instagram could not process this media.");
  return attentionOutcome("outcome_unknown", `ig_container_${st.code.toLowerCase()}`.slice(0, 80), "Atlas could not confirm whether Instagram published this post.", "uncertain");
}

async function publishContainer(ctx, d, igUserId, containerId) {
  await ctx.beginSubmit();
  const r = await graphPost(ctx, "instagram", `${igUserId}/media_publish`, { creation_id: containerId }, { afterSubmit: true });
  if (!r.ok) return r.outcome;
  const mediaId = String(r.res.json?.id ?? "");
  if (!/^\d{1,40}$/.test(mediaId)) return { status: "verifying", error: { class: "uncertain", code: "ig_publish_no_id", message: "Instagram accepted the publish but returned no media id." } };
  await ctx.recordStep("submitted", { provider_post_id: mediaId }, statusStep("media_publish", "PUBLISHED", { http_status: r.res.status }));
  return publishedWithPermalink(ctx, mediaId, "provider");
}

export async function publish(ctx, d) {
  const igUserId = String(ctx.credential?.resource?.id ?? "");
  if (!/^\d{1,40}$/.test(igUserId)) return attentionOutcome("no_resource", "ig_account_missing", "No Instagram account is chosen for publishing.");
  if (!["ig_feed", "ig_carousel", "ig_reel"].includes(d.target_kind)) return failedOutcome("provider_rejected", "ig_target_unsupported", "This Instagram format is not supported yet.");
  const video = d.target_kind === "ig_reel" || publishItems(d).some(isVideo);

  if (d.post_id) return { status: "published", post_id: d.post_id, permalink: d.permalink ?? null, source: "provider" };
  if (d.claim_kind === "verify") return verify(ctx, d, igUserId);
  // Instagram takes JPEG photos only [S]; the approval snapshot should carry
  // the JPEG "publish" variant. Refuse before any container is created.
  if (d.target_kind !== "ig_reel" && publishItems(d).some((item) => !isVideo(item) && String(item.mime_type) !== "image/jpeg")) {
    return failedOutcome("media_invalid", "ig_image_not_jpeg", "Instagram takes JPEG photos only. Use the JPEG copy of the photo and approve again.");
  }
  const afterMarker = d.phase === "submitting" || d.phase === "submitted";

  let containerId = d.container_id;
  if (containerId) {
    const st = await containerStatus(ctx, containerId);
    if (st.fail) {
      if (afterMarker) return verifyAgain(d, "ig_status_unreachable", "Instagram could not be checked.");
      return d.claim_kind === "poll" && !st.fail.classified?.definitive ? processingOutcome(d, video) : st.fail.outcome;
    }
    await ctx.recordStep(null, {}, statusStep("container_status", st.code));
    if (st.code === "PUBLISHED") return verify(ctx, { ...d, verify_attempts: 0 }, igUserId);
    if (st.code === "ERROR") return failedOutcome("media_invalid", "ig_container_error", "Instagram could not process this media.");
    if (st.code === "IN_PROGRESS") {
      if (givenUp(ctx, d, video)) return attentionOutcome("max_attempts", "ig_processing_timeout", "Instagram is taking too long to process this media.");
      const waited = await waitInline(ctx, containerId, video ? VIDEO_INLINE_POLLS_MS.slice(0, 1) : IMAGE_INLINE_POLLS_MS.slice(0, 1));
      if (waited.fail || waited.code === "IN_PROGRESS") return processingOutcome(d, video);
      if (waited.code !== "FINISHED") return publish(ctx, { ...d, claim_kind: "poll" });
    }
    if (st.code === "EXPIRED") {
      if (afterMarker) return attentionOutcome("outcome_unknown", "ig_container_expired_after_submit", "Atlas could not confirm whether Instagram published this post.", "uncertain");
      await ctx.recordStep("none", { reset_container: true, progress: { children_container_ids: [] } }, statusStep("container_expired", "EXPIRED"));
      containerId = null;
      d = { ...d, container_id: null, progress: { ...(d.progress ?? {}), children_container_ids: [] } };
    } else {
      await ctx.recordStep("container_ready", {}, statusStep("container_ready", "FINISHED"));
      return publishContainer(ctx, d, igUserId, containerId);
    }
  }

  if (afterMarker) return attentionOutcome("outcome_unknown", "ig_marker_without_container", "Atlas could not confirm whether Instagram published this post.", "uncertain");

  const created = await createMainContainer(ctx, d, igUserId);
  if (created.fail) return created.fail;
  containerId = created.id;
  const createdAt = new Date(ctx.now()).toISOString();
  await ctx.recordStep(
    "container_created",
    { provider_container_id: containerId, progress: { container_created_at: createdAt } },
    statusStep("container_created", null, created.expires_at ? { detail: `url_expires_at=${created.expires_at}` } : {}),
  );
  d = { ...d, container_id: containerId, progress: { ...(d.progress ?? {}), container_created_at: createdAt } };

  const waited = await waitInline(ctx, containerId, video ? VIDEO_INLINE_POLLS_MS : IMAGE_INLINE_POLLS_MS);
  if (waited.fail) return processingOutcome(d, video);
  await ctx.recordStep(null, {}, statusStep("container_status", waited.code));
  if (waited.code === "IN_PROGRESS") return processingOutcome(d, video);
  if (waited.code === "ERROR") return failedOutcome("media_invalid", "ig_container_error", "Instagram could not process this media.");
  if (waited.code !== "FINISHED") return processingOutcome(d, video);
  await ctx.recordStep("container_ready", {}, statusStep("container_ready", "FINISHED"));
  return publishContainer(ctx, d, igUserId, containerId);
}
