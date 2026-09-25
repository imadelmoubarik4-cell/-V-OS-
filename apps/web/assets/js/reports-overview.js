// Reports › Overview figures computed from the loaded shell data (items,
// recipes, restock log, suppliers). Formerly Business Intelligence
// (business.js). Pure: no DOM, no requests. Unknown stays unknown:
// inventoryValue() is NaN while any active item is not counted or has no cost
// (AtlasStockTruth.inventoryValue, parity with atlas-domain inventoryValue).
(function (root) {
  'use strict';

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function sourceItems() {
    try { return typeof items !== 'undefined' && Array.isArray(items) ? items : []; } catch { return []; } // eslint-disable-line no-undef
  }
  function sourceRecipes() {
    try { return typeof recipes !== 'undefined' && Array.isArray(recipes) ? recipes : []; } catch { return []; } // eslint-disable-line no-undef
  }
  // Every loaded movement (AtlasData.movements), else the legacy restock log;
  // the canonical purchase-receipt rule picks the spend rows either way.
  function sourceMovements() {
    const all = root.AtlasData?.movements?.();
    if (Array.isArray(all)) return all;
    try { return typeof restockLog !== 'undefined' && Array.isArray(restockLog) ? restockLog : []; } catch { return []; } // eslint-disable-line no-undef
  }
  function activeItems() {
    return sourceItems().filter((item) => item.active !== false);
  }
  function truth() {
    return root.AtlasStockTruth || null;
  }

  // The canonical stock value (AtlasStockTruth.inventoryValue, atlas-domain
  // inventoryValue): unknown (NaN here) unless every active item is counted
  // AND has a usable cost (cost_price > 0).
  function inventoryValue() {
    const result = truth()?.inventoryValue?.(sourceItems());
    return result && result.value !== null ? result.value : NaN;
  }

  // What is known so far: the lower bound over counted, costed items and the
  // counts of what is missing (not counted; no usable cost, counted or not).
  function inventoryValueParts() {
    const result = truth()?.inventoryValue?.(sourceItems()) || { value: null, known_value: null, unknown_items: 0, missing_cost_items: 0, active_items: activeItems().length };
    return { value: result.value, knownValue: result.known_value, uncounted: result.unknown_items, uncosted: result.missing_cost_items, items: result.active_items };
  }

  // The counted, costed part of that value per category (the same items and
  // rule as inventoryValueParts, so the chart adds up to its lower bound).
  function inventoryValueByCategory() {
    const rule = truth();
    if (!rule?.known || !rule?.hasCost) return [];
    const totals = new Map();
    activeItems().forEach((item) => {
      if (!rule.known(item) || !rule.hasCost(item)) return;
      const name = String(item.category || '').trim() || 'No category';
      totals.set(name, (totals.get(name) || 0) + Math.max(0, number(item.quantity)) * Number(item.cost_price));
    });
    return [...totals.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }

  // Movements with created_at inside [start, end] (venue date keys).
  function movementsBetween(start, end) {
    const clock = root.AtlasVenueClock;
    return sourceMovements().filter((movement) => {
      const key = clock?.venueDate ? clock.venueDate(movement.created_at) : String(movement.created_at || '').slice(0, 10);
      return key && (!start || key >= start) && (!end || key <= end);
    });
  }

  // Purchasing spend: the canonical costed purchase receipts in the period
  // (AtlasStockTruth.purchaseSpend; same rule as Reports SQL and Atlas AI).
  // Waste and adjustments are never spend.
  function spend(start, end) {
    return truth()?.purchaseSpend?.(movementsBetween(start, end)).total ?? 0;
  }

  // Share of costed deliveries per supplier in the period, largest first.
  function supplierConcentration(start, end) {
    const totals = new Map();
    movementsBetween(start, end).forEach((movement) => {
      const name = movement.suppliers?.name || movement.supplier || null;
      const cost = truth()?.purchaseReceiptAmount?.(movement) || 0;
      if (!name || !cost) return;
      totals.set(name, (totals.get(name) || 0) + cost);
    });
    const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
    return [...totals.entries()]
      .map(([name, value]) => ({ name, spend: value, share: total > 0 ? value / total * 100 : 0 }))
      .sort((a, b) => b.spend - a.spend);
  }

  function recipeCosting() {
    const list = sourceRecipes().filter((recipe) => recipe.active !== false);
    // Every item, inactive references (Ice, Water) included: a reference costs 0.
    const metrics = list.map((recipe) => root.AtlasCalculations?.recipeMetrics(recipe, sourceItems())?.financials).filter(Boolean);
    const complete = metrics.filter((entry) => entry.complete);
    const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
    return {
      total: list.length,
      complete: complete.length,
      averageMargin: average(complete.map((entry) => entry.margin).filter(Number.isFinite)),
      averageCostPerServe: average(complete.map((entry) => entry.perServing).filter(Number.isFinite))
    };
  }

  function completeness() {
    const list = activeItems();
    const share = (predicate) => (list.length ? list.filter(predicate).length / list.length * 100 : null);
    const costing = recipeCosting();
    return {
      items: list.length,
      cost: share((item) => Boolean(truth()?.hasCost?.(item))),
      par: share((item) => item.par_level != null && number(item.par_level) > 0),
      supplier: share((item) => Boolean(item.supplier_id || String(item.supplier || '').trim())),
      counted: share((item) => Boolean(truth()?.known?.(item))),
      recipesCosted: costing.total ? costing.complete / costing.total * 100 : null,
      recipes: costing.total
    };
  }

  // Suggested order exposure: canonical suggestions not yet on an order.
  function orderExposure() {
    const suggestions = root.AtlasOperations?.orderSuggestions?.() || [];
    const open = suggestions.filter((entry) => !entry.ordered);
    // estimatedCost is null for an item without a usable cost: it is counted
    // as uncosted, never added as 0 kr (atlas-domain orderExposure).
    const costed = open.filter((entry) => typeof entry.estimatedCost === 'number' && Number.isFinite(entry.estimatedCost));
    return {
      items: open.length,
      estimate: costed.reduce((sum, entry) => sum + Math.max(0, entry.estimatedCost), 0),
      uncosted: open.length - costed.length
    };
  }

  root.AtlasReportsOverview = Object.freeze({
    inventoryValue,
    inventoryValueParts,
    inventoryValueByCategory,
    spend,
    supplierConcentration,
    recipeCosting,
    completeness,
    orderExposure
  });
})(typeof window === 'undefined' ? globalThis : window);
