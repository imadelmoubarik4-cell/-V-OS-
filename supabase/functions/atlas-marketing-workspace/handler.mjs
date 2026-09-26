// atlas-marketing-workspace: the Marketing gateway (plan, approve, publish).
//
// Plain ESM with injected dependencies so every action is unit-testable in
// Node (tests/node/marketing-gateway-s94.test.js):
//   createMarketingHandler({ env, fetchImpl, now, resolveActor?, waitUntil? })
//     env(name)            -> function secret / setting (or an object / Deno.env)
//     fetchImpl(url, init) -> fetch (service-role RPC, Storage signing, worker wake)
//     now()                -> epoch milliseconds
//     resolveActor(request)-> { token, userId, profile } (default: _shared/auth.mjs)
//
// Rules (docs/marketing/S94_Publishing_Architecture.md §0, §6, §8):
// - Every action authenticates the caller; S94 publishing actions are for
//   managers and administrators only, and the SQL checks the role again.
// - The browser never receives tokens, signed provider URLs, storage paths of
//   originals or the worker secret. Media thumbnails are 5-minute signed
//   Storage URLs, signed here in one batch per response.
// - Publish now is not a second path: the RPC makes the deliveries due and this
//   gateway only wakes the worker (fire and forget; the cron tick is the
//   fallback). This gateway never calls a social provider.
// - The venue date comes from the database (snapshot / venue clock RPC).

import { AuthError, actorLabel, authConfig, resolveActor as sharedResolveActor } from "../_shared/auth.mjs";
import { readTikTokCreatorInfo } from "../_shared/integrations/credentials.mjs";

export const FUNCTION_VERSION = "0.2.0";

export const CORS_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  vary: "authorization",
});

export const WRITE_ROLES = new Set(["admin", "manager", "bartender"]);
export const MANAGER_ROLES = new Set(["admin", "manager"]);
export const PLATFORM_KEYS = new Set(["instagram", "facebook", "tiktok", "google-business-profile"]);
const CONTENT_TYPES = new Set(["post", "story", "reel", "campaign_task", "event_promotion", "content_idea", "google_post"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const CAMPAIGN_TYPES = new Set(["promotion", "event", "seasonal", "always_on", "brand", "other"]);
const APPROVAL_DECISIONS = new Set(["approved", "changes_requested", "rejected"]);
const MEDIA_ROLES = new Set(["primary", "cover", "item", "thumbnail"]);
const MAX_BODY_BYTES = 96 * 1024;
const MAX_MEDIA_ITEMS = 35;
const THUMB_TTL_SECONDS = 300;
const WAKE_TIMEOUT_MS = 2500;
export const MEDIA_BUCKET = "atlas-marketing-media";
export const PUBLISHER_FUNCTION = "atlas-marketing-publisher";

// Service-role RPCs (public wrappers; each re-checks the role in SQL).
export const RPC = Object.freeze({
  snapshot: "atlas_marketing_workspace_snapshot",
  recommendations: "atlas_marketing_recommendations",
  venueClock: "atlas_settings_venue_clock",
  createCampaign: "atlas_marketing_create_campaign",
  createContent: "atlas_marketing_create_content",
  updateContent: "atlas_marketing_update_content",
  submitApproval: "atlas_marketing_submit_approval",
  decideApproval: "atlas_marketing_decide_approval",
  markPublished: "atlas_marketing_mark_published",
  markCompleted: "atlas_marketing_mark_completed",
  convertRecommendation: "atlas_marketing_convert_recommendation_occurrence",
  dismissRecommendation: "atlas_marketing_dismiss_recommendation_occurrence",
  // S94 (actor RPCs resolve the role from the active profile again in SQL)
  patchContent: "atlas_marketing_update_content", // overload (p_actor_id, p_content_id, p_expected_version, p_patch, p_note)
  cancelContent: "atlas_marketing_content_cancel",
  rescheduleContent: "atlas_marketing_content_reschedule",
  duplicateContent: "atlas_marketing_content_duplicate",
  setContentMedia: "atlas_marketing_content_media_set",
  publishNow: "atlas_marketing_publish_now",
  deliveryAction: "atlas_marketing_delivery_manager_action",
  history: "atlas_marketing_publication_history",
  publishTargets: "atlas_integration_publish_targets",
});

// Field names that must never reach the browser (tokens, secrets, provider
// upload/signed URLs, storage paths of originals, claim tokens).
const SECRET_KEY = /(^|_)(access_token|refresh_token|id_token|token|secret|client_secret|ciphertext|nonce|kek|claim_token|lease_token|signed_url|upload_url|upload_token|authorization|password)$/i;
const PATH_KEY = /(^|_)(storage_path|path|object_path|bucket)$/i;

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const STATUS_CODES = { 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 409: "conflict", 413: "too_large", 503: "unavailable" };

// ---------- pure helpers (exported for tests) ----------

export function findSecretKeys(value, path = "$") {
  const hits = [];
  if (Array.isArray(value)) value.forEach((entry, index) => hits.push(...findSecretKeys(entry, `${path}[${index}]`)));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) hits.push(`${path}.${key}`);
      hits.push(...findSecretKeys(child, `${path}.${key}`));
    }
  }
  return hits;
}

// Deep copy without credential-shaped or storage-path fields. Media rows keep
// their ids, kinds, sizes and the signed thumb_url added by signMedia().
export function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || PATH_KEY.test(key)) continue;
    out[key] = scrub(child);
  }
  return out;
}

export function jsonResponse(value, status = 200) {
  let body = value;
  if (findSecretKeys(body).length) {
    body = { error: "The Marketing response was withheld because it contained credential fields.", error_code: "internal" };
    status = 500;
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-marketing-version": FUNCTION_VERSION,
    },
  });
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function requireUuid(value, label) {
  if (!isUuid(value)) throw new ApiError(400, `${label} is invalid.`);
  return value.toLowerCase();
}
function optionalUuid(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return requireUuid(value, label);
}
function optionalText(value, maxLength) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, "A text field is invalid.");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new ApiError(400, `Text is limited to ${maxLength} characters.`);
  return normalized;
}
function requiredText(value, label, maxLength) {
  const normalized = optionalText(value, maxLength);
  if (!normalized) throw new ApiError(400, `${label} is required.`);
  return normalized;
}
function requireEnum(value, label, allowed) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!allowed.has(normalized)) throw new ApiError(400, `${label} is invalid.`);
  return normalized;
}
function dateOnly(value, label) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(400, `${label} must use YYYY-MM-DD.`);
  if (Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) throw new ApiError(400, `${label} is invalid.`);
  return value;
}
// An instant. It must carry an offset or Z: a bare wall-clock time would be
// read in the server's zone, never the venue's.
function dateTime(value, label) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) throw new ApiError(400, `${label} is invalid.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ApiError(400, `${label} is invalid.`);
  return parsed.toISOString();
}
function stringArray(value, label, allowed, maxItems = 8) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError(400, `${label} must be a list.`);
  const normalized = [...new Set(value.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean))];
  if (normalized.length > maxItems || normalized.some((entry) => !allowed.has(entry))) throw new ApiError(400, `${label} contains an unsupported value.`);
  return normalized;
}
function jsonArray(value, label, maxItems = 20) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new ApiError(400, `${label} must be a valid list.`);
  return value;
}
function jsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, `${label} must be a valid object.`);
  return value;
}
function expectedVersion(value, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new ApiError(400, "The post version is missing. Reload and try again.");
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 2_000_000_000) throw new ApiError(400, "The post version is invalid.");
  return number;
}
const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key);

// Per-platform options (§5.1). Only known keys pass; values are bounded. The
// SQL and the worker's rules decide what is valid for publishing.
const TIKTOK_PRIVACY = new Set(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]);
const TARGET_KINDS = new Set(["ig_feed", "ig_carousel", "ig_reel", "fb_page_post", "fb_page_photo", "fb_page_video", "fb_reel", "tiktok_video", "tiktok_inbox_video", "gbp_local_post"]);
const GBP_TOPICS = new Set(["STANDARD", "EVENT", "OFFER", "ALERT"]);
const GBP_ACTIONS = new Set(["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]);
function httpsUrl(value, label) {
  const text = optionalText(value, 2000);
  if (!text) return null;
  let parsed;
  try { parsed = new URL(text); } catch { throw new ApiError(400, `${label} must be a full link starting with https://`); }
  if (parsed.protocol !== "https:") throw new ApiError(400, `${label} must be a full link starting with https://`);
  return parsed.href;
}
function bool(value) { return value === true; }

// TikTok Direct Post needs the music-usage (and, for branded content, the
// Branded Content Policy) consent recorded: the time comes from the browser
// (when the manager ticked it, bounded here) and consent_by is always the
// person saving it, never a browser-supplied id.
function consentTime(value, nowMs) {
  if (value === null || value === undefined || value === "") return null;
  const iso = dateTime(value, "TikTok consent time");
  const at = Date.parse(iso);
  if (at > nowMs + 5 * 60 * 1000 || at < nowMs - 400 * 24 * 3600 * 1000) throw new ApiError(400, "The TikTok confirmation time is invalid. Tick it again.");
  return iso;
}

export function platformOptions(value, { actorId = null, nowMs = Date.now() } = {}) {
  const input = jsonObject(value, "Platform options");
  const out = {};
  for (const [platform, raw] of Object.entries(input)) {
    if (!PLATFORM_KEYS.has(platform)) throw new ApiError(400, "Platform options contain an unsupported channel.");
    const options = jsonObject(raw, "Platform options");
    const entry = {};
    if (has(options, "caption")) entry.caption = optionalText(options.caption, 10000);
    if (has(options, "target_kind") && options.target_kind !== null && options.target_kind !== "") entry.target_kind = requireEnum(options.target_kind, "Format", TARGET_KINDS);
    if (has(options, "crop") && options.crop !== null) entry.crop = optionalText(options.crop, 20);
    if (platform === "tiktok" && options.tiktok) {
      const t = jsonObject(options.tiktok, "TikTok options");
      const privacy = typeof t.privacy_level === "string" && t.privacy_level ? t.privacy_level.trim().toUpperCase() : null;
      if (privacy && !TIKTOK_PRIVACY.has(privacy)) throw new ApiError(400, "TikTok privacy is invalid.");
      entry.tiktok = {
        privacy_level: privacy,
        disable_comment: t.disable_comment !== false,
        disable_duet: t.disable_duet !== false,
        disable_stitch: t.disable_stitch !== false,
        brand_content_toggle: bool(t.brand_content_toggle),
        brand_organic_toggle: bool(t.brand_organic_toggle),
        consent_confirmed_at: consentTime(t.consent_confirmed_at, nowMs),
        consent_by: null,
      };
      if (entry.tiktok.consent_confirmed_at) {
        if (!actorId) throw new ApiError(400, "The TikTok confirmation needs a signed-in manager.");
        entry.tiktok.consent_by = actorId;
      }
      if (entry.tiktok.brand_content_toggle && privacy === "SELF_ONLY") throw new ApiError(400, "Branded content can't be private. Choose Everyone or Friends.");
    }
    if (platform === "google-business-profile" && options.gbp) {
      const g = jsonObject(options.gbp, "Google options");
      const gbp = { topic_type: g.topic_type ? requireEnum(String(g.topic_type).toLowerCase(), "Google post type", new Set([...GBP_TOPICS].map((x) => x.toLowerCase()))).toUpperCase() : "STANDARD" };
      if (g.call_to_action && g.call_to_action.action_type) {
        const actionType = requireEnum(String(g.call_to_action.action_type).toLowerCase(), "Google button", new Set([...GBP_ACTIONS].map((x) => x.toLowerCase()))).toUpperCase();
        gbp.call_to_action = { action_type: actionType, url: actionType === "CALL" ? null : httpsUrl(g.call_to_action.url, "Button link") };
      }
      if (g.event) {
        const e = jsonObject(g.event, "Google event");
        gbp.event = { title: optionalText(e.title, 58), start: dateTime(e.start, "Event start"), end: dateTime(e.end, "Event end") };
        if (gbp.event.start && gbp.event.end && gbp.event.end < gbp.event.start) throw new ApiError(400, "The event ends before it starts.");
      }
      if (g.offer) {
        const o = jsonObject(g.offer, "Google offer");
        gbp.offer = { coupon_code: optionalText(o.coupon_code, 58), redeem_online_url: httpsUrl(o.redeem_online_url, "Redeem online link"), terms: optionalText(o.terms, 5000) };
      }
      entry.gbp = gbp;
    }
    out[platform] = entry;
  }
  return out;
}

// The full create payload (unchanged contract) ...
function contentPayload(body, resolveOwner) {
  const eventStartsAt = dateTime(body.event_starts_at, "Event start");
  const eventEndsAt = dateTime(body.event_ends_at, "Event end");
  if (eventStartsAt && eventEndsAt && new Date(eventEndsAt) < new Date(eventStartsAt)) throw new ApiError(400, "Event end cannot precede event start.");
  return {
    campaign_id: optionalUuid(body.campaign_id, "Campaign"),
    title: requiredText(body.title, "Title", 180),
    content_type: requireEnum(body.content_type, "Content type", CONTENT_TYPES),
    priority: requireEnum(body.priority ?? "normal", "Priority", PRIORITIES),
    platforms: stringArray(body.platforms, "Platforms", PLATFORM_KEYS, 4),
    scheduled_for: dateTime(body.scheduled_for, "Scheduled time"),
    reminder_at: dateTime(body.reminder_at, "Reminder time"),
    event_starts_at: eventStartsAt,
    event_ends_at: eventEndsAt,
    suggested_format: optionalText(body.suggested_format, 2000),
    caption_draft: optionalText(body.caption_draft, 10000),
    creative_brief: optionalText(body.creative_brief, 10000),
    frames: jsonArray(body.frames, "Frames", 20),
    media_requirements: jsonObject(body.media_requirements, "Media requirements"),
    metadata: jsonObject(body.metadata, "Metadata"),
    owner: resolveOwner,
  };
}

// ... and the partial patch: only fields the caller sent, so a save never
// clears frames, the brief, event times or the owner it did not touch (audit §9.1).
const PATCH_FIELDS = {
  title: (v) => requiredText(v, "Title", 180),
  campaign_id: (v) => optionalUuid(v, "Campaign"),
  priority: (v) => requireEnum(v, "Priority", PRIORITIES),
  platforms: (v) => stringArray(v, "Platforms", PLATFORM_KEYS, 4),
  scheduled_for: (v) => dateTime(v, "Scheduled time"),
  reminder_at: (v) => dateTime(v, "Reminder time"),
  event_starts_at: (v) => dateTime(v, "Event start"),
  event_ends_at: (v) => dateTime(v, "Event end"),
  suggested_format: (v) => optionalText(v, 2000),
  caption_draft: (v) => optionalText(v, 10000),
  creative_brief: (v) => optionalText(v, 10000),
  frames: (v) => jsonArray(v, "Frames", 20),
  media_requirements: (v) => jsonObject(v, "Media requirements"),
  platform_options: (v, ctx) => platformOptions(v, ctx),
};
export function contentPatch(body, ctx = {}) {
  const patch = {};
  for (const [key, parse] of Object.entries(PATCH_FIELDS)) if (has(body, key)) patch[key] = parse(body[key], ctx);
  if (patch.event_starts_at && patch.event_ends_at && patch.event_ends_at < patch.event_starts_at) throw new ApiError(400, "Event end cannot precede event start.");
  return patch;
}

export function mediaItems(value) {
  if (!Array.isArray(value) || value.length > MAX_MEDIA_ITEMS) throw new ApiError(400, `Media must be a list of up to ${MAX_MEDIA_ITEMS} items.`);
  const seen = new Set();
  return value.map((raw, index) => {
    const item = jsonObject(raw, "Media item");
    const assetId = requireUuid(item.asset_id, "Media item");
    const platform = item.platform ? requireEnum(item.platform, "Media channel", PLATFORM_KEYS) : null;
    const variantId = optionalUuid(item.variant_id, "Media variant");
    const key = `${assetId}|${platform ?? ""}|${variantId ?? ""}`;
    if (seen.has(key)) throw new ApiError(400, "The same photo or video is in the list twice.");
    seen.add(key);
    return {
      asset_id: assetId,
      variant_id: variantId,
      collection_id: optionalUuid(item.collection_id, "Collection"),
      platform,
      role: item.role ? requireEnum(item.role, "Media role", MEDIA_ROLES) : index === 0 ? "cover" : "item",
      position: index,
    };
  });
}

function envReader(env) {
  if (typeof env === "function") return (name) => { const v = env(name); return v === undefined || v === null ? undefined : String(v); };
  if (env && typeof env.get === "function") return (name) => { const v = env.get(name); return v === undefined || v === null ? undefined : String(v); };
  return (name) => { const v = env?.[name]; return v === undefined || v === null ? undefined : String(v); };
}

// A failed service-role RPC: fixed wording by class. Known business errors
// carry an `atlas:<code>` hint or a code word in the message.
export function rpcFailure(status, parsed) {
  const code = String(parsed?.code ?? "");
  const message = String(parsed?.message ?? "");
  const hint = String(parsed?.hint ?? "");
  const text = `${message} ${hint}`;
  const atlasCode = (hint.match(/atlas:([a-z_]+)/) || [])[1] ?? "";
  if (atlasCode === "in_flight") return new ApiError(409, "This post is being published right now. Wait until it finishes, then try again.", { error_code: "in_flight" });
  if (atlasCode === "attestation_required") return new ApiError(409, "This channel may already have the post. Check it on the platform, then confirm it wasn't posted before retrying.", { error_code: "attestation_required" });
  if (atlasCode === "forbidden") return new ApiError(403, "This action is limited to managers and administrators.", { error_code: "forbidden" });
  if (atlasCode === "not_found") return new ApiError(404, "That post or channel no longer exists.", { error_code: "not_found" });
  if (atlasCode === "superseded") return new ApiError(409, "This post was edited after approval, so it needs approval again before it can publish.", { error_code: "superseded" });
  if (atlasCode === "conflict") return new ApiError(409, "This can't be done in the post's current state. It has been reloaded.", { error_code: "conflict" });
  if (/stale_request/i.test(text) || code === "40001") return new ApiError(409, "This post changed while you were working. It has been reloaded; check it and try again.", { error_code: "stale_request" });
  if (/automatic_publishing_disabled/i.test(text)) return new ApiError(409, "Automatic publishing is off. An administrator can turn it on in Settings › Marketing.", { error_code: "automatic_publishing_disabled" });
  if (/not_approved|approval_required/i.test(text)) return new ApiError(409, "This post needs approval before it can be published.", { error_code: "not_approved" });
  if (/not_retryable|invalid_transition|illegal delivery transition/i.test(text)) return new ApiError(409, "This channel can't be retried in its current state.", { error_code: "invalid_state" });
  if (status === 403 || code === "42501") return new ApiError(403, "This action is limited to managers and administrators.", { error_code: "forbidden" });
  if (code === "P0002" || status === 404 || /not found/i.test(message)) return new ApiError(404, "That post or channel no longer exists.", { error_code: "not_found" });
  if (code === "23505") return new ApiError(409, "This was already saved.", { error_code: "conflict" });
  if (status >= 400 && status < 500) {
    // Validation messages written for people (P0001 / 22023 / 23514) pass
    // through, bounded; anything else is a fixed sentence.
    const safe = /^[\p{L}\p{N} .,;:'’()!?%/+&-]{1,240}$/u.test(message) && !/(select|insert|update|delete|relation|column|function|schema|constraint)\b/i.test(message);
    return new ApiError(400, safe ? message : "The request was not valid. Nothing was changed.", { error_code: "invalid_request" });
  }
  return new ApiError(503, "The Marketing workspace is temporarily unavailable.", { error_code: "unavailable" });
}

// ---------- handler ----------

export function createMarketingHandler(deps = {}) {
  const env = envReader(deps.env);
  const envObject = { get: env };
  const fetchImpl = (input, init) => (deps.fetchImpl ?? globalThis.fetch)(input, init);
  const now = deps.now ?? (() => Date.now());
  const waitUntil = deps.waitUntil ?? null;
  const resolveActor = deps.resolveActor ?? (async (request) => {
    const actor = await sharedResolveActor(request, envObject, fetchImpl, {
      inactiveMessage: "This Atlas profile is inactive. Marketing workspace access has been removed.",
    });
    return { token: actor.token, userId: actor.userId, profile: actor.profile };
  });

  function serviceConfig() {
    const base = String(env("SUPABASE_URL") ?? "").replace(/\/+$/, "");
    const key = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!base || !key) throw new ApiError(503, "The private Marketing workspace service is unavailable.", { error_code: "unavailable" });
    return { base, key };
  }

  async function rpc(name, payload = {}) {
    const { base, key } = serviceConfig();
    let response;
    try {
      response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json", "cache-control": "no-store" },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new ApiError(503, "The Marketing workspace is temporarily unavailable.", { error_code: "unavailable" });
    }
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      console.warn("[atlas-marketing-workspace] rpc failed", name, response.status, parsed?.code ?? "-");
      throw rpcFailure(response.status, parsed);
    }
    return parsed;
  }

  // Batch-sign thumbnails (5 minutes). Paths come only from the database.
  async function signPaths(paths) {
    const unique = [...new Set(paths.filter((p) => typeof p === "string" && p && !p.includes("..")))];
    if (!unique.length) return new Map();
    const { base, key } = serviceConfig();
    try {
      const response = await fetchImpl(`${base}/storage/v1/object/sign/${MEDIA_BUCKET}`, {
        method: "POST",
        headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: THUMB_TTL_SECONDS, paths: unique }),
      });
      if (!response.ok) return new Map();
      const rows = await response.json().catch(() => []);
      const map = new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        const signed = row?.signedURL ?? row?.signedUrl;
        if (row?.path && typeof signed === "string" && !row.error) map.set(row.path, `${base}/storage/v1${signed.startsWith("/") ? "" : "/"}${signed}`);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  const thumbPathOf = (media) => media?.thumb_path ?? media?.thumbnail_path ?? media?.thumb_storage_path ?? media?.poster_path ?? null;

  // Adds thumb_url + thumb_expires_at to every media entry found under
  // content items (and history), then drops every path field.
  async function signMedia(containers) {
    const entries = [];
    const visit = (list) => { for (const m of Array.isArray(list) ? list : []) if (m && typeof m === "object") entries.push(m); };
    for (const item of containers) visit(item?.media);
    const map = await signPaths(entries.map(thumbPathOf));
    const expiresAt = new Date(now() + THUMB_TTL_SECONDS * 1000).toISOString();
    for (const media of entries) {
      const url = map.get(thumbPathOf(media));
      media.thumb_url = url ?? null;
      media.thumb_expires_at = url ? expiresAt : null;
    }
  }

  async function venueDate(context) {
    try {
      const clock = await rpc(RPC.venueClock, { p_actor_role: context.profile.role, p_actor_id: context.userId });
      if (clock && /^\d{4}-\d{2}-\d{2}$/.test(String(clock.venue_date ?? ""))) return String(clock.venue_date);
    } catch { /* fall through */ }
    throw new ApiError(503, "The venue clock is unavailable. Try again in a moment.", { error_code: "unavailable" });
  }

  function monthRange(rawStart, rawEnd, today) {
    const start = dateOnly(rawStart, "Start date");
    const end = dateOnly(rawEnd, "End date");
    let s = start;
    let e = end;
    if (!s || !e) {
      const [year, month] = String(today).split("-").map(Number);
      s = s ?? `${year}-${String(month).padStart(2, "0")}-01`;
      e = e ?? new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    }
    const difference = Math.round((new Date(`${e}T00:00:00Z`).getTime() - new Date(`${s}T00:00:00Z`).getTime()) / 86400000);
    if (difference < 0 || difference > 92) throw new ApiError(400, "Calendar range must be between 1 and 93 days.");
    return { start: s, end: e };
  }

  async function resolveRange(context, rawStart, rawEnd) {
    if (dateOnly(rawStart, "Start date") && dateOnly(rawEnd, "End date")) return monthRange(rawStart, rawEnd, null);
    return monthRange(rawStart, rawEnd, await venueDate(context));
  }

  async function activeProfiles(context) {
    const { projectUrl, publishableKey } = authConfig(envObject);
    const url = new URL(`${projectUrl}/rest/v1/profiles`);
    url.searchParams.set("select", "id,email,display_name,role,active");
    url.searchParams.set("active", "eq.true");
    url.searchParams.set("order", "display_name.asc.nullslast,email.asc");
    url.searchParams.set("limit", "500");
    try {
      const response = await fetchImpl(url.href, { headers: { apikey: publishableKey, authorization: `Bearer ${context.token}`, accept: "application/json", "cache-control": "no-store" } });
      if (!response.ok) return [];
      const rows = await response.json().catch(() => []);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  const memberPayload = (members) => members.map((m) => ({ id: m.id, label: actorLabel(m), role: m.role }));

  function staffPayload(context) {
    const role = context.profile.role;
    const manager = MANAGER_ROLES.has(role);
    return {
      id: context.userId,
      label: actorLabel(context.profile),
      role,
      active: true,
      can_create: WRITE_ROLES.has(role),
      can_approve: manager,
      can_mark_published: manager,
      can_manage_connections: manager,
      can_publish: manager,
      can_manage_media: manager,
      can_set_automatic_publishing: role === "admin",
    };
  }

  function requireWriter(context) {
    if (!WRITE_ROLES.has(context.profile.role)) throw new ApiError(403, "This profile can view marketing plans but cannot create or edit them.", { error_code: "forbidden" });
  }
  function requireManager(context) {
    if (!MANAGER_ROLES.has(context.profile.role)) throw new ApiError(403, "This action is limited to managers and administrators.", { error_code: "forbidden" });
  }

  function actorArgs(context) {
    return { p_actor_id: context.userId, p_actor_label: actorLabel(context.profile), p_actor_role: context.profile.role };
  }

  async function publishTargets(context) {
    try {
      const rows = await rpc(RPC.publishTargets, {});
      return Array.isArray(rows) ? scrub(rows) : [];
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) throw error;
      return [];
    }
  }

  // Derived counts for Overview and the tab badges (never trusted for gating).
  function attentionCounts(items, today) {
    const counts = { failed_deliveries: 0, needs_attention: 0, waiting_approval: 0, ready_not_sent: 0 };
    for (const item of items) {
      if (item?.status === "pending_approval") counts.waiting_approval += 1;
      if (item?.publication_state === "ready_not_sent") counts.ready_not_sent += 1;
      for (const d of Array.isArray(item?.deliveries) ? item.deliveries : []) {
        if (d?.status === "failed") counts.failed_deliveries += 1;
        if (d?.status === "needs_attention") counts.needs_attention += 1;
      }
    }
    counts.total = counts.failed_deliveries + counts.needs_attention;
    counts.venue_date = today ?? null;
    return counts;
  }

  async function workspaceSnapshot(context, range, { withMembers = true } = {}) {
    const [workspace, members] = await Promise.all([
      rpc(RPC.snapshot, { p_user_id: context.userId, p_user_role: context.profile.role, p_start_date: range.start, p_end_date: range.end }),
      withMembers ? activeProfiles(context) : Promise.resolve([]),
    ]);
    const snapshot = workspace && typeof workspace === "object" ? workspace : {};
    const today = /^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.venue_date ?? "")) ? snapshot.venue_date : await venueDate(context);
    const needTargets = !Array.isArray(snapshot.publish_targets);
    const [recommendations, targets] = await Promise.all([
      rpc(RPC.recommendations, { p_local_date: today }).catch(() => []),
      needTargets ? publishTargets(context) : Promise.resolve(snapshot.publish_targets),
    ]);
    const items = Array.isArray(snapshot.content_items) ? snapshot.content_items : [];
    await signMedia(items);
    const clean = scrub({
      ...snapshot,
      venue_date: today,
      recommendations: Array.isArray(recommendations) ? recommendations : [],
      publish_targets: targets,
      automatic_publishing_enabled: snapshot.automatic_publishing_enabled === true,
    });
    clean.attention = snapshot.attention && typeof snapshot.attention === "object" ? scrub(snapshot.attention) : attentionCounts(clean.content_items ?? [], today);
    return { workspace: clean, members: memberPayload(members) };
  }

  function policy(workspace) {
    return {
      publishing_via_worker: true,
      automatic_publishing_enabled: workspace?.automatic_publishing_enabled === true,
      manager_approval_required: true,
      analytics_ingestion_enabled: false,
      oauth_tokens_in_browser: false,
      provider_calls_from_gateway: false,
      history_preserved: true,
    };
  }

  // Fire and forget: the worker claims whatever is due. A failed wake is not
  // an error (the cron tick publishes within a minute). The secret goes only
  // in this server-side header, never into a response or a log line.
  function wakePublisher() {
    const secret = env("ATLAS_MARKETING_PUBLISHER_SECRET");
    const base = String(env("SUPABASE_URL") ?? "").replace(/\/+$/, "");
    if (!secret || !base) return Promise.resolve(false);
    const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(WAKE_TIMEOUT_MS) : undefined;
    const promise = Promise.resolve()
      .then(() => fetchImpl(`${base}/functions/v1/${PUBLISHER_FUNCTION}?action=kick`, {
        method: "POST",
        headers: { "x-atlas-publisher-secret": secret, "content-type": "application/json" },
        body: JSON.stringify({ reason: "publish-now" }),
        signal,
      }))
      .then((response) => { try { response?.body?.cancel?.(); } catch { /* ignore */ } return Boolean(response?.ok); })
      .catch(() => false);
    if (waitUntil) { try { waitUntil(promise); return Promise.resolve(true); } catch { /* await below */ } }
    return promise;
  }

  async function readJson(request) {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.");
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.");
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      return parsed;
    } catch {
      throw new ApiError(400, "Request body must be valid JSON.");
    }
  }

  async function ownerFor(context, body) {
    const ownerId = optionalUuid(body.owner_id, "Owner");
    if (!ownerId) return { id: null, label: null };
    const member = (await activeProfiles(context)).find((profile) => profile.id === ownerId);
    if (!member) throw new ApiError(404, "The selected owner is no longer an active Atlas profile.");
    return { id: member.id, label: actorLabel(member) };
  }

  // ---- GET actions ----

  async function handleGet(context, url, action) {
    if (action === "snapshot") {
      const range = await resolveRange(context, url.searchParams.get("start"), url.searchParams.get("end"));
      const payload = await workspaceSnapshot(context, range);
      return { ...payload, staff: staffPayload(context), policy: policy(payload.workspace) };
    }
    if (action === "history") {
      requireManager(context);
      const contentId = requireUuid(url.searchParams.get("content_id"), "Post");
      const history = await rpc(RPC.history, { p_actor_id: context.userId, p_content_id: contentId });
      const value = history && typeof history === "object" ? history : {};
      if (value.content) await signMedia([value.content]);
      return { history: scrub(value), staff: staffPayload(context) };
    }
    if (action === "publish-targets") {
      requireManager(context);
      return { publish_targets: await publishTargets(context), staff: staffPayload(context) };
    }
    if (action === "tiktok-creator-info") {
      requireManager(context);
      return { creator_info: await tiktokCreatorInfo(context) };
    }
    throw new ApiError(404, "Unknown Marketing workspace action.");
  }

  // Live TikTok creator info (nickname, privacy options, disabled
  // interactions, max duration) through the S94B credential module. Nothing
  // is cached and the token never leaves server memory.
  async function tiktokCreatorInfo(context) {
    const reader = deps.readTikTokCreatorInfo ?? readTikTokCreatorInfo;
    try {
      const info = await reader({ rpc, env, fetchImpl, now }, { actorId: context.userId, actorRole: context.profile.role, actorLabel: actorLabel(context.profile) });
      if (!info || typeof info !== "object") return { available: false, reason: "unavailable" };
      const safe = scrub(info);
      return {
        available: true,
        nickname: typeof safe.creator_nickname === "string" ? safe.creator_nickname : typeof safe.nickname === "string" ? safe.nickname : null,
        username: typeof safe.creator_username === "string" ? safe.creator_username : typeof safe.username === "string" ? safe.username : null,
        privacy_level_options: Array.isArray(safe.privacy_level_options) ? safe.privacy_level_options.filter((x) => TIKTOK_PRIVACY.has(x)) : [],
        comment_disabled: safe.comment_disabled === true,
        duet_disabled: safe.duet_disabled === true,
        stitch_disabled: safe.stitch_disabled === true,
        max_video_post_duration_sec: Number.isFinite(Number(safe.max_video_post_duration_sec)) ? Number(safe.max_video_post_duration_sec) : null,
        direct_post_allowed: safe.direct_post_allowed === true,
      };
    } catch (error) {
      const code = String(error?.code ?? "");
      const reason = /reauth|expired|invalid_grant/i.test(code) || error?.reauthorize === true ? "needs_reauthorization" : code === "not_connected" ? "not_connected" : "unavailable";
      return { available: false, reason };
    }
  }

  // ---- POST actions ----

  async function handlePost(context, action, body) {
    const actor = actorArgs(context);
    switch (action) {
      case "create-campaign": {
        requireManager(context);
        const startDate = dateOnly(body.campaign_start_date, "Campaign start date");
        const endDate = dateOnly(body.campaign_end_date, "Campaign end date");
        if (startDate && endDate && endDate < startDate) throw new ApiError(400, "Campaign end date cannot precede its start date.");
        return rpc(RPC.createCampaign, {
          p_name: requiredText(body.name, "Campaign name", 180),
          p_description: optionalText(body.description, 5000),
          p_campaign_type: requireEnum(body.campaign_type ?? "always_on", "Campaign type", CAMPAIGN_TYPES),
          p_objective: optionalText(body.objective, 3000),
          p_target_audience: optionalText(body.target_audience, 3000),
          p_platforms: stringArray(body.platforms, "Platforms", PLATFORM_KEYS, 4),
          p_start_date: startDate,
          p_end_date: endDate,
          ...actor,
        });
      }
      case "create-content": {
        requireWriter(context);
        const content = contentPayload(body);
        const owner = await ownerFor(context, body);
        const created = await rpc(RPC.createContent, {
          p_client_request_id: requireUuid(body.client_request_id, "Client request ID"),
          p_campaign_id: content.campaign_id,
          p_title: content.title,
          p_content_type: content.content_type,
          p_priority: content.priority,
          p_platforms: content.platforms,
          p_scheduled_for: content.scheduled_for,
          p_reminder_at: content.reminder_at,
          p_event_starts_at: content.event_starts_at,
          p_event_ends_at: content.event_ends_at,
          p_suggested_format: content.suggested_format,
          p_caption_draft: content.caption_draft,
          p_creative_brief: content.creative_brief,
          p_frames: content.frames,
          p_media_requirements: content.media_requirements,
          p_owner_id: owner.id,
          p_owner_label: owner.label,
          ...actor,
          p_metadata: content.metadata,
        });
        // S94: options and media ride on the same save (managers only; the
        // SQL re-checks). The new id comes from the RPC result, never a diff.
        const contentId = created?.content_id ?? created?.id ?? created?.content?.id ?? null;
        const options = has(body, "platform_options") ? platformOptions(body.platform_options, { actorId: context.userId, nowMs: now() }) : null;
        const media = has(body, "media") ? mediaItems(body.media) : null;
        if ((options || media) && contentId && MANAGER_ROLES.has(context.profile.role) && created?.duplicate !== true) {
          let version = Number(created?.content?.version ?? 1);
          if (options && Object.keys(options).length) {
            const patched = await rpc(RPC.patchContent, { p_actor_id: context.userId, p_content_id: contentId, p_expected_version: version, p_patch: { platform_options: options }, p_note: null });
            version = Number(patched?.content?.version ?? version + 1);
          }
          if (media && media.length) await rpc(RPC.setContentMedia, { p_actor_id: context.userId, p_content_id: contentId, p_items: media });
        }
        return contentId ? { ...created, content_id: contentId } : created;
      }
      case "update-content": {
        requireWriter(context);
        const contentId = requireUuid(body.content_id, "Content item");
        const patch = contentPatch(body, { actorId: context.userId, nowMs: now() });
        if (has(body, "owner_id")) {
          const owner = await ownerFor(context, body);
          patch.owner_id = owner.id;
          patch.owner_label = owner.label;
        }
        if (has(body, "platform_options")) requireManager(context);
        if (!Object.keys(patch).length) throw new ApiError(400, "Nothing to save.");
        return rpc(RPC.patchContent, {
          p_actor_id: context.userId,
          p_content_id: contentId,
          p_expected_version: expectedVersion(body.version),
          p_patch: patch,
          p_note: optionalText(body.note, 2000),
        });
      }
      case "submit-approval": {
        requireWriter(context);
        return rpc(RPC.submitApproval, { p_content_id: requireUuid(body.content_id, "Content item"), p_note: optionalText(body.note, 3000), ...actor });
      }
      case "decide-approval": {
        requireManager(context);
        return rpc(RPC.decideApproval, {
          p_content_id: requireUuid(body.content_id, "Content item"),
          p_decision: requireEnum(body.decision, "Approval decision", APPROVAL_DECISIONS),
          p_note: optionalText(body.note, 3000),
          ...actor,
        });
      }
      case "mark-published": {
        requireManager(context);
        return rpc(RPC.markPublished, {
          p_content_id: requireUuid(body.content_id, "Content item"),
          p_published_at: dateTime(body.published_at, "Published time"),
          p_external_publication_ids: jsonObject(body.external_publication_ids, "Publication references"),
          p_note: optionalText(body.note, 3000),
          ...actor,
        });
      }
      case "mark-completed": {
        requireWriter(context);
        return rpc(RPC.markCompleted, { p_content_id: requireUuid(body.content_id, "Content item"), p_note: optionalText(body.note, 3000), ...actor });
      }
      case "convert-recommendation": {
        requireWriter(context);
        return rpc(RPC.convertRecommendation, {
          p_recommendation_id: requireUuid(body.recommendation_id, "Recommendation"),
          p_occurrence_date: dateOnly(body.occurrence_date, "Occurrence date") ?? await venueDate(context),
          p_client_request_id: requireUuid(body.client_request_id, "Client request ID"),
          p_scheduled_for: dateTime(body.scheduled_for, "Scheduled time"),
          p_reminder_at: dateTime(body.reminder_at, "Reminder time"),
          ...actor,
        });
      }
      case "dismiss-recommendation": {
        requireManager(context);
        return rpc(RPC.dismissRecommendation, {
          p_recommendation_id: requireUuid(body.recommendation_id, "Recommendation"),
          p_occurrence_date: dateOnly(body.occurrence_date, "Occurrence date") ?? await venueDate(context),
          p_reason: requiredText(body.reason, "Dismiss reason", 2000),
          ...actor,
        });
      }

      // ---- S94 (managers and administrators) ----
      case "cancel-content": {
        requireManager(context);
        return rpc(RPC.cancelContent, { p_actor_id: context.userId, p_content_id: requireUuid(body.content_id, "Post"), p_reason: optionalText(body.note ?? body.reason, 2000) });
      }
      case "reschedule-content": {
        requireManager(context);
        return rpc(RPC.rescheduleContent, {
          p_actor_id: context.userId,
          p_content_id: requireUuid(body.content_id, "Post"),
          p_expected_version: expectedVersion(body.version, { required: true }),
          p_scheduled_for: dateTime(body.scheduled_for, "Scheduled time"),
        });
      }
      case "duplicate-content": {
        requireManager(context);
        return rpc(RPC.duplicateContent, { p_actor_id: context.userId, p_content_id: requireUuid(body.content_id, "Post") });
      }
      case "set-content-media": {
        requireManager(context);
        return rpc(RPC.setContentMedia, {
          p_actor_id: context.userId,
          p_content_id: requireUuid(body.content_id, "Post"),
          p_items: mediaItems(body.items ?? body.media),
        });
      }
      case "publish-now": {
        requireManager(context);
        const result = await rpc(RPC.publishNow, { p_actor_id: context.userId, p_content_id: requireUuid(body.content_id, "Post") });
        if (result?.wake !== false) await wakePublisher();
        return result;
      }
      case "retry-delivery": {
        requireManager(context);
        const result = await rpc(RPC.deliveryAction, {
          p_actor_id: context.userId,
          p_delivery_id: requireUuid(body.delivery_id, "Channel delivery"),
          p_action: "retry",
          p_payload: { confirmed_not_posted: body.confirmed_not_posted === true, note: optionalText(body.note, 2000) },
        });
        await wakePublisher();
        return result;
      }
      case "cancel-delivery": {
        requireManager(context);
        return rpc(RPC.deliveryAction, {
          p_actor_id: context.userId,
          p_delivery_id: requireUuid(body.delivery_id, "Channel delivery"),
          p_action: "cancel",
          p_payload: { note: optionalText(body.note, 2000) },
        });
      }
      case "mark-delivery-posted": {
        requireManager(context);
        const permalink = httpsUrl(body.permalink, "Post link");
        if (!permalink) throw new ApiError(400, "Add the link to the post on the platform.");
        return rpc(RPC.deliveryAction, {
          p_actor_id: context.userId,
          p_delivery_id: requireUuid(body.delivery_id, "Channel delivery"),
          p_action: "mark_posted",
          p_payload: { permalink, published_at: dateTime(body.published_at, "Posted time"), post_id: optionalText(body.post_id, 200), note: optionalText(body.note, 2000) },
        });
      }
      default:
        throw new ApiError(404, "Unknown Marketing workspace action.");
    }
  }

  return async function handle(request) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    try {
      let context;
      try {
        context = await resolveActor(request);
      } catch (error) {
        // The shared caller check keeps its original response shape.
        if (error instanceof AuthError) return jsonResponse({ error: error.message }, error.status);
        throw error;
      }
      const url = new URL(request.url);
      const action = url.searchParams.get("action") || "snapshot";
      if (request.method === "GET") return jsonResponse(await handleGet(context, url, action));
      if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
      const body = await readJson(request);
      const range = await resolveRange(context, body.start_date, body.end_date);
      const result = await handlePost(context, action, body);
      const refreshed = await workspaceSnapshot(context, range);
      return jsonResponse({ result: scrub(result ?? null), workspace: refreshed.workspace, staff: staffPayload(context), members: refreshed.members, policy: policy(refreshed.workspace) });
    } catch (error) {
      if (error instanceof ApiError) return jsonResponse({ error: error.message, error_code: error.extra?.error_code ?? STATUS_CODES[error.status] ?? "unavailable" }, error.status);
      console.error("[atlas-marketing-workspace] request failed", error instanceof Error ? error.name : "unknown");
      return jsonResponse({ error: "The Marketing workspace is temporarily unavailable.", error_code: "internal" }, 500);
    }
  };
}
