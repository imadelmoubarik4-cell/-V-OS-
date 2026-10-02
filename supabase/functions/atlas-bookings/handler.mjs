// atlas-bookings request handling (S99). The staff booking workspace + the one
// authoritative availability/reservation service. Every side effect is injected so Node
// tests run it without the network:
//   env(name)             -> string | undefined
//   fetchImpl(url, init)  -> Response (Auth, PostgREST RPC)
//   resolveActor(req)     -> optional override of _shared/auth.mjs resolveActor
//   services              -> optional override of createServices()
//
// verify_jwt=false (supabase/config.toml): the production Auth project issues the JWT, so
// the handler authenticates every request itself with _shared/auth.mjs resolveActor and
// passes the resolved actor (never a browser-sent id/role) into the service-role
// public.atlas_bookings_* RPCs, which re-check the actor. Guest contact + staff notes never
// leave the staff RPCs; there are no public (guest) endpoints in this step.
//
//   GET  ?action=snapshot&date=YYYY-MM-DD                the staff day view (default action)
//   GET  ?action=config                                  the room + rules (managers)
//   GET  ?action=availability&from=&to=&party_size=      bookable slots for a window
//   POST ?action=save-area          {id?, name, section_colour?, display_order?, is_active?}
//   POST ?action=save-table         {id?, area_id?, label, seat_capacity, ...}
//   POST ?action=save-combination   {id?, name, member_table_ids[], combined_capacity, ...}
//   POST ?action=save-settings      {..rules.., expected_version?}
//   POST ?action=create             {party_size, start_at, source?, table_ids?, guest_*?, ...}
//   POST ?action=assign             {reservation_id, table_ids[]}
//   POST ?action=set-status         {reservation_id, to_status, note?}
//   POST ?action=hold               {table_id, start_at, end_at, minutes?, reservation_id?}
//   POST ?action=release-hold       {hold_id}

import { AuthError, resolveActor as sharedResolveActor } from "../_shared/auth.mjs";

export const FUNCTION_VERSION = "0.1.0";
export const LIMITS = Object.freeze({ jsonBytes: 64 * 1024 });
const MANAGER_ROLES = new Set(["admin", "manager"]);
const STAFF_ROLES = new Set(["admin", "manager", "bartender"]);

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
  invalid_request: "Some of the details weren’t valid. Check them and try again.",
  unauthorized: "Alcedo couldn’t confirm your sign-in for this. Try again in a moment.",
  forbidden: "This isn’t available for your Alcedo role.",
  not_found: "That booking could not be found.",
  conflict: "That table is no longer free for the requested time. Refresh and try again.",
  unavailable: "Bookings is unavailable right now. Nothing was changed. Try again in a moment.",
  internal: "Bookings could not complete that request. Nothing was changed.",
});

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value ?? null), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-bookings-version": FUNCTION_VERSION,
    },
  });
}

export function errorResponse(error) {
  if (error instanceof ApiError) return jsonResponse({ error_code: error.code, message: error.message, ...error.extra }, error.status);
  if (error?.name === "AuthError" || error instanceof AuthError) {
    const code = error.status === 401 ? "unauthorized" : error.status === 403 ? "forbidden" : "unavailable";
    return jsonResponse({ error_code: code, message: code === "forbidden" ? MESSAGES.forbidden : error.message }, error.status);
  }
  console.error("[atlas-bookings] unexpected error", error?.name ?? "Error");
  return jsonResponse({ error_code: "internal", message: MESSAGES.internal }, 500);
}

// PostgREST error -> ApiError. The RPC hint ('atlas:<code>') decides the status; database
// text is never passed on to the browser.
const HINTS = Object.freeze({
  forbidden: 403, not_found: 404, conflict: 409, invalid_request: 400, unavailable: 503,
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
  if (code === "23505" || code === "23P01") return new ApiError(409, "conflict", MESSAGES.conflict);
  return new ApiError(status >= 500 ? 503 : 502, "unavailable", MESSAGES.unavailable);
}

function envValue(env, name) {
  const value = typeof env === "function" ? env(name) : typeof env?.get === "function" ? env.get(name) : env?.[name];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

const invalid = (message = MESSAGES.invalid_request) => new ApiError(400, "invalid_request", message);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}
function boundedInt(value, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}
// An ISO-8601 instant string, passed straight to the RPC (Postgres parses/validates it).
function requireInstant(value) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) throw invalid();
  return value.trim();
}

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

const RPCS = new Set([
  "atlas_bookings_snapshot", "atlas_bookings_config", "atlas_bookings_save_area",
  "atlas_bookings_save_table", "atlas_bookings_save_combination", "atlas_bookings_save_settings",
  "atlas_bookings_availability", "atlas_bookings_create", "atlas_bookings_assign",
  "atlas_bookings_set_status", "atlas_bookings_hold", "atlas_bookings_release_hold",
]);

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
      console.warn(`[atlas-bookings] rpc ${name} failed`, response.status, parsed?.code ?? "-");
      throw mapRpcError(response.status, parsed);
    }
    return parsed;
  }

  return { rpc };
}

export function createBookingsHandler({ env, fetchImpl, resolveActor = null, services = null } = {}) {
  const svc = services ?? createServices({ env, fetchImpl });
  const resolve = resolveActor ?? ((request) => sharedResolveActor(request, { get: (name) => envValue(env, name) }, fetchImpl, {
    inactiveMessage: "This Alcedo profile is inactive. Bookings access has been removed.",
  }));

  async function requireActor(request) {
    const actor = await resolve(request);
    if (!actor || actor.active === false) throw new ApiError(403, "forbidden", MESSAGES.forbidden);
    return actor;
  }
  function requireStaff(actor) {
    if (!STAFF_ROLES.has(actor.role)) throw new ApiError(403, "forbidden", MESSAGES.forbidden);
    return actor;
  }
  function requireManager(actor) {
    requireStaff(actor);
    if (!MANAGER_ROLES.has(actor.role)) throw new ApiError(403, "forbidden", MESSAGES.forbidden);
    return actor;
  }
  const actorArgs = (actor) => ({ p_actor_id: actor.userId, p_actor_role: actor.role });

  async function snapshot(actor, date) {
    return svc.rpc("atlas_bookings_snapshot", { ...actorArgs(actor), p_date: date || null });
  }
  async function config(actor) {
    requireManager(actor);
    return svc.rpc("atlas_bookings_config", actorArgs(actor));
  }
  async function availability(actor, params) {
    const partySize = boundedInt(params.get("party_size"), 1, 500);
    if (partySize === null) throw invalid();
    return svc.rpc("atlas_bookings_availability", {
      ...actorArgs(actor),
      p_from: requireInstant(params.get("from")),
      p_to: requireInstant(params.get("to")),
      p_party_size: partySize,
    });
  }
  async function saveArea(actor, body) {
    requireManager(actor);
    return svc.rpc("atlas_bookings_save_area", { ...actorArgs(actor), p_payload: body });
  }
  async function saveTable(actor, body) {
    requireManager(actor);
    return svc.rpc("atlas_bookings_save_table", { ...actorArgs(actor), p_payload: body });
  }
  async function saveCombination(actor, body) {
    requireManager(actor);
    return svc.rpc("atlas_bookings_save_combination", { ...actorArgs(actor), p_payload: body });
  }
  async function saveSettings(actor, body) {
    requireManager(actor);
    const expected = body.expected_version === undefined || body.expected_version === null
      ? null : boundedInt(body.expected_version, 1, 2147483647);
    return svc.rpc("atlas_bookings_save_settings", { ...actorArgs(actor), p_payload: body, p_expected_version: expected });
  }
  async function create(actor, body) {
    requireStaff(actor);
    if (boundedInt(body.party_size, 1, 500) === null) throw invalid();
    requireInstant(body.start_at);
    return svc.rpc("atlas_bookings_create", { ...actorArgs(actor), p_payload: body });
  }
  async function assign(actor, body) {
    requireStaff(actor);
    const tables = body.table_ids;
    if (!Array.isArray(tables) || tables.length < 1) throw invalid();
    tables.forEach(requireUuid);
    return svc.rpc("atlas_bookings_assign", {
      ...actorArgs(actor), p_reservation_id: requireUuid(body.reservation_id), p_table_ids: tables,
    });
  }
  async function setStatus(actor, body) {
    requireStaff(actor);
    const to = String(body.to_status ?? "").trim();
    if (!to) throw invalid();
    return svc.rpc("atlas_bookings_set_status", {
      ...actorArgs(actor), p_reservation_id: requireUuid(body.reservation_id),
      p_to_status: to, p_note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
    });
  }
  async function hold(actor, body) {
    requireStaff(actor);
    return svc.rpc("atlas_bookings_hold", { ...actorArgs(actor), p_payload: body });
  }
  async function releaseHold(actor, body) {
    requireStaff(actor);
    return svc.rpc("atlas_bookings_release_hold", { ...actorArgs(actor), p_hold_id: requireUuid(body.hold_id) });
  }

  return async function handle(request) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    try {
      const url = new URL(request.url);
      const action = url.searchParams.get("action") || "snapshot";
      const actor = await requireActor(request);
      if (request.method === "GET") {
        if (action === "snapshot") return jsonResponse(await snapshot(actor, url.searchParams.get("date")));
        if (action === "config") return jsonResponse(await config(actor));
        if (action === "availability") return jsonResponse(await availability(actor, url.searchParams));
        throw new ApiError(404, "not_found", MESSAGES.not_found);
      }
      if (request.method !== "POST") throw new ApiError(405, "invalid_request", MESSAGES.invalid_request);
      const body = await readJson(request);
      switch (action) {
        case "save-area": return jsonResponse(await saveArea(actor, body));
        case "save-table": return jsonResponse(await saveTable(actor, body));
        case "save-combination": return jsonResponse(await saveCombination(actor, body));
        case "save-settings": return jsonResponse(await saveSettings(actor, body));
        case "create": return jsonResponse(await create(actor, body));
        case "assign": return jsonResponse(await assign(actor, body));
        case "set-status": return jsonResponse(await setStatus(actor, body));
        case "hold": return jsonResponse(await hold(actor, body));
        case "release-hold": return jsonResponse(await releaseHold(actor, body));
        default: throw new ApiError(404, "not_found", MESSAGES.not_found);
      }
    } catch (error) {
      return errorResponse(error);
    }
  };
}
