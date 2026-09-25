// Reports › Overview figures computed from the loaded shell data (items,
// recipes, restock log, suppliers). Formerly Business Intelligence
// (business.js). Pure: no DOM, no requests. Unknown stays unknown:
// inventoryValue() is NaN while any active item is not counted or has no cost
// (parity with supabase/functions/_shared/atlas-domain.mjs inventoryValue).
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
  function sourceMovements() {
    try { return typeof restockLog !== 'undefined' && Array.isArray(restockLog) ? restockLog : []; } catch { return []; } // eslint-disable-line no-undef
  }
  function activeItems() {
    return sourceItems().filter((item) => item.active !== false);
  }
  function known(item) {
    return Boolean(root.AtlasStockTruth?.known(item));
  }

  // Counted stock at cost. NaN (unknown) while anything is not counted or uncosted.
  function inventoryValue() {
    if (activeItems().some((item) => !known(item) || item.cost_price == null)) return NaN;
    return activeItems().reduce((sum, item) => {
      const quantity = Math.max(0, number(item.quantity));
      const cost = number(item.cost_price, NaN);
      return sum + (Number.isFinite(cost) && cost > 0 ? quantity * cost : 0);
    }, 0);
  }

  // What is known so far: value of counted, costed items and what is missing.
  function inventoryValueParts() {
    const list = activeItems();
    const uncounted = list.filter((item) => !known(item)).length;
    const uncosted = list.filter((item) => known(item) && item.cost_price == null).length;
    const knownValue = list.filter((item) => known(item) && item.cost_price != null)
      .reduce((sum, item) => sum + Math.max(0, number(item.quantity)) * Math.max(0, number(item.cost_price)), 0);
    const value = inventoryValue();
    return { value: Number.isFinite(value) ? value : null, knownValue, uncounted, uncosted, items: list.length };
  }

  // Movements with created_at inside [start, end] (venue date keys).
  function movementsBetween(start, end) {
    const clock = root.AtlasVenueClock;
    return sourceMovements().filter((movement) => {
      const key = clock?.venueDate ? clock.venueDate(movement.created_at) : String(movement.created_at || '').slice(0, 10);
      return key && (!start || key >= start) && (!end || key <= end);
    });
  }

  function spend(start, end) {
    return movementsBetween(start, end).reduce((sum, movement) => sum + Math.max(0, number(movement.total_cost)), 0);
  }

  // Share of costed deliveries per supplier in the period, largest first.
  function supplierConcentration(start, end) {
    const totals = new Map();
    movementsBetween(start, end).forEach((movement) => {
      const name = movement.suppliers?.name || movement.supplier || null;
      const cost = Math.max(0, number(movement.total_cost));
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
    const metrics = list.map((recipe) => root.AtlasCalculations?.recipeMetrics(recipe, activeItems())?.financials).filter(Boolean);
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
      cost: share((item) => number(item.cost_price) > 0),
      par: share((item) => item.par_level != null && number(item.par_level) > 0),
      supplier: share((item) => Boolean(item.supplier_id || String(item.supplier || '').trim())),
      counted: share((item) => known(item)),
      recipesCosted: costing.total ? costing.complete / costing.total * 100 : null,
      recipes: costing.total
    };
  }

  // Suggested order exposure: canonical suggestions not yet on an order.
  function orderExposure() {
    const suggestions = root.AtlasOperations?.orderSuggestions?.() || [];
    const open = suggestions.filter((entry) => !entry.ordered);
    const costed = open.filter((entry) => Number.isFinite(Number(entry.estimatedCost)));
    return {
      items: open.length,
      estimate: costed.reduce((sum, entry) => sum + Math.max(0, number(entry.estimatedCost)), 0),
      uncosted: open.length - costed.length
    };
  }

  root.AtlasReportsOverview = Object.freeze({
    inventoryValue,
    inventoryValueParts,
    spend,
    supplierConcentration,
    recipeCosting,
    completeness,
    orderExposure
  });
})(typeof window === 'undefined' ? globalThis : window);
