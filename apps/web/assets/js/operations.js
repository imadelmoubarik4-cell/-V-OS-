(function () {
  'use strict';

  const CHECKLISTS = {
    opening: [
      { id: 'cash-pos', label: 'Confirm POS, cash float and card terminals' },
      { id: 'coffee-machine', label: 'Start and test the coffee machine' },
      { id: 'ice', label: 'Check ice production and service wells' },
      { id: 'garnish', label: 'Prepare garnish and fresh citrus' },
      { id: 'glassware', label: 'Polish and stock service glassware' },
      { id: 'bar-stock', label: 'Restock the bar to service levels' },
      { id: 'music-lighting', label: 'Set music, lighting and guest areas' },
      { id: 'toilets', label: 'Complete the guest-area and toilet check' },
      { id: 'tablet', label: 'Charge and position the service tablet' }
    ],
    closing: [
      { id: 'cash-close', label: 'Close and reconcile the register' },
      { id: 'dishwasher', label: 'Empty and clean the dishwasher' },
      { id: 'waste', label: 'Record waste and remove rubbish' },
      { id: 'alcohol', label: 'Secure alcohol and high-value stock' },
      { id: 'bar-clean', label: 'Clean stations, tools and work surfaces' },
      { id: 'equipment', label: 'Switch off and check equipment' },
      { id: 'lights', label: 'Turn off music and non-essential lighting' },
      { id: 'alarm', label: 'Lock doors and set the alarm' },
      { id: 'shift-report', label: 'Submit the shift handover report' }
    ]
  };

  const state = {
    checklistType: 'opening',
    initialized: false
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

  function formatIsk(value) {
    return `${Math.round(number(value)).toLocaleString('en-US')} ISK`;
  }

  function dateKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function checklistStorageKey(type) {
    return `atlas.checklist.${dateKey()}.${type}`;
  }

  function orderedStorageKey() {
    return `atlas.order-status.${dateKey()}`;
  }

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value ?? fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function checklistState(type = state.checklistType) {
    return readJson(checklistStorageKey(type), {});
  }

  function checklistProgress(type = state.checklistType) {
    const definitions = CHECKLISTS[type] || [];
    const saved = checklistState(type);
    const complete = definitions.filter((item) => Boolean(saved[item.id])).length;
    return {
      complete,
      total: definitions.length,
      percent: definitions.length ? Math.round((complete / definitions.length) * 100) : 0
    };
  }

  function lowInventoryItems() {
    return (typeof items !== 'undefined' ? items : []).filter((item) => (
      item.active !== false && item.par_level != null && number(item.quantity) <= number(item.par_level)
    ));
  }

  function recipeIssues() {
    const source = typeof recipes !== 'undefined' ? recipes : [];
    if (!window.AtlasRecipes?.recipeAvailability) return [];
    return source
      .filter((recipe) => recipe.active !== false)
      .map((recipe) => ({ recipe, availability: window.AtlasRecipes.recipeAvailability(recipe) }))
      .filter((entry) => entry.availability.status !== 'ready')
      .sort((a, b) => {
        const rank = { unavailable: 0, attention: 1, incomplete: 2 };
        return (rank[a.availability.status] ?? 9) - (rank[b.availability.status] ?? 9)
          || number(a.availability.servings, 999999) - number(b.availability.servings, 999999);
      });
  }

  function orderedItemIds() {
    return new Set(readJson(orderedStorageKey(), []));
  }

  function orderSuggestions() {
    const ordered = orderedItemIds();
    return lowInventoryItems().map((item) => {
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
        unit: item.unit || 'units',
        supplier: item.supplier || 'Supplier not assigned',
        shortfall,
        orderQuantity,
        cases,
        estimatedCost: cost * orderQuantity,
        ordered: ordered.has(item.id)
      };
    });
  }

  function orderGroups() {
    const groups = new Map();
    orderSuggestions().forEach((suggestion) => {
      if (!groups.has(suggestion.supplier)) groups.set(suggestion.supplier, []);
      groups.get(suggestion.supplier).push(suggestion);
    });
    return Array.from(groups, ([supplier, suggestions]) => ({
      supplier,
      suggestions,
      estimatedCost: suggestions.reduce((sum, item) => sum + item.estimatedCost, 0)
    })).sort((a, b) => b.suggestions.length - a.suggestions.length || a.supplier.localeCompare(b.supplier));
  }

  function readinessData() {
    const low = lowInventoryItems();
    const issues = recipeIssues();
    const opening = checklistProgress('opening');
    const unavailable = issues.filter((entry) => entry.availability.status === 'unavailable').length;
    const incomplete = issues.filter((entry) => entry.availability.status === 'incomplete').length;
    const checklistPenalty = Math.round((100 - opening.percent) * 0.22);
    const score = Math.max(0, Math.min(100,
      100 - Math.min(30, low.length * 4) - Math.min(25, unavailable * 10) - Math.min(15, incomplete * 4) - checklistPenalty
    ));
    let label = 'Ready for service';
    if (score < 85) label = 'Review before service';
    if (score < 60) label = 'Attention required';
    return { score, label, low, issues, opening };
  }

  function priorities() {
    const data = readinessData();
    const orders = orderSuggestions().filter((entry) => !entry.ordered);
    const result = [];

    if (data.low.length) {
      result.push({
        icon: 'package-search',
        title: `${data.low.length} inventory ${data.low.length === 1 ? 'item is' : 'items are'} below par`,
        detail: 'Review current stock and confirm the suggested supplier order.',
        action: 'Review stock',
        target: 'inventory'
      });
    }

    if (data.issues.length) {
      const issue = data.issues[0];
      const availability = issue.availability;
      let detail = 'Recipe setup or inventory links require review.';
      if (availability.status === 'unavailable') detail = 'The recipe cannot currently be served.';
      if (availability.status === 'attention') detail = `Approximately ${availability.servings} servings remain.`;
      result.push({
        icon: 'martini',
        title: issue.recipe.name,
        detail,
        action: 'Review recipe',
        target: 'recipes'
      });
    }

    if (orders.length) {
      const supplierCount = new Set(orders.map((entry) => entry.supplier)).size;
      result.push({
        icon: 'truck',
        title: `Suggested purchasing list: ${orders.length} ${orders.length === 1 ? 'item' : 'items'}`,
        detail: `${supplierCount} ${supplierCount === 1 ? 'supplier needs' : 'suppliers need'} attention.`,
        action: 'Review orders',
        target: 'operations-orders'
      });
    }

    if (data.opening.complete < data.opening.total) {
      result.push({
        icon: 'clipboard-check',
        title: `Opening checklist: ${data.opening.complete} of ${data.opening.total} complete`,
        detail: 'Complete the remaining checks before service.',
        action: 'Open checklist',
        target: 'operations-checklist'
      });
    }

    if (!result.length) {
      result.push({
        icon: 'circle-check-big',
        title: 'VÁ is ready for service',
        detail: 'Inventory, recipe availability and the opening checklist are clear.',
        action: 'View overview',
        target: 'operations'
      });
    }

    return result.slice(0, 4);
  }

  function ensureMarkup() {
    const main = document.querySelector('.atlas-content.standard-view main');
    if (!main || document.getElementById('operations-view')) return;

    const view = document.createElement('div');
    view.id = 'operations-view';
    view.style.display = 'none';
    view.innerHTML = '<section class="operations-center" id="operations-center"></section>';
    const teamView = document.getElementById('team-view');
    main.insertBefore(view, teamView || null);

    const firstGroup = document.querySelector('.atlas-nav .nav-group');
    if (firstGroup && !document.querySelector('[data-view="operations"]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nav-item';
      button.dataset.view = 'operations';
      button.innerHTML = '<i data-lucide="gauge"></i><span>Operations Center</span>';
      firstGroup.appendChild(button);
      button.addEventListener('click', () => setActiveView('operations'));
    }

    const serviceGrid = document.querySelector('.service-grid');
    if (serviceGrid && !serviceGrid.querySelector('[data-service-view="operations"]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'service-card';
      button.dataset.serviceView = 'operations';
      button.innerHTML = '<i data-lucide="clipboard-check"></i><h3>Service Readiness</h3><p>Opening, closing and daily priorities.</p>';
      serviceGrid.prepend(button);
      button.addEventListener('click', () => {
        document.body.classList.remove('service-mode');
        setActiveView('operations');
      });
    }

    const fabMenu = document.getElementById('fab-menu');
    if (fabMenu && !document.getElementById('fab-open-operations')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'fab-open-operations';
      button.innerHTML = '<i data-lucide="gauge"></i><span>Operations Center</span>';
      fabMenu.appendChild(button);
      button.addEventListener('click', () => {
        fabMenu.classList.remove('open');
        document.getElementById('fab-btn')?.classList.remove('open');
        setActiveView('operations');
      });
    }

    dom.view = view;
    dom.center = document.getElementById('operations-center');
  }

  function renderPriorities() {
    const entries = priorities();
    return entries.map((entry) => `
      <div class="operations-priority">
        <div class="operations-priority-icon"><i data-lucide="${escape(entry.icon)}"></i></div>
        <div><strong>${escape(entry.title)}</strong><span>${escape(entry.detail)}</span></div>
        <button type="button" data-operation-target="${escape(entry.target)}">${escape(entry.action)}</button>
      </div>`).join('');
  }

  function renderOrders() {
    const groups = orderGroups();
    if (!groups.length) return '<div class="operations-empty">No purchase suggestions are required at the moment.</div>';

    return groups.map((group) => `
      <section class="operations-order-group">
        <div class="operations-order-group-head">
          <strong>${escape(group.supplier)}</strong>
          <span>${group.suggestions.length} ${group.suggestions.length === 1 ? 'item' : 'items'} · ${formatIsk(group.estimatedCost)}</span>
        </div>
        ${group.suggestions.map((item) => `
          <div class="operations-order-item ${item.ordered ? 'is-ordered' : ''}">
            <div><strong>${escape(item.name)}</strong><span>${item.cases ? `${item.cases} case${item.cases === 1 ? '' : 's'} · ` : ''}${item.orderQuantity} ${escape(item.unit)}</span></div>
            <strong>${formatIsk(item.estimatedCost)}</strong>
            <button type="button" data-order-toggle="${escape(item.id)}">${item.ordered ? 'Reopen' : 'Mark ordered'}</button>
          </div>`).join('')}
      </section>`).join('');
  }

  function renderChecklist() {
    const type = state.checklistType;
    const definitions = CHECKLISTS[type];
    const saved = checklistState(type);
    return definitions.map((item) => `
      <button type="button" class="operations-check-item ${saved[item.id] ? 'is-complete' : ''}" data-operation-check="${escape(item.id)}">
        <span class="operations-check-box">${saved[item.id] ? '<i data-lucide="check"></i>' : ''}</span>
        <span class="operations-check-label">${escape(item.label)}</span>
      </button>`).join('');
  }

  function render() {
    if (!dom.center) return;
    const data = readinessData();
    const orders = orderSuggestions().filter((entry) => !entry.ordered);
    const supplierCount = new Set(orders.map((entry) => entry.supplier)).size;
    const unavailableRecipes = data.issues.filter((entry) => entry.availability.status === 'unavailable').length;
    const checklist = checklistProgress(state.checklistType);
    const dateLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

    dom.center.innerHTML = `
      <header class="operations-hero">
        <div><span class="operations-kicker">Atlas Alpha 0.4</span><h1>Operations Intelligence</h1><p>${escape(dateLabel)}. One calm view of service readiness, stock risk, recipe availability and the tasks that matter today.</p></div>
        <div class="operations-readiness"><span>Service readiness</span><strong>${data.score}%</strong><div class="operations-progress"><span style="width:${data.score}%"></span></div><small>${escape(data.label)}</small></div>
      </header>

      <section class="operations-summary-grid" aria-label="Operations summary">
        <article class="operations-summary-card"><div class="summary-icon"><i data-lucide="package-search"></i></div><div><strong>${data.low.length}</strong><span>Inventory alerts</span></div></article>
        <article class="operations-summary-card"><div class="summary-icon"><i data-lucide="martini"></i></div><div><strong>${data.issues.length}</strong><span>Recipes needing attention</span></div></article>
        <article class="operations-summary-card"><div class="summary-icon"><i data-lucide="truck"></i></div><div><strong>${supplierCount}</strong><span>Suppliers in suggested order</span></div></article>
        <article class="operations-summary-card"><div class="summary-icon"><i data-lucide="clipboard-check"></i></div><div><strong>${data.opening.complete}/${data.opening.total}</strong><span>Opening checks complete</span></div></article>
      </section>

      <div class="operations-layout">
        <div class="operations-stack">
          <section class="operations-card">
            <header class="operations-card-head"><div><h2>Today’s priorities</h2><p>Generated from live operational data.</p></div></header>
            <div class="operations-priority-list">${renderPriorities()}</div>
          </section>

          <section class="operations-card" id="operations-orders">
            <header class="operations-card-head"><div><h2>Suggested purchasing</h2><p>Calculated from current quantity, par level and supplier information.</p></div><button type="button" class="operations-card-action" data-operation-target="suppliers">Open Purchasing</button></header>
            <div class="operations-order-groups">${renderOrders()}</div>
          </section>
        </div>

        <aside class="operations-stack">
          <section class="operations-card" id="operations-checklist">
            <header class="operations-card-head"><div><h2>Daily checklist</h2><p>Progress is saved on this device for today.</p></div></header>
            <div class="operations-checklist-tabs"><button type="button" data-checklist-tab="opening" class="${state.checklistType === 'opening' ? 'active' : ''}">Opening</button><button type="button" data-checklist-tab="closing" class="${state.checklistType === 'closing' ? 'active' : ''}">Closing</button></div>
            <div class="operations-checklist">${renderChecklist()}</div>
            <footer class="operations-checklist-footer"><span>${checklist.complete} of ${checklist.total} complete</span><button type="button" data-checklist-reset>Reset today</button></footer>
          </section>

          <section class="operations-card">
            <header class="operations-card-head"><div><h2>Operational signals</h2><p>Current risk indicators for today’s service.</p></div></header>
            <div class="operations-priority-list">
              <div class="operations-priority"><div class="operations-priority-icon"><i data-lucide="ban"></i></div><div><strong>${unavailableRecipes} unavailable ${unavailableRecipes === 1 ? 'recipe' : 'recipes'}</strong><span>Based on live ingredient coverage.</span></div><button type="button" data-operation-target="recipes">Review</button></div>
              <div class="operations-priority"><div class="operations-priority-icon"><i data-lucide="receipt-text"></i></div><div><strong>${orders.length} unconfirmed order ${orders.length === 1 ? 'item' : 'items'}</strong><span>Mark items ordered as purchasing is completed.</span></div><button type="button" data-operation-target="operations-orders">Review</button></div>
            </div>
          </section>
        </aside>
      </div>`;

    bindRenderedEvents();
    if (window.lucide) window.lucide.createIcons();
  }

  function scrollOperationsTarget(id) {
    setActiveView('operations');
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function bindRenderedEvents() {
    dom.center.querySelectorAll('[data-operation-target]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.operationTarget;
        if (target === 'operations-orders' || target === 'operations-checklist') scrollOperationsTarget(target);
        else setActiveView(target);
      });
    });

    dom.center.querySelectorAll('[data-checklist-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        state.checklistType = button.dataset.checklistTab;
        render();
      });
    });

    dom.center.querySelectorAll('[data-operation-check]').forEach((button) => {
      button.addEventListener('click', () => {
        const saved = checklistState(state.checklistType);
        const id = button.dataset.operationCheck;
        saved[id] = !saved[id];
        writeJson(checklistStorageKey(state.checklistType), saved);
        render();
        renderHomeAugmentation();
      });
    });

    dom.center.querySelector('[data-checklist-reset]')?.addEventListener('click', () => {
      localStorage.removeItem(checklistStorageKey(state.checklistType));
      render();
      renderHomeAugmentation();
    });

    dom.center.querySelectorAll('[data-order-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const ordered = orderedItemIds();
        const id = button.dataset.orderToggle;
        if (ordered.has(id)) ordered.delete(id); else ordered.add(id);
        writeJson(orderedStorageKey(), Array.from(ordered));
        render();
        renderHomeAugmentation();
      });
    });
  }

  function renderHomeAugmentation() {
    const focusList = document.getElementById('focus-list');
    if (!focusList) return;
    focusList.querySelectorAll('[data-atlas-operations-focus]').forEach((row) => row.remove());

    const opening = checklistProgress('opening');
    const orders = orderSuggestions().filter((entry) => !entry.ordered);
    const rows = [];
    if (orders.length) rows.push(`${orders.length} suggested purchasing ${orders.length === 1 ? 'item is' : 'items are'} ready for review.`);
    if (opening.complete < opening.total) rows.push(`Opening checklist: ${opening.complete} of ${opening.total} complete.`);

    rows.reverse().forEach((text) => {
      focusList.insertAdjacentHTML('afterbegin', `<div class="focus-row" data-target="operations" data-atlas-operations-focus><span class="focus-dot"></span><span>${escape(text)}</span></div>`);
    });
    if (typeof bindHomeLinks === 'function') bindHomeLinks();
  }

  function patchApplication() {
    if (typeof viewMap !== 'undefined') viewMap.operations = dom.view;
    if (typeof titleMap !== 'undefined') titleMap.operations = 'Operations Center';

    if (typeof setActiveView === 'function' && !setActiveView.__atlasOperationsPatched) {
      const originalSetActiveView = setActiveView;
      const patchedSetActiveView = function (view) {
        originalSetActiveView(view);
        if (view === 'operations') render();
      };
      patchedSetActiveView.__atlasOperationsPatched = true;
      setActiveView = patchedSetActiveView;
    }

    if (typeof loadAll === 'function' && !loadAll.__atlasOperationsPatched) {
      const originalLoadAll = loadAll;
      const patchedLoadAll = async function () {
        await originalLoadAll();
        render();
        renderHomeAugmentation();
      };
      patchedLoadAll.__atlasOperationsPatched = true;
      loadAll = patchedLoadAll;
    }

    if (typeof renderAtlasHome === 'function' && !renderAtlasHome.__atlasOperationsPatched) {
      const originalRenderAtlasHome = renderAtlasHome;
      const patchedRenderAtlasHome = function () {
        originalRenderAtlasHome();
        renderHomeAugmentation();
      };
      patchedRenderAtlasHome.__atlasOperationsPatched = true;
      renderAtlasHome = patchedRenderAtlasHome;
    }
  }

  function init() {
    if (state.initialized) return;
    ensureMarkup();
    if (!dom.view || !dom.center) return;
    patchApplication();
    state.initialized = true;
    render();
    if (window.lucide) window.lucide.createIcons();
  }

  window.AtlasOperations = {
    init,
    render,
    priorities,
    orderSuggestions,
    readinessData
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
