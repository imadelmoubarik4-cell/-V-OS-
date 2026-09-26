// atlas-marketing-media request handling (S94A Media Library). Every side
// effect is injected so Node tests run it without the network:
//   env(name)             -> string | undefined
//   fetchImpl(url, init)  -> Response (Auth, PostgREST RPC, Storage)
//   now()                 -> epoch milliseconds
//   resolveActor(req)     -> optional override of _shared/auth.mjs resolveActor
//   services              -> optional override of createStorageServices()
//
// Media is for active managers and administrators (contract §8). The gateway
// checks the role, and every public.atlas_marketing_media_* RPC checks it
// again. Files live only in the private atlas-marketing-media bucket, which
// has no storage.objects policy. Bytes never pass through this function on
// upload: `reserve` returns a one-time signed upload token for exactly the
// server-chosen path, the browser uploads straight to Storage (single PUT up
// to 6 MiB, TUS resumable above), and `complete` verifies the stored object
// (size equality and magic bytes by ranged reads, server-parsed dimensions
// and duration) before the asset is ready. Browsers get 5-minute signed read
// URLs, never a storage path, never a service credential.
//
//   GET  ?action=list[&kind&tag&q&used&collection&archived&sort&cursor&limit]
//   GET  ?action=asset&id=                 one asset + 5-minute preview/thumb URLs
//   GET  ?action=collections[&archived=1]
//   POST ?action=reserve            {client_request_id, mime_type, byte_size, original_filename, client_hints, client_sha256?, title?}
//                                   -> {asset, upload:{url, token, method:'put'|'tus', expires_at, ...}}
//   POST ?action=complete           {asset_id}
//   POST ?action=abandon            {asset_id}
//   POST ?action=reserve-variant    {client_request_id, asset_id, purpose, mime_type, byte_size, aspect_ratio?, crop_rect?, source_time_ms?, width?, height?}
//   POST ?action=complete-variant   {variant_id}
//   POST ?action=update             {asset_id, title?, alt_text?, notes?, tags?, focal_point?, trim?, variant? | cover_variant_id?}
//   POST ?action=archive|restore|delete {asset_id}
//   POST ?action=collection-upsert  {id?, name, description?, campaign_id?, cover_asset_id?, asset_ids?}
//   POST ?action=collection-reorder {collection_id, asset_ids}
//   POST ?action=collection-archive {collection_id, archived?}
//   POST ?action=maintenance        (administrators) abandon expired uploads, purge due objects

import { AuthError, resolveActor as sharedResolveActor } from "../_shared/auth.mjs";

export const FUNCTION_VERSION = "0.1.0";
export const BUCKET = "atlas-marketing-media";
const MIB = 1024 * 1024;
export const LIMITS = Object.freeze({
  imageBytes: 30 * MIB,
  videoBytes: 1024 * MIB,
  variantBytes: 30 * MIB,
  // Single PUT up to this size; TUS resumable above (Supabase recommends TUS over 6 MB).
  singleUploadBytes: 6 * MIB,
  tusChunkBytes: 6 * MIB,
  jsonBytes: 64 * 1024,
  headBytes: 64 * 1024,
  moovBytes: 16 * MIB,
  boxHops: 16,
  // Browser preview and thumbnail links (contract §3: 5 minutes, never stored).
  signedPreviewSeconds: 300,
  // Storage fixes signed upload URLs at 2 hours.
  signedUploadSeconds: 7200,
  signBatch: 100,
  maintenanceBatch: 100,
});

// The only types a master may have, with the one extension each is stored
// under. SVG, HTML, GIF and everything else are refused.
export const MASTER_TYPES = Object.freeze({
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/png": { kind: "image", ext: "png" },
  "image/webp": { kind: "image", ext: "webp" },
  "image/heic": { kind: "image", ext: "heic" },
  "image/heif": { kind: "image", ext: "heif" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/quicktime": { kind: "video", ext: "mov" },
});
export const VARIANT_TYPES = Object.freeze({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" });
// File-name extensions a browser may send, and the type each implies.
export const EXTENSIONS = Object.freeze({
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", qt: "video/quicktime",
});
export const VARIANT_PURPOSES = Object.freeze(["thumb", "poster", "crop", "publish"]);
export const ASPECT_RATIOS = Object.freeze(["1:1", "4:5", "9:16", "16:9", "1.91:1", "4:3", "original"]);

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
  forbidden: "Media is for managers and administrators.",
  not_found: "That photo or video could not be found.",
  conflict: "This was already done. Refresh and try again.",
  unsupported_type: "Choose a JPEG, PNG, WebP or HEIC photo, or an MP4 or MOV video.",
  too_large: "Photos can be up to 30 MB and videos up to 1 GB.",
  quota: "You have too many unfinished uploads. Let them finish, or cancel some, then try again.",
  upload_missing: "The upload hasn’t arrived yet. Try again in a moment.",
  size_mismatch: "The uploaded file didn’t match what was sent. Nothing was kept. Upload it again.",
  in_use: "It’s used in a post that is waiting, scheduled or published. Remove it from those posts first.",
  content_locked: "This post can no longer change.",
  not_ready: "Only finished library media can be attached.",
  duplicate_name: "A collection with that name already exists.",
  too_many: "A post can have at most 35 photos and videos.",
  storage_failed: "The file could not be reached. Nothing was changed. Try again.",
  unavailable: "Media is unavailable right now. Nothing was changed. Try again in a moment.",
  internal: "Media could not complete that request. Nothing was changed.",
});

// Keys never returned to a browser (storage paths are for the gateway only).
function isHiddenKey(key) {
  return key === "storage_path" || key.endsWith("_path") || key === "bucket_id";
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

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-marketing-media-version": FUNCTION_VERSION,
    },
  });
}

export function errorResponse(error) {
  if (error instanceof ApiError) return jsonResponse({ error_code: error.code, message: error.message, ...error.extra }, error.status);
  if (error?.name === "AuthError" || error instanceof AuthError) {
    const code = error.status === 401 ? "unauthorized" : error.status === 403 ? "forbidden" : "unavailable";
    return jsonResponse({ error_code: code, message: code === "forbidden" ? MESSAGES.forbidden : error.message }, error.status);
  }
  console.error("[atlas-marketing-media] unexpected error", error?.name ?? "Error");
  return jsonResponse({ error_code: "internal", message: MESSAGES.internal }, 500);
}

// PostgREST error -> ApiError. The hint ('atlas:<code>') decides; database
// text is never passed on.
const HINTS = Object.freeze({
  invalid_request: 400, forbidden: 403, not_found: 404, conflict: 409, unsupported_type: 415, too_large: 413,
  quota: 429, upload_missing: 409, size_mismatch: 422, in_use: 409, content_locked: 409, not_ready: 409,
  duplicate_name: 409, too_many: 400,
});
export function mapRpcError(status, body) {
  const code = String(body?.code ?? "");
  const hint = String(body?.hint ?? "");
  const hinted = hint.startsWith("atlas:") ? hint.slice(6) : "";
  if (Object.prototype.hasOwnProperty.call(HINTS, hinted)) {
    const extra = {};
    if (hinted === "in_use") {
      try {
        const detail = JSON.parse(String(body?.details ?? "null"));
        if (detail && typeof detail === "object") extra.block = { reason: String(detail.reason ?? "in_use"), count: Number(detail.count) || 0 };
      } catch { /* no detail */ }
    }
    return new ApiError(HINTS[hinted], hinted, MESSAGES[hinted], extra);
  }
  if (code === "42501") return new ApiError(403, "forbidden", MESSAGES.forbidden);
  if (code === "P0002") return new ApiError(404, "not_found", MESSAGES.not_found);
  if (code === "22023" || code === "22P02") return new ApiError(400, "invalid_request", MESSAGES.invalid_request);
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
// Content sniffing and metadata: by content only, never by name or declared type.
// ---------------------------------------------------------------------------
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "heif", "mif2"]);
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V ", "M4VH", "M4VP", "mmp4", "3gp4", "3gp5", "3gp6", "3g2a", "f4v ", "msnv", "XAVC"]);
const QT_LEADING_ATOMS = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

const ascii = (b, start, text) => [...text].every((ch, index) => b[start + index] === ch.charCodeAt(0));
const fourcc = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const u16 = (b, at) => (b[at] << 8) | b[at + 1];
const u32 = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const u64 = (b, at) => u32(b, at) * 2 ** 32 + u32(b, at + 4);
const s32 = (b, at) => (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];

// The type the bytes really are, or null (SVG, HTML, PDF, GIF, text, ...).
export function sniffType(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && ascii(b, 1, "PNG\r\n\x1a\n")) return "image/png";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp";
  if (ascii(b, 4, "ftyp")) {
    const size = u32(b, 0);
    const brands = [fourcc(b, 8)];
    for (let at = 16; at + 4 <= Math.min(size, b.length) && brands.length < 32; at += 4) brands.push(fourcc(b, at));
    const major = brands[0];
    if (HEIF_BRANDS.has(major) || (!MP4_BRANDS.has(major) && major !== "qt  " && brands.some((brand) => HEIF_BRANDS.has(brand)))) {
      const heic = brands.some((brand) => brand.startsWith("hei") || brand.startsWith("hev"));
      return heic ? "image/heic" : "image/heif";
    }
    if (major === "qt  ") return "video/quicktime";
    if (brands.some((brand) => MP4_BRANDS.has(brand))) return "video/mp4";
    return null;
  }
  // Legacy QuickTime: no ftyp, a leading moov/mdat/wide/free atom.
  if (QT_LEADING_ATOMS.has(fourcc(b, 4)) && u32(b, 0) >= 8) return "video/quicktime";
  return null;
}

export function kindOf(mime) {
  return MASTER_TYPES[mime]?.kind ?? null;
}

function jpegOrientation(b, start, length) {
  // APP1 "Exif\0\0" then a TIFF header; tag 0x0112 is the orientation.
  if (!ascii(b, start, "Exif\0\0")) return 1;
  const tiff = start + 6;
  const little = b[tiff] === 0x49;
  const r16 = (at) => (little ? b[at] | (b[at + 1] << 8) : u16(b, at));
  const r32 = (at) => (little ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 2 ** 24 : u32(b, at));
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > start + length || ifd + 2 > b.length) return 1;
  const count = r16(ifd);
  for (let index = 0; index < count && index < 64; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > b.length) break;
    if (r16(entry) === 0x0112) return r16(entry + 8) || 1;
  }
  return 1;
}

// Width/height as displayed (EXIF orientation applied), or null.
export function imageDimensions(mime, b) {
  try {
    if (mime === "image/png" && b.length >= 24 && ascii(b, 12, "IHDR")) return { width: u32(b, 16), height: u32(b, 20) };
    if (mime === "image/jpeg") {
      let at = 2;
      let orientation = 1;
      while (at + 9 < b.length) {
        if (b[at] !== 0xff) { at += 1; continue; }
        const marker = b[at + 1];
        if (marker === 0xff) { at += 1; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
        if (marker === 0xd9 || marker === 0xda) break;
        const length = u16(b, at + 2);
        if (marker === 0xe1) orientation = jpegOrientation(b, at + 4, length - 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = u16(b, at + 5);
          const width = u16(b, at + 7);
          const rotated = orientation >= 5 && orientation <= 8;
          return {
            width: rotated ? height : width,
            height: rotated ? width : height,
            rotation: { 3: 180, 6: 90, 8: 270 }[orientation] ?? 0,
          };
        }
        at += 2 + length;
      }
      return null;
    }
    if (mime === "image/webp" && b.length >= 30) {
      const chunk = fourcc(b, 12);
      if (chunk === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
      if (chunk === "VP8L") {
        return {
          width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
          height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
        };
      }
      if (chunk === "VP8X") {
        return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      }
      return null;
    }
    if (mime === "image/heic" || mime === "image/heif") {
      // The largest 'ispe' (image spatial extent) is the primary image.
      let best = null;
      for (let at = 4; at + 16 <= b.length; at += 1) {
        if (b[at] === 0x69 && ascii(b, at, "ispe")) {
          const width = u32(b, at + 8);
          const height = u32(b, at + 12);
          if (!best || width * height > best.width * best.height) best = { width, height };
        }
      }
      return best;
    }
  } catch { /* malformed: fall back to hints */ }
  return null;
}

function* boxes(b, start, end) {
  let at = start;
  while (at + 8 <= end) {
    let size = u32(b, at);
    const type = fourcc(b, at + 4);
    let header = 8;
    if (size === 1) { size = u64(b, at + 8); header = 16; }
    if (size === 0) size = end - at;
    if (size < header || at + size > end) return;
    yield { type, start: at, body: at + header, end: at + size };
    at += size;
  }
}

function rotationFromMatrix(b, at) {
  const a = s32(b, at);
  const bb = s32(b, at + 4);
  const c = s32(b, at + 12);
  const d = s32(b, at + 16);
  const one = 0x10000;
  if (a === 0 && bb === one && c === -one && d === 0) return 90;
  if (a === -one && d === -one) return 180;
  if (a === 0 && bb === -one && c === one && d === 0) return 270;
  return 0;
}

// Parse a moov box: duration (mvhd), the video track's display size and
// rotation (tkhd matrix), and whether there is an audio track (hdlr).
export function parseMoov(b, start = 0, end = b.length) {
  const out = { duration_ms: null, width: null, height: null, rotation: 0, has_audio: false };
  for (const box of boxes(b, start, end)) {
    if (box.type === "moov") return parseMoov(b, box.body, box.end);
    if (box.type === "mvhd") {
      const version = b[box.body];
      const timescale = version === 1 ? u32(b, box.body + 20) : u32(b, box.body + 12);
      const duration = version === 1 ? u64(b, box.body + 24) : u32(b, box.body + 16);
      if (timescale > 0) out.duration_ms = Math.round((duration / timescale) * 1000);
    }
    if (box.type === "trak") {
      let handler = null;
      let tkhd = null;
      for (const child of boxes(b, box.body, box.end)) {
        if (child.type === "tkhd") {
          const version = b[child.body];
          const matrixAt = child.body + (version === 1 ? 52 : 40);
          const sizeAt = matrixAt + 36;
          tkhd = { width: u32(b, sizeAt) >>> 16, height: u32(b, sizeAt + 4) >>> 16, rotation: rotationFromMatrix(b, matrixAt) };
        }
        if (child.type === "mdia") {
          for (const inner of boxes(b, child.body, child.end)) {
            if (inner.type === "hdlr") handler = fourcc(b, inner.body + 8);
          }
        }
      }
      if (handler === "soun") out.has_audio = true;
      if (handler === "vide" && tkhd && tkhd.width > 0 && tkhd.height > 0 && out.width === null) {
        const rotated = tkhd.rotation === 90 || tkhd.rotation === 270;
        out.width = rotated ? tkhd.height : tkhd.width;
        out.height = rotated ? tkhd.width : tkhd.height;
        out.rotation = tkhd.rotation;
      }
    }
  }
  return out;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------
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
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}
function extensionOf(name) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(String(name ?? "").trim());
  return match ? match[1].toLowerCase() : null;
}

// Type and kind of a new master from what the browser declared. The declared
// MIME may be empty (some browsers give no type for HEIC); then the extension
// decides. Anything outside the allowlist, or a name and type that disagree,
// is refused before a row is reserved.
export function classifyUpload({ mime_type: mimeType, original_filename: fileName, kind }) {
  const declared = String(mimeType ?? "").trim().toLowerCase();
  const ext = extensionOf(fileName);
  if (ext && !EXTENSIONS[ext]) throw new ApiError(415, "unsupported_type", MESSAGES.unsupported_type);
  if (!declared && !ext) throw new ApiError(415, "unsupported_type", MESSAGES.unsupported_type);
  const mime = declared || EXTENSIONS[ext];
  if (!MASTER_TYPES[mime]) throw new ApiError(415, "unsupported_type", MESSAGES.unsupported_type);
  if (ext && EXTENSIONS[ext] !== mime && !(kindOf(EXTENSIONS[ext]) === "image" && ["image/heic", "image/heif"].includes(mime) && ["heic", "heif"].includes(ext))) {
    throw new ApiError(415, "unsupported_type", MESSAGES.unsupported_type);
  }
  const resolvedKind = MASTER_TYPES[mime].kind;
  if (kind !== undefined && kind !== null && kind !== resolvedKind) throw new ApiError(415, "unsupported_type", MESSAGES.unsupported_type);
  return { mime, kind: resolvedKind };
}

function filterParams(url) {
  const params = url.searchParams;
  const filters = {};
  const kind = params.get("kind");
  if (kind) {
    if (!["image", "video"].includes(kind)) throw invalid();
    filters.kind = kind;
  }
  const tags = params.getAll("tag").flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean);
  if (tags.length > 10) throw invalid();
  if (tags.length) filters.tags = tags.map((entry) => entry.slice(0, 48));
  const q = params.get("q");
  if (q && q.trim()) filters.q = q.trim().slice(0, 100);
  const used = params.get("used");
  if (used) {
    if (!["used", "unused"].includes(used)) throw invalid();
    filters.used = used;
  }
  const collection = params.get("collection");
  if (collection) filters.collection = requireUuid(collection);
  const archived = params.get("archived");
  if (archived === "1" || archived === "true") filters.archived = true;
  const sort = params.get("sort");
  if (sort) {
    if (!["newest", "oldest", "name"].includes(sort)) throw invalid();
    filters.sort = sort;
  }
  const cursor = params.get("cursor");
  if (cursor) {
    const offset = boundedInt(cursor, 0, 100000);
    if (offset === null) throw invalid();
    filters.cursor = offset;
  }
  const limit = params.get("limit");
  if (limit) {
    const count = boundedInt(limit, 1, 100);
    if (count === null) throw invalid();
    filters.limit = count;
  }
  return filters;
}

// ---------------------------------------------------------------------------
// Service-role access: the media RPCs and the private bucket.
// ---------------------------------------------------------------------------
export const RPCS = Object.freeze([
  "atlas_marketing_media_list", "atlas_marketing_media_get", "atlas_marketing_media_reserve", "atlas_marketing_media_upload_state",
  "atlas_marketing_media_complete", "atlas_marketing_media_abandon", "atlas_marketing_media_reserve_variant",
  "atlas_marketing_media_complete_variant", "atlas_marketing_media_update", "atlas_marketing_media_lifecycle",
  "atlas_marketing_media_collections", "atlas_marketing_media_collection_upsert", "atlas_marketing_media_collection_reorder",
  "atlas_marketing_media_collection_archive", "atlas_marketing_media_maintenance_candidates", "atlas_marketing_media_purge_confirm",
]);
const RPC_SET = new Set(RPCS);
const encodePath = (path) => String(path).split("/").map((part) => encodeURIComponent(part)).join("/");
const PATH_PATTERN = /^venues\/[a-z0-9-]{1,32}\/[0-9]{4}\/(0[1-9]|1[0-2])\/[0-9a-f-]{36}\/(original|v\/[0-9a-f-]{36})\.(jpg|png|webp|heic|heif|mp4|mov)$/;

export function createStorageServices({ env, fetchImpl }) {
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
    if (!RPC_SET.has(name)) throw new Error("rpc not allowed");
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
      console.warn(`[atlas-marketing-media] rpc ${name} failed`, response.status, parsed?.code ?? "-");
      throw mapRpcError(response.status, parsed);
    }
    return parsed;
  }

  // A one-time upload token for exactly this path (no upsert).
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
    const token = link.searchParams.get("token");
    if (!token) throw new ApiError(502, "storage_failed", MESSAGES.storage_failed);
    return { url: link.toString(), token };
  }

  // Short-lived read links for many paths in one call: Map(path -> url).
  async function sign(paths, seconds) {
    const { url, key } = credentials();
    const unique = [...new Set(paths.filter((path) => typeof path === "string" && PATH_PATTERN.test(path)))];
    const links = new Map();
    for (let index = 0; index < unique.length; index += LIMITS.signBatch) {
      const batch = unique.slice(index, index + LIMITS.signBatch);
      let response;
      try {
        response = await fetchImpl(`${url}/storage/v1/object/sign/${BUCKET}`, {
          method: "POST", headers: headers(key, { "content-type": "application/json", accept: "application/json" }),
          body: JSON.stringify({ expiresIn: seconds, paths: batch }),
        });
      } catch {
        continue;
      }
      if (!response.ok) continue;
      const payload = await response.json().catch(() => []);
      for (const entry of Array.isArray(payload) ? payload : []) {
        const value = entry?.signedURL || entry?.signedUrl || entry?.signed_url;
        if (!entry?.error && typeof entry?.path === "string" && typeof value === "string") links.set(entry.path, absolute(url, value));
      }
    }
    return links;
  }

  // At most `length` bytes from `start` (Range read; a server that ignores
  // Range is cut off after `length` bytes, so a file is never loaded whole).
  async function readRange(path, start, length) {
    const { url, key } = credentials();
    let response;
    try {
      response = await fetchImpl(`${url}/storage/v1/object/authenticated/${BUCKET}/${encodePath(checkPath(path))}`, {
        headers: headers(key, { range: `bytes=${start}-${start + length - 1}` }),
      });
    } catch {
      throw new ApiError(502, "storage_failed", MESSAGES.storage_failed);
    }
    if (!response.ok) throw new ApiError(502, "storage_failed", MESSAGES.storage_failed);
    const ranged = response.status === 206;
    const out = new Uint8Array(length);
    let filled = 0;
    let skip = ranged ? 0 : start;
    const reader = response.body?.getReader?.();
    if (!reader) {
      const all = new Uint8Array(await response.arrayBuffer());
      const slice = all.subarray(skip, skip + length);
      return slice.slice();
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value;
      if (skip > 0) {
        if (chunk.byteLength <= skip) { skip -= chunk.byteLength; continue; }
        chunk = chunk.subarray(skip);
        skip = 0;
      }
      const take = Math.min(chunk.byteLength, length - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (filled >= length) {
        try { await reader.cancel(); } catch { /* closed */ }
        break;
      }
    }
    return out.subarray(0, filled);
  }

  async function remove(paths) {
    const valid = paths.filter((path) => typeof path === "string" && PATH_PATTERN.test(path));
    if (!valid.length) return true;
    const { url, key } = credentials();
    try {
      const response = await fetchImpl(`${url}/storage/v1/object/${BUCKET}`, {
        method: "DELETE", headers: headers(key, { "content-type": "application/json" }), body: JSON.stringify({ prefixes: valid }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  function uploadEndpoints() {
    const { url } = credentials();
    // TUS: the direct storage hostname is recommended for large files
    // (https://<ref>.storage.supabase.co); ATLAS_MARKETING_MEDIA_TUS_URL overrides.
    const override = envValue(env, "ATLAS_MARKETING_MEDIA_TUS_URL");
    let tus = `${url}/storage/v1/upload/resumable`;
    if (override && /^https:\/\/[^/\s]+\/storage\/v1\/upload\/resumable$/.test(override)) tus = override;
    else {
      const match = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/.exec(url);
      if (match) tus = `https://${match[1]}.storage.supabase.co/storage/v1/upload/resumable`;
    }
    return { tus };
  }

  return { rpc, signUpload, sign, readRange, remove, uploadEndpoints };
}

// Replace every *thumb_path / *preview_path in a structure with a signed
// *_url (5 minutes) and drop all storage paths. Exported for the Marketing
// gateway, which shows attached media with the same short links.
export async function withSignedUrls(storage, value, seconds = LIMITS.signedPreviewSeconds) {
  const paths = [];
  const collect = (node) => {
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, entry] of Object.entries(node)) {
      if ((key === "thumb_path" || key === "preview_path" || key === "url_path") && typeof entry === "string") paths.push(entry);
      else collect(entry);
    }
  };
  collect(value);
  const links = paths.length ? await storage.sign(paths, seconds) : new Map();
  const rewrite = (node) => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, entry] of Object.entries(node)) {
      if (key === "thumb_path") out.thumb_url = typeof entry === "string" ? links.get(entry) ?? null : null;
      else if (key === "preview_path") out.preview_url = typeof entry === "string" ? links.get(entry) ?? null : null;
      else if (key === "url_path") out.url = typeof entry === "string" ? links.get(entry) ?? null : null;
      else if (!isHiddenKey(key)) out[key] = rewrite(entry);
    }
    return out;
  };
  return rewrite(value);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
const MANAGER_ROLES = new Set(["admin", "manager"]);

export function createMarketingMediaHandler({ env, fetchImpl, now = () => Date.now(), resolveActor = null, services = null } = {}) {
  const storage = services ?? createStorageServices({ env, fetchImpl });
  const resolve = resolveActor ?? ((request) => sharedResolveActor(request, { get: (name) => envValue(env, name) }, fetchImpl, {
    inactiveMessage: "This Atlas profile is inactive.",
  }));

  async function manager(request) {
    const actor = await resolve(request);
    if (!actor || actor.active === false || !MANAGER_ROLES.has(actor.role)) throw new ApiError(403, "forbidden", MESSAGES.forbidden);
    return actor;
  }

  async function uploadFor(path, bytes, expiresAt) {
    const signed = await storage.signUpload(path);
    const platformExpiry = now() + LIMITS.signedUploadSeconds * 1000;
    const rowExpiry = expiresAt ? Date.parse(expiresAt) : platformExpiry;
    const expires = new Date(Math.min(platformExpiry, Number.isFinite(rowExpiry) ? rowExpiry : platformExpiry)).toISOString();
    if (bytes <= LIMITS.singleUploadBytes) {
      return { method: "put", url: signed.url, token: signed.token, expires_at: expires };
    }
    return {
      method: "tus", url: storage.uploadEndpoints().tus, token: signed.token, expires_at: expires,
      chunk_size: LIMITS.tusChunkBytes, bucket: BUCKET, object_name: path,
    };
  }

  async function assetView(actor, id) {
    const asset = await storage.rpc("atlas_marketing_media_get", { p_actor_id: actor.userId, p_asset_id: id });
    // Preview: a browser-displayable master, else the JPEG publish copy (HEIC), else the thumbnail.
    const variants = Array.isArray(asset?.variants) ? asset.variants : [];
    const publish = variants.find((variant) => variant.id === asset.publish_variant_id);
    const displayable = asset.kind === "video" || ["image/jpeg", "image/png", "image/webp"].includes(asset.mime_type);
    const withPreview = {
      ...asset,
      preview_path: displayable ? asset.storage_path : publish?.storage_path ?? asset.thumb_path ?? null,
      variants: variants.map((variant) => ({ ...variant, url_path: variant.storage_path })),
    };
    return withSignedUrls(storage, withPreview);
  }

  async function reserve(actor, body) {
    const clientRequestId = requireUuid(body.client_request_id);
    const { mime, kind } = classifyUpload(body);
    const bytes = body.byte_size;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1) throw invalid();
    if (bytes > (kind === "image" ? LIMITS.imageBytes : LIMITS.videoBytes)) throw new ApiError(413, "too_large", MESSAGES.too_large);
    const hints = body.client_hints && typeof body.client_hints === "object" && !Array.isArray(body.client_hints) ? body.client_hints : {};
    const reserved = await storage.rpc("atlas_marketing_media_reserve", {
      p_actor_id: actor.userId,
      p_request: {
        client_request_id: clientRequestId, kind, mime_type: mime, byte_size: bytes,
        original_filename: cleanText(body.original_filename, 255),
        title: cleanText(body.title, 180),
        client_sha256: typeof body.client_sha256 === "string" && /^[0-9a-f]{64}$/.test(body.client_sha256) ? body.client_sha256 : null,
        client_hints: {
          width: boundedInt(hints.width, 1, 16384), height: boundedInt(hints.height, 1, 16384),
          duration_ms: kind === "video" ? boundedInt(hints.duration_ms, 0, 3600000) : null,
        },
      },
    });
    const asset = reserved?.asset ?? {};
    if (asset.status !== "pending_upload") return { asset: await withSignedUrls(storage, asset), upload: null, replayed: true };
    const upload = await uploadFor(reserved.storage_path, bytes, null);
    return { asset: stripPaths(asset), upload, replayed: Boolean(reserved.replayed) };
  }

  // Verify an uploaded object. Returns the verified facts or throws after
  // recording the rejection and removing the object.
  async function verifyObject(state, { reject, variant }) {
    const object = state.object;
    if (!object || object.size === null || object.size === undefined) {
      throw new ApiError(409, "upload_missing", MESSAGES.upload_missing);
    }
    if (Number(object.size) !== Number(state.declared_bytes)) {
      await reject("size_mismatch");
      throw new ApiError(422, "size_mismatch", MESSAGES.size_mismatch);
    }
    const size = Number(object.size);
    const imageLike = variant || state.kind === "image";
    // Photos (at most 30 MiB) are read whole: sniffed, measured and hashed.
    // Videos are read by ranges only.
    const head = await storage.readRange(state.storage_path, 0, imageLike ? Math.min(size, LIMITS.imageBytes) : Math.min(size, LIMITS.headBytes));
    const sniffed = sniffType(head);
    const allowed = variant ? Boolean(VARIANT_TYPES[sniffed]) && sniffed === state.declared_mime : kindOf(sniffed) === state.kind;
    if (!sniffed || !allowed) {
      await reject("magic_bytes");
      throw new ApiError(415, "unsupported_type", MESSAGES.unsupported_type);
    }
    const result = { outcome: "ready", mime_type: sniffed, byte_size: size, server_probe: "none" };
    if (imageLike) {
      if (head.byteLength === size) result.sha256 = await sha256Hex(head);
      const dims = imageDimensions(sniffed, head);
      if (dims?.width && dims?.height) {
        Object.assign(result, { width: dims.width, height: dims.height, server_probe: "full" });
        if (Number.isInteger(dims.rotation)) result.rotation = dims.rotation;
      }
      return result;
    }
    const probe = await probeVideo(state.storage_path, head, size);
    if (probe) {
      for (const key of ["duration_ms", "width", "height", "rotation", "has_audio"]) if (probe[key] !== null && probe[key] !== undefined) result[key] = probe[key];
      result.server_probe = probe.width && probe.duration_ms !== null ? "full" : "partial";
    }
    return result;
  }

  // Walk the top-level ISO-BMFF boxes to moov (it may follow a large mdat,
  // as camera files often do) with small ranged reads, then parse it.
  async function probeVideo(path, head, size) {
    try {
      let at = 0;
      for (let hop = 0; hop < LIMITS.boxHops && at + 8 <= size; hop += 1) {
        const header = at + 16 <= head.byteLength ? head.subarray(at, at + 16) : await storage.readRange(path, at, Math.min(16, size - at));
        if (header.byteLength < 8) return null;
        let boxSize = u32(header, 0);
        const type = fourcc(header, 4);
        if (boxSize === 1 && header.byteLength >= 16) boxSize = u64(header, 8);
        if (boxSize === 0) boxSize = size - at;
        if (boxSize < 8) return null;
        if (type === "moov") {
          if (boxSize > LIMITS.moovBytes) return null;
          const moov = at + boxSize <= head.byteLength ? head.subarray(at, at + boxSize) : await storage.readRange(path, at, boxSize);
          return parseMoov(moov, 0, moov.byteLength);
        }
        at += boxSize;
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
    }
    return null;
  }

  async function complete(actor, body) {
    const assetId = requireUuid(body.asset_id);
    const state = await storage.rpc("atlas_marketing_media_upload_state", { p_actor_id: actor.userId, p_asset_id: assetId, p_variant_id: null });
    if (state.status === "ready") {
      return { asset: await withSignedUrls(storage, await storage.rpc("atlas_marketing_media_get", { p_actor_id: actor.userId, p_asset_id: assetId })), replayed: true };
    }
    if (!["pending_upload", "verifying"].includes(state.status)) throw new ApiError(409, "conflict", MESSAGES.conflict);
    const reject = async (reason) => {
      await storage.rpc("atlas_marketing_media_complete", { p_actor_id: actor.userId, p_asset_id: assetId, p_result: { outcome: "rejected", reject_reason: reason } });
      await storage.remove([state.storage_path]);
    };
    const result = await verifyObject(state, { reject, variant: false });
    let done;
    try {
      done = await storage.rpc("atlas_marketing_media_complete", { p_actor_id: actor.userId, p_asset_id: assetId, p_result: result });
    } catch (error) {
      // The object changed between the read and the record (a second PUT raced us).
      if (error instanceof ApiError && error.code === "size_mismatch") await reject("size_mismatch");
      throw error;
    }
    return { asset: await withSignedUrls(storage, done.asset), replayed: Boolean(done.replayed) };
  }

  async function abandon(actor, body) {
    const result = await storage.rpc("atlas_marketing_media_abandon", { p_actor_id: actor.userId, p_asset_id: requireUuid(body.asset_id) });
    await storage.remove([result.storage_path]);
    return { asset_id: result.asset_id, status: result.status };
  }

  async function reserveVariant(actor, body) {
    const mime = String(body.mime_type ?? "").toLowerCase();
    if (!VARIANT_TYPES[mime]) throw new ApiError(415, "unsupported_type", MESSAGES.unsupported_type);
    const purpose = String(body.purpose ?? "");
    if (!VARIANT_PURPOSES.includes(purpose)) throw invalid();
    const bytes = body.byte_size;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1) throw invalid();
    if (bytes > LIMITS.variantBytes) throw new ApiError(413, "too_large", MESSAGES.too_large);
    const aspect = body.aspect_ratio === undefined || body.aspect_ratio === null ? null : String(body.aspect_ratio);
    if (aspect !== null && !ASPECT_RATIOS.includes(aspect)) throw invalid();
    let rect = null;
    if (body.crop_rect !== undefined && body.crop_rect !== null) {
      const r = body.crop_rect;
      const values = ["x", "y", "w", "h"].map((key) => Number(r?.[key]));
      if (values.some((value) => !Number.isFinite(value))) throw invalid();
      rect = { x: values[0], y: values[1], w: values[2], h: values[3] };
    }
    const reserved = await storage.rpc("atlas_marketing_media_reserve_variant", {
      p_actor_id: actor.userId,
      p_request: {
        client_request_id: requireUuid(body.client_request_id), asset_id: requireUuid(body.asset_id), purpose, mime_type: mime,
        byte_size: bytes, aspect_ratio: aspect, crop_rect: rect,
        source_time_ms: boundedInt(body.source_time_ms, 0, 3600000),
        width: boundedInt(body.width, 1, 8192), height: boundedInt(body.height, 1, 8192),
      },
    });
    const variant = reserved?.variant ?? {};
    if (variant.status !== "pending_upload") return { variant: stripPaths(variant), upload: null, replayed: true };
    return { variant: stripPaths(variant), upload: await uploadFor(reserved.storage_path, bytes, null), replayed: Boolean(reserved.replayed) };
  }

  async function completeVariant(actor, body) {
    const variantId = requireUuid(body.variant_id);
    const state = await storage.rpc("atlas_marketing_media_upload_state", { p_actor_id: actor.userId, p_asset_id: null, p_variant_id: variantId });
    if (state.status === "ready") return { variant: stripPaths((await storage.rpc("atlas_marketing_media_complete_variant", { p_actor_id: actor.userId, p_variant_id: variantId, p_result: {} })).variant), replayed: true };
    if (state.status !== "pending_upload") throw new ApiError(409, "conflict", MESSAGES.conflict);
    const reject = async (reason) => {
      await storage.rpc("atlas_marketing_media_complete_variant", { p_actor_id: actor.userId, p_variant_id: variantId, p_result: { outcome: "rejected", reject_reason: reason } });
      await storage.remove([state.storage_path]);
    };
    const result = await verifyObject(state, { reject, variant: true });
    const done = await storage.rpc("atlas_marketing_media_complete_variant", { p_actor_id: actor.userId, p_variant_id: variantId, p_result: result });
    const variant = done.variant ?? {};
    return { variant: await withSignedUrls(storage, { ...variant, url_path: variant.storage_path }), replayed: Boolean(done.replayed) };
  }

  async function update(actor, body) {
    const patch = {};
    if ("title" in body) patch.title = cleanText(body.title, 180);
    if ("alt_text" in body) patch.alt_text = cleanText(body.alt_text, 1000);
    if ("notes" in body) patch.notes = cleanText(body.notes, 4000);
    if ("tags" in body) {
      if (!Array.isArray(body.tags) || body.tags.length > 20 || body.tags.some((tag) => typeof tag !== "string")) throw invalid();
      patch.tags = body.tags.map((tag) => tag.trim().slice(0, 48)).filter(Boolean);
    }
    if ("focal_point" in body) {
      const point = body.focal_point;
      if (point === null) patch.focal_point = null;
      else {
        const x = Number(point?.x);
        const y = Number(point?.y);
        if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw invalid();
        patch.focal_point = { x, y };
      }
    }
    if ("trim" in body) {
      const trim = body.trim;
      if (trim === null) patch.trim = null;
      else {
        const start = boundedInt(trim?.start_ms, 0, 3600000);
        const end = boundedInt(trim?.end_ms, 1, 3600000);
        if (start === null || end === null || end <= start) throw invalid("End must be after start.");
        patch.trim = { start_ms: start, end_ms: end };
      }
    }
    if ("variant" in body || "cover_variant_id" in body) patch.cover_variant_id = optionalUuid(body.cover_variant_id ?? body.variant);
    if ("rights_status" in body) {
      if (!["owned", "licensed", "user_generated_permission", "unknown"].includes(body.rights_status)) throw invalid();
      patch.rights_status = body.rights_status;
    }
    if ("people_consent" in body) {
      if (body.people_consent !== null && typeof body.people_consent !== "boolean") throw invalid();
      patch.people_consent = body.people_consent;
    }
    const assetId = requireUuid(body.asset_id);
    await storage.rpc("atlas_marketing_media_update", { p_actor_id: actor.userId, p_asset_id: assetId, p_patch: patch });
    return { asset: await assetView(actor, assetId) };
  }

  async function lifecycle(actor, action, body) {
    const result = await storage.rpc("atlas_marketing_media_lifecycle", { p_actor_id: actor.userId, p_asset_id: requireUuid(body.asset_id), p_action: action });
    return { asset: await withSignedUrls(storage, result.asset), detached: Number(result.detached ?? 0) };
  }

  async function collections(actor, includeArchived) {
    const result = await storage.rpc("atlas_marketing_media_collections", { p_actor_id: actor.userId, p_include_archived: includeArchived });
    return withSignedUrls(storage, result);
  }

  async function collectionUpsert(actor, body) {
    const payload = {};
    if (body.id) payload.id = requireUuid(body.id);
    if ("name" in body) payload.name = cleanText(body.name, 120);
    if ("description" in body) payload.description = cleanText(body.description, 2000);
    if ("campaign_id" in body) payload.campaign_id = optionalUuid(body.campaign_id);
    if ("cover_asset_id" in body) payload.cover_asset_id = optionalUuid(body.cover_asset_id);
    if ("asset_ids" in body) {
      if (!Array.isArray(body.asset_ids) || body.asset_ids.length > 200) throw invalid();
      payload.asset_ids = body.asset_ids.map(requireUuid);
    }
    if (!payload.id && !payload.name) throw invalid("Give the collection a name.");
    const collection = await storage.rpc("atlas_marketing_media_collection_upsert", { p_actor_id: actor.userId, p_collection: payload });
    return { collection: await withSignedUrls(storage, collection) };
  }

  async function collectionReorder(actor, body) {
    if (!Array.isArray(body.asset_ids) || body.asset_ids.length > 200) throw invalid();
    const collection = await storage.rpc("atlas_marketing_media_collection_reorder", {
      p_actor_id: actor.userId, p_collection_id: requireUuid(body.collection_id), p_asset_ids: body.asset_ids.map(requireUuid),
    });
    return { collection: await withSignedUrls(storage, collection) };
  }

  async function collectionArchive(actor, body) {
    const collection = await storage.rpc("atlas_marketing_media_collection_archive", {
      p_actor_id: actor.userId, p_collection_id: requireUuid(body.collection_id), p_archived: body.archived !== false,
    });
    return { collection: await withSignedUrls(storage, collection) };
  }

  // Administrators: abandon expired uploads and purge due objects. Rows are
  // removed only after their objects were removed.
  async function maintenance(actor) {
    if (actor.role !== "admin") throw new ApiError(403, "forbidden", "Media maintenance is for administrators.");
    const candidates = await storage.rpc("atlas_marketing_media_maintenance_candidates", { p_actor_id: actor.userId, p_limit: LIMITS.maintenanceBatch });
    const assets = Array.isArray(candidates?.assets) ? candidates.assets : [];
    const variants = Array.isArray(candidates?.variants) ? candidates.variants : [];
    const assetIds = [];
    for (const entry of assets) {
      if (await storage.remove(Array.isArray(entry.paths) ? entry.paths : [])) assetIds.push(entry.asset_id);
    }
    const variantIds = [];
    for (const entry of variants) {
      if (await storage.remove([entry.path])) variantIds.push(entry.variant_id);
    }
    const purged = await storage.rpc("atlas_marketing_media_purge_confirm", { p_actor_id: actor.userId, p_asset_ids: assetIds, p_variant_ids: variantIds });
    return { purged_assets: Number(purged?.assets ?? 0), purged_variants: Number(purged?.variants ?? 0) };
  }

  return async function handle(request) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    try {
      const url = new URL(request.url);
      const action = url.searchParams.get("action") || "list";
      const actor = await manager(request);
      if (request.method === "GET") {
        if (action === "list") {
          const result = await storage.rpc("atlas_marketing_media_list", { p_actor_id: actor.userId, p_filters: filterParams(url) });
          return jsonResponse(await withSignedUrls(storage, result));
        }
        if (action === "asset") return jsonResponse({ asset: await assetView(actor, requireUuid(url.searchParams.get("id"))) });
        if (action === "collections") return jsonResponse(await collections(actor, ["1", "true"].includes(url.searchParams.get("archived") ?? "")));
        throw new ApiError(404, "not_found", MESSAGES.not_found);
      }
      if (request.method !== "POST") throw new ApiError(405, "invalid_request", MESSAGES.invalid_request);
      const body = await readJson(request);
      switch (action) {
        case "reserve": return jsonResponse(await reserve(actor, body));
        case "complete": return jsonResponse(await complete(actor, body));
        case "abandon": return jsonResponse(await abandon(actor, body));
        case "reserve-variant": return jsonResponse(await reserveVariant(actor, body));
        case "complete-variant": return jsonResponse(await completeVariant(actor, body));
        case "update": return jsonResponse(await update(actor, body));
        case "archive": case "restore": case "delete": return jsonResponse(await lifecycle(actor, action, body));
        case "collection-upsert": return jsonResponse(await collectionUpsert(actor, body));
        case "collection-reorder": return jsonResponse(await collectionReorder(actor, body));
        case "collection-archive": return jsonResponse(await collectionArchive(actor, body));
        case "maintenance": return jsonResponse(await maintenance(actor));
        default: throw new ApiError(404, "not_found", MESSAGES.not_found);
      }
    } catch (error) {
      return errorResponse(error);
    }
  };
}
