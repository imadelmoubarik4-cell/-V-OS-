import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";
const FUNCTION_VERSION = "0.2.0";
const MAX_BODY_BYTES = 160 * 1024;
const MAX_INVENTORY_ROWS = 5000;
const PUBLICATION_ENV_ENABLED =
  (Deno.env.get("ATLAS_STOCK_COUNT_PUBLICATION_ENABLED") ?? "false").toLowerCase() === "true";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(["admin", "manager", "bartender", "viewer"]);
const EDIT_ROLES = new Set(["admin", "manager", "bartender"]);
const MANAGER_ROLES = new Set(["admin", "manager"]);
const SCOPE_TYPES = new Set(["all", "location", "category"]);
const LINE_STATUSES = new Set(["pending", "counted", "skipped"]);
const COUNT_METHODS = new Set(["manual", "barcode", "photo", "import"]);
const COUNT_UNITS = new Set([
  "inventory", "bottle", "case", "unit", "litre", "millilitre", "kilogram", "gram",
]);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

type JsonObject = Record<string, unknown>;
type Profile = {
  id: string;
  email?: string | null;
  display_name?: string | null;
  role: string;
  active: boolean;
};
type Context = {
  token: string;
  user: { id: string; email?: string | null };
  profile: Profile;
};

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-stock-count-version": FUNCTION_VERSION,
    },
  });
}

function bearerToken(request: Request): string {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.");
  return match[1];
}

function labelFor(context: Context): string {
  return context.profile.display_name?.trim()
    || context.profile.email?.trim()
    || context.user.email?.trim()
    || context.user.id;
}

function requiredText(value: unknown, label: string, maxLength = 3000): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(400, `${label} is required.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new ApiError(400, `${label} is too long.`);
  return normalized;
}

function optionalText(value: unknown, label: string, maxLength = 3000): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, `${label} must be text.`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new ApiError(400, `${label} is too long.`);
  return normalized;
}

function requiredUuid(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 64);
  if (!UUID_PATTERN.test(normalized)) throw new ApiError(400, `${label} is invalid.`);
  return normalized;
}

function enumValue(value: unknown, label: string, allowed: Set<string>): string {
  const normalized = requiredText(value, label, 100).toLowerCase();
  if (!allowed.has(normalized)) throw new ApiError(400, `${label} is invalid.`);
  return normalized;
}

function integerValue(value: unknown, label: string, min = 1, max = 1_000_000): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(400, `${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function quantityValue(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000_000) {
    throw new ApiError(400, `${label} must be zero or more.`);
  }
  return parsed;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function objectValue(value: unknown, label: string): JsonObject {
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `${label} must be an object.`);
  }
  return value as JsonObject;
}

async function readJson(request: Request): Promise<JsonObject> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "Request body is too large.");
  }
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value as JsonObject;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

async function requireActiveProfile(request: Request): Promise<Context> {
  const token = bearerToken(request);
  const headers = {
    apikey: AUTH_PUBLISHABLE_KEY,
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "cache-control": "no-store",
  };

  const userResponse = await fetch(`${AUTH_PROJECT_URL}/auth/v1/user`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!userResponse.ok) throw new ApiError(401, "Your Atlas session has expired.");
  const user = await userResponse.json() as { id?: string; email?: string | null };
  if (!user.id) throw new ApiError(401, "Your Atlas account could not be verified.");

  const profileUrl = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  profileUrl.searchParams.set("id", `eq.${user.id}`);
  profileUrl.searchParams.set("select", "id,email,display_name,role,active");
  profileUrl.searchParams.set("limit", "1");
  const profileResponse = await fetch(profileUrl, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!profileResponse.ok) throw new ApiError(403, "Your Atlas staff profile could not be verified.");
  const profiles = await profileResponse.json() as Profile[];
  const profile = profiles[0];
  if (!profile?.active) throw new ApiError(403, "This Atlas profile is inactive.");
  if (!ROLES.has(profile.role)) throw new ApiError(403, "This Atlas profile cannot access stock counts.");
  return { token, user: { id: user.id, email: user.email }, profile };
}

function requireEditingRole(context: Context): void {
  if (!EDIT_ROLES.has(context.profile.role)) {
    throw new ApiError(403, "This action is limited to operational staff and managers.");
  }
}

function requireManager(context: Context): void {
  if (!MANAGER_ROLES.has(context.profile.role)) {
    throw new ApiError(403, "This action is limited to managers and administrators.");
  }
}

async function productionInventory(context: Context): Promise<JsonObject[]> {
  const commercialAccess = MANAGER_ROLES.has(context.profile.role);
  const safeFields = [
    "id", "name", "category", "quantity", "unit", "par_level", "bin_location", "sku", "barcode",
    "updated_at", "active", "units_per_case", "size_ml", "package_size",
  ].join(",");
  const commercialFields = [
    safeFields,
    "source_updated_at", "source_file", "supplier", "supplier_id", "supplier_product_reference",
    "case_cost", "cost_price", "critical_minimum", "lead_time_days", "minimum_order_quantity",
  ].join(",");

  async function readRelation(relation: string, select: string): Promise<Response> {
    const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/${relation}`);
    url.searchParams.set("select", select);
    url.searchParams.set("active", "eq.true");
    url.searchParams.set("order", "bin_location.asc.nullslast,category.asc,name.asc");
    url.searchParams.set("limit", String(MAX_INVENTORY_ROWS));
    return await fetch(url, {
      headers: {
        apikey: AUTH_PUBLISHABLE_KEY,
        authorization: `Bearer ${context.token}`,
        accept: "application/json",
        "cache-control": "no-store",
        range: `0-${MAX_INVENTORY_ROWS - 1}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
  }

  let response = await readRelation(
    commercialAccess ? "inventory_items" : "inventory_catalog",
    commercialAccess ? commercialFields : safeFields,
  );

  // Draft-preview compatibility before the production security migration. The
  // fallback still selects only redacted columns and disappears once the view exists.
  if (!commercialAccess && !response.ok) {
    response = await readRelation("inventory_items", safeFields);
  }

  const text = await response.text();
  let parsed: unknown = [];
  try { parsed = text ? JSON.parse(text) : []; } catch { parsed = []; }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "message" in parsed
      ? String((parsed as { message: unknown }).message)
      : "The production inventory catalog could not be read.";
    throw new ApiError(response.status === 401 ? 401 : response.status === 403 ? 403 : 400, message);
  }
  return Array.isArray(parsed)
    ? parsed.filter((row): row is JsonObject => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

function branchCredentials() {
  const url = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !key) throw new ApiError(500, "The private stock-count service is unavailable.");
  return { url, key };
}

async function branchRpc(name: string, payload: JsonObject = {}): Promise<any> {
  const { url, key } = branchCredentials();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "message" in parsed
      ? String(parsed.message)
      : typeof parsed === "string" && parsed
      ? parsed
      : `Stock-count database request ${name} failed.`;
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

function actorPayload(context: Context) {
  return {
    id: context.user.id,
    label: labelFor(context),
    role: context.profile.role,
    active: true,
    can_manage: MANAGER_ROLES.has(context.profile.role),
  };
}

function policyPayload() {
  return {
    environment: PUBLICATION_ENV_ENABLED ? "release_candidate" : "isolated_branch",
    count_observation_mutates_inventory: false,
    verification_mutates_inventory: false,
    manager_publication_required: true,
    publication_code_path_available: true,
    publication_environment_enabled: PUBLICATION_ENV_ENABLED,
    automatic_inventory_adjustment: false,
    historical_inventory_used_as_current: false,
    direct_browser_table_access: false,
  };
}

async function snapshot(context: Context) {
  const inventory = await productionInventory(context);
  const counts = await branchRpc("atlas_stock_count_snapshot", {
    p_inventory: inventory,
    p_actor_id: context.user.id,
    p_actor_role: context.profile.role,
  });
  return { counts, staff: actorPayload(context), policy: policyPayload() };
}

async function detail(context: Context, sessionId: string) {
  const count = await branchRpc("atlas_stock_count_detail", {
    p_session_id: sessionId,
    p_actor_id: context.user.id,
    p_actor_role: context.profile.role,
  });
  return { count, staff: actorPayload(context), policy: policyPayload() };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireActiveProfile(request);
    const url = new URL(request.url);
    const action = (url.searchParams.get("action") || "snapshot").toLowerCase();

    if (request.method === "GET") {
      if (action === "snapshot") return jsonResponse(await snapshot(context));
      if (action === "detail") {
        return jsonResponse(await detail(context, requiredUuid(url.searchParams.get("id"), "Stock-count session")));
      }
      throw new ApiError(404, "Unknown stock-count action.");
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await readJson(request);
    const actorLabel = labelFor(context);
    let result: unknown;
    let sessionId: string | null = null;

    switch (action) {
      case "start": {
        requireEditingRole(context);
        const scopeType = enumValue(body.scope_type ?? "all", "Scope type", SCOPE_TYPES);
        const scopeValue = scopeType === "all" ? null : requiredText(body.scope_value, "Scope value", 220);
        const inventory = await productionInventory(context);
        result = await branchRpc("atlas_stock_count_start", {
          p_inventory: inventory,
          p_title: optionalText(body.title, "Title", 220),
          p_scope_type: scopeType,
          p_scope_value: scopeValue,
          p_notes: optionalText(body.notes, "Notes", 3000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
          p_client_request_id: requiredText(body.client_request_id, "Client request ID", 128),
        });
        sessionId = String((result as any)?.session?.id || "");
        break;
      }

      case "save-line": {
        requireEditingRole(context);
        sessionId = requiredUuid(body.session_id, "Stock-count session");
        const status = enumValue(body.line_status, "Line status", LINE_STATUSES);
        const countMethod = status === "counted"
          ? enumValue(body.count_method ?? "manual", "Count method", COUNT_METHODS)
          : null;
        const inputUnit = status === "counted"
          ? enumValue(body.observed_input_unit ?? body.observed_unit ?? "inventory", "Count unit", COUNT_UNITS)
          : "inventory";
        result = await branchRpc("atlas_stock_count_save_line_v2", {
          p_session_id: sessionId,
          p_line_id: requiredUuid(body.line_id, "Count line"),
          p_line_status: status,
          p_input_quantity: status === "counted"
            ? quantityValue(body.observed_input_quantity ?? body.observed_quantity, "Observed quantity")
            : null,
          p_input_unit: inputUnit,
          p_count_method: countMethod,
          p_note: optionalText(body.note, "Note", 2000),
          p_skipped_reason: status === "skipped" ? requiredText(body.skipped_reason, "Skip reason", 1000) : null,
          p_expected_version: integerValue(body.expected_version, "Expected line version"),
          p_evidence: objectValue(body.evidence, "Count evidence"),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "submit":
        requireEditingRole(context);
        sessionId = requiredUuid(body.session_id, "Stock-count session");
        result = await branchRpc("atlas_stock_count_submit", {
          p_session_id: sessionId,
          p_notes: optionalText(body.notes, "Submission note", 3000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "verify": {
        requireManager(context);
        sessionId = requiredUuid(body.session_id, "Stock-count session");
        result = await branchRpc("atlas_stock_count_verify", {
          p_session_id: sessionId,
          p_inventory: await productionInventory(context),
          p_acknowledge_conflicts: booleanValue(body.acknowledge_conflicts),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "prepare-publication": {
        requireManager(context);
        sessionId = requiredUuid(body.session_id, "Stock-count session");
        result = await branchRpc("atlas_stock_count_prepare_publication", {
          p_session_id: sessionId,
          p_inventory: await productionInventory(context),
          p_request_id: requiredText(body.request_id, "Publication request ID", 128),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "publish": {
        requireManager(context);
        if (!PUBLICATION_ENV_ENABLED) {
          throw new ApiError(409, "Production stock-count publication is disabled in this deployment.");
        }
        sessionId = requiredUuid(body.session_id, "Stock-count session");
        result = await branchRpc("atlas_stock_count_publish", {
          p_session_id: sessionId,
          p_request_id: requiredText(body.request_id, "Publication request ID", 128),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "reject":
        requireManager(context);
        sessionId = requiredUuid(body.session_id, "Stock-count session");
        result = await branchRpc("atlas_stock_count_reject", {
          p_session_id: sessionId,
          p_reason: requiredText(body.reason, "Rejection reason", 2000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "cancel":
        requireEditingRole(context);
        sessionId = requiredUuid(body.session_id, "Stock-count session");
        result = await branchRpc("atlas_stock_count_cancel", {
          p_session_id: sessionId,
          p_reason: optionalText(body.reason, "Cancellation reason", 2000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      default:
        throw new ApiError(404, "Unknown stock-count action.");
    }

    const refreshed = await snapshot(context);
    const refreshedDetail = sessionId && UUID_PATTERN.test(sessionId)
      ? await detail(context, sessionId)
      : null;
    return jsonResponse({
      result,
      ...refreshed,
      detail: refreshedDetail?.count || null,
    });
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Stock-count API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The stock-count service is temporarily unavailable." }, 500);
  }
});
