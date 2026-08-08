import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Atlas users authenticate against the production VÁ Auth project while the
// Phase 3 Brain reads and writes only the isolated development branch. The
// branch gateway JWT check is disabled in config.toml because a production JWT
// cannot be validated by the branch gateway. This handler verifies the token
// against production Auth, confirms an active manager/admin profile, and only
// then calls service-role-only Phase 3 RPCs inside the branch.
const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";

const MAX_BODY_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECISIONS = new Set(["accept", "reject", "modify", "defer", "reset"]);
const OUTCOME_STATUSES = new Set(["observed", "confirmed", "disputed"]);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type ManagerContext = {
  user: { id: string; email?: string | null };
  profile: { id: string; email?: string | null; role: string; active: boolean };
};

type JsonObject = Record<string, unknown>;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-phase3-version": "0.1.0",
    },
  });
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.");
  return match[1];
}

function stringValue(value: unknown, label: string, maxLength = 2000): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, `${label} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) throw new ApiError(400, `${label} is too long.`);
  return trimmed;
}

function requiredUuid(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 64);
  if (!parsed || !UUID_PATTERN.test(parsed)) throw new ApiError(400, `${label} must be a valid UUID.`);
  return parsed;
}

function optionalUuid(value: unknown, label: string): string | null {
  const parsed = stringValue(value, label, 64);
  if (!parsed) return null;
  if (!UUID_PATTERN.test(parsed)) throw new ApiError(400, `${label} must be a valid UUID.`);
  return parsed;
}

function optionalObject(value: unknown, label: string): JsonObject | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, `${label} must be an object.`);
  return value as JsonObject;
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError(400, `${label} must be an array.`);
  if (value.length > 50) throw new ApiError(400, `${label} contains too many entries.`);
  return value;
}

function optionalDate(value: unknown, label: string): string | null {
  const parsed = stringValue(value, label, 80);
  if (!parsed) return null;
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, `${label} must be a valid date and time.`);
  return date.toISOString();
}

function optionalScore(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ApiError(400, "success_score must be between 0 and 1.");
  }
  return parsed;
}

async function readJsonBody(request: Request): Promise<JsonObject> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "The request body is too large.");
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "The request body must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "The request body must be a JSON object.");
  }
  return parsed as JsonObject;
}

async function requireManager(request: Request): Promise<ManagerContext> {
  const token = bearerToken(request);
  const authHeaders = {
    apikey: AUTH_PUBLISHABLE_KEY,
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "cache-control": "no-store",
  };

  const userResponse = await fetch(`${AUTH_PROJECT_URL}/auth/v1/user`, { headers: authHeaders });
  if (!userResponse.ok) throw new ApiError(401, "Your Atlas session has expired.");

  const user = await userResponse.json() as { id?: string; email?: string | null };
  if (!user.id) throw new ApiError(401, "Your Atlas account could not be verified.");

  const profileResponse = await fetch(
    `${AUTH_PROJECT_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,role,active`,
    { headers: authHeaders },
  );
  if (!profileResponse.ok) throw new ApiError(403, "Your Atlas role could not be verified.");

  const profiles = await profileResponse.json() as Array<{
    id: string;
    email?: string | null;
    role: string;
    active: boolean;
  }>;
  const profile = profiles[0];
  if (!profile?.active) throw new ApiError(403, "This Atlas profile is inactive.");
  if (profile.role !== "admin" && profile.role !== "manager") {
    throw new ApiError(403, "Atlas Brain Phase 3 is limited to managers and administrators.");
  }

  return { user: { id: user.id, email: user.email }, profile };
}

async function branchRpc(name: string, payload: JsonObject = {}): Promise<unknown> {
  const branchUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!branchUrl || !serviceRoleKey) throw new ApiError(500, "Phase 3 branch credentials are unavailable.");

  const response = await fetch(`${branchUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed && "message" in parsed
      ? String((parsed as { message: unknown }).message)
      : "The Atlas Brain database request failed.";
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

function managerPayload(context: ManagerContext): JsonObject {
  return {
    id: context.user.id,
    email: context.profile.email ?? context.user.email ?? null,
    role: context.profile.role,
  };
}

async function handleGet(request: Request, url: URL, context: ManagerContext): Promise<Response> {
  const action = (url.searchParams.get("action") ?? "snapshot").toLowerCase();

  if (action === "snapshot") {
    const snapshot = await branchRpc("atlas_phase3_snapshot");
    return jsonResponse({ snapshot, manager: managerPayload(context) });
  }

  if (action === "detail") {
    const recommendationId = requiredUuid(url.searchParams.get("id"), "id");
    const detail = await branchRpc("atlas_phase3_recommendation_detail", {
      p_recommendation_id: recommendationId,
    });
    return jsonResponse({ detail, manager: managerPayload(context) });
  }

  if (action === "memory") {
    const rawLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.trunc(rawLimit), 100)) : 50;
    const memory = await branchRpc("atlas_phase3_memory_search", {
      p_subject_type: stringValue(url.searchParams.get("subject_type"), "subject_type", 120),
      p_subject_key: stringValue(url.searchParams.get("subject_key"), "subject_key", 300),
      p_limit: limit,
    });
    return jsonResponse({ memory, manager: managerPayload(context) });
  }

  throw new ApiError(404, "Unknown Phase 3 read action.");
}

async function handlePost(request: Request, url: URL, context: ManagerContext): Promise<Response> {
  const action = (url.searchParams.get("action") ?? "").toLowerCase();
  const body = await readJsonBody(request);

  if (action === "refresh") {
    await branchRpc("atlas_phase3_refresh_shadow_recommendations");
    const snapshot = await branchRpc("atlas_phase3_snapshot");
    return jsonResponse({ snapshot, manager: managerPayload(context) });
  }

  if (action === "decision") {
    const decision = stringValue(body.decision, "decision", 20)?.toLowerCase() ?? "";
    if (!DECISIONS.has(decision)) throw new ApiError(400, "decision must be accept, reject, modify, defer, or reset.");
    const clientRequestId = stringValue(body.client_request_id, "client_request_id", 128);
    if (!clientRequestId || clientRequestId.length < 8) throw new ApiError(400, "client_request_id is required.");

    const modifiedAction = optionalObject(body.modified_action, "modified_action");
    const deferredUntil = optionalDate(body.deferred_until, "deferred_until");
    if (decision === "modify" && !modifiedAction) throw new ApiError(400, "A modified recommendation requires modified_action.");
    if (decision === "defer" && !deferredUntil) throw new ApiError(400, "A deferred recommendation requires deferred_until.");

    const result = await branchRpc("atlas_phase3_decide_recommendation", {
      p_recommendation_id: requiredUuid(body.recommendation_id, "recommendation_id"),
      p_decision: decision,
      p_reason_code: stringValue(body.reason_code, "reason_code", 100),
      p_notes: stringValue(body.notes, "notes", 2000),
      p_modified_action: modifiedAction,
      p_deferred_until: deferredUntil,
      p_decided_by: context.user.id,
      p_decided_by_label: context.profile.email ?? context.user.email ?? context.user.id,
      p_client_request_id: clientRequestId,
    });
    return jsonResponse({ result, manager: managerPayload(context) });
  }

  if (action === "outcome") {
    const clientRequestId = stringValue(body.client_request_id, "client_request_id", 128);
    if (!clientRequestId || clientRequestId.length < 8) throw new ApiError(400, "client_request_id is required.");
    const outcomeStatus = (stringValue(body.outcome_status, "outcome_status", 20) ?? "observed").toLowerCase();
    if (!OUTCOME_STATUSES.has(outcomeStatus)) throw new ApiError(400, "outcome_status must be observed, confirmed, or disputed.");

    const result = await branchRpc("atlas_phase3_record_outcome", {
      p_recommendation_id: requiredUuid(body.recommendation_id, "recommendation_id"),
      p_decision_id: optionalUuid(body.decision_id, "decision_id"),
      p_outcome_type: stringValue(body.outcome_type, "outcome_type", 100) ?? "manager_observation",
      p_outcome_status: outcomeStatus,
      p_success_score: optionalScore(body.success_score),
      p_result: optionalObject(body.result, "result") ?? {},
      p_source_refs: optionalArray(body.source_refs, "source_refs"),
      p_notes: stringValue(body.notes, "notes", 2000),
      p_observed_at: optionalDate(body.observed_at, "observed_at") ?? new Date().toISOString(),
      p_recorded_by: context.user.id,
      p_recorded_by_label: context.profile.email ?? context.user.email ?? context.user.id,
      p_client_request_id: clientRequestId,
    });
    return jsonResponse({ result, manager: managerPayload(context) });
  }

  throw new ApiError(404, "Unknown Phase 3 write action.");
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireManager(request);
    const url = new URL(request.url);
    if (request.method === "GET") return await handleGet(request, url, context);
    if (request.method === "POST") return await handlePost(request, url, context);
    throw new ApiError(405, "Method not allowed.");
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Atlas Brain Phase 3 API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "Atlas Brain Phase 3 is temporarily unavailable." }, 500);
  }
});
