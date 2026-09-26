// S94C publishing worker: the only outbound HTTP path for provider adapters.
//
// - Every request has a timeout (AbortController) and `redirect: "manual"`:
//   a 3xx is never followed (a redirect could carry a token or bytes to a
//   host we did not choose).
// - Only allowlisted hosts are reachable: the provider API hosts below and
//   our own Storage host (from SUPABASE_URL). Anything else throws before a
//   socket is opened (SSRF guard, contract §9).
// - Provider-returned upload URLs (TikTok `upload_url`, Meta rupload) go
//   through assertProviderUploadUrl() first: https, no credentials in the
//   URL, no IP literal, default port, host on the per-provider allowlist.
// - This module never logs. Error messages that leave it are sanitised:
//   tokens, bearer headers and URLs (signed URLs are bearer secrets) are
//   redacted and the text is capped at 240 characters.

export const DEFAULT_TIMEOUT_MS = 20_000;
export const UPLOAD_TIMEOUT_MS = 90_000;
const MESSAGE_LIMIT = 240;

// Provider API hosts (fixed). UNVERIFIED items: `graph-video.facebook.com`
// (legacy video host) and the TikTok upload host family `*.tiktokapis.com`
// (the documented example is open-upload.tiktokapis.com; confirm before the
// first live upload, report 03 §3.5).
export const PROVIDER_API_HOSTS = Object.freeze({
  meta: ["graph.facebook.com", "graph-video.facebook.com", "rupload.facebook.com"],
  tiktok: ["open.tiktokapis.com"],
  google: ["mybusiness.googleapis.com", "mybusinessbusinessinformation.googleapis.com"],
});

// Hosts a provider may hand back for byte uploads.
const UPLOAD_HOST_RULES = Object.freeze({
  tiktok: (host) => host === "open-upload.tiktokapis.com" || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.tiktokapis\.com$/.test(host),
  meta: (host) => host === "rupload.facebook.com",
});

export class HttpError extends Error {
  constructor(message, { network = false, timeout = false, blocked = false, redirect = false, status = 0 } = {}) {
    super(message);
    this.name = "HttpError";
    this.network = network;
    this.timeout = timeout;
    this.blocked = blocked;
    this.redirect = redirect;
    this.status = status;
  }
}

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || /^\[.*\]$/.test(host);
}

function parseUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

export function storageOrigin(supabaseUrl) {
  const url = parseUrl(String(supabaseUrl ?? "").replace(/\/+$/, ""));
  if (!url || !/^https?:$/.test(url.protocol)) return null;
  return url.origin;
}

// SSRF guard for URLs a provider returned (upload targets).
export function assertProviderUploadUrl(value, provider) {
  const url = parseUrl(value);
  const rule = UPLOAD_HOST_RULES[provider];
  if (!url || !rule) throw new HttpError("upload_url_rejected", { blocked: true });
  if (url.protocol !== "https:" || url.username || url.password || url.port || isIpLiteral(url.hostname) || !rule(url.hostname.toLowerCase())) {
    throw new HttpError("upload_url_rejected", { blocked: true });
  }
  return url;
}

// Redacts secrets from any provider/storage text before it is stored or
// returned. `secrets` are exact values known to the caller (the access
// token of this delivery, the service key); patterns catch the rest.
export function sanitizeMessage(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && String(secret).length >= 6) out = out.split(String(secret)).join("[redacted]");
  }
  out = out
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(bearer|oauth)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/((?:access_|refresh_|id_)?token|secret|signature|apikey|api_key|client_secret)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{6,}/gi, "$1$2[redacted]")
    .replace(/\bEA[A-Za-z0-9]{20,}\b/g, "[redacted]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\b(act|rft)\.[A-Za-z0-9._!*-]{10,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return out.length > MESSAGE_LIMIT ? `${out.slice(0, MESSAGE_LIMIT - 1)}…` : out;
}

function headerValue(headers, name) {
  try {
    return headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

// createHttp({ fetchImpl, supabaseUrl }) -> { request, json }
// request(url, { method, headers, body, timeoutMs, upload, binary }) resolves with
// { status, ok, headers, text, json } or throws HttpError (network/timeout/
// blocked/redirect). Bodies are read in full (provider JSON is small; upload
// responses are ignored beyond their status).
export function createHttp({ fetchImpl, supabaseUrl }) {
  if (typeof fetchImpl !== "function") throw new Error("createHttp needs fetchImpl");
  const ownStorage = storageOrigin(supabaseUrl);
  const allowedHosts = new Set(Object.values(PROVIDER_API_HOSTS).flat());

  function assertAllowed(url, { upload }) {
    if (!url) throw new HttpError("url_rejected", { blocked: true });
    if (ownStorage && url.origin === ownStorage && url.pathname.startsWith("/storage/v1/")) return;
    if (url.protocol !== "https:" || url.username || url.password || url.port || isIpLiteral(url.hostname)) {
      throw new HttpError("url_rejected", { blocked: true });
    }
    const host = url.hostname.toLowerCase();
    if (allowedHosts.has(host)) return;
    if (upload && Object.values(UPLOAD_HOST_RULES).some((rule) => rule(host))) return;
    throw new HttpError("host_not_allowed", { blocked: true });
  }

  async function request(target, { method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, upload = false, binary = false } = {}) {
    const url = parseUrl(target);
    assertAllowed(url, { upload });
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let response;
    try {
      response = await fetchImpl(url.href, { method, headers, body, redirect: "manual", signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      const timeout = timedOut || error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new HttpError(timeout ? "timeout" : "network_error", { network: true, timeout });
    }
    let text = "";
    let bytes = null;
    try {
      if (binary && response.status >= 200 && response.status < 300) bytes = new Uint8Array(await response.arrayBuffer());
      else text = await response.text();
    } catch (error) {
      clearTimeout(timer);
      // The status line arrived but the body was cut off: the outcome of a
      // write is unknown, so this is a network-class failure.
      throw new HttpError(timedOut ? "timeout" : "network_error", { network: true, timeout: timedOut, status: response.status });
    }
    clearTimeout(timer);
    if (response.status >= 300 && response.status < 400) {
      throw new HttpError("redirect_refused", { redirect: true, status: response.status });
    }
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: response.headers,
      header: (name) => headerValue(response.headers, name),
      text,
      json,
      bytes,
    };
  }

  return { request, storageOrigin: ownStorage };
}

// Retry-After as seconds (delta-seconds or an HTTP date).
export function retryAfterSeconds(value, nowMs) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text), 86_400);
  const at = Date.parse(text);
  if (Number.isFinite(at) && Number.isFinite(nowMs)) return Math.max(0, Math.min(86_400, Math.ceil((at - nowMs) / 1000)));
  return null;
}
