// atlas-training request handling (S98). Training lessons are Knowledge
// articles (article_type='training') with a private video, chapters, procedure
// steps, per-user progress and explicit completion. Every side effect is
// injected so Node tests run it without the network:
//   env(name)             -> string | undefined
//   fetchImpl(url, init)  -> Response (Auth, PostgREST RPC, Storage)
//   resolveActor(req)     -> optional override of _shared/auth.mjs resolveActor
//   services              -> optional override of createServices()
//
// verify_jwt=false (supabase/config.toml): the production Auth project issues
// the JWT, so the handler authenticates every request itself with
// _shared/auth.mjs resolveActor and passes the resolved actor (never a
// browser-sent id/role) into the service-role public.atlas_training_* RPCs,
// which re-check the actor. Video bytes never pass through this function: the
// browser uploads straight to the private atlas-training-videos bucket with a
// one-time signed upload URL, and plays back through a 5-minute signed URL.
// A storage path never reaches the browser.
//
//   GET  ?action=snapshot                                  the Training home
//   GET  ?action=lesson&article_id=&prefer_draft=0|1       one lesson (no storage path)
//   GET  ?action=report&article_id=                        completion report (managers)
//   POST ?action=reserve-media   {client_request_id, mime_type, declared_bytes, original_filename?}
//   POST ?action=finalize-media  {media_id, path, duration_seconds?, width?, height?}
//   POST ?action=save-draft      {article_id?, article_key?, category_id, title, ...}
//   POST ?action=attach-media    {article_id, media_id}
//   POST ?action=publish         {article_id, change_note?}
//   POST ?action=retire          {article_id, reason}
//   POST ?action=playback        {article_id, version_id}
//   POST ?action=start           {article_id, version_id}
//   POST ?action=progress        {version_id, position_seconds}
//   POST ?action=complete        {article_id, version_id}

import { AuthError, resolveActor as sharedResolveActor } from "../_shared/auth.mjs";

export const FUNCTION_VERSION = "0.1.0";
export const BUCKET = "atlas-training-videos";
const GIB = 1024 * 1024 * 1024;
export const LIMITS = Object.freeze({
  videoBytes: 2 * GIB, // 2 GiB, matches the bucket file_size_limit
  jsonBytes: 64 * 1024,
  // Browser playback link (contract: 5 minutes, never stored).
  signedPlaybackSeconds: 300,
});

// The only video types a lesson master may be.
export const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
export const DIFFICULTY = new Set(["easy", "medium", "hard"]);
export const TARGET_ROLES = new Set(["all", "admin", "manager", "bartender", "viewer"]);
const MANAGER_ROLES = new Set(["admin", "manager"]);

export const CORS_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  vary: "authorization",
});

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const MESSAGES = Object.freeze({
  invalid_request: "Some of the details were not valid. Check them and try again.",
  unauthorized: "Atlas couldn’t confirm your sign-in for this. Try again in a moment.",
  forbidden: "This isn’t available for your Atlas role.",
  not_found: "That training lesson could not be found.",
  conflict: "This was already done. Refresh and try again.",
  too_large: "Videos can be up to 2 GB.",
  unsupported_type: "Upload an MP4, WebM or MOV video.",
  not_ready: "The upload hasn’t finished yet. Try again in a moment.",
  quota: "You have too many unfinished uploads. Let them finish, or cancel some, then try again.",
  storage_failed: "The video could not be reached. Nothing was changed. Try again.",
  unavailable: "Training is unavailable right now. Nothing was changed. Try again in a moment.",
  internal: "Training could not complete that request. Nothing was changed.",
});

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value ?? null), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-training-version": FUNCTION_VERSION,
    },
  });
}

export function errorResponse(error) {
  if (error instanceof ApiError) return jsonResponse({ error_code: error.code, message: error.message, ...error.extra }, error.status);
  if (error?.name === "AuthError" || error instanceof AuthError) {
    const code = error.status === 401 ? "unauthorized" : error.status === 403 ? "forbidden" : "unavailable";
    return jsonResponse({ error_code: code, message: code === "forbidden" ? MESSAGES.forbidden : error.message }, error.status);
  }
  console.error("[atlas-training] unexpected error", error?.name ?? "Error");
  return jsonResponse({ error_code: "internal", message: MESSAGES.internal }, 500);
}

// PostgREST error -> ApiError. The RPC hint ('atlas:<code>') decides the
// status; database text is never passed on to the browser.
const HINTS = Object.freeze({
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_request: 400,
  too_large: 400,
  unsupported_type: 400,
  not_ready: 400,
  quota: 400,
});
export function mapRpcError(status, body) {
  const code = String(body?.code ?? "");
  const hint = String(body?.hint ?? "");
  const hinted = hint.startsWith("atlas:") ? hint.slice(6) : "";
  if (Object.prototype.hasOwnProperty.call(HINTS, hinted)) {
    return new ApiError(HINTS[hinted], hinted, MESSAGES[hinted] ?? MESSAGES.invalid_request);
  }
  if (code === "42501") return new ApiError(403, "forbidden", MESSAGES.forbidden);
  if (code === "P0002") return new ApiError(404, "not_found", MESSAGES.not_found);
  if (code === "22023" || code === "22P02" || code === "22007" || code === "22008") return new ApiError(400, "invalid_request", MESSAGES.invalid_request);
  if (code === "23505") return new ApiError(409, "conflict", MESSAGES.conflict);
  return new ApiError(status >= 500 ? 503 : 502, "unavailable", MESSAGES.unavailable);
}

function envValue(env, name) {
  const value = typeof env === "function" ? env(name) : typeof env?.get === "function" ? env.get(name) : env?.[name];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

const invalid = (message = MESSAGES.invalid_request) => new ApiError(400, "invalid_request", message);

// ---------------------------------------------------------------------------
// Input helpers (Set-based allowlists and uuid checks, like atlas-accounting).
// ---------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}
function optionalUuid(value) {
  if (value === undefined || value === null || value === "") return null;
  return requireUuid(value);
}
function boundedInt(value, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}
function cleanText(value, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid();
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
  return text || null;
}
function requireText(value, max, message = MESSAGES.invalid_request) {
  const text = cleanText(value, max);
  if (!text) throw invalid(message);
  return text;
}
function optionalEnum(value, allowed) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!allowed.has(normalized)) throw invalid();
  return normalized;
}
function roleArray(value) {
  if (!Array.isArray(value)) throw invalid();
  const values = [...new Set(value.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  if (!values.length || values.some((item) => !TARGET_ROLES.has(item))) throw invalid();
  return values;
}

// A slug from a title, mirroring the atlas-knowledge rules
// (^[a-z0-9][a-z0-9-]{1,119}$) plus a short random suffix on create.
function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 110);
}
const ARTICLE_KEY = /^[a-z0-9][a-z0-9-]{1,119}$/;

async function readJson(request) {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > LIMITS.jsonBytes) throw invalid();
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITS.jsonBytes) {
      try { await reader.cancel(); } catch { /* closed */ }
      throw invalid();
    }
    chunks.push(value);
  }
  if (!total) return {};
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw invalid();
  }
}

// Storage paths are for the gateway only: every *_path / storage_path /
// bucket_id key is dropped before a reply reaches the browser.
function isHiddenKey(key) {
  return key === "storage_path" || key === "bucket_id" || key.endsWith("_path");
}
export function stripPaths(value) {
  if (Array.isArray(value)) return value.map(stripPaths);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isHiddenKey(key)) out[key] = stripPaths(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Service-role access: the training RPCs and the private bucket.
// ---------------------------------------------------------------------------
const RPCS = new Set([
  "atlas_training_snapshot", "atlas_training_lesson", "atlas_training_reserve_media",
  "atlas_training_finalize_media", "atlas_training_save_draft", "atlas_training_attach_media",
  "atlas_training_publish", "atlas_training_playback_path", "atlas_training_start",
  "atlas_training_save_progress", "atlas_training_complete", "atlas_training_completion_report",
  "atlas_knowledge_retire",
]);
const encodePath = (path) => String(path).split("/").map((part) => encodeURIComponent(part)).join("/");
// The immutable object path the reserve RPC mints (migration check constraint).
const PATH_PATTERN = /^lessons\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(mp4|webm|mov)$/;

export function createServices({ env, fetchImpl }) {
  function credentials() {
    const url = String(envValue(env, "SUPABASE_URL") ?? "").replace(/\/+$/, "");
    const key = String(envValue(env, "SUPABASE_SERVICE_ROLE_KEY") ?? "");
    if (!/^https?:\/\/[^/\s]+$/.test(url) || !key) throw new ApiError(503, "unavailable", MESSAGES.unavailable);
    return { url, key };
  }
  const headers = (key, extra = {}) => ({ apikey: key, authorization: `Bearer ${key}`, "cache-control": "no-store", ...extra });
  const checkPath = (path) => {
    if (typeof path !== "string" || !PATH_PATTERN.test(path)) throw new ApiError(502, "storage_failed", MESSAGES.storage_failed);
    return path;
  };
  function absolute(url, value) {
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith("/storage/v1/")) return `${url}${value}`;
    if (value.startsWith("/object/")) return `${url}/storage/v1${value}`;
    return `${url}/storage/v1/${value.replace(/^\/+/, "")}`;
  }

  async function rpc(name, args) {
    if (!RPCS.has(name)) throw new Error("rpc not allowed");
    const { url, key } = credentials();
    let response;
    try {
      response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: headers(key, { "content-type": "application/json", accept: "application/json" }),
        body: JSON.stringify(args ?? {}),
      });
    } catch {
      throw new ApiError(503, "unavailable", MESSAGES.unavailable);
    }
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      console.warn(`[atlas-training] rpc ${name} failed`, response.status, parsed?.code ?? "-");
      throw mapRpcError(response.status, parsed);
    }
    return parsed;
  }

  // A one-time upload token for exactly this path (no upsert). The browser PUTs
  // the video bytes straight to Storage with it; the bytes never touch us.
  async function signUpload(path) {
    const { url, key } = credentials();
    let response;
    try {
      response = await fetchImpl(`${url}/storage/v1/object/upload/sign/${BUCKET}/${encodePath(checkPath(path))}`, {
        method: "POST", headers: headers(key, { "content-type": "application/json", accept: "application/json" }), body: "{}",
      });
    } catch {
      throw new ApiError(502, "storage_failed", MESSAGES.storage_failed);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload?.url !== "string") throw new ApiError(502, "storage_failed", MESSAGES.storage_failed);
    const link = new URL(absolute(url, payload.url));
    const token = link.searchParams.get("token") || payload.token || null;
    if (!token) throw new ApiError(502, "storage_failed", MESSAGES.storage_failed);
    return { url: link.toString(), token };
  }

  // A short-lived signed read link for one object, normalized to absolute.
  async function sign(path, seconds) {
    const { url, key } = credentials();
    let response;
    try {
      response = await fetchImpl(`${url}/storage/v1/object/sign/${BUCKET}/${encodePath(checkPath(path))}`, {
        method: "POST", headers: headers(key, { "content-type": "application/json", accept: "application/json" }),
        body: JSON.stringify({ expiresIn: seconds }),
      });
    } catch {
      throw new ApiError(502, "storage_failed", MESSAGES.unavailable);
    }
    const payload = await response.json().catch(() => ({}));
    const value = payload?.signedURL || payload?.signedUrl || payload?.signed_url;
    if (!response.ok || typeof value !== "string") throw new ApiError(502, "storage_failed", MESSAGES.unavailable);
    return absolute(url, value);
  }

  // The stored object's true size and mime, without downloading the file, or
  // null when the object is not there yet. Prefers the info endpoint and falls
  // back to a single-byte ranged read of the authenticated object.
  async function objectInfo(path) {
    const { url, key } = credentials();
    const encoded = encodePath(checkPath(path));
    // 1. The info endpoint (authenticated), when the deployment has it.
    try {
      const response = await fetchImpl(`${url}/storage/v1/object/info/authenticated/${BUCKET}/${encoded}`, {
        headers: headers(key, { accept: "application/json" }),
      });
      if (response.ok) {
        const info = await response.json().catch(() => null);
        const size = pickSize(info);
        if (size !== null) return { size, mime: pickMime(info) };
      } else if (response.status !== 404 && response.status !== 400 && response.status !== 405) {
        // A 5xx or auth failure is a service problem, not a missing object.
        try { await response.body?.cancel?.(); } catch { /* closed */ }
        throw new ApiError(502, "storage_failed", MESSAGES.storage_failed);
      } else {
        try { await response.body?.cancel?.(); } catch { /* closed */ }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // fall through to the ranged read
    }
    // 2. A ranged read of the authenticated object: content-range/-length gives
    //    the total size, content-type the mime; the body is never consumed.
    let response;
    try {
      response = await fetchImpl(`${url}/storage/v1/object/authenticated/${BUCKET}/${encoded}`, {
        headers: headers(key, { range: "bytes=0-0" }),
      });
    } catch {
      throw new ApiError(502, "storage_failed", MESSAGES.storage_failed);
    }
    if (response.status === 404 || response.status === 416) {
      try { await response.body?.cancel?.(); } catch { /* closed */ }
      return null;
    }
    if (!response.ok && response.status !== 206) {
      try { await response.body?.cancel?.(); } catch { /* closed */ }
      throw new ApiError(502, "storage_failed", MESSAGES.storage_failed);
    }
    let size = null;
    const range = response.headers.get("content-range");
    if (range) {
      const match = /\/(\d+)\s*$/.exec(range);
      if (match) size = Number(match[1]);
    }
    if (size === null && response.status === 200) {
      const length = response.headers.get("content-length");
      if (length && /^\d+$/.test(length)) size = Number(length);
    }
    const mime = response.headers.get("content-type") || null;
    try { await response.body?.cancel?.(); } catch { /* closed */ }
    if (size === null || !Number.isFinite(size)) return null;
    return { size, mime };
  }

  return { rpc, signUpload, sign, objectInfo };
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.trunc(number);
  }
  return null;
}
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
function pickSize(info) {
  if (!info || typeof info !== "object") return null;
  const meta = info.metadata && typeof info.metadata === "object" ? info.metadata : {};
  return firstNumber(info.size, info.contentLength, info.content_length, meta.size, meta.contentLength);
}
function pickMime(info) {
  if (!info || typeof info !== "object") return null;
  const meta = info.metadata && typeof info.metadata === "object" ? info.metadata : {};
  return firstString(info.contentType, info.content_type, info.mimetype, meta.mimetype, meta.contentType, meta.content_type);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export function createTrainingHandler({ env, fetchImpl, resolveActor = null, services = null } = {}) {
  const svc = services ?? createServices({ env, fetchImpl });
  // _shared/auth.mjs reads settings from an object with get() (Deno.env) or a
  // plain object; index.ts passes a function, so it is wrapped here.
  const resolve = resolveActor ?? ((request) => sharedResolveActor(request, { get: (name) => envValue(env, name) }, fetchImpl, {
    inactiveMessage: "This Atlas profile is inactive. Training access has been removed.",
  }));

  // Every request authenticates through resolveActor (verify_jwt is false).
  async function requireActor(request) {
    const actor = await resolve(request);
    if (!actor || actor.active === false) throw new ApiError(403, "forbidden", MESSAGES.forbidden);
    return actor;
  }
  function requireManager(actor) {
    if (!MANAGER_ROLES.has(actor.role)) throw new ApiError(403, "forbidden", MESSAGES.forbidden);
    return actor;
  }
  const actorArgs = (actor) => ({ p_actor_id: actor.userId, p_actor_role: actor.role });

  async function snapshot(actor) {
    return svc.rpc("atlas_training_snapshot", actorArgs(actor));
  }

  async function lesson(actor, articleId, preferDraft) {
    const result = await svc.rpc("atlas_training_lesson", {
      p_article_id: requireUuid(articleId), p_actor_id: actor.userId, p_actor_role: actor.role, p_prefer_draft: preferDraft,
    });
    // The browser must never receive a storage path.
    return stripPaths(result);
  }

  async function reserveMedia(actor, body) {
    const clientRequestId = requireUuid(body.client_request_id);
    const mime = String(body.mime_type ?? "").trim().toLowerCase();
    if (!VIDEO_TYPES.has(mime)) throw new ApiError(400, "unsupported_type", MESSAGES.unsupported_type);
    const bytes = body.declared_bytes;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1) throw invalid();
    if (bytes > LIMITS.videoBytes) throw new ApiError(400, "too_large", MESSAGES.too_large);
    const reserved = await svc.rpc("atlas_training_reserve_media", {
      p_actor_id: actor.userId,
      p_actor_role: actor.role,
      p_request: {
        client_request_id: clientRequestId,
        mime_type: mime,
        declared_bytes: bytes,
        original_filename: cleanText(body.original_filename, 255),
      },
    });
    const path = reserved?.storage_path;
    const media = stripPaths(reserved?.media ?? {});
    // A replay of an upload whose bytes already arrived: the object exists, so
    // Storage will not sign a second upload for it. Tell the browser it is done.
    if (media.upload_status === "stored" || typeof path !== "string") {
      return { media, upload: null, replayed: Boolean(reserved?.replayed) };
    }
    const upload = await svc.signUpload(path);
    return { media, upload: { url: upload.url, token: upload.token, path }, replayed: Boolean(reserved?.replayed) };
  }

  async function finalizeMedia(actor, body) {
    const mediaId = requireUuid(body.media_id);
    // The object path the browser uploaded to (from reserve's upload.path). It
    // is validated against the immutable path pattern; the finalize RPC still
    // enforces that the media row belongs to this actor.
    const path = body.path ?? body.storage_path;
    if (typeof path !== "string" || !PATH_PATTERN.test(path)) throw invalid();
    const info = await svc.objectInfo(path);
    if (!info || info.size === null || info.size === undefined) {
      throw new ApiError(400, "not_ready", "Upload not finished");
    }
    const sniffedMime = String(info.mime ?? "").toLowerCase();
    const object = {
      byte_size: info.size,
      // Only a known video type is passed on; anything else lets the RPC keep
      // the type the manager declared at reserve time.
      mime_type: VIDEO_TYPES.has(sniffedMime) ? sniffedMime : "",
      duration_seconds: boundedInt(body.duration_seconds, 0, 86400),
      width: boundedInt(body.width, 1, 16384),
      height: boundedInt(body.height, 1, 16384),
    };
    const result = await svc.rpc("atlas_training_finalize_media", {
      p_actor_id: actor.userId, p_actor_role: actor.role, p_media_id: mediaId, p_object: object,
    });
    return { media: stripPaths(result?.media ?? {}) };
  }

  async function saveDraft(actor, body) {
    const articleId = optionalUuid(body.article_id);
    const title = requireText(body.title, 220);
    const categoryId = requireUuid(body.category_id);
    const content = requireText(body.content, 250000);

    let articleKey = cleanText(body.article_key, 120);
    if (!articleId && !articleKey) {
      articleKey = `${slugify(title) || "lesson"}-${crypto.randomUUID().slice(0, 8)}`;
    }
    if (articleKey && !ARTICLE_KEY.test(articleKey)) {
      throw invalid("Article key must contain lowercase letters, numbers and hyphens.");
    }

    const payload = {
      article_id: articleId,
      article_key: articleKey,
      category_id: categoryId,
      title,
      summary: cleanText(body.summary, 3000),
      content,
      change_note: cleanText(body.change_note, 3000),
      estimated_minutes: boundedInt(body.estimated_minutes, 1, 600),
      difficulty: optionalEnum(body.difficulty, DIFFICULTY),
    };
    if (typeof body.required === "boolean") payload.required = body.required;
    if (typeof body.requires_video === "boolean") payload.requires_video = body.requires_video;
    if ("target_roles" in body && body.target_roles !== undefined && body.target_roles !== null) {
      payload.target_roles = roleArray(body.target_roles);
    }
    if ("chapters" in body && body.chapters !== undefined && body.chapters !== null) {
      payload.chapters = chaptersPayload(body.chapters);
    }
    if ("steps" in body && body.steps !== undefined && body.steps !== null) {
      payload.steps = stepsPayload(body.steps);
    }

    return svc.rpc("atlas_training_save_draft", {
      p_actor_id: actor.userId, p_actor_label: actor.label, p_actor_role: actor.role, p_payload: payload,
    });
  }

  async function attachMedia(actor, body) {
    return svc.rpc("atlas_training_attach_media", {
      p_actor_id: actor.userId, p_actor_role: actor.role,
      p_article_id: requireUuid(body.article_id), p_media_id: requireUuid(body.media_id),
    });
  }

  async function publish(actor, body) {
    return svc.rpc("atlas_training_publish", {
      p_actor_id: actor.userId, p_actor_label: actor.label, p_actor_role: actor.role,
      p_article_id: requireUuid(body.article_id), p_change_note: cleanText(body.change_note, 3000),
    });
  }

  async function retire(actor, body) {
    // atlas_knowledge_retire raises generic exceptions (no atlas: hint), so the
    // manager check and the reason are validated here for clean statuses.
    requireManager(actor);
    await svc.rpc("atlas_knowledge_retire", {
      p_article_id: requireUuid(body.article_id),
      p_reason: requireText(body.reason, 3000),
      p_actor_id: actor.userId, p_actor_label: actor.label, p_actor_role: actor.role,
    });
    return { ok: true };
  }

  async function playback(actor, body) {
    const path = await svc.rpc("atlas_training_playback_path", {
      p_actor_id: actor.userId, p_actor_role: actor.role,
      p_article_id: requireUuid(body.article_id), p_version_id: requireUuid(body.version_id),
    });
    if (typeof path !== "string" || !PATH_PATTERN.test(path)) throw new ApiError(404, "not_found", MESSAGES.not_found);
    const url = await svc.sign(path, LIMITS.signedPlaybackSeconds);
    return { url, expires_in: LIMITS.signedPlaybackSeconds };
  }

  async function start(actor, body) {
    const result = await svc.rpc("atlas_training_start", {
      p_actor_id: actor.userId, p_actor_role: actor.role,
      p_article_id: requireUuid(body.article_id), p_version_id: requireUuid(body.version_id),
    });
    return stripPaths(result);
  }

  async function progress(actor, body) {
    const raw = Number(body.position_seconds);
    if (!Number.isFinite(raw)) throw invalid();
    const position = Math.max(0, Math.min(86400, Math.trunc(raw)));
    await svc.rpc("atlas_training_save_progress", {
      p_actor_id: actor.userId, p_actor_role: actor.role,
      p_version_id: requireUuid(body.version_id), p_position_seconds: position,
    });
    return { ok: true };
  }

  async function complete(actor, body) {
    return svc.rpc("atlas_training_complete", {
      p_actor_id: actor.userId, p_actor_role: actor.role,
      p_article_id: requireUuid(body.article_id), p_version_id: requireUuid(body.version_id),
    });
  }

  async function completionReport(actor, articleId) {
    return svc.rpc("atlas_training_completion_report", {
      p_actor_id: actor.userId, p_actor_role: actor.role, p_article_id: requireUuid(articleId),
    });
  }

  return async function handle(request) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    try {
      const url = new URL(request.url);
      const action = url.searchParams.get("action") || "snapshot";
      const actor = await requireActor(request);
      if (request.method === "GET") {
        if (action === "snapshot") return jsonResponse(await snapshot(actor));
        if (action === "lesson") {
          const preferDraft = ["1", "true"].includes(url.searchParams.get("prefer_draft") ?? "");
          return jsonResponse(await lesson(actor, url.searchParams.get("article_id"), preferDraft));
        }
        if (action === "report") return jsonResponse(await completionReport(actor, url.searchParams.get("article_id")));
        throw new ApiError(404, "not_found", MESSAGES.not_found);
      }
      if (request.method !== "POST") throw new ApiError(405, "invalid_request", MESSAGES.invalid_request);
      const body = await readJson(request);
      switch (action) {
        case "reserve-media": return jsonResponse(await reserveMedia(actor, body));
        case "finalize-media": return jsonResponse(await finalizeMedia(actor, body));
        case "save-draft": return jsonResponse(await saveDraft(actor, body));
        case "attach-media": return jsonResponse(await attachMedia(actor, body));
        case "publish": return jsonResponse(await publish(actor, body));
        case "retire": return jsonResponse(await retire(actor, body));
        case "playback": return jsonResponse(await playback(actor, body));
        case "start": return jsonResponse(await start(actor, body));
        case "progress": return jsonResponse(await progress(actor, body));
        case "complete": return jsonResponse(await complete(actor, body));
        default: throw new ApiError(404, "not_found", MESSAGES.not_found);
      }
    } catch (error) {
      return errorResponse(error);
    }
  };
}

// Chapters the browser may send: [{start_seconds, title}]. The RPC bounds and
// truncates these again and drops any with an empty title.
function chaptersPayload(value) {
  if (!Array.isArray(value)) throw invalid();
  if (value.length > 200) throw invalid();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const title = requireText(entry.title, 160, "Each chapter needs a title.");
    return { start_seconds: boundedInt(entry.start_seconds, 0, 86400) ?? 0, title };
  });
}

// Procedure steps the browser may send: a list of strings.
function stepsPayload(value) {
  if (!Array.isArray(value)) throw invalid();
  if (value.length > 200) throw invalid();
  return value
    .map((entry) => {
      if (typeof entry !== "string") throw invalid();
      return entry.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
    })
    .filter(Boolean);
}
