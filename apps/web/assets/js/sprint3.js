(function () {
  'use strict';

  const VERSION = '3.0.0';
  const state = {
    view: 'dashboard',
    navKey: null,
    recipeFilter: 'all',
    refreshQueued: false
  };

  function dotGroup(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '0';
    return Math.round(numeric).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function isk(value) {
    return `${dotGroup(value)} ISK`;
  }

  function normalizeIskText(text) {
    if (!text || !/ISK\b/i.test(text)) return text;
    return text.replace(/(-?\d(?:[\d.,\u00a0 ]*\d)?)\s*ISK\b/gi, (match, raw) => {
      const negative = raw.trim().startsWith('-');
      const digits = raw.replace(/\D/g, '');
      if (!digits) return match;
      const grouped = digits.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      return `${negative ? '-' : ''}${grouped || '0'} ISK`;
    });
  }

  function normalizeIskNode(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      const parent = root.parentElement;
      if (!parent || parent.closest('script,style,textarea,code,pre')) return;
      const next = normalizeIskText(root.nodeValue);
      if (next !== root.nodeValue) root.nodeValue = next;
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE && root.matches('script,style,textarea,code,pre')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(normalizeIskNode);
  }

  function replaceSidebarBrand() {
    const brand = document.querySelector('.atlas-brand');
    if (!brand || brand.classList.contains('atlas-brand-sprint3')) return;
    brand.classList.add('atlas-brand-sprint3');
    brand.innerHTML = `
      <div class="atlas-logo">
        <img src="assets/logo/atlas-icon.png" alt="Atlas" width="132" />
      </div>
      <small>Hospitality OS · VÁ</small>`;
  }

  function decorateSubNavigation() {
    document.querySelectorAll('.nav-sub .nav-item').forEach((button) => {
      button.classList.add('nav-sub-item');
    });
  }

  function selectorEscape(value) {
    const text = String(value ?? '');
    if (window.CSS?.escape) return window.CSS.escape(text);
    return text.replace(/[\\"]/g, '\\$&');
  }

  function buttonKey(button) {
    if (!button) return null;
    if (button.dataset.recipeFilter) return `recipe:${button.dataset.recipeFilter}`;
    if (button.dataset.subview) return `sub:${button.dataset.view || ''}:${button.dataset.subview}`;
    return `view:${button.dataset.view || button.dataset.default || ''}`;
  }

  function openParentFor(button) {
    const sub = button?.closest('.nav-sub');
    if (!sub) return;
    const parent = sub.previousElementSibling;
    if (parent?.classList.contains('nav-parent')) parent.classList.add('open');
  }

  function currentRecipeFilter() {
    const activeChip = document.querySelector('.recipe-category-chip.active[data-category]');
    if (activeChip) return activeChip.dataset.category || 'all';
    return state.recipeFilter || 'all';
  }

  function selectNavigationTarget(view) {
    if (view === 'recipes') {
      state.recipeFilter = currentRecipeFilter();
      return document.querySelector(`.nav-sub [data-recipe-filter="${selectorEscape(state.recipeFilter)}"]`)
        || document.querySelector('.nav-sub [data-recipe-filter="all"]');
    }

    if (state.navKey?.startsWith('sub:')) {
      const parts = state.navKey.split(':');
      const keyView = parts[1];
      const subview = parts.slice(2).join(':');
      if (keyView === view) {
        const target = Array.from(document.querySelectorAll('.nav-sub .nav-item')).find((button) => (
          button.dataset.view === view && button.dataset.subview === subview
        ));
        if (target) return target;
      }
    }

    const topLevel = Array.from(document.querySelectorAll('.atlas-nav > .nav-group > .nav-item[data-view], .atlas-nav .nav-group > .nav-item[data-view]'))
      .find((button) => !button.closest('.nav-sub') && button.dataset.view === view);
    if (topLevel) return topLevel;

    return document.querySelector(`.nav-sub .nav-item[data-view="${selectorEscape(view)}"]`);
  }

  function syncNavigation(view = state.view) {
    decorateSubNavigation();
    document.querySelectorAll('.atlas-nav .nav-item.active').forEach((button) => button.classList.remove('active'));
    const target = selectNavigationTarget(view);
    if (!target) return;
    target.classList.add('active');
    openParentFor(target);
  }

  function renderTopbarTitle(view) {
    const title = document.getElementById('atlas-page-title');
    if (!title) return;
    if (view !== 'brain') {
      title.classList.remove('is-brain-icon');
      title.removeAttribute('aria-label');
      title.removeAttribute('title');
      return;
    }
    title.classList.add('is-brain-icon');
    title.setAttribute('aria-label', 'Atlas Brain');
    title.setAttribute('title', 'Atlas Brain');
    title.innerHTML = '<i data-lucide="brain-circuit" aria-hidden="true"></i>';
    window.lucide?.createIcons?.();
  }

  function sourceItems() {
    try {
      return typeof items !== 'undefined' && Array.isArray(items) ? items : [];
    } catch (error) {
      return [];
    }
  }

  function lowestStockItem() {
    return sourceItems()
      .filter((item) => item?.active !== false && item?.par_level != null)
      .sort((a, b) => {
        const aPar = Number(a.par_level) || 0;
        const bPar = Number(b.par_level) || 0;
        const aRatio = aPar > 0 ? (Number(a.quantity) || 0) / aPar : Number.POSITIVE_INFINITY;
        const bRatio = bPar > 0 ? (Number(b.quantity) || 0) / bPar : Number.POSITIVE_INFINITY;
        return aRatio - bRatio || String(a.name || '').localeCompare(String(b.name || ''));
      })[0] || null;
  }

  function featuredRecipeName() {
    try {
      const recommendations = window.AtlasBrain?.recommendations?.() || [];
      const feature = recommendations.find((entry) => /^Feature\s+/i.test(entry?.title || ''));
      return feature ? feature.title.replace(/^Feature\s+/i, '').trim() : null;
    } catch (error) {
      return null;
    }
  }

  function brainMusingText() {
    const lowest = lowestStockItem();
    const featured = featuredRecipeName();
    if (lowest && featured) {
      return `${lowest.name} is the tightest stock position today; ${featured} remains the strongest feature while its ingredients stay available.`;
    }
    if (lowest) return `${lowest.name} currently has the least stock cover and deserves the next purchasing check.`;
    if (featured) return `${featured} is the clearest recipe to feature based on the currently connected cost and availability data.`;
    return 'No immediate stock constraint or featured-recipe signal is strong enough to change today\'s service plan.';
  }

  function ensureBrainMusing() {
    const briefing = document.querySelector('#brain-view .brain-briefing-line, .brain-view .brain-briefing-line');
    if (!briefing) return;
    let musing = briefing.parentElement?.querySelector('.brain-musing');
    if (!musing) {
      musing = document.createElement('aside');
      musing.className = 'brain-musing';
      musing.setAttribute('aria-label', 'Atlas musing');
      briefing.insertAdjacentElement('afterend', musing);
    }
    musing.textContent = brainMusingText();
  }

  function enhanceMobileNavigation() {
    const button = document.getElementById('mobile-menu-btn');
    const sidebar = document.getElementById('atlas-sidebar');
    if (!button || !sidebar) return;
    button.setAttribute('aria-controls', 'atlas-sidebar');
    button.setAttribute('aria-label', 'Open navigation');
    button.setAttribute('aria-expanded', String(sidebar.classList.contains('open')));
  }

  function patchViewSwitching() {
    if (typeof setActiveView !== 'function' || setActiveView.__atlasSprint3Patched) return;
    const originalSetActiveView = setActiveView;
    const patchedSetActiveView = function (view) {
      state.view = view;
      const result = originalSetActiveView.apply(this, arguments);
      queueMicrotask(() => {
        syncNavigation(view);
        renderTopbarTitle(view);
        if (view === 'brain') ensureBrainMusing();
        normalizeIskNode(document.getElementById('app-screen'));
      });
      return result;
    };
    patchedSetActiveView.__atlasSprint3Patched = true;
    patchedSetActiveView.__atlasSprint3Original = originalSetActiveView;
    setActiveView = patchedSetActiveView;
  }

  function captureNavigationIntent(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target) return;
    const button = target.closest('.atlas-nav .nav-item');
    if (button) {
      state.navKey = buttonKey(button);
      if (button.dataset.recipeFilter) state.recipeFilter = button.dataset.recipeFilter || 'all';
    }

    const chip = target.closest('.recipe-category-chip[data-category]');
    if (chip) {
      state.recipeFilter = chip.dataset.category || 'all';
      state.navKey = `recipe:${state.recipeFilter}`;
      queueMicrotask(() => syncNavigation('recipes'));
    }
  }

  function queueRefresh() {
    if (state.refreshQueued) return;
    state.refreshQueued = true;
    queueMicrotask(() => {
      state.refreshQueued = false;
      replaceSidebarBrand();
      decorateSubNavigation();
      patchViewSwitching();
      enhanceMobileNavigation();
      syncNavigation(state.view);
      renderTopbarTitle(state.view);
      ensureBrainMusing();
      normalizeIskNode(document.getElementById('app-screen'));
    });
  }

  function observeApplication() {
    const target = document.body;
    if (!target) return;
    const observer = new MutationObserver((mutations) => {
      let shouldRefresh = false;
      mutations.forEach((mutation) => {
        if (mutation.type === 'characterData') normalizeIskNode(mutation.target);
        mutation.addedNodes.forEach((node) => {
          normalizeIskNode(node);
          if (node.nodeType === Node.ELEMENT_NODE && (
            node.matches?.('.nav-item,.recipe-category-chip,.brain-briefing-line,#brain-view')
            || node.querySelector?.('.nav-item,.recipe-category-chip,.brain-briefing-line,#brain-view')
          )) shouldRefresh = true;
        });
        if (mutation.type === 'attributes') {
          if (mutation.target.id === 'atlas-sidebar' && mutation.attributeName === 'class') enhanceMobileNavigation();
          if (mutation.target.matches?.('.recipe-category-chip') && mutation.attributeName === 'class') shouldRefresh = true;
        }
      });
      if (shouldRefresh) queueRefresh();
    });
    observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  }

  function detectInitialView() {
    const active = document.querySelector('.atlas-nav .nav-item.active[data-view]');
    state.view = active?.dataset.view || 'dashboard';
    const activeRecipe = document.querySelector('.recipe-category-chip.active[data-category]');
    if (activeRecipe) state.recipeFilter = activeRecipe.dataset.category || 'all';
  }

  function init() {
    detectInitialView();
    document.addEventListener('click', captureNavigationIntent, true);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const sidebar = document.getElementById('atlas-sidebar');
      const backdrop = document.getElementById('sidebar-backdrop');
      sidebar?.classList.remove('open');
      backdrop?.classList.remove('open');
      enhanceMobileNavigation();
    });
    replaceSidebarBrand();
    decorateSubNavigation();
    patchViewSwitching();
    enhanceMobileNavigation();
    observeApplication();
    syncNavigation(state.view);
    renderTopbarTitle(state.view);
    ensureBrainMusing();
    normalizeIskNode(document.getElementById('app-screen'));
    document.documentElement.dataset.atlasSprint = VERSION;
  }

  window.AtlasSprint3 = {
    version: VERSION,
    isk,
    refresh: queueRefresh,
    syncNavigation,
    normalizeIsk: () => normalizeIskNode(document.getElementById('app-screen'))
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
