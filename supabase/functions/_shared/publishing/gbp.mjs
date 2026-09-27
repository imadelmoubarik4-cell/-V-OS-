// S94C Google Business Profile adapter (v4 localPosts, mybusiness.googleapis.com).
//
// localPosts exist only on v4 (live probe 2026-09-26, report 06 §11):
//   POST {parent}/localPosts          create (no idempotency key; UNVERIFIED as absent)
//   GET  {parent}/localPosts/{id}     state PROCESSING -> LIVE | REJECTED [IDX]
//   GET  {parent}/localPosts?pageSize list (ordering UNVERIFIED; we scan the page)
// parent = accounts/{accountId}/locations/{locationId} (the selected
// gbp_location resource id must carry both ids; a bare locations/{id} cannot
// be posted to).
//
// Body [IDX shape; required-field rules UNVERIFIED]: languageCode, summary
// (≤1500 chars UNVERIFIED), topicType STANDARD|EVENT|OFFER (ALERT not
// supported), callToAction {actionType, url} (no url for CALL), event {title,
// schedule{startDate,startTime,endDate,endTime}} (local time of the location,
// UNVERIFIED), offer {couponCode, redeemOnlineUrl, termsConditions} (OFFER also
// needs event), media [{mediaFormat: PHOTO, sourceUrl}] - one photo, signed
// Storage URL minted just before the create (15 min, contract §5.4).
//
// Lost create response -> verifying: list recent posts and match summary,
// topic type, event title and createTime >= submit - 2 min before any retry
// (same rules as Facebook: two empty reads 2 min apart prove absence, one
// automatic retry at most). Writes per location are serialised by the worker
// (one account group runs sequentially; 10 edits/min/profile, report 06 §10).
// `searchUrl` is the permalink (may be absent while PROCESSING).

import { attentionOutcome, cadence, failedOutcome, mediaFailureOutcome, normalizeCaption, outcomeFor, providerRequest } from "./classify.mjs";
import { URL_TTL_SECONDS } from "./media-urls.mjs";

const API = "https://mybusiness.googleapis.com/v4";
const PARENT_PATTERN = /^accounts\/[A-Za-z0-9_-]{1,64}\/locations\/[A-Za-z0-9_-]{1,64}$/;
const POST_PATTERN = /^accounts\/[A-Za-z0-9_-]{1,64}\/locations\/[A-Za-z0-9_-]{1,64}\/localPosts\/[A-Za-z0-9_-]{1,128}$/;
const TOPICS = new Set(["STANDARD", "EVENT", "OFFER"]);
const ACTIONS = new Set(["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]);
const POLL_CADENCE_S = [60, 300, 900, 3600];
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
const VERIFY_CADENCE_S = [120, 120, 300];
const MAX_VERIFIES = 3;
const ABSENT_READ_GAP_MS = 2 * 60 * 1000;
const MATCH_WINDOW_MS = 2 * 60 * 1000;

function headers(ctx, json = false) {
  const out = { authorization: `Bearer ${ctx.credential.access_token}`, accept: "application/json" };
  if (json) out["content-type"] = "application/json";
  return out;
}

function encodeName(name) {
  return name.split("/").map(encodeURIComponent).join("/");
}

export function gbpOptions(options) {
  const nested = options?.gbp;
  if (nested && typeof nested === "object") return nested;
  return options && typeof options === "object" ? options : {};
}

function venueZone(ctx, d) {
  const fromPayload = d.payload.venue_timezone;
  const fromEnv = typeof ctx.env === "function" ? ctx.env("ATLAS_VENUE_TIMEZONE") : undefined;
  return String(fromPayload || fromEnv || "Atlantic/Reykjavik");
}

// "2026-10-03T20:00" (venue wall time), "2026-10-03" (all day) or an ISO
// instant -> { date: {year,month,day}, time: {hours,minutes,seconds,nanos}|null }
export function localParts(value, timeZone) {
  const text = String(value ?? "").trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return { date: { year: +match[1], month: +match[2], day: +match[3] }, time: null };
  match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (match) return { date: { year: +match[1], month: +match[2], day: +match[3] }, time: { hours: +match[4], minutes: +match[5], seconds: 0, nanos: 0 } };
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  } catch {
    return null;
  }
  return { date: { year: +parts.year, month: +parts.month, day: +parts.day }, time: { hours: +parts.hour % 24, minutes: +parts.minute, seconds: 0, nanos: 0 } };
}

function schedule(start, end, zone) {
  const a = localParts(start, zone);
  const b = localParts(end, zone);
  if (!a || !b) return null;
  const out = { startDate: a.date, endDate: b.date };
  if (a.time) out.startTime = a.time;
  if (b.time) out.endTime = b.time;
  return out;
}

export function buildLocalPost(ctx, d, photoUrl) {
  const opts = gbpOptions(d.payload.options);
  const topic = String(opts.topic_type ?? "STANDARD").toUpperCase();
  if (!TOPICS.has(topic)) return { error: failedOutcome("provider_rejected", "gbp_topic_unsupported", "This Google Business Profile post type is not supported.") };
  const language = String(opts.language_code || (typeof ctx.env === "function" ? ctx.env("ATLAS_GBP_LANGUAGE") : "") || "is").slice(0, 10);
  const body = { languageCode: language, summary: String(d.payload.caption ?? ""), topicType: topic };
  const zone = venueZone(ctx, d);
  if (topic === "EVENT" || topic === "OFFER") {
    const source = topic === "OFFER" ? { ...(opts.event ?? {}), ...(opts.offer ?? {}) } : (opts.event ?? {});
    const title = String(source.title ?? opts.event?.title ?? "").trim();
    const sched = schedule(source.start ?? opts.event?.start, source.end ?? opts.event?.end, zone);
    if (!title || !sched) return { error: failedOutcome("provider_rejected", "gbp_event_incomplete", "Google Business Profile events and offers need a title, a start and an end.") };
    body.event = { title: title.slice(0, 58), schedule: sched };
  }
  if (topic === "OFFER") {
    const offer = opts.offer ?? {};
    const out = {};
    if (offer.coupon_code) out.couponCode = String(offer.coupon_code).slice(0, 58);
    if (/^https:\/\//.test(String(offer.redeem_online_url ?? ""))) out.redeemOnlineUrl = String(offer.redeem_online_url);
    if (offer.terms) out.termsConditions = String(offer.terms).slice(0, 5000);
    if (Object.keys(out).length) body.offer = out;
  } else {
    const cta = opts.call_to_action;
    const action = String(cta?.action_type ?? "").toUpperCase();
    if (ACTIONS.has(action)) {
      if (action === "CALL") body.callToAction = { actionType: "CALL" };
      else if (/^https:\/\//.test(String(cta.url ?? ""))) body.callToAction = { actionType: action, url: String(cta.url) };
      else return { error: failedOutcome("provider_rejected", "gbp_cta_link_missing", "The Google Business Profile button needs a link starting with https://.") };
    }
  }
  if (photoUrl) body.media = [{ mediaFormat: "PHOTO", sourceUrl: photoUrl }];
  return { body };
}

function publishedFrom(ctx, post, source) {
  const permalink = /^https:\/\//.test(String(post.searchUrl ?? "")) ? String(post.searchUrl).slice(0, 500) : null;
  return { status: "published", post_id: String(post.name), permalink, published_at: new Date(Date.parse(post.createTime ?? "") || ctx.now()).toISOString(), source };
}

function stateOutcome(ctx, d, post, source) {
  const state = String(post.state ?? "").toUpperCase();
  if (state === "LIVE") return publishedFrom(ctx, post, source);
  if (state === "REJECTED") return failedOutcome("provider_rejected", "gbp_post_rejected", "Google rejected this post. Check the text and photo against Google's post rules.");
  const started = Date.parse(d.submit_started_at ?? "");
  if (Number.isFinite(started) && ctx.now() - started > GIVE_UP_MS) return attentionOutcome("outcome_unknown", "gbp_processing_timeout", "Google has not made this post live within a day.", "uncertain");
  return { status: "processing", ids: {}, poll_after_s: cadence(POLL_CADENCE_S, d.poll_count) };
}

async function create(ctx, d, parent) {
  const items = (d.payload.media ?? []).filter((item) => item.role !== "thumbnail");
  if (items.some((item) => /^video\//.test(String(item.mime_type)))) return failedOutcome("media_invalid", "gbp_video_unsupported", "Google Business Profile can't post videos.");
  const photo = items.find((item) => /^image\/(jpeg|png)$/.test(String(item.mime_type)));
  if (items.length && !photo) return failedOutcome("media_invalid", "gbp_photo_format", "Google Business Profile photos must be JPEG or PNG.");
  const draft = buildLocalPost(ctx, d, null);
  if (draft.error) return draft.error;
  let signed = null;
  if (photo) {
    try {
      signed = await ctx.mediaUrls.sign(photo.storage_path, URL_TTL_SECONDS.gbp_photo);
    } catch (error) {
      return mediaFailureOutcome(error);
    }
  }
  const { body } = buildLocalPost(ctx, d, signed?.url ?? null);
  await ctx.beginSubmit();
  const r = await providerRequest(ctx, "google-business-profile", `${API}/${encodeName(parent)}/localPosts`, { method: "POST", headers: headers(ctx, true), body: JSON.stringify(body) }, { afterSubmit: true });
  if (!r.ok) return r.outcome;
  const post = r.res.json ?? {};
  if (!POST_PATTERN.test(String(post.name ?? ""))) return { status: "verifying", error: { class: "uncertain", code: "gbp_no_post_name", message: "Google accepted the post but returned no name." } };
  await ctx.recordStep("submitted", { provider_post_id: post.name }, { step: "local_post_created", http_status: r.res.status, poll_status: String(post.state ?? ""), detail: signed ? `url_expires_at=${signed.expires_at}` : undefined });
  return stateOutcome(ctx, d, post, "provider");
}

async function poll(ctx, d) {
  const r = await providerRequest(ctx, "google-business-profile", `${API}/${encodeName(d.post_id)}`, { method: "GET", headers: headers(ctx) });
  if (!r.ok) {
    if (r.classified?.definitive && ["auth", "policy"].includes(r.classified.class)) return outcomeFor(r.classified, { afterSubmit: true });
    return stateOutcome(ctx, d, { state: "PROCESSING" }, "provider");
  }
  await ctx.recordStep(null, {}, { step: "local_post_state", poll_status: String(r.res.json?.state ?? "") });
  return stateOutcome(ctx, d, { ...r.res.json, name: d.post_id }, "provider");
}

function verifyAgain(d, code, message, pollAfter) {
  if ((Number(d.verify_attempts) || 0) >= MAX_VERIFIES) return attentionOutcome("outcome_unknown", code, message, "uncertain");
  return { status: "verifying", poll_after_s: pollAfter ?? cadence(VERIFY_CADENCE_S, d.verify_attempts), error: { class: "uncertain", code, message } };
}

async function verify(ctx, d, parent) {
  const r = await providerRequest(ctx, "google-business-profile", `${API}/${encodeName(parent)}/localPosts?pageSize=20`, { method: "GET", headers: headers(ctx) });
  if (!r.ok) {
    if (r.classified?.definitive && r.classified.class === "auth") return outcomeFor(r.classified, { afterSubmit: true });
    return verifyAgain(d, "gbp_verify_unreachable", "Google could not be checked; Atlas will check again.");
  }
  const opts = gbpOptions(d.payload.options);
  const topic = String(opts.topic_type ?? "STANDARD").toUpperCase();
  const eventTitle = topic === "STANDARD" ? null : String((topic === "OFFER" ? (opts.offer?.title ?? opts.event?.title) : opts.event?.title) ?? "").trim().slice(0, 58);
  const started = Date.parse(d.submit_started_at ?? "");
  const summary = normalizeCaption(d.payload.caption);
  const posts = Array.isArray(r.res.json?.localPosts) ? r.res.json.localPosts : [];
  const matches = posts.filter((post) => normalizeCaption(post.summary) === summary
    && String(post.topicType ?? "STANDARD").toUpperCase() === topic
    && (!eventTitle || String(post.event?.title ?? "").trim() === eventTitle)
    && (!Number.isFinite(started) || Date.parse(post.createTime ?? "") >= started - MATCH_WINDOW_MS)
    && POST_PATTERN.test(String(post.name ?? "")));
  await ctx.recordStep(null, {}, { step: "verify_read", detail: `matches=${matches.length}` });
  if (matches.length === 1) {
    const post = matches[0];
    await ctx.recordStep("submitted", { provider_post_id: post.name }, { step: "verified_present", poll_status: String(post.state ?? "") });
    return stateOutcome(ctx, { ...d, post_id: post.name }, post, "verification");
  }
  if (matches.length > 1) return attentionOutcome("outcome_unknown", "gbp_verify_ambiguous", "Google shows more than one matching post. Check the Business Profile.", "uncertain");
  const reads = (Array.isArray(d.progress?.gbp_absent_reads) ? d.progress.gbp_absent_reads : []).concat(new Date(ctx.now()).toISOString());
  if (reads.length < 2 || ctx.now() - Date.parse(reads[0]) < ABSENT_READ_GAP_MS) {
    await ctx.recordStep(null, { progress: { gbp_absent_reads: reads } }, { step: "verify_absent_read" });
    return { status: "verifying", poll_after_s: 120, error: { class: "uncertain", code: "gbp_verify_absent_once", message: "Google does not show the post yet; Atlas will check again." } };
  }
  if (!d.progress?.verify_retry_used) {
    await ctx.recordStep(null, { progress: { verify_retry_used: true, gbp_absent_reads: [] } }, { step: "verified_absent" });
    return { status: "retrying", definitive: true, error: { class: "uncertain", code: "verified_absent", message: "Google confirmed the post was not created; Atlas will try once more." } };
  }
  return attentionOutcome("outcome_unknown", "gbp_verify_absent_after_retry", "Atlas could not confirm whether Google published this post.", "uncertain");
}

export async function publish(ctx, d) {
  const parent = String(ctx.credential?.resource?.id ?? "");
  if (ctx.credential?.resource?.kind && ctx.credential.resource.kind !== "gbp_location") {
    return attentionOutcome("no_resource", "gbp_location_missing", "Choose which Google Business Profile location Atlas posts to.");
  }
  if (!PARENT_PATTERN.test(parent)) return attentionOutcome("no_resource", "gbp_location_missing", "Choose which Google Business Profile location Atlas posts to.");
  if (d.target_kind !== "gbp_local_post") return failedOutcome("provider_rejected", "gbp_target_unsupported", "This Google Business Profile format is not supported.");
  // A known post (created or adopted by verification): read its state. On a
  // verify claim the worker keeps `processing` as `verifying` (legal transitions).
  if (d.post_id) return poll(ctx, d);
  // Only a verify claim looks for a lost create. A publish claim after the
  // marker exists only after proven absence or a manager's attested retry.
  if (d.claim_kind === "verify") return verify(ctx, d, parent);
  return create(ctx, d, parent);
}
