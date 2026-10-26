// atlas-public-booking (S107) — the narrowly scoped PUBLIC (guest) booking
// service for the KANEL website. Separate from the staff atlas-bookings function.
// Every side effect is injected so Node tests run it without the network:
//   env(name)             -> string | undefined
//   fetchImpl(url, init)  -> Response (PostgREST RPC)
//   services              -> optional override of createServices()
//   now()                 -> Date (tests)
//
// INDEPENDENT SERVER-SIDE FLAG: the endpoint is inert unless the edge env flag
// PUBLIC_BOOKING_ENABLED === "true". This is separate from the database flag
// (booking_settings.public_online_enabled, re-checked by every RPC) and from the
// frontend flag (config.js). The frontend flag alone can never open this endpoint.
//
// No guest input is trusted: the service-role public.atlas_public_booking_* RPCs
// enforce the party cap, Bar-only, opening hours, horizon, buffer, section
// contiguity, 'requested' status, expiring holds, idempotency and rate limiting.
// The service-role key never leaves the server; only the RPCs' minimal JSON is
// returned. No staff auth, no cookies, no other guests' data.
//
//   GET  ?action=availability&date=YYYY-MM-DD&party_size=N
//   POST ?action=request            {party_size, start_at, guest_name, guest_phone?, guest_email?, guest_requests?}
//   POST ?action=book               -> confirmed immediately with adjacent stools
//   GET  ?action=status&token=<public_token>

export const FUNCTION_VERSION = "0.2.0";
export const LIMITS = Object.freeze({ jsonBytes: 16 * 1024 });

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
  invalid_request: "Some of the details weren’t valid. Check them and try again.",
  not_found: "We couldn’t find that booking.",
  conflict: "That time is no longer available. Please choose another.",
  rate_limited: "Too many requests. Please try again shortly.",
  disabled: "Online booking isn’t available right now.",
  unavailable: "Online booking is unavailable right now. Nothing was changed.",
  internal: "We couldn’t complete that request. Nothing was changed.",
});

// The CORS allow-list is restrictive by default: only the KANEL site origins,
// overridable with PUBLIC_BOOKING_ORIGINS (comma-separated). Never "*". A
// non-matching Origin is not echoed (the browser then blocks the cross-origin
// read). No credentials/cookies are used.
const DEFAULT_ORIGINS = ["https://kanel.is", "https://www.kanel.is"];
function corsHeaders(env, requestOrigin) {
  const configured = String(envValue(env, "PUBLIC_BOOKING_ORIGINS") ?? "").trim();
  const list = configured ? configured.split(",").map((o) => o.trim()).filter(Boolean) : DEFAULT_ORIGINS;
  const allow = requestOrigin && list.includes(requestOrigin) ? requestOrigin : (list[0] ?? "null");
  return {
    "access-control-allow-origin": allow,
    // x-booking-token lets a caller pass the private status token in a header
    // instead of the URL query string (see statusToken()).
    "access-control-allow-headers": "content-type, idempotency-key, x-booking-token",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
    vary: "origin",
  };
}

export function jsonResponse(value, status, env, origin) {
  return new Response(JSON.stringify(value ?? null), {
    status,
    headers: {
      ...corsHeaders(env, origin),
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-public-booking-version": FUNCTION_VERSION,
    },
  });
}

export function errorResponse(error, env, origin) {
  if (error instanceof ApiError) {
    return jsonResponse({ error_code: error.code, message: error.message, ...error.extra }, error.status, env, origin);
  }
  console.error("[atlas-public-booking] unexpected error", error?.name ?? "Error");
  return jsonResponse({ error_code: "internal", message: MESSAGES.internal }, 500, env, origin);
}

const HINTS = Object.freeze({
  not_found: 404, conflict: 409, invalid_request: 400, unavailable: 503,
  disabled: 503, rate_limited: 429,
});
export function mapRpcError(status, body) {
  const code = String(body?.code ?? "");
  const hint = String(body?.hint ?? "");
  const hinted = hint.startsWith("atlas:") ? hint.slice(6) : "";
  if (Object.prototype.hasOwnProperty.call(HINTS, hinted)) {
    return new ApiError(HINTS[hinted], hinted, MESSAGES[hinted] ?? MESSAGES.invalid_request);
  }
  if (code === "P0002") return new ApiError(404, "not_found", MESSAGES.not_found);
  if (code === "22023" || code === "22P02" || code === "22007" || code === "22008") return new ApiError(400, "invalid_request", MESSAGES.invalid_request);
  if (code === "23505" || code === "23P01") return new ApiError(409, "conflict", MESSAGES.conflict);
  if (code === "53400") return new ApiError(429, "rate_limited", MESSAGES.rate_limited);
  return new ApiError(status >= 500 ? 503 : 502, "unavailable", MESSAGES.unavailable);
}

function envValue(env, name) {
  const value = typeof env === "function" ? env(name) : typeof env?.get === "function" ? env.get(name) : env?.[name];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

const invalid = (message = MESSAGES.invalid_request) => new ApiError(400, "invalid_request", message);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN = /^[0-9a-f]{24,64}$/i;

async function readJson(request) {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > LIMITS.jsonBytes) throw invalid();
  const text = await request.text();
  if (text.length > LIMITS.jsonBytes) throw invalid();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw invalid();
  }
}

const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+)$/i;

// The trustworthy client IP. X-Forwarded-For is client-spoofable on the LEFT: a
// caller can prepend fake entries to rotate their fingerprint and evade the rate
// limit. Our own infrastructure appends the real connecting IP on the RIGHT, so
// with N trusted proxy hops the real client sits at index (length - N). We never
// take the leftmost (attacker-controlled) entry. If the chain is shorter than the
// configured hops the request did not traverse our infrastructure as expected, so
// we fall back to x-real-ip (set by trusted infra) and otherwise to a constant —
// never to a client-supplied value.
function clientIp(request, env) {
  const hops = Math.max(1, Number(envValue(env, "PUBLIC_BOOKING_TRUSTED_HOPS") ?? 1) || 1);
  const xff = String(request.headers.get("x-forwarded-for") ?? "");
  const chain = xff.split(",").map((s) => s.trim()).filter((s) => IP_RE.test(s));
  if (chain.length >= hops) {
    const ip = chain[chain.length - hops];
    if (ip && IP_RE.test(ip)) return ip;
  }
  const real = String(request.headers.get("x-real-ip") ?? "").trim();
  if (IP_RE.test(real)) return real;
  return "unknown";
}

// A strong, server-only salt is MANDATORY: without it the function fails safe
// (503) rather than fingerprinting with a guessable default or leaking a raw IP.
function requireSalt(env) {
  const salt = envValue(env, "PUBLIC_BOOKING_SALT");
  if (!salt || String(salt).length < 16) {
    console.error("[atlas-public-booking] PUBLIC_BOOKING_SALT missing or too weak");
    throw new ApiError(503, "unavailable", MESSAGES.unavailable);
  }
  return String(salt);
}

// A stable, privacy-preserving client fingerprint: SHA-256 of the trustworthy
// client IP + the mandatory server salt, truncated. The raw IP is never returned
// or stored; a hashing failure fails safe (503) instead of leaking it.
async function fingerprint(request, env) {
  const salt = requireSalt(env);
  const ip = clientIp(request, env);
  try {
    const data = new TextEncoder().encode(`${salt}:${ip}`);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  } catch {
    throw new ApiError(503, "unavailable", MESSAGES.unavailable);
  }
}

const PUBLIC_RPCS = new Set([
  "atlas_public_booking_availability",
  "atlas_public_booking_request",
  "atlas_public_booking_status",
  "atlas_public_booking_rate",
]);

export function createServices({ env, fetchImpl }) {
  function credentials() {
    const url = String(envValue(env, "SUPABASE_URL") ?? "").replace(/\/+$/, "");
    const key = String(envValue(env, "SUPABASE_SERVICE_ROLE_KEY") ?? "");
    if (!/^https?:\/\/[^/\s]+$/.test(url) || !key) throw new ApiError(503, "unavailable", MESSAGES.unavailable);
    return { url, key };
  }
  async function rpc(name, args) {
    if (!PUBLIC_RPCS.has(name)) throw new Error("rpc not allowed");
    const { url, key } = credentials();
    let response;
    try {
      response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json", "cache-control": "no-store" },
        body: JSON.stringify(args ?? {}),
      });
    } catch {
      throw new ApiError(503, "unavailable", MESSAGES.unavailable);
    }
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      console.warn(`[atlas-public-booking] rpc ${name} failed`, response.status, parsed?.code ?? "-");
      throw mapRpcError(response.status, parsed);
    }
    return parsed;
  }
  return { rpc };
}

export function createPublicBookingHandler({ env, fetchImpl, services = null } = {}) {
  const svc = services ?? createServices({ env, fetchImpl });

  function enabled() {
    return envValue(env, "PUBLIC_BOOKING_ENABLED") === "true";
  }

  // Consume the per-action rate budget in its OWN committed transaction BEFORE
  // the work. Because this is a separate RPC call (its own PostgREST transaction),
  // a flood whose booking RPCs later fail still counts toward the limit. A refused
  // budget maps to 429. The fingerprint is already salted + trusted-IP derived.
  async function rateGate(fp, action) {
    const res = await svc.rpc("atlas_public_booking_rate", { p_fingerprint: fp, p_action: action });
    if (!res || res.ok !== true) throw new ApiError(429, "rate_limited", MESSAGES.rate_limited);
  }

  // The private status token, preferred OUT of the URL query string: a request
  // header or POST body first, the query only as a legacy fallback.
  async function statusToken(request, url) {
    const header = request.headers.get("x-booking-token");
    if (header) return String(header).trim();
    if (request.method === "POST") {
      const body = await readJson(request);
      if (typeof body.token === "string") return body.token.trim();
    }
    return (url.searchParams.get("token") || "").trim();
  }

  async function route(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "availability";

    if (request.method === "GET" && action === "availability") {
      const date = url.searchParams.get("date") || "";
      if (!DATE.test(date)) throw invalid();
      const party = Number(url.searchParams.get("party_size"));
      if (!Number.isInteger(party) || party < 1 || party > 20) throw invalid();
      await rateGate(await fingerprint(request, env), "availability");
      return svc.rpc("atlas_public_booking_availability", { p_date: date, p_party_size: party, p_tz: "Atlantic/Reykjavik" });
    }

    if ((request.method === "GET" || request.method === "POST") && action === "status") {
      const token = await statusToken(request, url);
      if (!TOKEN.test(token)) throw new ApiError(404, "not_found", MESSAGES.not_found);
      await rateGate(await fingerprint(request, env), "status");
      return svc.rpc("atlas_public_booking_status", { p_token: token });
    }

    if (request.method === "POST" && (action === "request" || action === "book")) {
      const body = await readJson(request);
      const idem = request.headers.get("idempotency-key") || body.idempotency_key || null;
      const fp = await fingerprint(request, env);
      await rateGate(fp, "request");
      const payload = {
        party_size: body.party_size,
        start_at: body.start_at,
        guest_name: typeof body.guest_name === "string" ? body.guest_name.slice(0, 120) : null,
        guest_phone: typeof body.guest_phone === "string" ? body.guest_phone.slice(0, 40) : null,
        guest_email: typeof body.guest_email === "string" ? body.guest_email.slice(0, 160) : null,
        guest_requests: typeof body.guest_requests === "string" ? body.guest_requests.slice(0, 500) : null,
        tz: "Atlantic/Reykjavik",
        fingerprint: fp,
        idempotency_key: idem ? String(idem).slice(0, 128) : null,
        booking_mode: action === "book" ? "direct" : "request",
      };
      return svc.rpc("atlas_public_booking_request", { p_payload: payload });
    }

    throw new ApiError(404, "not_found", MESSAGES.not_found);
  }

  return async function handle(request) {
    const origin = request.headers.get("origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
    }
    // The independent server flag. While off, the endpoint behaves as if it does
    // not exist — no availability, no requests, no status.
    if (!enabled()) {
      return jsonResponse({ error_code: "disabled", message: MESSAGES.disabled }, 404, env, origin);
    }
    try {
      const result = await route(request);
      return jsonResponse(result, 200, env, origin);
    } catch (error) {
      return errorResponse(error, env, origin);
    }
  };
}
