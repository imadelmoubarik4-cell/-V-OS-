(function () {
  'use strict';

  const state = {
    loading: false,
    loadPromise: null,
    ready: false,
    extensionReady: false,
    itemMasterReady: false,
  };
  const WORKSPACE_SOURCE = 'assets/js/stock-count-workspace.js?v=20260926-s88';
  const EXTENSION_SOURCE = 'assets/js/stock-count-l1-verified.js?v=20260926-s88';
  const ITEM_MASTER_SOURCE = 'assets/js/item-master-workspace.js?v=20260926-s88';
  const ITEM_MASTER_STYLESHEET = 'assets/css/item-master-workspace.css?v=20260806-l2';
  const ITEM_MASTER_API = String(window.VABAR_CONFIG?.ITEM_MASTER_API || '').trim();
  const SCRIPT_TIMEOUT_MS = 8000;

  function ensureStylesheet(href, marker) {
    if (document.querySelector(`link[data-${marker}]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset[marker.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = 'true';
    document.head.appendChild(link);
  }

  // One loader for every inventory runtime: AtlasShell.load deduplicates by
  // path and resolves only once the script has installed its global.
  function loadScript(src, globalName) {
    return window.AtlasShell.load(src, { global: globalName, requireGlobal: true, timeout: SCRIPT_TIMEOUT_MS });
  }

  // S88: the workspace scopes its own visibility handling and re-shows its mount
  // on open(), so the bootstrap no longer wraps AtlasStockCounts.open.
  async function loadStockCountWorkspace() {
    if (!window.AtlasStockCounts) await loadScript(WORKSPACE_SOURCE, 'AtlasStockCounts');
    if (!window.AtlasStockCounts) {
      throw new Error('The canonical Stock Count workspace loaded without installing AtlasStockCounts.');
    }
    state.ready = true;
  }

  // S88: stock-count-l1-verified.js ships its scoped, Lucide-aware observer in
  // its own source, so it loads as a normal script (no source rewrite, no Blob).
  async function loadStockCountExtension() {
    if (!window.AtlasStockCountsL1) await loadScript(EXTENSION_SOURCE, 'AtlasStockCountsL1');
    state.extensionReady = Boolean(window.AtlasStockCountsL1);
    window.AtlasStockCountsL1?.enhance?.();
  }

  async function loadItemMaster() {
    const runtimeConfig = window.VABAR_CONFIG = window.VABAR_CONFIG || {};
    runtimeConfig.ITEM_MASTER_API = runtimeConfig.ITEM_MASTER_API || ITEM_MASTER_API;
    ensureStylesheet(ITEM_MASTER_STYLESHEET, 'atlas-item-master-css');
    if (!window.AtlasItemMaster) await loadScript(ITEM_MASTER_SOURCE, 'AtlasItemMaster');
    state.itemMasterReady = Boolean(window.AtlasItemMaster);
  }

  async function performLoad() {
    state.loading = true;
    ensureStylesheet('assets/css/stock-count-workspace.css?v=20260813-l1-core5', 'atlas-stock-count-css');

    try {
      await loadStockCountWorkspace();
    } catch (error) {
      state.ready = false;
      console.error('Checkpoint L1 stock-count workspace could not be loaded', error);
    }

    try {
      await loadStockCountExtension();
    } catch (error) {
      state.extensionReady = false;
      console.error('Checkpoint L1 stock-count enhancement could not be loaded', error);
    }

    try {
      await loadItemMaster();
    } catch (error) {
      state.itemMasterReady = false;
      console.error('Checkpoint L2 item-master assets could not be loaded', error);
    } finally {
      state.loading = false;
      state.loadPromise = null;
    }
  }

  function load() {
    if (state.ready && state.extensionReady && state.itemMasterReady) return Promise.resolve();
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = performLoad();
    return state.loadPromise;
  }

  function activateInventorySubview(label) {
    document.querySelectorAll('[data-view="inventory"][data-subview]').forEach((item) => {
      item.classList.toggle('active', item.dataset.subview === label);
    });
  }

  function openStockCount() {
    const inventory = document.getElementById('inventory-view');
    if (inventory) inventory.style.display = 'grid';
    const title = document.getElementById('atlas-page-title');
    if (title) title.textContent = 'Stock count';
    activateInventorySubview('Stock count');
    window.AtlasItemMaster?.close?.();
    window.AtlasStockCounts?.open?.();
  }

  function openItemMaster() {
    window.AtlasStockCounts?.close?.();
    window.AtlasItemMaster?.open?.();
  }

  function whenLoaded(open) {
    load().then(() => window.setTimeout(open, 0)).catch((error) => {
      console.error('Inventory workspace navigation could not finish loading', error);
    });
  }

  // Inventory sections are routes: the Stock count tab, Home's "Start stock
  // count" and a #inventory/stock-count link all arrive here through AtlasShell.
  function handleInventoryShown(params) {
    if (params.section === 'stock-count') {
      if (window.AtlasStockCounts) {
        openStockCount();
        load().catch((error) => console.error('Inventory workspace background refresh could not finish loading', error));
      } else {
        whenLoaded(openStockCount);
      }
      return;
    }
    if (params.section === 'item-master') {
      whenLoaded(openItemMaster);
      return;
    }
    if (params.section === 'items') window.setTimeout(() => activateInventorySubview('Items'), 0);
  }

  // The Item master tab is an Inventory control rather than a view of its own.
  function handleItemMasterClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-item-master-l2]')) {
      whenLoaded(openItemMaster);
      return;
    }
    if (!target.closest('[data-view="inventory"][data-subview]') && document.body.classList.contains('stock-count-active')) {
      window.setTimeout(() => activateInventorySubview('Stock count'), 0);
    }
  }

  window.AtlasShell.onView('inventory', { show: handleInventoryShown });
  document.addEventListener('click', handleItemMasterClick);

  window.AtlasStockCountBootstrap = {
    load,
    open: () => window.AtlasShell.show('inventory', { section: 'stock-count' }),
    ready: () => state.ready,
    extensionReady: () => state.extensionReady,
    itemMasterReady: () => state.itemMasterReady,
  };
  if (document.readyState === 'complete') load();
  else window.addEventListener('load', load, { once: true });
})();
