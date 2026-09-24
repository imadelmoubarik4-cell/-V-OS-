// atlas-inventory-recognition request handling. Every side effect is
// injected so Node and Deno tests run it without the network:
//   env(name)           -> string | undefined
//   fetchImpl(url, init) -> Response (Auth, PostgREST, Storage, OpenAI)
//   now()               -> epoch milliseconds
//   newId()             -> uuid (storage object names)
//   resolveActor(req)   -> optional override of _shared/auth.mjs resolveActor
//
// Structural guarantee (owner §10): the only database calls this function
// can make are the atlas_recognition_* RPCs in RECOGNITION_RPCS (guardedRpc),
// which run as the NOLOGIN recognition definer with no write grant on stock,
// items, codes or aliases. Storage writes go only to the private
// atlas-ai-media bucket under the caller's own folder. Every response carries
// stock_changed: false.

import { AuthError, resolveActor as sharedResolveActor } from "../_shared/auth.mjs";
import { callVision, estimateVisionCostUsd, RecognitionError, visionModelFrom } from "../_shared/recognition/extract.mjs";
import { guardedRpc, RpcNotAllowedError } from "../_shared/recognition/retrieve.mjs";
import { identify, normalizeContext, normalizeMode, searchText } from "../_shared/recognition/pipeline.mjs";
import { BAND_COPY, fieldState, percent } from "../_shared/recognition/bands.mjs";
import { actionsFor, detectionSummary } from "../_shared/recognition/explain.mjs";

export const FUNCTION_VERSION = "0.1.0";
export const MEDIA_BUCKET = "atlas-ai-media";
export const LIMITS = Object.freeze({
  imageBytes: 12 * 1024 * 1024,
  multipartOverheadBytes: 256 * 1024,
  jsonBytes: 64 * 1024,
  visionTimeoutMs: 20000,
});

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

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-recognition-version": FUNCTION_VERSION,
    },
  });
}

// Friendly, fixed messages. Database and provider text is never returned.
export const ERROR_MESSAGES = Object.freeze({
  invalid_request: "Some of the details were not valid.",
  unauthorized: "A valid Atlas session is required.",
  forbidden: "This is not available for your Atlas role.",
  not_found: "That could not be found.",
  conflict: "This was already handled. Refresh and try again.",
  stale_request: "This request changed. Refresh before trying again.",
  duplicate_suspected: "This looks like an existing product. Check the possible matches first.",
  invalid_code: "This code is not valid.",
  rate_limited: "You've reached the photo recognition limit. Scan barcodes or search instead, and try photos again later.",
  upload_quota_exceeded: "You've reached today's photo upload limit. Scan barcodes or search instead.",
  too_large: "Photos can be up to 12 MB.",
  unsupported_type: "Send a JPEG, PNG, WebP or HEIC photo.",
  not_configured: "Photo recognition is not configured. Scan the barcode or search instead.",
  storage_failed: "The photo could not be stored. Please try again.",
  unavailable: "Recognition is unavailable right now. Scan the barcode or search instead.",
  internal: "Recognition could not complete that request.",
});

export function errorResponse(error) {
  if (error instanceof ApiError) {
    return jsonResponse({ error_code: error.code, message: error.message, stock_changed: false, ...error.extra }, error.status);
  }
  if (error instanceof RecognitionError) {
    return jsonResponse({ error_code: error.code, message: error.message, stock_changed: false }, error.status);
  }
  if (error?.name === "AuthError" || error instanceof AuthError) {
    const code = error.status === 401 ? "unauthorized" : error.status === 403 ? "forbidden" : "unavailable";
    return jsonResponse({ error_code: code, message: error.message, stock_changed: false }, error.status);
  }
  if (error instanceof RpcNotAllowedError) {
    console.error("[atlas-inventory-recognition] blocked rpc");
    return jsonResponse({ error_code: "internal", message: ERROR_MESSAGES.internal, stock_changed: false }, 500);
  }
  console.error("[atlas-inventory-recognition] unexpected error", error?.name ?? "Error");
  return jsonResponse({ error_code: "internal", message: ERROR_MESSAGES.internal, stock_changed: false }, 500);
}

// PostgREST error -> ApiError. Hints ('atlas:<code>') and the S88 hardening
// message prefixes are matched; the raw text is never passed on.
const HINT_CODES = new Set(["invalid_request", "forbidden", "not_found", "duplicate_suspected", "invalid_code", "stale_request", "append_only", "rate_limited"]);
export function mapRpcError(status, body) {
  const code = String(body?.code ?? "");
  const message = String(body?.message ?? "");
  const hint = String(body?.hint ?? "");
  if (message.startsWith("rate_limited:")) {
    return new ApiError(429, "rate_limited", ERROR_MESSAGES.rate_limited, { reason: message.slice(13).trim() || null });
  }
  if (message.startsWith("upload_quota_exceeded:")) {
    return new ApiError(429, "upload_quota_exceeded", ERROR_MESSAGES.upload_quota_exceeded, { reason: message.slice(22).trim() || null });
  }
  const hinted = hint.startsWith("atlas:") ? hint.slice(6) : "";
  if (HINT_CODES.has(hinted)) {
    const map = {
      invalid_request: [400, "invalid_request"], forbidden: [403, "forbidden"], not_found: [404, "not_found"],
      duplicate_suspected: [409, "duplicate_suspected"], invalid_code: [400, "invalid_code"], stale_request: [409, "stale_request"],
      append_only: [409, "conflict"], rate_limited: [429, "rate_limited"],
    }[hinted];
    return new ApiError(map[0], map[1], ERROR_MESSAGES[map[1]]);
  }
  if (code === "42501") return new ApiError(403, "forbidden", ERROR_MESSAGES.forbidden);
  if (code === "P0002") return new ApiError(404, "not_found", ERROR_MESSAGES.not_found);
  if (code === "22023" || code === "22P02") return new ApiError(400, "invalid_request", ERROR_MESSAGES.invalid_request);
  if (code === "40001" || code === "23505") return new ApiError(409, "conflict", ERROR_MESSAGES.conflict);
  return new ApiError(status >= 500 ? 503 : 502, "unavailable", ERROR_MESSAGES.unavailable);
}

function envValue(env, name) {
  const value = typeof env === "function" ? env(name) : env?.[name];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

export function recognitionConfig(env) {
  return Object.freeze({
    visionModel: visionModelFrom((name) => envValue(env, name)),
    openaiBaseUrl: (envValue(env, "ATLAS_AI_OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKeyPresent: Boolean(envValue(env, "OPENAI_API_KEY")),
  });
}

// ---------------------------------------------------------------------------
// Image sniffing: a renamed file is not accepted as a photo.
// ---------------------------------------------------------------------------
export const IMAGE_TYPES = Object.freeze({
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
});
const VISION_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "heif", "mif2"]);

export function imageMatches(mime, b) {
  if (!b || b.length < 12) return false;
  const ascii = (start, text) => [...text].every((ch, index) => b[start + index] === ch.charCodeAt(0));
  switch (mime) {
    case "image/jpeg": return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/png": return b[0] === 0x89 && ascii(1, "PNG");
    case "image/webp": return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "image/heic":
    case "image/heif": return ascii(4, "ftyp") && HEIF_BRANDS.has(String.fromCharCode(b[8], b[9], b[10], b[11]));
    default: return false;
  }
}

function normaliseImageMime(type) {
  const base = String(type ?? "").split(";")[0].trim().toLowerCase();
  return base === "image/jpg" ? "image/jpeg" : base;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBytes(request, maxBytes, message) {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw new ApiError(413, "too_large", message);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* closed */ }
      throw new ApiError(413, "too_large", message);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

async function readJson(request) {
  const bytes = await readBytes(request, LIMITS.jsonBytes, "The request is too large.");
  if (!bytes.length) return {};
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new ApiError(400, "invalid_request", "The request body must be a JSON object.");
  }
}

// multipart: `payload` (JSON text) and an optional `image` file.
async function readIdentifyRequest(request) {
  const type = String(request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("multipart/form-data")) return { payload: await readJson(request), image: null };
  const raw = await readBytes(request, LIMITS.imageBytes + LIMITS.multipartOverheadBytes, ERROR_MESSAGES.too_large);
  let form;
  try {
    form = await new Response(raw, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw new ApiError(400, "invalid_request", "Send the photo as multipart form data.");
  }
  let payload = {};
  const text = form.get("payload");
  if (typeof text === "string" && text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(400, "invalid_request", "payload must be JSON.");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ApiError(400, "invalid_request", "payload must be a JSON object.");
  }
  const file = form.get("image");
  if (!file || typeof file === "string") return { payload, image: null };
  if (file.size > LIMITS.imageBytes) throw new ApiError(413, "too_large", ERROR_MESSAGES.too_large);
  if (file.size === 0) throw new ApiError(400, "invalid_request", "The photo is empty.");
  const mime = normaliseImageMime(file.type);
  if (!IMAGE_TYPES[mime]) throw new ApiError(415, "unsupported_type", ERROR_MESSAGES.unsupported_type);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!imageMatches(mime, bytes)) throw new ApiError(415, "unsupported_type", "The file content does not match its image type.");
  return { payload, image: { bytes, mime } };
}

// ---------------------------------------------------------------------------
// Service-role access: guarded recognition RPCs and the private media bucket.
// ---------------------------------------------------------------------------
function encodePath(path) {
  return String(path).split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function createServices({ env, fetchImpl }) {
  function credentials() {
    const url = String(envValue(env, "SUPABASE_URL") ?? "").replace(/\/+$/, "");
    const key = String(envValue(env, "SUPABASE_SERVICE_ROLE_KEY") ?? "");
    if (!/^https?:\/\/[^/\s]+$/.test(url) || !key) throw new ApiError(503, "unavailable", ERROR_MESSAGES.unavailable);
    return { url, key };
  }
  const headers = (key, extra = {}) => ({ apikey: key, authorization: `Bearer ${key}`, "cache-control": "no-store", ...extra });

  async function rawRpc(name, args) {
    const { url, key } = credentials();
    let response;
    try {
      response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: headers(key, { "content-type": "application/json", accept: "application/json" }),
        body: JSON.stringify(args ?? {}),
      });
    } catch {
      throw new ApiError(503, "unavailable", ERROR_MESSAGES.unavailable);
    }
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      console.warn(`[atlas-inventory-recognition] rpc ${name} failed`, response.status, parsed?.code ?? "-");
      throw mapRpcError(response.status, parsed);
    }
    return parsed;
  }

  async function uploadObject(path, bytes, mime) {
    const { url, key } = credentials();
    let response;
    try {
      response = await fetchImpl(`${url}/storage/v1/object/${MEDIA_BUCKET}/${encodePath(path)}`, {
        method: "POST", headers: headers(key, { "content-type": mime, "x-upsert": "false" }), body: bytes,
      });
    } catch {
      throw new ApiError(502, "storage_failed", ERROR_MESSAGES.storage_failed);
    }
    if (!response.ok) throw new ApiError(502, "storage_failed", ERROR_MESSAGES.storage_failed);
  }

  async function removeObject(path) {
    const { url, key } = credentials();
    await fetchImpl(`${url}/storage/v1/object/${MEDIA_BUCKET}`, {
      method: "DELETE", headers: headers(key, { "content-type": "application/json" }), body: JSON.stringify({ prefixes: [path] }),
    }).catch(() => null);
  }

  return { rpc: guardedRpc(rawRpc), uploadObject, removeObject };
}

// ---------------------------------------------------------------------------
// Replay of a stored request (same client_request_id): no second vision call.
// ---------------------------------------------------------------------------
export function replayResponse(stored) {
  const detections = (stored.detections ?? []).map((detection) => {
    const candidates = (detection.candidates ?? []).slice(0, 5).map((candidate) => ({
      rank: candidate.rank,
      item_id: candidate.item_id,
      item: candidate.item ?? null,
      score: Number(candidate.score),
      percent: percent(candidate.score),
      explanation: candidate.explanation,
      evidence: candidate.features?.evidence ?? [],
      exact_identifier: candidate.features?.exact_identifier ?? null,
      conflicts: candidate.features?.conflicts ?? [],
      flags: {
        inactive: candidate.features?.inactive === true || candidate.item?.active === false,
        in_session: candidate.features?.in_session === true,
        counted_in_session: candidate.features?.counted_in_session === true,
        on_order: candidate.features?.on_order === true,
      },
    }));
    const confidence = detection.field_confidence ?? {};
    return {
      detection_id: detection.detection_id,
      detection_index: detection.detection_index,
      bbox: detection.bbox ?? null,
      band: detection.band,
      band_label: BAND_COPY[detection.band]?.label ?? null,
      reason: null,
      summary: detectionSummary(detection.band, candidates[0] ?? null, null),
      in_atlas: detection.band !== "low",
      preselected_item_id: detection.preselected_item_id ?? null,
      read: detection.extracted ?? null,
      field_confidence: confidence,
      field_state: Object.fromEntries(Object.entries(confidence).map(([key, value]) => [key, fieldState(value)])),
      candidates,
      more_candidates: Math.max(0, (detection.candidates ?? []).length - 5),
      actions: actionsFor(detection.band, stored.mode),
    };
  });
  return {
    request_id: stored.request_id,
    client_request_id: stored.client_request_id,
    replayed: true,
    mode: stored.mode,
    method: stored.vision_model ? "vision" : detections.length ? "barcode" : "none",
    status: stored.status,
    failure_code: stored.failure_code ?? null,
    vision: { configured: null, used: Boolean(stored.vision_model), model: stored.vision_model ?? null, reason: null },
    image_quality: stored.image_quality ?? null,
    media: stored.media_id ? { media_id: stored.media_id, expires_at: null } : null,
    detections,
    scorer_version: stored.scorer_version,
    extractor_version: stored.extractor_version === "none" ? null : stored.extractor_version,
    stock_changed: false,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (value, field) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !UUID.test(value)) throw new ApiError(400, "invalid_request", `${field} must be an Atlas id.`);
  return value.toLowerCase();
};
const requireUuid = (value, field) => {
  const id = uuidOrNull(value, field);
  if (!id) throw new ApiError(400, "invalid_request", `${field} is required.`);
  return id;
};
const textOrNull = (value, max, field) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, "invalid_request", `${field} must be text.`);
  return value.trim().slice(0, max) || null;
};
const objectOr = (value, fallback, field) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_request", `${field} must be an object.`);
  return value;
};

export const OUTCOMES = Object.freeze(["confirmed_preselected", "chose_candidate", "chose_by_search", "no_match", "wrong_product", "dismissed", "new_product_draft"]);
export const USED_FOR = Object.freeze(["count_line", "identify", "receiving", "draft", "ai_answer"]);
export const PROPOSAL_KINDS = Object.freeze(["alias", "code", "new_item", "metadata_correction", "wrong_match_report"]);

export function outcomeRequest(body) {
  const outcome = String(body.outcome ?? "");
  if (!OUTCOMES.includes(outcome)) throw new ApiError(400, "invalid_request", "Unknown outcome.");
  const usedFor = body.used_for === undefined || body.used_for === null ? null : String(body.used_for);
  if (usedFor !== null && !USED_FOR.includes(usedFor)) throw new ApiError(400, "invalid_request", "Unknown use.");
  const rank = body.chosen_rank === undefined || body.chosen_rank === null ? null : Number(body.chosen_rank);
  if (rank !== null && (!Number.isInteger(rank) || rank < 1 || rank > 25)) throw new ApiError(400, "invalid_request", "chosen_rank must be 1-25.");
  const usedRef = objectOr(body.used_ref, null, "used_ref");
  if (usedRef && JSON.stringify(usedRef).length > 2000) throw new ApiError(400, "invalid_request", "used_ref is too large.");
  return {
    client_outcome_id: uuidOrNull(body.client_outcome_id, "client_outcome_id"),
    detection_id: requireUuid(body.detection_id, "detection_id"),
    outcome,
    chosen_item_id: uuidOrNull(body.chosen_item_id, "chosen_item_id"),
    chosen_rank: rank,
    used_for: usedFor,
    used_ref: usedRef,
    note: textOrNull(body.note, 2000, "note"),
  };
}

export function proposeRequest(body, forcedKind = null) {
  const kind = forcedKind ?? String(body.kind ?? "");
  if (!PROPOSAL_KINDS.includes(kind)) throw new ApiError(400, "invalid_request", "Unknown request type.");
  const payload = { ...objectOr(body.payload, {}, "payload") };
  if (forcedKind === "wrong_match_report") {
    for (const key of ["item_id", "detection_id", "suggested_item_id"]) {
      const value = uuidOrNull(body[key] ?? payload[key], key);
      if (value) payload[key] = value;
    }
    const note = textOrNull(body.note ?? payload.note, 2000, "note");
    if (note) payload.note = note;
  }
  const evidence = objectOr(body.evidence, {}, "evidence");
  if (JSON.stringify(payload).length > 60000 || JSON.stringify(evidence).length > 120000) {
    throw new ApiError(400, "invalid_request", "The request is too large.");
  }
  const requestId = textOrNull(body.request_id, 200, "request_id");
  return {
    p_kind: kind,
    p_payload: payload,
    p_evidence: evidence,
    p_recognition_request_id: uuidOrNull(body.recognition_request_id, "recognition_request_id"),
    p_media_id: uuidOrNull(body.media_id, "media_id"),
    p_request_id: requestId,
  };
}

export function duplicatesRequest(body) {
  const values = objectOr(body.values, null, "values");
  if (!values) throw new ApiError(400, "invalid_request", "values are required.");
  const list = (value, field) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 20) throw new ApiError(400, "invalid_request", `${field} must be a list of at most 20.`);
    return value;
  };
  const limit = body.limit === undefined || body.limit === null ? 10 : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new ApiError(400, "invalid_request", "limit must be 1-25.");
  return { p_values: values, p_codes: list(body.codes, "codes"), p_aliases: list(body.aliases, "aliases"), p_limit: limit };
}

export function createRecognitionHandler(deps) {
  const env = deps.env;
  const fetchImpl = deps.fetchImpl;
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const services = deps.services ?? createServices({ env, fetchImpl });
  const config = recognitionConfig(env);
  const resolve = deps.resolveActor ?? ((request) => sharedResolveActor(request, { get: (name) => envValue(env, name) }, fetchImpl));
  const actorArgs = (actor) => ({ p_actor_id: actor.userId, p_actor_role: actor.role });

  function visionFor(enabled) {
    if (!config.apiKeyPresent) return { vision: null, reason: "not_configured" };
    if (!enabled) return { vision: null, reason: "disabled" };
    const apiKey = envValue(env, "OPENAI_API_KEY");
    return {
      reason: null,
      vision: async ({ imageDataUrl, mode }) => {
        const result = await callVision({
          fetchImpl, apiKey, baseUrl: config.openaiBaseUrl, model: config.visionModel, imageDataUrl, mode,
          timeoutMs: LIMITS.visionTimeoutMs, now,
        });
        return { ...result, cost_usd: estimateVisionCostUsd(result.model, result.tokens_in, result.tokens_out) };
      },
    };
  }

  async function status(actor) {
    const limits = await services.rpc("atlas_recognition_limits", { ...actorArgs(actor), p_vision: false, p_upload_bytes: null });
    return {
      vision: { configured: config.apiKeyPresent, enabled: limits?.vision_enabled === true, model: config.apiKeyPresent ? config.visionModel : null },
      limits,
      modes: ["stock_count", "identify", "add_product", "receiving", "ai"],
      stock_changed: false,
    };
  }

  async function identifyAction(request, actor) {
    const { payload, image } = await readIdentifyRequest(request);
    const clientRequestId = requireUuid(payload.client_request_id, "client_request_id");
    const mode = normalizeMode(payload.mode ?? "identify");
    const context = normalizeContext(payload.context);
    const barcodes = payload.client_barcodes ?? [];
    if (!Array.isArray(barcodes)) throw new ApiError(400, "invalid_request", "client_barcodes must be a list.");
    if (!image && !barcodes.length) throw new ApiError(400, "invalid_request", "Send a photo or a barcode.");

    const stored = await services.rpc("atlas_recognition_request_get", { p_client_request_id: clientRequestId, ...actorArgs(actor) });
    if (stored && stored.request_id) return { status: 200, body: replayResponse(stored) };

    const visionWanted = Boolean(image) && config.apiKeyPresent && VISION_MIMES.has(image?.mime);
    const limits = await services.rpc("atlas_recognition_limits", {
      ...actorArgs(actor), p_vision: visionWanted, p_upload_bytes: image ? image.bytes.byteLength : null,
    });

    let media = null;
    let path = null;
    if (image) {
      path = `${actor.userId}/unsorted/${newId()}.${IMAGE_TYPES[image.mime]}`;
      await services.uploadObject(path, image.bytes, image.mime);
      try {
        media = await services.rpc("atlas_recognition_register_media", {
          p_media: { path, mime: image.mime, bytes: image.bytes.byteLength, kind: "image", sha256: await sha256Hex(image.bytes) },
          ...actorArgs(actor),
        });
      } catch (error) {
        await services.removeObject(path);
        throw error;
      }
    }
    let { vision, reason } = visionFor(limits?.vision_enabled === true);
    if (image && !VISION_MIMES.has(image.mime)) { vision = null; reason = "unsupported_image"; }
    const result = await identify({
      rpc: services.rpc,
      actor,
      vision,
      visionReason: reason,
    }, {
      client_request_id: clientRequestId,
      mode,
      context,
      client_barcodes: barcodes,
      image: image ? { dataUrl: `data:${image.mime};base64,${bytesToBase64(image.bytes)}` } : null,
      media: media ? { media_id: media.media_id, expires_at: media.expires_at } : null,
    });
    return { status: result.replayed ? 200 : 201, body: result };
  }

  async function search(query, body, actor) {
    const text = textOrNull(query, 200, "q");
    if (!text) throw new ApiError(400, "invalid_request", "Type what to search for.");
    const context = normalizeContext(body?.context);
    await services.rpc("atlas_recognition_limits", { ...actorArgs(actor), p_vision: false, p_upload_bytes: null });
    const result = await searchText(async (signals) => {
      const response = await services.rpc("atlas_recognition_candidates", { p_signals: signals, p_limit: 25, ...actorArgs(actor) });
      return { method: response?.method ?? "fts", candidates: response?.candidates ?? [] };
    }, text, { context, limit: 10 });
    return {
      query: text,
      band: result.decision.band,
      band_label: BAND_COPY[result.decision.band].label,
      preselected_item_id: result.decision.preselected_item_id,
      candidates: result.ranked.map((entry) => ({
        rank: entry.rank, item_id: entry.item_id, item: entry.item, score: entry.p, percent: entry.percent,
        explanation: entry.explanation, evidence: entry.evidence, exact_identifier: entry.exact_identifier, conflicts: entry.conflicts,
        flags: { inactive: !entry.active },
      })),
      method: result.method,
      stock_changed: false,
    };
  }

  return async function handle(request) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    try {
      const url = new URL(request.url);
      const actor = await resolve(request);
      if (!actor || actor.active !== true) throw new ApiError(403, "forbidden", ERROR_MESSAGES.forbidden);
      const actionFromUrl = String(url.searchParams.get("action") ?? "").trim().toLowerCase().replace(/_/g, "-");
      if (request.method === "GET") {
        if (actionFromUrl === "status" || actionFromUrl === "") return jsonResponse(await status(actor));
        if (actionFromUrl === "search") return jsonResponse(await search(url.searchParams.get("q"), {}, actor));
        if (actionFromUrl === "my-requests") {
          const limit = Number(url.searchParams.get("limit") ?? 50);
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, "invalid_request", "limit must be 1-200.");
          const requests = await services.rpc("atlas_recognition_my_requests", { p_limit: limit, ...actorArgs(actor) });
          return jsonResponse({ requests, stock_changed: false });
        }
        throw new ApiError(404, "not_found", "Unknown action.");
      }
      if (request.method !== "POST") throw new ApiError(405, "invalid_request", "Method not allowed.");
      if (actionFromUrl === "identify" || actionFromUrl === "resolve-code") {
        const result = await identifyAction(request, actor);
        return jsonResponse(result.body, result.status);
      }
      const body = await readJson(request);
      const action = actionFromUrl || String(body.action ?? "").trim().toLowerCase().replace(/_/g, "-");
      if (action === "search") return jsonResponse(await search(body.q ?? body.query, body, actor));
      if (action === "outcome" || action === "confirm") {
        const outcome = await services.rpc("atlas_recognition_record_outcome", {
          p_outcome: outcomeRequest(body), p_actor_id: actor.userId, p_actor_label: actor.label ?? null, p_actor_role: actor.role,
        });
        return jsonResponse({ outcome, stock_changed: false }, outcome?.replayed ? 200 : 201);
      }
      if (action === "propose" || action === "report") {
        const args = proposeRequest(body, action === "report" ? "wrong_match_report" : null);
        let duplicates = null;
        if (args.p_kind === "new_item") {
          // Identify before create: the duplicate guard always runs first.
          duplicates = await services.rpc("atlas_recognition_find_duplicates", {
            p_values: objectOr(args.p_payload.values, {}, "payload.values"),
            p_codes: Array.isArray(args.p_payload.codes) ? args.p_payload.codes : [],
            p_aliases: Array.isArray(args.p_payload.aliases) ? args.p_payload.aliases : [],
            p_limit: 10, ...actorArgs(actor),
          });
        }
        const proposal = await services.rpc("atlas_recognition_propose", {
          ...args, p_actor_id: actor.userId, p_actor_label: actor.label ?? null, p_actor_role: actor.role,
        });
        return jsonResponse({ ...proposal, duplicates, stock_changed: false }, 201);
      }
      if (action === "duplicates") {
        const duplicates = await services.rpc("atlas_recognition_find_duplicates", { ...duplicatesRequest(body), ...actorArgs(actor) });
        return jsonResponse({ duplicates, stock_changed: false });
      }
      throw new ApiError(404, "not_found", "Unknown action.");
    } catch (error) {
      return errorResponse(error);
    }
  };
}
