(function () {
  'use strict';

  const FALLBACK_CATEGORIES = [
    { slug: 'signature-cocktail', name: 'Signature Cocktails', icon: 'sparkles', display_order: 10 },
    { slug: 'classic-cocktail', name: 'Classic Cocktails', icon: 'martini', display_order: 20 },
    { slug: 'frozen-cocktail', name: 'Frozen Cocktails', icon: 'snowflake', display_order: 30 },
    { slug: 'spritz', name: 'Spritzes', icon: 'wine', display_order: 40 },
    { slug: 'mocktail', name: 'Mocktails', icon: 'citrus', display_order: 50 },
    { slug: 'coffee', name: 'Coffee', icon: 'coffee', display_order: 60 },
    { slug: 'hot-cocktail', name: 'Hot Cocktails', icon: 'flame', display_order: 70 },
    { slug: 'food', name: 'Food', icon: 'utensils', display_order: 80 },
    { slug: 'dessert', name: 'Dessert', icon: 'cake-slice', display_order: 90 },
    { slug: 'other', name: 'Other', icon: 'layers-3', display_order: 100 }
  ];

  const state = {
    categories: [],
    categoryById: new Map(),
    categoryBySlug: new Map(),
    search: '',
    category: 'all',
    viewMode: 'grid',
    statusFilter: 'all',
    selectedRecipeId: null,
    phoneDetail: null,
    missingRecipe: null,
    pendingRoute: null,
    wakeLock: null,
    draftIngredients: [],
    editingRecipe: null,
    pendingImageFile: null,
    pendingImageObjectUrl: null,
    initialized: false,
    loadingCategories: null
  };

  const dom = {};

  // PHASE1_RECIPE_ROLE_GATE
  function canManageCommercial() {
    const profile = window.atlasCurrentProfile;
    if (profile?.active === true && ['admin', 'manager'].includes(profile.role)) return true;
    return typeof window.atlasCanManageCommercial === 'function'
      && window.atlasCanManageCommercial();
  }

  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  // Money is "3.900 kr" (spec §11 decision 5) through the venue clock's formatter.
  function formatIsk(value, empty = '—') {
    if (!Number.isFinite(value)) return empty;
    return window.AtlasFormat?.money ? window.AtlasFormat.money(value, empty) : window.AtlasCalculations.formatIsk(value, empty);
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
    if (['bottle', 'can', 'each'].includes(normalized)) return { quantity: 1, unit: normalized };
    return null;
  }

  function convertIngredientQuantity(quantity, unit) {
    const normalized = normalizeUnit(unit);
    if (normalized === 'l') return { quantity: quantity * 1000, unit: 'ml' };
    if (normalized === 'kg') return { quantity: quantity * 1000, unit: 'g' };
    return { quantity, unit: normalized };
  }

  function ingredientCost(ingredient) {
    if (window.AtlasCalculations) {
      const result = window.AtlasCalculations.ingredientMetrics(ingredient, items);
      return { value: result.cost, item: result.item, reason: result.reason };
    }
    const item = items.find((candidate) => candidate.id === ingredient.item_id);
    const purchaseCost = number(item?.cost_price, NaN);
    if (!item || !Number.isFinite(purchaseCost) || purchaseCost <= 0) {
      return { value: null, item, reason: 'Missing inventory cost' };
    }

    const requested = convertIngredientQuantity(number(ingredient.quantity), ingredient.unit);
    const pack = parsePackSize(item);
    if (!pack) return { value: null, item, reason: 'Missing package size' };

    if (pack.unit === requested.unit) {
      return { value: purchaseCost * (requested.quantity / pack.quantity), item, reason: null };
    }

    const eachLike = new Set(['each', 'bottle', 'can']);
    if (eachLike.has(pack.unit) && eachLike.has(requested.unit)) {
      return { value: purchaseCost * requested.quantity, item, reason: null };
    }

    return { value: null, item, reason: 'Unit does not match inventory package' };
  }

  function ingredientAvailability(ingredient) {
    if (window.AtlasCalculations) {
      const result = window.AtlasCalculations.ingredientMetrics(ingredient, items);
      return { servings: result.batches, item: result.item, reference: result.reference === true, reason: result.batches == null && !result.reference && result.item?.freshness_state !== 'current' ? 'Unknown / Not counted' : result.reason, belowPar: result.belowPar };
    }
    const item = items.find((candidate) => candidate.id === ingredient.item_id);
    if (!item) return { servings: null, item: null, reason: 'Inventory item is missing', belowPar: false };

    const requested = convertIngredientQuantity(number(ingredient.quantity), ingredient.unit);
    const pack = parsePackSize(item);
    if (!pack || requested.quantity <= 0) {
      return { servings: null, item, reason: 'Package size is missing', belowPar: false };
    }

    if (item.freshness_state !== 'current' || item.verified_quantity == null || !Number.isFinite(Number(item.verified_quantity))) {
      return { servings: null, item, reason: 'Current stock is unknown / Not counted', belowPar: false };
    }
    const stockUnits = Math.max(0, Number(item.verified_quantity));
    const belowPar = number(item.par_level) > 0 && stockUnits < number(item.par_level);
    let availableBatches = null;

    if (pack.unit === requested.unit) {
      availableBatches = (stockUnits * pack.quantity) / requested.quantity;
    } else {
      const eachLike = new Set(['each', 'bottle', 'can']);
      if (eachLike.has(pack.unit) && eachLike.has(requested.unit)) {
        availableBatches = stockUnits / requested.quantity;
      }
    }

    if (!Number.isFinite(availableBatches)) {
      return { servings: null, item, reason: 'Inventory unit does not match recipe unit', belowPar };
    }

    return {
      servings: Math.max(0, availableBatches),
      item,
      reason: null,
      belowPar
    };
  }

  function recipeAvailability(recipeOrIngredients, yieldValue) {
    const ingredients = Array.isArray(recipeOrIngredients)
      ? recipeOrIngredients
      : recipeOrIngredients?.recipe_ingredients || [];
    const recipeYield = Math.max(0.0001, yieldValue !== undefined
      ? number(yieldValue, 1)
      : number(recipeOrIngredients?.yield_quantity, 1));

    if (window.AtlasCalculations) {
      return window.AtlasCalculations.recipeMetrics({ recipe_ingredients: ingredients, yield_quantity: recipeYield }, items).availability;
    }

    if (!ingredients.length) {
      return { servings: null, limiting: null, unknown: 0, missing: 0, belowPar: 0, status: 'incomplete' };
    }

    const results = ingredients.map((ingredient) => ({ ingredient, ...ingredientAvailability(ingredient) }));
    const known = results.filter((result) => Number.isFinite(result.servings));
    const unknown = results.filter((result) => !Number.isFinite(result.servings));
    const missing = results.filter((result) => !result.item);
    const belowPar = results.filter((result) => result.belowPar);

    if (!known.length) {
      return { servings: null, limiting: unknown[0] || null, unknown: unknown.length, missing: missing.length, belowPar: belowPar.length, status: 'incomplete' };
    }

    const limiting = known.reduce((smallest, result) => result.servings < smallest.servings ? result : smallest, known[0]);
    const servings = Math.floor(limiting.servings * recipeYield);
    let status = 'ready';
    if (unknown.length || missing.length) status = 'incomplete';
    else if (servings <= 0) status = 'unavailable';
    else if (servings < 12 || belowPar.length) status = 'attention';

    return {
      servings,
      limiting,
      unknown: unknown.length,
      missing: missing.length,
      belowPar: belowPar.length,
      status
    };
  }

  function recipeFinancials(recipeOrIngredients, menuPriceValue, yieldValue) {
    const ingredients = Array.isArray(recipeOrIngredients)
      ? recipeOrIngredients
      : recipeOrIngredients?.recipe_ingredients || [];
    const rawPrice = menuPriceValue !== undefined ? menuPriceValue : recipeOrIngredients?.menu_price;
    const menuPrice = rawPrice == null || rawPrice === '' ? NaN : number(rawPrice, NaN);
    const recipeYield = Math.max(0.0001, yieldValue !== undefined
      ? number(yieldValue, 1)
      : number(recipeOrIngredients?.yield_quantity, 1));

    if (window.AtlasCalculations) {
      return window.AtlasCalculations.recipeMetrics({ recipe_ingredients: ingredients, menu_price: menuPrice, yield_quantity: recipeYield }, items).financials;
    }

    let total = 0;
    let incomplete = 0;
    ingredients.forEach((ingredient) => {
      const result = ingredientCost(ingredient);
      if (result.value == null) incomplete += 1;
      else total += result.value;
    });

    const costsKnown = ingredients.length > 0 && incomplete === 0;
    if (!costsKnown) total = null;
    const perServing = costsKnown ? total / recipeYield : null;
    const costPercent = costsKnown && Number.isFinite(menuPrice) && menuPrice > 0 ? (perServing / menuPrice) * 100 : NaN;
    const profit = costsKnown && Number.isFinite(menuPrice) ? menuPrice - perServing : NaN;
    const margin = Number.isFinite(menuPrice) && menuPrice > 0 ? (profit / menuPrice) * 100 : NaN;

    return { total, perServing, costPercent, profit, margin, incomplete };
  }

  function categoryFor(recipe) {
    if (recipe?.category_id && state.categoryById.has(recipe.category_id)) {
      return state.categoryById.get(recipe.category_id);
    }
    const slug = recipe?.type || 'other';
    return state.categoryBySlug.get(slug) || {
      id: null,
      slug,
      name: slug.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      icon: 'layers-3'
    };
  }

  async function loadCategories(force = false) {
    if (!force && state.categories.length) return state.categories;
    if (!force && state.loadingCategories) return state.loadingCategories;

    state.loadingCategories = (async () => {
      try {
        const { data, error } = await sb
          .from('recipe_categories')
          .select('id, slug, name, description, icon, display_order, active')
          .eq('active', true)
          .order('display_order', { ascending: true });
        if (error) throw error;
        state.categories = data?.length ? data : FALLBACK_CATEGORIES;
      } catch (error) {
        state.categories = FALLBACK_CATEGORIES;
      }
      state.categoryById = new Map(state.categories.filter((category) => category.id).map((category) => [category.id, category]));
      state.categoryBySlug = new Map(state.categories.map((category) => [category.slug, category]));
      state.loadingCategories = null;
      return state.categories;
    })();

    return state.loadingCategories;
  }

  // ---------- canonical readiness (parity-tested with supabase/functions/_shared/atlas-domain.mjs) ----------

  function recipeStatus(recipe) {
    const availability = recipeAvailability(recipe);
    if (recipe.active === false) return { key: 'draft', label: 'Draft', className: 'draft', availability };
    if (availability.status === 'unavailable') return { key: 'unavailable', label: 'Out of stock', className: 'danger', availability };
    if (availability.status === 'attention') return { key: 'attention', label: 'Low availability', className: 'warn', availability };
    if (availability.status === 'incomplete') return { key: 'incomplete', label: 'Incomplete', className: 'warn', availability };
    return { key: 'ready', label: 'Ready', className: 'ready', availability };
  }

  function ingredientIntelligence(recipe) {
    const yieldQuantity = Math.max(0.0001, number(recipe.yield_quantity, 1));
    return (recipe.recipe_ingredients || []).map((ingredient) => {
      const availability = ingredientAvailability(ingredient);
      const cost = ingredientCost(ingredient);
      const servings = Number.isFinite(availability.servings) ? Math.floor(availability.servings * yieldQuantity) : null;
      return { ingredient, availability, cost, servings };
    });
  }

  // The ingredients that stop a recipe's availability from being calculated,
  // with the real reason. availability.limiting is the smallest *known*
  // ingredient, which is not the cause when a recipe is incomplete.
  function recipeBlockers(recipe) {
    if (!window.AtlasCalculations) return [];
    const rows = window.AtlasCalculations.recipeMetrics(recipe, items).rows || [];
    return rows
      .filter((row) => !row.reference && !Number.isFinite(row.batches))
      .map((row) => {
        const name = row.item?.name || row.ingredient?.item_name || 'An ingredient';
        let reason = 'not linked to an inventory item';
        if (row.item && row.reason && /unit|package/i.test(row.reason)) reason = row.reason.toLowerCase();
        else if (row.item && !window.AtlasStockTruth?.known(row.item)) reason = 'no verified stock count';
        else if (row.item) reason = String(row.reason || 'stock cannot be calculated').toLowerCase();
        return { name, reason };
      });
  }

  // ---------- presentation of the canonical status (spec §7.7) ----------

  function limitingName(availability) {
    return availability?.limiting?.item?.name || availability?.limiting?.ingredient?.item_name || null;
  }

  // Pill word + tone and the one-line reason shown under unavailable tiles.
  function availabilityView(recipe) {
    const status = recipeStatus(recipe);
    const availability = status.availability;
    const limiting = limitingName(availability);
    if (status.key === 'draft') return { status, pill: 'Draft', tone: 'neutral', line: 'Archived — off service and off the menu' };
    if (status.key === 'unavailable') return { status, pill: 'Unavailable', tone: 'danger', line: limiting ? `${limiting}: out of stock` : 'An ingredient is out of stock' };
    if (status.key === 'attention') {
      const servings = Number.isFinite(availability.servings) ? availability.servings : null;
      return {
        status,
        pill: servings !== null ? `Low · ${servings} left` : 'Low',
        tone: 'warning',
        line: limiting && servings !== null ? `${limiting} runs out after about ${servings} ${servings === 1 ? 'serve' : 'serves'}` : availability.belowPar ? 'An ingredient is below par' : ''
      };
    }
    if (status.key === 'incomplete') {
      const blocker = recipeBlockers(recipe)[0];
      const notCounted = blocker && /verified stock count/.test(blocker.reason);
      return { status, pill: notCounted ? 'Not counted' : 'Setup incomplete', tone: 'neutral', line: blocker ? `${blocker.name}: ${blocker.reason}` : 'Add ingredients to check availability' };
    }
    return { status, pill: 'Available', tone: 'positive', line: '' };
  }

  function servingsText(recipe) {
    const view = availabilityView(recipe);
    const servings = view.status.availability.servings;
    if (view.status.key === 'draft') return 'Not on service';
    if (Number.isFinite(servings)) {
      const limiting = limitingName(view.status.availability);
      return servings === 0 ? (limiting ? `None tonight. ${limiting}: out of stock` : 'None tonight. An ingredient is out of stock') : `About ${servings} ${servings === 1 ? 'serve' : 'serves'} from counted stock`;
    }
    return 'Unknown until every ingredient is counted and linked';
  }

  function stockPill(item) {
    if (!item) return '<span class="atlas-pill">Not linked</span>';
    // The canonical AtlasStockTruth.stockStatus.
    const status = window.AtlasStockTruth?.stockStatus ? window.AtlasStockTruth.stockStatus(item) : 'unknown';
    if (status === 'unknown') return '<span class="atlas-pill">Not counted</span>';
    if (status === 'out') return '<span class="atlas-pill atlas-pill--danger">Out</span>';
    if (status === 'below_par') return '<span class="atlas-pill atlas-pill--warning">Below par</span>';
    return '<span class="atlas-pill atlas-pill--positive">In stock</span>';
  }

  function quantityText(ingredient) {
    const quantity = number(ingredient.quantity, NaN);
    const shown = Number.isFinite(quantity) ? String(Math.round(quantity * 100) / 100) : '—';
    return `${shown} ${ingredient.unit || ''}`.trim();
  }

  function formatPercent(value) {
    return Number.isFinite(value) ? `${Math.round(value)} %` : '—';
  }

  // ---------- library ----------

  const SEGMENTS = [['all', 'All'], ['available', 'Available'], ['unavailable', 'Unavailable'], ['draft', 'Drafts']];

  function matchesSegment(key) {
    switch (state.statusFilter) {
      case 'available': return key === 'ready' || key === 'attention';
      case 'unavailable': return key === 'unavailable';
      case 'draft': return key === 'draft';
      case 'attention': return ['attention', 'unavailable', 'incomplete'].includes(key);
      default: return key !== 'draft';
    }
  }

  function searchText(recipe) {
    const ingredients = (recipe.recipe_ingredients || []).map((ingredient) => ingredient.item_name).join(' ');
    return [recipe.name, categoryFor(recipe).name, recipe.glassware, recipe.garnish, ingredients].filter(Boolean).join(' ').toLowerCase();
  }

  function filteredRecipes() {
    const query = state.search.trim().toLowerCase();
    return recipes
      .filter((recipe) => {
        if (state.category !== 'all' && categoryFor(recipe).slug !== state.category) return false;
        if (!matchesSegment(recipeStatus(recipe).key)) return false;
        return !query || searchText(recipe).includes(query);
      })
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }

  function headSub() {
    if (recipesHealth() === 'failed' && !recipes.length) return 'Recipes couldn’t be loaded';
    if (recipesHealth() === 'loading' && !recipes.length) return 'Loading recipes…';
    const active = recipes.filter((recipe) => recipe.active !== false);
    const unavailable = active.filter((recipe) => recipeStatus(recipe).key === 'unavailable').length;
    const parts = [`${active.length} ${active.length === 1 ? 'recipe' : 'recipes'}`];
    if (unavailable) parts.push(`${unavailable} unavailable tonight`);
    // "None out of stock" only when every stock input loaded (never a guess).
    else if (active.length && dataLoaded() && stockHealth() === 'ok') parts.push('none out of stock');
    return parts.join(' · ');
  }

  function dataLoaded() {
    return Boolean(window.AtlasShell?.dataLoadedAt?.());
  }

  // Load health (index.html AtlasData.health()): 'loading' | 'ok' | 'failed'.
  // A failed load is never shown as an empty library (S90, review P1-3).
  function recipesHealth() {
    const health = window.AtlasData?.health?.()?.recipes;
    if (health) return health;
    return dataLoaded() ? 'ok' : 'loading';
  }
  function stockHealth() {
    const health = window.AtlasData?.health?.()?.stock;
    if (health) return health;
    return dataLoaded() ? 'ok' : 'loading';
  }

  // One summary for every surface (Home "At a glance", Recipes head): the same
  // canonical recipeStatus the library pills use. `unchecked` recipes are
  // unknown, never counted as available or as 0 unavailable.
  function summary() {
    const health = recipesHealth();
    const active = recipes.filter((recipe) => recipe.active !== false);
    const statuses = active.map((recipe) => ({ recipe, status: recipeStatus(recipe) }));
    return {
      state: health === 'failed' && !recipes.length ? 'failed' : health === 'loading' && !recipes.length ? 'loading' : 'ok',
      stale: health === 'failed' && recipes.length > 0,
      stock: stockHealth(),
      active: active.length,
      unavailable: statuses.filter((entry) => entry.status.key === 'unavailable').map((entry) => entry.recipe),
      attention: statuses.filter((entry) => entry.status.key === 'attention').map((entry) => entry.recipe),
      unchecked: statuses.filter((entry) => entry.status.key === 'incomplete').map((entry) => entry.recipe)
    };
  }

  function loadFailedMarkup() {
    return `<div class="atlas-alert atlas-alert--danger" role="alert"><i data-lucide="circle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__title">Recipes couldn’t be loaded.</p><p class="atlas-alert__body">Nothing was changed and your recipes are safe. Check your connection and try again.</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-recipe-retry>Try again</button></div></div>`;
  }

  function categoryChipMarkup() {
    const counts = new Map();
    recipes.filter((recipe) => matchesSegment(recipeStatus(recipe).key)).forEach((recipe) => {
      const category = categoryFor(recipe);
      counts.set(category.slug, (counts.get(category.slug) || 0) + 1);
    });
    const selected = state.category === 'all' ? null : state.categories.find((category) => category.slug === state.category) || categoryFor({ type: state.category });
    const options = [...counts.entries()]
      .map(([slug, count]) => ({ slug, count, name: (state.categoryBySlug.get(slug) || categoryFor({ type: slug })).name, order: state.categoryBySlug.get(slug)?.display_order ?? 999 }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    const item = (slug, label) => `<li role="none"><button type="button" class="atlas-menu__item" role="menuitemradio" aria-checked="${state.category === slug}" data-recipe-category="${escape(slug)}">${label}</button></li>`;
    // The menu is rendered outside the toolbar (categoryMenuMarkup): on phones
    // the toolbar scrolls sideways under a fade mask, and a mask clips every
    // descendant, fixed popovers included (S91a: the menu never showed).
    const menu = `<ul class="atlas-menu recipe-category-menu" role="menu" id="recipe-category-menu" aria-label="Category" hidden>
        <li class="recipe-category-menu__head" role="none"><span class="atlas-menu__label">Category</span></li>
        ${item('all', 'All categories')}
        ${options.map((option) => item(option.slug, `<span class="recipe-category-menu__name">${escape(option.name)}</span> <span class="atlas-badge atlas-badge--muted">${option.count}</span>`)).join('')}
      </ul>`;
    return {
      chip: `<span class="recipe-category-picker"><button type="button" class="atlas-chip${selected ? ' is-active' : ''}" id="recipe-category-trigger" aria-haspopup="menu" aria-expanded="false">${escape(selected ? selected.name : 'Category')}<i data-lucide="chevron-down"></i></button>${selected ? `<button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-recipe-category="all" aria-label="Clear category"><i data-lucide="x"></i></button>` : ''}</span>`,
      menu
    };
  }

  function toolbarMarkup(count) {
    const segments = SEGMENTS.filter(([key]) => key !== 'draft' || canManageCommercial());
    const attention = state.statusFilter === 'attention'
      ? '<button type="button" class="atlas-chip is-active" data-recipe-status="all">Needs attention<span class="atlas-chip__clear" aria-hidden="true"><i data-lucide="x"></i></span><span class="sr-only">Clear</span></button>'
      : '';
    const category = categoryChipMarkup();
    // Phones get the search on its own row above the filters (spec §8.3).
    return `<label class="atlas-search recipe-search--phone"><i data-lucide="search"></i><input class="atlas-input" type="search" id="recipe-search-phone" placeholder="Search recipes or ingredients" aria-label="Search recipes" value="${escape(state.search)}"></label>
      <div class="atlas-toolbar recipe-toolbar">
        <label class="atlas-search recipe-search--desktop"><i data-lucide="search"></i><input class="atlas-input" type="search" id="recipe-search" placeholder="Search recipes or ingredients" aria-label="Search recipes or ingredients" value="${escape(state.search)}"></label>
        <div class="atlas-segmented" role="group" aria-label="Availability">${segments.map(([key, label]) => `<button type="button" aria-pressed="${state.statusFilter === key}" data-recipe-status="${key}">${label}</button>`).join('')}</div>
        ${attention}
        ${category.chip}
        <div class="atlas-toolbar__end"><span>${count} ${count === 1 ? 'recipe' : 'recipes'}</span>
          <div class="atlas-segmented recipe-view-toggle" role="group" aria-label="Layout"><button type="button" aria-pressed="${state.viewMode === 'grid'}" data-recipe-view="grid" aria-label="Grid"><i data-lucide="layout-grid"></i></button><button type="button" aria-pressed="${state.viewMode === 'list'}" data-recipe-view="list" aria-label="List"><i data-lucide="list"></i></button></div>
        </div>
      </div>${category.menu}`;
  }

  function tileMarkup(recipe) {
    const view = availabilityView(recipe);
    const category = categoryFor(recipe);
    // No photo: a calm compact tile with the category's glass icon, never a
    // large grey placeholder (review P2-3, spec §8.3 recipe lookup).
    const media = recipe.image_url
      ? `<span class="recipe-tile__media"><img class="recipe-tile__img" src="${escape(recipe.image_url)}" alt="" loading="lazy" decoding="async"></span>`
      : `<span class="recipe-tile__glyph" aria-hidden="true"><i data-lucide="${escape(category.icon || 'martini')}"></i></span>`;
    return `<a class="recipe-tile${recipe.image_url ? '' : ' recipe-tile--plain'}" href="#recipes/${escape(encodeURIComponent(recipe.id))}" data-recipe-id="${escape(recipe.id)}">
        ${media}
        <span class="recipe-tile__body">
          <span class="recipe-tile__name">${escape(recipe.name)}</span>
          <span class="recipe-tile__meta"><span class="recipe-tile__category">${escape(category.name)}</span>${recipe.glassware ? `<span class="recipe-tile__glass"> · ${escape(recipe.glassware)}</span>` : ''}</span>
          <span class="recipe-tile__status"><span class="atlas-pill atlas-pill--${view.tone}">${escape(view.pill)}</span></span>
          ${view.line && view.status.key !== 'ready' ? `<span class="recipe-tile__line">${escape(view.line)}</span>` : ''}
        </span>
      </a>`;
  }

  function listMarkup(list) {
    const manager = canManageCommercial();
    return `<div class="atlas-table-wrap atlas-table-wrap--responsive"><table class="atlas-table">
        <thead><tr><th>Recipe</th><th data-priority="2">Category</th><th data-priority="3">Glass</th><th>Availability</th>${manager ? '<th class="is-num">Cost</th><th class="is-num" data-priority="2">Price</th><th class="is-num">Margin</th>' : ''}</tr></thead>
        <tbody>${list.map((recipe) => {
          const view = availabilityView(recipe);
          const financials = recipeFinancials(recipe);
          const costKnown = !financials.incomplete && Number.isFinite(financials.perServing);
          const price = recipe.menu_price == null || recipe.menu_price === '' ? NaN : number(recipe.menu_price, NaN);
          return `<tr><td><a class="cell-primary" href="#recipes/${escape(encodeURIComponent(recipe.id))}">${escape(recipe.name)}</a>${view.line && view.status.key !== 'ready' ? `<span class="cell-sub">${escape(view.line)}</span>` : ''}</td>
            <td data-priority="2">${escape(categoryFor(recipe).name)}</td><td data-priority="3">${escape(recipe.glassware || '—')}</td>
            <td><span class="atlas-pill atlas-pill--${view.tone}">${escape(view.pill)}</span></td>
            ${manager ? `<td class="is-num">${costKnown ? formatIsk(financials.perServing) : '<span title="An ingredient has no cost or package size">—</span>'}</td><td class="is-num" data-priority="2">${Number.isFinite(price) ? formatIsk(price) : '<span title="No menu price">—</span>'}</td><td class="is-num">${costKnown && Number.isFinite(financials.margin) ? formatPercent(financials.margin) : '<span title="Needs every ingredient cost and a menu price">—</span>'}</td>` : ''}</tr>`;
        }).join('')}</tbody></table></div>
      <ul class="atlas-table-list">${list.map((recipe) => {
        const view = availabilityView(recipe);
        return `<li><a class="atlas-table-list__row" href="#recipes/${escape(encodeURIComponent(recipe.id))}"><div class="atlas-table-list__body"><div class="atlas-table-list__title">${escape(recipe.name)}</div><div class="atlas-table-list__meta">${escape(view.line || categoryFor(recipe).name)}</div></div><div class="atlas-table-list__value"><span class="atlas-pill atlas-pill--${view.tone}">${escape(view.pill)}</span></div></a></li>`;
      }).join('')}</ul>`;
  }

  function libraryMarkup() {
    const manager = canManageCommercial();
    const actions = manager ? [{ label: 'Public menu', icon: 'qr-code', variant: 'secondary', attrs: { 'data-recipe-menu-link': '' } }, { label: 'New recipe', icon: 'plus', variant: 'primary', attrs: { 'data-recipe-new': '' } }] : [];
    const head = window.AtlasShell.pageHead({ title: 'Recipes', sub: headSub(), actions });
    if (recipesHealth() === 'failed' && !recipes.length) return `${head}${loadFailedMarkup()}`;
    if ((!dataLoaded() || recipesHealth() === 'loading') && !recipes.length) {
      return `${head}${toolbarMarkup(0)}<div class="recipe-grid" aria-busy="true" aria-label="Loading recipes">${Array.from({ length: 8 }, () => '<span class="recipe-tile recipe-tile--skeleton"><span class="atlas-skel atlas-skel--block recipe-tile__media"></span><span class="recipe-tile__body"><span class="atlas-skel atlas-skel--title"></span><span class="atlas-skel atlas-skel--text"></span></span></span>').join('')}</div>`;
    }
    if (!recipes.length) {
      return `${head}<div class="atlas-empty atlas-empty--page"><div class="atlas-empty__icon"><i data-lucide="martini"></i></div><h3 class="atlas-empty__title">No recipes yet</h3><p class="atlas-empty__text">${manager ? 'Add your first recipe and link its ingredients to stock to see what you can serve.' : 'A manager adds recipes. They appear here with what you can serve tonight.'}</p>${manager ? '<div class="atlas-empty__actions"><button type="button" class="atlas-btn atlas-btn--secondary" data-recipe-new><i data-lucide="plus"></i>New recipe</button></div>' : ''}</div>`;
    }
    const list = filteredRecipes();
    let content;
    if (!list.length) {
      const what = state.search ? `“${state.search}”` : 'these filters';
      content = `<div class="atlas-empty"><div class="atlas-empty__icon"><i data-lucide="search-x"></i></div><h3 class="atlas-empty__title">No recipes match ${escape(what)}</h3><p class="atlas-empty__text">Search looks at recipe names, categories, glassware and ingredients.</p><div class="atlas-empty__actions"><button type="button" class="atlas-btn atlas-btn--secondary" data-recipe-clear>Clear filters</button></div></div>`;
    } else if (state.viewMode === 'list') content = listMarkup(list);
    else content = `<div class="recipe-grid${list.some((recipe) => recipe.image_url) ? '' : ' recipe-grid--plain'}">${list.map(tileMarkup).join('')}</div>`;
    const stale = dataLoaded() && !navigator.onLine
      ? '<div class="atlas-alert atlas-alert--warning"><i data-lucide="wifi-off"></i><div class="atlas-alert__content"><p class="atlas-alert__body">You\'re offline. Showing recipes and stock from the last time Atlas loaded.</p></div></div>'
      : recipesHealth() === 'failed'
        ? '<div class="atlas-alert atlas-alert--warning"><i data-lucide="triangle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__body">Recipes couldn’t be refreshed. Showing them as they were last loaded; nothing was changed.</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-recipe-retry>Try again</button></div></div>'
        : '';
    return `${head}${stale}${toolbarMarkup(list.length)}${content}`;
  }

  // ---------- detail (#recipes/<id>) ----------

  function methodMarkup(text) {
    const value = String(text || '').trim();
    if (!value) return '<p class="recipe-muted">No method yet.</p>';
    const steps = value.split(/\n+/).map((line) => line.replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim()).filter(Boolean);
    return steps.length > 1
      ? `<ol class="recipe-method">${steps.map((step) => `<li>${escape(step)}</li>`).join('')}</ol>`
      : `<p class="recipe-method recipe-method--single">${escape(steps[0] || value)}</p>`;
  }

  function detailBody(recipe) {
    const manager = canManageCommercial();
    const view = availabilityView(recipe);
    const rows = ingredientIntelligence(recipe);
    const financials = recipeFinancials(recipe);
    const costKnown = !financials.incomplete && Number.isFinite(financials.perServing);
    const price = recipe.menu_price == null || recipe.menu_price === '' ? NaN : number(recipe.menu_price, NaN);
    const blockers = view.status.key === 'incomplete' ? recipeBlockers(recipe) : [];
    const alert = view.status.key === 'unavailable' || view.status.key === 'attention'
      ? `<div class="atlas-alert atlas-alert--${view.status.key === 'unavailable' ? 'danger' : 'warning'}"><i data-lucide="${view.status.key === 'unavailable' ? 'circle-alert' : 'triangle-alert'}"></i><div class="atlas-alert__content"><p class="atlas-alert__body">${escape(view.line || view.pill)}</p></div></div>`
      : blockers.length
        ? `<div class="atlas-alert atlas-alert--info"><i data-lucide="info"></i><div class="atlas-alert__content"><p class="atlas-alert__title">Why availability is unknown</p><p class="atlas-alert__body">${blockers.map((entry) => `${escape(entry.name)}: ${escape(entry.reason)}`).join('<br>')}</p></div></div>`
        : '';
    const build = rows.length
      ? `<ul class="recipe-build">${rows.map(({ ingredient, availability, cost }) => {
          const item = availability.item;
          const name = item?.name || ingredient.item_name || 'Ingredient';
          const link = item?.id ? `<a href="#inventory/item/${escape(encodeURIComponent(item.id))}">${escape(name)}</a>` : escape(name);
          return `<li class="recipe-build__row"><span class="recipe-build__qty num">${escape(quantityText(ingredient))}</span><span class="recipe-build__name">${link}</span><span class="recipe-build__end">${availability.reference ? '<span class="atlas-pill">Not stock-tracked</span>' : stockPill(item)}${manager ? `<span class="recipe-build__cost num">${cost.value == null ? '<span title="No cost or package size">—</span>' : formatIsk(cost.value)}</span>` : ''}</span></li>`;
        }).join('')}</ul>`
      : '<p class="recipe-muted">No ingredients yet.</p>';
    const facts = [['Glass', recipe.glassware], ['Garnish', recipe.garnish], ['Makes', `${number(recipe.yield_quantity, 1)} ${recipe.yield_unit || 'serving'}`]];
    const money = manager ? `<section class="recipe-section" aria-labelledby="recipe-money-title">
        <h3 class="recipe-section__title" id="recipe-money-title">Cost and price</h3>
        <div class="atlas-stats recipe-stats">
          <div class="atlas-stat"><p class="atlas-stat__label">Cost per serve</p><p class="atlas-stat__value">${costKnown ? formatIsk(financials.perServing) : '—'}</p><p class="atlas-stat__detail">${costKnown ? 'From linked item costs' : `${financials.incomplete} ${financials.incomplete === 1 ? 'ingredient has' : 'ingredients have'} no cost or pack size`}</p></div>
          <div class="atlas-stat"><p class="atlas-stat__label">Menu price</p><p class="atlas-stat__value">${Number.isFinite(price) ? formatIsk(price) : '—'}</p><p class="atlas-stat__detail">${Number.isFinite(price) ? 'Set on this recipe' : 'Not set'}</p></div>
          <div class="atlas-stat"><p class="atlas-stat__label">Theoretical margin</p><p class="atlas-stat__value">${costKnown && Number.isFinite(financials.margin) ? formatPercent(financials.margin) : '—'}</p><p class="atlas-stat__detail">${costKnown && Number.isFinite(financials.profit) ? `${formatIsk(financials.profit)} per serve` : 'Needs costs and a price'}</p></div>
        </div>
        <p class="recipe-muted">Theoretical margin comes from recipe costs. Realised margin needs sales data, and no sales system is connected.</p>
      </section>` : '';
    const archive = manager ? `<section class="recipe-section recipe-manage">
        ${recipe.active === false
          ? '<button type="button" class="atlas-btn atlas-btn--secondary" data-restore-recipe><i data-lucide="archive-restore"></i>Restore to service</button><button type="button" class="atlas-btn atlas-btn--danger" data-delete-recipe><i data-lucide="trash-2"></i>Delete permanently</button>'
          : '<button type="button" class="atlas-btn atlas-btn--ghost" data-archive-recipe><i data-lucide="archive"></i>Archive</button>'}
      </section>` : '';
    return `${recipe.image_url ? `<img class="recipe-photo" src="${escape(recipe.image_url)}" alt="${escape(recipe.name)}">` : ''}
      <div class="recipe-detail-status"><span class="atlas-pill atlas-pill--${view.tone}">${escape(view.pill)}</span><span class="recipe-muted">${escape(servingsText(recipe))}</span></div>
      ${alert}
      <section class="recipe-section" aria-labelledby="recipe-build-title"><h3 class="recipe-section__title" id="recipe-build-title">Build</h3>${build}</section>
      <section class="recipe-section" aria-labelledby="recipe-method-title"><h3 class="recipe-section__title" id="recipe-method-title">Method</h3>${methodMarkup(recipe.method)}</section>
      <dl class="recipe-facts">${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value || '—')}</dd></div>`).join('')}</dl>
      ${recipe.notes ? `<section class="recipe-section"><h3 class="recipe-section__title">Notes</h3><p class="recipe-notes">${escape(recipe.notes)}</p></section>` : ''}
      ${money}${archive}`;
  }

  // Moving to a shorter route of the same view (#recipes/<id> → #recipes)
  // through the hash, so the address bar and history follow.
  function go(hash) {
    if (location.hash === hash) return;
    location.hash = hash;
  }

  function isPhone() {
    return window.matchMedia?.('(max-width: 767px)').matches;
  }

  function detailSheet() {
    let modal = document.getElementById('recipe-detail-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'recipe-detail-modal';
      modal.className = 'atlas-modal';
      modal.hidden = true;
      modal.setAttribute('data-atlas-modal', '');
      document.body.appendChild(modal);
      window.AtlasModal.register(modal, { closeOnBackdrop: true, onClose: (reason) => onDetailClosed(reason) });
      modal.addEventListener('click', handleDetailClick);
    }
    return modal;
  }

  function detailHeadActions(recipe) {
    return `<button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" data-recipe-ask><i data-lucide="sparkles"></i>Ask Atlas</button>${canManageCommercial() ? `<a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#recipes/${escape(encodeURIComponent(recipe.id))}/edit"><i data-lucide="pencil"></i>Edit</a>` : ''}`;
  }

  function openDetail(recipeId) {
    const recipe = recipes.find((entry) => String(entry.id) === String(recipeId));
    state.selectedRecipeId = recipe ? recipe.id : null;
    if (!recipe) {
      // Recipes that failed to load: reopen this recipe after Try again,
      // never "it may have been deleted".
      if (recipesHealth() === 'failed') state.pendingRoute = { recipe: recipeId };
      else state.missingRecipe = recipeId;
      render();
      return;
    }
    state.missingRecipe = null;
    if (isPhone()) {
      closeDetailSheet('route');
      state.phoneDetail = recipe.id;
      render();
      window.AtlasChrome?.setTopBar?.({ title: recipe.name, back: '#recipes', actions: [{ icon: 'sparkles', label: 'Ask Atlas', run: () => askAbout(recipe) }] });
      keepAwake(true);
      return;
    }
    state.phoneDetail = null;
    const modal = detailSheet();
    modal.dataset.recipeId = recipe.id;
    const category = categoryFor(recipe);
    modal.innerHTML = `<section class="atlas-sheet atlas-sheet--wide atlas-sheet--full-phone recipe-sheet" data-modal-panel aria-labelledby="recipe-detail-title">
        <span class="atlas-sheet__grabber"></span>
        <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="recipe-detail-title">${escape(recipe.name)}</h2><p class="atlas-sheet__desc">${escape([category.name, recipe.glassware].filter(Boolean).join(' · '))}</p></div><div class="recipe-sheet__actions">${detailHeadActions(recipe)}</div><button type="button" class="atlas-icon-btn atlas-sheet__close" aria-label="Close" data-modal-close><i data-lucide="x"></i></button></header>
        <div class="atlas-sheet__body recipe-detail" tabindex="-1">${detailBody(recipe)}</div>
      </section>`;
    if (!window.AtlasModal.isOpen(modal)) window.AtlasModal.open(modal);
    keepAwake(true);
    if (window.lucide) window.lucide.createIcons();
  }

  function phoneDetailMarkup(recipe) {
    return `<article class="recipe-screen" aria-labelledby="recipe-screen-title">
        <h1 class="recipe-screen__title" id="recipe-screen-title">${escape(recipe.name)}</h1>
        <p class="recipe-muted">${escape([categoryFor(recipe).name, recipe.glassware].filter(Boolean).join(' · '))}</p>
        <div class="recipe-screen__actions">${detailHeadActions(recipe)}</div>
        <div class="recipe-detail">${detailBody(recipe)}</div>
      </article>`;
  }

  function closeDetailSheet(reason = 'route') {
    const modal = document.getElementById('recipe-detail-modal');
    if (modal && window.AtlasModal.isOpen(modal)) {
      modal.dataset.closing = reason;
      window.AtlasModal.close(modal, reason);
    }
  }

  function onDetailClosed(reason) {
    keepAwake(false);
    const modal = document.getElementById('recipe-detail-modal');
    const programmatic = modal?.dataset.closing;
    if (modal) delete modal.dataset.closing;
    if (programmatic) return;
    // Closed by the user (Esc, close button, backdrop): return to the library route.
    const route = window.AtlasShell?.parseRoute?.(location.hash);
    if (route?.view === 'recipes' && route.params.recipe) go('#recipes');
    state.selectedRecipeId = null;
  }

  function handleDetailClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const recipe = recipes.find((entry) => String(entry.id) === String(state.selectedRecipeId));
    if (!recipe) return;
    if (target.closest('[data-recipe-ask]')) { askAbout(recipe); return; }
    if (target.closest('[data-archive-recipe]')) { setRecipeActive(recipe, false); return; }
    if (target.closest('[data-restore-recipe]')) { setRecipeActive(recipe, true); return; }
    if (target.closest('[data-delete-recipe]')) deleteRecipe(recipe);
  }

  function askAbout(recipe) {
    window.AtlasAI?.askAbout?.({ type: 'recipe', id: recipe.id, label: recipe.name });
  }

  async function keepAwake(on) {
    try {
      if (on && !state.wakeLock && navigator.wakeLock?.request) state.wakeLock = await navigator.wakeLock.request('screen');
      if (!on && state.wakeLock) { await state.wakeLock.release(); state.wakeLock = null; }
    } catch {
      state.wakeLock = null;
    }
  }

  // ---------- editor (#recipes/<id>/edit, #recipes/new/edit) ----------

  function editorMarkup(recipe) {
    const units = ['ml', 'cl', 'l', 'g', 'kg', 'tsp', 'tbsp', 'each', 'bottle', 'can', 'dash', 'barspoon', 'piece'];
    return `<section class="atlas-sheet atlas-sheet--wide atlas-sheet--full-phone recipe-sheet" data-modal-panel aria-labelledby="recipe-modal-title">
      <span class="atlas-sheet__grabber"></span>
      <header class="atlas-sheet__head"><div><h2 class="atlas-sheet__title" id="recipe-modal-title">${recipe ? `Edit ${escape(recipe.name)}` : 'New recipe'}</h2><p class="atlas-sheet__desc" id="recipe-modal-subtitle">${recipe ? 'Changes apply to service as soon as you save.' : 'Link each ingredient to an item so availability and cost stay current.'}</p></div>
        ${recipe ? `<span class="recipe-editor-more"><button type="button" class="atlas-icon-btn" id="recipe-editor-more" aria-label="More actions" aria-haspopup="menu" aria-expanded="false"><i data-lucide="ellipsis"></i></button><ul class="atlas-menu" role="menu" id="recipe-editor-menu" aria-label="Recipe actions" hidden>${recipe.active === false
          ? '<li><button type="button" class="atlas-menu__item" role="menuitem" data-editor-action="restore"><i data-lucide="archive-restore"></i>Restore to service</button></li><li><button type="button" class="atlas-menu__item atlas-menu__item--danger" role="menuitem" data-editor-action="delete"><i data-lucide="trash-2"></i>Delete permanently</button></li>'
          : '<li><button type="button" class="atlas-menu__item" role="menuitem" data-editor-action="archive"><i data-lucide="archive"></i>Archive</button></li>'}</ul></span>` : ''}
        <button type="button" class="atlas-icon-btn atlas-sheet__close" aria-label="Close editor" data-modal-close><i data-lucide="x"></i></button></header>
      <form id="recipe-form" class="recipe-form" novalidate>
        <div class="atlas-sheet__body">
          <input type="hidden" id="recipe-id">
          <fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Details</legend>
            <div class="atlas-field"><label for="recipe-name">Name</label><input class="atlas-input" id="recipe-name" required maxlength="160" placeholder="e.g. Espresso martini"></div>
            <div class="atlas-field"><label for="recipe-category-id">Category</label><select class="atlas-select" id="recipe-category-id"></select></div>
            <div class="atlas-field"><span class="atlas-label" id="recipe-photo-label">Photo <span class="optional">(optional)</span></span>
              <div class="atlas-upload recipe-upload">
                <div class="atlas-upload__thumb"><img id="recipe-image-preview" alt="Recipe photo" hidden><i data-lucide="image" id="recipe-image-icon"></i></div>
                <div class="atlas-upload__body"><p class="atlas-upload__title">JPEG, PNG or WebP</p><p class="atlas-upload__help">Up to 10 MB. Large photos are resized on this device.</p></div>
                <label class="atlas-btn atlas-btn--secondary atlas-btn--sm" for="recipe-image-file">Choose</label>
                <input class="sr-only" type="file" id="recipe-image-file" accept="image/jpeg,image/png,image/webp,image/heic" aria-labelledby="recipe-photo-label">
                <button type="button" class="atlas-btn atlas-btn--ghost atlas-btn--sm" id="recipe-image-remove">Remove</button>
              </div>
              <input type="hidden" id="recipe-image-url">
            </div>
          </fieldset>
          <fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Ingredients</legend>
            <div class="recipe-ingredient-picker">
              <div class="atlas-field recipe-ingredient-picker__search"><label for="ingredient-search">Find an item</label><input class="atlas-input" id="ingredient-search" type="search" placeholder="Search items" autocomplete="off"></div>
              <div class="atlas-field recipe-ingredient-picker__item"><label for="ingredient-item">Item</label><select class="atlas-select" id="ingredient-item"></select></div>
              <div class="atlas-field"><label for="ingredient-qty">Quantity</label><input class="atlas-input" id="ingredient-qty" inputmode="decimal" placeholder="45"></div>
              <div class="atlas-field"><label for="ingredient-unit">Unit</label><select class="atlas-select" id="ingredient-unit">${units.map((unit) => `<option value="${unit}">${unit}</option>`).join('')}</select></div>
              <button type="button" class="atlas-btn atlas-btn--secondary" id="add-ingredient-btn"><i data-lucide="plus"></i>Add</button>
            </div>
            <p class="error" id="ingredient-error" hidden></p>
            <ul class="atlas-list recipe-ingredient-list" id="ingredient-list"></ul>
          </fieldset>
          <fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Method</legend>
            <div class="atlas-field"><label for="recipe-method">Steps</label><textarea class="atlas-textarea" id="recipe-method" rows="5" placeholder="One step per line"></textarea><p class="help">One step per line — they show numbered at the bar.</p></div>
          </fieldset>
          <fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Service</legend>
            <div class="atlas-grid-2">
              <div class="atlas-field"><label for="recipe-glassware">Glass</label><input class="atlas-input" id="recipe-glassware" placeholder="e.g. Coupe"></div>
              <div class="atlas-field"><label for="recipe-garnish">Garnish</label><input class="atlas-input" id="recipe-garnish" placeholder="e.g. Orange twist"></div>
              <div class="atlas-field"><label for="recipe-yield-qty">Makes</label><input class="atlas-input" id="recipe-yield-qty" inputmode="decimal" value="1"></div>
              <div class="atlas-field"><label for="recipe-yield-unit">Unit</label><input class="atlas-input" id="recipe-yield-unit" value="serving"></div>
            </div>
            <div class="atlas-field"><label for="recipe-notes">Notes <span class="optional">(optional)</span></label><textarea class="atlas-textarea" id="recipe-notes" rows="2" placeholder="Allergens, substitutions, prep"></textarea></div>
            <label class="atlas-check-row"><input type="checkbox" class="atlas-check" id="recipe-active" checked>On service (unticked keeps it as an archived draft)</label>
            <label class="atlas-check-row"><input type="checkbox" class="atlas-check" id="recipe-show-on-menu" checked>Show on the public menu</label>
          </fieldset>
          <fieldset class="atlas-form-group"><legend class="atlas-form-group__title">Price</legend>
            <div class="atlas-field"><label for="recipe-menu-price">Menu price</label><div class="atlas-affix"><input class="atlas-input" id="recipe-menu-price" inputmode="numeric" placeholder="3290"><span class="suffix">kr</span></div></div>
            <dl class="recipe-cost-figures">
              <div><dt>Recipe cost</dt><dd class="num" id="calc-total-cost">—</dd></div>
              <div><dt>Cost per serve</dt><dd class="num" id="calc-cost-per-serving">—</dd></div>
              <div><dt>Cost %</dt><dd class="num" id="calc-cost-pct">—</dd></div>
              <div><dt>Profit per serve</dt><dd class="num" id="calc-profit">—</dd></div>
            </dl>
            <p class="help" id="recipe-cost-note"></p>
            <p class="help" id="recipe-availability-note"><span></span></p>
          </fieldset>
        </div>
        <footer class="atlas-sheet__foot"><span class="atlas-sheet__foot-start recipe-save-state" id="recipe-save-state" role="status"></span><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>Cancel</button><button type="submit" class="atlas-btn atlas-btn--primary">Save recipe</button></footer>
      </form>
    </section>`;
  }

  function editorModal() {
    let modal = document.getElementById('recipe-overlay');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'recipe-overlay';
      modal.className = 'atlas-modal';
      modal.hidden = true;
      modal.setAttribute('data-atlas-modal', '');
      document.body.appendChild(modal);
      window.AtlasModal.register(modal, { closeOnBackdrop: false, initialFocus: '#recipe-name', onClose: onEditorClosed });
    }
    return modal;
  }

  function cacheEditorDom(modal) {
    dom.modal = modal;
    dom.form = modal.querySelector('#recipe-form');
    dom.modalTitle = modal.querySelector('#recipe-modal-title');
    dom.modalSubtitle = modal.querySelector('#recipe-modal-subtitle');
    dom.categorySelect = modal.querySelector('#recipe-category-id');
    dom.ingredientSelect = modal.querySelector('#ingredient-item');
    dom.ingredientSearch = modal.querySelector('#ingredient-search');
    dom.ingredientList = modal.querySelector('#ingredient-list');
    dom.saveState = modal.querySelector('#recipe-save-state');
    dom.imageFile = modal.querySelector('#recipe-image-file');
    dom.imagePreview = modal.querySelector('#recipe-image-preview');
    dom.imageRemove = modal.querySelector('#recipe-image-remove');
  }

  function bindEditor(modal, recipe) {
    modal.querySelector('#add-ingredient-btn').addEventListener('click', addIngredientFromForm);
    dom.ingredientSearch.addEventListener('input', () => populateIngredientSelect(dom.ingredientSearch.value));
    dom.ingredientSearch.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); modal.querySelector('#ingredient-qty').focus(); } });
    modal.querySelector('#ingredient-qty').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addIngredientFromForm(); } });
    dom.ingredientList.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-remove-ingredient]');
      const move = event.target.closest('[data-move-ingredient]');
      if (remove) {
        state.draftIngredients.splice(Number(remove.dataset.removeIngredient), 1);
        renderIngredientList();
      } else if (move) {
        const index = Number(move.dataset.moveIngredient);
        const to = index + Number(move.dataset.direction);
        if (to < 0 || to >= state.draftIngredients.length) return;
        const [entry] = state.draftIngredients.splice(index, 1);
        state.draftIngredients.splice(to, 0, entry);
        renderIngredientList();
        dom.ingredientList.querySelector(`[data-move-ingredient="${to}"][data-direction="${move.dataset.direction}"]`)?.focus();
      }
    });
    ['recipe-yield-qty', 'recipe-menu-price'].forEach((id) => modal.querySelector(`#${id}`)?.addEventListener('input', renderDraftFinancials));
    dom.imageFile.addEventListener('change', handleRecipeImageSelection);
    dom.imageRemove.addEventListener('click', clearRecipeImage);
    dom.form.addEventListener('submit', saveRecipe);
    const more = modal.querySelector('#recipe-editor-more');
    const menu = modal.querySelector('#recipe-editor-menu');
    if (more && menu && recipe) {
      window.AtlasShell?.menu?.(more, menu, {
        onSelect: (item) => {
          const action = item?.dataset?.editorAction;
          if (action === 'archive') setRecipeActive(recipe, false);
          else if (action === 'restore') setRecipeActive(recipe, true);
          else if (action === 'delete') deleteRecipe(recipe);
        }
      });
    }
  }

  async function openEditor(recipe) {
    if (!canManageCommercial()) {
      window.AtlasShell?.toast?.('Recipe editing is for managers. Ask an administrator if you need access.');
      return;
    }
    closeDetailSheet('route');
    await loadCategories();
    const modal = editorModal();
    modal.innerHTML = editorMarkup(recipe);
    cacheEditorDom(modal);
    bindEditor(modal, recipe);
    state.editingRecipe = recipe || null;
    state.draftIngredients = (recipe?.recipe_ingredients || []).map((ingredient) => ({
      item_id: ingredient.item_id,
      item_name: ingredient.item_name,
      quantity: number(ingredient.quantity),
      unit: ingredient.unit
    }));
    document.getElementById('recipe-id').value = recipe?.id || '';
    document.getElementById('recipe-name').value = recipe?.name || '';
    populateCategorySelect(recipe?.category_id, recipe?.type || 'signature-cocktail');
    revokePendingImageUrl();
    state.pendingImageFile = null;
    document.getElementById('recipe-image-url').value = recipe?.image_url || '';
    setRecipeImagePreview(recipe?.image_url || '');
    document.getElementById('recipe-glassware').value = recipe?.glassware || '';
    document.getElementById('recipe-garnish').value = recipe?.garnish || '';
    document.getElementById('recipe-method').value = recipe?.method || '';
    document.getElementById('recipe-notes').value = recipe?.notes || '';
    document.getElementById('recipe-yield-qty').value = number(recipe?.yield_quantity, 1);
    document.getElementById('recipe-yield-unit').value = recipe?.yield_unit || 'serving';
    document.getElementById('recipe-menu-price').value = recipe?.menu_price ?? '';
    document.getElementById('recipe-active').checked = recipe?.active !== false;
    document.getElementById('recipe-show-on-menu').checked = recipe?.show_on_menu !== false;
    populateIngredientSelect('');
    renderIngredientList();
    if (!window.AtlasModal.isOpen(modal)) window.AtlasModal.open(modal);
    if (window.lucide) window.lucide.createIcons();
  }

  function onEditorClosed(reason) {
    const saved = reason === 'saved';
    const recipeId = state.editingRecipe?.id || null;
    resetEditor();
    if (reason === 'route' || saved) return;
    const route = window.AtlasShell?.parseRoute?.(location.hash);
    if (route?.view === 'recipes' && route.params.edit) go(recipeId ? `#recipes/${encodeURIComponent(recipeId)}` : '#recipes');
  }

  function closeEditor(reason = 'route') {
    const modal = document.getElementById('recipe-overlay');
    if (modal && window.AtlasModal.isOpen(modal)) window.AtlasModal.close(modal, reason);
  }

  function populateCategorySelect(selectedId, selectedSlug) {
    if (!dom.categorySelect) return;
    dom.categorySelect.innerHTML = state.categories.map((category) => {
      const selected = selectedId ? category.id === selectedId : category.slug === selectedSlug;
      return `<option value="${escape(category.id || '')}" data-slug="${escape(category.slug)}" ${selected ? 'selected' : ''}>${escape(category.name)}</option>`;
    }).join('');
  }

  function stockLabel(item) {
    return window.AtlasStockTruth?.known?.(item) && item.verified_quantity != null && Number.isFinite(Number(item.verified_quantity))
      ? `${Number(item.verified_quantity)} ${item.unit || ''}`.trim() : 'Not counted';
  }

  function populateIngredientSelect(query = '') {
    if (!dom.ingredientSelect) return;
    const text = String(query || '').trim().toLowerCase();
    const available = items
      .filter((item) => item.active !== false)
      .filter((item) => !text || `${item.name} ${item.category || ''}`.toLowerCase().includes(text))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .slice(0, 200);
    dom.ingredientSelect.innerHTML = available.length
      ? available.map((item) => `<option value="${escape(item.id)}">${escape(item.name)} · ${escape(stockLabel(item))}</option>`).join('')
      : `<option value="">${text ? 'No items match' : 'No active items'}</option>`;
  }

  function setRecipeImagePreview(src) {
    if (!dom.imagePreview) return;
    const icon = document.getElementById('recipe-image-icon');
    if (src) {
      dom.imagePreview.src = src;
      dom.imagePreview.hidden = false;
      if (icon) icon.hidden = true;
    } else {
      dom.imagePreview.removeAttribute('src');
      dom.imagePreview.hidden = true;
      if (icon) icon.hidden = false;
    }
    if (dom.imageRemove) dom.imageRemove.hidden = !src;
  }

  function revokePendingImageUrl() {
    if (state.pendingImageObjectUrl) {
      URL.revokeObjectURL(state.pendingImageObjectUrl);
      state.pendingImageObjectUrl = null;
    }
  }

  function setSaveState(message, error = false) {
    if (!dom.saveState) return;
    dom.saveState.textContent = message;
    dom.saveState.className = `atlas-sheet__foot-start recipe-save-state${error ? ' is-error' : ''}`;
  }

  function handleRecipeImageSelection(event) {
    const file = event.target.files?.[0] || null;
    revokePendingImageUrl();
    state.pendingImageFile = null;
    if (!file) {
      setRecipeImagePreview(document.getElementById('recipe-image-url')?.value.trim() || '');
      return;
    }
    if (!file.type.startsWith('image/')) {
      event.target.value = '';
      setSaveState('Choose a JPEG, PNG or WebP photo.', true);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      event.target.value = '';
      setSaveState('Photos must be 10 MB or smaller.', true);
      return;
    }
    setSaveState('');
    state.pendingImageFile = file;
    state.pendingImageObjectUrl = URL.createObjectURL(file);
    setRecipeImagePreview(state.pendingImageObjectUrl);
  }

  function clearRecipeImage() {
    revokePendingImageUrl();
    state.pendingImageFile = null;
    if (dom.imageFile) dom.imageFile.value = '';
    const urlInput = document.getElementById('recipe-image-url');
    if (urlInput) urlInput.value = '';
    setRecipeImagePreview('');
  }

  // Photos are decoded and re-encoded on the device: large camera images are
  // resized, and formats other browsers cannot display (HEIC) never reach the
  // public menu. A photo the browser cannot decode is rejected with a reason.
  async function prepareRecipeImage(file) {
    const MAX_EDGE = 1600;
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw Object.assign(new Error('format'), { userMessage: 'This photo format can\'t be shown on every device. Choose a JPEG, PNG or WebP photo.' });
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      bitmap.close?.();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob) throw Object.assign(new Error('prepare'), { userMessage: 'The photo couldn\'t be prepared. Try another photo.' });
    return new File([blob], (file.name.replace(/\.[^.]+$/, '') || 'recipe') + '.jpg', { type: 'image/jpeg' });
  }

  async function uploadRecipeImage(original) {
    if (!original) return null;
    const file = await prepareRecipeImage(original);
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const userId = currentUser?.id || 'unknown';
    const objectName = `recipes/${userId}/${(window.crypto?.randomUUID?.() || ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, (c) => (c ^ (window.crypto?.getRandomValues?.(new Uint8Array(1))[0] ?? Math.random() * 256) & 15 >> c / 4).toString(16)))}.${ext}`;
    const { data: upload, error: uploadError } = await sb.storage
      .from('atlas-media')
      .upload(objectName, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || undefined
      });
    if (uploadError) throw Object.assign(new Error('upload'), { userMessage: 'The photo couldn\'t be uploaded. The recipe was not saved. Try again or remove the photo.' });
    const { data } = sb.storage.from('atlas-media').getPublicUrl(upload.path);
    if (!data?.publicUrl) throw Object.assign(new Error('link'), { userMessage: 'The photo uploaded but its link couldn\'t be created. Try again.' });
    return data.publicUrl;
  }

  function resetEditor() {
    state.editingRecipe = null;
    state.draftIngredients = [];
    revokePendingImageUrl();
    state.pendingImageFile = null;
  }

  function addIngredientFromForm() {
    const itemId = dom.ingredientSelect.value;
    const item = items.find((candidate) => String(candidate.id) === String(itemId));
    const qtyInput = document.getElementById('ingredient-qty');
    const quantity = number(String(qtyInput.value).replace(',', '.'), NaN);
    const unit = document.getElementById('ingredient-unit').value.trim();
    const error = document.getElementById('ingredient-error');
    const fail = (message, field) => {
      error.hidden = false;
      error.textContent = message;
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    };
    if (!item) { fail('Choose an item from the list.', dom.ingredientSearch); return; }
    if (!Number.isFinite(quantity) || quantity <= 0) { fail('Enter a quantity above 0.', qtyInput); return; }
    error.hidden = true;
    qtyInput.removeAttribute('aria-invalid');
    dom.ingredientSearch.removeAttribute('aria-invalid');
    state.draftIngredients.push({ item_id: item.id, item_name: item.name, quantity, unit: unit || 'ml' });
    qtyInput.value = '';
    dom.ingredientSearch.value = '';
    populateIngredientSelect('');
    renderIngredientList();
    dom.ingredientSearch.focus();
  }

  function renderIngredientList() {
    if (!dom.ingredientList) return;
    const manager = canManageCommercial();
    dom.ingredientList.innerHTML = state.draftIngredients.length
      ? state.draftIngredients.map((ingredient, index) => {
          const cost = ingredientCost(ingredient);
          const item = cost.item;
          return `<li class="atlas-row atlas-row--compact"><span class="recipe-build__qty num">${escape(quantityText(ingredient))}</span>
              <div class="atlas-row__body"><p class="atlas-row__title">${escape(ingredient.item_name)}</p><p class="atlas-row__meta">${item ? escape(stockLabel(item)) : 'Not linked to an item'}${manager ? ` · ${cost.value == null ? escape(String(cost.reason || 'No cost')) : formatIsk(cost.value)}` : ''}</p></div>
              <div class="atlas-row__end"><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-move-ingredient="${index}" data-direction="-1" aria-label="Move ${escape(ingredient.item_name)} up"${index === 0 ? ' disabled' : ''}><i data-lucide="arrow-up"></i></button><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-move-ingredient="${index}" data-direction="1" aria-label="Move ${escape(ingredient.item_name)} down"${index === state.draftIngredients.length - 1 ? ' disabled' : ''}><i data-lucide="arrow-down"></i></button><button type="button" class="atlas-icon-btn atlas-icon-btn--sm" data-remove-ingredient="${index}" aria-label="Remove ${escape(ingredient.item_name)}"><i data-lucide="trash-2"></i></button></div></li>`;
        }).join('')
      : '<li class="recipe-muted recipe-ingredient-empty">No ingredients yet. Search for an item above and add it with its quantity.</li>';
    renderDraftFinancials();
    if (window.lucide) window.lucide.createIcons();
  }

  function renderDraftFinancials() {
    const menuPrice = document.getElementById('recipe-menu-price')?.value;
    const recipeYield = document.getElementById('recipe-yield-qty')?.value;
    const financials = recipeFinancials(state.draftIngredients, menuPrice, recipeYield);
    const has = state.draftIngredients.length > 0;
    const set = (id, text) => { const element = document.getElementById(id); if (element) element.textContent = text; };
    set('calc-total-cost', has ? formatIsk(financials.total, '—') : '—');
    set('calc-cost-per-serving', has ? formatIsk(financials.perServing, '—') : '—');
    set('calc-cost-pct', Number.isFinite(financials.costPercent) ? formatPercent(financials.costPercent) : '—');
    set('calc-profit', Number.isFinite(financials.profit) ? formatIsk(financials.profit) : '—');
    const note = document.getElementById('recipe-cost-note');
    if (note) {
      note.textContent = !has
        ? 'Add ingredients to see the cost.'
        : financials.incomplete
          ? `${financials.incomplete} ${financials.incomplete === 1 ? 'ingredient needs' : 'ingredients need'} a cost and pack size on its item before the cost is complete.`
          : 'Cost comes from each linked item\'s cost and pack size.';
    }
    const availabilityNote = document.getElementById('recipe-availability-note')?.querySelector('span');
    if (availabilityNote) {
      const availability = recipeAvailability(state.draftIngredients, recipeYield);
      if (!has) availabilityNote.textContent = '';
      else if (availability.status === 'incomplete') availabilityNote.textContent = 'Availability is unknown until every linked item is counted and its unit matches.';
      else if (availability.status === 'unavailable') availabilityNote.textContent = limitingName(availability) ? `${limitingName(availability)}: out of stock, so this can’t be served now.` : 'An ingredient is out of stock, so this can’t be served now.';
      else availabilityNote.textContent = `Counted stock covers about ${availability.servings} serves before ${limitingName(availability) || 'an ingredient'} runs out.`;
    }
  }

  // ---------- archive, restore, delete (S87 rules) ----------

  function confirmDialog({ title, body, confirm, keep = 'Cancel', danger = false, typeName = null }) {
    return new Promise((resolve) => {
      let modal = document.getElementById('recipe-confirm-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'recipe-confirm-modal';
        modal.className = 'atlas-modal';
        modal.hidden = true;
        modal.setAttribute('data-atlas-modal', '');
        document.body.appendChild(modal);
        window.AtlasModal.register(modal, { closeOnBackdrop: true });
      }
      modal.innerHTML = `<section class="atlas-dialog" data-modal-panel aria-labelledby="recipe-confirm-title">
          <h2 class="atlas-dialog__title" id="recipe-confirm-title">${escape(title)}</h2>
          <div class="atlas-dialog__body"><p>${escape(body)}</p>${typeName ? `<div class="atlas-field"><label for="recipe-confirm-name">Type <strong>${escape(typeName)}</strong> to confirm</label><input class="atlas-input" id="recipe-confirm-name" autocomplete="off"></div>` : ''}</div>
          <div class="atlas-dialog__foot"><button type="button" class="atlas-btn atlas-btn--ghost" data-modal-close>${escape(keep)}</button><button type="button" class="atlas-btn atlas-btn--${danger ? 'danger-solid' : 'primary'}" data-recipe-confirm${typeName ? ' disabled' : ''}>${escape(confirm)}</button></div>
        </section>`;
      const button = modal.querySelector('[data-recipe-confirm]');
      const input = modal.querySelector('#recipe-confirm-name');
      if (input) input.addEventListener('input', () => { button.disabled = input.value.trim().toLowerCase() !== String(typeName).trim().toLowerCase(); });
      let answered = false;
      const done = (value) => { if (!answered) { answered = true; resolve(value); } };
      button.addEventListener('click', () => { done(true); window.AtlasModal.close(modal, 'confirm'); });
      modal.addEventListener('atlas:modal-close', () => done(false), { once: true });
      window.AtlasModal.open(modal);
    });
  }

  // Archiving is the normal way to take a recipe off service: it keeps the
  // recipe, its ingredient links and its history, and can be undone.
  async function setRecipeActive(recipe, active) {
    if (!recipe?.id) return;
    if (!canManageCommercial()) {
      window.AtlasShell?.toast?.('Recipe changes are for managers.');
      return;
    }
    if (!active && !await confirmDialog({ title: `Archive ${recipe.name}?`, body: 'It leaves service and the menu but keeps its ingredients and history. You can restore it at any time.', confirm: 'Archive', keep: 'Keep on service' })) return;
    const { error } = await sb.from('recipes').update({ active }).eq('id', recipe.id);
    if (error) {
      await confirmDialog({ title: active ? 'Couldn\'t restore the recipe' : 'Couldn\'t archive the recipe', body: 'Nothing was changed. Check your connection and try again.', confirm: 'OK', keep: 'Close' });
      return;
    }
    window.AtlasShell?.toast?.(active ? `${recipe.name} is back on service.` : `${recipe.name} archived.`);
    closeEditor('saved');
    await loadAll();
    if (activeView === 'recipes') render();
  }

  // Permanent deletion is only offered for archived recipes and needs the
  // recipe name typed back. The database refuses to delete an active recipe.
  async function deleteRecipe(recipe) {
    if (!recipe?.id) return;
    if (!canManageCommercial()) {
      window.AtlasShell?.toast?.('Deleting recipes is for managers.');
      return;
    }
    if (recipe.active !== false) {
      await confirmDialog({ title: 'Archive it first', body: 'Only archived recipes can be deleted permanently.', confirm: 'OK', keep: 'Close' });
      return;
    }
    const ok = await confirmDialog({
      title: `Delete ${recipe.name} permanently?`,
      body: 'This removes the recipe and its ingredient links and can\'t be undone. Items and stock are not changed.',
      confirm: 'Delete recipe', keep: 'Keep recipe', danger: true, typeName: recipe.name
    });
    if (!ok) return;
    const { error } = await sb.from('recipes').delete().eq('id', recipe.id);
    if (error) {
      await confirmDialog({ title: 'Couldn\'t delete the recipe', body: 'Nothing was deleted. Check your connection and try again.', confirm: 'OK', keep: 'Close' });
      return;
    }
    if (String(state.selectedRecipeId) === String(recipe.id)) state.selectedRecipeId = null;
    closeEditor('saved');
    closeDetailSheet('route');
    window.AtlasShell?.toast?.(`${recipe.name} deleted.`);
    go('#recipes');
    await loadAll();
    if (activeView === 'recipes') render();
  }

  async function saveRecipe(event) {
    event.preventDefault();
    if (!canManageCommercial()) {
      dom.saveState.textContent = 'Recipe editing is for managers.';
      return;
    }
    const submitButton = dom.form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    dom.saveState.textContent = 'Saving…';
    dom.saveState.className = 'atlas-sheet__foot-start recipe-save-state';
    let saved = false;

    try {
      const selectedOption = dom.categorySelect.options[dom.categorySelect.selectedIndex];
      const categoryId = dom.categorySelect.value || null;
      const categorySlug = selectedOption?.dataset.slug || 'other';
      const recipeId = document.getElementById('recipe-id').value || null;
      const name = document.getElementById('recipe-name').value.trim();
      if (!name) throw Object.assign(new Error('name'), { userMessage: 'Give the recipe a name.' });
      const uploadedImageUrl = state.pendingImageFile
        ? await uploadRecipeImage(state.pendingImageFile)
        : null;
      const payload = {
        name,
        category_id: categoryId,
        type: categorySlug,
        image_url: uploadedImageUrl || document.getElementById('recipe-image-url').value.trim() || null,
        glassware: document.getElementById('recipe-glassware').value.trim() || null,
        garnish: document.getElementById('recipe-garnish').value.trim() || null,
        method: document.getElementById('recipe-method').value.trim() || null,
        notes: document.getElementById('recipe-notes').value.trim() || null,
        yield_quantity: Math.max(0.0001, number(document.getElementById('recipe-yield-qty').value, 1)),
        yield_unit: document.getElementById('recipe-yield-unit').value.trim() || 'serving',
        menu_price: document.getElementById('recipe-menu-price').value === ''
          ? null
          : number(document.getElementById('recipe-menu-price').value),
        active: document.getElementById('recipe-active').checked,
        show_on_menu: document.getElementById('recipe-show-on-menu').checked,
        updated_by: currentUser?.id || null
      };

      const { data: savedRecipeId, error } = await sb.rpc('atlas_save_recipe', {
        p_recipe_id: recipeId,
        p_recipe: payload,
        p_ingredients: state.draftIngredients.map((ingredient) => ({
          item_id: ingredient.item_id,
          item_name: ingredient.item_name,
          quantity: ingredient.quantity,
          unit: ingredient.unit
        }))
      });
      if (error) throw error;
      saved = true;
      // Retain the persisted identity if refreshing fails, so retry updates it.
      document.getElementById('recipe-id').value = savedRecipeId;

      dom.saveState.textContent = 'Saved';
      await loadAll();
      window.AtlasModal.close(dom.modal, 'saved');
      window.AtlasShell?.toast?.(`${payload.name} saved.`);
      if (typeof go === 'function') go(`#recipes/${encodeURIComponent(savedRecipeId)}`);
      if (activeView === 'recipes') await render();
    } catch (error) {
      dom.saveState.textContent = saved
        ? 'Saved. The recipe list couldn\'t refresh — reload the page to see the change.'
        : error.userMessage || 'The recipe couldn\'t be saved. Nothing was changed. Try again.';
      dom.saveState.className = 'atlas-sheet__foot-start recipe-save-state is-error';
    } finally {
      submitButton.disabled = false;
    }
  }

  function init() {
    if (state.initialized) return;
    dom.view = document.getElementById('recipes-view');
    if (!dom.view) return;
    state.initialized = true;
    state.viewMode = readViewMode();
    dom.view.addEventListener('input', (event) => {
      if (!['recipe-search', 'recipe-search-phone'].includes(event.target.id)) return;
      state.search = event.target.value;
      renderLibrary({ keepFocus: event.target.id });
    });
    dom.view.addEventListener('click', handleLibraryClick);
    registerWithShell();
    // The category menu is a popover on desktop and a bottom sheet on phones;
    // crossing the breakpoint re-binds it in the right mode.
    window.matchMedia?.('(max-width: 767px)').addEventListener?.('change', () => {
      if (activeView === 'recipes' && !state.phoneDetail && document.getElementById('recipe-category-menu')?.hidden !== false) renderLibrary();
    });
    loadCategories().then(() => { if (activeView === 'recipes') render(); });
  }

  // ---------- page render and routing ----------

  function readViewMode() {
    try { return localStorage.getItem('atlas.recipes.view') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
  }

  function renderLibrary({ keepFocus = false } = {}) {
    if (!dom.view) return;
    const searchId = typeof keepFocus === 'string' ? keepFocus : 'recipe-search';
    const search = keepFocus ? document.getElementById(searchId) : null;
    const caret = search ? search.selectionStart : null;
    if (state.phoneDetail && isPhone()) {
      const recipe = recipes.find((entry) => String(entry.id) === String(state.phoneDetail));
      if (recipe) {
        dom.view.innerHTML = `<div class="atlas-page recipes-page">${phoneDetailMarkup(recipe)}</div>`;
        if (window.lucide) window.lucide.createIcons();
        return;
      }
    }
    const missing = state.missingRecipe && recipesHealth() !== 'failed'
      ? `<div class="atlas-alert atlas-alert--warning"><i data-lucide="triangle-alert"></i><div class="atlas-alert__content"><p class="atlas-alert__title">That recipe isn't available</p><p class="atlas-alert__body">It may have been deleted or archived. The library below is up to date.</p></div></div>`
      : '';
    dom.view.innerHTML = `<div class="atlas-page recipes-page">${libraryMarkup().replace('</header>', `</header>${missing}`)}</div>`;
    const trigger = document.getElementById('recipe-category-trigger');
    const menu = document.getElementById('recipe-category-menu');
    if (trigger && menu) {
      // Desktop: a popover under the chip (placed by AtlasShell.menu). Phone:
      // a bottom sheet placed by recipes.css, so it is never off screen.
      const handle = window.AtlasShell?.menu?.(trigger, menu, {
        align: 'start',
        position: isPhone() ? false : undefined,
        onSelect: (item) => {
          state.category = item?.dataset?.recipeCategory || 'all';
          // Re-render after AtlasShell.menu has closed the old menu, then give
          // focus back to the new chip and keep it in view in the scrolling toolbar.
          queueMicrotask(() => {
            renderLibrary();
            const next = document.getElementById('recipe-category-trigger');
            next?.focus({ preventScroll: true });
            revealInToolbar(next?.closest('.recipe-category-picker'));
          });
        }
      });
      // The phone sheet's backdrop is the menu's own ::before: a tap on it lands
      // on the menu element outside its box, and closes the sheet without
      // reaching the recipe underneath.
      menu.addEventListener('click', (event) => {
        if (event.target !== menu) return;
        const rect = menu.getBoundingClientRect();
        if (event.clientY < rect.top || event.clientY > rect.bottom || event.clientX < rect.left || event.clientX > rect.right) handle?.close?.(true);
      });
    }
    if (search) {
      const next = document.getElementById(searchId);
      next?.focus({ preventScroll: true });
      if (next && caret !== null) next.setSelectionRange(caret, caret);
    }
    if (window.lucide) window.lucide.createIcons();
  }

  // The phone toolbar scrolls sideways and fades under its padding: scroll it
  // so the whole control sits inside the padding box.
  function revealInToolbar(control) {
    const toolbar = control?.closest('.atlas-toolbar');
    if (!toolbar || toolbar.scrollWidth <= toolbar.clientWidth) return;
    const style = getComputedStyle(toolbar);
    const bar = toolbar.getBoundingClientRect();
    const box = control.getBoundingClientRect();
    const past = Math.ceil(box.right - (bar.right - parseFloat(style.paddingRight || '0')));
    const before = Math.floor(box.left - (bar.left + parseFloat(style.paddingLeft || '0')));
    if (past > 0) toolbar.scrollLeft += past;
    else if (before < 0) toolbar.scrollLeft += before;
  }

  function handleLibraryClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const status = target.closest('[data-recipe-status]');
    if (status) { state.statusFilter = status.dataset.recipeStatus || 'all'; renderLibrary(); return; }
    const view = target.closest('[data-recipe-view]');
    if (view) {
      state.viewMode = view.dataset.recipeView === 'list' ? 'list' : 'grid';
      try { localStorage.setItem('atlas.recipes.view', state.viewMode); } catch { /* per-device preference only */ }
      renderLibrary();
      return;
    }
    const category = target.closest('button[data-recipe-category]');
    if (category && !category.closest('.atlas-menu')) { state.category = 'all'; renderLibrary(); return; }
    const retry = target.closest('[data-recipe-retry]');
    if (retry) {
      retry.disabled = true;
      retry.classList.add('is-loading');
      Promise.resolve(window.atlasReloadData?.()).catch(() => {}).finally(() => renderLibrary());
      return;
    }
    if (target.closest('[data-recipe-clear]')) { state.search = ''; state.category = 'all'; state.statusFilter = 'all'; renderLibrary(); return; }
    if (target.closest('[data-recipe-new]')) { window.AtlasShell.navigate('#recipes/new/edit'); return; }
    if (target.closest('[data-recipe-menu-link]')) { openMenuShare(); return; }
    if (state.phoneDetail) {
      const recipe = recipes.find((entry) => String(entry.id) === String(state.phoneDetail));
      if (!recipe) return;
      if (target.closest('[data-recipe-ask]')) askAbout(recipe);
      else if (target.closest('[data-archive-recipe]')) setRecipeActive(recipe, false);
      else if (target.closest('[data-restore-recipe]')) setRecipeActive(recipe, true);
      else if (target.closest('[data-delete-recipe]')) deleteRecipe(recipe);
    }
  }

  function openMenuShare() {
    const url = `${window.location.origin}/menu.html`;
    confirmDialog({ title: 'Public menu', body: `Recipes marked "Show on the public menu" appear at ${url}.`, confirm: 'Copy link', keep: 'Close' })
      .then((copy) => {
        if (!copy) return;
        navigator.clipboard?.writeText?.(url).then(() => window.AtlasShell?.toast?.('Menu link copied.'), () => window.AtlasShell?.toast?.(`Menu link: ${url}`));
      });
  }

  async function render() {
    if (!state.initialized) init();
    if (!dom.view) return;
    renderLibrary();
    const modal = document.getElementById('recipe-detail-modal');
    if (modal && window.AtlasModal.isOpen(modal) && state.selectedRecipeId) {
      const recipe = recipes.find((entry) => String(entry.id) === String(state.selectedRecipeId));
      if (recipe) {
        const body = modal.querySelector('.recipe-detail');
        if (body) body.innerHTML = detailBody(recipe);
        if (window.lucide) window.lucide.createIcons();
      }
    }
  }

  // AtlasShell calls this on every #recipes route: library, #recipes/<id>,
  // #recipes/<id>/edit, #recipes/new/edit.
  function show(params = {}) {
    if (!state.initialized) init();
    const recipeId = params.recipe || null;
    const editing = Boolean(params.edit);
    if (!recipeId) {
      state.phoneDetail = null;
      state.missingRecipe = null;
      closeEditor('route');
      closeDetailSheet('route');
      keepAwake(false);
      renderLibrary();
      return;
    }
    if (editing) {
      const recipe = recipeId === 'new' ? null : recipes.find((entry) => String(entry.id) === String(recipeId));
      if (!canManageCommercial()) {
        window.AtlasShell?.toast?.('Recipe editing is for managers. Showing the recipe instead.', { tone: 'info' });
        openDetail(recipeId);
        return;
      }
      if (recipeId !== 'new' && !recipe) {
        if (!dataLoaded()) { state.pendingRoute = params; return; }
        state.missingRecipe = recipeId;
        renderLibrary();
        return;
      }
      state.phoneDetail = null;
      renderLibrary();
      openEditor(recipe);
      return;
    }
    closeEditor('route');
    if (!recipes.some((entry) => String(entry.id) === String(recipeId)) && !dataLoaded()) {
      state.pendingRoute = params;
      renderLibrary();
      return;
    }
    renderLibrary();
    openDetail(recipeId);
  }

  function registerWithShell() {
    const shell = window.AtlasShell;
    if (!shell) return;
    shell.onDataLoaded?.(() => {
      if (state.pendingRoute && activeView === 'recipes') {
        const params = state.pendingRoute;
        state.pendingRoute = null;
        show(params);
      }
      shell.emit?.('notify:changed', { source: 'home:recipes' });
    });
    shell.on?.('view:hide', ({ view }) => {
      if (view !== 'recipes') return;
      closeEditor('route');
      closeDetailSheet('route');
      state.phoneDetail = null;
      keepAwake(false);
    });
    shell.actions?.register?.({
      id: 'recipes.edit', label: 'Edit recipe', icon: 'pencil', keywords: ['edit recipe', 'change recipe', 'price'],
      roles: ['admin', 'manager'], forRecord: 'recipe', recordLabel: 'Edit {name}',
      when: (ctx = {}) => Boolean(ctx.record?.type === 'recipe' && ctx.record?.id),
      run: (ctx = {}) => shell.navigate(`#recipes/${encodeURIComponent(ctx.record.id)}/edit`)
    });
    shell.actions?.register?.({
      id: 'recipes.ask', label: 'Ask Atlas about this recipe', icon: 'sparkles', keywords: ['ask', 'recipe'],
      forRecord: 'recipe', recordLabel: 'Ask Atlas about {name}',
      when: (ctx = {}) => Boolean(ctx.record?.type === 'recipe' && ctx.record?.id),
      run: (ctx = {}) => window.AtlasAI?.askAbout?.({ type: 'recipe', id: ctx.record.id, label: ctx.record.label || '' })
    });
    shell.home?.contribute?.('recipes', {
      order: 40,
      focusRows: () => recipes
        .filter((recipe) => recipe.active !== false && recipeStatus(recipe).key === 'unavailable')
        .slice(0, 2)
        .map((recipe) => ({
          id: `unavailable:${recipe.id}`,
          severity: 'warning',
          icon: 'martini',
          title: `${recipe.name} can’t be served`,
          detail: availabilityView(recipe).line,
          action: { label: 'Open recipe', route: `#recipes/${encodeURIComponent(recipe.id)}` }
        }))
    });
  }

  function getHomeAlert() {
    const active = recipes.filter((recipe) => recipe.active !== false);
    const rank = { unavailable: 0, attention: 1, incomplete: 2 };
    const issue = active
      .map((recipe) => ({ recipe, availability: recipeAvailability(recipe) }))
      .filter((entry) => entry.availability.status !== 'ready')
      .sort((a, b) => (rank[a.availability.status] ?? 3) - (rank[b.availability.status] ?? 3) || number(a.availability.servings, 999999) - number(b.availability.servings, 999999))[0];
    if (!issue) return null;
    if (issue.availability.status === 'unavailable') return { text: `${issue.recipe.name} can’t be served right now.` };
    if (issue.availability.status === 'attention') return { text: `${issue.recipe.name}: about ${issue.availability.servings} serves left.` };
    return { text: `${issue.recipe.name} needs a stock count or an ingredient link.` };
  }

  function getHomeMetrics() {
    const margins = recipes
      .filter((recipe) => recipe.active !== false)
      .map((recipe) => recipeFinancials(recipe))
      .filter((financials) => financials.incomplete === 0 && Number.isFinite(financials.margin));
    return {
      averageMargin: margins.length ? margins.reduce((sum, financials) => sum + financials.margin, 0) / margins.length : null,
      marginRecipeCount: margins.length
    };
  }

  window.AtlasRecipes = {
    init,
    render,
    show,
    openEditor: (recipe) => window.AtlasShell?.navigate?.(recipe?.id ? `#recipes/${encodeURIComponent(recipe.id)}/edit` : '#recipes/new/edit'),
    getHomeAlert,
    getHomeMetrics,
    summary,
    recipeAvailability,
    // Search and Ask Atlas use the exact readiness shown on the Recipes page.
    recipeStatus,
    recipeBlockers,
    availabilityView,
    openWithStatus: (status) => {
      state.statusFilter = ['all', 'available', 'unavailable', 'draft', 'attention'].includes(status) ? status : 'all';
      state.category = 'all';
      go('#recipes');
      renderLibrary();
    },
    openRecipe: (recipeId) => window.AtlasShell?.navigate?.(`#recipes/${encodeURIComponent(recipeId)}`),
    reloadCategories: () => loadCategories(true)
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
