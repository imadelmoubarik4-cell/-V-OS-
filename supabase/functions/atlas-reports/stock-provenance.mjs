export const HISTORICAL_OPENING_CUTOFF = "2026-07-31";

function text(value) {
  return String(value ?? "").trim();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
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


const OWNER_CONFIRMED_TYPES = new Set(["owner_confirmed", "owner_confirmed_supplier_price"]);
const DEFAULT_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

function has(item, key) {
  return Boolean(item) && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, key);
}

// The owner confirmation is its own evidence pair (S84). Rows read before the
// columns exist fall back to the live row, matching the previous rule.
function ownerConfirmation(item) {
  // S84.1: dedicated owner evidence is authoritative once present. The
  // database guard decides which trusted owner workflows may stamp it.
  if (has(item, "source_confirmed_at") || has(item, "source_confirmed_quantity")) {
    return { quantity: numberOrNull(item?.source_confirmed_quantity), at: dateMillis(item?.source_confirmed_at) };
  }

  // Compatibility for pre-S84 rows only.
  const sourceType = lower(item?.source_type);
  if (!OWNER_CONFIRMED_TYPES.has(sourceType) || numberOrNull(item?.source_confidence) !== 100) return null;
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

function currentQuantityEvidence(item, balance, movements, nowMillis) {
  const manager = managerVerifiedBaseline(balance, nowMillis);
  const owner = ownerConfirmedBaseline(item, balance);
  const baseline = owner && (!manager || owner.at > manager.at) ? owner : manager;
  if (!baseline) return null;

  const delta = movementDelta(movements, item?.id, baseline.at, nowMillis);
  return {
    quantity: Math.max(0, baseline.quantity + delta),
    source: baseline.source,
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

export function reconcileRecipeStockEvidence(recipeReport, ingredients, stockReport) {
  const evidenceByItem = new Map(stockReport.evidence_rows.map((row) => [text(row.id), row]));
  const evidenceByRecipe = new Map();
  for (const ingredient of Array.isArray(ingredients) ? ingredients : []) {
    const recipeId = text(ingredient?.recipe_id);
    const itemId = text(ingredient?.item_id);
    if (!recipeId || !itemId) continue;
    const item = evidenceByItem.get(itemId);
    if (!item) continue;
    const current = evidenceByRecipe.get(recipeId) || { untrusted: 0, out: 0, below: 0 };
    if (item.quantity_status !== "current") current.untrusted += 1;
    else if ((numberOrNull(item.quantity) ?? 0) <= 0) current.out += 1;
    else if ((numberOrNull(item.par_level) ?? 0) > 0 && numberOrNull(item.quantity) < numberOrNull(item.par_level)) current.below += 1;
    evidenceByRecipe.set(recipeId, current);
  }

  const rows = (Array.isArray(recipeReport?.rows) ? recipeReport.rows : []).map((row) => {
    const evidence = evidenceByRecipe.get(text(row.id)) || { untrusted: 0, out: 0, below: 0 };
    let availabilityState = "ready";
    if ((numberOrNull(row.ingredient_count) ?? 0) === 0
      || (numberOrNull(row.missing_links) ?? 0) > 0
      || (numberOrNull(row.incompatible_units) ?? 0) > 0) availabilityState = "incomplete_setup";
    else if (evidence.out > 0) availabilityState = "unavailable";
    else if (evidence.untrusted > 0) availabilityState = "incomplete_setup";
    else if ((numberOrNull(row.missing_costs) ?? 0) > 0 || evidence.below > 0) availabilityState = "needs_attention";
    return {
      ...row,
      availability_state: availabilityState,
      stock_evidence_status: evidence.untrusted > 0 ? "unverified" : "current",
      untrusted_stock_items: evidence.untrusted,
      below_par_items: evidence.below,
      out_items: evidence.out,
      estimated_servings_available: evidence.untrusted > 0 ? null : row.estimated_servings_available,
    };
  });

  return {
    ...(recipeReport || {}),
    summary: {
      ...(recipeReport?.summary || {}),
      active_recipes: rows.length,
      shown_on_menu: rows.filter((row) => row.show_on_menu === true).length,
      ready: rows.filter((row) => row.availability_state === "ready").length,
      needs_attention: rows.filter((row) => row.availability_state === "needs_attention").length,
      unavailable: rows.filter((row) => row.availability_state === "unavailable").length,
      incomplete_setup: rows.filter((row) => row.availability_state === "incomplete_setup").length,
      stock_evidence_unverified: rows.filter((row) => row.stock_evidence_status === "unverified").length,
    },
    formula: "Recipe availability uses the same current stock truth as Inventory: the newest authoritative physical baseline plus audited movements. Historical, stale or unverified evidence is marked incomplete rather than unavailable.",
    rows,
  };
}

export function applyStockTrustToWorkspace(workspace, stockReport, recipeReport) {
  const next = structuredClone(workspace || {});
  next.reports = next.reports || {};
  next.reports.inventory = {
    summary: stockReport.summary,
    formula: stockReport.formula,
    rows: stockReport.rows,
    categories: stockReport.categories,
  };
  if (recipeReport) next.reports.recipes = recipeReport;

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
