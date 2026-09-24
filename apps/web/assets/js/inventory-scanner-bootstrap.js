(function () {
  'use strict';

  const SCANNER_SCRIPT = 'assets/js/inventory-scanner.js?v=20260926-s88';
  const SCANNER_STYLE = 'assets/css/inventory-scanner.css';
  const STOCK_COUNT_BOOTSTRAP = 'assets/js/stock-count-bootstrap.js?v=20260926-s88';
  const STOCK_COUNTS_API = String(window.VABAR_CONFIG?.STOCK_COUNTS_API || '').trim();
  const state = {
    loading: false,
    loaded: false,
    stockCountsLoading: false,
    stockCountsLoaded: false,
    pollTimer: null
  };

  function appIsVisible() {
    const login = document.getElementById('login-screen');
    const app = document.getElementById('app-screen');
    if (!app) return false;
    const appVisible = window.getComputedStyle(app).display !== 'none';
    const loginVisible = Boolean(login) && window.getComputedStyle(login).display !== 'none';
    return appVisible && !loginVisible;
  }

  function installInteractionStyles() {
    if (document.getElementById('inventory-scanner-interaction-fix')) return;
    const style = document.createElement('style');
    style.id = 'inventory-scanner-interaction-fix';
    style.textContent = `
      .inventory-scanner-overlay{isolation:isolate!important;pointer-events:auto!important}
      .inventory-scanner-backdrop{z-index:0!important;pointer-events:auto!important}
      .inventory-scanner-panel{z-index:1!important;pointer-events:auto!important}
      .inventory-scanner-panel button,
      .inventory-scanner-panel input,
      .inventory-scanner-panel textarea,
      .inventory-scanner-panel label,
      .inventory-scanner-panel select,
      .inventory-scanner-panel summary{pointer-events:auto!important;touch-action:manipulation}
    `;
    document.head.appendChild(style);
  }

  function loadStylesheet() {
    if (document.querySelector(`link[href="${SCANNER_STYLE}"]`)) return;
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = SCANNER_STYLE;
    stylesheet.dataset.atlasInventoryScanner = 'true';
    document.head.appendChild(stylesheet);
  }

  // Both runtimes load through AtlasShell.load (deduplicated, no global API
  // replacement). The scanner registers its own capture-phase handlers.
  function loadStockCounts() {
    const cfg = window.VABAR_CONFIG = window.VABAR_CONFIG || {};
    cfg.STOCK_COUNTS_API = cfg.STOCK_COUNTS_API || STOCK_COUNTS_API;
    if (!appIsVisible() || state.stockCountsLoading || state.stockCountsLoaded || window.AtlasStockCountBootstrap) return;

    state.stockCountsLoading = true;
    window.AtlasShell.load(STOCK_COUNT_BOOTSTRAP, { global: 'AtlasStockCountBootstrap', dataset: { atlasStockCountBootstrap: 'true' } })
      .then(() => {
        state.stockCountsLoading = false;
        state.stockCountsLoaded = true;
        window.AtlasStockCountBootstrap?.load?.();
      })
      .catch(() => {
        state.stockCountsLoading = false;
        console.error('Stock count could not load.');
      });
  }

  function loadScanner() {
    if (!appIsVisible() || state.loading || state.loaded || window.AtlasInventoryScanner) return;

    state.loading = true;
    loadStylesheet();
    installInteractionStyles();
    window.AtlasShell.load(SCANNER_SCRIPT, { global: 'AtlasInventoryScanner', async: true, dataset: { atlasInventoryScanner: 'true' } })
      .then(() => {
        state.loading = false;
        state.loaded = true;
      })
      .catch(() => {
        state.loading = false;
        console.error('Atlas bottle scanner could not load.');
      });
  }

  function checkState() {
    if (!appIsVisible()) {
      document.body.classList.remove('inventory-scanner-open');
      document.querySelectorAll('.inventory-scanner-overlay').forEach((overlay) => {
        overlay.hidden = true;
      });
      return;
    }
    loadScanner();
    loadStockCounts();
  }

  function init() {
    const cfg = window.VABAR_CONFIG = window.VABAR_CONFIG || {};
    cfg.STOCK_COUNTS_API = cfg.STOCK_COUNTS_API || STOCK_COUNTS_API;
    installInteractionStyles();
    checkState();

    // The signed-in shell announces itself through AtlasShell (a view opens or
    // data loads); the short poll covers a bootstrap that arrives before either.
    window.AtlasShell.on('view:show', checkState);
    window.AtlasShell.onDataLoaded(checkState);

    state.pollTimer = window.setInterval(() => {
      checkState();
      if (state.loaded && state.stockCountsLoaded) {
        window.clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    }, 400);

    window.addEventListener('pagehide', () => {
      if (state.pollTimer) window.clearInterval(state.pollTimer);
      window.AtlasInventoryScanner?.stop?.();
    }, { once: true });
  }

  window.AtlasInventoryScannerBootstrap = {
    load: checkState,
    loaded: () => state.loaded,
    stockCountsLoaded: () => state.stockCountsLoaded
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
