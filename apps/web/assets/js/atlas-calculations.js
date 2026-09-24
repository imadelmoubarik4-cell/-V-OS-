(function () {
  'use strict';

  const EACH_LIKE = new Set(['each', 'bottle', 'can']);
  const MEASURES = {
    ml: { factor: 1, base: 'ml' }, l: { factor: 1000, base: 'ml' },
    tsp: { factor: 5, base: 'ml' }, tbsp: { factor: 15, base: 'ml' },
    g: { factor: 1, base: 'g' }, kg: { factor: 1000, base: 'g' }
  };

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeUnit(unit) {
    const value = String(unit || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!value) return 'each';
    if (['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters'].includes(value)) return 'ml';
    if (['l', 'lt', 'liter', 'liters', 'litre', 'litres'].includes(value)) return 'l';
    if (['g', 'gr', 'gram', 'grams'].includes(value)) return 'g';
    if (['kg', 'kilogram', 'kilograms'].includes(value)) return 'kg';
    if (['tsp', 'teaspoon', 'teaspoons'].includes(value)) return 'tsp';
    if (['tbsp', 'tablespoon', 'tablespoons'].includes(value)) return 'tbsp';
    if (['bottle', 'bottles'].includes(value)) return 'bottle';
    if (['can', 'cans'].includes(value)) return 'can';
    if (['piece', 'pieces', 'pc', 'pcs', 'unit', 'units', 'each', 'ea'].includes(value)) return 'each';
    return value;
  }

  function parsePackSize(item) {
    if (number(item?.size_ml) > 0) return { quantity: number(item.size_ml), unit: 'ml' };
    const text = String(item?.unit || '').trim().toLowerCase();
    const match = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*(ml|l|lt|g|kg)\b/i);
    if (match) {
      const quantity = Number(match[1].replace(',', '.'));
      const unit = normalizeUnit(match[2]);
      if (unit === 'l') return { quantity: quantity * 1000, unit: 'ml' };
      if (unit === 'kg') return { quantity: quantity * 1000, unit: 'g' };
      return { quantity, unit };
    }
    const normalized = normalizeUnit(text);
    if (MEASURES[normalized]) return { quantity: MEASURES[normalized].factor, unit: MEASURES[normalized].base };
    return EACH_LIKE.has(normalized) ? { quantity: 1, unit: normalized } : null;
  }

  function convert(quantity, unit) {
    const normalized = normalizeUnit(unit);
    if (MEASURES[normalized]) return { quantity: quantity * MEASURES[normalized].factor, unit: MEASURES[normalized].base };
    return { quantity, unit: normalized };
  }

  // Discrete counting unit (bottle, can, pie, box…); null for measures.
  function countUnit(unit) {
    const normalized = normalizeUnit(unit);
    if (MEASURES[normalized]) return null;
    return EACH_LIKE.has(normalized) ? 'each' : normalized;
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

  // Inactive or untracked items (Ice, Water, recipe choices) are recipe
  // references, not live stock: they never limit or block availability.
  function isReference(item) {
    return item?.active === false || normalizeUnit(item?.unit) === 'untracked';
  }

  function ingredientMetrics(ingredient, inventory) {
    const item = inventory.find((candidate) => candidate.id === ingredient.item_id);
    if (!item) return { item: null, cost: null, batches: null, reason: 'Inventory item is missing', belowPar: false };
    const pack = parsePackSize(item);
    const requested = convert(number(ingredient.quantity), ingredient.unit);
    const purchaseCost = number(item.cost_price, NaN);
    const hasCost = Number.isFinite(purchaseCost) && purchaseCost > 0;
    if (isReference(item)) {
      return { item, cost: null, batches: null, reference: true, reason: 'Recipe reference, not stocked', belowPar: false };
    }
    // Operational quantities are historical until a current verified balance is supplied.
    const stockKnown = item.freshness_state === 'current' && item.verified_quantity != null
      && Number.isFinite(Number(item.verified_quantity));
    const stockUnits = stockKnown ? Math.max(0, Number(item.verified_quantity)) : null;
    const belowPar = stockKnown && item.par_level != null && stockUnits <= number(item.par_level);
    if (requested.quantity <= 0) return { item, cost: null, batches: null, reason: 'Package size is missing', belowPar };

    // Stock is counted in the item's own unit: a measure (kg, l, ml) is the
    // stock unit itself; a discrete count (bottle, can, pie) matches the same
    // count in a recipe; otherwise the package size converts the recipe measure.
    const itemMeasure = MEASURES[normalizeUnit(item.unit)];
    const requestedCount = countUnit(ingredient.unit);
    const countMatch = sameCount(requestedCount, countUnit(item.unit));
    const measurePacks = itemMeasure && itemMeasure.base === requested.unit ? requested.quantity / itemMeasure.factor : null;
    const stockPacks = itemMeasure ? measurePacks : countMatch ? requested.quantity : packsFor(pack, requested);
    const costPacks = packsFor(pack, requested) ?? (countMatch ? requested.quantity : measurePacks);
    const cost = hasCost && costPacks !== null ? purchaseCost * costPacks : null;
    if (stockPacks === null) {
      const reason = !pack && !itemMeasure ? 'Package size is missing' : 'Inventory unit does not match recipe unit';
      return { item, cost, batches: null, reason, belowPar };
    }
    return {
      item,
      cost,
      batches: stockKnown ? stockUnits / stockPacks : null,
      reason: !hasCost ? 'Missing inventory cost' : !stockKnown ? 'Current stock is unknown / Not counted' : null,
      belowPar
    };
  }

  function recipeMetrics(recipe, inventory) {
    const ingredients = Array.isArray(recipe?.recipe_ingredients) ? recipe.recipe_ingredients : [];
    const recipeYield = Math.max(0.0001, number(recipe?.yield_quantity, 1));
    const menuPrice = recipe?.menu_price == null || recipe.menu_price === '' ? NaN : number(recipe.menu_price, NaN);
    const rows = ingredients.map((ingredient) => ({ ingredient, ...ingredientMetrics(ingredient, inventory) }));
    const costRows = rows.filter((row) => Number.isFinite(row.cost));
    const completeCosts = ingredients.length > 0 && costRows.length === ingredients.length;
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
    // A verified shortage cannot be served whatever the other ingredients say.
    const shortage = knownServings !== null && knownServings <= 0;
    const servings = shortage ? 0 : limiting && !unknown ? knownServings : null;
    let availabilityStatus = 'ready';
    if (shortage) availabilityStatus = 'unavailable';
    else if (!stockRows.length || unknown || missing) availabilityStatus = 'incomplete';
    else if (servings < 12 || belowPar) availabilityStatus = 'attention';

    return {
      financials: { total, perServing, profit, margin, costPercent, incomplete: ingredients.length - costRows.length, complete: completeCosts && Number.isFinite(menuPrice) && menuPrice > 0 },
      availability: { servings, limiting, unknown, missing, belowPar, references, status: availabilityStatus },
      rows
    };
  }

  function formatIsk(value, fallback = '—') {
    return Number.isFinite(value) ? `${Math.round(value).toLocaleString('en-US')} ISK` : fallback;
  }

  window.AtlasCalculations = Object.freeze({ normalizeUnit, parsePackSize, ingredientMetrics, recipeMetrics, formatIsk });
})();
