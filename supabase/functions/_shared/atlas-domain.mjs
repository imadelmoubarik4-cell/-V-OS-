// Atlas canonical business truth, server side.
//
// Plain dependency-free ESM so Edge Functions (Deno) and the Node test suite
// import the same file. Every rule here is a port of the browser rule named
// beside it and is parity-tested against the shipped browser modules
// (tests/node/domain-parity-s88.test.js). Change both together.
//
// Inputs are plain rows as PostgREST returns them. Nothing here reads the
// network, the clock (callers pass `nowMillis`) or browser storage.

import {
  HISTORICAL_OPENING_CUTOFF,
  currentQuantityEvidence,
  quantityTrustState,
  recipeMetrics as provenanceRecipeMetrics,
} from "./stock-provenance.mjs";

export { HISTORICAL_OPENING_CUTOFF, quantityTrustState };

// Same coercion as the browser modules: Number(), finite or the fallback.
function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// AtlasStockTruth.numberOrNull.
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Stock truth (apps/web/assets/js/atlas-stock-truth.js)
// ---------------------------------------------------------------------------

// AtlasStockTruth.project: every item with its effective stock. Unknown stock
// is `null`, never the raw imported quantity.
export function projectStock(items, balances, movements = [], nowMillis = Date.now()) {
  const byId = new Map(asArray(balances)
    .filter((balance) => balance && typeof balance === "object")
    .map((balance) => [text(balance.inventory_item_id), balance]));
  return asArray(items).map((item) => {
    const evidence = currentQuantityEvidence(item, byId.get(text(item?.id)), movements, nowMillis);
    return {
      ...item,
      quantity: evidence ? evidence.quantity : null,
      verified_quantity: evidence ? evidence.quantity : null,
      freshness_state: evidence ? "current" : "unknown",
      stock_source: evidence?.source || null,
      stock_baseline_at: evidence?.baselineAt || null,
      stock_movement_delta: evidence?.movementDelta || 0,
      stock_recount_due: evidence?.recountDue === true,
    };
  });
}

// Item Master L2 `count_activity` entry → the verified-balance shape the stock
// rules read. Count lines without a verified balance are activity, not stock
// evidence, so they yield null.
export function balanceFromCountActivity(entry) {
  if (!entry || typeof entry !== "object" || !entry.verified_at) return null;
  return {
    inventory_item_id: entry.inventory_item_id,
    verified_quantity: entry.verified_quantity,
    verification_status: entry.verification_status,
    verified_at: entry.verified_at,
    expires_at: entry.expires_at,
  };
}

// AtlasStockTruth.known: the item carries a current verified quantity.
export function isStockKnown(item) {
  return item?.freshness_state === "current" && item.verified_quantity != null
    && item.verified_quantity !== "" && Number.isFinite(Number(item.verified_quantity));
}

// AtlasStockTruth.belowPar: verified stock strictly under a positive par.
// Unknown or unverified stock is never below par; an item at par is not.
export function belowPar(item) {
  if (!isStockKnown(item)) return false;
  const par = numberOrNull(item.par_level);
  const quantity = numberOrNull(item.verified_quantity ?? item.quantity);
  return par !== null && par > 0 && quantity !== null && quantity < par;
}

// operations.js lowInventoryItems: active items that are below par.
export function belowParItems(projectedItems) {
  return asArray(projectedItems).filter((item) => item && item.active !== false && belowPar(item));
}

// ---------------------------------------------------------------------------
// Recipes (atlas-calculations.js recipeMetrics, recipes.js recipeStatus and
// recipeBlockers). `items` are projected items (inactive references included),
// as an array or a Map keyed by id. Ingredients come from
// `recipe.recipe_ingredients` unless passed explicitly.
// ---------------------------------------------------------------------------

function itemsMap(items) {
  if (items instanceof Map) {
    return new Map([...items].map(([id, item]) => [text(id), item]));
  }
  return new Map(asArray(items)
    .filter((item) => item && typeof item === "object")
    .map((item) => [text(item.id), item]));
}

function ingredientsOf(recipe, ingredients) {
  if (Array.isArray(ingredients)) return ingredients;
  return asArray(recipe?.recipe_ingredients);
}

// AtlasCalculations.recipeMetrics → { financials, availability, rows }.
export function recipeMetrics(recipe, items, ingredients) {
  return provenanceRecipeMetrics(recipe, ingredientsOf(recipe, ingredients), itemsMap(items));
}

// recipes.js recipeAvailability.
export function recipeAvailability(recipe, items, ingredients) {
  return recipeMetrics(recipe, items, ingredients).availability;
}

const STATUS_LABELS = {
  draft: { label: "Draft", className: "draft" },
  unavailable: { label: "Out of stock", className: "danger" },
  attention: { label: "Low availability", className: "warn" },
  incomplete: { label: "Incomplete", className: "warn" },
  ready: { label: "Ready", className: "ready" },
};

// recipes.js recipeStatus: draft (inactive/archived) first, then availability.
export function recipeStatus(recipe, items, ingredients) {
  const availability = recipeAvailability(recipe, items, ingredients);
  let key = "ready";
  if (recipe?.active === false) key = "draft";
  else if (availability.status === "unavailable") key = "unavailable";
  else if (availability.status === "attention") key = "attention";
  else if (availability.status === "incomplete") key = "incomplete";
  return { key, ...STATUS_LABELS[key], availability };
}

// recipes.js recipeBlockers: the ingredients that stop availability from being
// calculated, with the real reason.
export function recipeBlockers(recipe, items, ingredients) {
  const rows = recipeMetrics(recipe, items, ingredients).rows || [];
  return rows
    .filter((row) => !row.reference && !Number.isFinite(row.batches))
    .map((row) => {
      const name = row.item?.name || row.ingredient?.item_name || "An ingredient";
      let reason = "not linked to an inventory item";
      if (row.item && row.reason && /unit|package/i.test(row.reason)) reason = row.reason.toLowerCase();
      else if (row.item && !isStockKnown(row.item)) reason = "no verified stock count";
      else if (row.item) reason = String(row.reason || "stock cannot be calculated").toLowerCase();
      return { name, reason };
    });
}

// Recipe cost with the canonical AtlasCalculations cost rules:
// { total, perServing, profit, margin, costPercent, incomplete, complete }.
// Cost is manager-only data; callers must gate it by role.
export function recipeCost(recipe, items, ingredients) {
  return recipeMetrics(recipe, items, ingredients).financials;
}

// ---------------------------------------------------------------------------
// Purchasing (operations.js orderSuggestions, purchase-orders.js openItemIds)
// ---------------------------------------------------------------------------

// purchase-orders.js AtlasPurchaseOrders.openItemIds: items on a placed, not
// yet received order (status 'ordered').
export function openPurchaseOrderItemIds(purchaseOrders) {
  return new Set(asArray(purchaseOrders)
    .filter((order) => order?.status === "ordered")
    .flatMap((order) => asArray(order.lines).map((line) => line?.item_id))
    .filter(Boolean));
}

// operations.js orderSuggestions. Target is twice par; the shortfall is at
// least one unit; case packs round up to whole cases. "Ordered" comes from
// open purchase orders (plus any explicit `orderedItemIds`), never from
// browser storage.
export function orderSuggestions(projectedItems, { purchaseOrders = [], orderedItemIds = [] } = {}) {
  const ordered = openPurchaseOrderItemIds(purchaseOrders);
  for (const id of orderedItemIds || []) ordered.add(id);
  return belowParItems(projectedItems).map((item) => {
    const par = Math.max(0, number(item.par_level));
    const current = Math.max(0, number(item.quantity));
    const target = Math.max(par, Math.ceil(par * 2));
    const shortfall = Math.max(1, Math.ceil(target - current));
    const unitsPerCase = Math.max(0, number(item.units_per_case));
    const cases = unitsPerCase > 1 ? Math.max(1, Math.ceil(shortfall / unitsPerCase)) : null;
    const orderQuantity = cases ? cases * unitsPerCase : shortfall;
    const cost = Math.max(0, number(item.cost_price));
    return {
      id: item.id,
      name: item.name,
      unit: item.unit || "units",
      supplier: item.supplier || "Supplier not assigned",
      supplierId: item.supplier_id ?? null,
      shortfall,
      orderQuantity,
      cases,
      estimatedCost: cost * orderQuantity,
      ordered: ordered.has(item.id),
    };
  });
}

// operations.js orderGroups: suggestions grouped by supplier.
export function orderGroups(suggestions) {
  const groups = new Map();
  for (const suggestion of asArray(suggestions)) {
    if (!groups.has(suggestion.supplier)) groups.set(suggestion.supplier, []);
    groups.get(suggestion.supplier).push(suggestion);
  }
  return Array.from(groups, ([supplier, entries]) => ({
    supplier,
    suggestions: entries,
    estimatedCost: entries.reduce((sum, entry) => sum + entry.estimatedCost, 0),
  })).sort((a, b) => b.suggestions.length - a.suggestions.length || a.supplier.localeCompare(b.supplier));
}

// ---------------------------------------------------------------------------
// Inventory value (business.js inventoryValue)
// ---------------------------------------------------------------------------

// `value` is the browser total: null (the browser shows NaN, "—") when any
// active item lacks verified stock or a cost, so an unknown is never reported
// as a smaller number. `known_value` is the sum over items that do have both
// (null when there are none), for "at least" wording.
export function inventoryValue(projectedItems) {
  const active = asArray(projectedItems).filter((item) => item && item.active !== false);
  const unknownItems = active.filter((item) => !isStockKnown(item)).length;
  const missingCostItems = active.filter((item) => item.cost_price == null).length;
  let knownValue = null;
  for (const item of active) {
    if (!isStockKnown(item)) continue;
    const cost = number(item.cost_price, NaN);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    knownValue = (knownValue ?? 0) + Math.max(0, number(item.quantity)) * cost;
  }
  const complete = unknownItems === 0 && missingCostItems === 0;
  const value = complete
    ? active.reduce((sum, item) => {
      const cost = number(item.cost_price, NaN);
      return sum + (Number.isFinite(cost) && cost > 0 ? Math.max(0, number(item.quantity)) * cost : 0);
    }, 0)
    : null;
  return {
    value,
    complete,
    known_value: knownValue,
    active_items: active.length,
    unknown_items: unknownItems,
    missing_cost_items: missingCostItems,
  };
}
