// HTTP helpers for atlas-ai: CORS, JSON responses, friendly errors and the
// service-role data/storage client. Browser-facing errors never carry raw
// database or provider text; codes are logged instead.

export const FUNCTION_VERSION = "0.1.0";
export const MEDIA_BUCKET = "atlas-ai-media";

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

export const NOT_CONFIGURED = () => new ApiError(503, "not_configured", "Atlas AI is not configured");

export function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-ai-version": FUNCTION_VERSION,
      ...headers,
    },
  });
}

export function errorResponse(error) {
  if (error instanceof ApiError) {
    return jsonResponse({ error_code: error.code, message: error.message, ...error.extra }, error.status);
  }
  if (error && typeof error.status === "number" && error.name === "AuthError") {
    const code = error.status === 401 ? "unauthorized" : error.status === 403 ? "forbidden" : "unavailable";
    return jsonResponse({ error_code: code, message: error.message }, error.status);
  }
  console.error("[atlas-ai] unexpected error", error?.name ?? "Error");
  return jsonResponse({ error_code: "internal", message: "Atlas AI could not complete that request." }, 500);
}

// Reads a request body with a hard byte limit: a declared content-length
// over the limit is refused before anything is read, and a chunked or
// under-declared body is counted while it streams and cut off at the limit.
export async function readBodyBytes(request, maxBytes, { message = "The request is too large." } = {}) {
  const declared = request.headers.get("content-length");
  if (declared !== null && declared !== "") {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) throw new ApiError(400, "invalid_request", "The request length is not valid.");
    if (length > maxBytes) throw new ApiError(413, "too_large", message);
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new ApiError(413, "too_large", message);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonBody(request, maxBytes) {
  const bytes = await readBodyBytes(request, maxBytes);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(400, "invalid_request", "The request body must be valid JSON.");
  }
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_request", "The request body must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_request", "The request body must be a JSON object.");
  }
  return parsed;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidOrNull(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ApiError(400, "invalid_request", `${field} must be an Atlas id.`);
  }
  return value.toLowerCase();
}

export function requireUuid(value, field) {
  const id = uuidOrNull(value, field);
  if (!id) throw new ApiError(400, "invalid_request", `${field} is required.`);
  return id;
}

// Maps an RPC failure (error prefix contract in ai-data-contract.md) to a
// friendly ApiError. The raw message is never returned to the browser.
const VOICE_QUOTA_REASONS = new Set(["daily_sessions", "concurrent", "daily_minutes"]);
const UPLOAD_QUOTA_REASONS = new Set(["daily_files", "daily_bytes"]);
const reasonAfter = (message, prefix, allowed) => {
  const reason = message.slice(prefix.length).trim();
  return allowed.has(reason) ? { reason } : {};
};
const RPC_ERRORS = [
  // S88 hardening codes are matched by message prefix first (the SQLSTATEs
  // 55000/53400 are shared with conflict and other limits).
  { test: (_code, message) => message.startsWith("rate_limited:"), status: 429, code: "rate_limited", message: "You've reached an Atlas AI limit. Please wait and try again." },
  { test: (_code, message) => message.startsWith("voice_quota_exceeded:"), status: 429, code: "voice_quota_exceeded", message: "You've reached today's live voice limit. Voice notes and text still work.", extra: (message) => reasonAfter(message, "voice_quota_exceeded:", VOICE_QUOTA_REASONS) },
  { test: (_code, message) => message.startsWith("upload_quota_exceeded:"), status: 429, code: "upload_quota_exceeded", message: "You've reached today's upload limit for Atlas AI. It resets within 24 hours.", extra: (message) => reasonAfter(message, "upload_quota_exceeded:", UPLOAD_QUOTA_REASONS) },
  { test: (_code, message) => message.startsWith("voice_session_inactive:"), status: 409, code: "voice_session_inactive", message: "This live voice session has ended. Start a new one to continue." },
  { test: (_code, message) => message.startsWith("voice_session_replaced:"), status: 409, code: "voice_session_replaced", message: "Live voice moved to another device." },
  { test: (_code, message) => message.startsWith("not_configured:"), status: 503, code: "not_configured", message: "Atlas AI is not configured" },
  { test: (code, message) => code === "42501" || message.startsWith("forbidden:"), status: 403, code: "forbidden", message: "This is not available for your Atlas role." },
  { test: (code, message) => code === "P0002" || message.startsWith("not_found:"), status: 404, code: "not_found", message: "That could not be found." },
  { test: (code, message) => code === "22023" || message.startsWith("invalid_arguments:"), status: 400, code: "invalid_request", message: "Some of the details were not valid." },
  { test: (code, message) => code === "55000" || message.startsWith("conflict:"), status: 409, code: "conflict", message: "This was already handled or has expired." },
];

export class RpcError extends ApiError {
  constructor(status, code, message, rpcName, dbCode, extra = {}) {
    super(status, code, message, extra);
    this.name = "RpcError";
    this.rpcName = rpcName;
    this.dbCode = dbCode;
  }
}

// The friendly error for a failed RPC (the raw database text is only
// matched, never returned). Exported for the test harness.
export function mapRpcError(name, dbCode, message) {
  const text = String(message ?? "");
  const mapped = RPC_ERRORS.find((entry) => entry.test(String(dbCode ?? ""), text));
  if (mapped) return new RpcError(mapped.status, mapped.code, mapped.message, name, dbCode, mapped.extra ? mapped.extra(text) : {});
  return new RpcError(502, "unavailable", "Atlas AI could not reach its data service.", name, dbCode);
}

function envValue(env, name) {
  if (!env) return undefined;
  const value = typeof env.get === "function" ? env.get(name) : typeof env === "function" ? env(name) : env[name];
  return value === undefined || value === null ? undefined : String(value);
}

function encodePath(path) {
  return String(path).split("/").map((part) => encodeURIComponent(part)).join("/");
}

// Service-role access to the private Atlas branch: RPCs and the private
// atlas-ai-media bucket. `fetchImpl` is injected for tests.
export function createServices({ env, fetchImpl }) {
  function credentials() {
    const url = String(envValue(env, "SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
    const key = String(envValue(env, "SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
    if (!/^https?:\/\/[^/\s]+$/.test(url) || !key) {
      throw new ApiError(503, "unavailable", "Atlas AI storage is not available right now.");
    }
    return { url, key };
  }

  function serviceHeaders(key, extra = {}) {
    return { apikey: key, authorization: `Bearer ${key}`, "cache-control": "no-store", ...extra };
  }

  async function rpc(name, payload) {
    const { url, key } = credentials();
    let response;
    try {
      response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: serviceHeaders(key, { "content-type": "application/json", accept: "application/json" }),
        body: JSON.stringify(payload ?? {}),
      });
    } catch {
      console.warn(`[atlas-ai] rpc ${name} unreachable`);
      throw new RpcError(503, "unavailable", "Atlas AI could not reach its data service.", name, null);
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const dbCode = parsed && typeof parsed === "object" ? String(parsed.code ?? "") : "";
      const message = parsed && typeof parsed === "object" ? String(parsed.message ?? "") : "";
      console.warn(`[atlas-ai] rpc ${name} failed`, response.status, dbCode || "-");
      throw mapRpcError(name, dbCode, message);
    }
    return parsed;
  }

  async function uploadObject(path, bytes, mime) {
    const { url, key } = credentials();
    const response = await fetchImpl(`${url}/storage/v1/object/${MEDIA_BUCKET}/${encodePath(path)}`, {
      method: "POST",
      headers: serviceHeaders(key, { "content-type": mime, "x-upsert": "false" }),
      body: bytes,
    });
    if (!response.ok) {
      console.warn("[atlas-ai] storage upload failed", response.status);
      throw new ApiError(502, "storage_failed", "The file could not be stored. Please try again.");
    }
  }

  async function downloadObject(path) {
    const { url, key } = credentials();
    const response = await fetchImpl(`${url}/storage/v1/object/${MEDIA_BUCKET}/${encodePath(path)}`, {
      method: "GET",
      headers: serviceHeaders(key),
    });
    if (!response.ok) {
      console.warn("[atlas-ai] storage download failed", response.status);
      throw new ApiError(502, "storage_failed", "An attachment could not be read.");
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async function signObject(path, expiresIn) {
    const { url, key } = credentials();
    const response = await fetchImpl(`${url}/storage/v1/object/sign/${MEDIA_BUCKET}/${encodePath(path)}`, {
      method: "POST",
      headers: serviceHeaders(key, { "content-type": "application/json", accept: "application/json" }),
      body: JSON.stringify({ expiresIn }),
    });
    const payload = await response.json().catch(() => ({}));
    const value = payload?.signedURL || payload?.signedUrl || payload?.signed_url;
    if (!response.ok || typeof value !== "string" || !value) {
      console.warn("[atlas-ai] storage sign failed", response.status);
      throw new ApiError(502, "storage_failed", "A link to this file could not be created.");
    }
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith("/storage/v1/")) return `${url}${value}`;
    if (value.startsWith("/object/")) return `${url}/storage/v1${value}`;
    return `${url}/storage/v1/${value.replace(/^\/+/, "")}`;
  }

  async function removeObjects(paths) {
    const prefixes = [...new Set((paths || []).filter((path) => typeof path === "string" && path))];
    if (!prefixes.length) return { removed: 0 };
    const { url, key } = credentials();
    const response = await fetchImpl(`${url}/storage/v1/object/${MEDIA_BUCKET}`, {
      method: "DELETE",
      headers: serviceHeaders(key, { "content-type": "application/json" }),
      body: JSON.stringify({ prefixes }),
    });
    if (!response.ok) {
      console.warn("[atlas-ai] storage delete failed", response.status);
      throw new ApiError(502, "storage_failed", "Stored files could not be removed.");
    }
    return { removed: prefixes.length };
  }

  // Service-role read of one profile, for the scheduled background actor.
  async function profileById(userId) {
    const { url, key } = credentials();
    const target = new URL(`${url}/rest/v1/profiles`);
    target.searchParams.set("id", `eq.${userId}`);
    target.searchParams.set("select", "id,email,display_name,role,active");
    target.searchParams.set("limit", "1");
    const response = await fetchImpl(target.toString(), { headers: serviceHeaders(key, { accept: "application/json" }) });
    if (!response.ok) return null;
    const rows = await response.json().catch(() => null);
    return Array.isArray(rows) && rows[0]?.id === userId ? rows[0] : null;
  }

  // Row-level-security read with the caller's own JWT (used only for the
  // bounded transcription vocabulary). Failures return [].
  async function restAsUser(actor, table, select, limit) {
    try {
      const url = String(envValue(env, "ATLAS_AUTH_PROJECT_URL") ?? envValue(env, "SUPABASE_URL") ?? "").replace(/\/+$/, "");
      let publishable = String(envValue(env, "ATLAS_AUTH_PUBLISHABLE_KEY") ?? "").trim();
      if (!publishable) {
        try { publishable = String(JSON.parse(envValue(env, "SUPABASE_PUBLISHABLE_KEYS") ?? "{}")?.default ?? ""); } catch { publishable = ""; }
      }
      if (!url || !publishable || !actor?.token) return [];
      const target = new URL(`${url}/rest/v1/${table}`);
      target.searchParams.set("select", select);
      target.searchParams.set("limit", String(limit));
      const response = await fetchImpl(target.toString(), {
        headers: { apikey: publishable, authorization: `Bearer ${actor.token}`, accept: "application/json" },
      });
      if (!response.ok) return [];
      const rows = await response.json().catch(() => []);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  return { rpc, uploadObject, downloadObject, signObject, removeObjects, profileById, restAsUser };
}
