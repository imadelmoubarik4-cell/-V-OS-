// S94C platform rules: the v1 publishing matrix (contract §5.4) as one pure
// function used by the server (gateway, worker) and, through a generated copy,
// by the browser composer (apps/web/assets/js/marketing-platform-rules.js, the
// AtlasPlatformRules global, built by scripts/build_platform_rules.mjs; a parity
// test keeps the copy byte-identical to a fresh build).
//
// This file must stay dependency-free (no imports) and use only syntax that
// also runs as a classic browser script once `export ` is removed.
//
// validate({ platforms, caption, overrides, media, options, targets_ready })
//   -> { errors: [{code, platform, message}], warnings: [...], target_kinds: {platform: kind|null} }
// Messages are plain language and name the channel first (report 08 §5.8).
//
// Limits come from reports 04-06. UNVERIFIED items (flagged below) must be
// rechecked on the providers' pages before the first live post (§12).

export const PLATFORM_LABELS = Object.freeze({
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  "google-business-profile": "Google Business Profile",
});

export const TARGET_KINDS = Object.freeze({
  instagram: Object.freeze(["ig_feed", "ig_carousel", "ig_reel"]),
  facebook: Object.freeze(["fb_page_post", "fb_page_photo", "fb_page_video", "fb_reel"]),
  tiktok: Object.freeze(["tiktok_inbox_video", "tiktok_video"]),
  "google-business-profile": Object.freeze(["gbp_local_post"]),
});

export const LIMITS = Object.freeze({
  instagram: Object.freeze({
    caption: 2200, // [S]
    hashtags: 30, // [S]
    mentions: 20, // UNVERIFIED
    carousel_max: 10, // [S]
    image_mime: Object.freeze(["image/jpeg"]), // [S] JPEG only
    image_max_bytes: 8 * 1024 * 1024, // [S]
    aspect_min: 0.8, // 4:5 [S]
    aspect_max: 1.91, // 1.91:1 [S]
    video_mime: Object.freeze(["video/mp4", "video/quicktime"]),
    reel_min_ms: 3000, // [S]
    reel_max_ms: 15 * 60 * 1000, // [S]
    reel_max_bytes: 300 * 1024 * 1024, // [S], one summary said 8 MB: recheck
  }),
  facebook: Object.freeze({
    caption: 63206, // UNVERIFIED (practical limit)
    video_mime: Object.freeze(["video/mp4", "video/quicktime"]),
    video_max_bytes: 1024 * 1024 * 1024, // [S] URL upload ≤1 GB
    video_max_ms: 20 * 60 * 1000, // [S] URL upload ≤20 min
    reel_min_ms: 3000, // UNVERIFIED
    reel_max_ms: 90 * 1000, // UNVERIFIED
    image_mime: Object.freeze(["image/jpeg", "image/png"]),
  }),
  tiktok: Object.freeze({
    caption: 2200, // UNVERIFIED (2200 UTF-16 runes)
    video_mime: Object.freeze(["video/mp4", "video/quicktime", "video/webm"]), // MP4 [V]; MOV/WebM UNVERIFIED
    video_max_bytes: 4 * 1024 * 1024 * 1024, // UNVERIFIED
    default_max_ms: 10 * 60 * 1000, // UNVERIFIED platform maximum; the creator's value wins
  }),
  "google-business-profile": Object.freeze({
    caption: 1500, // UNVERIFIED
    image_mime: Object.freeze(["image/jpeg", "image/png"]), // [IDX]
    image_min_bytes: 10 * 1024, // [IDX]
    image_max_bytes: 5 * 1024 * 1024, // [IDX]
    image_min_side: 250, // [IDX]
    event_title: 58,
  }),
});

const TIKTOK_PRIVACY_LABELS = Object.freeze({
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
});

const GBP_ACTIONS = Object.freeze(["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]);

const READY_REASONS = Object.freeze({
  not_connected: "isn't connected. Connect it in Settings › Integrations; Atlas won't post there until then.",
  needs_reauthorization: "needs reconnecting in Settings › Integrations before Atlas can post.",
  publishing_permission_missing: "is connected, but posting isn't allowed yet. Choose Allow publishing in Settings › Integrations.",
  review_required: "needs the platform's app review before Atlas can post.",
  review_pending: "is waiting for the platform's app review before Atlas can post.",
  no_resource_selected: "has no account chosen. Choose one in Settings › Integrations.",
  not_configured: "isn't set up for Atlas yet.",
});

function formatNumber(value) {
  return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatDuration(ms) {
  const total = Math.round((Number(ms) || 0) / 1000);
  if (total < 60) return `${total} second${total === 1 ? "" : "s"}`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatLimitMinutes(seconds) {
  const s = Math.floor(Number(seconds) || 0);
  if (s % 60 === 0) return `${s / 60} minute${s === 60 ? "" : "s"}`;
  return formatDuration(s * 1000);
}

function formatBytes(bytes) {
  const mb = (Number(bytes) || 0) / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.round(mb * 10) / 10} MB`;
}

// The file actually published for a photo: a non-JPEG original with a ready
// JPEG publish copy (publish_variant_id, no explicit variant chosen) is
// published as that JPEG (S94C marketing_content_media_list does the same).
export function publishedImageMime(item) {
  if (item && !item.variant_id && item.publish_variant_id) return String(item.publish_variant_mime || "image/jpeg");
  return String((item && item.mime_type) || "");
}

export function mediaKind(item) {
  const kind = String((item && item.kind) || "");
  if (kind === "image" || kind === "video") return kind;
  const mime = String((item && item.mime_type) || "");
  if (mime.indexOf("video/") === 0) return "video";
  if (mime.indexOf("image/") === 0) return "image";
  return "unknown";
}

export function orientation(item) {
  const w = Number(item && item.width);
  const h = Number(item && item.height);
  if (!(w > 0) || !(h > 0)) return null;
  if (Math.abs(w - h) / Math.max(w, h) < 0.02) return "square";
  return w > h ? "landscape" : "portrait";
}

export function countHashtags(text) {
  const matches = String(text || "").match(/(^|\s)#[\p{L}\p{N}_]+/gu);
  return matches ? matches.length : 0;
}

export function countMentions(text) {
  const matches = String(text || "").match(/(^|\s)@[\p{L}\p{N}_.]+/gu);
  return matches ? matches.length : 0;
}

// Heuristic: 7-15 digits written as a phone number (dates are ignored).
export function containsPhoneNumber(text) {
  const candidates = String(text || "").match(/\+?\d[\d\s().-]{5,}\d/g) || [];
  for (const raw of candidates) {
    const candidate = raw.trim();
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(candidate) || /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(candidate)) continue;
    const digits = candidate.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) return true;
  }
  return false;
}

function characterCount(text) {
  return Array.from(String(text || "")).length;
}

function platformOptions(options, platform) {
  const all = options && typeof options === "object" ? options : {};
  const own = all[platform];
  return own && typeof own === "object" ? own : {};
}

function nested(options, key) {
  const inner = options && options[key];
  if (inner && typeof inner === "object") return inner;
  return options || {};
}

function readinessFor(targetsReady, platform) {
  if (!targetsReady) return null;
  if (Array.isArray(targetsReady)) {
    for (const row of targetsReady) if (row && row.provider_key === platform) return row;
    return null;
  }
  const row = targetsReady[platform];
  if (row === true) return { ready: true };
  if (row === false) return { ready: false };
  return row && typeof row === "object" ? row : null;
}

function nth(index) {
  return index + 1;
}

// Target kind for one platform from its media and chosen format.
export function deriveTargetKind(platform, media, options, readiness) {
  const items = Array.isArray(media) ? media : [];
  const videos = items.filter((item) => mediaKind(item) === "video").length;
  const images = items.filter((item) => mediaKind(item) === "image").length;
  const chosen = String((options && options.target_kind) || "");
  if (platform === "instagram") {
    if (TARGET_KINDS.instagram.indexOf(chosen) >= 0) return chosen;
    if (items.length === 0) return null;
    if (items.length === 1) return videos === 1 ? "ig_reel" : "ig_feed";
    return "ig_carousel";
  }
  if (platform === "facebook") {
    if (TARGET_KINDS.facebook.indexOf(chosen) >= 0) return chosen;
    if (items.length === 0) return "fb_page_post";
    if (videos === 0) return "fb_page_photo";
    if (videos === 1 && images === 0) return "fb_page_video";
    return null;
  }
  if (platform === "tiktok") {
    const allowed = readiness && Array.isArray(readiness.target_kinds) ? readiness.target_kinds : null;
    if (chosen === "tiktok_video" && (!allowed || allowed.indexOf("tiktok_video") >= 0)) return "tiktok_video";
    return "tiktok_inbox_video";
  }
  if (platform === "google-business-profile") return "gbp_local_post";
  return null;
}

export function validate(input) {
  const source = input && typeof input === "object" ? input : {};
  const platforms = Array.isArray(source.platforms) ? source.platforms.filter((p, i, list) => list.indexOf(p) === i) : [];
  const common = String(source.caption == null ? "" : source.caption);
  const overrides = source.overrides && typeof source.overrides === "object" ? source.overrides : {};
  const media = Array.isArray(source.media) ? source.media : [];
  const options = source.options && typeof source.options === "object" ? source.options : {};
  const errors = [];
  const warnings = [];
  const targetKinds = {};
  const error = (code, platform, message) => errors.push({ code, platform, message });
  const warn = (code, platform, message) => warnings.push({ code, platform, message });

  if (!platforms.length) error("no_channel", null, "Choose at least one channel.");

  const scheduledFor = source.scheduled_for != null ? source.scheduled_for : options.scheduled_for;
  const nowMs = Number(source.now != null ? source.now : options.now);
  if (scheduledFor && Number.isFinite(nowMs) && Date.parse(scheduledFor) < nowMs) error("time_past", null, "Choose a time in the future.");

  const images = media.map((item, index) => ({ item, index })).filter((entry) => mediaKind(entry.item) === "image");
  const videos = media.map((item, index) => ({ item, index })).filter((entry) => mediaKind(entry.item) === "video");
  let altWarned = false;

  for (const platform of platforms) {
    const label = PLATFORM_LABELS[platform];
    if (!label) {
      error("unknown_platform", platform, "Atlas can't publish to this channel.");
      targetKinds[platform] = null;
      continue;
    }
    const own = platformOptions(options, platform);
    const caption = typeof overrides[platform] === "string" ? overrides[platform] : common;
    const readiness = readinessFor(source.targets_ready, platform);
    const kind = deriveTargetKind(platform, media, own, readiness);
    targetKinds[platform] = kind;

    if (readiness && readiness.ready === false) {
      const reason = READY_REASONS[readiness.reason] || "isn't ready to publish yet. Check Settings › Integrations.";
      warn("not_ready", platform, `${label} ${reason}`);
    }

    if (platform === "instagram") {
      const lim = LIMITS.instagram;
      if (!media.length) error("ig_no_media", platform, "Instagram needs at least one photo or video.");
      if (media.length > lim.carousel_max) {
        const extra = media.length - lim.carousel_max;
        error("ig_too_many", platform, `Instagram carousels take up to 10 photos or videos. Remove ${extra}.`);
      }
      if (kind === "ig_reel" && !(media.length === 1 && videos.length === 1)) error("ig_reel_media", platform, "Instagram: a Reel needs exactly one video.");
      if (kind === "ig_feed" && !(media.length === 1 && images.length === 1)) error("ig_feed_media", platform, "Instagram: a single post needs exactly one photo. Several items become a carousel.");
      if (kind === "ig_carousel" && media.length < 2) error("ig_carousel_media", platform, "Instagram: a carousel needs 2 to 10 photos or videos.");
      if (kind !== "ig_reel") {
        for (const { item, index } of images) {
          if (lim.image_mime.indexOf(publishedImageMime(item)) < 0) error("ig_image_format", platform, `Instagram: photo ${nth(index)} must be a JPEG. Use the JPEG copy Atlas makes in the media editor.`);
          const ratio = Number(item.width) / Number(item.height);
          if (Number.isFinite(ratio) && ratio > 0) {
            if (ratio < lim.aspect_min - 0.005) error("ig_aspect", platform, `Instagram: photo ${nth(index)} is taller than 4:5. Choose the Portrait 4:5 crop.`);
            else if (ratio > lim.aspect_max + 0.005) error("ig_aspect", platform, `Instagram: photo ${nth(index)} is wider than 1.91:1. Choose the Landscape 1.91:1 crop.`);
          }
          if (Number(item.byte_size) > lim.image_max_bytes) error("ig_image_size", platform, `Instagram: photo ${nth(index)} is ${formatBytes(item.byte_size)}; the limit is 8 MB.`);
        }
      }
      for (const { item, index } of videos) {
        if (lim.video_mime.indexOf(String(item.mime_type)) < 0) error("ig_video_format", platform, `Instagram: video ${nth(index)} must be MP4 or MOV.`);
        if (kind === "ig_reel") {
          const ms = Number(item.duration_ms);
          if (Number.isFinite(ms) && ms > 0 && (ms < lim.reel_min_ms || ms > lim.reel_max_ms)) {
            error("ig_reel_duration", platform, `Instagram Reels must be 3 seconds to 15 minutes. This video is ${formatDuration(ms)}.`);
          }
          if (Number(item.byte_size) > lim.reel_max_bytes) error("ig_reel_size", platform, `Instagram Reels can be up to 300 MB. This video is ${formatBytes(item.byte_size)}.`);
        }
      }
      const chars = characterCount(caption);
      if (chars > lim.caption) error("ig_caption_length", platform, `Instagram caption is ${formatNumber(chars)} characters; the limit is 2,200. Shorten it or write a shorter Instagram caption.`);
      const tags = countHashtags(caption);
      if (tags > lim.hashtags) error("ig_hashtags", platform, `Instagram allows up to 30 hashtags. This caption has ${tags}.`);
      const mentions = countMentions(caption);
      if (mentions > lim.mentions) warn("ig_mentions", platform, `Instagram may refuse more than 20 @mentions. This caption has ${mentions}.`);
    } else if (platform === "facebook") {
      const lim = LIMITS.facebook;
      if (!media.length && !caption.trim()) error("fb_empty", platform, "Facebook needs text, a photo or a video.");
      if (videos.length && images.length) error("fb_mixed_media", platform, "Facebook can post several photos or one video, not both. Remove the video or the photos.");
      else if (videos.length > 1) error("fb_too_many_videos", platform, "Facebook can post one video at a time. Remove the extra videos.");
      if ((kind === "fb_page_video" || kind === "fb_reel") && videos.length !== 1) error("fb_video_media", platform, "Facebook: a video post or Reel needs exactly one video.");
      if (kind === "fb_page_photo" && (!images.length || videos.length)) error("fb_photo_media", platform, "Facebook: a photo post needs photos only.");
      if (kind === "fb_page_post" && media.length) error("fb_post_media", platform, "Facebook: a text post has no media. Choose Photo or Video instead.");
      for (const { item, index } of images) {
        if (lim.image_mime.indexOf(publishedImageMime(item)) < 0) error("fb_image_format", platform, `Facebook: photo ${nth(index)} must be a JPEG or PNG. Use the JPEG copy Atlas makes in the media editor.`);
      }
      for (const { item, index } of videos) {
        if (lim.video_mime.indexOf(String(item.mime_type)) < 0) error("fb_video_format", platform, `Facebook: video ${nth(index)} must be MP4 or MOV.`);
        const ms = Number(item.duration_ms);
        if (kind === "fb_reel") {
          if (Number.isFinite(ms) && ms > 0 && (ms < lim.reel_min_ms || ms > lim.reel_max_ms)) warn("fb_reel_duration", platform, `Facebook Reels are usually 3 to 90 seconds. This video is ${formatDuration(ms)}.`);
          if (orientation(item) && orientation(item) !== "portrait") warn("fb_reel_orientation", platform, "Facebook Reels look best as vertical 9:16 video.");
        } else if (Number.isFinite(ms) && ms > lim.video_max_ms) {
          error("fb_video_duration", platform, `Facebook videos from Atlas can be up to 20 minutes. This one is ${formatDuration(ms)}.`);
        }
        if (Number(item.byte_size) > lim.video_max_bytes) error("fb_video_size", platform, `Facebook videos from Atlas can be up to 1 GB. This one is ${formatBytes(item.byte_size)}.`);
      }
      const chars = characterCount(caption);
      if (chars > lim.caption) error("fb_caption_length", platform, `Facebook text is ${formatNumber(chars)} characters; the limit is 63,206.`);
    } else if (platform === "tiktok") {
      const lim = LIMITS.tiktok;
      const tt = nested(own, "tiktok");
      const creator = (tt.creator_info && typeof tt.creator_info === "object" ? tt.creator_info : null)
        || (source.tiktok_creator_info && typeof source.tiktok_creator_info === "object" ? source.tiktok_creator_info : null);
      if (!media.length) error("tiktok_no_media", platform, "TikTok needs one video.");
      else if (images.length) error("tiktok_photo_unsupported", platform, "TikTok posts from Atlas need one video. Photo posts aren't supported yet.");
      else if (videos.length > 1) error("tiktok_one_video", platform, "TikTok posts one video at a time. Remove the extra videos.");
      for (const { item, index } of videos) {
        if (lim.video_mime.indexOf(String(item.mime_type)) < 0) error("tiktok_video_format", platform, `TikTok: video ${nth(index)} must be MP4, MOV or WebM.`);
        const maxSec = creator && Number(creator.max_video_post_duration_sec) > 0 ? Number(creator.max_video_post_duration_sec) : lim.default_max_ms / 1000;
        const ms = Number(item.duration_ms);
        if (Number.isFinite(ms) && ms > maxSec * 1000) error("tiktok_too_long", platform, `TikTok: this account can post videos up to ${formatLimitMinutes(maxSec)}. This one is ${formatDuration(ms)}.`);
      }
      if (String(own.target_kind || "") === "tiktok_video" && kind !== "tiktok_video") {
        warn("tiktok_direct_unavailable", platform, "TikTok: direct posting needs TikTok's approval first. Atlas sends the video to your TikTok inbox instead, and you finish the post in the TikTok app.");
      }
      if (kind === "tiktok_video") {
        const privacy = String(tt.privacy_level || "");
        const allowed = creator && Array.isArray(creator.privacy_level_options) ? creator.privacy_level_options.map(String) : null;
        if (!TIKTOK_PRIVACY_LABELS[privacy]) error("tiktok_privacy", platform, "Choose who can see it on TikTok.");
        else if (allowed && allowed.indexOf(privacy) < 0) {
          error("tiktok_privacy_unavailable", platform, allowed.length && allowed.every((value) => value === "SELF_ONLY")
            ? "Until TikTok approves Atlas, TikTok posts are private (Only me). Choose Only me."
            : `TikTok doesn't offer "${TIKTOK_PRIVACY_LABELS[privacy]}" for this account. Choose who can see it again.`);
        }
        if (tt.commercial_content === true || tt.brand_content_toggle === true || tt.brand_organic_toggle === true) {
          if (tt.commercial_content === true && tt.brand_content_toggle !== true && tt.brand_organic_toggle !== true) {
            error("tiktok_commercial", platform, "Choose whether this promotes your brand, another brand, or both.");
          }
          if (tt.brand_content_toggle === true && privacy === "SELF_ONLY") error("tiktok_branded_private", platform, "Branded content can't be private. Choose Everyone or Friends.");
        }
      }
      const chars = String(caption).length;
      if (chars > lim.caption) error("tiktok_caption_length", platform, `TikTok caption is ${formatNumber(chars)} characters; the limit is 2,200. Shorten it or write a shorter TikTok caption.`);
    } else if (platform === "google-business-profile") {
      const lim = LIMITS["google-business-profile"];
      const g = nested(own, "gbp");
      const topic = String(g.topic_type || "STANDARD").toUpperCase();
      if (videos.length) error("gbp_video", platform, "Google Business Profile can't post videos. Remove the video or turn off Google Business Profile.");
      if (images.length > 1) warn("gbp_extra_photos", platform, "Google Business Profile uses only the first photo.");
      const first = images[0];
      if (first) {
        const item = first.item;
        if (lim.image_mime.indexOf(publishedImageMime(item)) < 0) error("gbp_photo_format", platform, "Google Business Profile photos must be JPEG or PNG. Use the JPEG copy Atlas makes in the media editor.");
        const bytes = Number(item.byte_size);
        if (Number.isFinite(bytes) && bytes > 0 && (bytes < lim.image_min_bytes || bytes > lim.image_max_bytes)) {
          error("gbp_photo_size", platform, `Google Business Profile photos must be 10 KB to 5 MB. This one is ${bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : formatBytes(bytes)}.`);
        }
        if ((Number(item.width) > 0 && Number(item.width) < lim.image_min_side) || (Number(item.height) > 0 && Number(item.height) < lim.image_min_side)) {
          error("gbp_photo_dimensions", platform, "Google Business Profile photos must be at least 250 × 250 pixels.");
        }
      }
      if (["STANDARD", "EVENT", "OFFER"].indexOf(topic) < 0) error("gbp_topic_unsupported", platform, "Google Business Profile: choose Update, Event or Offer.");
      if (topic === "EVENT" || topic === "OFFER") {
        const event = Object.assign({}, g.event || {}, topic === "OFFER" ? g.offer || {} : {});
        const title = String(event.title || "").trim();
        if (!title) error("gbp_event_title", platform, topic === "OFFER" ? "Give the offer a title." : "Give the event a title.");
        else if (title.length > lim.event_title) error("gbp_event_title_length", platform, `Google Business Profile: the title can be up to 58 characters. This one is ${title.length}.`);
        if (!event.start || !event.end) error("gbp_event_dates", platform, "Add when the event starts and ends.");
        else if (Date.parse(event.end) < Date.parse(event.start)) error("gbp_event_order", platform, "The event ends before it starts.");
      }
      if (topic !== "OFFER" && g.call_to_action && g.call_to_action.action_type) {
        const action = String(g.call_to_action.action_type).toUpperCase();
        const url = String(g.call_to_action.url || "").trim();
        if (GBP_ACTIONS.indexOf(action) < 0) error("gbp_cta_unsupported", platform, "Google Business Profile: choose a button from the list.");
        else if (action !== "CALL") {
          if (!url) error("gbp_cta_link", platform, "Add the link the button opens.");
          else if (!/^https:\/\/[^\s]+$/.test(url)) error("gbp_cta_https", platform, "Enter a full link starting with https://");
        }
      }
      if (topic === "OFFER" && g.offer && g.offer.redeem_online_url && !/^https:\/\/[^\s]+$/.test(String(g.offer.redeem_online_url))) {
        error("gbp_offer_link", platform, "Enter a full link starting with https://");
      }
      if (containsPhoneNumber(caption)) error("gbp_phone", platform, "Google removes posts with a phone number in the text. Use the Call now button instead.");
      const chars = characterCount(caption);
      if (chars > lim.caption) error("gbp_caption_length", platform, `Google Business Profile text is ${formatNumber(chars)} characters; the limit is 1,500. Shorten it or write a shorter Google caption.`);
      if (!caption.trim() && !media.length) error("gbp_empty", platform, "Google Business Profile needs text or a photo.");
    }

    if (!altWarned && (platform === "instagram" || platform === "facebook")) {
      for (const { item, index } of images) {
        if (!String(item.alt_text || "").trim() && item.alt_text !== undefined) {
          warn("missing_alt", platform, `Photo ${nth(index)} has no alt text. Add it so people using screen readers know what it shows.`);
          altWarned = true;
          break;
        }
      }
    }
  }

  return { errors, warnings, target_kinds: targetKinds };
}
