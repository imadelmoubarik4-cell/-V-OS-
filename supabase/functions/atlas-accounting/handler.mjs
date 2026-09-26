// atlas-accounting request handling (S92). Every side effect is injected so
// Node tests run it without the network:
//   env(name)             -> string | undefined
//   fetchImpl(url, init)  -> Response (Auth, PostgREST, Storage, OpenAI)
//   newId()               -> uuid (document ids and storage object names)
//   resolveActor(req)     -> optional override of _shared/auth.mjs resolveActor
//
// Accounting is for administrators only (owner decision). The gateway checks
// the role, and every public.atlas_accounting_* RPC checks it again. Files go
// only to the private atlas-accounting-documents bucket under
// documents/<document id>/; a browser never gets storage credentials, only a
// short signed link to one file after the admin check.
//
//   GET  ?action=snapshot                 the workspace
//   GET  ?action=document&id=             one document with its history
//   GET  ?action=file&id=                 a 5-minute signed link to the file
//   GET  ?action=export&from=&to=         approved, paid and void documents + links
//   POST ?action=upload   (multipart)     file, request_id, fields (JSON)
//   POST ?action=read     {id, again?}    Atlas reads the file into a draft (again: re-read)
//   POST ?action=command  {id, version, command, payload}

import { AuthError, resolveActor as sharedResolveActor } from "../_shared/auth.mjs";
import { callDocumentModel, prefillFrom, ReadError, safeFileName, visionModelFrom, EXTRACTOR_VERSION } from "./extract.mjs";

export const FUNCTION_VERSION = "0.1.0";
export const BUCKET = "atlas-accounting-documents";
export const LIMITS = Object.freeze({
  fileBytes: 15 * 1024 * 1024,
  multipartOverheadBytes: 256 * 1024,
  jsonBytes: 64 * 1024,
  // What the model is sent. Larger files are stored but typed in by hand.
  readBytes: 5 * 1024 * 1024,
  readTimeoutMs: 45000,
  dailyReads: 60,
  // Estimated model spend per 24 hours (ATLAS_ACCOUNTING_READ_BUDGET_USD overrides).
  dailyBudgetUsd: 2,
  signedFileSeconds: 300,
  signedExportSeconds: 900,
});
export const COMMANDS = Object.freeze(["save", "approve", "reopen", "mark_paid", "unmark_paid", "void", "discard"]);

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
  forbidden: "Accounting is for administrators.",
  not_found: "That document could not be found.",
  stale_request: "This document changed while you were working. It has been reloaded — check it and try again.",
  conflict: "This was already done. Refresh and try again.",
  duplicate_file: "This file is already in Accounting.",
  possible_duplicate: "This looks like a document that is already in Accounting. Check it, then confirm to approve anyway.",
  missing_fields: "Add the supplier, the document date and the total before approving.",
  append_only: "Accounting records are kept for 7 years and can’t be deleted.",
  too_large: "Files can be up to 15 MB.",
  unsupported_type: "Upload a PDF, or a JPEG, PNG, WebP or HEIC photo.",
  rate_limited: "Atlas has read today’s limit of documents. Type the details in by hand, or try again tomorrow.",
  storage_failed: "The file could not be stored. Nothing was saved. Try again.",
  unavailable: "Accounting is unavailable right now. Nothing was changed. Try again in a moment.",
  internal: "Accounting could not complete that request. Nothing was changed.",
});

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-accounting-version": FUNCTION_VERSION,
    },
  });
}

export function errorResponse(error) {
  if (error instanceof ApiError) return jsonResponse({ error_code: error.code, message: error.message, ...error.extra }, error.status);
  if (error?.name === "AuthError" || error instanceof AuthError) {
    const code = error.status === 401 ? "unauthorized" : error.status === 403 ? "forbidden" : "unavailable";
    return jsonResponse({ error_code: code, message: code === "forbidden" ? MESSAGES.forbidden : error.message }, error.status);
  }
  console.error("[atlas-accounting] unexpected error", error?.name ?? "Error");
  return jsonResponse({ error_code: "internal", message: MESSAGES.internal }, 500);
}

// PostgREST error -> ApiError. The hint ('atlas:<code>') decides; database
// text is never passed on.
const HINTS = Object.freeze({
  invalid_request: 400, forbidden: 403, not_found: 404, stale_request: 409, duplicate_file: 409,
  possible_duplicate: 409, missing_fields: 422, append_only: 409,
});
export function mapRpcError(status, body) {
  const code = String(body?.code ?? "");
  const message = String(body?.message ?? "");
  const hint = String(body?.hint ?? "");
  if (message.startsWith("rate_limited:")) return new ApiError(429, "rate_limited", MESSAGES.rate_limited);
  const hinted = hint.startsWith("atlas:") ? hint.slice(6) : "";
  if (Object.prototype.hasOwnProperty.call(HINTS, hinted)) return new ApiError(HINTS[hinted], hinted, MESSAGES[hinted]);
  if (code === "42501") return new ApiError(403, "forbidden", MESSAGES.forbidden);
  if (code === "P0002") return new ApiError(404, "not_found", MESSAGES.not_found);
  if (code === "22023" || code === "22P02" || code === "22007" || code === "22008") return new ApiError(400, "invalid_request", MESSAGES.invalid_request);
  if (code === "40001") return new ApiError(409, "stale_request", MESSAGES.stale_request);
  if (code === "23505") return new ApiError(409, "conflict", MESSAGES.conflict);
  return new ApiError(status >= 500 ? 503 : 502, "unavailable", MESSAGES.unavailable);
}

function envValue(env, name) {
  const value = typeof env === "function" ? env(name) : env?.[name];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

// ---------------------------------------------------------------------------
// Files: sniffed by content, never by name or declared type.
// ---------------------------------------------------------------------------
export const FILE_TYPES = Object.freeze({
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
});
const READABLE = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "heif", "mif2"]);

export function sniffType(b) {
  if (!b || b.length < 12) return null;
  const ascii = (start, text) => [...text].every((ch, index) => b[start + index] === ch.charCodeAt(0));
  if (ascii(0, "%PDF-")) return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && ascii(1, "PNG")) return "image/png";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (HEIF_BRANDS.has(brand)) return brand.startsWith("hei") || brand.startsWith("hev") ? "image/heic" : "image/heif";
  }
  return null;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBytes(request, maxBytes, code = "too_large") {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw new ApiError(413, code, MESSAGES[code] ?? MESSAGES.too_large);
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
      throw new ApiError(413, code, MESSAGES[code] ?? MESSAGES.too_large);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

async function readJson(request) {
  const bytes = await readBytes(request, LIMITS.jsonBytes, "invalid_request");
  if (!bytes.length) return {};
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new ApiError(400, "invalid_request", MESSAGES.invalid_request);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requireUuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new ApiError(400, "invalid_request", MESSAGES.invalid_request);
  return value.toLowerCase();
}
function requireDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ApiError(400, "invalid_request", MESSAGES.invalid_request);
  }
  return value;
}

// The editable fields a browser may send. Anything else is dropped here and
// validated again in the database.
export const FIELD_KEYS = Object.freeze([
  "kind", "category", "supplier_id", "supplier_name", "supplier_kennitala", "document_number", "issue_date", "due_date",
  "currency", "net_amount", "vat_amount", "total_amount", "vat_lines", "purchase_order_id", "note", "paid_by", "paid_by_profile_id",
]);
export function pickFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const key of FIELD_KEYS) if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
  return out;
}

// ---------------------------------------------------------------------------
// Service-role access: the accounting RPCs, suppliers and the private bucket.
// ---------------------------------------------------------------------------
const RPCS = new Set([
  "atlas_accounting_snapshot", "atlas_accounting_document", "atlas_accounting_find_file", "atlas_accounting_create",
  "atlas_accounting_begin_read", "atlas_accounting_command", "atlas_accounting_file", "atlas_accounting_export",
]);
const encodePath = (path) => String(path).split("/").map((part) => encodeURIComponent(part)).join("/");

export function createServices({ env, fetchImpl }) {
  function credentials() {
    const url = String(envValue(env, "SUPABASE_URL") ?? "").replace(/\/+$/, "");
    const key = String(envValue(env, "SUPABASE_SERVICE_ROLE_KEY") ?? "");
    if (!/^https?:\/\/[^/\s]+$/.test(url) || !key) throw new ApiError(503, "unavailable", MESSAGES.unavailable);
    return { url, key };
  }
  const headers = (key, extra = {}) => ({ apikey: key, authorization: `Bearer ${key}`, "cache-control": "no-store", ...extra });

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
      console.warn(`[atlas-accounting] rpc ${name} failed`, response.status, parsed?.code ?? "-");
      throw mapRpcError(response.status, parsed);
    }
    return parsed;
  }

  async function suppliers() {
    const { url, key } = credentials();
    try {
      const response = await fetchImpl(`${url}/rest/v1/suppliers?select=id,name&active=is.true&limit=500`, { headers: headers(key, { accept: "application/json" }) });
      if (!response.ok) return [];
      const rows = await response.json();
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  async function upload(path, bytes, mime) {
    const { url, key } = credentials();
    let response;
    try {
      response = await fetchImpl(`${url}/storage/v1/object/${BUCKET}/${encodePath(path)}`, {
        method: "POST", headers: headers(key, { "content-type": mime, "x-upsert": "false" }), body: bytes,
      });
    } catch {
      throw new ApiError(502, "storage_failed", MESSAGES.storage_failed);
    }
    if (!response.ok) throw new ApiError(502, "storage_failed", MESSAGES.storage_failed);
  }

  async function download(path) {
    const { url, key } = credentials();
    let response;
    try {
      response = await fetchImpl(`${url}/storage/v1/object/${BUCKET}/${encodePath(path)}`, { headers: headers(key) });
    } catch {
      throw new ApiError(502, "storage_failed", MESSAGES.unavailable);
    }
    if (!response.ok) throw new ApiError(502, "storage_failed", MESSAGES.unavailable);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function remove(path) {
    const { url, key } = credentials();
    try {
      await fetchImpl(`${url}/storage/v1/object/${BUCKET}`, {
        method: "DELETE", headers: headers(key, { "content-type": "application/json" }), body: JSON.stringify({ prefixes: [path] }),
      });
    } catch { /* the record already says discarded; a stray object is harmless and private */ }
  }

  async function sign(path, seconds, downloadName = null) {
    const { url, key } = credentials();
    let response;
    try {
      response = await fetchImpl(`${url}/storage/v1/object/sign/${BUCKET}/${encodePath(path)}`, {
        method: "POST", headers: headers(key, { "content-type": "application/json", accept: "application/json" }),
        body: JSON.stringify({ expiresIn: seconds }),
      });
    } catch {
      throw new ApiError(502, "storage_failed", MESSAGES.unavailable);
    }
    const payload = await response.json().catch(() => ({}));
    const value = payload?.signedURL || payload?.signedUrl || payload?.signed_url;
    if (!response.ok || typeof value !== "string") throw new ApiError(502, "storage_failed", MESSAGES.unavailable);
    let link;
    if (/^https?:\/\//i.test(value)) link = value;
    else if (value.startsWith("/storage/v1/")) link = `${url}${value}`;
    else if (value.startsWith("/object/")) link = `${url}/storage/v1${value}`;
    else link = `${url}/storage/v1/${value.replace(/^\/+/, "")}`;
    if (downloadName) link += `${link.includes("?") ? "&" : "?"}download=${encodeURIComponent(downloadName)}`;
    return link;
  }

  return { rpc, suppliers, upload, download, remove, sign };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export function createAccountingHandler({ env, fetchImpl, newId = () => crypto.randomUUID(), resolveActor = null, services = null } = {}) {
  const svc = services ?? createServices({ env, fetchImpl });
  // _shared/auth.mjs reads settings from an object with get() (Deno.env) or a
  // plain object; index.ts passes a function, so it is wrapped here.
  const resolve = resolveActor ?? ((request) => sharedResolveActor(request, { get: (name) => envValue(env, name) }, fetchImpl, {
    inactiveMessage: "This Atlas profile is inactive.",
  }));

  async function admin(request) {
    const actor = await resolve(request);
    if (!actor || actor.active === false || actor.role !== "admin") throw new ApiError(403, "forbidden", MESSAGES.forbidden);
    return actor;
  }

  async function uploadDocument(actor, request) {
    const type = String(request.headers.get("content-type") ?? "").toLowerCase();
    if (!type.startsWith("multipart/form-data")) throw new ApiError(400, "invalid_request", MESSAGES.invalid_request);
    const raw = await readBytes(request, LIMITS.fileBytes + LIMITS.multipartOverheadBytes);
    let form;
    try {
      form = await new Response(raw, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    } catch {
      throw new ApiError(400, "invalid_request", MESSAGES.invalid_request);
    }
    const requestId = requireUuid(form.get("request_id"));
    let fields = {};
    const fieldText = form.get("fields");
    if (typeof fieldText === "string" && fieldText.trim()) {
      try { fields = pickFields(JSON.parse(fieldText)); } catch { throw new ApiError(400, "invalid_request", MESSAGES.invalid_request); }
    }
    const file = form.get("file");
    if (!file || typeof file === "string") throw new ApiError(400, "invalid_request", "Choose a file to upload.");
    if (file.size > LIMITS.fileBytes) throw new ApiError(413, "too_large", MESSAGES.too_large);
    if (file.size === 0) throw new ApiError(400, "invalid_request", "The file is empty.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffType(bytes);
    if (!mime) throw new ApiError(415, "unsupported_type", MESSAGES.unsupported_type);
    const sha256 = await sha256Hex(bytes);

    const existing = await svc.rpc("atlas_accounting_find_file", { p_actor_id: actor.userId, p_sha256: sha256, p_request_id: requestId });
    // A retry of an upload that was already recorded replays it.
    if (existing?.replayed) return { document: existing.document, readable: READABLE.has(mime) && bytes.byteLength <= LIMITS.readBytes, replayed: true };
    if (existing?.id) {
      throw new ApiError(409, "duplicate_file", MESSAGES.duplicate_file, { existing: { id: existing.id, status: existing.status } });
    }
    const documentId = newId();
    const path = `documents/${documentId}/${newId()}.${FILE_TYPES[mime]}`;
    await svc.upload(path, bytes, mime);
    try {
      const document = await svc.rpc("atlas_accounting_create", {
        p_actor_id: actor.userId,
        p_request_id: requestId,
        p_file: { document_id: documentId, storage_path: path, mime_type: mime, byte_size: bytes.byteLength, sha256, file_name: safeFileName(file.name) },
        p_fields: fields,
      });
      // A replayed request returns the first upload; this second copy goes.
      if (document?.replayed) await svc.remove(path);
      return { document, readable: READABLE.has(mime) && bytes.byteLength <= LIMITS.readBytes };
    } catch (error) {
      // Remove the stored file only when the record certainly does not exist:
      // a definite refusal (4xx), or no record found for this request after an
      // unclear failure (the database may have committed before the reply was
      // lost; that record keeps its file for 7 years).
      const refused = error instanceof ApiError && error.status < 500;
      let recorded = false;
      if (!refused) {
        try {
          const again = await svc.rpc("atlas_accounting_find_file", { p_actor_id: actor.userId, p_sha256: sha256, p_request_id: requestId });
          recorded = Boolean(again?.replayed);
        } catch {
          recorded = true;
        }
      }
      if (!recorded) await svc.remove(path);
      throw error;
    }
  }

  async function readDocument(actor, body) {
    const id = requireUuid(body.id);
    const record = (payload) => svc.rpc("atlas_accounting_command", {
      p_actor_id: actor.userId, p_id: id, p_version: null, p_command: "record_read", p_payload: payload,
    });
    const apiKey = envValue(env, "OPENAI_API_KEY");
    // Without a key nothing is spent and the limit is not touched.
    if (!apiKey) return { document: await record({ outcome: "not_configured" }), outcome: "not_configured" };
    const budget = Number(envValue(env, "ATLAS_ACCOUNTING_READ_BUDGET_USD"));
    // begin_read decides under the document's row lock: a document Atlas
    // read is only read again with again: true (Read again), and a read in
    // progress is never started twice. Nothing is spent in either case.
    const started = await svc.rpc("atlas_accounting_begin_read", {
      p_actor_id: actor.userId, p_id: id, p_daily_limit: LIMITS.dailyReads,
      p_daily_budget_usd: Number.isFinite(budget) && budget > 0 ? budget : LIMITS.dailyBudgetUsd,
      p_max_bytes: LIMITS.readBytes, p_again: body.again === true,
    });
    if (started?.already === "read" || started?.already === "reading") {
      const current = await svc.rpc("atlas_accounting_document", { p_actor_id: actor.userId, p_id: id });
      return { document: current, outcome: started.already === "read" ? "already_read" : "reading" };
    }
    if (!started?.ai_enabled) return { document: await record({ outcome: "not_configured" }), outcome: "not_configured" };
    if (started.too_large) return { document: await record({ outcome: "not_readable" }), outcome: "not_readable" };
    if (!READABLE.has(started.mime_type)) return { document: await record({ outcome: "not_readable" }), outcome: "not_readable" };
    let result;
    try {
      const bytes = await svc.download(started.storage_path);
      if (bytes.byteLength > LIMITS.readBytes) return { document: await record({ outcome: "not_readable" }), outcome: "not_readable" };
      const today = new Date().toISOString().slice(0, 10);
      result = await callDocumentModel({
        fetchImpl, apiKey,
        baseUrl: envValue(env, "ATLAS_AI_OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
        model: visionModelFrom((name) => envValue(env, name)),
        mime: started.mime_type, base64: bytesToBase64(bytes), fileName: started.file_name, timeoutMs: LIMITS.readTimeoutMs, today,
      });
    } catch (error) {
      const outcome = error instanceof ReadError ? error.outcome : "failed";
      // A model call that was paid for still counts against the budget.
      const cost = Number(error?.est_cost_usd);
      return { document: await record({ outcome, ...(Number.isFinite(cost) && cost > 0 ? { est_cost_usd: cost } : {}) }), outcome };
    }
    if (!result.read.usable) return { document: await record({ outcome: "not_readable", est_cost_usd: result.est_cost_usd }), outcome: "not_readable" };
    const prefill = prefillFrom(result.read, await svc.suppliers());
    const document = await record({
      outcome: "read", model: result.model, tokens_in: result.tokens_in, tokens_out: result.tokens_out, est_cost_usd: result.est_cost_usd,
      extraction: { version: EXTRACTOR_VERSION, fields: result.read, prefill },
    });
    return { document, outcome: "read" };
  }

  async function command(actor, body) {
    const id = requireUuid(body.id);
    const name = String(body.command ?? "");
    if (!COMMANDS.includes(name)) throw new ApiError(400, "invalid_request", MESSAGES.invalid_request);
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 1) throw new ApiError(400, "invalid_request", MESSAGES.invalid_request);
    const source = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
    const payload = name === "save" ? { fields: pickFields(source.fields) }
      : name === "approve" ? { confirm_duplicate: source.confirm_duplicate === true }
      : name === "mark_paid" ? { paid_at: source.paid_at ?? null, payment_method: source.payment_method ?? null, payment_reference: source.payment_reference ?? null }
      : name === "void" || name === "discard" ? { reason: typeof source.reason === "string" ? source.reason.slice(0, 500) : "" }
      : {};
    const document = await svc.rpc("atlas_accounting_command", {
      p_actor_id: actor.userId, p_id: id, p_version: version, p_command: name, p_payload: payload,
    });
    if (name === "discard" && typeof document?.removed_storage_path === "string") {
      await svc.remove(document.removed_storage_path);
      delete document.removed_storage_path;
    }
    return { document };
  }

  async function fileLink(actor, id) {
    const file = await svc.rpc("atlas_accounting_file", { p_actor_id: actor.userId, p_id: requireUuid(id) });
    return { url: await svc.sign(file.storage_path, LIMITS.signedFileSeconds), mime_type: file.mime_type, expires_in: LIMITS.signedFileSeconds };
  }

  async function exportRange(actor, from, to) {
    const result = await svc.rpc("atlas_accounting_export", { p_actor_id: actor.userId, p_from: requireDate(from), p_to: requireDate(to) });
    // Links are signed 8 at a time: a busy month stays well inside the timeout.
    const entries = Array.isArray(result?.documents) ? result.documents : [];
    const documents = new Array(entries.length);
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const index = next;
        next += 1;
        const { storage_path: path, ...document } = entries[index];
        let url = null;
        if (typeof path === "string" && path) {
          try { url = await svc.sign(path, LIMITS.signedExportSeconds); } catch { url = null; }
        }
        documents[index] = { ...document, file_url: url };
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, entries.length) }, worker));
    return { from: result.from, to: result.to, documents, expires_in: LIMITS.signedExportSeconds };
  }

  return async function handle(request) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    try {
      const url = new URL(request.url);
      const action = url.searchParams.get("action") || "snapshot";
      const actor = await admin(request);
      if (request.method === "GET") {
        if (action === "snapshot") return jsonResponse({ workspace: await svc.rpc("atlas_accounting_snapshot", { p_actor_id: actor.userId }) });
        if (action === "document") return jsonResponse({ document: await svc.rpc("atlas_accounting_document", { p_actor_id: actor.userId, p_id: requireUuid(url.searchParams.get("id")) }) });
        if (action === "file") return jsonResponse(await fileLink(actor, url.searchParams.get("id")));
        if (action === "export") return jsonResponse(await exportRange(actor, url.searchParams.get("from"), url.searchParams.get("to")));
        throw new ApiError(404, "not_found", MESSAGES.not_found);
      }
      if (request.method !== "POST") throw new ApiError(405, "invalid_request", MESSAGES.invalid_request);
      if (action === "upload") return jsonResponse(await uploadDocument(actor, request));
      if (action === "read") return jsonResponse(await readDocument(actor, await readJson(request)));
      if (action === "command") return jsonResponse(await command(actor, await readJson(request)));
      throw new ApiError(404, "not_found", MESSAGES.not_found);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
