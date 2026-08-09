/* global compatibility surface for the existing Atlas workflow modules.
 * These bindings point to the single /next.html shell and the same authenticated
 * production client. They do not initialize the retired legacy application.
 */
var sb = null;
var currentUser = null;
var items = [];
var recipes = [];
var suppliers = [];
var restockLog = [];
var activeView = 'home';
var viewMap = Object.create(null);
var titleMap = Object.create(null);

var setActiveView = function setActiveView(view) {
  return window.AtlasNextWorkspaces?.navigateLegacy?.(view);
};

var renderAtlasHome = function renderAtlasHome() {
  return window.AtlasNext?.renderHome?.();
};

var bindHomeLinks = function bindHomeLinks() {};

var showToast = function showToast(message, duration) {
  return window.AtlasNext?.toast?.(message, duration);
};

var loadItems = async function loadItems() {
  await window.AtlasNext?.refresh?.({ quiet: true });
  return items;
};

var loadAll = async function loadAll() {
  await window.AtlasNext?.refresh?.({ quiet: true });
  return { items, recipes, suppliers, restockLog };
};

var canManageCommercial = function canManageCommercial() {
  return ['admin', 'manager'].includes(document.body.dataset.atlasRole || '');
};

var atlasCanManageCommercial = canManageCommercial;

var openRestockModal = function openRestockModal() {
  window.AtlasNextPurchasing?.openRestock?.();
};

var openSupplierModal = function openSupplierModal() {
  window.AtlasNextPurchasing?.openSupplier?.();
};

(() => {
  'use strict';

  const ROUTE_TITLES = Object.freeze({
    operations: 'Operations',
    recipes: 'Recipes',
    purchasing: 'Purchasing',
    imports: 'Import Center',
    review: 'Real VÁ Data',
    marketing: 'Marketing',
    messages: 'Messages',
    team: 'Team',
    shifts: 'Shifts',
    knowledge: 'Knowledge',
    brain: 'Atlas Brain',
    business: 'Business Intelligence',
    reports: 'Reports',
    settings: 'Settings',
    system: 'System',
  });

  const LEGACY_ROUTES = Object.freeze({
    dashboard: 'home',
    home: 'home',
    inventory: 'inventory',
    operations: 'operations',
    recipes: 'recipes',
    suppliers: 'purchasing',
    purchasing: 'purchasing',
    imports: 'imports',
    'sprint3-review': 'review',
    review: 'review',
    marketing: 'marketing',
    messages: 'messages',
    team: 'messages',
    'team-profiles': 'team',
    profiles: 'team',
    shifts: 'shifts',
    knowledge: 'knowledge',
    brain: 'brain',
    business: 'business',
    reports: 'reports',
    settings: 'settings',
    system: 'system',
  });

  const HOSTS = Object.freeze({
    operations: 'operations-center',
    recipes: 'recipes-view',
    purchasing: 'purchasing-view',
    imports: 'imports-view',
    review: 'sprint3-review-view',
    marketing: 'marketing-view',
    messages: 'team-view',
    team: 'team-profiles-view',
    shifts: 'shifts-view',
    knowledge: 'knowledge-view',
    brain: 'brain-shell',
    business: 'business-view',
    reports: 'reports-view',
    settings: 'settings-view',
    system: 'system-view',
  });

  const state = {
    route: null,
    activateSerial: 0,
    itemMasterOpen: false,
    initialized: false,
  };

  function iconRefresh() {
    try { window.lucide?.createIcons?.(); } catch (_) { /* icons are optional */ }
  }

  function connectedMain() {
    return document.getElementById('connected-workspace-main');
  }

  function allHosts() {
    const main = connectedMain();
    return main ? Array.from(main.children).filter((child) => child instanceof HTMLElement) : [];
  }

  function hideConnectedHosts(except = null) {
    allHosts().forEach((host) => {
      if (host === except) return;
      host.hidden = true;
      host.style.display = 'none';
    });
  }

  function showHost(host) {
    if (!(host instanceof HTMLElement)) return;
    hideConnectedHosts(host);
    host.hidden = false;
    host.style.display = 'block';
  }

  function compatibilityTitle(value) {
    const title = document.getElementById('atlas-page-title');
    if (title) title.textContent = value || '';
  }

  function restoreVisibleNavigation(route) {
    document.querySelectorAll('#sidebar-nav .nav-item[data-view]').forEach((button) => {
      const selected = button.dataset.view === route;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function hostFor(route) {
    const id = HOSTS[route];
    return id ? document.getElementById(id) : null;
  }

  function loadingHost(route) {
    const main = connectedMain();
    if (!main) return null;
    let host = document.getElementById(`atlas-connected-loading-${route}`);
    if (!host) {
      host = document.createElement('section');
      host.id = `atlas-connected-loading-${route}`;
      host.dataset.atlasConnectedHost = route;
      host.className = 'atlas-connected-loading';
      host.innerHTML = `<span aria-hidden="true"></span><h2>${ROUTE_TITLES[route] || 'Atlas workspace'}</h2><p>Connecting the existing authenticated workflow…</p>`;
      main.appendChild(host);
    }
    return host;
  }

  function invokeRoute(route) {
    try {
      if (route === 'operations') window.AtlasCheckpointA?.load?.();
      else if (route === 'recipes') window.AtlasRecipes?.render?.();
      else if (route === 'purchasing') window.AtlasNextPurchasing?.open?.();
      else if (route === 'imports') window.AtlasImportCenter?.render?.();
      else if (route === 'review') window.AtlasSprint3Review?.refresh?.(false);
      else if (route === 'marketing') window.AtlasMarketingWorkspace?.refresh?.();
      else if (route === 'messages') window.AtlasTeamMessages?.refresh?.();
      else if (route === 'team') window.AtlasTeamProfiles?.open?.();
      else if (route === 'shifts') window.AtlasShifts?.refresh?.();
      else if (route === 'knowledge') window.AtlasKnowledge?.refresh?.();
      else if (route === 'brain') {
        window.AtlasDailyBriefing?.refresh?.();
        window.AtlasPhase3Brain?.refresh?.();
        window.AtlasCheckpointK?.refresh?.();
      } else if (route === 'business') window.AtlasBusiness?.render?.();
      else if (route === 'reports') window.AtlasReports?.refresh?.();
      else if (route === 'settings') window.AtlasSettings?.refresh?.();
      else if (route === 'system') window.AtlasSystem?.refresh?.();
    } catch (error) {
      console.warn(`Atlas ${route} activation warning`, error);
    }
  }

  function waitForHost(route, serial, attempt = 0) {
    if (serial !== state.activateSerial || state.route !== route) return;
    const host = hostFor(route);
    if (host) {
      document.querySelector(`#atlas-connected-loading-${CSS.escape(route)}`)?.remove();
      showHost(host);
      compatibilityTitle(ROUTE_TITLES[route]);
      invokeRoute(route);
      window.requestAnimationFrame(() => {
        restoreVisibleNavigation(route);
        iconRefresh();
      });
      return;
    }
    if (attempt >= 30) {
      const loading = loadingHost(route);
      if (loading) {
        loading.className = 'atlas-connected-error';
        loading.innerHTML = `<i data-lucide="triangle-alert"></i><h2>${ROUTE_TITLES[route] || 'Workspace'} could not mount</h2><p>The existing gateway module did not initialize. No operational change was performed.</p><button type="button" class="atlas-button secondary" data-connected-retry="${route}">Try again</button>`;
        iconRefresh();
      }
      return;
    }
    showHost(loadingHost(route));
    window.setTimeout(() => waitForHost(route, serial, attempt + 1), 120);
  }

  function activate(route) {
    if (!ROUTE_TITLES[route]) return;
    state.route = route;
    state.activateSerial += 1;
    const serial = state.activateSerial;
    activeView = route;
    compatibilityTitle(ROUTE_TITLES[route]);
    invokeRoute(route);
    waitForHost(route, serial);
  }

  function navigateLegacy(view) {
    const normalized = LEGACY_ROUTES[String(view || '').trim()] || String(view || '').trim();
    if (!normalized) return;
    if (normalized === 'home' || normalized === 'inventory') {
      window.AtlasNext?.navigate?.(normalized);
      return;
    }
    window.AtlasNext?.navigate?.(normalized);
  }

  function updateData(detail = {}) {
    sb = detail.client || sb;
    currentUser = detail.session?.user || currentUser;
    items = Array.isArray(detail.inventory) ? detail.inventory : items;
    recipes = Array.isArray(detail.recipes) ? detail.recipes : recipes;
    suppliers = Array.isArray(detail.suppliers) ? detail.suppliers : suppliers;
    restockLog = Array.isArray(detail.movements) ? detail.movements : restockLog;
    window.sb = sb;
    window.atlasSupabase = sb;
    window.currentUser = currentUser;
    window.items = items;
    window.recipes = recipes;
    window.suppliers = suppliers;
    window.restockLog = restockLog;
    if (state.route) invokeRoute(state.route);
  }

  function syncAuth(detail = {}) {
    sb = detail.client || sb;
    currentUser = detail.session?.user || null;
    window.sb = sb;
    window.atlasSupabase = sb;
    window.currentUser = currentUser;
  }

  function markItemMasterTab() {
    const tabs = document.querySelector('.atlas-inventory-sections');
    if (!tabs) return;
    tabs.querySelectorAll('[data-atlas-inventory-section]').forEach((button) => {
      const selected = button.dataset.atlasInventorySection === 'item-master';
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    restoreVisibleNavigation('inventory');
    document.getElementById('page-title').textContent = 'Item master';
  }

  function ensureItemMasterTab(attempt = 0) {
    const tabs = document.querySelector('.atlas-inventory-sections');
    if (tabs) {
      if (!tabs.querySelector('[data-atlas-inventory-section="item-master"]')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.atlasInventorySection = 'item-master';
        button.innerHTML = '<i data-lucide="list-checks"></i><span>Item master</span>';
        tabs.appendChild(button);
        iconRefresh();
      }
      return;
    }
    if (attempt < 30) window.setTimeout(() => ensureItemMasterTab(attempt + 1), 120);
  }

  function openItemMaster() {
    window.AtlasNextStockCounts?.close?.();
    window.AtlasNext?.navigate?.('inventory');
    state.itemMasterOpen = true;
    window.setTimeout(() => {
      window.AtlasItemMaster?.open?.();
      markItemMasterTab();
    }, 0);
  }

  function closeItemMaster() {
    if (!state.itemMasterOpen) return;
    state.itemMasterOpen = false;
    window.AtlasItemMaster?.close?.();
  }

  function bindCompatibilityNavigation() {
    document.querySelector('.atlas-next-compatibility')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-view]');
      if (!button || button.dataset.itemMasterL2 === 'true') return;
      event.preventDefault();
      const subview = button.dataset.subview;
      if (subview === 'Stock count') window.AtlasNextStockCounts?.open?.();
      else setActiveView(button.dataset.view);
    });
  }

  function captureActions(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const itemMaster = target.closest('[data-atlas-inventory-section="item-master"], [data-item-master-l2]');
    if (itemMaster) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openItemMaster();
      return;
    }

    const inventorySection = target.closest('[data-atlas-inventory-section]');
    if (inventorySection && inventorySection.dataset.atlasInventorySection !== 'item-master') closeItemMaster();

    if (target.closest('[data-action="scan"], [data-service-action="scan"]')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      document.getElementById('service-overlay')?.setAttribute('hidden', '');
      window.AtlasInventoryScanner?.open?.();
      return;
    }

    if (target.closest('[data-service-view="recipes"]')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      document.getElementById('service-overlay')?.setAttribute('hidden', '');
      window.AtlasRecipes?.openServiceLibrary?.();
      return;
    }

    if (target.closest('[data-service-view="knowledge"]')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      document.getElementById('service-overlay')?.setAttribute('hidden', '');
      window.AtlasNext?.navigate?.('knowledge');
      return;
    }

    const retry = target.closest('[data-connected-retry]');
    if (retry) {
      event.preventDefault();
      activate(retry.dataset.connectedRetry);
    }
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    bindCompatibilityNavigation();
    document.addEventListener('click', captureActions, true);
    document.addEventListener('atlas:auth', (event) => syncAuth(event.detail || {}));
    document.addEventListener('atlas:data', (event) => updateData(event.detail || {}));
    document.addEventListener('atlas:navigate', (event) => {
      const route = event.detail?.view;
      if (ROUTE_TITLES[route]) activate(route);
      else {
        state.route = null;
        state.activateSerial += 1;
        hideConnectedHosts();
        if (route !== 'inventory') closeItemMaster();
      }
    });
    ensureItemMasterTab();
  }

  window.AtlasNextWorkspaces = Object.freeze({
    activate,
    navigateLegacy,
    updateData,
    openItemMaster,
    closeItemMaster,
    route: () => state.route,
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
