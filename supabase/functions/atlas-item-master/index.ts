import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Canonical stock truth shared with Reports and the browser (AtlasStockTruth):
// owner-confirmed and manager-verified evidence, the historical cutoff and the
// below-par rule.
import {
  balanceFromCountActivity,
  belowPar as canonicalBelowPar,
  projectStock,
  quantityTrustState as canonicalQuantityTrustState,
} from "../_shared/atlas-domain.mjs";
// S89: one product-identity normalisation shared with SQL, the scanner and
// the import engine (Icelandic letters kept; codes GTIN-validated).
import { normalizeCode as normalizeProductCode, searchFoldText } from "../_shared/product-identity.mjs";

const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";
const FUNCTION_VERSION = "0.2.0";
const MAX_ROWS = 5000;
const MANAGER_ROLES = new Set(["admin", "manager"]);

const MASTER_FIELDS = [
  "par_level",
  "critical_minimum",
  "supplier_id",
  "supplier",
  "supplier_product_reference",
  "units_per_case",
  "size_ml",
  "package_weight_g",
  "package_size",
  "cost_price",
  "case_cost",
  "bin_location",
  "lead_time_days",
  "minimum_order_quantity",
];

// S89 product attributes (published through atlas_apply_item_master_update).
const S89_MASTER_FIELDS = [
  "brand",
  "product_name",
  "variant",
  "item_class",
  "packaging_type",
  "unit_size_quantity",
  "unit_size_base",
  "abv_percent",
  "subcategory",
];

const FIELD_LABELS = {
  par_level: "Par level",
  critical_minimum: "Critical minimum",
  supplier: "Supplier",
  supplier_product_reference: "Supplier product reference",
  units_per_case: "Units per case",
  package_size_or_weight: "Bottle size or package weight",
  cost_price: "Unit cost",
  case_cost: "Case cost",
  bin_location: "Storage location",
  lead_time_days: "Lead time",
  minimum_order_quantity: "Minimum order quantity",
  recipe_links: "Recipe links",
  barcode_aliases: "Barcode aliases",
};

const SERVICE_CATEGORY_PATTERNS = [
  "beer", "cider", "keg", "wine", "vodka", "gin", "whiskey", "whisky",
  "rum", "tequila", "mezcal", "cognac", "brandy", "liqueur", "bitters",
  "spirit", "mixer", "juice", "syrup", "ingredient", "fruit", "herb",
  "garnish", "coffee", "energy", "non-alcoholic", "soft drink",
];

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

class ApiError extends Error {
  status;
  code;
  details;

  constructor(status, message, code = null, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// s88-activation-helpers:start (pure; unit-tested by tests/node/inventory-activation-api-s88.test.js)
const ACTIVATION_ERROR_STATUS = {
  forbidden: 403,
  not_found: 404,
  stale_item: 409,
  open_purchase_order: 409,
  active_duplicate_name: 409,
  invalid_request: 400,
  // S89 catalogue governance
  duplicate_suspected: 409,
  duplicate_identity: 409,
  code_conflict: 409,
  alias_conflict: 409,
  stale_request: 409,
  invalid_code: 400,
  open_count: 409,
  stock_on_duplicate: 409,
  append_only: 409,
};
const ACTIVATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// S88 hardening (F9): database text reaches the browser only when it is an
// Atlas-authored message (raised by our SQL) without schema detail; anything
// else (constraint, column, relation or permission text) becomes the fixed
// fallback. The SQLSTATE is logged instead.
const AUTHORED_SQLSTATES = new Set(["P0001", "42501", "22023", "P0002", "55000", "23514"]);
const SCHEMA_DETAIL = /(relation|column|constraint|function\s|schema|syntax|violates|duplicate key|permission denied|operator|does not exist|null value|sqlstate|pg_|atlas_private\.|public\.)/i;

function safeDbMessage(parsed, fallback) {
  if (!parsed || typeof parsed !== "object") return fallback;
  const body = parsed;
  const code = String(body.code ?? "");
  const message = String(body.message ?? "").trim();
  if (!message || message.length > 300 || !AUTHORED_SQLSTATES.has(code) || SCHEMA_DETAIL.test(message)) return fallback;
  return message;
}

function rpcErrorCode(hint) {
  const match = typeof hint === "string" ? hint.match(/^atlas:([a-z_]+)$/) : null;
  return match ? match[1] : null;
}

function activationErrorStatus(status, code) {
  if (code && ACTIVATION_ERROR_STATUS[code]) return ACTIVATION_ERROR_STATUS[code];
  return status >= 500 ? 500 : 400;
}

function activationItemId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!ACTIVATION_UUID.test(id)) throw new ApiError(400, "Inventory item is invalid.", "invalid_request");
  return id.toLowerCase();
}

function activationRequest(body) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (typeof source.active !== "boolean") {
    throw new ApiError(400, "Active must be true or false.", "invalid_request");
  }
  let reason = null;
  if (source.reason !== undefined && source.reason !== null && source.reason !== "") {
    if (typeof source.reason !== "string") throw new ApiError(400, "Reason must be text.", "invalid_request");
    reason = source.reason.trim() || null;
    if (reason && reason.length > 500) {
      throw new ApiError(400, "Reason is limited to 500 characters.", "invalid_request");
    }
  }
  let expectedUpdatedAt = null;
  if (source.expected_updated_at !== undefined && source.expected_updated_at !== null && source.expected_updated_at !== "") {
    const parsed = typeof source.expected_updated_at === "string" ? new Date(source.expected_updated_at) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      throw new ApiError(400, "Expected update time is invalid.", "invalid_request");
    }
    // Keep the original string: Postgres timestamps carry microseconds that
    // a JavaScript Date would round away.
    expectedUpdatedAt = source.expected_updated_at;
  }
  return {
    p_item_id: activationItemId(source.item_id),
    p_active: source.active,
    p_reason: reason,
    p_expected_updated_at: expectedUpdatedAt,
  };
}
// s88-activation-helpers:end

// s89-catalog-helpers:start (pure; unit-tested by tests/node/catalog-governance-api-s89.test.js)
const CATALOG_KINDS = new Set([
  "alias", "code", "new_item", "duplicate_resolution", "metadata_correction", "wrong_match_report", "code_conflict",
]);
const CATALOG_STATUSES = new Set(["pending", "approved", "rejected", "applied", "failed", "withdrawn", "superseded", "all"]);
const CATALOG_SOURCES = new Set(["manager", "data_review", "backfill", "import", "ai_proposal", "recognition"]);
const CATALOG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATALOG_MAX_JSON = 64 * 1024;

function catalogObject(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, `${label} must be an object.`, "invalid_request");
  if (JSON.stringify(value).length > CATALOG_MAX_JSON) throw new ApiError(413, `${label} is too large.`, "invalid_request");
  return value;
}

function catalogList(value, label, max = 20) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new ApiError(400, `${label} must be a list of up to ${max}.`, "invalid_request");
  return value;
}

function catalogUuid(value, label, required = true) {
  if ((value === undefined || value === null || value === "") && !required) return null;
  const id = typeof value === "string" ? value.trim() : "";
  if (!CATALOG_UUID.test(id)) throw new ApiError(400, `${label} is invalid.`, "invalid_request");
  return id.toLowerCase();
}

function catalogRequestId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 200) throw new ApiError(400, "A request id is required.", "invalid_request");
  return id;
}

// POST action=create-item. The legacy Add item form fields sku and barcode
// become codes; quantity is never accepted (items start at 0). The database
// runs the mandatory duplicate check.
function createItemRequest(body) {
  const source = catalogObject(body, "Request");
  const values = { ...catalogObject(source.values, "Item values") };
  const codes = [...catalogList(source.codes, "Codes")];
  for (const [field, kind] of [["sku", "sku"], ["barcode", null]]) {
    const raw = typeof values[field] === "string" ? values[field].trim() : "";
    if (raw) codes.push(kind ? { kind, code: raw } : { code: raw });
    delete values[field];
  }
  delete values.quantity;
  return {
    p_values: values,
    p_codes: codes,
    p_aliases: catalogList(source.aliases, "Aliases"),
    p_media_id: catalogUuid(source.media_id, "Image", false),
    p_duplicate_ack: source.duplicate_ack === undefined || source.duplicate_ack === null
      ? null
      : Array.isArray(source.duplicate_ack)
        ? { acknowledged: source.duplicate_ack }
        : catalogObject(source.duplicate_ack, "Duplicate acknowledgement"),
    p_change_request_id: catalogUuid(source.change_request_id, "Change request", false),
    p_request_id: catalogRequestId(source.request_id),
  };
}

function findDuplicatesRequest(body) {
  const source = catalogObject(body, "Request");
  const limit = source.limit === undefined ? 10 : Number(source.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ApiError(400, "Limit must be between 1 and 50.", "invalid_request");
  const request = createItemRequest({ ...source, request_id: "find-duplicates" });
  return {
    p_values: request.p_values,
    p_codes: request.p_codes,
    p_aliases: request.p_aliases,
    p_exclude_item_id: catalogUuid(source.exclude_item_id, "Excluded item", false),
    p_limit: limit,
  };
}

function catalogDecideRequest(body) {
  const source = catalogObject(body, "Request");
  const decision = typeof source.decision === "string" ? source.decision.trim().toLowerCase() : "";
  if (!["approve", "reject"].includes(decision)) throw new ApiError(400, "Decision must be approve or reject.", "invalid_request");
  const note = source.note === undefined || source.note === null ? null : String(source.note).trim() || null;
  if (note && note.length > 2000) throw new ApiError(400, "Note is limited to 2000 characters.", "invalid_request");
  let version = null;
  if (source.expected_version !== undefined && source.expected_version !== null) {
    version = Number(source.expected_version);
    if (!Number.isInteger(version) || version < 1) throw new ApiError(400, "Expected version is invalid.", "invalid_request");
  }
  return {
    p_id: catalogUuid(source.id ?? source.change_request_id, "Change request"),
    p_decision: decision,
    p_note: note,
    p_expected_version: version,
    p_resolution: catalogObject(source.resolution, "Resolution"),
  };
}

function catalogCreateRequest(body) {
  const source = catalogObject(body, "Request");
  const kind = typeof source.kind === "string" ? source.kind.trim() : "";
  if (!CATALOG_KINDS.has(kind)) throw new ApiError(400, "Unknown catalogue request type.", "invalid_request");
  const origin = typeof source.source === "string" && source.source.trim() ? source.source.trim() : "manager";
  if (!CATALOG_SOURCES.has(origin)) throw new ApiError(400, "Unknown request source.", "invalid_request");
  return {
    p_kind: kind,
    p_subject_item_id: catalogUuid(source.subject_item_id, "Item", false),
    p_payload: catalogObject(source.payload, "Payload"),
    p_evidence: catalogObject(source.evidence, "Evidence"),
    p_source: origin,
    p_ai_action_id: catalogUuid(source.ai_action_id, "Atlas AI action", false),
    p_recognition_request_id: catalogUuid(source.recognition_request_id, "Recognition result", false),
    p_media_id: catalogUuid(source.media_id, "Image", false),
    p_request_id: catalogRequestId(source.request_id),
    p_self_approve: source.self_approve === true,
  };
}

function catalogQueueQuery(params) {
  const status = (params.get("status") || "pending").trim().toLowerCase();
  if (!CATALOG_STATUSES.has(status)) throw new ApiError(400, "Status is invalid.", "invalid_request");
  const kind = (params.get("kind") || "").trim();
  if (kind && !CATALOG_KINDS.has(kind)) throw new ApiError(400, "Unknown catalogue request type.", "invalid_request");
  const limit = Number(params.get("limit") || 50);
  const offset = Number(params.get("offset") || 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, "Limit must be between 1 and 200.", "invalid_request");
  if (!Number.isInteger(offset) || offset < 0) throw new ApiError(400, "Offset is invalid.", "invalid_request");
  return { p_kind: kind || null, p_status: status, p_limit: limit, p_offset: offset };
}

// The database puts the duplicate check (candidates, conflicts) in the error
// detail of duplicate_suspected / duplicate_identity / code_conflict /
// alias_conflict refusals.
function catalogErrorDetails(details) {
  if (typeof details !== "string" || !details.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(details);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// A decided request that came from an approved Atlas AI proposal is also
// written to the Brain (atlas_catalog_record_ai_decision -> brain_decisions).
function shouldRecordAiDecision(request) {
  return Boolean(request && typeof request === "object" && request.source === "ai_proposal"
    && typeof request.ai_action_id === "string" && request.ai_action_id
    && ["applied", "rejected", "failed"].includes(String(request.status)));
}
// s89-catalog-helpers:end

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-item-master-version": FUNCTION_VERSION,
    },
  });
}

function bearerToken(request) {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.");
  return match[1];
}

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Search-only comparison key for recipe ingredient names (never stored).
function normalizeName(value) {
  return searchFoldText(value).replace(/[.,]+/g, " ").replace(/\s+/g, " ").trim();
}

// Shared code normalisation: GTIN-14 for valid GTINs, otherwise the code
// with whitespace removed and ASCII letters upper-cased (hyphens kept).
function normalizeCode(value) {
  const code = normalizeProductCode(text(value));
  if (code.valid) return code.normalized;
  return normalizeProductCode(text(value), { kind: "other_barcode" }).normalized ?? "";
}

function stableHash(value) {
  const source = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function labelFor(context) {
  return text(context.profile.display_name)
    || text(context.profile.email)
    || text(context.user.email)
    || context.user.id;
}

async function requireManager(request) {
  const token = bearerToken(request);
  const headers = {
    apikey: AUTH_PUBLISHABLE_KEY,
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "cache-control": "no-store",
  };

  const userResponse = await fetch(`${AUTH_PROJECT_URL}/auth/v1/user`, { headers });
  if (!userResponse.ok) throw new ApiError(401, "Your Atlas session has expired.");
  const user = await userResponse.json();
  if (!user?.id) throw new ApiError(401, "Your Atlas account could not be verified.");

  const profileUrl = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  profileUrl.searchParams.set("id", `eq.${user.id}`);
  profileUrl.searchParams.set("select", "id,email,display_name,role,active");
  profileUrl.searchParams.set("limit", "1");
  const profileResponse = await fetch(profileUrl, { headers });
  if (!profileResponse.ok) throw new ApiError(403, "Your Atlas staff profile could not be verified.");
  const profiles = await profileResponse.json();
  const profile = Array.isArray(profiles) ? profiles[0] : null;
  if (!profile?.active) throw new ApiError(403, "This Atlas profile is inactive.");
  if (!MANAGER_ROLES.has(profile.role)) {
    throw new ApiError(403, "Checkpoint L2 is available only to managers and administrators.");
  }

  return {
    token,
    user: { id: user.id, email: user.email ?? null },
    profile,
  };
}

function productionHeaders(context, extra = {}) {
  return {
    apikey: AUTH_PUBLISHABLE_KEY,
    authorization: `Bearer ${context.token}`,
    accept: "application/json",
    "cache-control": "no-store",
    ...extra,
  };
}

async function productionRows(context, table, select, orderColumn, filters = {}) {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  if (orderColumn) url.searchParams.set("order", `${orderColumn}.asc.nullslast`);
  url.searchParams.set("limit", String(MAX_ROWS));
  for (const [key, value] of Object.entries(filters)) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  try {
    const response = await fetch(url, {
      headers: productionHeaders(context, { range: `0-${MAX_ROWS - 1}` }),
    });
    const body = await response.text();
    let parsed = [];
    try { parsed = body ? JSON.parse(body) : []; } catch { parsed = []; }
    if (!response.ok) {
      const message = safeDbMessage(parsed, `${table} returned ${response.status}`);
      return { table, status: "degraded", rows: [], error: message, statusCode: response.status };
    }
    const rows = Array.isArray(parsed)
      ? parsed.filter((row) => row && typeof row === "object" && !Array.isArray(row))
      : [];
    return { table, status: rows.length ? "connected" : "no_records", rows, error: null, statusCode: response.status };
  } catch (error) {
    return {
      table,
      status: "degraded",
      rows: [],
      error: `${table} could not be read`,
      statusCode: 0,
    };
  }
}

async function inventoryRows(context) {
  const richSelect = [
    "id", "name", "category", "quantity", "unit", "par_level", "critical_minimum",
    "supplier_id", "supplier", "supplier_product_reference", "units_per_case",
    "size_ml", "package_weight_g", "package_size", "cost_price", "case_cost",
    "bin_location", "lead_time_days", "minimum_order_quantity", "sku", "barcode",
    "active", "source_file", "source_updated_at", "source_type", "source_confidence",
    "source_confirmed_at", "source_confirmed_quantity", "updated_at",
  ].join(",");
  const legacySelect = [
    "id", "name", "category", "quantity", "unit", "par_level", "supplier_id",
    "supplier", "units_per_case", "size_ml", "package_size", "cost_price", "case_cost",
    "bin_location", "sku", "barcode", "active", "source_file", "source_updated_at",
    "updated_at",
  ].join(",");

  const s89 = await productionRows(context, "inventory_items", `${richSelect},${S89_MASTER_FIELDS.join(",")}`, "name", { active: "eq.true" });
  if (s89.status !== "degraded") {
    return { ...s89, schemaState: "s89_columns_available" };
  }

  const rich = await productionRows(context, "inventory_items", richSelect, "name", { active: "eq.true" });
  if (rich.status !== "degraded") {
    return { ...rich, schemaState: "l2_columns_available" };
  }

  const legacy = await productionRows(context, "inventory_items", legacySelect, "name", { active: "eq.true" });
  return {
    ...legacy,
    rows: legacy.rows.map((row) => ({
      critical_minimum: null,
      supplier_product_reference: null,
      package_weight_g: null,
      lead_time_days: null,
      minimum_order_quantity: null,
      ...row,
    })),
    schemaState: legacy.status === "degraded" ? "unavailable" : "legacy_columns",
    richSchemaError: rich.error,
  };
}

function branchCredentials() {
  const branchUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!branchUrl || !serviceRoleKey) {
    throw new ApiError(500, "The private Checkpoint L2 service is unavailable.");
  }
  return { branchUrl, serviceRoleKey };
}

async function branchRpc(name, payload = {}) {
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
  const body = await response.text();
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
  if (!response.ok) {
    const message = safeDbMessage(parsed, "The item master database request failed.");
    if (message === "The item master database request failed.") {
      console.warn("Checkpoint L2 RPC failed", name, response.status, parsed && typeof parsed === "object" ? String(parsed.code ?? "-") : "-");
    }
    const code = parsed && typeof parsed === "object" ? rpcErrorCode(parsed.hint) : null;
    const details = parsed && typeof parsed === "object" ? catalogErrorDetails(parsed.details) : null;
    throw new ApiError(code ? activationErrorStatus(response.status, code) : response.status >= 500 ? 500 : 400, message, code, details);
  }
  return parsed;
}

function masterValues(item) {
  const values = {};
  for (const field of MASTER_FIELDS) values[field] = item[field] ?? null;
  // S89 fields join the optimistic check only once the columns exist.
  for (const field of S89_MASTER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(item, field)) values[field] = item[field] ?? null;
  }
  return values;
}

function sourceSnapshot(item) {
  const values = masterValues(item);
  return {
    id: item.id,
    name: item.name,
    category: item.category ?? null,
    unit: item.unit ?? null,
    updated_at: item.updated_at ?? null,
    source_file: item.source_file ?? null,
    source_updated_at: item.source_updated_at ?? null,
    master_values: values,
    // The fingerprint stays on the legacy fields so drafts saved before S89
    // still match their source.
    master_fingerprint: stableHash(Object.fromEntries(MASTER_FIELDS.map((field) => [field, values[field]]))),
  };
}

function isImportantServiceCategory(category) {
  const normalized = lower(category);
  return SERVICE_CATEGORY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

// Same trust states as Reports (current / stale / historical / unverified):
// a current manager count or a newer owner-confirmed count is current.
function quantityTrustState(item, countActivity, nowMillis = Date.now()) {
  return canonicalQuantityTrustState(item, balanceFromCountActivity(countActivity), nowMillis);
}

function createEnvironment(sources) {
  const items = sources.inventory.rows.filter((item) => item.active !== false);
  const activeRecipes = sources.recipes.rows.filter((recipe) => recipe.active !== false);
  const recipeById = new Map(activeRecipes.map((recipe) => [text(recipe.id), recipe]));
  const itemByNormalizedName = new Map();
  for (const item of items) {
    const key = normalizeName(item.name);
    if (!itemByNormalizedName.has(key)) itemByNormalizedName.set(key, []);
    itemByNormalizedName.get(key).push(item);
  }

  const linkedByItem = new Map();
  const candidateLinksByItem = new Map();
  for (const ingredient of sources.ingredients.rows) {
    const recipe = recipeById.get(text(ingredient.recipe_id));
    if (!recipe) continue;
    const link = {
      ingredient_id: text(ingredient.id),
      recipe_id: text(recipe.id),
      recipe_name: text(recipe.name),
      item_name: text(ingredient.item_name),
      quantity: ingredient.quantity ?? null,
      unit: ingredient.unit ?? null,
    };
    if (ingredient.item_id) {
      const itemId = text(ingredient.item_id);
      if (!linkedByItem.has(itemId)) linkedByItem.set(itemId, []);
      linkedByItem.get(itemId).push(link);
      continue;
    }
    const matches = itemByNormalizedName.get(normalizeName(ingredient.item_name)) ?? [];
    if (matches.length === 1) {
      const itemId = text(matches[0].id);
      if (!candidateLinksByItem.has(itemId)) candidateLinksByItem.set(itemId, []);
      candidateLinksByItem.get(itemId).push(link);
    }
  }

  const movementByItem = new Map();
  const adjustmentByItem = new Map();
  for (const movement of sources.movements.rows) {
    const itemId = text(movement.item_id);
    if (!itemId) continue;
    movementByItem.set(itemId, (movementByItem.get(itemId) ?? 0) + 1);
    if (["adjustment", "count"].includes(lower(movement.movement_type))) {
      adjustmentByItem.set(itemId, (adjustmentByItem.get(itemId) ?? 0) + 1);
    }
  }

  const draftByItem = new Map((sources.branch.drafts ?? []).map((draft) => [text(draft.external_item_id), draft]));
  const aliasesByItem = new Map();
  const aliasByCode = new Map();
  for (const alias of sources.branch.barcode_aliases ?? []) {
    const itemId = text(alias.external_item_id);
    if (!aliasesByItem.has(itemId)) aliasesByItem.set(itemId, []);
    aliasesByItem.get(itemId).push(alias);
    aliasByCode.set(normalizeCode(alias.normalized_code || alias.code), alias);
  }
  const countByItem = new Map((sources.branch.count_activity ?? []).map((entry) => [text(entry.inventory_item_id), entry]));
  const nowMillis = Date.now();
  const projectedByItem = new Map(projectStock(
    items,
    [...countByItem.values()].map(balanceFromCountActivity).filter(Boolean),
    sources.movements.rows,
    nowMillis,
  ).map((projected) => [text(projected.id), projected]));
  const supplierById = new Map(sources.suppliers.rows.map((supplier) => [text(supplier.id), supplier]));

  return {
    items,
    activeRecipes,
    linkedByItem,
    candidateLinksByItem,
    movementByItem,
    adjustmentByItem,
    draftByItem,
    aliasesByItem,
    aliasByCode,
    countByItem,
    projectedByItem,
    nowMillis,
    supplierById,
  };
}

function assessItem(item, environment, draftOverride = undefined) {
  const itemId = text(item.id);
  const draft = draftOverride === undefined ? environment.draftByItem.get(itemId) ?? null : draftOverride;
  const proposedValues = draft?.proposed_values && typeof draft.proposed_values === "object"
    ? draft.proposed_values
    : {};
  const effective = { ...item, ...proposedValues };
  const existingAliases = environment.aliasesByItem.get(itemId) ?? [];
  const proposedAliases = Array.isArray(draft?.proposed_barcode_aliases) ? draft.proposed_barcode_aliases : [];
  const aliases = [...existingAliases];
  const aliasKeys = new Set(existingAliases.map((entry) => normalizeCode(entry.normalized_code || entry.code)));
  for (const entry of proposedAliases) {
    const key = normalizeCode(entry?.code);
    if (key && !aliasKeys.has(key)) {
      aliases.push({ ...entry, normalized_code: key, draft: true });
      aliasKeys.add(key);
    }
  }

  const linkedRecipes = environment.linkedByItem.get(itemId) ?? [];
  const recipeLinkCandidates = environment.candidateLinksByItem.get(itemId) ?? [];
  const proposedRecipeLinks = Array.isArray(draft?.proposed_recipe_links) ? draft.proposed_recipe_links : [];
  const selectedLinkIds = new Set(proposedRecipeLinks.map((entry) => text(entry.ingredient_id)));

  const hasSupplier = Boolean(text(effective.supplier_id) || text(effective.supplier));
  const hasPackage = nullableNumber(effective.size_ml) !== null
    || nullableNumber(effective.package_weight_g) !== null
    || Boolean(text(effective.package_size));
  const hasBarcode = Boolean(text(item.barcode) || aliases.length);
  const recipeLinkComplete = recipeLinkCandidates.length === 0
    || linkedRecipes.length > 0
    || selectedLinkIds.size > 0;

  const fieldChecks = {
    par_level: nullableNumber(effective.par_level) !== null,
    critical_minimum: nullableNumber(effective.critical_minimum) !== null,
    supplier: hasSupplier,
    supplier_product_reference: Boolean(text(effective.supplier_product_reference)),
    units_per_case: numberValue(effective.units_per_case) > 0,
    package_size_or_weight: hasPackage,
    cost_price: nullableNumber(effective.cost_price) !== null,
    case_cost: nullableNumber(effective.case_cost) !== null,
    bin_location: Boolean(text(effective.bin_location)),
    lead_time_days: nullableNumber(effective.lead_time_days) !== null,
    minimum_order_quantity: numberValue(effective.minimum_order_quantity) > 0,
    recipe_links: recipeLinkComplete,
    barcode_aliases: hasBarcode,
  };
  const missingFields = Object.entries(fieldChecks)
    .filter(([, complete]) => !complete)
    .map(([key]) => key);
  const completeFields = Object.values(fieldChecks).filter(Boolean).length;
  const completionPercent = Math.round((completeFields / Object.keys(fieldChecks).length) * 100);

  const countActivity = environment.countByItem.get(itemId) ?? null;
  const movementCount = environment.movementByItem.get(itemId) ?? 0;
  const adjustmentCount = environment.adjustmentByItem.get(itemId) ?? 0;
  const quantityStatus = quantityTrustState(item, countActivity, environment.nowMillis);
  const projected = environment.projectedByItem.get(itemId) ?? null;
  const historicalZero = quantityStatus === "historical" && numberValue(item.quantity) <= 0;
  // The canonical AtlasStockTruth.belowPar on verified stock, against the
  // effective (draft-aware) par. Unverified stock is never below par.
  const belowPar = Boolean(projected) && canonicalBelowPar({ ...projected, par_level: effective.par_level });
  const usedByActiveRecipe = linkedRecipes.length > 0 || recipeLinkCandidates.length > 0;
  const importantCategory = isImportantServiceCategory(item.category);

  let priorityScore = 0;
  const priorityReasons = [];
  if (usedByActiveRecipe) {
    priorityScore += linkedRecipes.length ? 45 : 35;
    priorityReasons.push(linkedRecipes.length
      ? `Used by ${linkedRecipes.length} active recipe${linkedRecipes.length === 1 ? "" : "s"}`
      : `Matches ${recipeLinkCandidates.length} unlinked active-recipe ingredient${recipeLinkCandidates.length === 1 ? "" : "s"}`);
  }
  if (importantCategory) {
    priorityScore += 15;
    priorityReasons.push("Important service category");
  }
  if (historicalZero) {
    priorityScore += 25;
    priorityReasons.push("Historical zero requires a verified current count");
  } else if (belowPar) {
    priorityScore += 30;
    priorityReasons.push("Verified current quantity is below configured par");
  }
  if (numberValue(countActivity?.count_observations) >= 2) {
    const score = Math.min(20, numberValue(countActivity.count_observations) * 4);
    priorityScore += score;
    priorityReasons.push(`Counted ${countActivity.count_observations} times`);
  }
  if (movementCount >= 2) {
    priorityScore += Math.min(15, movementCount * 3);
    priorityReasons.push(`${movementCount} recorded inventory movements`);
  }
  if (adjustmentCount >= 2) {
    priorityScore += Math.min(12, adjustmentCount * 4);
    priorityReasons.push(`${adjustmentCount} count or adjustment movements`);
  }
  if (!hasSupplier) {
    priorityScore += 12;
    priorityReasons.push("Supplier missing");
  }
  if (!hasPackage) {
    priorityScore += 12;
    priorityReasons.push("Package information missing");
  }
  if (recipeLinkCandidates.length > 0 && !recipeLinkComplete) {
    priorityScore += 15;
    priorityReasons.push("Active recipe ingredient needs an inventory link");
  }
  priorityScore += Math.min(30, missingFields.length * 3);

  let priorityTier = "standard";
  if (missingFields.length === 0) {
    priorityTier = "complete";
    priorityScore = 0;
  } else if (priorityScore >= 75) {
    priorityTier = "critical";
  } else if (priorityScore >= 45) {
    priorityTier = "high";
  }

  return {
    item: {
      id: itemId,
      name: text(item.name),
      category: text(item.category),
      quantity: nullableNumber(item.quantity),
      unit: text(item.unit),
      source_updated_at: item.source_updated_at ?? null,
      updated_at: item.updated_at ?? null,
      barcode: item.barcode ?? null,
      sku: item.sku ?? null,
    },
    source_snapshot: sourceSnapshot(item),
    effective_values: masterValues(effective),
    proposed_values: proposedValues,
    linked_recipes: linkedRecipes,
    recipe_link_candidates: recipeLinkCandidates.map((entry) => ({
      ...entry,
      selected: selectedLinkIds.has(entry.ingredient_id),
    })),
    barcode_aliases: aliases,
    proposed_barcode_aliases: proposedAliases,
    quantity_status: quantityStatus,
    verified_quantity: projected?.verified_quantity ?? null,
    verified_at: projected?.stock_baseline_at ? new Date(projected.stock_baseline_at).toISOString() : null,
    quantity_source: projected?.stock_source ?? null,
    recount_due: projected?.stock_recount_due === true,
    count_observations: numberValue(countActivity?.count_observations),
    movement_count: movementCount,
    adjustment_count: adjustmentCount,
    field_checks: fieldChecks,
    missing_fields: missingFields,
    missing_field_labels: missingFields.map((field) => FIELD_LABELS[field] ?? field),
    completion_percent: completionPercent,
    priority_score: priorityScore,
    priority_tier: priorityTier,
    priority_reasons: priorityReasons,
    draft,
  };
}

function summarizeQueue(queue) {
  const fieldCoverage = {};
  for (const key of Object.keys(FIELD_LABELS)) {
    fieldCoverage[key] = {
      complete: queue.filter((entry) => entry.field_checks[key]).length,
      total: queue.length,
    };
  }
  return {
    active_items: queue.length,
    critical_items: queue.filter((entry) => entry.priority_tier === "critical").length,
    high_items: queue.filter((entry) => entry.priority_tier === "high").length,
    standard_items: queue.filter((entry) => entry.priority_tier === "standard").length,
    complete_items: queue.filter((entry) => entry.priority_tier === "complete").length,
    draft_items: queue.filter((entry) => entry.draft && entry.draft.status !== "published").length,
    published_items: queue.filter((entry) => entry.draft?.status === "published").length,
    total_missing_fields: queue.reduce((total, entry) => total + entry.missing_fields.length, 0),
    average_completion_percent: queue.length
      ? Math.round(queue.reduce((total, entry) => total + entry.completion_percent, 0) / queue.length)
      : 0,
    field_coverage: fieldCoverage,
  };
}

async function sourceBundle(context) {
  const [inventory, recipes, ingredients, suppliers, movements, branch] = await Promise.all([
    inventoryRows(context),
    productionRows(context, "recipes", "id,name,type,active,show_on_menu,updated_at", "name"),
    productionRows(context, "recipe_ingredients", "id,recipe_id,item_id,item_name,quantity,unit", "id"),
    productionRows(context, "suppliers", "id,name,active,updated_at", "name"),
    productionRows(context, "inventory_movements", "id,item_id,item_name,movement_type,quantity_change,created_at", "created_at"),
    branchRpc("atlas_item_master_snapshot", {
      p_actor_id: context.user.id,
      p_actor_role: context.profile.role,
    }),
  ]);

  if (inventory.status === "degraded") {
    throw new ApiError(503, `Production inventory could not be read: ${inventory.error || "unknown error"}`);
  }
  return { inventory, recipes, ingredients, suppliers, movements, branch };
}

async function buildWorkspace(context) {
  const sources = await sourceBundle(context);
  const environment = createEnvironment(sources);
  const queue = environment.items
    .map((item) => assessItem(item, environment))
    .sort((left, right) =>
      right.priority_score - left.priority_score
      || left.item.category.localeCompare(right.item.category)
      || left.item.name.localeCompare(right.item.name));

  return {
    workspace: {
      version: "atlas-item-master-l2/0.1.0",
      generated_at: new Date().toISOString(),
      summary: summarizeQueue(queue),
      queue,
      suppliers: sources.suppliers.rows
        .filter((supplier) => supplier.active !== false)
        .map((supplier) => ({ id: text(supplier.id), name: text(supplier.name) })),
      source_health: {
        inventory: { status: sources.inventory.status, schema_state: sources.inventory.schemaState, records: sources.inventory.rows.length, error: sources.inventory.error ?? null },
        recipes: { status: sources.recipes.status, records: sources.recipes.rows.length, error: sources.recipes.error ?? null },
        recipe_ingredients: { status: sources.ingredients.status, records: sources.ingredients.rows.length, error: sources.ingredients.error ?? null },
        suppliers: { status: sources.suppliers.status, records: sources.suppliers.rows.length, error: sources.suppliers.error ?? null },
        movements: { status: sources.movements.status, records: sources.movements.rows.length, error: sources.movements.error ?? null },
      },
      policy: {
        manager_only: true,
        private_drafts: true,
        production_apply_enabled: Boolean(sources.branch?.settings?.production_apply_enabled),
        source_match_required: sources.branch?.settings?.source_match_required !== false,
        quantity_mutation: false,
        inventory_movement_creation: false,
        supplier_order_submission: false,
      },
    },
    sources,
    environment,
  };
}

function optionalNumber(value, field, options = {}) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ApiError(400, `${FIELD_LABELS[field] ?? field} must be numeric.`);
  if (options.integer && !Number.isInteger(parsed)) throw new ApiError(400, `${FIELD_LABELS[field] ?? field} must be a whole number.`);
  if (options.exclusiveMin !== undefined && parsed <= options.exclusiveMin) {
    throw new ApiError(400, `${FIELD_LABELS[field] ?? field} must be greater than ${options.exclusiveMin}.`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new ApiError(400, `${FIELD_LABELS[field] ?? field} cannot be below ${options.min}.`);
  }
  return parsed;
}

function sanitizeProposedValues(input, item, environment) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "Item-master values must be an object.");
  }
  const values = {};
  const par = optionalNumber(input.par_level, "par_level", { min: 0 });
  const critical = optionalNumber(input.critical_minimum, "critical_minimum", { min: 0 });
  const unitsPerCase = optionalNumber(input.units_per_case, "units_per_case", { exclusiveMin: 0 });
  const sizeMl = optionalNumber(input.size_ml, "package_size_or_weight", { exclusiveMin: 0 });
  const packageWeight = optionalNumber(input.package_weight_g, "package_size_or_weight", { exclusiveMin: 0 });
  let unitCost = optionalNumber(input.cost_price, "cost_price", { min: 0 });
  const caseCost = optionalNumber(input.case_cost, "case_cost", { min: 0 });
  const leadTime = optionalNumber(input.lead_time_days, "lead_time_days", { min: 0, integer: true });
  const minimumOrder = optionalNumber(input.minimum_order_quantity, "minimum_order_quantity", { exclusiveMin: 0 });

  if (par !== null) values.par_level = par;
  if (critical !== null) values.critical_minimum = critical;
  if ((critical ?? nullableNumber(item.critical_minimum)) !== null
      && (par ?? nullableNumber(item.par_level)) !== null
      && (critical ?? nullableNumber(item.critical_minimum)) > (par ?? nullableNumber(item.par_level))) {
    throw new ApiError(400, "Critical minimum cannot be above par level.");
  }

  const supplierId = text(input.supplier_id);
  if (supplierId) {
    const supplier = environment.supplierById.get(supplierId);
    if (!supplier) throw new ApiError(400, "Select a supplier from the current supplier list.");
    values.supplier_id = supplierId;
    values.supplier = text(supplier.name);
  } else if (text(input.supplier)) {
    values.supplier = text(input.supplier).slice(0, 240);
  }

  const supplierReference = text(input.supplier_product_reference);
  if (supplierReference) values.supplier_product_reference = supplierReference.slice(0, 240);
  if (unitsPerCase !== null) values.units_per_case = unitsPerCase;
  if (sizeMl !== null) values.size_ml = sizeMl;
  if (packageWeight !== null) values.package_weight_g = packageWeight;

  let packageSize = text(input.package_size);
  if (!packageSize && sizeMl !== null) packageSize = `${sizeMl} ml`;
  if (!packageSize && packageWeight !== null) packageSize = `${packageWeight} g`;
  if (packageSize) values.package_size = packageSize.slice(0, 120);

  if (unitCost === null && caseCost !== null && unitsPerCase !== null) {
    unitCost = Math.round((caseCost / unitsPerCase) * 100) / 100;
  }
  if (unitCost !== null) values.cost_price = unitCost;
  if (caseCost !== null) values.case_cost = caseCost;

  const location = text(input.bin_location);
  if (location) values.bin_location = location.slice(0, 240);
  Object.assign(values, sanitizeProductAttributes(input));
  if (leadTime !== null) values.lead_time_days = leadTime;
  if (minimumOrder !== null) values.minimum_order_quantity = minimumOrder;
  return values;
}

const ITEM_CLASSES = new Set([
  "spirit", "liqueur", "wine", "sparkling", "beer_cider", "non_alcoholic", "syrup", "bar_ingredient", "dairy_alt",
  "coffee_tea", "produce", "garnish", "food", "consumable", "cleaning", "equipment", "gas", "prep", "reference",
]);
const PACKAGING_TYPES = new Set([
  "bottle", "can", "carton", "keg", "bag", "box", "case", "jar", "tub", "pouch", "sachet", "tray", "bundle", "loose",
  "cup", "wrapped", "cylinder", "tool", "other",
]);

// S89 product attributes. Text keeps every letter as typed (no folding).
function sanitizeProductAttributes(input) {
  const values = {};
  for (const field of ["brand", "product_name", "variant", "subcategory"]) {
    const value = text(input[field]);
    if (value) values[field] = value.slice(0, 240);
  }
  const itemClass = lower(input.item_class);
  if (itemClass) {
    if (!ITEM_CLASSES.has(itemClass)) throw new ApiError(400, "Product type is not in the Atlas taxonomy.");
    values.item_class = itemClass;
  }
  const packagingType = lower(input.packaging_type);
  if (packagingType) {
    if (!PACKAGING_TYPES.has(packagingType)) throw new ApiError(400, "Package type is not supported.");
    values.packaging_type = packagingType;
  }
  const unitSize = optionalNumber(input.unit_size_quantity, "unit_size_quantity", { exclusiveMin: 0 });
  const unitBase = lower(input.unit_size_base);
  if (unitSize !== null || unitBase) {
    if (unitSize === null || !["ml", "g", "count"].includes(unitBase)) {
      throw new ApiError(400, "Unit size needs a quantity and a unit (ml, g or count).");
    }
    values.unit_size_quantity = unitSize;
    values.unit_size_base = unitBase;
  }
  const abv = optionalNumber(input.abv_percent, "abv_percent", { min: 0 });
  if (abv !== null) {
    if (abv > 100) throw new ApiError(400, "ABV must be between 0 and 100.");
    values.abv_percent = abv;
  }
  return values;
}

function sanitizeRecipeLinks(input, queueItem) {
  const requested = Array.isArray(input) ? input : [];
  const allowed = new Map(queueItem.recipe_link_candidates.map((entry) => [text(entry.ingredient_id), entry]));
  const result = [];
  const seen = new Set();
  for (const value of requested) {
    const ingredientId = text(value?.ingredient_id ?? value);
    if (!ingredientId || seen.has(ingredientId)) continue;
    const candidate = allowed.get(ingredientId);
    if (!candidate) throw new ApiError(400, "A selected recipe link is no longer available for this item.");
    result.push({
      ingredient_id: ingredientId,
      recipe_id: candidate.recipe_id,
      recipe_name: candidate.recipe_name,
      item_name: candidate.item_name,
      quantity: candidate.quantity,
      unit: candidate.unit,
    });
    seen.add(ingredientId);
  }
  return result;
}

function sanitizeAliases(input, queueItem, environment) {
  const requested = Array.isArray(input) ? input : [];
  const result = [];
  const seen = new Set();
  for (const value of requested) {
    const code = text(value?.code ?? value);
    const normalized = normalizeCode(code);
    if (!normalized) continue;
    if (normalized.length < 3 || normalized.length > 128) {
      throw new ApiError(400, "Barcode aliases must normalize to 3–128 characters.");
    }
    if (seen.has(normalized)) continue;
    const conflict = environment.aliasByCode.get(normalized);
    if (conflict && text(conflict.external_item_id) !== queueItem.item.id) {
      throw new ApiError(409, `Barcode ${code} is already linked to another inventory item.`);
    }
    result.push({ code, symbology: text(value?.symbology) || "unknown" });
    seen.add(normalized);
  }
  return result;
}

function requestId(prefix, itemId) {
  return `${prefix}:${itemId}:${crypto.randomUUID()}`;
}

async function saveDraft(context, body) {
  const built = await buildWorkspace(context);
  const queueItem = built.workspace.queue.find((entry) => entry.item.id === text(body.item_id));
  if (!queueItem) throw new ApiError(404, "Inventory item not found in the current L2 queue.");

  const proposedValues = sanitizeProposedValues(body.proposed_values ?? {}, queueItem.effective_values, built.environment);
  const recipeLinks = sanitizeRecipeLinks(body.recipe_links, queueItem);
  const aliases = sanitizeAliases(body.barcode_aliases, queueItem, built.environment);
  const draftOverride = {
    proposed_values: proposedValues,
    proposed_recipe_links: recipeLinks,
    proposed_barcode_aliases: aliases,
    status: "draft",
  };
  const sourceItem = built.environment.items.find((item) => text(item.id) === queueItem.item.id);
  const reassessed = assessItem(sourceItem, built.environment, draftOverride);
  const currentDraft = queueItem.draft;

  await branchRpc("atlas_item_master_save_draft", {
    p_external_item_id: queueItem.item.id,
    p_item_name: queueItem.item.name,
    p_category: queueItem.item.category || null,
    p_source_snapshot: queueItem.source_snapshot,
    p_proposed_values: proposedValues,
    p_recipe_links: recipeLinks,
    p_barcode_aliases: aliases,
    p_priority_score: reassessed.priority_score,
    p_priority_tier: reassessed.priority_tier,
    p_priority_reasons: reassessed.priority_reasons,
    p_missing_fields: reassessed.missing_fields,
    p_expected_version: currentDraft ? Number(currentDraft.version) : null,
    p_actor_id: context.user.id,
    p_actor_label: labelFor(context),
    p_actor_role: context.profile.role,
  });

  const refreshed = await buildWorkspace(context);
  return {
    ...refreshed.workspace,
    message: `Private item-master draft saved for ${queueItem.item.name}.`,
  };
}

async function productionRpc(context, name, payload) {
  const response = await fetch(`${AUTH_PROJECT_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: productionHeaders(context, {
      "content-type": "application/json",
      prefer: "return=representation",
    }),
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
  if (!response.ok) {
    const message = safeDbMessage(parsed, `Production item-master publication failed (${response.status}).`);
    throw new ApiError(response.status >= 500 ? 500 : 409, message);
  }
  return parsed;
}

async function publishDraft(context, body) {
  const built = await buildWorkspace(context);
  const draftId = text(body.draft_id);
  const queueItem = built.workspace.queue.find((entry) => text(entry.draft?.id) === draftId);
  if (!queueItem?.draft) throw new ApiError(404, "Item-master draft not found.");
  const publicationRequestId = text(body.request_id) || requestId("checkpoint-l2", queueItem.item.id);

  let publication = await branchRpc("atlas_item_master_prepare_publication", {
    p_draft_id: draftId,
    p_request_id: publicationRequestId,
    p_current_source_snapshot: queueItem.source_snapshot,
    p_actor_id: context.user.id,
    p_actor_label: labelFor(context),
    p_actor_role: context.profile.role,
  });

  if (publication?.status === "blocked") {
    const refreshed = await buildWorkspace(context);
    return {
      ...refreshed.workspace,
      publication,
      message: publication.blocked_reason || "Item-master publication is blocked.",
    };
  }
  if (publication?.status === "published") {
    const refreshed = await buildWorkspace(context);
    return { ...refreshed.workspace, publication, message: "Item-master publication was already completed." };
  }

  publication = await branchRpc("atlas_item_master_begin_publication", {
    p_publication_id: publication.id,
    p_actor_id: context.user.id,
    p_actor_label: labelFor(context),
    p_actor_role: context.profile.role,
  });

  try {
    const expectedValues = queueItem.source_snapshot.master_values ?? {};
    const recipeIngredientIds = (queueItem.draft.proposed_recipe_links ?? []).map((entry) => text(entry.ingredient_id)).filter(Boolean);
    const applied = await productionRpc(context, "atlas_apply_item_master_update", {
      p_item_id: queueItem.item.id,
      p_values: queueItem.draft.proposed_values ?? {},
      p_recipe_ingredient_ids: recipeIngredientIds,
      p_expected_values: expectedValues,
      p_request_id: publicationRequestId,
    });

    publication = await branchRpc("atlas_item_master_complete_publication", {
      p_publication_id: publication.id,
      p_status: "published",
      p_applied_values: applied?.applied_values ?? queueItem.draft.proposed_values ?? {},
      p_failure_message: null,
      p_actor_id: context.user.id,
      p_actor_label: labelFor(context),
      p_actor_role: context.profile.role,
    });
    const refreshed = await buildWorkspace(context);
    return {
      ...refreshed.workspace,
      publication,
      message: `${queueItem.item.name} master data was published. No quantity or movement was changed.`,
    };
  } catch (error) {
    try {
      await branchRpc("atlas_item_master_complete_publication", {
        p_publication_id: publication.id,
        p_status: "failed",
        p_applied_values: {},
        p_failure_message: error instanceof Error ? error.message : "Publication failed",
        p_actor_id: context.user.id,
        p_actor_label: labelFor(context),
        p_actor_role: context.profile.role,
      });
    } catch (recordingError) {
      console.error("Checkpoint L2 could not record publication failure", recordingError);
    }
    throw error;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireManager(request);
    const url = new URL(request.url);
    const actionFromUrl = lower(url.searchParams.get("action")) || "snapshot";

    if (request.method === "GET") {
      if (actionFromUrl === "item_dependencies" || actionFromUrl === "item-dependencies") {
        const dependencies = await branchRpc("atlas_inventory_item_dependencies", {
          p_item_id: activationItemId(url.searchParams.get("item_id")),
          p_actor_id: context.user.id,
        });
        return jsonResponse({
          dependencies,
          manager: { id: context.user.id, label: labelFor(context), role: context.profile.role },
        });
      }
      if (actionFromUrl === "catalog-queue" || actionFromUrl === "catalog_queue") {
        const queue = await branchRpc("atlas_catalog_queue", {
          ...catalogQueueQuery(url.searchParams),
          p_actor_id: context.user.id,
        });
        return jsonResponse({ queue, stock_changed: false, manager: { id: context.user.id, label: labelFor(context), role: context.profile.role } });
      }
      if (actionFromUrl !== "snapshot") throw new ApiError(404, "Unknown Checkpoint L2 action.");
      const built = await buildWorkspace(context);
      return jsonResponse({
        ...built.workspace,
        manager: { id: context.user.id, label: labelFor(context), role: context.profile.role },
      });
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await request.json().catch(() => ({}));
    const action = lower(body.action) || actionFromUrl;
    if (action === "save_draft") {
      const result = await saveDraft(context, body);
      return jsonResponse({
        ...result,
        manager: { id: context.user.id, label: labelFor(context), role: context.profile.role },
      });
    }
    if (action === "set_item_active" || action === "set-item-active") {
      const result = await branchRpc("atlas_set_inventory_item_active", {
        ...activationRequest(body),
        p_actor_id: context.user.id,
        p_actor_label: labelFor(context),
      });
      return jsonResponse({
        result,
        manager: { id: context.user.id, label: labelFor(context), role: context.profile.role },
      });
    }
    if (action === "create-item" || action === "create_item") {
      const result = await branchRpc("atlas_catalog_create_item", {
        ...createItemRequest(body),
        p_actor_id: context.user.id,
        p_actor_label: labelFor(context),
      });
      return jsonResponse({
        result,
        stock_changed: false,
        manager: { id: context.user.id, label: labelFor(context), role: context.profile.role },
      }, result?.replayed ? 200 : 201);
    }
    if (action === "find-duplicates" || action === "find_duplicates") {
      const duplicates = await branchRpc("atlas_catalog_find_duplicates", {
        ...findDuplicatesRequest(body),
        p_actor_id: context.user.id,
      });
      return jsonResponse({ duplicates, stock_changed: false });
    }
    if (action === "catalog-request" || action === "catalog_request") {
      const request = await branchRpc("atlas_catalog_request_create", {
        ...catalogCreateRequest(body),
        p_actor_id: context.user.id,
        p_actor_label: labelFor(context),
      });
      return jsonResponse({ request, stock_changed: false }, 201);
    }
    if (action === "catalog-decide" || action === "catalog_decide") {
      const request = await branchRpc("atlas_catalog_request_decide", {
        ...catalogDecideRequest(body),
        p_actor_id: context.user.id,
        p_actor_label: labelFor(context),
      });
      let brainDecision = null;
      if (shouldRecordAiDecision(request)) {
        // Best effort: the catalogue decision stands even if the Brain write fails.
        brainDecision = await branchRpc("atlas_catalog_record_ai_decision", {
          p_change_request_id: request.id,
          p_actor_id: context.user.id,
          p_actor_label: labelFor(context),
        }).catch(() => ({ recorded: false, reason: "unavailable" }));
      }
      return jsonResponse({ request, brain_decision: brainDecision, stock_changed: false });
    }
    if (action === "catalog-withdraw" || action === "catalog_withdraw") {
      const request = await branchRpc("atlas_catalog_request_withdraw", {
        p_id: catalogUuid(body.id ?? body.change_request_id, "Change request"),
        p_actor_id: context.user.id,
        p_actor_label: labelFor(context),
      });
      return jsonResponse({ request, stock_changed: false });
    }
    if (action === "catalog-backfill" || action === "catalog_backfill") {
      const limit = body.limit === undefined ? 100 : Number(body.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new ApiError(400, "Limit must be between 1 and 500.", "invalid_request");
      }
      const proposals = await branchRpc("atlas_catalog_propose_backfill", {
        p_limit: limit,
        p_actor_id: context.user.id,
        p_actor_label: labelFor(context),
      });
      return jsonResponse({ proposals, stock_changed: false });
    }
    if (action === "publish") {
      const result = await publishDraft(context, body);
      return jsonResponse({
        ...result,
        manager: { id: context.user.id, label: labelFor(context), role: context.profile.role },
      });
    }
    throw new ApiError(404, "Unknown Checkpoint L2 action.");
  } catch (error) {
    if (error instanceof ApiError) {
      const payload = error.code ? { error: error.message, code: error.code } : { error: error.message };
      if (error.details) payload.duplicate_check = error.details;
      return jsonResponse(payload, error.status);
    }
    console.error("Checkpoint L2 item-master error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "Checkpoint L2 is temporarily unavailable." }, 500);
  }
});
