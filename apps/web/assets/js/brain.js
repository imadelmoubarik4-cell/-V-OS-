(function () {
  'use strict';

  const SERVICE_BUFFER = 12;
  const state = {
    initialized: false,
    timer: null,
    assistantAnswer: ''
  };
  const dom = {};

  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatIsk(value, fallback = '—') {
    if (!Number.isFinite(value)) return fallback;
    return `${Math.round(value).toLocaleString('en-US')} ISK`;
  }

  function sourceItems() {
    return typeof items !== 'undefined' && Array.isArray(items) ? items : [];
  }

  function sourceRecipes() {
    return typeof recipes !== 'undefined' && Array.isArray(recipes) ? recipes : [];
  }

  function sourceSuppliers() {
    return typeof suppliers !== 'undefined' && Array.isArray(suppliers) ? suppliers : [];
  }

  function userName() {
    if (typeof currentUser !== 'undefined' && currentUser?.email) return currentUser.email.split('@')[0];
    return document.getElementById('profile-name')?.textContent?.trim() || 'VÁ team';
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
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

  function convertQuantity(quantity, unit) {
    const normalized = normalizeUnit(unit);
    if (normalized === 'l') return { quantity: quantity * 1000, unit: 'ml' };
    if (normalized === 'kg') return { quantity: quantity * 1000, unit: 'g' };
    return { quantity, unit: normalized };
  }

  function ingredientCost(ingredient) {
    const item = sourceItems().find((candidate) => candidate.id === ingredient.item_id);
    const purchaseCost = number(item?.cost_price, NaN);
    if (!item || !Number.isFinite(purchaseCost) || purchaseCost <= 0) return null;
    const pack = parsePackSize(item);
    const requested = convertQuantity(number(ingredient.quantity), ingredient.unit);
    if (!pack || requested.quantity <= 0) return null;
    if (pack.unit === requested.unit) return purchaseCost * (requested.quantity / pack.quantity);
    const eachLike = new Set(['each', 'bottle', 'can']);
    if (eachLike.has(pack.unit) && eachLike.has(requested.unit)) return purchaseCost * requested.quantity;
    return null;
  }

  function recipeFinancials(recipe) {
    const ingredients = recipe?.recipe_ingredients || [];
    const recipeYield = Math.max(.0001, number(recipe?.yield_quantity, 1));
    const menuPrice = number(recipe?.menu_price, NaN);
    let total = 0;
    let incomplete = 0;
    ingredients.forEach((ingredient) => {
      const value = ingredientCost(ingredient);
      if (value == null) incomplete += 1;
      else total += value;
    });
    const perServing = total / recipeYield;
    const profit = Number.isFinite(menuPrice) ? menuPrice - perServing : NaN;
    const margin = Number.isFinite(menuPrice) && menuPrice > 0 ? (profit / menuPrice) * 100 : NaN;
    const costPercent = Number.isFinite(menuPrice) && menuPrice > 0 ? (perServing / menuPrice) * 100 : NaN;
    return { total, perServing, profit, margin, costPercent, incomplete };
  }

  function recipeAvailability(recipe) {
    if (window.AtlasRecipes?.recipeAvailability) return window.AtlasRecipes.recipeAvailability(recipe);
    return { servings: null, limiting: null, status: (recipe?.recipe_ingredients || []).length ? 'ready' : 'incomplete' };
  }

  function recipeEntries() {
    return sourceRecipes()
      .filter((recipe) => recipe.active !== false)
      .map((recipe) => ({ recipe, availability: recipeAvailability(recipe), financials: recipeFinancials(recipe) }));
  }

  function recipeIssues() {
    const rank = { unavailable: 0, attention: 1, incomplete: 2, ready: 9 };
    return recipeEntries()
      .filter((entry) => entry.availability.status !== 'ready')
      .sort((a, b) => (rank[a.availability.status] ?? 8) - (rank[b.availability.status] ?? 8)
        || number(a.availability.servings, 999999) - number(b.availability.servings, 999999));
  }

  function lowInventory() {
    return sourceItems()
      .filter((item) => item.active !== false && item.par_level != null && number(item.quantity) <= number(item.par_level))
      .sort((a, b) => {
        const ratioA = number(a.par_level) > 0 ? number(a.quantity) / number(a.par_level) : 1;
        const ratioB = number(b.par_level) > 0 ? number(b.quantity) / number(b.par_level) : 1;
        return ratioA - ratioB || String(a.name).localeCompare(String(b.name));
      });
  }

  function operationOrders() {
    return window.AtlasOperations?.orderSuggestions?.() || lowInventory().map((item) => ({
      id: item.id,
      name: item.name,
      supplier: item.supplier || 'Supplier not assigned',
      orderQuantity: Math.max(1, Math.ceil(number(item.par_level) * 2 - number(item.quantity))),
      unit: item.unit || 'units',
      estimatedCost: Math.max(0, number(item.cost_price)) * Math.max(1, Math.ceil(number(item.par_level) * 2 - number(item.quantity))),
      ordered: false
    }));
  }

  function readiness() {
    if (window.AtlasOperations?.readinessData) return window.AtlasOperations.readinessData();
    const low = lowInventory();
    const issues = recipeIssues();
    const score = Math.max(0, 100 - Math.min(40, low.length * 5) - Math.min(35, issues.length * 8));
    return { score, label: score >= 85 ? 'Ready for service' : score >= 60 ? 'Review before service' : 'Attention required', low, issues, opening: { complete: 0, total: 9, percent: 0 } };
  }

  function riskData() {
    const data = readiness();
    const unavailable = recipeIssues().filter((entry) => entry.availability.status === 'unavailable').length;
    if (data.score < 60 || unavailable > 0) return { label: 'High', tone: 'danger' };
    if (data.score < 85 || lowInventory().length > 0) return { label: 'Medium', tone: 'warn' };
    return { label: 'Low', tone: 'good' };
  }

  function revenueAtRisk() {
    return recipeEntries().reduce((sum, entry) => {
      const price = number(entry.recipe.menu_price, NaN);
      if (!Number.isFinite(price) || price <= 0) return sum;
      let gap = 0;
      if (entry.availability.status === 'unavailable') gap = SERVICE_BUFFER;
      else if (entry.availability.status === 'attention' && Number.isFinite(entry.availability.servings)) gap = Math.max(0, SERVICE_BUFFER - entry.availability.servings);
      return sum + gap * price;
    }, 0);
  }

  function featuredRecipe() {
    const candidates = recipeEntries().filter((entry) => (
      entry.availability.status === 'ready'
      && entry.financials.incomplete === 0
      && Number.isFinite(entry.financials.margin)
      && entry.financials.margin > 0
    ));
    return candidates.sort((a, b) => b.financials.margin - a.financials.margin)[0] || null;
  }

  function dataCoverage() {
    return [
      { name: 'Inventory', connected: sourceItems().length > 0 },
      { name: 'Recipes', connected: sourceRecipes().length > 0 },
      { name: 'Suppliers', connected: sourceSuppliers().length > 0 || sourceItems().some((item) => item.supplier) },
      { name: 'Operations', connected: Boolean(window.AtlasOperations) },
      { name: 'Sales history', connected: false },
      { name: 'Bookings', connected: false }
    ];
  }

  function venueSchedule(now = new Date()) {
    const day = now.getDay();
    const open = new Date(now);
    open.setHours(11, 30, 0, 0);
    const close = new Date(now);
    if (day === 5 || day === 6) {
      close.setDate(close.getDate() + 1);
      close.setHours(0, 0, 0, 0);
    } else {
      close.setHours(22, 0, 0, 0);
    }

    if (now < open) return { phase: 'before', label: 'Opening in', target: open, open, close };
    if (now < close) return { phase: 'open', label: 'Closes in', target: close, open, close };

    const nextOpen = new Date(now);
    nextOpen.setDate(nextOpen.getDate() + 1);
    nextOpen.setHours(11, 30, 0, 0);
    return { phase: 'after', label: 'Next opening in', target: nextOpen, open, close };
  }

  function durationLabel(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }

  function openingProgress() {
    return readiness().opening || { complete: 0, total: 0, percent: 0 };
  }

  function topBriefing() {
    const data = readiness();
    const issues = recipeIssues();
    const orders = operationOrders().filter((entry) => !entry.ordered);
    const parts = [];
    if (issues.length) {
      const issue = issues[0];
      if (issue.availability.status === 'unavailable') parts.push(`${issue.recipe.name} cannot currently be served`);
      else if (Number.isFinite(issue.availability.servings)) parts.push(`${issue.recipe.name} has approximately ${issue.availability.servings} servings available`);
      else parts.push(`${issue.recipe.name} needs a recipe or inventory check`);
    }
    if (data.low.length) parts.push(`${data.low.length} inventory ${data.low.length === 1 ? 'item is' : 'items are'} below par`);
    if (orders.length) parts.push(`${orders.length} purchasing ${orders.length === 1 ? 'item is' : 'items are'} ready for review`);
    if (!parts.length) return 'Current inventory, recipe availability and service checks indicate a clear start to the day.';
    return `${parts.slice(0, 2).join('. ')}.`;
  }

  function recommendations() {
    const result = [];
    const low = lowInventory();
    const issues = recipeIssues();
    const orders = operationOrders().filter((entry) => !entry.ordered);
    const opening = openingProgress();
    const featured = featuredRecipe();

    if (orders.length) {
      const suppliers = new Set(orders.map((entry) => entry.supplier));
      result.push({
        icon: 'truck',
        title: `Review ${orders.length} suggested purchasing ${orders.length === 1 ? 'item' : 'items'}`,
        detail: `${suppliers.size} ${suppliers.size === 1 ? 'supplier is' : 'suppliers are'} included in the current recommendation.`,
        action: 'Open orders',
        target: 'operations-orders'
      });
    } else if (low.length) {
      result.push({ icon: 'package-search', title: 'Review low inventory', detail: `${low.length} items are currently at or below par.`, action: 'Open inventory', target: 'inventory' });
    }

    if (issues.length) {
      const issue = issues[0];
      result.push({
        icon: 'martini',
        title: `Resolve ${issue.recipe.name}`,
        detail: issue.availability.status === 'unavailable'
          ? 'This recipe cannot currently be served.'
          : Number.isFinite(issue.availability.servings)
            ? `Approximately ${issue.availability.servings} servings remain.`
            : 'Inventory links or package information need review.',
        action: 'Review recipe',
        target: 'recipes'
      });
    }

    if (opening.total && opening.complete < opening.total) {
      result.push({
        icon: 'clipboard-check',
        title: `Complete ${opening.total - opening.complete} opening ${opening.total - opening.complete === 1 ? 'check' : 'checks'}`,
        detail: `${opening.complete} of ${opening.total} opening tasks are complete.`,
        action: 'Open checklist',
        target: 'operations-checklist'
      });
    }

    if (featured) {
      result.push({
        icon: 'badge-percent',
        title: `Feature ${featured.recipe.name}`,
        detail: `Ready for service with an estimated ${featured.financials.margin.toFixed(0)}% gross margin.`,
        action: 'Open recipes',
        target: 'recipes'
      });
    }

    if (!result.length) {
      result.push({ icon: 'circle-check-big', title: 'No urgent action required', detail: 'Atlas has not detected an immediate service risk from the currently connected data.', action: 'View operations', target: 'operations' });
    }

    return result.slice(0, 5);
  }

  function timelineEntries(now = new Date()) {
    const day = now.getDay();
    const entries = [
      { time: '11:00', title: 'Opening checks', detail: 'Complete the final service-readiness review.' },
      { time: '11:30', title: 'Open', detail: 'VÁ opens for service.' },
      { time: '15:00', title: 'Happy Hour', detail: 'Cocktail, wine and beer offers begin.' }
    ];
    if (day === 0) entries.push({ time: '18:00', title: 'Sunday beer promotion', detail: 'Two-for-one beer offer begins.' });
    if (day === 5 || day === 6) entries.push({ time: '22:00', title: 'Late Happy Hour', detail: 'Friday and Saturday late offer begins.' });
    entries.push({ time: (day === 5 || day === 6) ? '24:00' : '22:00', title: 'Close', detail: 'Complete closing checks and handover.' });

    const minutesNow = now.getHours() * 60 + now.getMinutes();
    let currentAssigned = false;
    return entries.map((entry) => {
      const [hoursRaw, minutesRaw] = entry.time.split(':').map(Number);
      const minutes = hoursRaw === 24 ? 1440 : hoursRaw * 60 + minutesRaw;
      let status = 'future';
      if (minutes < minutesNow) status = 'past';
      if (!currentAssigned && minutes >= minutesNow) {
        status = 'current';
        currentAssigned = true;
      }
      return { ...entry, status };
    });
  }

  function assistantResponse(question) {
    const query = String(question || '').trim().toLowerCase();
    const data = readiness();
    const issues = recipeIssues();
    const orders = operationOrders().filter((entry) => !entry.ordered);
    const featured = featuredRecipe();
    const opening = openingProgress();

    if (!query || query.includes('attention') || query.includes('priority')) {
      const list = recommendations().slice(0, 3).map((entry, index) => `${index + 1}. ${entry.title}. ${entry.detail}`);
      return list.join('\n');
    }
    if (query.includes('order') || query.includes('purchase')) {
      if (!orders.length) return 'No unconfirmed purchasing suggestions are currently required.';
      const suppliers = Array.from(new Set(orders.map((entry) => entry.supplier))).join(', ');
      const estimated = orders.reduce((sum, entry) => sum + number(entry.estimatedCost), 0);
      return `${orders.length} suggested purchasing ${orders.length === 1 ? 'item is' : 'items are'} ready across ${suppliers}. Current estimated value: ${formatIsk(estimated)}.`;
    }
    if (query.includes('promote') || query.includes('feature') || query.includes('marketing')) {
      if (!featured) return 'Atlas needs complete recipe cost and price data before recommending a recipe to feature.';
      return `${featured.recipe.name} is the strongest current feature candidate. It is ready for service with an estimated ${featured.financials.margin.toFixed(0)}% gross margin.`;
    }
    if (query.includes('ready') || query.includes('service')) {
      return `Service readiness is ${data.score}%. ${topBriefing()} Opening checks are ${opening.complete} of ${opening.total} complete.`;
    }
    if (query.includes('recipe')) {
      if (!issues.length) return 'All active recipes with complete inventory links are currently ready for service.';
      const issue = issues[0];
      return `${issue.recipe.name} requires attention first. ${issue.availability.status === 'unavailable' ? 'It cannot currently be served.' : Number.isFinite(issue.availability.servings) ? `Approximately ${issue.availability.servings} servings remain.` : 'Its inventory setup is incomplete.'}`;
    }
    if (query.includes('stock') || query.includes('inventory')) {
      const low = lowInventory();
      if (!low.length) return 'Inventory levels are currently above their configured par levels.';
      return `${low.length} inventory ${low.length === 1 ? 'item is' : 'items are'} at or below par. The first item to review is ${low[0].name}, with ${number(low[0].quantity)} ${low[0].unit || 'units'} in stock.`;
    }
    return 'Ask about today’s priorities, service readiness, purchasing, inventory, recipes, or which recipe to feature.';
  }

  function ensureMarkup() {
    const main = document.querySelector('.atlas-content.standard-view main');
    if (!main || document.getElementById('brain-view')) return;

    const view = document.createElement('div');
    view.id = 'brain-view';
    view.style.display = 'none';
    view.innerHTML = '<section class="brain-shell" id="brain-shell"></section>';
    const operationsView = document.getElementById('operations-view');
    main.insertBefore(view, operationsView || document.getElementById('inventory-view') || null);

    const firstGroup = document.querySelector('.atlas-nav .nav-group');
    if (firstGroup && !document.querySelector('[data-view="brain"]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nav-item';
      button.dataset.view = 'brain';
      button.innerHTML = '<i data-lucide="brain-circuit"></i><span>Atlas Brain</span>';
      const homeButton = firstGroup.querySelector('[data-view="dashboard"]');
      if (homeButton) homeButton.insertAdjacentElement('afterend', button);
      else firstGroup.prepend(button);
      button.addEventListener('click', () => setActiveView('brain'));
    }

    const serviceGrid = document.querySelector('.service-grid');
    if (serviceGrid && !serviceGrid.querySelector('[data-service-view="brain"]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'service-card';
      button.dataset.serviceView = 'brain';
      button.innerHTML = '<i data-lucide="brain-circuit"></i><h3>Atlas Brain</h3><p>Live briefing and recommended actions.</p>';
      serviceGrid.prepend(button);
      button.addEventListener('click', () => {
        document.body.classList.remove('service-mode');
        setActiveView('brain');
      });
    }

    const fabMenu = document.getElementById('fab-menu');
    if (fabMenu && !document.getElementById('fab-open-brain')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'fab-open-brain';
      button.innerHTML = '<i data-lucide="brain-circuit"></i><span>Open Atlas Brain</span>';
      fabMenu.appendChild(button);
      button.addEventListener('click', () => {
        fabMenu.classList.remove('open');
        document.getElementById('fab-btn')?.classList.remove('open');
        setActiveView('brain');
      });
    }

    dom.view = view;
    dom.shell = document.getElementById('brain-shell');
  }

  function metricMarkup(icon, value, label, tone = '') {
    return `<article class="brain-metric" ${tone ? `data-tone="${escape(tone)}"` : ''}><div class="brain-metric-icon"><i data-lucide="${escape(icon)}"></i></div><strong>${escape(value)}</strong><span>${escape(label)}</span></article>`;
  }

  function recommendationsMarkup() {
    return recommendations().map((entry) => `<div class="brain-recommendation"><div class="brain-recommendation-icon"><i data-lucide="${escape(entry.icon)}"></i></div><div><strong>${escape(entry.title)}</strong><span>${escape(entry.detail)}</span></div><button type="button" data-brain-target="${escape(entry.target)}">${escape(entry.action)}</button></div>`).join('');
  }

  function stockMarkup() {
    const low = lowInventory().slice(0, 5);
    if (!low.length) return '<div class="brain-empty">No inventory item is currently at or below its configured par level.</div>';
    return low.map((item) => {
      const par = Math.max(0, number(item.par_level));
      const quantity = Math.max(0, number(item.quantity));
      const percent = par > 0 ? Math.max(0, Math.min(100, (quantity / par) * 100)) : 0;
      return `<div class="brain-stock-row"><div class="brain-stock-copy"><strong>${escape(item.name)}</strong><span>${escape(item.supplier || 'Supplier not assigned')} · Par ${par} ${escape(item.unit || 'units')}</span><div class="brain-stock-meter"><span style="width:${percent}%"></span></div></div><div class="brain-stock-qty"><strong>${quantity}</strong><span>${escape(item.unit || 'units')} in stock</span></div></div>`;
    }).join('');
  }

  function timelineMarkup() {
    return timelineEntries().map((entry) => `<div class="brain-timeline-row is-${escape(entry.status)}"><time>${escape(entry.time)}</time><span class="brain-timeline-marker"></span><div class="brain-timeline-copy"><strong>${escape(entry.title)}</strong><span>${escape(entry.detail)}</span></div></div>`).join('');
  }

  function dataMarkup() {
    return dataCoverage().map((entry) => `<div class="brain-data-row"><span>${escape(entry.name)}</span><span class="brain-data-state"><i class="brain-data-dot ${entry.connected ? 'connected' : 'pending'}"></i>${entry.connected ? 'Connected' : 'Not connected'}</span></div>`).join('');
  }

  function featuredMarkup() {
    const featured = featuredRecipe();
    if (!featured) return '<div class="brain-empty">Complete recipe prices, inventory costs and package sizes to unlock a margin-based feature recommendation.</div>';
    const availability = featured.availability;
    return `<div class="brain-recipe-focus"><div><h3>${escape(featured.recipe.name)}</h3><p>Atlas selected this recipe because it is ready for service and currently has the strongest complete margin signal.</p><div class="brain-recipe-facts"><div class="brain-recipe-fact"><span>Margin</span><strong>${featured.financials.margin.toFixed(0)}%</strong></div><div class="brain-recipe-fact"><span>Cost per serve</span><strong>${escape(formatIsk(featured.financials.perServing))}</strong></div><div class="brain-recipe-fact"><span>Availability</span><strong>${Number.isFinite(availability.servings) ? `${availability.servings} serves` : 'Ready'}</strong></div></div></div><button type="button" class="brain-feature-button" data-brain-target="recipes">Open recipe library</button></div>`;
  }

  function render() {
    if (!dom.shell) return;
    const data = readiness();
    const risk = riskData();
    const issues = recipeIssues();
    const orders = operationOrders().filter((entry) => !entry.ordered);
    const suppliers = new Set(orders.map((entry) => entry.supplier));
    const coverage = dataCoverage();
    const connectedCount = coverage.filter((entry) => entry.connected).length;
    const schedule = venueSchedule();
    const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const answer = state.assistantAnswer || assistantResponse('attention');

    dom.shell.innerHTML = `
      <header class="brain-hero">
        <div class="brain-hero-copy">
          <span class="brain-kicker"><i data-lucide="brain-circuit"></i>Atlas Alpha 0.5</span>
          <h1>${escape(greeting())}, ${escape(userName())}.</h1>
          <p>${escape(date)}. Atlas is reading live stock, recipe, supplier and operations data to prepare one clear management briefing.</p>
          <div class="brain-briefing-line"><i data-lucide="sparkles"></i><span>${escape(topBriefing())}</span></div>
        </div>
        <aside class="brain-hero-panel">
          <div class="brain-clock-label"><span id="brain-clock-phase">${escape(schedule.label)}</span><strong>${schedule.phase === 'open' ? 'Service underway' : 'VÁ Bar'}</strong></div>
          <div class="brain-countdown"><strong id="brain-countdown">${escape(durationLabel(schedule.target - new Date()))}</strong><span>${schedule.phase === 'open' ? 'until today’s close' : 'until the next service opening'}</span><div class="brain-readiness-row"><div class="brain-readiness-track"><span style="width:${data.score}%"></span></div><b>${data.score}% ready</b></div></div>
        </aside>
      </header>

      <section class="brain-metric-grid" aria-label="Atlas Brain summary">
        ${metricMarkup('gauge', `${data.score}%`, 'Service readiness', data.score < 60 ? 'danger' : data.score < 85 ? 'warn' : 'good')}
        ${metricMarkup('shield-alert', risk.label, 'Today’s operational risk', risk.tone)}
        ${metricMarkup('banknote', formatIsk(revenueAtRisk()), 'Estimated menu value at risk', revenueAtRisk() > 0 ? 'warn' : 'good')}
        ${metricMarkup('martini', String(issues.length), 'Recipes needing attention', issues.length ? 'warn' : 'good')}
        ${metricMarkup('database', `${connectedCount}/${coverage.length}`, 'Live data sources connected', connectedCount < coverage.length ? 'warn' : 'good')}
      </section>

      <div class="brain-layout">
        <div class="brain-stack">
          <section class="brain-card">
            <header class="brain-card-head"><div><h2>Atlas recommendations</h2><p>Rule-based actions generated from the data currently connected to VÁ OS.</p></div><button type="button" class="brain-card-action" data-brain-refresh>Refresh analysis</button></header>
            <div class="brain-recommendation-list">${recommendationsMarkup()}</div>
          </section>

          <section class="brain-card">
            <header class="brain-card-head"><div><h2>Featured recipe</h2><p>A ready-for-service recipe with a strong complete margin signal.</p></div></header>
            ${featuredMarkup()}
          </section>

          <section class="brain-card">
            <header class="brain-card-head"><div><h2>Stock intelligence</h2><p>Current items at or below par, ordered by urgency.</p></div><button type="button" class="brain-card-action" data-brain-target="inventory">Open Inventory</button></header>
            <div class="brain-stock-list">${stockMarkup()}</div>
          </section>
        </div>

        <aside class="brain-stack">
          <section class="brain-card">
            <header class="brain-card-head"><div><h2>Ask Atlas</h2><p>Live rule-based answers from the current operating data.</p></div></header>
            <div class="brain-assistant"><div class="brain-assistant-answer" id="brain-assistant-answer">${escape(answer)}</div><div class="brain-prompt-row"><button type="button" data-brain-prompt="What needs attention today?">What needs attention?</button><button type="button" data-brain-prompt="What should I order?">What should I order?</button><button type="button" data-brain-prompt="Which recipe should I promote?">What should I feature?</button></div><form class="brain-assistant-form" id="brain-assistant-form"><input id="brain-assistant-input" placeholder="Ask about stock, recipes, orders or readiness" autocomplete="off" /><button type="submit">Ask</button></form></div>
          </section>

          <section class="brain-card">
            <header class="brain-card-head"><div><h2>Today’s timeline</h2><p>Key VÁ service moments based on the current day.</p></div></header>
            <div class="brain-timeline">${timelineMarkup()}</div>
          </section>

          <section class="brain-card">
            <header class="brain-card-head"><div><h2>Brain data coverage</h2><p>Forecast quality improves as more operating systems are connected.</p></div></header>
            <div class="brain-data-list">${dataMarkup()}</div>
          </section>
        </aside>
      </div>`;

    bindRenderedEvents();
    updateClock();
    if (window.lucide) window.lucide.createIcons();
  }

  function navigate(target) {
    if (target === 'operations-orders' || target === 'operations-checklist') {
      setActiveView('operations');
      requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return;
    }
    setActiveView(target);
  }

  function bindRenderedEvents() {
    dom.shell.querySelectorAll('[data-brain-target]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.brainTarget)));
    dom.shell.querySelector('[data-brain-refresh]')?.addEventListener('click', render);
    dom.shell.querySelectorAll('[data-brain-prompt]').forEach((button) => button.addEventListener('click', () => {
      state.assistantAnswer = assistantResponse(button.dataset.brainPrompt);
      const answer = document.getElementById('brain-assistant-answer');
      if (answer) answer.textContent = state.assistantAnswer;
    }));
    dom.shell.querySelector('#brain-assistant-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = document.getElementById('brain-assistant-input');
      state.assistantAnswer = assistantResponse(input?.value || '');
      const answer = document.getElementById('brain-assistant-answer');
      if (answer) answer.textContent = state.assistantAnswer;
      if (input) input.value = '';
    });
  }

  function updateClock() {
    const schedule = venueSchedule();
    const countdown = document.getElementById('brain-countdown');
    const phase = document.getElementById('brain-clock-phase');
    if (countdown) countdown.textContent = durationLabel(schedule.target - new Date());
    if (phase) phase.textContent = schedule.label;
  }

  function startClock() {
    if (state.timer) window.clearInterval(state.timer);
    state.timer = window.setInterval(updateClock, 1000);
  }

  function renderHomeAugmentation() {
    const focusList = document.getElementById('focus-list');
    if (!focusList) return;
    focusList.querySelectorAll('[data-atlas-brain-focus]').forEach((row) => row.remove());
    const recommendation = recommendations()[0];
    if (!recommendation) return;
    focusList.insertAdjacentHTML('afterbegin', `<div class="focus-row" data-target="brain" data-atlas-brain-focus><span class="focus-dot"></span><span>Atlas Brain: ${escape(recommendation.title)}.</span></div>`);
    if (typeof bindHomeLinks === 'function') bindHomeLinks();
  }

  function patchApplication() {
    if (typeof viewMap !== 'undefined') viewMap.brain = dom.view;
    if (typeof titleMap !== 'undefined') titleMap.brain = 'Atlas Brain';

    if (typeof setActiveView === 'function' && !setActiveView.__atlasBrainPatched) {
      const originalSetActiveView = setActiveView;
      const patchedSetActiveView = function (view) {
        originalSetActiveView(view);
        if (view === 'brain') render();
      };
      patchedSetActiveView.__atlasBrainPatched = true;
      setActiveView = patchedSetActiveView;
    }

    if (typeof loadAll === 'function' && !loadAll.__atlasBrainPatched) {
      const originalLoadAll = loadAll;
      const patchedLoadAll = async function () {
        await originalLoadAll();
        render();
        renderHomeAugmentation();
      };
      patchedLoadAll.__atlasBrainPatched = true;
      loadAll = patchedLoadAll;
    }

    if (typeof renderAtlasHome === 'function' && !renderAtlasHome.__atlasBrainPatched) {
      const originalRenderAtlasHome = renderAtlasHome;
      const patchedRenderAtlasHome = function () {
        originalRenderAtlasHome();
        renderHomeAugmentation();
      };
      patchedRenderAtlasHome.__atlasBrainPatched = true;
      renderAtlasHome = patchedRenderAtlasHome;
    }

    document.getElementById('global-search')?.addEventListener('input', (event) => {
      const query = event.target.value.toLowerCase();
      if (query.includes('brain') || query.includes('briefing') || query.includes('intelligence')) setActiveView('brain');
    });
  }

  function init() {
    if (state.initialized) return;
    ensureMarkup();
    if (!dom.view || !dom.shell) return;
    patchApplication();
    state.initialized = true;
    render();
    renderHomeAugmentation();
    startClock();
    if (window.lucide) window.lucide.createIcons();
  }

  window.AtlasBrain = {
    init,
    render,
    recommendations,
    revenueAtRisk,
    riskData,
    assistantResponse
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
