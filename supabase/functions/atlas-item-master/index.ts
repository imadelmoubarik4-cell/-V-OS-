import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";
const FUNCTION_VERSION = "0.1.0";
const MAX_ROWS = 5000;
const HISTORICAL_OPENING_CUTOFF = "2026-07-31";
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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

function dateValue(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeName(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeCode(value) {
  return lower(value).replace(/[^a-z0-9]/g, "");
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
      const message = parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.message
        ? String(parsed.message)
        : `${table} returned ${response.status}`;
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
      error: error instanceof Error ? error.message : `${table} could not be read`,
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
    "active", "source_file", "source_updated_at", "updated_at",
  ].join(",");
  const legacySelect = [
    "id", "name", "category", "quantity", "unit", "par_level", "supplier_id",
    "supplier", "units_per_case", "size_ml", "package_size", "cost_price", "case_cost",
    "bin_location", "sku", "barcode", "active", "source_file", "source_updated_at",
    "updated_at",
  ].join(",");

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
    const message = parsed && typeof parsed === "object" && parsed.message
      ? String(parsed.message)
      : typeof parsed === "string" && parsed
      ? parsed
      : `Checkpoint L2 database request ${name} failed.`;
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

function masterValues(item) {
  const values = {};
  for (const field of MASTER_FIELDS) values[field] = item[field] ?? null;
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
    master_fingerprint: stableHash(values),
  };
}

function isImportantServiceCategory(category) {
  const normalized = lower(category);
  return SERVICE_CATEGORY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function quantityTrustState(item, countActivity) {
  const now = Date.now();
  if (countActivity?.verification_status === "current") {
    const expires = dateValue(countActivity.expires_at);
    if (!expires || expires.getTime() > now) return "current";
  }
  if (countActivity?.verified_at) return "stale";
  if (text(item.source_updated_at) && text(item.source_updated_at) <= HISTORICAL_OPENING_CUTOFF) return "historical";
  return "unverified";
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
  const quantityStatus = quantityTrustState(item, countActivity);
  const historicalZero = quantityStatus === "historical" && numberValue(item.quantity) <= 0;
  const belowPar = nullableNumber(effective.par_level) !== null
    && numberValue(item.quantity) <= numberValue(effective.par_level);
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
    priorityReasons.push("Current quantity is at or below configured par");
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
    verified_quantity: countActivity?.verified_quantity ?? null,
    verified_at: countActivity?.verified_at ?? null,
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
  if (leadTime !== null) values.lead_time_days = leadTime;
  if (minimumOrder !== null) values.minimum_order_quantity = minimumOrder;
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
    const message = parsed && typeof parsed === "object" && parsed.message
      ? String(parsed.message)
      : typeof parsed === "string" && parsed
      ? parsed
      : `Production item-master publication failed (${response.status}).`;
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
    if (action === "publish") {
      const result = await publishDraft(context, body);
      return jsonResponse({
        ...result,
        manager: { id: context.user.id, label: labelFor(context), role: context.profile.role },
      });
    }
    throw new ApiError(404, "Unknown Checkpoint L2 action.");
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Checkpoint L2 item-master error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "Checkpoint L2 is temporarily unavailable." }, 500);
  }
});
