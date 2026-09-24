// Atlas AI data access adapters.
//
// Every read and write a tool performs goes through here, with the verified
// actor from the server context (never from tool arguments):
//
// - `rest` / `userRpc`: PostgREST with the caller's own JWT, so RLS and the
//   database role checks decide (inventory_items, recipes, suppliers,
//   purchase_orders and cost are manager-only there; staff read the
//   redacted catalog views).
// - `serviceRpc`: the service-role RPCs the Atlas gateways call. Those RPCs
//   trust `p_actor_id`/`p_actor_role`, so each call re-applies the owning
//   gateway's role gate here before sending the verified actor.
// - `callFunction`: an existing Atlas Edge Function over HTTP with the
//   caller's JWT, reusing that gateway's validation, role checks and
//   response shaping (writes, and reads whose shaping lives in the gateway).
//
// Plain ESM; `fetch` and `env` are injected so Node tests run it against an
// in-memory fake backend.

import { projectStock } from "../atlas-domain.mjs";
import { buildStockReport } from "../stock-provenance.mjs";
import { ATLAS_ROLES, MANAGER_ROLES, WRITE_ROLES } from "../auth.mjs";

export { ATLAS_ROLES, MANAGER_ROLES, WRITE_ROLES };

export class ServiceError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
  }
}

function envValue(env, name) {
  if (!env) return undefined;
  if (typeof env.get === "function") return env.get(name) ?? undefined;
  return env[name] ?? undefined;
}

function trimUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

export function serviceConfig(env) {
  const serviceUrl = trimUrl(envValue(env, "SUPABASE_URL"));
  const authUrl = trimUrl(envValue(env, "ATLAS_AUTH_PROJECT_URL") ?? serviceUrl);
  let publishableKey = String(envValue(env, "ATLAS_AUTH_PUBLISHABLE_KEY") ?? "").trim();
  if (!publishableKey) {
    try {
      publishableKey = String(JSON.parse(envValue(env, "SUPABASE_PUBLISHABLE_KEYS") ?? "{}")?.default ?? "").trim();
    } catch {
      publishableKey = "";
    }
  }
  return {
    serviceUrl,
    authUrl,
    publishableKey,
    serviceKey: String(envValue(env, "SUPABASE_SERVICE_ROLE_KEY") ?? "").trim(),
    functionsUrl: trimUrl(envValue(env, "ATLAS_FUNCTIONS_URL") ?? (serviceUrl ? `${serviceUrl}/functions/v1` : "")),
  };
}

const MAX_ROWS = 5000;

// Columns read per relation. Staff relations carry no cost or supplier data.
const INVENTORY_MANAGER_FIELDS = [
  "id", "name", "category", "quantity", "unit", "par_level", "updated_at", "source_updated_at", "source_type",
  "source_confidence", "source_confirmed_at", "source_confirmed_quantity", "supplier_id", "supplier", "cost_price",
  "sku", "barcode", "bin_location", "size_ml", "active", "sell_price", "package_size", "brand", "subcategory",
  "needs_review", "units_per_case",
].join(",");
const INVENTORY_STAFF_FIELDS = [
  "id", "name", "category", "quantity", "unit", "par_level", "sku", "barcode", "bin_location", "units_per_case",
  "size_ml", "active", "sell_price", "package_size", "brand", "subcategory", "needs_review", "updated_at",
  "owner_confirmed_quantity", "owner_confirmed_at",
].join(",");
const MOVEMENT_MANAGER_FIELDS = "id,item_id,item_name,movement_type,quantity_change,unit_cost,total_cost,supplier_id,note,created_at";
const MOVEMENT_STAFF_FIELDS = "id,item_id,item_name,movement_type,quantity_change,note,created_at";
const RECIPE_MANAGER_FIELDS = "id,name,type,method,yield_quantity,yield_unit,menu_price,show_on_menu,active,category_id,happy_hour_price,glass_price,bottle_price,updated_at,recipe_ingredients(id,recipe_id,item_id,item_name,quantity,unit)";
const RECIPE_STAFF_FIELDS = "id,name,type,method,yield_quantity,yield_unit,menu_price,show_on_menu,active,category_id,updated_at,recipe_ingredients";
const PURCHASE_ORDER_FIELDS = "id,supplier_id,lines,note,status,version,expected_delivery_date,created_at,updated_at,ordered_at,received_at,submitted_at,approved_at";
const SUPPLIER_FIELDS = "id,name,contact_name,email,phone,active,created_at,updated_at";

function splitSelect(select) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of String(select || "*")) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// "column inventory_items.brand does not exist" / "Could not find the 'brand' column".
function missingColumn(message) {
  const patterns = [
    /Could not find the ['"]([^'"]+)['"] column/i,
    /column\s+(?:["']?[a-z0-9_]+["']?\.)?["']?([a-z_][a-z0-9_]*)["']?\s+does not exist/i,
  ];
  for (const pattern of patterns) {
    const match = String(message || "").match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function readBody(response) {
  const textBody = await response.text();
  if (!textBody) return null;
  try {
    return JSON.parse(textBody);
  } catch {
    return textBody;
  }
}

function errorFrom(status, body, fallback) {
  const message = body && typeof body === "object"
    ? String(body.message || body.error || body.details || fallback)
    : typeof body === "string" && body ? body.slice(0, 300) : fallback;
  const pgCode = body && typeof body === "object" ? String(body.code || "") : "";
  let mapped = status;
  if (pgCode === "42501" || /^forbidden:/i.test(message)) mapped = 403;
  else if (pgCode === "P0002" || /^not_found:/i.test(message)) mapped = 404;
  else if (pgCode === "22023" || /^invalid_arguments:/i.test(message)) mapped = 400;
  else if (pgCode === "55000" || /^conflict:/i.test(message)) mapped = 409;
  return new ServiceError(mapped, message.replace(/^(forbidden|not_found|invalid_arguments|conflict):\s*/i, ""), pgCode || null);
}

// Creates the adapter set for one verified actor. `actor` = { userId, role,
// active, label, token } from `_shared/auth.mjs resolveActor`.
export function createServices({ fetch: fetchImpl = globalThis.fetch, env, actor, now = Date.now() } = {}) {
  if (!actor || typeof actor !== "object") throw new ServiceError(401, "A verified Atlas actor is required.");
  const config = serviceConfig(env);
  const manager = actor.active === true && MANAGER_ROLES.includes(actor.role);
  const memo = new Map();

  function once(key, loader) {
    if (!memo.has(key)) {
      const promise = Promise.resolve().then(loader);
      promise.catch(() => memo.delete(key));
      memo.set(key, promise);
    }
    return memo.get(key);
  }

  async function send(url, init, label) {
    if (typeof fetchImpl !== "function") throw new ServiceError(500, "Atlas data access is not configured.");
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      throw new ServiceError(503, `${label} is unavailable right now.`);
    }
    const body = await readBody(response);
    if (!response.ok) throw errorFrom(response.status, body, `${label} failed.`);
    return body;
  }

  function userHeaders(extra = {}) {
    if (!config.authUrl || !config.publishableKey) throw new ServiceError(500, "Atlas data access is not configured.");
    if (!actor.token) throw new ServiceError(401, "A valid Atlas session is required.");
    return {
      apikey: config.publishableKey,
      authorization: `Bearer ${actor.token}`,
      accept: "application/json",
      "cache-control": "no-store",
      ...extra,
    };
  }

  // PostgREST read with the caller's JWT (RLS applies). Like the existing
  // gateways, a column the production schema does not have yet is dropped
  // from the projection and the read retried, so a schema lag degrades to a
  // missing field (reported as unknown) instead of a failed answer.
  async function rest(table, { select = "*", filters = {}, order = null, limit = MAX_ROWS } = {}) {
    let fields = splitSelect(select);
    for (let attempt = 0; ; attempt += 1) {
      const url = new URL(`${config.authUrl}/rest/v1/${table}`);
      url.searchParams.set("select", fields.join(","));
      if (order) url.searchParams.set("order", order);
      url.searchParams.set("limit", String(Math.min(MAX_ROWS, Math.max(1, limit))));
      for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
      try {
        const rows = await send(url.toString(), { method: "GET", headers: userHeaders() }, `Reading ${table}`);
        return Array.isArray(rows) ? rows : [];
      } catch (error) {
        const column = error instanceof ServiceError && error.status === 400 ? missingColumn(error.message) : null;
        if (!column || attempt >= 8 || !fields.includes(column)) throw error;
        fields = fields.filter((field) => field !== column);
      }
    }
  }

  // PostgREST RPC with the caller's JWT; the database checks the role.
  async function userRpc(name, args = {}) {
    return send(`${config.authUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: userHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(args),
    }, name);
  }

  // Service-role RPC with the verified actor. `roles` is the owning
  // gateway's role gate, re-applied here; it is required.
  async function serviceRpc(name, args = {}, roles) {
    if (!Array.isArray(roles) || !roles.length) throw new ServiceError(500, `${name} has no role gate.`);
    if (actor.active !== true || !roles.includes(actor.role)) {
      throw new ServiceError(403, "This information is not available for your Atlas role.");
    }
    if (!config.serviceUrl || !config.serviceKey) throw new ServiceError(500, "Atlas data access is not configured.");
    return send(`${config.serviceUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: config.serviceKey,
        authorization: `Bearer ${config.serviceKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify(args),
    }, name);
  }

  // An existing Atlas Edge Function with the caller's JWT.
  async function callFunction(name, { method = "GET", action = null, params = {}, body = null } = {}) {
    if (!config.functionsUrl) throw new ServiceError(500, "Atlas functions are not configured.");
    const url = new URL(`${config.functionsUrl}/${name}`);
    if (action) url.searchParams.set("action", action);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    const init = { method, headers: userHeaders(body ? { "content-type": "application/json" } : {}) };
    if (body) init.body = JSON.stringify(body);
    return send(url.toString(), init, name);
  }

  const actorArgs = () => ({ p_actor_id: actor.userId, p_actor_role: actor.role });
  const actorLabelArgs = () => ({ ...actorArgs(), p_actor_label: actor.label || actor.displayName || "Atlas team member" });

  function requireManager() {
    if (!manager) throw new ServiceError(403, "This information is available to managers only.");
  }

  const services = {
    actor,
    isManager: manager,
    now,
    transport: { rest, userRpc, serviceRpc, callFunction },

    // ---- Inventory ------------------------------------------------------
    // Every item, inactive included (recipes recognise inactive references).
    inventory() {
      return once("inventory", () => manager
        ? rest("inventory_items", { select: INVENTORY_MANAGER_FIELDS, order: "name.asc" })
        : rest("inventory_catalog", { select: INVENTORY_STAFF_FIELDS, order: "name.asc" }));
    },
    verifiedBalances() {
      return once("balances", async () => {
        const rows = await serviceRpc("atlas_stock_count_verified_balances", {}, ATLAS_ROLES);
        return Array.isArray(rows) ? rows : [];
      });
    },
    movements() {
      return once("movements", () => manager
        ? rest("inventory_movements", { select: MOVEMENT_MANAGER_FIELDS, order: "created_at.desc" })
        : rest("inventory_movement_catalog", { select: MOVEMENT_STAFF_FIELDS, order: "created_at.desc" }));
    },
    // Canonical projection: _shared/atlas-domain projectStock (unknown = null).
    async projectedItems() {
      const [items, balances, movements] = await Promise.all([services.inventory(), services.verifiedBalances(), services.movements()]);
      return projectStock(items, balances, movements, now);
    },
    // Canonical report rows: _shared/stock-provenance buildStockReport.
    async stockReport(filters = {}) {
      const [items, balances, movements] = await Promise.all([services.inventory(), services.verifiedBalances(), services.movements()]);
      return buildStockReport(items, balances, filters, now, movements);
    },
    scannerLookup(code) {
      return callFunction("atlas-inventory-scanner", { action: "lookup", params: { code } });
    },

    // ---- Recipes --------------------------------------------------------
    recipes() {
      return once("recipes", async () => {
        const rows = manager
          ? await rest("recipes", { select: RECIPE_MANAGER_FIELDS, order: "name.asc" })
          : await rest("recipe_catalog", { select: RECIPE_STAFF_FIELDS, order: "name.asc" });
        return rows.map((recipe) => ({
          ...recipe,
          recipe_ingredients: Array.isArray(recipe.recipe_ingredients) ? recipe.recipe_ingredients : [],
        }));
      });
    },

    // ---- Purchasing (manager-only by RLS) --------------------------------
    suppliers() {
      requireManager();
      return once("suppliers", () => rest("suppliers", { select: SUPPLIER_FIELDS, order: "name.asc" }));
    },
    purchaseOrders() {
      requireManager();
      return once("purchase_orders", () => rest("purchase_orders", { select: PURCHASE_ORDER_FIELDS, order: "created_at.desc", limit: 500 }));
    },
    purchaseOrderDetail(id) {
      requireManager();
      return userRpc("atlas_purchase_order_detail", { p_id: id });
    },
    purchaseOrderPolicy() {
      requireManager();
      return once("po_policy", () => userRpc("atlas_purchase_order_policy", {}));
    },
    purchaseOrderCommand(args) {
      requireManager();
      return userRpc("atlas_purchase_order_command_v2", {
        p_id: args.p_id,
        p_action: args.p_action,
        p_version: args.p_version ?? null,
        p_supplier_id: args.p_supplier_id ?? null,
        p_lines: args.p_lines ?? null,
        p_note: args.p_note ?? null,
        p_expected_delivery_date: args.p_expected_delivery_date ?? null,
        p_receipt: args.p_receipt ?? null,
        p_request_id: args.p_request_id ?? null,
        p_reason: args.p_reason ?? null,
      });
    },

    // ---- Venue clock and operations ----------------------------------------
    venueClock() {
      return once("venue_clock", () => serviceRpc("atlas_settings_venue_clock", { p_actor_role: actor.role }, ATLAS_ROLES));
    },
    operationsToday(localDate) {
      return once(`ops:${localDate}`, () => serviceRpc("atlas_operations_today", { p_local_date: localDate }, ATLAS_ROLES));
    },
    dailyChecklists(businessDate = null) {
      return once(`checklists:${businessDate}`, () => serviceRpc("atlas_operations_daily_checklists", { p_business_date: businessDate }, ATLAS_ROLES));
    },

    // ---- Shifts and team -------------------------------------------------
    shiftsSnapshot(weekStart) {
      return once(`shifts:${weekStart}`, () => serviceRpc("atlas_shifts_snapshot", { p_week_start: weekStart, ...actorArgs() }, ATLAS_ROLES));
    },
    teamProfiles() {
      return once("team_profiles", () => callFunction("atlas-team-profiles", { action: "snapshot" }));
    },

    // ---- Knowledge -------------------------------------------------------
    knowledgeSearch(query, limit) {
      return serviceRpc("atlas_knowledge_search", { p_query: query, ...actorArgs(), p_limit: limit }, ATLAS_ROLES);
    },
    knowledgeDetail(articleId) {
      // Staff never receive drafts; the SQL also enforces visibility by role.
      return serviceRpc("atlas_knowledge_article_detail", { p_article_id: articleId, ...actorArgs(), p_prefer_draft: false }, ATLAS_ROLES);
    },
    knowledgeSnapshot() {
      return once("knowledge_snapshot", () => callFunction("atlas-knowledge", { action: "snapshot" }));
    },

    // ---- Settings, decisions, data quality, marketing, integrations -------
    settingsSnapshot() {
      return once("settings_snapshot", () => callFunction("atlas-settings", { action: "snapshot" }));
    },
    memorySearch(query, limit) {
      return serviceRpc("atlas_ai_memory_search", { p_query: query, p_limit: limit, ...actorArgs() }, MANAGER_ROLES);
    },
    phase3Memory(subjectType, subjectKey, limit) {
      return serviceRpc("atlas_phase3_memory_search", { p_subject_type: subjectType, p_subject_key: subjectKey, p_limit: limit }, MANAGER_ROLES);
    },
    dataReviewSummary() {
      requireManager();
      return once("data_review", () => userRpc("atlas_data_review_summary", {}));
    },
    dataReviewRows(issue, limit, offset) {
      requireManager();
      return userRpc("atlas_data_review_rows", { p_issue: issue, p_limit: limit, p_offset: offset });
    },
    parLevelEvidence(itemIds, coverDays) {
      requireManager();
      return userRpc("atlas_par_level_evidence", { p_item_ids: itemIds, p_cover_days: coverDays });
    },
    marketingRecommendations(localDate) {
      return serviceRpc("atlas_marketing_recommendations", { p_local_date: localDate }, ATLAS_ROLES);
    },
    integrationsStatus() {
      requireManager();
      return callFunction("atlas-integrations", { action: "status" });
    },

    // ---- Writes used only by actions.mjs after human approval -------------
    stockCountStart(body) {
      return callFunction("atlas-stock-counts", { method: "POST", action: "start", body });
    },
    stockCountSaveLine(body) {
      return callFunction("atlas-stock-counts", { method: "POST", action: "save-line", body });
    },
    shiftSave(body) {
      return callFunction("atlas-shifts", { method: "POST", action: "save-shift", body });
    },
    teamMessageSend(body) {
      return callFunction("atlas-team-messages", { method: "POST", action: "send", body });
    },
    knowledgeSaveDraft(body) {
      return callFunction("atlas-knowledge", { method: "POST", action: "save-draft", body });
    },
  };
  services.actorLabelArgs = actorLabelArgs;
  return services;
}
