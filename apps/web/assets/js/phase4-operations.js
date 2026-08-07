(function () {
  'use strict';

  const VERSION = 'atlas-phase4-operations/0.1.0';
  const STYLE_HREF = 'assets/css/phase4-operations.css';
  const POLL_LIMIT = 120;
  const state = {
    installed: false,
    pollCount: 0,
    inventoryMode: 'items',
    purchasingMode: 'suppliers',
    observer: null,
    timer: null,
    navigationPatched: false,
    serviceBuilt: false,
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);

  const renderIcons = () => {
    try { window.lucide?.createIcons?.(); } catch (_) { /* Icons are decorative. */ }
  };

  function ensureStylesheet() {
    if (document.querySelector(`link[href="${STYLE_HREF}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLE_HREF;
    link.dataset.atlasPhase4Operations = 'true';
    document.head.appendChild(link);
  }

  function toast(message, tone = 'neutral') {
    if (typeof window.showToast === 'function') {
      window.showToast(message);
      return;
    }
    let node = document.getElementById('phase4-operational-toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'phase4-operational-toast';
      node.className = 'phase4-operational-toast';
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      document.body.appendChild(node);
    }
    node.dataset.tone = tone;
    node.textContent = message;
    node.classList.add('is-visible');
    window.clearTimeout(node.__atlasTimer);
    node.__atlasTimer = window.setTimeout(() => node.classList.remove('is-visible'), 4200);
  }

  function canManageCommercial() {
    try {
      if (typeof window.atlasCanManageCommercial === 'function') return Boolean(window.atlasCanManageCommercial());
      if (typeof currentProfile !== 'undefined') return Boolean(currentProfile?.active && ['admin', 'manager'].includes(currentProfile.role));
    } catch (_) { /* Profile may not be ready yet. */ }
    return document.body.classList.contains('atlas-commercial-manager');
  }

  function movementRows() {
    try {
      return typeof restockLog !== 'undefined' && Array.isArray(restockLog) ? restockLog : [];
    } catch (_) {
      return [];
    }
  }

  function inventoryRows() {
    try {
      return typeof items !== 'undefined' && Array.isArray(items) ? items : [];
    } catch (_) {
      return [];
    }
  }

  function formatNumber(value, maximumFractionDigits = 2) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return '—';
    return parsed.toLocaleString('en-US', { maximumFractionDigits });
  }

  function formatIsk(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return '—';
    return `${Math.round(parsed).toLocaleString('en-US')} ISK`;
  }

  function formatDate(value) {
    if (!value) return 'Not recorded';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Atlantic/Reykjavik',
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(parsed);
  }

  function movementType(row) {
    const explicit = String(row?.movement_type || row?.type || '').trim().toLowerCase();
    if (explicit) return explicit;
    return Number(row?.quantity_change) >= 0 ? 'restock' : 'adjustment';
  }

  function movementLabel(row) {
    return movementType(row).replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function navigateTo(view) {
    if (view === 'operations') view = 'dashboard';
    try {
      if (typeof window.setActiveView === 'function') {
        window.setActiveView(view);
        return true;
      }
      if (typeof setActiveView === 'function') {
        setActiveView(view);
        return true;
      }
    } catch (_) { /* Fall through to the real navigation control. */ }
    const button = document.querySelector(`.atlas-nav [data-view="${CSS.escape(view)}"],.atlas-nav [data-default="${CSS.escape(view)}"]`);
    button?.click();
    return Boolean(button);
  }

  function setPageTitle(value) {
    const title = document.getElementById('atlas-page-title');
    if (title) title.textContent = value;
  }

  function waitFor(check, timeout = 10000, interval = 80) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const attempt = () => {
        let result = null;
        try { result = check(); } catch (_) { result = null; }
        if (result) { resolve(result); return; }
        if (Date.now() - started >= timeout) { reject(new Error('Atlas workspace did not become ready in time.')); return; }
        window.setTimeout(attempt, interval);
      };
      attempt();
    });
  }

  function baseInventoryElements() {
    return {
      toolbar: document.querySelector('#inventory-view > .toolbar'),
      table: document.getElementById('table-wrap'),
      secondary: document.getElementById('phase4-inventory-secondary'),
      hero: document.getElementById('phase4-inventory-hero'),
    };
  }

  function setBaseInventoryVisible(visible) {
    const elements = baseInventoryElements();
    if (elements.toolbar) elements.toolbar.hidden = !visible;
    if (elements.table) elements.table.hidden = !visible;
    if (elements.secondary) elements.secondary.hidden = visible;
  }

  function syncInventoryTabs() {
    document.querySelectorAll('[data-phase4-inventory-mode]').forEach((button) => {
      const active = button.dataset.phase4InventoryMode === state.inventoryMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.body.dataset.phase4InventoryMode = state.inventoryMode;
  }

  function closeInventoryExtensions() {
    try { window.AtlasStockCounts?.close?.(); } catch (_) { /* no-op */ }
    try { window.AtlasItemMaster?.close?.(); } catch (_) { /* no-op */ }
  }

  function showInventoryItems() {
    navigateTo('inventory');
    closeInventoryExtensions();
    state.inventoryMode = 'items';
    setBaseInventoryVisible(true);
    setPageTitle('Inventory');
    syncInventoryTabs();
    markQuantitiesReadOnly();
  }

  async function openStockCount() {
    navigateTo('inventory');
    closeInventoryExtensions();
    state.inventoryMode = 'count';
    setBaseInventoryVisible(false);
    syncInventoryTabs();
    setPageTitle('Stock count');
    try {
      window.AtlasStockCountBootstrap?.load?.();
      const workspace = await waitFor(() => window.AtlasStockCounts?.open && window.AtlasStockCounts);
      workspace.open();
    } catch (error) {
      state.inventoryMode = 'items';
      setBaseInventoryVisible(true);
      syncInventoryTabs();
      toast(error.message || 'Stock counts are not available yet.', 'error');
    }
  }

  async function openItemMaster() {
    navigateTo('inventory');
    closeInventoryExtensions();
    state.inventoryMode = 'master';
    setBaseInventoryVisible(false);
    syncInventoryTabs();
    setPageTitle('Item master');
    try {
      window.AtlasStockCountBootstrap?.load?.();
      const workspace = await waitFor(() => window.AtlasItemMaster?.open && window.AtlasItemMaster);
      workspace.open();
    } catch (error) {
      state.inventoryMode = 'items';
      setBaseInventoryVisible(true);
      syncInventoryTabs();
      toast(error.message || 'Item master is not available yet.', 'error');
    }
  }

  async function openScanner() {
    try {
      window.AtlasInventoryScannerBootstrap?.load?.();
      const scanner = await waitFor(() => window.AtlasInventoryScanner?.open && window.AtlasInventoryScanner);
      scanner.open();
    } catch (error) {
      toast(error.message || 'Barcode scanner is not available yet.', 'error');
    }
  }

  function openNewRecipe() {
    navigateTo('recipes');
    window.setTimeout(() => {
      if (window.AtlasRecipes?.openEditor) window.AtlasRecipes.openEditor(null);
      else document.getElementById('add-recipe-btn')?.click();
    }, 60);
  }

  function openDelivery() {
    if (!canManageCommercial()) {
      toast('Delivery logging is limited to managers and administrators.', 'warning');
      return;
    }
    document.querySelector('[data-service-action="restock"]')?.click() || document.getElementById('fab-log-restock')?.click();
  }

  function openWasteLogger() {
    if (window.AtlasWaste?.open) {
      window.AtlasWaste.open();
      return;
    }
    toast('Waste review is available, but the controlled waste-write gateway is not enabled. No stock was changed.', 'warning');
  }

  function renderMovementCards(mode) {
    const rows = movementRows().filter((row) => {
      if (mode === 'waste') return /waste|breakage|spoil|spill|comp/.test(movementType(row));
      if (mode === 'deliveries') return /restock|delivery|purchase/.test(movementType(row));
      return true;
    });
    const title = mode === 'waste' ? 'Waste evidence' : mode === 'deliveries' ? 'Delivery history' : 'Inventory movements';
    const copy = mode === 'waste'
      ? 'Explicitly recorded waste events only. Atlas does not infer waste or attribute unexplained variance to a person.'
      : mode === 'deliveries'
        ? 'Recorded incoming stock and delivery movements. Supplier submission remains outside Atlas.'
        : 'Auditable stock movements from controlled workflows.';
    const totalChange = rows.reduce((sum, row) => sum + (Number(row.quantity_change) || 0), 0);
    const cards = rows.length ? rows.slice(0, 80).map((row) => {
      const quantity = Number(row.quantity_change);
      const tone = quantity < 0 ? 'is-negative' : quantity > 0 ? 'is-positive' : 'is-neutral';
      const itemName = row.item_name || row.inventory_items?.name || row.name || 'Inventory item';
      const supplier = row.suppliers?.name || row.supplier_name || row.supplier || '';
      const note = row.note || row.notes || '';
      return `<article class="phase4-movement-row ${tone}">
        <div class="phase4-movement-icon"><i data-lucide="${mode === 'waste' ? 'trash-2' : quantity < 0 ? 'arrow-down-left' : 'arrow-up-right'}"></i></div>
        <div class="phase4-movement-copy"><span>${escapeHtml(movementLabel(row))}</span><strong>${escapeHtml(itemName)}</strong><small>${escapeHtml([supplier, note].filter(Boolean).join(' · ') || 'No additional note')}</small></div>
        <div class="phase4-movement-value"><strong>${Number.isFinite(quantity) ? `${quantity > 0 ? '+' : ''}${formatNumber(quantity)}` : '—'}</strong><span>${escapeHtml(row.unit || row.inventory_unit || '')}</span></div>
        <div class="phase4-movement-meta"><strong>${row.total_cost != null && canManageCommercial() ? formatIsk(row.total_cost) : ''}</strong><span>${escapeHtml(formatDate(row.created_at))}</span></div>
      </article>`;
    }).join('') : `<div class="phase4-operational-empty"><i data-lucide="${mode === 'waste' ? 'shield-check' : 'inbox'}"></i><h3>No ${escapeHtml(title.toLowerCase())} recorded</h3><p>${mode === 'waste' ? 'A single stock count does not prove waste. Explicit waste events will appear here when the approved workflow records them.' : 'Controlled movements will appear here as they are recorded.'}</p></div>`;
    return `<section class="phase4-secondary-workspace">
      <header class="phase4-secondary-head"><div><span>Verified operational evidence</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p></div>${mode === 'waste' ? `<button type="button" class="phase4-secondary-button" data-phase4-action="log-waste"><i data-lucide="plus"></i>Log waste</button>` : ''}</header>
      <div class="phase4-secondary-summary"><article><span>Records</span><strong>${rows.length}</strong></article><article><span>Net quantity change</span><strong>${formatNumber(totalChange)}</strong></article><article><span>Automatic attribution</span><strong>Off</strong></article></div>
      <div class="phase4-movement-list">${cards}</div>
    </section>`;
  }

  function renderInventorySecondary(mode) {
    const host = document.getElementById('phase4-inventory-secondary');
    if (!host) return;
    host.hidden = false;
    host.innerHTML = renderMovementCards(mode);
    renderIcons();
  }

  function showInventorySecondary(mode) {
    navigateTo('inventory');
    closeInventoryExtensions();
    state.inventoryMode = mode;
    setBaseInventoryVisible(false);
    renderInventorySecondary(mode);
    setPageTitle(mode === 'waste' ? 'Waste' : 'Movements');
    syncInventoryTabs();
  }

  function ensureInventoryChrome() {
    const inventory = document.getElementById('inventory-view');
    if (!inventory) return false;
    if (!document.getElementById('phase4-inventory-hero')) {
      const hero = document.createElement('section');
      hero.id = 'phase4-inventory-hero';
      hero.className = 'phase4-operational-hero phase4-inventory-hero';
      hero.innerHTML = `<div class="phase4-operational-heading"><span>Operations · Verified inventory</span><h1>Inventory</h1><p>Count, classify and replenish every item through controlled evidence workflows.</p></div>
        <div class="phase4-operational-actions"><button type="button" class="phase4-secondary-button" data-phase4-action="scan"><i data-lucide="scan-barcode"></i>Scan barcode</button><button type="button" class="phase4-secondary-button" data-phase4-action="item-master"><i data-lucide="list-checks"></i>Item master</button><button type="button" class="phase4-primary-button" data-phase4-action="stock-count"><i data-lucide="clipboard-check"></i>Start stock count</button></div>
        <div class="phase4-segmented" role="tablist" aria-label="Inventory workspace"><button type="button" data-phase4-inventory-mode="items" role="tab">Items</button><button type="button" data-phase4-inventory-mode="count" role="tab">Stock count</button><button type="button" data-phase4-inventory-mode="master" role="tab">Item master</button><button type="button" data-phase4-inventory-mode="movements" role="tab">Movements</button><button type="button" data-phase4-inventory-mode="waste" role="tab">Waste</button></div>
        <div class="phase4-safety-line"><i data-lucide="shield-check"></i><span>Displayed quantities are read-only. A manager-approved count publication or another controlled adjustment is required to change live stock.</span></div>`;
      inventory.insertBefore(hero, inventory.firstChild);
    }
    if (!document.getElementById('phase4-inventory-secondary')) {
      const secondary = document.createElement('div');
      secondary.id = 'phase4-inventory-secondary';
      secondary.hidden = true;
      inventory.appendChild(secondary);
    }
    markQuantitiesReadOnly();
    syncInventoryTabs();
    return true;
  }

  function markQuantitiesReadOnly() {
    document.querySelectorAll('#items-body .qty-input').forEach((input) => {
      input.readOnly = true;
      input.setAttribute('aria-readonly', 'true');
      input.dataset.phase4ReadOnly = 'true';
      input.title = 'Use Stock count or another controlled adjustment to change live stock.';
    });
    document.querySelectorAll('#items-body .step-btn').forEach((button) => {
      button.hidden = true;
      button.tabIndex = -1;
      button.setAttribute('aria-hidden', 'true');
    });
  }

  function ensureHomeActions() {
    const intro = document.getElementById('home-intro');
    if (!intro || document.getElementById('phase4-home-actions')) return Boolean(intro);
    const actions = document.createElement('section');
    actions.id = 'phase4-home-actions';
    actions.className = 'phase4-home-actions';
    actions.setAttribute('aria-label', 'Quick actions');
    actions.innerHTML = `<button type="button" data-phase4-action="stock-count"><span><i data-lucide="clipboard-check"></i></span><strong>Start stock count</strong><small>Private draft by location</small></button>
      <button type="button" data-phase4-action="scan"><span><i data-lucide="scan-barcode"></i></span><strong>Scan barcode</strong><small>Find or observe an item</small></button>
      <button type="button" data-phase4-action="item-master"><span><i data-lucide="list-checks"></i></span><strong>Complete item master</strong><small>Par, supplier, package and cost</small></button>
      <button type="button" data-phase4-action="new-recipe"><span><i data-lucide="martini"></i></span><strong>New recipe</strong><small>Link ingredients to inventory</small></button>
      <button type="button" data-phase4-action="purchasing"><span><i data-lucide="truck"></i></span><strong>Purchasing</strong><small>Review replenishment drafts</small></button>`;
    intro.insertAdjacentElement('afterend', actions);
    return true;
  }

  function patchOperationsNavigation() {
    const operationsButton = document.querySelector('.atlas-nav [data-phase4-destination="operations"],.atlas-nav [data-view="operations"]');
    if (operationsButton) operationsButton.remove();
    if (state.navigationPatched) return;
    state.navigationPatched = true;
    try {
      const original = typeof window.setActiveView === 'function' ? window.setActiveView : null;
      if (original && !original.__atlasPhase4HomeHub) {
        const patched = function (view) {
          return original.call(this, view === 'operations' ? 'dashboard' : view);
        };
        patched.__atlasPhase4HomeHub = true;
        patched.__atlasOriginal = original;
        window.setActiveView = patched;
        try { setActiveView = patched; } catch (_) { /* Global binding may be lexical. */ }
      }
    } catch (_) { /* Navigation still works through the visible Home button. */ }
  }

  function ensureHomeHub() {
    const intro = document.getElementById('home-intro');
    const center = document.getElementById('operations-center');
    if (!intro || !center) return false;
    ensureHomeActions();
    let host = document.getElementById('phase4-home-operations');
    if (!host) {
      host = document.createElement('section');
      host.id = 'phase4-home-operations';
      host.className = 'phase4-home-operations';
      const actions = document.getElementById('phase4-home-actions');
      actions.insertAdjacentElement('afterend', host);
    }
    if (center.parentElement !== host) host.appendChild(center);
    document.getElementById('operations-view')?.setAttribute('hidden', '');
    document.getElementById('home-focus')?.classList.add('phase4-home-legacy');
    document.getElementById('home-metrics')?.classList.add('phase4-home-legacy');
    document.getElementById('dashboard-view')?.classList.add('phase4-home-legacy');
    document.getElementById('low-stock-banner')?.classList.add('phase4-home-legacy');
    const kicker = center.querySelector('.operations-kicker');
    if (kicker) kicker.textContent = 'Today at VÁ';
    const heading = center.querySelector('.operations-hero h1');
    if (heading) heading.textContent = 'Operations Hub';
    patchOperationsNavigation();
    try { window.AtlasOperations?.render?.(); } catch (_) { /* Current render remains. */ }
    return true;
  }

  function purchaseSuggestions() {
    try {
      return Array.isArray(window.AtlasOperations?.orderSuggestions?.()) ? window.AtlasOperations.orderSuggestions() : [];
    } catch (_) {
      return [];
    }
  }

  function renderPurchaseDrafts() {
    const rows = purchaseSuggestions();
    const groups = new Map();
    rows.forEach((row) => {
      const supplier = row.supplier || 'Supplier not assigned';
      if (!groups.has(supplier)) groups.set(supplier, []);
      groups.get(supplier).push(row);
    });
    const content = groups.size ? Array.from(groups, ([supplier, entries]) => {
      const total = entries.reduce((sum, entry) => sum + (Number(entry.estimatedCost) || 0), 0);
      return `<section class="phase4-purchase-group"><header><div><span>Supplier draft</span><h3>${escapeHtml(supplier)}</h3></div><strong>${canManageCommercial() ? formatIsk(total) : `${entries.length} item${entries.length === 1 ? '' : 's'}`}</strong></header>${entries.map((entry) => `<article><div><strong>${escapeHtml(entry.name)}</strong><span>Shortfall ${formatNumber(entry.shortfall)} · review ${formatNumber(entry.orderQuantity)} ${escapeHtml(entry.unit || 'units')}${entry.cases ? ` · ${formatNumber(entry.cases)} case${Number(entry.cases) === 1 ? '' : 's'}` : ''}</span></div><span class="phase4-purchase-state">Review required</span></article>`).join('')}</section>`;
    }).join('') : '<div class="phase4-operational-empty"><i data-lucide="circle-check-big"></i><h3>No replenishment draft is required</h3><p>Atlas will only calculate drafts when par, supplier, package and cost evidence is available.</p></div>';
    return `<section class="phase4-secondary-workspace"><header class="phase4-secondary-head"><div><span>Evidence-backed purchasing</span><h2>Replenishment drafts</h2><p>Case rounding and estimated value are suggestions for manager review. Atlas cannot submit an order.</p></div><button type="button" class="phase4-secondary-button" data-phase4-action="item-master"><i data-lucide="list-checks"></i>Complete blockers</button></header><div class="phase4-purchasing-contract"><i data-lucide="shield-check"></i><span>Draft only · no supplier submission · no automatic ordering · no stock mutation</span></div><div class="phase4-purchase-groups">${content}</div></section>`;
  }

  function renderDeliveryHistory() {
    return renderMovementCards('deliveries');
  }

  function syncPurchasingTabs() {
    document.querySelectorAll('[data-phase4-purchasing-mode]').forEach((button) => {
      const active = button.dataset.phase4PurchasingMode === state.purchasingMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
  }

  function setPurchasingMode(mode) {
    state.purchasingMode = mode;
    const view = document.getElementById('suppliers-view');
    if (!view) return;
    const toolbar = view.querySelector(':scope > .toolbar');
    const table = view.querySelector(':scope > table');
    const empty = document.getElementById('suppliers-empty');
    const workspace = document.getElementById('phase4-purchasing-workspace');
    const showSuppliers = mode === 'suppliers';
    if (toolbar) toolbar.hidden = !showSuppliers;
    if (table) table.hidden = !showSuppliers;
    if (empty && !showSuppliers) empty.style.display = 'none';
    if (workspace) {
      workspace.hidden = showSuppliers;
      if (!showSuppliers) workspace.innerHTML = mode === 'drafts' ? renderPurchaseDrafts() : renderDeliveryHistory();
    }
    syncPurchasingTabs();
    renderIcons();
  }

  function ensurePurchasingChrome() {
    const view = document.getElementById('suppliers-view');
    if (!view) return false;
    if (!document.getElementById('phase4-purchasing-hero')) {
      const hero = document.createElement('section');
      hero.id = 'phase4-purchasing-hero';
      hero.className = 'phase4-operational-hero phase4-purchasing-hero';
      hero.innerHTML = `<div class="phase4-operational-heading"><span>Operations · Purchasing</span><h1>Purchasing</h1><p>Review suppliers, evidence-backed replenishment drafts and recorded deliveries.</p></div><div class="phase4-operational-actions"><button type="button" class="phase4-secondary-button" data-phase4-action="delivery"><i data-lucide="package-plus"></i>Log delivery</button></div><div class="phase4-segmented" role="tablist" aria-label="Purchasing workspace"><button type="button" data-phase4-purchasing-mode="suppliers" role="tab">Suppliers</button><button type="button" data-phase4-purchasing-mode="drafts" role="tab">Purchase drafts</button><button type="button" data-phase4-purchasing-mode="deliveries" role="tab">Deliveries</button></div><div class="phase4-safety-line"><i data-lucide="shield-check"></i><span>Every purchase remains a manager-reviewed draft. Atlas does not submit supplier orders automatically.</span></div>`;
      view.insertBefore(hero, view.firstChild);
    }
    if (!document.getElementById('phase4-purchasing-workspace')) {
      const workspace = document.createElement('div');
      workspace.id = 'phase4-purchasing-workspace';
      workspace.hidden = true;
      view.appendChild(workspace);
    }
    setPurchasingMode(state.purchasingMode);
    return true;
  }

  function ensureRecipesChrome() {
    const dashboard = document.querySelector('#recipes-view .recipe-dashboard');
    if (!dashboard) return false;
    dashboard.classList.add('phase4-recipe-dashboard');
    const intelligence = dashboard.querySelector('.recipe-intelligence-panel');
    if (intelligence && !intelligence.dataset.phase4Brain) {
      intelligence.dataset.phase4Brain = 'true';
      const icon = intelligence.querySelector('.recipe-intelligence-icon');
      if (icon) icon.innerHTML = '<i data-lucide="bot"></i>';
      const label = intelligence.querySelector('.recipe-intelligence-copy > span');
      if (label) label.textContent = 'Atlas Brain';
    }
    return true;
  }

  function serviceActionButton(key, icon, title, copy, options = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `service-card phase4-service-card${options.disabled ? ' is-disabled' : ''}`;
    button.dataset.phase4ServiceAction = key;
    if (options.disabled) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
    button.innerHTML = `<i data-lucide="${icon}"></i><h3>${escapeHtml(title)}</h3><p>${escapeHtml(copy)}</p>${options.badge ? `<span class="phase4-service-badge">${escapeHtml(options.badge)}</span>` : ''}`;
    return button;
  }

  function ensureServiceMode() {
    const grid = document.querySelector('.service-grid');
    if (!grid) return false;
    if (grid.dataset.phase4Operational === VERSION) return true;
    const fragment = document.createDocumentFragment();
    [
      ['items', 'package-search', 'Quick stock check', 'Read current quantities and storage locations.'],
      ['count', 'clipboard-check', 'Start stock count', 'Private mobile count with manager verification.'],
      ['scan', 'scan-barcode', 'Scan barcode', 'Find an item or record count evidence.'],
      ['recipes', 'martini', 'Recipe lookup', 'Fast specs, builds, garnish and availability.'],
      ['checklists', 'list-checks', 'Checklists', 'Opening, closing and service readiness.'],
      ['brief', 'bot', 'Daily brief', 'Evidence-backed priorities from Atlas Brain.'],
      ['waste', 'trash-2', 'Waste review', 'Explicit events only; no automatic blame.'],
    ].forEach((entry) => fragment.appendChild(serviceActionButton(...entry)));
    if (canManageCommercial()) fragment.appendChild(serviceActionButton('delivery', 'package-plus', 'Log delivery', 'Record incoming stock through the controlled adjustment workflow.'));
    fragment.appendChild(serviceActionButton('eighty-six', 'ban', '86 board', 'Service availability control is not configured yet.', { disabled: true, badge: 'Not configured' }));
    grid.replaceChildren(fragment);
    grid.dataset.phase4Operational = VERSION;
    const subtitle = document.querySelector('.service-head p');
    if (subtitle) subtitle.textContent = 'Fast, focused access for a busy shift.';
    state.serviceBuilt = true;
    renderIcons();
    return true;
  }

  function exitServiceMode() {
    document.body.classList.remove('service-mode');
  }

  function serviceAction(action) {
    exitServiceMode();
    if (action === 'items') showInventoryItems();
    else if (action === 'count') openStockCount();
    else if (action === 'scan') openScanner();
    else if (action === 'recipes') navigateTo('recipes');
    else if (action === 'checklists') {
      navigateTo('dashboard');
      window.setTimeout(() => document.getElementById('operations-checklist')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    } else if (action === 'brief') navigateTo('brain');
    else if (action === 'waste') showInventorySecondary('waste');
    else if (action === 'delivery') openDelivery();
  }

  function handleAction(action) {
    if (action === 'stock-count') openStockCount();
    else if (action === 'scan') openScanner();
    else if (action === 'item-master') openItemMaster();
    else if (action === 'new-recipe') openNewRecipe();
    else if (action === 'purchasing') { navigateTo('suppliers'); window.setTimeout(() => setPurchasingMode('drafts'), 50); }
    else if (action === 'delivery') openDelivery();
    else if (action === 'log-waste') openWasteLogger();
  }

  function handleClick(event) {
    const action = event.target.closest('[data-phase4-action]');
    if (action) {
      event.preventDefault();
      handleAction(action.dataset.phase4Action);
      return;
    }
    const inventoryMode = event.target.closest('[data-phase4-inventory-mode]');
    if (inventoryMode) {
      event.preventDefault();
      const mode = inventoryMode.dataset.phase4InventoryMode;
      if (mode === 'items') showInventoryItems();
      else if (mode === 'count') openStockCount();
      else if (mode === 'master') openItemMaster();
      else showInventorySecondary(mode);
      return;
    }
    const purchasingMode = event.target.closest('[data-phase4-purchasing-mode]');
    if (purchasingMode) {
      event.preventDefault();
      setPurchasingMode(purchasingMode.dataset.phase4PurchasingMode);
      return;
    }
    const service = event.target.closest('[data-phase4-service-action]');
    if (service) {
      event.preventDefault();
      serviceAction(service.dataset.phase4ServiceAction);
    }
  }

  function installObservers() {
    if (state.observer) return;
    state.observer = new MutationObserver((records) => {
      if (records.some((record) => record.target?.closest?.('.inventory-scanner-overlay,.stock-count-scan-backdrop,.item-master-drawer'))) return;
      ensureOperationalSurfaces();
      markQuantitiesReadOnly();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function ensureOperationalSurfaces() {
    ensureStylesheet();
    ensureHomeActions();
    ensureHomeHub();
    ensureInventoryChrome();
    ensurePurchasingChrome();
    ensureRecipesChrome();
    ensureServiceMode();
    patchOperationsNavigation();
    renderIcons();
  }

  function install() {
    if (state.installed) return;
    state.installed = true;
    ensureStylesheet();
    document.body.classList.add('atlas-phase4b');
    document.documentElement.dataset.atlasPhase4Operations = VERSION;
    document.addEventListener('click', handleClick, true);
    installObservers();
    ensureOperationalSurfaces();
    state.timer = window.setInterval(() => {
      state.pollCount += 1;
      ensureOperationalSurfaces();
      if (state.pollCount >= POLL_LIMIT || (document.getElementById('phase4-home-operations') && document.getElementById('phase4-inventory-hero') && document.getElementById('phase4-purchasing-hero') && state.serviceBuilt)) {
        window.clearInterval(state.timer);
        state.timer = null;
      }
    }, 250);
    window.addEventListener('pagehide', () => {
      document.removeEventListener('click', handleClick, true);
      state.observer?.disconnect();
      if (state.timer) window.clearInterval(state.timer);
    }, { once: true });
    window.AtlasPhase4Operations = Object.freeze({
      version: VERSION,
      showInventoryItems,
      openStockCount,
      openItemMaster,
      openScanner,
      showWaste: () => showInventorySecondary('waste'),
      showMovements: () => showInventorySecondary('movements'),
      showPurchaseDrafts: () => setPurchasingMode('drafts'),
      refresh: ensureOperationalSurfaces,
    });
    document.dispatchEvent(new CustomEvent('atlas:phase4b-ready', { detail: { version: VERSION } }));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();