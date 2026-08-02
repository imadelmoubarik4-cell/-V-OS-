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
    viewMode: 'workspace',
    statusFilter: 'all',
    selectedRecipeId: localStorage.getItem('atlas.selectedRecipeId') || null,
    draftIngredients: [],
    editingRecipe: null,
    initialized: false,
    loadingCategories: null
  };

  const dom = {};

  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatIsk(value, empty = '—') {
    if (!Number.isFinite(value)) return empty;
    return `${Math.round(value).toLocaleString('en-US')} ISK`;
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
    const item = items.find((candidate) => candidate.id === ingredient.item_id);
    if (!item) return { servings: null, item: null, reason: 'Inventory item is missing', belowPar: false };

    const requested = convertIngredientQuantity(number(ingredient.quantity), ingredient.unit);
    const pack = parsePackSize(item);
    if (!pack || requested.quantity <= 0) {
      return { servings: null, item, reason: 'Package size is missing', belowPar: false };
    }

    const stockUnits = Math.max(0, number(item.quantity));
    const belowPar = item.par_level != null && stockUnits <= number(item.par_level);
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
    const menuPrice = menuPriceValue !== undefined
      ? number(menuPriceValue, NaN)
      : number(recipeOrIngredients?.menu_price, NaN);
    const recipeYield = Math.max(0.0001, yieldValue !== undefined
      ? number(yieldValue, 1)
      : number(recipeOrIngredients?.yield_quantity, 1));

    let total = 0;
    let incomplete = 0;
    ingredients.forEach((ingredient) => {
      const result = ingredientCost(ingredient);
      if (result.value == null) incomplete += 1;
      else total += result.value;
    });

    const perServing = total / recipeYield;
    const costPercent = Number.isFinite(menuPrice) && menuPrice > 0 ? (perServing / menuPrice) * 100 : NaN;
    const profit = Number.isFinite(menuPrice) ? menuPrice - perServing : NaN;
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
        console.warn('Recipe categories fallback:', error);
        state.categories = FALLBACK_CATEGORIES;
      }
      state.categoryById = new Map(state.categories.filter((category) => category.id).map((category) => [category.id, category]));
      state.categoryBySlug = new Map(state.categories.map((category) => [category.slug, category]));
      state.loadingCategories = null;
      return state.categories;
    })();

    return state.loadingCategories;
  }

  function ensureWorkspaceMarkup() {
    const view = document.getElementById('recipes-view');
    if (!view || view.dataset.alpha03 === 'true') return;
    view.dataset.alpha03 = 'true';
    view.innerHTML = `
      <section class="recipe-alpha03">
        <header class="recipe-alpha03-head">
          <div>
            <span class="recipe-kicker">Atlas Alpha 0.3</span>
            <h1>Recipe Intelligence</h1>
            <p>Service specifications, live inventory availability and cost performance in one workspace.</p>
          </div>
          <button type="button" class="recipe-primary-action" id="add-recipe-btn"><i data-lucide="plus"></i><span>New recipe</span></button>
        </header>

        <div class="recipe-summary-grid recipe-alpha03-summary" aria-label="Recipe summary">
          <div class="recipe-summary-card"><div class="summary-icon"><i data-lucide="book-open"></i></div><div><strong id="recipe-stat-total">0</strong><span>Total recipes</span></div></div>
          <div class="recipe-summary-card"><div class="summary-icon"><i data-lucide="circle-check-big"></i></div><div><strong id="recipe-stat-active">0</strong><span>Active for service</span></div></div>
          <div class="recipe-summary-card"><div class="summary-icon"><i data-lucide="badge-check"></i></div><div><strong id="recipe-stat-ready">0</strong><span>Ready today</span></div></div>
          <div class="recipe-summary-card"><div class="summary-icon"><i data-lucide="triangle-alert"></i></div><div><strong id="recipe-stat-attention">0</strong><span>Need attention</span></div></div>
        </div>

        <section class="recipe-intelligence-panel recipe-alpha03-brief" aria-live="polite">
          <div class="recipe-intelligence-icon"><i data-lucide="sparkles"></i></div>
          <div class="recipe-intelligence-copy"><span>Atlas Intelligence</span><h3 id="recipe-intelligence-title">Checking recipe readiness…</h3><p id="recipe-intelligence-detail">Atlas is comparing every linked ingredient with current inventory.</p></div>
          <button type="button" class="recipe-intelligence-action" id="recipe-intelligence-action" hidden>Review recipe</button>
        </section>

        <div class="recipe-workspace">
          <aside class="recipe-library-pane" aria-label="Recipe library">
            <div class="recipe-library-head">
              <div><h2>Library</h2><span id="recipe-library-count">0 recipes</span></div>
              <button type="button" class="recipe-icon-action" id="recipe-library-add" aria-label="Create recipe"><i data-lucide="plus"></i></button>
            </div>
            <label class="recipe-search recipe-workspace-search" aria-label="Search recipes"><i data-lucide="search"></i><input type="search" id="recipe-search" placeholder="Search recipes…" /></label>
            <div class="recipe-status-filters" id="recipe-status-filters" aria-label="Recipe health filters">
              <button type="button" class="active" data-status="all">All</button>
              <button type="button" data-status="ready">Ready</button>
              <button type="button" data-status="attention">Attention</button>
              <button type="button" data-status="draft">Draft</button>
            </div>
            <div class="recipe-category-row recipe-category-stack" id="recipe-category-row" aria-label="Recipe categories"></div>
            <div id="recipes-grid-v2" class="recipe-library-list"></div>
            <div id="recipes-empty-v2" class="recipe-library-empty" hidden><i data-lucide="search-x"></i><strong>No recipes found</strong><span>Change the filters or create a new recipe.</span></div>
          </aside>

          <main class="recipe-profile-pane" id="recipe-profile-pane" aria-live="polite"></main>
          <aside class="recipe-insight-pane" id="recipe-insight-pane" aria-label="Recipe intelligence"></aside>
        </div>

        <div class="recipe-foundation-panel recipe-alpha03-foundation">
          <article class="recipe-foundation-card">
            <h3>Inventory connection</h3>
            <p>Recipe ingredients use live inventory quantities, costs and package sizes.</p>
            <div class="inventory-connection-list">
              <div class="inventory-connection-row"><span>Inventory items available</span><strong id="recipe-inventory-count">0</strong></div>
              <div class="inventory-connection-row"><span>Ingredients connected</span><strong id="recipe-linked-count">0</strong></div>
              <div class="inventory-connection-row"><span>Ingredients needing a link</span><strong id="recipe-unlinked-count">0</strong></div>
            </div>
          </article>
          <article class="recipe-foundation-card recipe-featured-card" id="recipe-featured-card"></article>
          <article class="recipe-foundation-card">
            <h3>Public menu</h3>
            <p>Only recipes marked “Show on public menu” appear on the guest-facing menu.</p>
            <div class="recipe-menu-share"><img id="menu-qr" alt="QR code to public menu" width="84" height="84" /><div><label for="menu-link">Menu link</label><input id="menu-link" readonly /><input id="menu-embed" readonly aria-label="Embed code" /></div></div>
          </article>
        </div>
      </section>`;

    if (!document.getElementById('recipe-service-overlay')) {
      const service = document.createElement('div');
      service.id = 'recipe-service-overlay';
      service.className = 'recipe-service-overlay';
      service.hidden = true;
      service.innerHTML = '<div class="recipe-service-shell" id="recipe-service-shell"></div>';
      document.body.appendChild(service);
    }
  }

  function professionalizeQuickActions() {
    const actions = [
      ['fab-add-item', 'plus', 'Add inventory item'],
      ['fab-log-restock', 'package-plus', 'Log restock'],
      ['fab-add-recipe', 'martini', 'Add recipe'],
      ['fab-add-supplier', 'truck', 'Add supplier']
    ];
    actions.forEach(([id, iconName, label]) => {
      const button = document.getElementById(id);
      if (!button) return;
      const icon = document.createElement('i');
      icon.dataset.lucide = iconName;
      const text = document.createElement('span');
      text.textContent = label;
      button.replaceChildren(icon, text);
    });
  }

  function cacheDom() {
    dom.view = document.getElementById('recipes-view');
    dom.grid = document.getElementById('recipes-grid-v2');
    dom.empty = document.getElementById('recipes-empty-v2');
    dom.search = document.getElementById('recipe-search');
    dom.categoryRow = document.getElementById('recipe-category-row');
    dom.statusFilters = document.getElementById('recipe-status-filters');
    dom.addButton = document.getElementById('add-recipe-btn');
    dom.libraryAdd = document.getElementById('recipe-library-add');
    dom.profile = document.getElementById('recipe-profile-pane');
    dom.insight = document.getElementById('recipe-insight-pane');
    dom.featured = document.getElementById('recipe-featured-card');
    dom.modal = document.getElementById('recipe-overlay');
    dom.form = document.getElementById('recipe-form');
    dom.modalTitle = document.getElementById('recipe-modal-title');
    dom.modalSubtitle = document.getElementById('recipe-modal-subtitle');
    dom.categorySelect = document.getElementById('recipe-category-id');
    dom.ingredientSelect = document.getElementById('ingredient-item');
    dom.ingredientList = document.getElementById('ingredient-list');
    dom.saveState = document.getElementById('recipe-save-state');
    dom.serviceOverlay = document.getElementById('recipe-service-overlay');
    dom.serviceShell = document.getElementById('recipe-service-shell');
  }

  function bindEvents() {
    dom.addButton?.addEventListener('click', () => openEditor(null));
    dom.libraryAdd?.addEventListener('click', () => openEditor(null));
    dom.search?.addEventListener('input', (event) => {
      state.search = event.target.value.trim().toLowerCase();
      renderWorkspaceContent();
    });
    dom.statusFilters?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-status]');
      if (!button) return;
      state.statusFilter = button.dataset.status || 'all';
      dom.statusFilters.querySelectorAll('[data-status]').forEach((candidate) => candidate.classList.toggle('active', candidate === button));
      renderWorkspaceContent();
    });
    document.querySelectorAll('[data-recipe-filter]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        state.category = button.dataset.recipeFilter || 'all';
        setActiveView('recipes');
        render();
      });
    });
    document.getElementById('add-ingredient-btn')?.addEventListener('click', addIngredientFromForm);
    dom.ingredientList?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-ingredient]');
      if (!button) return;
      state.draftIngredients.splice(Number(button.dataset.removeIngredient), 1);
      renderIngredientList();
    });
    ['recipe-yield-qty', 'recipe-menu-price'].forEach((id) => document.getElementById(id)?.addEventListener('input', renderDraftFinancials));
    dom.form?.addEventListener('submit', saveRecipe);
    dom.modal?.addEventListener('atlas:modal-close', resetEditor);
    document.getElementById('fab-add-recipe')?.addEventListener('click', () => {
      document.getElementById('fab-menu')?.classList.remove('open');
      document.getElementById('fab-btn')?.classList.remove('open');
      setActiveView('recipes');
      openEditor(null);
    });
    dom.serviceOverlay?.addEventListener('click', (event) => {
      if (event.target === dom.serviceOverlay || event.target.closest('[data-service-close]')) closeServiceView();
      const next = event.target.closest('[data-service-next]');
      const previous = event.target.closest('[data-service-previous]');
      if (next) stepServiceRecipe(1);
      if (previous) stepServiceRecipe(-1);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !dom.serviceOverlay?.hidden) closeServiceView();
      if (!dom.serviceOverlay?.hidden && event.key === 'ArrowRight') stepServiceRecipe(1);
      if (!dom.serviceOverlay?.hidden && event.key === 'ArrowLeft') stepServiceRecipe(-1);
    });
    document.addEventListener('click', (event) => {
      const serviceRecipeCard = event.target.closest('[data-service-view="recipes"]');
      if (!serviceRecipeCard) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openServiceLibrary();
    }, true);
  }

  function renderSummary() {
    const activeRecipes = recipes.filter((recipe) => recipe.active !== false);
    const availabilityEntries = activeRecipes.map((recipe) => ({ recipe, availability: recipeAvailability(recipe) }));
    document.getElementById('recipe-stat-total').textContent = recipes.length;
    document.getElementById('recipe-stat-active').textContent = activeRecipes.length;
    document.getElementById('recipe-stat-ready').textContent = availabilityEntries.filter((entry) => entry.availability.status === 'ready').length;
    document.getElementById('recipe-stat-attention').textContent = availabilityEntries.filter((entry) => entry.availability.status !== 'ready').length;
    const totalIngredients = recipes.reduce((total, recipe) => total + (recipe.recipe_ingredients?.length || 0), 0);
    const linkedIngredients = recipes.reduce((total, recipe) => total + (recipe.recipe_ingredients || []).filter((ingredient) => ingredient.item_id).length, 0);
    document.getElementById('recipe-inventory-count').textContent = items.length;
    document.getElementById('recipe-linked-count').textContent = linkedIngredients;
    document.getElementById('recipe-unlinked-count').textContent = Math.max(0, totalIngredients - linkedIngredients);
    renderIntelligence(availabilityEntries);
  }

  function urgencyRank(status) {
    return ({ unavailable: 0, attention: 1, incomplete: 2, ready: 3 })[status] ?? 4;
  }

  function renderIntelligence(entries) {
    const title = document.getElementById('recipe-intelligence-title');
    const detail = document.getElementById('recipe-intelligence-detail');
    const action = document.getElementById('recipe-intelligence-action');
    if (!title || !detail || !action) return;
    const issues = entries.filter((entry) => entry.availability.status !== 'ready').sort((a, b) => urgencyRank(a.availability.status) - urgencyRank(b.availability.status) || number(a.availability.servings, 999999) - number(b.availability.servings, 999999));
    if (!issues.length) {
      const featured = featuredRecipe();
      title.textContent = entries.length ? 'Every active recipe is ready for service.' : 'Create your first connected recipe.';
      detail.textContent = featured ? `${featured.recipe.name} is the strongest current promotion candidate based on availability and margin.` : 'Once ingredients are linked, Atlas will calculate cost and service availability.';
      action.hidden = !featured;
      action.textContent = featured ? 'Review recommendation' : '';
      action.onclick = featured ? () => selectRecipe(featured.recipe.id) : null;
      return;
    }
    const issue = issues[0];
    const limitingName = issue.availability.limiting?.item?.name || issue.availability.limiting?.ingredient?.item_name || 'an ingredient';
    if (issue.availability.status === 'unavailable') {
      title.textContent = `${issue.recipe.name} cannot currently be served.`;
      detail.textContent = `${limitingName} is insufficient for one serving.`;
    } else if (issue.availability.status === 'attention') {
      title.textContent = `${issue.recipe.name}: approximately ${issue.availability.servings} servings available.`;
      detail.textContent = `${limitingName} is the limiting ingredient${issue.availability.belowPar ? ' and is at or below par' : ''}.`;
    } else {
      title.textContent = `${issue.recipe.name} needs an inventory check.`;
      detail.textContent = issue.availability.missing ? 'One or more ingredients are no longer linked to inventory.' : 'Add package size and matching units to calculate service availability.';
    }
    action.hidden = false;
    action.textContent = 'Review recipe';
    action.onclick = () => selectRecipe(issue.recipe.id);
  }

  function categoryCounts() {
    const counts = new Map();
    recipes.forEach((recipe) => {
      const category = categoryFor(recipe);
      counts.set(category.slug, (counts.get(category.slug) || 0) + 1);
    });
    return counts;
  }

  function renderCategoryChips() {
    if (!dom.categoryRow) return;
    const counts = categoryCounts();
    dom.categoryRow.innerHTML = [
      `<button type="button" class="recipe-category-chip ${state.category === 'all' ? 'active' : ''}" data-category="all"><span>All recipes</span><span class="count">${recipes.length}</span></button>`,
      ...state.categories.map((category) => `<button type="button" class="recipe-category-chip ${state.category === category.slug ? 'active' : ''}" data-category="${escape(category.slug)}"><span>${escape(category.name)}</span><span class="count">${counts.get(category.slug) || 0}</span></button>`)
    ].join('');
    dom.categoryRow.querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => {
      state.category = button.dataset.category;
      renderWorkspaceContent();
    }));
  }

  function recipeStatus(recipe) {
    const availability = recipeAvailability(recipe);
    if (recipe.active === false) return { key: 'draft', label: 'Draft', className: 'draft', availability };
    if (availability.status === 'unavailable') return { key: 'unavailable', label: 'Out of stock', className: 'danger', availability };
    if (availability.status === 'attention') return { key: 'attention', label: 'Low availability', className: 'warn', availability };
    if (availability.status === 'incomplete') return { key: 'incomplete', label: 'Incomplete', className: 'warn', availability };
    return { key: 'ready', label: 'Ready', className: 'ready', availability };
  }

  function filteredRecipes() {
    return recipes.filter((recipe) => {
      const category = categoryFor(recipe);
      const status = recipeStatus(recipe);
      const categoryMatch = state.category === 'all' || category.slug === state.category;
      const statusMatch = state.statusFilter === 'all' || (state.statusFilter === 'attention' ? ['attention', 'unavailable', 'incomplete'].includes(status.key) : status.key === state.statusFilter);
      const searchText = [recipe.name, category.name, recipe.glassware, recipe.garnish, recipe.method, recipe.notes].filter(Boolean).join(' ').toLowerCase();
      return categoryMatch && statusMatch && (!state.search || searchText.includes(state.search));
    });
  }

  function selectRecipe(recipeId, options = {}) {
    state.selectedRecipeId = recipeId || null;
    if (recipeId) localStorage.setItem('atlas.selectedRecipeId', recipeId);
    else localStorage.removeItem('atlas.selectedRecipeId');
    renderWorkspaceContent();
    if (options.focus && dom.profile) dom.profile.focus({ preventScroll: true });
  }

  function renderCards() {
    if (!dom.grid || !dom.empty) return;
    const visible = filteredRecipes();
    const count = document.getElementById('recipe-library-count');
    if (count) count.textContent = `${visible.length} ${visible.length === 1 ? 'recipe' : 'recipes'}`;
    if (!visible.length) {
      dom.grid.innerHTML = '';
      dom.empty.hidden = false;
      state.selectedRecipeId = null;
      return;
    }
    dom.empty.hidden = true;
    if (!visible.some((recipe) => recipe.id === state.selectedRecipeId)) state.selectedRecipeId = visible[0].id;
    dom.grid.innerHTML = visible.map((recipe) => {
      const category = categoryFor(recipe);
      const status = recipeStatus(recipe);
      const financials = recipeFinancials(recipe);
      return `<button type="button" class="recipe-library-item ${recipe.id === state.selectedRecipeId ? 'selected' : ''}" data-recipe-id="${escape(recipe.id)}">
        <span class="recipe-library-item-top"><strong>${escape(recipe.name)}</strong><span class="recipe-health-dot ${status.className}" aria-label="${escape(status.label)}"></span></span>
        <span class="recipe-library-item-meta">${escape(category.name)}<span>${Number.isFinite(status.availability.servings) ? `${status.availability.servings} servings` : status.label}</span></span>
        <span class="recipe-library-item-finance"><span>${financials.incomplete ? 'Cost incomplete' : formatIsk(financials.perServing)}</span><span>${Number.isFinite(financials.margin) && !financials.incomplete ? `${financials.margin.toFixed(0)}% margin` : 'Margin unavailable'}</span></span>
      </button>`;
    }).join('');
    dom.grid.querySelectorAll('[data-recipe-id]').forEach((button) => button.addEventListener('click', () => selectRecipe(button.dataset.recipeId, { focus: true })));
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

  function healthRecommendation(recipe, status) {
    const limiting = status.availability.limiting?.item?.name || status.availability.limiting?.ingredient?.item_name;
    if (status.key === 'draft') return { title: 'Recipe is not active', detail: 'Activate it when the service specification is complete.', action: 'Edit recipe' };
    if (status.key === 'unavailable') return { title: 'Restock required', detail: `${limiting || 'The limiting ingredient'} prevents this recipe from being served.`, action: 'Review inventory' };
    if (status.key === 'attention') return { title: 'Low service coverage', detail: `${limiting || 'The limiting ingredient'} will run out first. Plan a restock before the next busy service.`, action: 'Review inventory' };
    if (status.key === 'incomplete') return { title: 'Setup is incomplete', detail: 'Add missing inventory links, package sizes or matching units.', action: 'Edit recipe' };
    return { title: 'Ready for service', detail: 'All linked ingredients currently support service.', action: 'Open Service Mode' };
  }

  function renderProfile() {
    if (!dom.profile || !dom.insight) return;
    const recipe = recipes.find((candidate) => candidate.id === state.selectedRecipeId);
    if (!recipe) {
      dom.profile.innerHTML = '<div class="recipe-profile-empty"><i data-lucide="martini"></i><h2>Select a recipe</h2><p>Choose a recipe from the library to review its specification, stock coverage and cost.</p><button type="button" class="recipe-primary-action" data-empty-create><i data-lucide="plus"></i><span>Create recipe</span></button></div>';
      dom.insight.innerHTML = '<div class="recipe-insight-empty"><i data-lucide="activity"></i><strong>Recipe intelligence</strong><span>Live analysis appears when a recipe is selected.</span></div>';
      dom.profile.querySelector('[data-empty-create]')?.addEventListener('click', () => openEditor(null));
      return;
    }
    const category = categoryFor(recipe);
    const status = recipeStatus(recipe);
    const financials = recipeFinancials(recipe);
    const ingredientRows = ingredientIntelligence(recipe);
    const image = recipe.image_url ? `<div class="recipe-profile-image" style="background-image:url('${escape(recipe.image_url)}')"></div>` : '<div class="recipe-profile-image recipe-profile-placeholder"><i data-lucide="martini"></i></div>';
    const ingredientMarkup = ingredientRows.length ? ingredientRows.map(({ ingredient, availability, cost, servings }) => {
      const item = availability.item;
      const stock = item ? `${number(item.quantity)} ${escape(item.unit)}` : 'Missing link';
      const rowClass = !item ? 'missing' : availability.belowPar ? 'low' : servings === 0 ? 'out' : '';
      return `<div class="recipe-profile-ingredient ${rowClass}">
        <div><strong>${escape(ingredient.item_name)}</strong><span>${number(ingredient.quantity)} ${escape(ingredient.unit)} per recipe</span></div>
        <div><span>Stock</span><strong>${stock}</strong></div>
        <div><span>Coverage</span><strong>${Number.isFinite(servings) ? `${servings} servings` : escape(availability.reason || 'Unknown')}</strong></div>
        <div><span>Cost</span><strong>${cost.value == null ? 'Incomplete' : formatIsk(cost.value)}</strong></div>
      </div>`;
    }).join('') : '<div class="recipe-section-empty">No ingredients have been added.</div>';

    dom.profile.innerHTML = `${image}<div class="recipe-profile-header">
      <div><span class="recipe-profile-category">${escape(category.name)}</span><h2>${escape(recipe.name)}</h2><div class="recipe-profile-meta">${escape(recipe.glassware || 'Glassware not set')}<span></span>${escape(recipe.garnish || 'Garnish not set')}</div></div>
      <span class="recipe-profile-status ${status.className}">${escape(status.label)}</span>
    </div>
    <div class="recipe-profile-actions"><button type="button" class="recipe-secondary-action" data-edit-recipe><i data-lucide="pencil-line"></i>Edit recipe</button><button type="button" class="recipe-primary-action" data-service-recipe><i data-lucide="monitor-up"></i>Service view</button></div>
    <section class="recipe-profile-section"><div class="recipe-profile-section-head"><div><span>Ingredients</span><h3>Live inventory coverage</h3></div><strong>${ingredientRows.length}</strong></div><div class="recipe-profile-ingredients">${ingredientMarkup}</div></section>
    <section class="recipe-profile-section recipe-spec-grid"><div><span>Method</span><p>${escape(recipe.method || 'Preparation method has not been added.')}</p></div><div><span>Service notes</span><p>${escape(recipe.notes || 'No additional service notes.')}</p></div></section>`;
    dom.profile.querySelector('[data-edit-recipe]')?.addEventListener('click', () => openEditor(recipe));
    dom.profile.querySelector('[data-service-recipe]')?.addEventListener('click', () => openServiceView(recipe));

    const recommendation = healthRecommendation(recipe, status);
    const limitingName = status.availability.limiting?.item?.name || status.availability.limiting?.ingredient?.item_name || '—';
    dom.insight.innerHTML = `<div class="recipe-insight-head"><span>Live analysis</span><h2>Recipe health</h2></div>
      <div class="recipe-health-card ${status.className}"><span class="recipe-health-label">Status</span><strong>${escape(status.label)}</strong><p>${escape(recommendation.detail)}</p></div>
      <div class="recipe-insight-metrics">
        <div><span>Menu price</span><strong>${Number.isFinite(number(recipe.menu_price, NaN)) ? formatIsk(number(recipe.menu_price)) : 'Not set'}</strong></div>
        <div><span>Cost per serving</span><strong>${financials.incomplete ? 'Incomplete' : formatIsk(financials.perServing)}</strong></div>
        <div><span>Cost percentage</span><strong>${Number.isFinite(financials.costPercent) && !financials.incomplete ? `${financials.costPercent.toFixed(1)}%` : '—'}</strong></div>
        <div><span>Gross margin</span><strong>${Number.isFinite(financials.margin) && !financials.incomplete ? `${financials.margin.toFixed(1)}%` : '—'}</strong></div>
        <div><span>Profit per serving</span><strong>${Number.isFinite(financials.profit) && !financials.incomplete ? formatIsk(financials.profit) : '—'}</strong></div>
        <div><span>Current coverage</span><strong>${Number.isFinite(status.availability.servings) ? `${status.availability.servings} servings` : 'Unknown'}</strong></div>
      </div>
      <div class="recipe-limiting-card"><span>Limiting ingredient</span><strong>${escape(limitingName)}</strong><p>${status.availability.belowPar ? 'At or below its par level.' : 'This ingredient will run out first.'}</p></div>
      <button type="button" class="recipe-insight-primary" data-health-action>${escape(recommendation.action)}</button>`;
    dom.insight.querySelector('[data-health-action]')?.addEventListener('click', () => {
      if (status.key === 'ready') openServiceView(recipe);
      else if (['draft', 'incomplete'].includes(status.key)) openEditor(recipe);
      else setActiveView('inventory');
    });
  }

  function featuredRecipe() {
    const candidates = recipes.map((recipe) => ({ recipe, status: recipeStatus(recipe), financials: recipeFinancials(recipe) })).filter((entry) => entry.recipe.active !== false && entry.status.key === 'ready' && !entry.financials.incomplete && Number.isFinite(entry.financials.margin));
    candidates.forEach((entry) => { entry.score = entry.financials.margin + Math.min(30, number(entry.status.availability.servings)) * 0.45; });
    return candidates.sort((a, b) => b.score - a.score)[0] || null;
  }

  function renderFeatured() {
    if (!dom.featured) return;
    const featured = featuredRecipe();
    if (!featured) {
      dom.featured.innerHTML = '<h3>Featured recommendation</h3><p>Atlas needs one complete, active and service-ready recipe before it can recommend a feature.</p>';
      return;
    }
    dom.featured.innerHTML = `<div class="recipe-featured-head"><div class="summary-icon"><i data-lucide="sparkles"></i></div><span>Featured recommendation</span></div><h3>${escape(featured.recipe.name)}</h3><p>Strong current margin and sufficient service coverage make this the best recipe to promote today.</p><div class="recipe-featured-stats"><span>${featured.financials.margin.toFixed(0)}% margin</span><span>${featured.status.availability.servings} servings available</span></div><button type="button" class="recipe-secondary-action" data-featured-review>Review recipe</button>`;
    dom.featured.querySelector('[data-featured-review]')?.addEventListener('click', () => selectRecipe(featured.recipe.id, { focus: true }));
  }

  function renderMenuShare() {
    const menuUrl = `${window.location.origin}/menu.html`;
    const linkInput = document.getElementById('menu-link');
    const embedInput = document.getElementById('menu-embed');
    const qrImage = document.getElementById('menu-qr');
    if (linkInput) linkInput.value = menuUrl;
    if (embedInput) embedInput.value = `<iframe src="${menuUrl}" width="100%" height="600" style="border:none"></iframe>`;
    if (qrImage) qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(menuUrl)}`;
  }

  function renderWorkspaceContent() {
    renderCategoryChips();
    renderCards();
    renderProfile();
    renderFeatured();
    if (window.lucide) window.lucide.createIcons();
  }

  async function render() {
    if (!state.initialized) init();
    await loadCategories();
    renderSummary();
    renderWorkspaceContent();
    renderMenuShare();
    populateCategorySelect();
    if (window.lucide) window.lucide.createIcons();
  }

  function serviceRecipes() {
    return recipes.filter((recipe) => recipe.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  }

  function openServiceLibrary() {
    const serviceList = serviceRecipes();
    if (!serviceList.length) {
      setActiveView('recipes');
      return;
    }
    const selected = serviceList.find((recipe) => recipe.id === state.selectedRecipeId) || serviceList[0];
    openServiceView(selected);
  }

  function openServiceView(recipe) {
    if (!recipe || !dom.serviceOverlay || !dom.serviceShell) return;
    state.selectedRecipeId = recipe.id;
    localStorage.setItem('atlas.selectedRecipeId', recipe.id);
    const category = categoryFor(recipe);
    const status = recipeStatus(recipe);
    const ingredientMarkup = (recipe.recipe_ingredients || []).map((ingredient) => `<li><strong>${number(ingredient.quantity)} ${escape(ingredient.unit)}</strong><span>${escape(ingredient.item_name)}</span></li>`).join('') || '<li><span>No ingredients added.</span></li>';
    dom.serviceShell.innerHTML = `<header class="recipe-service-head"><div><span>${escape(category.name)}</span><h1>${escape(recipe.name)}</h1></div><button type="button" data-service-close aria-label="Close service view"><i data-lucide="x"></i></button></header>
      <div class="recipe-service-status"><span class="recipe-profile-status ${status.className}">${escape(status.label)}</span><span>${Number.isFinite(status.availability.servings) ? `${status.availability.servings} servings currently available` : 'Availability needs setup'}</span></div>
      <div class="recipe-service-layout"><section><h2>Ingredients</h2><ul class="recipe-service-ingredients">${ingredientMarkup}</ul></section><section class="recipe-service-spec"><div><span>Method</span><p>${escape(recipe.method || 'Method not added.')}</p></div><div><span>Glassware</span><p>${escape(recipe.glassware || 'Not set')}</p></div><div><span>Garnish</span><p>${escape(recipe.garnish || 'Not set')}</p></div><div><span>Service notes</span><p>${escape(recipe.notes || 'No service notes.')}</p></div></section></div>
      <footer class="recipe-service-footer"><button type="button" data-service-previous><i data-lucide="arrow-left"></i>Previous</button><span>Use the arrow keys to move between recipes</span><button type="button" data-service-next>Next<i data-lucide="arrow-right"></i></button></footer>`;
    dom.serviceOverlay.hidden = false;
    document.body.classList.add('recipe-service-open');
    if (window.lucide) window.lucide.createIcons();
  }

  function closeServiceView() {
    if (!dom.serviceOverlay) return;
    dom.serviceOverlay.hidden = true;
    document.body.classList.remove('recipe-service-open');
  }

  function stepServiceRecipe(direction) {
    const list = serviceRecipes();
    if (!list.length) return;
    const index = Math.max(0, list.findIndex((recipe) => recipe.id === state.selectedRecipeId));
    openServiceView(list[(index + direction + list.length) % list.length]);
  }

  function populateCategorySelect(selectedId, selectedSlug) {
    if (!dom.categorySelect) return;
    dom.categorySelect.innerHTML = state.categories.map((category) => {
      const selected = selectedId
        ? category.id === selectedId
        : category.slug === selectedSlug;
      return `<option value="${escape(category.id || '')}" data-slug="${escape(category.slug)}" ${selected ? 'selected' : ''}>${escape(category.name)}</option>`;
    }).join('');
  }

  function populateIngredientSelect() {
    if (!dom.ingredientSelect) return;
    const available = items.filter((item) => item.active !== false);
    dom.ingredientSelect.innerHTML = [
      '<option value="">Select inventory item</option>',
      ...available.map((item) => `<option value="${escape(item.id)}">${escape(item.name)} · ${escape(item.category || 'Other')} · ${number(item.quantity)} ${escape(item.unit)}</option>`)
    ].join('');
  }

  async function openEditor(recipe) {
    await loadCategories();
    state.editingRecipe = recipe || null;
    state.draftIngredients = (recipe?.recipe_ingredients || []).map((ingredient) => ({
      item_id: ingredient.item_id,
      item_name: ingredient.item_name,
      quantity: number(ingredient.quantity),
      unit: ingredient.unit
    }));

    dom.modalTitle.textContent = recipe ? 'Edit recipe' : 'New recipe';
    dom.modalSubtitle.textContent = recipe
      ? 'Update the recipe, service specification and inventory links.'
      : 'Build a service-ready recipe connected to live inventory.';

    document.getElementById('recipe-id').value = recipe?.id || '';
    document.getElementById('recipe-name').value = recipe?.name || '';
    populateCategorySelect(recipe?.category_id, recipe?.type || 'signature-cocktail');
    document.getElementById('recipe-image-url').value = recipe?.image_url || '';
    document.getElementById('recipe-glassware').value = recipe?.glassware || '';
    document.getElementById('recipe-garnish').value = recipe?.garnish || '';
    document.getElementById('recipe-method').value = recipe?.method || '';
    document.getElementById('recipe-notes').value = recipe?.notes || '';
    document.getElementById('recipe-yield-qty').value = number(recipe?.yield_quantity, 1);
    document.getElementById('recipe-yield-unit').value = recipe?.yield_unit || 'serving';
    document.getElementById('recipe-menu-price').value = recipe?.menu_price ?? '';
    document.getElementById('recipe-active').checked = recipe?.active !== false;
    document.getElementById('recipe-show-on-menu').checked = recipe?.show_on_menu !== false;
    dom.saveState.textContent = '';
    dom.saveState.className = 'recipe-save-state';

    populateIngredientSelect();
    document.getElementById('ingredient-qty').value = '';
    document.getElementById('ingredient-unit').value = 'ml';
    renderIngredientList();
    window.AtlasModal.open(dom.modal);
  }

  function resetEditor() {
    state.editingRecipe = null;
    state.draftIngredients = [];
    dom.form?.reset();
    if (dom.saveState) {
      dom.saveState.textContent = '';
      dom.saveState.className = 'recipe-save-state';
    }
  }

  function addIngredientFromForm() {
    const itemId = dom.ingredientSelect.value;
    const item = items.find((candidate) => candidate.id === itemId);
    const quantity = number(document.getElementById('ingredient-qty').value, NaN);
    const unit = document.getElementById('ingredient-unit').value.trim();

    if (!item) {
      dom.ingredientSelect.focus();
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      document.getElementById('ingredient-qty').focus();
      return;
    }

    state.draftIngredients.push({
      item_id: item.id,
      item_name: item.name,
      quantity,
      unit: unit || 'ml'
    });
    document.getElementById('ingredient-qty').value = '';
    renderIngredientList();
  }

  function renderIngredientList() {
    if (!dom.ingredientList) return;
    if (!state.draftIngredients.length) {
      dom.ingredientList.innerHTML = '<div class="ingredient-list-empty">No ingredients yet. Select an inventory item above to create the first live link.</div>';
      renderDraftFinancials();
      return;
    }

    dom.ingredientList.innerHTML = state.draftIngredients.map((ingredient, index) => {
      const cost = ingredientCost(ingredient);
      const item = cost.item;
      const inventoryMeta = item
        ? `${number(item.quantity)} ${escape(item.unit)} in stock${item.par_level != null ? ` · par ${number(item.par_level)}` : ''}`
        : 'Inventory link missing';
      return `
        <div class="ingredient-line-v2">
          <div class="ingredient-name-v2">
            <strong>${escape(ingredient.item_name)}</strong>
            <span>${inventoryMeta}</span>
          </div>
          <span class="ingredient-quantity-v2">${number(ingredient.quantity)} ${escape(ingredient.unit)}</span>
          <span class="ingredient-cost-v2">${cost.value == null ? escape(cost.reason) : formatIsk(cost.value)}</span>
          <button type="button" class="ingredient-remove-v2" data-remove-ingredient="${index}" aria-label="Remove ${escape(ingredient.item_name)}">×</button>
        </div>
      `;
    }).join('');
    renderDraftFinancials();
  }

  function renderDraftFinancials() {
    const menuPrice = document.getElementById('recipe-menu-price')?.value;
    const recipeYield = document.getElementById('recipe-yield-qty')?.value;
    const financials = recipeFinancials(state.draftIngredients, menuPrice, recipeYield);

    document.getElementById('calc-total-cost').textContent = formatIsk(financials.total, '0 ISK');
    document.getElementById('calc-cost-per-serving').textContent = formatIsk(financials.perServing, '0 ISK');
    document.getElementById('calc-cost-pct').textContent = Number.isFinite(financials.costPercent) ? `${financials.costPercent.toFixed(1)}%` : '—';
    document.getElementById('calc-profit').textContent = Number.isFinite(financials.profit) ? formatIsk(financials.profit) : '—';

    const note = document.getElementById('recipe-cost-note');
    if (financials.incomplete) {
      note.textContent = `${financials.incomplete} ingredient ${financials.incomplete === 1 ? 'needs' : 'need'} an inventory cost and package size before costing is complete.`;
      note.className = 'recipe-cost-note warn';
    } else {
      note.textContent = state.draftIngredients.length
        ? 'Costing is calculated from the linked inventory item cost and package size.'
        : 'Add linked ingredients to calculate the recipe cost.';
      note.className = 'recipe-cost-note';
    }

    const availabilityNote = document.getElementById('recipe-availability-note');
    if (availabilityNote) {
      const availability = recipeAvailability(state.draftIngredients, recipeYield);
      const label = availabilityNote.querySelector('span');
      availabilityNote.className = `recipe-availability-note ${availability.status}`;
      if (!state.draftIngredients.length) {
        label.textContent = 'Add linked ingredients to calculate current service availability.';
      } else if (availability.status === 'incomplete') {
        label.textContent = 'Availability is incomplete because an inventory link, package size or matching unit is missing.';
      } else if (availability.status === 'unavailable') {
        label.textContent = `${availability.limiting?.item?.name || 'The limiting ingredient'} is insufficient for one serving.`;
      } else {
        label.textContent = `Current stock supports approximately ${availability.servings} servings before ${availability.limiting?.item?.name || 'the limiting ingredient'} runs out.`;
      }
    }
  }

  async function saveRecipe(event) {
    event.preventDefault();
    const submitButton = dom.form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    dom.saveState.textContent = 'Saving…';
    dom.saveState.className = 'recipe-save-state';

    try {
      const selectedOption = dom.categorySelect.options[dom.categorySelect.selectedIndex];
      const categoryId = dom.categorySelect.value || null;
      const categorySlug = selectedOption?.dataset.slug || 'other';
      const recipeId = document.getElementById('recipe-id').value || null;
      const payload = {
        name: document.getElementById('recipe-name').value.trim(),
        category_id: categoryId,
        type: categorySlug,
        image_url: document.getElementById('recipe-image-url').value.trim() || null,
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

      if (!payload.name) throw new Error('Recipe name is required.');

      let savedRecipeId = recipeId;
      if (recipeId) {
        const { error } = await sb.from('recipes').update(payload).eq('id', recipeId);
        if (error) throw error;
        const { error: deleteError } = await sb.from('recipe_ingredients').delete().eq('recipe_id', recipeId);
        if (deleteError) throw deleteError;
      } else {
        const { data, error } = await sb.from('recipes').insert(payload).select('id').single();
        if (error) throw error;
        savedRecipeId = data.id;
      }

      if (state.draftIngredients.length) {
        const { error } = await sb.from('recipe_ingredients').insert(
          state.draftIngredients.map((ingredient) => ({
            recipe_id: savedRecipeId,
            item_id: ingredient.item_id,
            item_name: ingredient.item_name,
            quantity: ingredient.quantity,
            unit: ingredient.unit
          }))
        );
        if (error) throw error;
      }

      dom.saveState.textContent = 'Saved';
      await loadAll();
      window.AtlasModal.close(dom.modal, 'saved');
      if (activeView === 'recipes') await render();
    } catch (error) {
      console.error(error);
      dom.saveState.textContent = error.message || 'Could not save recipe.';
      dom.saveState.className = 'recipe-save-state error';
    } finally {
      submitButton.disabled = false;
    }
  }

  function init() {
    if (state.initialized) return;
    ensureWorkspaceMarkup();
    professionalizeQuickActions();
    cacheDom();
    if (!dom.view) return;
    window.AtlasModal.register(dom.modal, { closeOnBackdrop: true, initialFocus: '#recipe-name' });
    bindEvents();
    state.initialized = true;
    if (window.lucide) window.lucide.createIcons();
  }

  function getHomeAlert() {
    const active = recipes.filter((recipe) => recipe.active !== false);
    const issues = active.map((recipe) => ({ recipe, availability: recipeAvailability(recipe) })).filter((entry) => entry.availability.status !== 'ready').sort((a, b) => urgencyRank(a.availability.status) - urgencyRank(b.availability.status) || number(a.availability.servings, 999999) - number(b.availability.servings, 999999));
    if (issues.length) {
      const issue = issues[0];
      if (issue.availability.status === 'unavailable') return { text: `${issue.recipe.name} cannot currently be served.` };
      if (issue.availability.status === 'attention') return { text: `${issue.recipe.name}: only about ${issue.availability.servings} servings available.` };
      return { text: `${issue.recipe.name} needs an inventory or package-size check.` };
    }
    const featured = featuredRecipe();
    return featured ? { text: `Featured recommendation: ${featured.recipe.name} is ready with a ${featured.financials.margin.toFixed(0)}% margin.` } : null;
  }

  window.AtlasRecipes = {
    init,
    render,
    openEditor,
    getHomeAlert,
    recipeAvailability,
    openServiceLibrary,
    reloadCategories: () => loadCategories(true)
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
