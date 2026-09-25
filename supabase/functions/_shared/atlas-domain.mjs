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
  MOVEMENT_PAGE_SIZE,
  MOVEMENT_ROW_LIMIT,
  PURCHASE_RECEIPT_TYPES,
  REFERENCE_COST_REASON,
  STOCK_STATUSES,
  currentQuantityEvidence,
  formatKr,
  hasCost,
  inventoryValue,
  isReference,
  isStockKnown,
  needsOrdering,
  purchaseReceiptAmount,
  quantityTrustState,
  recipeMetrics as provenanceRecipeMetrics,
  stockCounts,
  stockStatus,
} from "./stock-provenance.mjs";

// The S89 canonical rules live beside the stock evidence rules in
// stock-provenance.mjs (so Reports needs one import) and are re-exported here.
export {
  HISTORICAL_OPENING_CUTOFF,
  MOVEMENT_PAGE_SIZE,
  MOVEMENT_ROW_LIMIT,
  PURCHASE_RECEIPT_TYPES,
  REFERENCE_COST_REASON,
  STOCK_STATUSES,
  formatKr,
  hasCost,
  inventoryValue,
  isReference,
  isStockKnown,
  needsOrdering,
  purchaseReceiptAmount,
  quantityTrustState,
  stockCounts,
  stockStatus,
};

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

// AtlasStockTruth.belowPar, the par test: verified stock strictly under a
// positive par (true for an out item that has a par). Unknown or unverified
// stock is never under par; an item at par is not. Summaries use stockStatus.
export function belowPar(item) {
  if (!isStockKnown(item)) return false;
  const par = numberOrNull(item.par_level);
  const quantity = numberOrNull(item.verified_quantity ?? item.quantity);
  return par !== null && par > 0 && quantity !== null && quantity < par;
}

// Active items under par (the par test; includes out items with a par).
export function belowParItems(projectedItems) {
  return asArray(projectedItems).filter((item) => item && item.active !== false && belowPar(item));
}

// operations.js lowInventoryItems: active items that need ordering
// (stockStatus 'out' or 'below_par').
export function needsOrderingItems(projectedItems) {
  return asArray(projectedItems).filter((item) => item && item.active !== false && needsOrdering(item));
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
// Purchasing (operations.js orderSuggestions, atlas-purchasing.js openItemIds)
// ---------------------------------------------------------------------------

// atlas-purchasing.js AtlasPurchaseOrders.openItemIds: items on a placed order
// that hasn't fully arrived (status 'ordered' or 'partially_received').
export function openPurchaseOrderItemIds(purchaseOrders) {
  return new Set(asArray(purchaseOrders)
    .filter((order) => order?.status === "ordered" || order?.status === "partially_received")
    .flatMap((order) => asArray(order.lines).map((line) => line?.item_id))
    .filter(Boolean));
}

// operations.js orderSuggestions for every item that needs ordering. Target
// is twice par; the shortfall is at least one unit; case packs round up to
// whole cases. estimatedCost is null when the item has no usable cost (never
// 0 kr). "Ordered" comes from open purchase orders (plus any explicit
// `orderedItemIds`), never from browser storage.
export function orderSuggestions(projectedItems, { purchaseOrders = [], orderedItemIds = [] } = {}) {
  const ordered = openPurchaseOrderItemIds(purchaseOrders);
  for (const id of orderedItemIds || []) ordered.add(id);
  return needsOrderingItems(projectedItems).map((item) => {
    const par = Math.max(0, number(item.par_level));
    const current = Math.max(0, number(item.quantity));
    const target = Math.max(par, Math.ceil(par * 2));
    const shortfall = Math.max(1, Math.ceil(target - current));
    const unitsPerCase = Math.max(0, number(item.units_per_case));
    const cases = unitsPerCase > 1 ? Math.max(1, Math.ceil(shortfall / unitsPerCase)) : null;
    const orderQuantity = cases ? cases * unitsPerCase : shortfall;
    const cost = hasCost(item) ? number(item.cost_price) : null;
    return {
      id: item.id,
      name: item.name,
      unit: item.unit || "units",
      supplier: item.supplier || "Supplier not assigned",
      supplierId: item.supplier_id ?? null,
      shortfall,
      orderQuantity,
      cases,
      estimatedCost: cost === null ? null : cost * orderQuantity,
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
    estimatedCost: entries.reduce((sum, entry) => sum + (Number.isFinite(entry.estimatedCost) ? entry.estimatedCost : 0), 0),
    uncosted: entries.filter((entry) => !Number.isFinite(entry.estimatedCost)).length,
  })).sort((a, b) => b.suggestions.length - a.suggestions.length || a.supplier.localeCompare(b.supplier));
}

// ---------------------------------------------------------------------------
// Order exposure (reports-overview.js orderExposure): suggestions not yet on
// an order, the estimate over costed lines and how many lines have no cost.
// ---------------------------------------------------------------------------
export function orderExposure(suggestions) {
  const open = asArray(suggestions).filter((entry) => entry && !entry.ordered);
  const costed = open.filter((entry) => Number.isFinite(entry.estimatedCost));
  return {
    items: open.length,
    estimate: costed.reduce((sum, entry) => sum + Math.max(0, entry.estimatedCost), 0),
    uncosted: open.length - costed.length,
  };
}

// ---------------------------------------------------------------------------
// Purchasing spend (AtlasStockTruth.purchaseSpend): costed purchase receipts
// (purchaseReceiptAmount) in the period; waste and adjustments are never spend.
// `include(movement)` is the caller's period test.
// ---------------------------------------------------------------------------
export function purchaseSpend(movements, include = () => true) {
  const result = { total: 0, receipts: 0, costed: 0, uncosted: 0 };
  for (const movement of asArray(movements)) {
    const amount = purchaseReceiptAmount(movement);
    if (amount === undefined || !include(movement)) continue;
    result.receipts += 1;
    if (amount === null) result.uncosted += 1;
    else {
      result.costed += 1;
      result.total += amount;
    }
  }
  return result;
}
