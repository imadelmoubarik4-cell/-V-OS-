import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";
const FUNCTION_VERSION = "0.1.0";
const MAX_BODY_BYTES = 64 * 1024;
const MANAGER_ROLES = new Set(["admin", "manager"]);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-atlas-request-id",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

type AtlasProfile = {
  id: string;
  email?: string | null;
  display_name?: string | null;
  role: string;
  active: boolean;
};

type AtlasContext = {
  token: string;
  user: { id: string; email?: string | null };
  profile: AtlasProfile;
};

class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = "REQUEST_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requestId(request: Request): string {
  const supplied = request.headers.get("x-atlas-request-id")?.trim();
  if (supplied && /^[0-9a-f-]{36}$/i.test(supplied)) return supplied;
  return crypto.randomUUID();
}

function jsonResponse(result: unknown, status = 200, id = crypto.randomUUID()): Response {
  return new Response(JSON.stringify({
    connection: {
      provider: "atlas-pos-mapping",
      state: status < 500 ? "healthy" : "degraded",
      checked_at: new Date().toISOString(),
      version: FUNCTION_VERSION,
    },
    result,
    request_id: id,
  }), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-pos-mapping-version": FUNCTION_VERSION,
      "x-atlas-request-id": id,
    },
  });
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.", "AUTHENTICATION_REQUIRED");
  return match[1];
}

function profileLabel(profile: Partial<AtlasProfile> | null | undefined): string {
  return profile?.display_name?.trim()
    || profile?.email?.trim()
    || "Atlas manager";
}

async function requireManagerProfile(request: Request): Promise<AtlasContext> {
  const token = bearerToken(request);
  const headers = {
    apikey: AUTH_PUBLISHABLE_KEY,
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "cache-control": "no-store",
  };

  const userResponse = await fetch(`${AUTH_PROJECT_URL}/auth/v1/user`, { headers });
  if (!userResponse.ok) {
    throw new ApiError(401, "Your Atlas session has expired.", "AUTHENTICATION_EXPIRED");
  }
  const user = await userResponse.json() as { id?: string; email?: string | null };
  if (!user.id) throw new ApiError(401, "Your Atlas account could not be verified.", "AUTHENTICATION_EXPIRED");

  const profileUrl = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  profileUrl.searchParams.set("id", `eq.${user.id}`);
  profileUrl.searchParams.set("select", "id,email,display_name,role,active");
  profileUrl.searchParams.set("limit", "1");
  const profileResponse = await fetch(profileUrl, { headers });
  if (!profileResponse.ok) {
    throw new ApiError(403, "Your Atlas staff profile could not be verified.", "PERMISSION_DENIED");
  }
  const profiles = await profileResponse.json() as AtlasProfile[];
  const profile = profiles[0];
  if (!profile?.active) {
    throw new ApiError(403, "This Atlas profile is inactive. Checkpoint M access has been removed.", "PERMISSION_DENIED");
  }
  if (!MANAGER_ROLES.has(profile.role)) {
    throw new ApiError(403, "Checkpoint M is available only to managers and administrators.", "PERMISSION_DENIED");
  }
  return { token, user: { id: user.id, email: user.email }, profile };
}

function branchCredentials() {
  const branchUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!branchUrl || !serviceRoleKey) {
    throw new ApiError(500, "The private Checkpoint M service is unavailable.", "PRIVATE_SERVICE_UNAVAILABLE");
  }
  return { branchUrl, serviceRoleKey };
}

async function branchRpc(name: string, payload: Record<string, unknown>): Promise<any> {
  const { branchUrl, serviceRoleKey } = branchCredentials();
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
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!response.ok) {
    console.error("Checkpoint M RPC failed", name, response.status);
    throw new ApiError(500, "The private Checkpoint M request failed.", "PRIVATE_RPC_FAILED");
  }
  return parsed;
}

async function productionRows(
  context: AtlasContext,
  table: string,
  select: string,
  options: { filters?: Record<string, string>; order?: string; limit?: number } = {},
): Promise<any[]> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  if (options.order) url.searchParams.set("order", options.order);
  url.searchParams.set("limit", String(Math.min(2000, Math.max(1, options.limit ?? 1000))));
  for (const [key, value] of Object.entries(options.filters || {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: {
      apikey: AUTH_PUBLISHABLE_KEY,
      authorization: `Bearer ${context.token}`,
      accept: "application/json",
      "cache-control": "no-store",
    },
  });
  if (!response.ok) {
    console.error("Checkpoint M production read failed", table, response.status);
    throw new ApiError(
      response.status === 401 ? 401 : response.status === 403 ? 403 : 502,
      "The production product catalogue could not be read.",
      response.status === 401 ? "AUTHENTICATION_EXPIRED" : response.status === 403 ? "PERMISSION_DENIED" : "PROVIDER_UNAVAILABLE",
    );
  }
  const payload = await response.json().catch(() => []);
  return Array.isArray(payload) ? payload : [];
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.", "REQUEST_TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "Request body is too large.", "REQUEST_TOO_LARGE");
  }
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.", "INVALID_JSON");
  }
}

function uuidValue(value: unknown, label: string, required = true): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) throw new ApiError(400, `${label} is required.`, "VALIDATION_FAILED");
    return null;
  }
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, `${label} is invalid.`, "VALIDATION_FAILED");
  }
  return value;
}

function stringValue(value: unknown, label: string, maxLength: number, required = true): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) throw new ApiError(400, `${label} is required.`, "VALIDATION_FAILED");
    return null;
  }
  if (typeof value !== "string") throw new ApiError(400, `${label} must be text.`, "VALIDATION_FAILED");
  const normalized = value.trim();
  if (!normalized && required) throw new ApiError(400, `${label} is required.`, "VALIDATION_FAILED");
  if (normalized.length > maxLength) throw new ApiError(400, `${label} is too long.`, "VALIDATION_FAILED");
  return normalized || null;
}

async function snapshot(context: AtlasContext) {
  return await branchRpc("atlas_pos_mapping_snapshot", {
    p_actor_id: context.user.id,
    p_actor_role: context.profile.role,
    p_limit: 300,
  });
}

async function refreshTargets(context: AtlasContext) {
  const recipes = await productionRows(
    context,
    "recipes",
    "id,name,type,category_id,menu_price,show_on_menu,active,updated_at",
    { order: "name.asc", filters: { active: "eq.true" }, limit: 2000 },
  );
  const targets = recipes.map((recipe) => ({
    production_recipe_id: recipe.id,
    name: recipe.name,
    product_type: recipe.type,
    category_id: recipe.category_id,
    menu_price: recipe.menu_price,
    show_on_menu: Boolean(recipe.show_on_menu),
    active: Boolean(recipe.active),
    source_updated_at: recipe.updated_at,
  }));
  const result = await branchRpc("atlas_pos_mapping_refresh_targets", {
    p_targets: targets,
    p_actor_id: context.user.id,
    p_actor_label: profileLabel(context.profile),
    p_actor_role: context.profile.role,
  });
  return { refresh: result, workspace: await snapshot(context) };
}

async function decide(context: AtlasContext, body: Record<string, unknown>) {
  const decision = stringValue(body.decision, "Decision", 20, true)!;
  if (!["approve", "reject", "ignore", "reset"].includes(decision)) {
    throw new ApiError(400, "Decision is invalid.", "VALIDATION_FAILED");
  }
  const result = await branchRpc("atlas_pos_mapping_decide", {
    p_product_id: uuidValue(body.product_id, "POS product"),
    p_target_id: uuidValue(body.target_id, "Mapping target", decision === "approve"),
    p_decision: decision,
    p_note: stringValue(body.note, "Decision note", 2000, false),
    p_actor_id: context.user.id,
    p_actor_label: profileLabel(context.profile),
    p_actor_role: context.profile.role,
  });
  return { mapping: result, workspace: await snapshot(context) };
}

Deno.serve(async (request: Request) => {
  const id = requestId(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireManagerProfile(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";

    if (request.method === "GET") {
      if (action !== "snapshot") throw new ApiError(404, "Unknown Checkpoint M action.", "NOT_FOUND");
      return jsonResponse({
        workspace: await snapshot(context),
        staff: {
          id: context.user.id,
          label: profileLabel(context.profile),
          role: context.profile.role,
          active: true,
          can_manage_mapping: true,
        },
        policy: {
          manager_approval_required: true,
          automatic_mapping_approval: false,
          sales_ingestion_enabled: false,
          brain_sales_evidence_enabled: false,
          automatic_ordering_enabled: false,
          production_source_mutation: false,
        },
      }, 200, id);
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.", "METHOD_NOT_ALLOWED");
    const body = await readJson(request);
    if (action === "refresh-targets") {
      return jsonResponse(await refreshTargets(context), 200, id);
    }
    if (action === "decide") {
      return jsonResponse(await decide(context, body), 200, id);
    }
    if (action === "stage-products") {
      throw new ApiError(
        409,
        "External POS product staging remains disabled until Dineout authorization is healthy.",
        "POS_CONNECTION_REQUIRED",
      );
    }
    throw new ApiError(404, "Unknown Checkpoint M action.", "NOT_FOUND");
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonResponse({ error: error.message, error_code: error.code }, error.status, id);
    }
    console.error("Checkpoint M API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({
      error: "Checkpoint M is temporarily unavailable.",
      error_code: "SERVICE_UNAVAILABLE",
    }, 500, id);
  }
});
