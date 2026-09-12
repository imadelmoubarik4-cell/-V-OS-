(function () {
  'use strict';

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
    return ['bottle', 'can', 'each'].includes(normalized) ? { quantity: 1, unit: normalized } : null;
  }

  function convert(quantity, unit) {
    const normalized = normalizeUnit(unit);
    if (normalized === 'l') return { quantity: quantity * 1000, unit: 'ml' };
    if (normalized === 'kg') return { quantity: quantity * 1000, unit: 'g' };
    return { quantity, unit: normalized };
  }

  function ingredientMetrics(ingredient, inventory) {
    const item = inventory.find((candidate) => candidate.id === ingredient.item_id);
    if (!item) return { item: null, cost: null, batches: null, reason: 'Inventory item is missing', belowPar: false };
    const pack = parsePackSize(item);
    const requested = convert(number(ingredient.quantity), ingredient.unit);
    const purchaseCost = number(item.cost_price, NaN);
    const stockUnits = Math.max(0, number(item.quantity));
    const belowPar = item.par_level != null && stockUnits <= number(item.par_level);
    if (!pack || requested.quantity <= 0) return { item, cost: null, batches: null, reason: 'Package size is missing', belowPar };

    const eachLike = new Set(['each', 'bottle', 'can']);
    const matching = pack.unit === requested.unit;
    const compatibleEach = eachLike.has(pack.unit) && eachLike.has(requested.unit);
    if (!matching && !compatibleEach) return { item, cost: null, batches: null, reason: 'Inventory unit does not match recipe unit', belowPar };
    const requestedPacks = matching ? requested.quantity / pack.quantity : requested.quantity;
    return {
      item,
      cost: Number.isFinite(purchaseCost) && purchaseCost > 0 ? purchaseCost * requestedPacks : null,
      batches: stockUnits / requestedPacks,
      reason: Number.isFinite(purchaseCost) && purchaseCost > 0 ? null : 'Missing inventory cost',
      belowPar
    };
  }

  function recipeMetrics(recipe, inventory) {
    const ingredients = Array.isArray(recipe?.recipe_ingredients) ? recipe.recipe_ingredients : [];
    const recipeYield = Math.max(0.0001, number(recipe?.yield_quantity, 1));
    const menuPrice = number(recipe?.menu_price, NaN);
    const rows = ingredients.map((ingredient) => ({ ingredient, ...ingredientMetrics(ingredient, inventory) }));
    const costRows = rows.filter((row) => Number.isFinite(row.cost));
    const completeCosts = ingredients.length > 0 && costRows.length === ingredients.length;
    const total = costRows.reduce((sum, row) => sum + row.cost, 0);
    const perServing = total / recipeYield;
    const profit = Number.isFinite(menuPrice) ? menuPrice - perServing : NaN;
    const margin = Number.isFinite(menuPrice) && menuPrice > 0 ? (profit / menuPrice) * 100 : NaN;
    const costPercent = Number.isFinite(menuPrice) && menuPrice > 0 ? (perServing / menuPrice) * 100 : NaN;

    const known = rows.filter((row) => Number.isFinite(row.batches));
    const limiting = known.length ? known.reduce((smallest, row) => row.batches < smallest.batches ? row : smallest, known[0]) : null;
    const servings = limiting ? Math.max(0, Math.floor(limiting.batches * recipeYield)) : null;
    const unknown = rows.length - known.length;
    const missing = rows.filter((row) => !row.item).length;
    const belowPar = rows.filter((row) => row.belowPar).length;
    let availabilityStatus = 'ready';
    if (!ingredients.length || unknown || missing) availabilityStatus = 'incomplete';
    else if (servings <= 0) availabilityStatus = 'unavailable';
    else if (servings < 12 || belowPar) availabilityStatus = 'attention';

    return {
      financials: { total, perServing, profit, margin, costPercent, incomplete: ingredients.length - costRows.length, complete: completeCosts && Number.isFinite(menuPrice) && menuPrice > 0 },
      availability: { servings, limiting, unknown, missing, belowPar, status: availabilityStatus },
      rows
    };
  }

  function formatIsk(value, fallback = '—') {
    return Number.isFinite(value) ? `${Math.round(value).toLocaleString('en-US')} ISK` : fallback;
  }

  window.AtlasCalculations = Object.freeze({ normalizeUnit, parsePackSize, ingredientMetrics, recipeMetrics, formatIsk });
})();
