import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";
const FUNCTION_VERSION = "0.1.0";
const HISTORICAL_OPENING_CUTOFF = "2026-07-26";
const MAX_ROWS = 5000;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

const EXPLICIT_WASTE_TYPES = new Set([
  "waste", "wastage", "expired", "expiry", "spoilage", "breakage", "spill", "spillage",
]);
const MANAGER_ROLES = new Set(["admin", "manager"]);

type JsonObject = Record<string, unknown>;
type SourceResult = {
  table: string;
  status: "connected" | "no_records" | "degraded";
  rows: JsonObject[];
  error: string | null;
  observedAt: string | null;
};
type ManagerContext = {
  token: string;
  user: { id: string; email?: string | null };
  profile: { id: string; email?: string | null; display_name?: string | null; role: string; active: boolean };
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
      "x-atlas-intelligence-version": FUNCTION_VERSION,
    },
  });
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.");
  return match[1];
}

function labelFor(context: ManagerContext): string {
  return context.profile.display_name?.trim()
    || context.profile.email?.trim()
    || context.user.email?.trim()
    || context.user.id;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function lower(value: unknown): string {
  return text(value).toLowerCase();
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(value: unknown): Date | null {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function latestIso(values: unknown[]): string | null {
  let latest = 0;
  for (const value of values) {
    const date = dateValue(value);
    if (date && date.getTime() > latest) latest = date.getTime();
  }
  return latest ? new Date(latest).toISOString() : null;
}

function historicalOpeningRow(item: JsonObject): boolean {
  const sourceDate = text(item.source_updated_at);
  return Boolean(sourceDate && sourceDate <= HISTORICAL_OPENING_CUTOFF);
}

function packageGrams(item: JsonObject): number | null {
  const raw = lower(item.package_size);
  const match = raw.match(/([0-9]+(?:[.,][0-9]+)?)\s*(kg|g|gr|gram|grams)\b/);
  if (!match) return null;
  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return match[2] === "kg" ? amount * 1000 : amount;
}

function sameEachUnit(ingredientUnit: string, itemUnit: string): boolean {
  const each = new Set(["each", "unit", "units", "bottle", "bottles", "can", "cans", "piece", "pieces"]);
  return each.has(ingredientUnit) && each.has(itemUnit);
}

function ingredientCostAndAvailability(ingredient: JsonObject, item: JsonObject | undefined) {
  if (!item) return { cost: null, servings: null, reason: "linked inventory item is missing" };
  if (historicalOpeningRow(item)) {
    return { cost: null, servings: null, reason: "linked quantity belongs to the historical July opening snapshot" };
  }

  const quantityNeeded = numberValue(ingredient.quantity);
  const ingredientUnit = lower(ingredient.unit);
  const itemUnit = lower(item.unit);
  const inventoryQuantity = numberValue(item.quantity);
  const costPrice = nullableNumber(item.cost_price);
  if (quantityNeeded <= 0) return { cost: null, servings: null, reason: "ingredient quantity is invalid" };

  if (ingredientUnit === "ml") {
    const sizeMl = nullableNumber(item.size_ml);
    if (!sizeMl || sizeMl <= 0) return { cost: null, servings: null, reason: "verified bottle size is missing" };
    return {
      cost: costPrice === null ? null : (quantityNeeded / sizeMl) * costPrice,
      servings: Math.floor((inventoryQuantity * sizeMl) / quantityNeeded),
      reason: costPrice === null ? "current cost is missing" : null,
    };
  }

  if (ingredientUnit === "g" || ingredientUnit === "gram" || ingredientUnit === "grams") {
    const grams = packageGrams(item);
    if (!grams) return { cost: null, servings: null, reason: "verified package weight is missing" };
    return {
      cost: costPrice === null ? null : (quantityNeeded / grams) * costPrice,
      servings: Math.floor((inventoryQuantity * grams) / quantityNeeded),
      reason: costPrice === null ? "current cost is missing" : null,
    };
  }

  if (sameEachUnit(ingredientUnit, itemUnit)) {
    return {
      cost: costPrice === null ? null : quantityNeeded * costPrice,
      servings: Math.floor(inventoryQuantity / quantityNeeded),
      reason: costPrice === null ? "current cost is missing" : null,
    };
  }

  return { cost: null, servings: null, reason: `unit ${ingredientUnit || "unknown"} is not safely compatible with ${itemUnit || "unknown"}` };
}

async function requireManager(request: Request): Promise<ManagerContext> {
  const token = bearerToken(request);
  const headers = {
    apikey: AUTH_PUBLISHABLE_KEY,
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "cache-control": "no-store",
  };

  const userResponse = await fetch(`${AUTH_PROJECT_URL}/auth/v1/user`, { headers });
  if (!userResponse.ok) throw new ApiError(401, "Your Atlas session has expired.");
  const user = await userResponse.json() as { id?: string; email?: string | null };
  if (!user.id) throw new ApiError(401, "Your Atlas account could not be verified.");

  const profileUrl = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  profileUrl.searchParams.set("id", `eq.${user.id}`);
  profileUrl.searchParams.set("select", "id,email,display_name,role,active");
  profileUrl.searchParams.set("limit", "1");
  const profileResponse = await fetch(profileUrl, { headers });
  if (!profileResponse.ok) throw new ApiError(403, "Your Atlas role could not be verified.");
  const profiles = await profileResponse.json() as Array<ManagerContext["profile"]>;
  const profile = profiles[0];
  if (!profile?.active) throw new ApiError(403, "This Atlas profile is inactive.");
  if (!MANAGER_ROLES.has(profile.role)) {
    throw new ApiError(403, "Checkpoint K is limited to managers and administrators.");
  }
  return { token, user: { id: user.id, email: user.email }, profile };
}

async function productionRows(
  context: ManagerContext,
  table: string,
  select: string,
  orderColumn: string,
): Promise<SourceResult> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  url.searchParams.set("order", `${orderColumn}.desc.nullslast`);
  url.searchParams.set("limit", String(MAX_ROWS));
  try {
    const response = await fetch(url, {
      headers: {
        apikey: AUTH_PUBLISHABLE_KEY,
        authorization: `Bearer ${context.token}`,
        accept: "application/json",
        "cache-control": "no-store",
        range: `0-${MAX_ROWS - 1}`,
      },
    });
    const body = await response.text();
    let parsed: unknown = [];
    try { parsed = body ? JSON.parse(body) : []; } catch { parsed = []; }
    if (!response.ok) {
      const message = parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : `${table} source returned ${response.status}`;
      return { table, status: "degraded", rows: [], error: message, observedAt: null };
    }
    const rows = Array.isArray(parsed)
      ? parsed.filter((row): row is JsonObject => Boolean(row) && typeof row === "object" && !Array.isArray(row))
      : [];
    return {
      table,
      status: rows.length ? "connected" : "no_records",
      rows,
      error: null,
      observedAt: latestIso(rows.flatMap((row) => [row.updated_at, row.created_at, row.source_updated_at])),
    };
  } catch (error) {
    return {
      table,
      status: "degraded",
      rows: [],
      error: error instanceof Error ? error.message : `${table} source failed`,
      observedAt: null,
    };
  }
}

async function branchRpc(name: string, payload: JsonObject = {}): Promise<any> {
  const branchUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!branchUrl || !serviceRoleKey) throw new ApiError(500, "Checkpoint K branch credentials are unavailable.");
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
  let parsed: any = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "message" in parsed
      ? String(parsed.message)
      : typeof parsed === "string" && parsed
      ? parsed
      : `Checkpoint K database request ${name} failed.`;
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

function recommendation(input: JsonObject): JsonObject {
  return {
    alternatives: [],
    consequence_of_inaction: {},
    limitations: [],
    priority: 100,
    source_kind: "production_rest_snapshot",
    source_schema: "public",
    observed_at: new Date().toISOString(),
    ...input,
  };
}

function createIntelligence(
  settings: JsonObject,
  inventorySource: SourceResult,
  movementSource: SourceResult,
  recipeSource: SourceResult,
  ingredientSource: SourceResult,
  supplierSource: SourceResult,
) {
  const inventory = inventorySource.rows.filter((item) => item.active !== false);
  const movements = movementSource.rows;
  const recipes = recipeSource.rows.filter((recipe) => recipe.active !== false);
  const ingredients = ingredientSource.rows;
  const suppliers = supplierSource.rows.filter((supplier) => supplier.active !== false);
  const inventoryById = new Map(inventory.map((item) => [text(item.id), item]));
  const supplierById = new Map(suppliers.map((supplier) => [text(supplier.id), supplier]));
  const ingredientsByRecipe = new Map<string, JsonObject[]>();
  for (const ingredient of ingredients) {
    const recipeId = text(ingredient.recipe_id);
    if (!ingredientsByRecipe.has(recipeId)) ingredientsByRecipe.set(recipeId, []);
    ingredientsByRecipe.get(recipeId)!.push(ingredient);
  }

  const historicalInventory = inventory.filter(historicalOpeningRow);
  const observedInventory = inventory.filter((item) => !historicalOpeningRow(item));
  const historicalZero = historicalInventory.filter((item) => numberValue(item.quantity) <= 0);
  const observedWithPar = observedInventory.filter((item) => nullableNumber(item.par_level) !== null && numberValue(item.par_level) > 0);
  const observedBelowPar = observedWithPar.filter((item) => numberValue(item.quantity) <= numberValue(item.par_level));
  const inventoryWithPar = inventory.filter((item) => nullableNumber(item.par_level) !== null && numberValue(item.par_level) > 0);
  const inventoryWithSupplier = inventory.filter((item) => text(item.supplier_id) || text(item.supplier));
  const inventoryWithCasePack = inventory.filter((item) => numberValue(item.units_per_case) > 0);
  const inventoryWithCost = inventory.filter((item) => nullableNumber(item.cost_price) !== null || nullableNumber(item.case_cost) !== null);

  const movementTypes = new Map<string, number>();
  for (const row of movements) {
    const type = lower(row.movement_type) || "unknown";
    movementTypes.set(type, (movementTypes.get(type) || 0) + 1);
  }
  const explicitWaste = movements.filter((row) => EXPLICIT_WASTE_TYPES.has(lower(row.movement_type)));
  const negativeAdjustments = movements.filter((row) => lower(row.movement_type) === "adjustment" && numberValue(row.quantity_change) < 0);

  const inventorySettings = (settings.inventory && typeof settings.inventory === "object")
    ? settings.inventory as JsonObject
    : {};
  const brainSettings = (settings.brain && typeof settings.brain === "object")
    ? settings.brain as JsonObject
    : {};
  const reorderSuggestionsEnabled = inventorySettings.automatic_reorder_suggestions !== false;
  const purchaseLearningEnabled = brainSettings.purchase_learning_enabled !== false;
  const menuLearningEnabled = brainSettings.menu_learning_enabled !== false;
  const wasteLearningEnabled = brainSettings.waste_learning_enabled !== false;

  const recommendations: JsonObject[] = [];

  for (const item of observedBelowPar.slice(0, 8)) {
    const quantity = numberValue(item.quantity);
    const par = numberValue(item.par_level);
    recommendations.push(recommendation({
      recommendation_key: `checkpoint-k:shortage:item:${text(item.id)}`,
      recommendation_type: "shortage",
      capability_key: "shortage_prediction",
      subject_type: "inventory_item",
      subject_key: text(item.id),
      title: quantity <= 0 ? `${text(item.name)} has no observed stock` : `${text(item.name)} is at or below par`,
      summary: `${quantity} ${text(item.unit) || "units"} observed against a configured par level of ${par}.`,
      explanation: "This is a deterministic par-level watch based on a non-historical inventory record. Atlas is not predicting a stockout date because validated demand, incoming deliveries and supplier lead times are not connected.",
      suggested_action: { kind: "open_inventory_item", target: "inventory", item_id: text(item.id), mode: "manager_review" },
      alternatives: [{ label: "Run a fresh stock count", target: "inventory-count" }],
      consequence_of_inaction: { risk: "The item may remain below the manager-configured service level." },
      confidence_state: "pending",
      confidence_score: 0.6,
      confidence_reason: "Quantity and par are present, but the record is not backed by a verified current stock count or demand history.",
      limitations: [
        "No validated product-level sales history is connected.",
        "No confirmed incoming delivery or supplier lead-time evidence is connected.",
        "This is a par watch, not a predicted shortage date.",
      ],
      priority: quantity <= 0 ? 12 : 18,
      source_object: "inventory_items",
      source_row_key: text(item.id),
      evidence_label: "Observed inventory versus configured par",
      evidence_value: { item_name: text(item.name), quantity, unit: text(item.unit), par_level: par, updated_at: item.updated_at, historical_opening_snapshot: false },
      observed_at: text(item.updated_at) || inventorySource.observedAt,
    }));
  }

  if (!observedWithPar.length) {
    recommendations.push(recommendation({
      recommendation_key: "checkpoint-k:shortage:verify-current-count",
      recommendation_type: "shortage",
      capability_key: "shortage_prediction",
      subject_type: "capability",
      subject_key: "shortage_prediction",
      title: "Complete a current stock count before shortage prediction",
      summary: `${historicalInventory.length} active inventory rows still originate from the July opening snapshot; ${historicalZero.length} of those rows show a zero balance that Atlas will not treat as current stock.`,
      explanation: "Atlas can identify historical balances and data gaps, but it deliberately refuses to convert the July snapshot into a current shortage prediction. A manager-verified count is the next evidence step.",
      suggested_action: { kind: "open_stock_count", target: "inventory-count", mode: "full_current_count" },
      alternatives: [{ label: "Verify priority service items first", target: "inventory" }],
      consequence_of_inaction: { risk: "Shortage dates and service-risk ordering remain evidence-gated." },
      confidence_state: "verified",
      confidence_score: 1,
      confidence_reason: "The source dates and coverage counts are read directly from the connected inventory records.",
      limitations: [
        "Historical July quantities are not current live stock.",
        "Zero historical balances are not treated as out-of-stock alerts.",
        "No forecast is generated without validated demand history.",
      ],
      priority: 11,
      source_object: "inventory_items",
      source_row_key: "historical-opening-coverage",
      evidence_label: "Current-stock readiness assessment",
      evidence_value: { active_rows: inventory.length, historical_rows: historicalInventory.length, historical_zero_rows: historicalZero.length, observed_rows_with_par: observedWithPar.length, cutoff_date: HISTORICAL_OPENING_CUTOFF },
      observed_at: inventorySource.observedAt,
    }));
  }

  const purchaseCandidates = reorderSuggestionsEnabled && purchaseLearningEnabled
    ? observedBelowPar.filter((item) => text(item.supplier_id) || text(item.supplier))
    : [];
  for (const item of purchaseCandidates.slice(0, 8)) {
    const quantity = numberValue(item.quantity);
    const par = numberValue(item.par_level);
    const shortfall = Math.max(0, par - quantity);
    const casePack = numberValue(item.units_per_case);
    const suggestedQuantity = casePack > 0 ? Math.ceil(shortfall / casePack) * casePack : Math.ceil(shortfall);
    if (suggestedQuantity <= 0) continue;
    const unitCost = nullableNumber(item.cost_price);
    const supplier = text(item.supplier)
      || text(supplierById.get(text(item.supplier_id))?.name)
      || "Supplier requires verification";
    recommendations.push(recommendation({
      recommendation_key: `checkpoint-k:purchase:item:${text(item.id)}`,
      recommendation_type: "purchase",
      capability_key: "purchase_recommendations",
      subject_type: "inventory_item",
      subject_key: text(item.id),
      title: `Review a replenishment draft for ${text(item.name)}`,
      summary: `A review-only draft would restore the item to par with ${suggestedQuantity} ${text(item.unit) || "units"}${casePack > 0 ? `, rounded to a ${casePack}-unit case` : ""}.`,
      explanation: "The quantity is derived only from the configured par shortfall and known case pack. It is not demand forecasting and Atlas cannot submit an order.",
      suggested_action: { kind: "review_purchase_draft", target: "purchasing", item_id: text(item.id), supplier, quantity: suggestedQuantity, automatic_submission: false },
      alternatives: [{ label: "Count the item again before drafting", target: "inventory-count" }],
      consequence_of_inaction: { risk: "The observed quantity remains below the configured par level." },
      confidence_state: "pending",
      confidence_score: casePack > 0 && unitCost !== null ? 0.65 : 0.5,
      confidence_reason: "The par shortfall is deterministic; supplier constraints, minimum order and lead time remain unverified.",
      limitations: [
        "No validated demand history or supplier lead time is connected.",
        "The recommendation restores only to par and does not optimize safety stock.",
        "A manager must verify package, contract and delivery constraints before ordering.",
      ],
      priority: 24,
      source_object: "inventory_items",
      source_row_key: text(item.id),
      evidence_label: "Par-restoration purchase draft",
      evidence_value: { item_name: text(item.name), quantity, par_level: par, shortfall, units_per_case: casePack || null, suggested_quantity: suggestedQuantity, supplier, estimated_cost_isk: unitCost === null ? null : unitCost * suggestedQuantity },
      observed_at: text(item.updated_at) || inventorySource.observedAt,
    }));
  }

  if (!purchaseCandidates.length) {
    recommendations.push(recommendation({
      recommendation_key: "checkpoint-k:purchase:complete-order-foundation",
      recommendation_type: "purchase",
      capability_key: "purchase_recommendations",
      subject_type: "capability",
      subject_key: "purchase_recommendations",
      title: "Complete purchasing fields before Atlas drafts replenishment",
      summary: `${inventory.length - inventoryWithPar.length} active items lack par levels, ${inventory.length - inventoryWithSupplier.length} lack a supplier, ${inventory.length - inventoryWithCasePack.length} lack case-pack data and ${inventory.length - inventoryWithCost.length} lack current cost evidence.`,
      explanation: "Atlas can only prepare a reviewable purchase draft when stock is current and the item has a par level and supplier. Package and cost evidence improve the draft but never authorize an order.",
      suggested_action: { kind: "open_inventory_data_review", target: "inventory", fields: ["par_level", "supplier", "units_per_case", "cost_price"] },
      alternatives: [{ label: "Configure the highest-priority service items first", target: "inventory" }],
      consequence_of_inaction: { risk: "Purchase recommendations remain data-readiness guidance only." },
      confidence_state: "verified",
      confidence_score: 1,
      confidence_reason: "Missing-field counts are calculated directly from active inventory records.",
      limitations: [
        "The July opening snapshot is not current stock.",
        "No supplier lead times, minimums or confirmed incoming deliveries are connected.",
        "Atlas never creates or sends a purchase order from this checkpoint.",
      ],
      priority: 21,
      source_object: "inventory_items",
      source_row_key: "purchase-readiness",
      evidence_label: "Purchase-data coverage",
      evidence_value: { active_items: inventory.length, missing_par: inventory.length - inventoryWithPar.length, missing_supplier: inventory.length - inventoryWithSupplier.length, missing_case_pack: inventory.length - inventoryWithCasePack.length, missing_cost: inventory.length - inventoryWithCost.length, historical_rows: historicalInventory.length, reorder_suggestions_enabled: reorderSuggestionsEnabled, purchase_learning_enabled: purchaseLearningEnabled },
      observed_at: inventorySource.observedAt,
    }));
  }

  let recipeCostReady = 0;
  let recipeAvailabilityReady = 0;
  let recipesWithSetupIssues = 0;
  for (const recipe of recipes.slice(0, 100)) {
    const recipeId = text(recipe.id);
    const recipeIngredients = ingredientsByRecipe.get(recipeId) || [];
    const unlinked = recipeIngredients.filter((ingredient) => !text(ingredient.item_id));
    const missingItems = recipeIngredients.filter((ingredient) => text(ingredient.item_id) && !inventoryById.has(text(ingredient.item_id)));
    const calculations = recipeIngredients
      .filter((ingredient) => text(ingredient.item_id))
      .map((ingredient) => ingredientCostAndAvailability(ingredient, inventoryById.get(text(ingredient.item_id))));
    const costReady = recipeIngredients.length > 0 && !unlinked.length && !missingItems.length && calculations.every((entry) => entry.cost !== null);
    const availabilityReady = recipeIngredients.length > 0 && !unlinked.length && !missingItems.length && calculations.every((entry) => entry.servings !== null);
    if (costReady) recipeCostReady += 1;
    if (availabilityReady) recipeAvailabilityReady += 1;

    const setupReasons: string[] = [];
    if (!recipeIngredients.length) setupReasons.push("no ingredient rows");
    if (unlinked.length) setupReasons.push(`${unlinked.length} ingredient${unlinked.length === 1 ? "" : "s"} not linked to inventory`);
    if (missingItems.length) setupReasons.push(`${missingItems.length} linked inventory item${missingItems.length === 1 ? " is" : "s are"} missing`);
    const calculationReasons = [...new Set(calculations.map((entry) => entry.reason).filter((value): value is string => Boolean(value)))];
    setupReasons.push(...calculationReasons);
    if (nullableNumber(recipe.menu_price) === null || numberValue(recipe.menu_price) <= 0) setupReasons.push("verified menu price is missing");

    if (setupReasons.length && menuLearningEnabled) {
      recipesWithSetupIssues += 1;
      recommendations.push(recommendation({
        recommendation_key: `checkpoint-k:menu:setup:${recipeId}`,
        recommendation_type: "menu",
        capability_key: "menu_recommendations",
        subject_type: "recipe",
        subject_key: recipeId,
        title: `Complete operational setup for ${text(recipe.name)}`,
        summary: setupReasons.slice(0, 3).join("; ") + (setupReasons.length > 3 ? "; additional evidence gaps remain." : "."),
        explanation: "Checkpoint K can evaluate recipe readiness, inventory links and calculable cost. It does not recommend changing the menu for performance because product-level sales history is not connected.",
        suggested_action: { kind: "open_recipe", target: "recipes", recipe_id: recipeId, mode: "complete_setup" },
        alternatives: [{ label: "Keep the recipe in review until evidence is complete", target: "recipes" }],
        consequence_of_inaction: { risk: "Availability, cost and margin guidance for this recipe remain incomplete." },
        confidence_state: "reviewed",
        confidence_score: 0.85,
        confidence_reason: "The setup gaps are counted directly from the recipe and ingredient links; performance conclusions are deliberately excluded.",
        limitations: [
          "No validated product-level sales history is connected.",
          "Historical July stock is not used to claim current servings available.",
          "Atlas does not change prices, menu visibility or recipe ingredients automatically.",
        ],
        priority: 30,
        source_object: "recipes+recipe_ingredients",
        source_row_key: recipeId,
        evidence_label: "Recipe operational-readiness evidence",
        evidence_value: { recipe_name: text(recipe.name), ingredient_rows: recipeIngredients.length, unlinked_ingredients: unlinked.length, missing_inventory_items: missingItems.length, menu_price_isk: nullableNumber(recipe.menu_price), cost_ready: costReady, availability_ready: availabilityReady, reasons: setupReasons },
        observed_at: text(recipe.updated_at) || recipeSource.observedAt,
      }));
    }
  }

  const wasteGroups = new Map<string, { itemId: string | null; itemName: string; events: number; quantity: number; cost: number; costedEvents: number; latest: string | null }>();
  for (const row of explicitWaste) {
    const key = text(row.item_id) || text(row.item_name) || "unknown";
    const group = wasteGroups.get(key) || { itemId: text(row.item_id) || null, itemName: text(row.item_name) || "Unknown item", events: 0, quantity: 0, cost: 0, costedEvents: 0, latest: null };
    const quantity = Math.abs(numberValue(row.quantity_change));
    const totalCost = nullableNumber(row.total_cost);
    const unitCost = nullableNumber(row.unit_cost);
    const calculatedCost = totalCost !== null ? Math.abs(totalCost) : unitCost !== null ? Math.abs(unitCost * quantity) : null;
    group.events += 1;
    group.quantity += quantity;
    if (calculatedCost !== null) { group.cost += calculatedCost; group.costedEvents += 1; }
    group.latest = latestIso([group.latest, row.created_at]);
    wasteGroups.set(key, group);
  }

  if (wasteLearningEnabled && wasteGroups.size) {
    const groups = [...wasteGroups.values()].sort((a, b) => b.cost - a.cost || b.quantity - a.quantity || b.events - a.events).slice(0, 8);
    for (const group of groups) {
      recommendations.push(recommendation({
        recommendation_key: `checkpoint-k:waste:item:${group.itemId || group.itemName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}`,
        recommendation_type: "waste",
        capability_key: "waste_identification",
        subject_type: "inventory_item",
        subject_key: group.itemId || group.itemName,
        title: `Review recorded waste for ${group.itemName}`,
        summary: `${group.events} explicit waste event${group.events === 1 ? "" : "s"} recorded ${group.quantity} units${group.costedEvents ? ` with an estimated recorded value of ${Math.round(group.cost).toLocaleString("en-US")} ISK` : ""}.`,
        explanation: "Atlas is summarising events explicitly labelled as waste, expiry, spoilage, breakage or spillage. It does not infer a cause, assign blame or reinterpret ordinary negative adjustments as waste.",
        suggested_action: { kind: "open_waste_history", target: "inventory-waste", item_id: group.itemId, mode: "manager_review" },
        alternatives: [{ label: "Review source movement records", target: "inventory-movements" }],
        consequence_of_inaction: { risk: "Repeated recorded waste may remain unreviewed." },
        confidence_state: group.events >= 3 ? "reviewed" : "pending",
        confidence_score: group.events >= 3 ? 0.75 : 0.55,
        confidence_reason: "Only explicitly labelled waste events are included; confidence rises with repeated records and cost coverage.",
        limitations: [
          "No cause is inferred from the event history.",
          "No employee attribution or misconduct conclusion is produced.",
          "Estimated value excludes events without cost evidence.",
        ],
        priority: 35,
        source_object: "inventory_movements",
        source_row_key: group.itemId || group.itemName,
        evidence_label: "Explicit waste-event aggregate",
        evidence_value: { item_name: group.itemName, event_count: group.events, recorded_quantity: group.quantity, costed_events: group.costedEvents, estimated_recorded_value_isk: group.costedEvents ? group.cost : null, latest_event_at: group.latest, negative_adjustments_excluded: negativeAdjustments.length },
        observed_at: group.latest || movementSource.observedAt,
      }));
    }
  } else {
    recommendations.push(recommendation({
      recommendation_key: "checkpoint-k:waste:record-explicit-events",
      recommendation_type: "waste",
      capability_key: "waste_identification",
      subject_type: "capability",
      subject_key: "waste_identification",
      title: "Record waste explicitly before Atlas identifies patterns",
      summary: `${movements.length} inventory movements are connected, but none are explicitly labelled as waste, expiry, spoilage, breakage or spillage. ${negativeAdjustments.length} negative adjustment records are deliberately excluded.`,
      explanation: "A negative adjustment can represent many things and is not reliable waste evidence. Checkpoint K requires an explicit waste reason before it creates item or category patterns.",
      suggested_action: { kind: "open_waste_log", target: "inventory-waste", mode: "explicit_reason_required" },
      alternatives: [{ label: "Review negative adjustments without reclassifying them", target: "inventory-movements" }],
      consequence_of_inaction: { risk: "Waste intelligence remains recording-readiness guidance rather than pattern detection." },
      confidence_state: "verified",
      confidence_score: 1,
      confidence_reason: "Movement types are counted directly and the exclusion rule is deterministic.",
      limitations: [
        "Negative adjustments are not treated as waste.",
        "No theft, negligence or staff-performance conclusion is generated.",
        "No waste value is estimated without explicit events and cost evidence.",
      ],
      priority: 31,
      source_object: "inventory_movements",
      source_row_key: "waste-recording-coverage",
      evidence_label: "Explicit waste-recording coverage",
      evidence_value: { total_movements: movements.length, movement_types: Object.fromEntries(movementTypes), explicit_waste_events: explicitWaste.length, negative_adjustments_excluded: negativeAdjustments.length },
      observed_at: movementSource.observedAt,
    }));
  }

  const sourceStatus = {
    inventory: { status: inventorySource.status, records: inventorySource.rows.length, error: inventorySource.error, observed_at: inventorySource.observedAt },
    movements: { status: movementSource.status, records: movementSource.rows.length, error: movementSource.error, observed_at: movementSource.observedAt },
    recipes: { status: recipeSource.status, records: recipeSource.rows.length, error: recipeSource.error, observed_at: recipeSource.observedAt },
    recipe_ingredients: { status: ingredientSource.status, records: ingredientSource.rows.length, error: ingredientSource.error, observed_at: ingredientSource.observedAt },
    suppliers: { status: supplierSource.status, records: supplierSource.rows.length, error: supplierSource.error, observed_at: supplierSource.observedAt },
  };

  const connections = [
    { connection_key: "current_stock", status: inventorySource.status === "degraded" ? "degraded" : inventory.length ? "pending_review" : "not_connected", last_verified_at: inventorySource.observedAt, metadata: { active_rows: inventory.length, historical_opening_rows: historicalInventory.length, non_historical_rows: observedInventory.length, verified_current_count: false } },
    { connection_key: "sales_history", status: "not_connected", last_verified_at: null, metadata: { reason: "No validated product-level sales source is connected." } },
    { connection_key: "confirmed_deliveries", status: "not_connected", last_verified_at: null, metadata: { reason: "Past restocks are not confirmed incoming deliveries." } },
    { connection_key: "supplier_lead_times", status: "not_connected", last_verified_at: null, metadata: { reason: "No verified lead-time source is connected." } },
    { connection_key: "supplier_constraints", status: inventory.length ? "pending_review" : "not_connected", last_verified_at: inventorySource.observedAt, metadata: { supplier_coverage: inventoryWithSupplier.length, case_pack_coverage: inventoryWithCasePack.length, cost_coverage: inventoryWithCost.length, verified_constraints: false } },
    { connection_key: "recipe_costs", status: recipeSource.status === "degraded" || ingredientSource.status === "degraded" ? "degraded" : recipes.length && recipeCostReady === recipes.length ? "connected" : "pending_review", last_verified_at: latestIso([recipeSource.observedAt, ingredientSource.observedAt, inventorySource.observedAt]), metadata: { active_recipes: recipes.length, cost_ready_recipes: recipeCostReady, verified_complete_costs: false } },
    { connection_key: "menu_prices", status: recipes.some((recipe) => numberValue(recipe.menu_price) > 0) ? "connected" : recipes.length ? "pending_review" : "not_connected", last_verified_at: recipeSource.observedAt, metadata: { active_recipes: recipes.length, recipes_with_menu_price: recipes.filter((recipe) => numberValue(recipe.menu_price) > 0).length, verified_current_menu: false } },
    { connection_key: "inventory_movements", status: movementSource.status === "degraded" ? "degraded" : movements.length ? "connected" : "not_connected", last_verified_at: movementSource.observedAt, metadata: { movement_count: movements.length, movement_types: Object.fromEntries(movementTypes), trusted_for_consumption_forecast: false } },
    { connection_key: "stock_counts", status: "not_connected", last_verified_at: null, metadata: { reason: "No frequent verified stock-count source is connected." } },
    { connection_key: "waste_events", status: explicitWaste.length ? "connected" : "not_connected", last_verified_at: explicitWaste.length ? latestIso(explicitWaste.map((row) => row.created_at)) : null, metadata: { explicit_events: explicitWaste.length, negative_adjustments_excluded: negativeAdjustments.length } },
    { connection_key: "bookings", status: "not_connected", last_verified_at: null, metadata: { reason: "Dineout bookings are not connected to Atlas runtime." } },
  ];

  const domains = [
    {
      key: "shortage",
      label: "Shortage intelligence",
      status: observedBelowPar.length ? "shadow_par_watch" : "evidence_gated",
      enabled_scope: observedBelowPar.length ? "current par-level watch" : historicalInventory.length ? "historical review only" : "data readiness only",
      full_capability_enabled: false,
      confidence: { state: observedBelowPar.length ? "pending" : historicalInventory.length ? "historical" : "pending", score: observedBelowPar.length ? 0.6 : historicalInventory.length ? 0.35 : 0.15 },
      metrics: { active_items: inventory.length, historical_opening_rows: historicalInventory.length, historical_zero_rows: historicalZero.length, non_historical_rows: observedInventory.length, rows_with_par: inventoryWithPar.length, observed_below_par: observedBelowPar.length },
      blockers: ["Manager-verified current stock count is missing.", "Validated product-level demand history is not connected.", "Confirmed incoming deliveries and supplier lead times are not connected."],
      limitations: ["No stockout date is predicted.", "July opening quantities remain historical evidence."],
      source_refs: ["public.inventory_items", "public.inventory_movements"],
    },
    {
      key: "purchase",
      label: "Purchase intelligence",
      status: purchaseCandidates.length ? "shadow_drafts" : "evidence_gated",
      enabled_scope: purchaseCandidates.length ? "par-restoration drafts" : "purchasing-data readiness",
      full_capability_enabled: false,
      confidence: { state: purchaseCandidates.length ? "pending" : "verified", score: purchaseCandidates.length ? 0.55 : 1 },
      metrics: { draft_candidates: purchaseCandidates.length, missing_par: inventory.length - inventoryWithPar.length, missing_supplier: inventory.length - inventoryWithSupplier.length, missing_case_pack: inventory.length - inventoryWithCasePack.length, missing_cost: inventory.length - inventoryWithCost.length },
      blockers: ["Current stock is not verified.", "Supplier lead times, minimums and incoming deliveries are not connected.", "No validated demand history is connected."],
      limitations: ["Atlas cannot create or send purchase orders.", "Any draft restores only to configured par."],
      source_refs: ["public.inventory_items", "public.suppliers"],
    },
    {
      key: "menu",
      label: "Menu intelligence",
      status: recipesWithSetupIssues ? "setup_intelligence" : recipes.length ? "operational_readiness" : "no_records",
      enabled_scope: "recipe setup, cost and availability readiness",
      full_capability_enabled: false,
      confidence: { state: recipes.length ? "reviewed" : "pending", score: recipes.length ? 0.8 : 0.15 },
      metrics: { active_recipes: recipes.length, ingredient_rows: ingredients.length, recipes_with_setup_issues: recipesWithSetupIssues, cost_ready_recipes: recipeCostReady, availability_ready_recipes: recipeAvailabilityReady, recipes_with_price: recipes.filter((recipe) => numberValue(recipe.menu_price) > 0).length },
      blockers: ["Product-level sales history is not connected, so popularity and menu-engineering recommendations remain disabled.", "Historical inventory is not used to claim current servings available."],
      limitations: ["Atlas does not change recipes, prices or menu visibility automatically."],
      source_refs: ["public.recipes", "public.recipe_ingredients", "public.inventory_items"],
    },
    {
      key: "waste",
      label: "Waste intelligence",
      status: explicitWaste.length ? "explicit_event_patterns" : "recording_readiness",
      enabled_scope: explicitWaste.length ? "explicit waste-event review" : "waste recording audit",
      full_capability_enabled: false,
      confidence: { state: explicitWaste.length ? "pending" : "verified", score: explicitWaste.length ? 0.6 : 1 },
      metrics: { movements: movements.length, explicit_waste_events: explicitWaste.length, negative_adjustments_excluded: negativeAdjustments.length, distinct_waste_items: wasteGroups.size },
      blockers: explicitWaste.length ? ["Frequent verified stock counts are not connected."] : ["No movements are explicitly labelled as waste, expiry, spoilage, breakage or spillage.", "Frequent verified stock counts are not connected."],
      limitations: ["Negative adjustments are never assumed to be waste.", "Atlas does not infer causes or assign staff blame."],
      source_refs: ["public.inventory_movements"],
    },
  ];

  const sourceObservedAt = latestIso([
    inventorySource.observedAt,
    movementSource.observedAt,
    recipeSource.observedAt,
    ingredientSource.observedAt,
    supplierSource.observedAt,
  ]);
  return { connections, domains, recommendations, sourceStatus, sourceObservedAt };
}

async function build(context: ManagerContext) {
  const [inventory, movements, recipes, ingredients, suppliers, settings] = await Promise.all([
    productionRows(context, "inventory_items", "id,name,category,quantity,unit,par_level,supplier_id,supplier,cost_price,units_per_case,case_cost,size_ml,active,sell_price,source_key,source_file,source_updated_at,updated_at,package_size", "updated_at"),
    productionRows(context, "inventory_movements", "id,item_id,item_name,movement_type,quantity_change,unit_cost,total_cost,supplier_id,created_at", "created_at"),
    productionRows(context, "recipes", "id,name,type,yield_quantity,yield_unit,menu_price,show_on_menu,active,updated_at,glass_price,bottle_price,happy_hour_price", "updated_at"),
    productionRows(context, "recipe_ingredients", "id,recipe_id,item_id,item_name,quantity,unit", "id"),
    productionRows(context, "suppliers", "id,name,active,updated_at", "updated_at"),
    branchRpc("atlas_phase3_intelligence_settings"),
  ]);

  const intelligence = createIntelligence(settings || {}, inventory, movements, recipes, ingredients, suppliers);
  const synced = await branchRpc("atlas_phase3_sync_intelligence", {
    p_connections: intelligence.connections,
    p_domains: intelligence.domains,
    p_recommendations: intelligence.recommendations,
    p_source_status: intelligence.sourceStatus,
    p_source_observed_at: intelligence.sourceObservedAt,
    p_actor_id: context.user.id,
    p_actor_label: labelFor(context),
    p_actor_role: context.profile.role,
  });
  const snapshot = await branchRpc("atlas_phase3_snapshot");
  return { intelligence: synced, snapshot };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const context = await requireManager(request);
    const url = new URL(request.url);
    const action = (url.searchParams.get("action") || "snapshot").toLowerCase();
    if (!["GET", "POST"].includes(request.method)) throw new ApiError(405, "Method not allowed.");
    if (!["snapshot", "refresh"].includes(action)) throw new ApiError(404, "Unknown Checkpoint K action.");
    const result = await build(context);
    return jsonResponse({
      ...result,
      manager: { id: context.user.id, email: context.profile.email ?? context.user.email ?? null, role: context.profile.role },
      policy: {
        shadow_mode: true,
        automatic_ordering: false,
        automatic_menu_changes: false,
        automatic_waste_attribution: false,
        historical_stock_used_for_prediction: false,
        negative_adjustments_treated_as_waste: false,
        production_source_mutation: false,
        manager_review_required: true,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Checkpoint K intelligence error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "Checkpoint K intelligence is temporarily unavailable." }, 500);
  }
});
