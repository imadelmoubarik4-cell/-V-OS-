export const HISTORICAL_OPENING_CUTOFF = "2026-07-31";

function text(value) {
  return String(value ?? "").trim();
}

// Strict numeric reader: finite numbers and plain decimal strings only.
// Text such as "1 / 1 unit", "250gr" or "" is not a number and yields null.
const PLAIN_NUMBER = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/;
function numberOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !PLAIN_NUMBER.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateMillis(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  const milliseconds = parsed.getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function lower(value) {
  return text(value).toLowerCase();
}

function isCurrentBalance(balance, nowMillis) {
  if (!balance || typeof balance !== "object") return false;
  const state = lower(balance.freshness_state || balance.verification_status);
  if (state !== "current") return false;
  const expiresAt = dateMillis(balance.expires_at);
  if (balance.expires_at && expiresAt === null) return false;
  return expiresAt === null || expiresAt > nowMillis;
}


// Pre-S84 compatibility only; the database decides which workflows create evidence.
const LEGACY_OWNER_TYPES = new Set(["owner_confirmed", "owner_confirmed_supplier_price", "owner_confirmed_prep", "owner_verified_count"]);
const DEFAULT_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

function has(item, key) {
  return Boolean(item) && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, key);
}

// The owner confirmation is its own evidence pair (S84), written by the
// database only for trusted owner workflows, so present evidence is trusted
// as-is. The staff catalogue carries the same evidence as owner_confirmed_*
// (same rule as AtlasStockTruth). Rows read before the columns exist fall back
// to the legacy rule.
function ownerConfirmation(item) {
  if (has(item, "source_confirmed_at") || has(item, "source_confirmed_quantity")) {
    return { quantity: numberOrNull(item.source_confirmed_quantity), at: dateMillis(item.source_confirmed_at) };
  }
  if (has(item, "owner_confirmed_at") || has(item, "owner_confirmed_quantity")) {
    return { quantity: numberOrNull(item.owner_confirmed_quantity), at: dateMillis(item.owner_confirmed_at) };
  }
  const sourceType = lower(item?.source_type);
  if (!LEGACY_OWNER_TYPES.has(sourceType) || numberOrNull(item?.source_confidence) !== 100) return null;
  return { quantity: numberOrNull(item?.quantity), at: dateMillis(item?.updated_at) };
}

function ownerConfirmedBaseline(item, balance) {
  const confirmation = ownerConfirmation(item);
  if (!confirmation || confirmation.quantity === null || confirmation.quantity < 0 || confirmation.at === null) return null;

  // Any recorded manager count at or after the confirmation supersedes it.
  const balanceAt = dateMillis(balance?.verified_at);
  if (balanceAt !== null && confirmation.at <= balanceAt) return null;

  // Owner confirmations do not expire; past the freshness window they are flagged for recount.
  const balanceExpires = dateMillis(balance?.expires_at);
  const freshnessWindow = balanceAt !== null && balanceExpires !== null && balanceExpires > balanceAt
    ? balanceExpires - balanceAt
    : DEFAULT_FRESHNESS_MS;

  return {
    quantity: confirmation.quantity,
    at: confirmation.at,
    expiresAt: null,
    recountDueAt: confirmation.at + freshnessWindow,
    source: "owner_confirmed",
  };
}

function managerVerifiedBaseline(balance, nowMillis) {
  if (!isCurrentBalance(balance, nowMillis)) return null;
  const quantity = numberOrNull(balance?.verified_quantity);
  if (quantity === null) return null;
  return {
    quantity,
    at: dateMillis(balance?.verified_at) ?? 0,
    expiresAt: dateMillis(balance?.expires_at),
    source: "manager_verified_count",
  };
}

function movementDelta(movements, itemId, afterMillis, nowMillis) {
  return (Array.isArray(movements) ? movements : []).reduce((sum, movement) => {
    if (text(movement?.item_id) !== text(itemId)) return sum;
    if (lower(movement?.movement_type) === "count") return sum;
    const createdAt = dateMillis(movement?.created_at);
    const delta = numberOrNull(movement?.quantity_change);
    if (createdAt === null || delta === null || createdAt <= afterMillis || createdAt > nowMillis) return sum;
    return sum + delta;
  }, 0);
}

// The newest authoritative baseline (current manager count or newer owner
// confirmation) plus audited movements after it; null when stock is unknown.
// Server twin of AtlasStockTruth.effectiveStock.
export function currentQuantityEvidence(item, balance, movements, nowMillis = Date.now()) {
  const manager = managerVerifiedBaseline(balance, nowMillis);
  const owner = ownerConfirmedBaseline(item, balance);
  const baseline = owner && (!manager || owner.at > manager.at) ? owner : manager;
  if (!baseline) return null;

  const delta = movementDelta(movements, item?.id, baseline.at, nowMillis);
  return {
    quantity: Math.max(0, baseline.quantity + delta),
    source: baseline.source,
    baselineAt: baseline.at,
    expiresAt: baseline.expiresAt,
    verifiedAt: new Date(baseline.at).toISOString(),
    movementDelta: delta,
    recountDue: typeof baseline.recountDueAt === "number" && baseline.recountDueAt <= nowMillis,
  };
}

export function quantityTrustState(item, balance, nowMillis = Date.now()) {
  if (currentQuantityEvidence(item, balance, [], nowMillis)) return "current";
  if (balance && typeof balance === "object") return "stale";
  const sourceDate = text(item?.source_updated_at);
  if (sourceDate && sourceDate <= HISTORICAL_OPENING_CUTOFF) return "historical";
  return "unverified";
}

function inventoryStatus(item, quantityStatus, quantity) {
  if (quantityStatus !== "current") return quantityStatus;
  const par = numberOrNull(item.par_level);
  if (quantity !== null && quantity <= 0) return "out_of_stock";
  if (quantity !== null && par !== null && par > 0 && quantity < par) return "below_par";
  const cost = numberOrNull(item.cost_price);
  if (cost === null || cost <= 0) return "missing_cost";
  if (!text(item.supplier) && !text(item.supplier_id)) return "missing_supplier";
  if (par === null || par <= 0) return "missing_par";
  return "ok";
}

function matchesFilters(row, filters) {
  if (filters.category && lower(row.category) !== lower(filters.category)) return false;
  if (filters.supplier && lower(row.supplier) !== lower(filters.supplier)) return false;
  if (filters.status && row.status !== filters.status) return false;
  if (filters.search) {
    const haystack = [
      row.name, row.category, row.brand, row.subcategory, row.supplier,
      row.sku, row.barcode, row.bin_location,
    ].map(text).join(" ").toLowerCase();
    if (!haystack.includes(lower(filters.search))) return false;
  }
  return true;
}

export function buildStockReport(inventory, balances, filters = {}, nowMillis = Date.now(), movements = []) {
  const balanceByItem = new Map(
    (Array.isArray(balances) ? balances : [])
      .filter((balance) => balance && typeof balance === "object")
      .map((balance) => [text(balance.inventory_item_id), balance]),
  );

  const allRows = (Array.isArray(inventory) ? inventory : [])
    .filter((item) => item && typeof item === "object" && item.active !== false)
    .map((item) => {
      const balance = balanceByItem.get(text(item.id));
      const evidence = currentQuantityEvidence(item, balance, movements, nowMillis);
      const quantityStatus = evidence
        ? "current"
        : quantityTrustState(item, balance, nowMillis);
      const verifiedQuantity = evidence?.quantity ?? null;
      const rawQuantity = numberOrNull(item.quantity);
      const cost = numberOrNull(item.cost_price);
      const status = inventoryStatus(item, quantityStatus, verifiedQuantity);
      return {
        id: item.id,
        name: item.name,
        category: item.category,
        brand: item.brand,
        subcategory: item.subcategory,
        quantity: verifiedQuantity,
        source_quantity: rawQuantity,
        quantity_status: quantityStatus,
        unit: item.unit,
        par_level: item.par_level,
        supplier: text(item.supplier) || "Unassigned",
        supplier_id: item.supplier_id ?? null,
        cost_price: item.cost_price,
        estimated_value: quantityStatus === "current" && verifiedQuantity !== null && verifiedQuantity >= 0 && cost !== null && cost > 0
          ? verifiedQuantity * cost
          : null,
        status,
        bin_location: item.bin_location,
        needs_review: item.needs_review === true,
        source_updated_at: item.source_updated_at ?? null,
        verified_at: quantityStatus === "current" ? (evidence?.verifiedAt ?? balance?.verified_at ?? null) : null,
        quantity_source: evidence?.source ?? null,
        movement_delta: evidence?.movementDelta ?? 0,
        recount_due: evidence?.recountDue === true,
        updated_at: quantityStatus === "current" ? (evidence?.verifiedAt ?? balance?.verified_at ?? item.updated_at) : item.updated_at,
      };
    });

  const rows = allRows.filter((row) => matchesFilters(row, filters));
  const currentRows = rows.filter((row) => row.quantity_status === "current");
  const currentWithCost = currentRows.filter((row) => numberOrNull(row.cost_price) > 0 && numberOrNull(row.quantity) !== null);
  const currentMissingCost = currentRows.filter((row) => (numberOrNull(row.cost_price) ?? 0) <= 0).length;
  const needsCurrentCount = rows.length - currentRows.length;
  const sevenDaysAgo = nowMillis - 7 * 24 * 60 * 60 * 1000;
  const summary = {
    active_items: rows.length,
    current_items: currentRows.length,
    stale_items: rows.filter((row) => row.quantity_status === "stale").length,
    historical_items: rows.filter((row) => row.quantity_status === "historical").length,
    unverified_items: rows.filter((row) => row.quantity_status === "unverified").length,
    needs_current_count: needsCurrentCount,
    estimated_value: currentWithCost.length ? currentWithCost.reduce((sum, row) => sum + Math.max(0, numberOrNull(row.quantity) ?? 0) * (numberOrNull(row.cost_price) ?? 0), 0) : null,
    current_missing_cost: currentMissingCost,
    valuation_excluded_items: needsCurrentCount + currentMissingCost,
    below_par: rows.filter((row) => row.status === "below_par").length,
    out_of_stock: rows.filter((row) => row.status === "out_of_stock").length,
    missing_cost: rows.filter((row) => (numberOrNull(row.cost_price) ?? 0) <= 0).length,
    missing_supplier: rows.filter((row) => !text(row.supplier_id) && row.supplier === "Unassigned").length,
    missing_par: rows.filter((row) => (numberOrNull(row.par_level) ?? 0) <= 0).length,
    recently_updated: currentRows.filter((row) => (dateMillis(row.verified_at) ?? 0) >= sevenDaysAgo).length,
  };

  const categoryMap = new Map();
  for (const row of rows) {
    const category = text(row.category) || "Uncategorised";
    const current = categoryMap.get(category) || { category, item_count: 0, current_items: 0, estimated_value: null };
    current.item_count += 1;
    if (row.quantity_status === "current") current.current_items += 1;
    if (row.estimated_value !== null) current.estimated_value = (current.estimated_value ?? 0) + row.estimated_value;
    categoryMap.set(category, current);
  }

  const statusOrder = new Map([
    ["out_of_stock", 0], ["below_par", 1], ["stale", 2], ["historical", 3],
    ["unverified", 4], ["missing_cost", 5], ["missing_supplier", 6], ["missing_par", 7], ["ok", 8],
  ]);
  rows.sort((a, b) => (statusOrder.get(a.status) ?? 99) - (statusOrder.get(b.status) ?? 99)
    || text(a.name).localeCompare(text(b.name)));

  return {
    summary,
    formula: "Live stock uses the newest authoritative physical count: a current manager-verified count or a newer 100% owner-confirmed physical count, plus audited movements after that baseline. Historical, stale and unverified quantities never become live alerts.",
    rows,
    categories: [...categoryMap.values()].sort((a, b) => b.estimated_value - a.estimated_value || a.category.localeCompare(b.category)),
    evidence_rows: allRows,
    rpc_inventory: allRows.map((row) => ({
      ...inventory.find((item) => text(item?.id) === text(row.id)),
      quantity: row.quantity_status === "current" ? row.quantity : null,
      quantity_status: row.quantity_status,
      verified_at: row.verified_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// Legacy quantity / package text classification (S86).
// Package descriptions are evidence for people, not inputs for arithmetic.
// Only a bare number or a bare "<number> <unit>" is treated as parseable;
// everything else is classified and reported, never guessed and never thrown.
// ---------------------------------------------------------------------------
const MEASURE_WORDS = {
  ml: ["ml", 1], millilitre: ["ml", 1], millilitres: ["ml", 1], milliliter: ["ml", 1], milliliters: ["ml", 1],
  cl: ["ml", 10], l: ["ml", 1000], lt: ["ml", 1000], liter: ["ml", 1000], liters: ["ml", 1000],
  litre: ["ml", 1000], litres: ["ml", 1000],
  g: ["g", 1], gr: ["g", 1], gram: ["g", 1], grams: ["g", 1],
  kg: ["g", 1000], kilogram: ["g", 1000], kilograms: ["g", 1000],
};
const DECIMAL = "(\\d+(?:[.,]\\d+)?)";

function decimal(textValue) {
  return numberOrNull(String(textValue).replace(",", "."));
}

export function classifyQuantityText(value) {
  if (value === null || value === undefined) return { kind: "empty", quantity: null, unit: null, reason: null };
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { kind: "number", quantity: value, unit: null, reason: null }
      : { kind: "ambiguous", quantity: null, unit: null, reason: "Not a finite number" };
  }
  const raw = String(value).trim().toLowerCase();
  if (!raw) return { kind: "empty", quantity: null, unit: null, reason: null };
  if (new RegExp(`^${DECIMAL}$`).test(raw)) return { kind: "number", quantity: decimal(raw), unit: null, reason: null };

  const measure = raw.match(new RegExp(`^${DECIMAL}\\s*([a-z]+)$`));
  if (measure && MEASURE_WORDS[measure[2]]) {
    const [unit, factor] = MEASURE_WORDS[measure[2]];
    return { kind: "measure", quantity: decimal(measure[1]) * factor, unit, reason: null };
  }

  const pack = raw.match(new RegExp(`^(\\d+)\\s*x\\s*${DECIMAL}\\s*([a-z]+)$`));
  if (pack && MEASURE_WORDS[pack[3]]) {
    const [unit, factor] = MEASURE_WORDS[pack[3]];
    return {
      kind: "package", quantity: decimal(pack[2]) * factor, unit, count: Number(pack[1]),
      reason: "Multi-pack description; inventory size_ml or unit decides the counted unit",
    };
  }

  return { kind: "ambiguous", quantity: null, unit: null, reason: "Free-text package description; not used for calculation" };
}

// ---------------------------------------------------------------------------
// S85 recipe readiness — a line-for-line port of
// apps/web/assets/js/atlas-calculations.js. Parity is enforced by
// tests/node/reports-recipe-readiness-s86.test.js, which runs both on the same
// snapshot. Change both together.
// ---------------------------------------------------------------------------
const EACH_LIKE = new Set(["each", "bottle", "can"]);
const MEASURES = {
  ml: { factor: 1, base: "ml" }, l: { factor: 1000, base: "ml" },
  tsp: { factor: 5, base: "ml" }, tbsp: { factor: 15, base: "ml" },
  g: { factor: 1, base: "g" }, kg: { factor: 1000, base: "g" },
};

function calcNumber(value, fallback = 0) {
  const parsed = numberOrNull(value);
  return parsed === null ? fallback : parsed;
}

export function normalizeUnit(unit) {
  const value = String(unit || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!value) return "each";
  if (["ml", "millilitre", "millilitres", "milliliter", "milliliters"].includes(value)) return "ml";
  if (["l", "lt", "liter", "liters", "litre", "litres"].includes(value)) return "l";
  if (["g", "gr", "gram", "grams"].includes(value)) return "g";
  if (["kg", "kilogram", "kilograms"].includes(value)) return "kg";
  if (["tsp", "teaspoon", "teaspoons"].includes(value)) return "tsp";
  if (["tbsp", "tablespoon", "tablespoons"].includes(value)) return "tbsp";
  if (["bottle", "bottles"].includes(value)) return "bottle";
  if (["can", "cans"].includes(value)) return "can";
  if (["piece", "pieces", "pc", "pcs", "unit", "units", "each", "ea"].includes(value)) return "each";
  return value;
}

export function parsePackSize(item) {
  if (calcNumber(item?.size_ml) > 0) return { quantity: calcNumber(item.size_ml), unit: "ml" };
  const unitText = String(item?.unit || "").trim().toLowerCase();
  const match = unitText.match(/([0-9]+(?:[.,][0-9]+)?)\s*(ml|l|lt|g|kg)\b/i);
  if (match) {
    const quantity = Number(match[1].replace(",", "."));
    const unit = normalizeUnit(match[2]);
    if (unit === "l") return { quantity: quantity * 1000, unit: "ml" };
    if (unit === "kg") return { quantity: quantity * 1000, unit: "g" };
    return { quantity, unit };
  }
  const normalized = normalizeUnit(unitText);
  if (MEASURES[normalized]) return { quantity: MEASURES[normalized].factor, unit: MEASURES[normalized].base };
  return EACH_LIKE.has(normalized) ? { quantity: 1, unit: normalized } : null;
}

function convertQuantity(quantity, unit) {
  const normalized = normalizeUnit(unit);
  if (MEASURES[normalized]) return { quantity: quantity * MEASURES[normalized].factor, unit: MEASURES[normalized].base };
  return { quantity, unit: normalized };
}

function countUnit(unit) {
  const normalized = normalizeUnit(unit);
  if (MEASURES[normalized]) return null;
  return EACH_LIKE.has(normalized) ? "each" : normalized;
}

function sameCount(a, b) {
  if (a === null || b === null) return false;
  return a === b || `${a}s` === b || `${b}s` === a || `${a}es` === b || `${b}es` === a;
}

function packsFor(pack, requested) {
  if (!pack || requested.quantity <= 0) return null;
  if (pack.unit === requested.unit) return requested.quantity / pack.quantity;
  if (EACH_LIKE.has(pack.unit) && EACH_LIKE.has(requested.unit)) return requested.quantity;
  return null;
}

function isReference(item) {
  return item?.active === false || normalizeUnit(item?.unit) === "untracked";
}

export function ingredientMetrics(ingredient, itemsById) {
  const item = itemsById.get(text(ingredient?.item_id)) || null;
  if (!item) return { item: null, cost: null, batches: null, reason: "Inventory item is missing", belowPar: false };
  const pack = parsePackSize(item);
  const requested = convertQuantity(calcNumber(ingredient.quantity), ingredient.unit);
  const purchaseCost = calcNumber(item.cost_price, NaN);
  const hasCost = Number.isFinite(purchaseCost) && purchaseCost > 0;
  if (isReference(item)) {
    return { item, cost: null, batches: null, reference: true, reason: "Recipe reference, not stocked", belowPar: false };
  }
  const stockKnown = item.freshness_state === "current" && numberOrNull(item.verified_quantity) !== null;
  const stockUnits = stockKnown ? Math.max(0, numberOrNull(item.verified_quantity)) : null;
  // Same rule as AtlasStockTruth.belowPar: strictly under a positive par.
  const belowPar = stockKnown && calcNumber(item.par_level) > 0 && stockUnits < calcNumber(item.par_level);
  if (requested.quantity <= 0) return { item, cost: null, batches: null, reason: "Package size is missing", belowPar };

  const itemMeasure = MEASURES[normalizeUnit(item.unit)];
  const requestedCount = countUnit(ingredient.unit);
  const countMatch = sameCount(requestedCount, countUnit(item.unit));
  const measurePacks = itemMeasure && itemMeasure.base === requested.unit ? requested.quantity / itemMeasure.factor : null;
  const stockPacks = itemMeasure ? measurePacks : countMatch ? requested.quantity : packsFor(pack, requested);
  const costPacks = packsFor(pack, requested) ?? (countMatch ? requested.quantity : measurePacks);
  const cost = hasCost && costPacks !== null ? purchaseCost * costPacks : null;
  if (stockPacks === null) {
    const reason = !pack && !itemMeasure ? "Package size is missing" : "Inventory unit does not match recipe unit";
    return { item, cost, batches: null, reason, belowPar };
  }
  return {
    item,
    cost,
    batches: stockKnown ? stockUnits / stockPacks : null,
    reason: !hasCost ? "Missing inventory cost" : !stockKnown ? "Current stock is unknown / Not counted" : null,
    belowPar,
  };
}

export function recipeMetrics(recipe, ingredients, itemsById) {
  const list = Array.isArray(ingredients) ? ingredients : [];
  const recipeYield = Math.max(0.0001, calcNumber(recipe?.yield_quantity, 1));
  const menuPrice = recipe?.menu_price == null || recipe.menu_price === "" ? NaN : calcNumber(recipe.menu_price, NaN);
  const rows = list.map((ingredient) => ({ ingredient, ...ingredientMetrics(ingredient, itemsById) }));
  const costRows = rows.filter((row) => Number.isFinite(row.cost));
  const completeCosts = list.length > 0 && costRows.length === list.length;
  const total = completeCosts ? costRows.reduce((sum, row) => sum + row.cost, 0) : null;
  const perServing = completeCosts ? total / recipeYield : null;
  const profit = completeCosts && Number.isFinite(menuPrice) ? menuPrice - perServing : NaN;
  const margin = Number.isFinite(menuPrice) && menuPrice > 0 ? (profit / menuPrice) * 100 : NaN;
  const costPercent = completeCosts && Number.isFinite(menuPrice) && menuPrice > 0 ? (perServing / menuPrice) * 100 : NaN;

  const stockRows = rows.filter((row) => !row.reference);
  const references = rows.length - stockRows.length;
  const known = stockRows.filter((row) => Number.isFinite(row.batches));
  const limiting = known.length ? known.reduce((smallest, row) => row.batches < smallest.batches ? row : smallest, known[0]) : null;
  const knownServings = limiting ? Math.max(0, Math.floor(limiting.batches * recipeYield)) : null;
  const unknown = stockRows.length - known.length;
  const missing = rows.filter((row) => !row.item).length;
  const belowPar = rows.filter((row) => row.belowPar).length;
  const shortage = knownServings !== null && knownServings <= 0;
  const servings = shortage ? 0 : limiting && !unknown ? knownServings : null;
  let status = "ready";
  if (shortage) status = "unavailable";
  else if (!stockRows.length || unknown || missing) status = "incomplete";
  else if (servings < 12 || belowPar) status = "attention";

  return {
    financials: {
      total, perServing, profit, margin, costPercent,
      incomplete: list.length - costRows.length,
      complete: completeCosts && Number.isFinite(menuPrice) && menuPrice > 0,
    },
    availability: { servings, limiting, unknown, missing, belowPar, references, status },
    rows,
  };
}

// S85 status → Reports vocabulary.
const REPORT_STATE = { ready: "ready", attention: "needs_attention", unavailable: "unavailable", incomplete: "incomplete_setup" };
const STATE_ORDER = { unavailable: 0, incomplete_setup: 1, needs_attention: 2, ready: 3 };
const UNIT_REASONS = new Set(["Package size is missing", "Inventory unit does not match recipe unit"]);

// Joins every inventory row (inactive references included) with the S84.1
// reconciled evidence so recipes read exactly what Inventory reports.
function recipeInventory(inventory, stockReport) {
  const evidence = new Map((stockReport?.evidence_rows || []).map((row) => [text(row.id), row]));
  const byId = new Map();
  for (const item of Array.isArray(inventory) ? inventory : []) {
    if (!item || typeof item !== "object" || !text(item.id)) continue;
    const row = evidence.get(text(item.id));
    const current = item.active !== false && row?.quantity_status === "current";
    byId.set(text(item.id), {
      ...item,
      freshness_state: current ? "current" : "unknown",
      verified_quantity: current ? row.quantity : null,
    });
  }
  return byId;
}

export function buildRecipeReport(recipes, ingredients, inventory, stockReport, filters = {}) {
  const itemsById = recipeInventory(inventory, stockReport);
  const byRecipe = new Map();
  for (const ingredient of Array.isArray(ingredients) ? ingredients : []) {
    if (!ingredient || typeof ingredient !== "object") continue;
    const key = text(ingredient.recipe_id);
    if (!byRecipe.has(key)) byRecipe.set(key, []);
    byRecipe.get(key).push(ingredient);
  }

  const allRows = (Array.isArray(recipes) ? recipes : [])
    .filter((recipe) => recipe && typeof recipe === "object" && recipe.active !== false)
    .map((recipe) => {
      let metrics;
      try {
        metrics = recipeMetrics(recipe, byRecipe.get(text(recipe.id)) || [], itemsById);
      } catch (error) {
        // One malformed recipe is reported as incomplete; it never fails the report.
        metrics = null;
      }
      const availability = metrics?.availability;
      const financials = metrics?.financials;
      const lines = metrics?.rows || [];
      const stockLines = lines.filter((line) => !line.reference);
      const state = availability ? REPORT_STATE[availability.status] : "incomplete_setup";
      const menuPrice = numberOrNull(recipe.menu_price);
      const costComplete = financials && financials.incomplete === 0 && lines.length > 0;
      return {
        id: recipe.id,
        name: recipe.name,
        type: recipe.type ?? null,
        show_on_menu: recipe.show_on_menu === true,
        menu_price: menuPrice,
        happy_hour_price: numberOrNull(recipe.happy_hour_price),
        glass_price: numberOrNull(recipe.glass_price),
        bottle_price: numberOrNull(recipe.bottle_price),
        availability_state: state,
        ingredient_count: lines.length,
        missing_links: availability?.missing ?? 0,
        missing_costs: lines.filter((line) => line.item && !line.reference && !Number.isFinite(line.cost)).length,
        incompatible_units: stockLines.filter((line) => line.item && UNIT_REASONS.has(line.reason)).length,
        below_par_items: availability?.belowPar ?? 0,
        out_items: stockLines.filter((line) => line.item?.freshness_state === "current" && (numberOrNull(line.item.verified_quantity) ?? 0) <= 0).length,
        reference_ingredients: availability?.references ?? 0,
        untrusted_stock_items: stockLines.filter((line) => line.item && line.item.freshness_state !== "current").length,
        stock_evidence_status: stockLines.some((line) => line.item && line.item.freshness_state !== "current") ? "unverified" : "current",
        limiting_ingredient: availability?.limiting?.item?.name ?? null,
        readiness_reason: !availability ? "Recipe data could not be evaluated"
          : state === "unavailable" ? `${availability.limiting?.item?.name || "An ingredient"} is insufficient for one serving`
          : state === "incomplete_setup" ? (stockLines.find((line) => line.reason && line.batches === null)?.reason || "No stocked ingredients to evaluate")
          : null,
        estimated_cost_per_serving: costComplete ? financials.perServing : null,
        estimated_gross_profit: costComplete && menuPrice !== null ? financials.profit : null,
        estimated_margin_percent: costComplete && menuPrice !== null && menuPrice > 0 ? financials.margin : null,
        estimated_servings_available: availability?.servings ?? null,
        updated_at: recipe.updated_at ?? null,
      };
    });

  const category = lower(filters?.category);
  const status = lower(filters?.status);
  const search = lower(filters?.search);
  const rows = allRows
    .filter((row) => (!category || lower(row.type) === category)
      && (!status || !Object.hasOwn(STATE_ORDER, status) || row.availability_state === status)
      && (!search || `${lower(row.name)} ${lower(row.type)}`.includes(search)))
    .sort((a, b) => STATE_ORDER[a.availability_state] - STATE_ORDER[b.availability_state] || text(a.name).localeCompare(text(b.name)));

  return {
    summary: {
      active_recipes: rows.length,
      shown_on_menu: rows.filter((row) => row.show_on_menu === true).length,
      ready: rows.filter((row) => row.availability_state === "ready").length,
      needs_attention: rows.filter((row) => row.availability_state === "needs_attention").length,
      unavailable: rows.filter((row) => row.availability_state === "unavailable").length,
      incomplete_setup: rows.filter((row) => row.availability_state === "incomplete_setup").length,
      stock_evidence_unverified: rows.filter((row) => row.stock_evidence_status === "unverified").length,
    },
    formula: "Recipe availability uses the same rules as Recipes, Operations and Home: current reconciled stock, whole-unit, kg/g, l/ml and tsp/tbsp conversion, inactive recipe references ignored, and a verified zero marked unavailable. Unmeasurable ingredients are incomplete rather than guessed.",
    rows,
  };
}

// ---------------------------------------------------------------------------
// Private snapshot payload sanitation. The private SQL casts package text to
// numeric; it receives only canonical "<n> ml" / "<n> g" (or "" for counted
// units), plain numbers and valid identifiers, so no row can abort the snapshot.
// ---------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNAPSHOT_NUMBERS = ["quantity", "par_level", "cost_price", "size_ml", "sell_price"];

function uuidOrNull(value) {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function timestampOrNull(value) {
  return dateMillis(value) === null ? null : value;
}

export function sanitizeSnapshotInventory(rows) {
  const clean = [];
  const issues = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const id = uuidOrNull(row.id);
    if (!id) {
      issues.push({ id: row.id ?? null, name: row.name ?? null, field: "id", value: row.id ?? null, reason: "Invalid inventory identifier; row excluded from the private snapshot" });
      continue;
    }
    const next = { ...row, id, supplier_id: uuidOrNull(row.supplier_id), updated_at: timestampOrNull(row.updated_at) };
    for (const field of SNAPSHOT_NUMBERS) {
      if (!(field in row)) continue;
      next[field] = numberOrNull(row[field]);
      if (row[field] !== null && row[field] !== undefined && row[field] !== "" && next[field] === null) {
        issues.push({ id, name: row.name ?? null, field, value: row[field], reason: "Not a plain number; treated as missing" });
      }
    }
    const pack = parsePackSize(next);
    next.package_size = pack && (pack.unit === "ml" || pack.unit === "g") ? `${pack.quantity} ${pack.unit}` : "";
    const packageText = classifyQuantityText(row.package_size);
    if (packageText.kind === "ambiguous" || packageText.kind === "package") {
      issues.push({ id, name: row.name ?? null, field: "package_size", value: row.package_size, classification: packageText.kind, reason: packageText.reason });
    }
    next.active = row.active !== false;
    clean.push(next);
  }
  return { rows: clean, issues };
}

export function sanitizeSnapshotRecipes(recipes, ingredients) {
  const recipeRows = (Array.isArray(recipes) ? recipes : [])
    .filter((row) => row && typeof row === "object" && !Array.isArray(row) && uuidOrNull(row.id))
    .map((row) => ({
      ...row,
      category_id: uuidOrNull(row.category_id),
      updated_at: timestampOrNull(row.updated_at),
      yield_quantity: numberOrNull(row.yield_quantity),
      menu_price: numberOrNull(row.menu_price),
      happy_hour_price: numberOrNull(row.happy_hour_price),
      glass_price: numberOrNull(row.glass_price),
      bottle_price: numberOrNull(row.bottle_price),
    }));
  const ingredientRows = (Array.isArray(ingredients) ? ingredients : [])
    .filter((row) => row && typeof row === "object" && !Array.isArray(row) && uuidOrNull(row.id) && uuidOrNull(row.recipe_id))
    .map((row) => ({ ...row, item_id: uuidOrNull(row.item_id), quantity: numberOrNull(row.quantity) }));
  return { recipes: recipeRows, ingredients: ingredientRows };
}

export function applyStockTrustToWorkspace(workspace, stockReport, recipeReport, dataQuality = {}) {
  const next = structuredClone(workspace || {});
  next.reports = next.reports || {};
  next.reports.inventory = {
    summary: stockReport.summary,
    formula: stockReport.formula,
    rows: stockReport.rows,
    categories: stockReport.categories,
    // Legacy package text and non-numeric values found in active inventory.
    // They are reported for correction; none of them is used as a number.
    data_quality: Array.isArray(dataQuality.issues) ? dataQuality.issues : [],
  };
  if (recipeReport) next.reports.recipes = recipeReport;
  if (dataQuality.degraded) {
    next.trust = { ...(next.trust || {}), private_snapshot_degraded: true };
  }

  const alertCount = stockReport.summary.below_par + stockReport.summary.out_of_stock;
  if (next.reports.overview?.summary) {
    next.reports.overview.summary.stock_risk = stockReport.summary.current_items === 0
      ? "No current verified stock counts. Historical, stale and unverified quantities are excluded from live alerts."
      : `${alertCount} current verified inventory alerts.`;
  }

  if (Array.isArray(next.kpis)) {
    next.kpis = next.kpis.map((kpi) => kpi?.key === "stock_alerts" ? {
      ...kpi,
      value: stockReport.summary.current_items > 0 ? alertCount : null,
      status: stockReport.summary.needs_current_count === 0 && stockReport.summary.current_items > 0 ? "complete" : "partial",
      detail: stockReport.summary.current_items > 0
        ? "Out-of-stock and below-par alerts from current manager-verified counts only."
        : "No current verified counts; historical, stale and unverified quantities are excluded.",
    } : kpi?.key === "inventory_value" ? {
      ...kpi,
      value: stockReport.summary.estimated_value,
      status: stockReport.summary.valuation_excluded_items === 0 && stockReport.summary.current_items > 0 ? "complete" : "partial",
      detail: "Current manager-verified quantities × configured costs. Unverified quantities and missing costs are excluded.",
      change_value: null, change_percent: null, comparison_value: null, trend: "not_comparable",
    } : kpi?.key === "recipes_attention" && recipeReport?.summary ? {
      ...kpi,
      value: recipeReport.summary.active_recipes === 0 ? null
        : recipeReport.summary.unavailable + recipeReport.summary.incomplete_setup + recipeReport.summary.needs_attention,
      detail: "Unavailable, incomplete or low-coverage recipes from current reconciled stock (same rules as Recipes).",
    } : kpi);
  }

  const attention = (Array.isArray(next.attention) ? next.attention : []).filter((item) => ![
    "inventory-out-stock", "inventory-below-par", "recipes-unavailable", "recipes-incomplete",
  ].includes(item?.key));
  const trustedAlerts = [];
  if (stockReport.summary.out_of_stock > 0) trustedAlerts.push({
    key: "inventory-out-stock", tone: "danger",
    title: `${stockReport.summary.out_of_stock} items are out of stock`,
    detail: "Current manager-verified counts show no available quantity.", section: "inventory", source: "Inventory",
  });
  if (stockReport.summary.below_par > 0) trustedAlerts.push({
    key: "inventory-below-par", tone: "warn",
    title: `${stockReport.summary.below_par} items are below par`,
    detail: "Current manager-verified counts are below the configured par level.", section: "inventory", source: "Inventory",
  });
  if (recipeReport?.summary?.unavailable > 0) trustedAlerts.push({
    key: "recipes-unavailable", tone: "danger",
    title: `${recipeReport.summary.unavailable} recipes are unavailable`,
    detail: "Current manager-verified stock counts show unavailable linked ingredients.", section: "recipes", source: "Recipes",
  });
  if (recipeReport?.summary?.incomplete_setup > 0) trustedAlerts.push({
    key: "recipes-incomplete", tone: "warn",
    title: `${recipeReport.summary.incomplete_setup} recipes need evidence or setup completion`,
    detail: "Missing links, incompatible units, or unverified stock evidence prevent a live availability claim.", section: "recipes", source: "Recipes",
  });
  next.attention = [...trustedAlerts, ...attention];

  const inventorySource = Array.isArray(next.data_sources)
    ? next.data_sources.find((source) => source?.key === "inventory")
    : null;
  const recipeSource = recipeReport && Array.isArray(next.data_sources)
    ? next.data_sources.find((source) => source?.key === "recipes")
    : null;
  if (recipeSource) {
    const summary = recipeReport.summary;
    recipeSource.status = summary.active_recipes === 0 ? "no_records"
      : summary.incomplete_setup > 0 || summary.needs_attention > 0 || summary.unavailable > 0 ? "partial" : "connected";
  }
  if (inventorySource) {
    inventorySource.status = stockReport.summary.current_items > 0 ? "connected" : "partial";
    inventorySource.records_included = stockReport.summary.current_items;
    inventorySource.records_excluded = stockReport.summary.active_items - stockReport.summary.current_items;
    inventorySource.note = "Live alerts and valuation include current manager-verified counts only; historical, stale and unverified quantities are excluded.";
  }

  if (next.filter_options?.statuses && Array.isArray(next.filter_options.statuses)) {
    next.filter_options.statuses = [...new Set([
      ...next.filter_options.statuses, "stale", "historical", "unverified",
    ])];
  }
  next.trust = {
    ...(next.trust || {}),
    live_stock_requires_current_verified_count: true,
    historical_stock_used_as_live_alert: false,
    stale_stock_used_as_live_alert: false,
    unverified_stock_used_as_live_alert: false,
  };
  return next;
}
