(function () {
  'use strict';

  const state = {
    loading: false,
    loadPromise: null,
    ready: false,
    runtimePatched: false,
    reentryPatched: false,
    itemMasterReady: false,
  };
  const WORKSPACE_SOURCE = 'assets/js/stock-count-workspace.js?v=20260805-l1';
  const EXTENSION_SOURCE = 'assets/js/stock-count-l1-verified.js?v=20260805-l1';
  const ITEM_MASTER_SOURCE = 'assets/js/item-master-workspace.js?v=20260806-l2';
  const ITEM_MASTER_STYLESHEET = 'assets/css/item-master-workspace.css?v=20260806-l2';
  const ITEM_MASTER_API = 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-item-master';

  function ensureStylesheet(href, marker) {
    if (document.querySelector(`link[data-${marker}]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset[marker.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = 'true';
    document.head.appendChild(link);
  }

  function loadScript(src, marker) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-${marker.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`);
      if (existing) {
        if ((marker === 'atlasStockCountL1Verified' && window.AtlasStockCountsL1)
            || (marker === 'atlasStockCountWorkspace' && window.AtlasStockCounts)
            || (marker === 'atlasItemMaster' && window.AtlasItemMaster)) {
          resolve();
          return;
        }
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.dataset[marker] = 'true';
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true });
      document.body.appendChild(script);
    });
  }

  function installStockCountReentryGuard() {
    const api = window.AtlasStockCounts;
    if (!api || typeof api.open !== 'function') return false;
    if (api.open.__atlasReentryGuard) {
      state.reentryPatched = true;
      return true;
    }

    const nativeOpen = api.open.bind(api);
    const guardedOpen = (...args) => {
      const mount = document.getElementById('stock-count-workspace');
      if (mount) mount.hidden = false;
      return nativeOpen(...args);
    };
    guardedOpen.__atlasReentryGuard = true;
    guardedOpen.__atlasOriginal = nativeOpen;
    api.open = guardedOpen;
    state.reentryPatched = true;
    return true;
  }

  async function loadStockCountWorkspace() {
    if (!window.AtlasStockCounts) {
      await loadScript(WORKSPACE_SOURCE, 'atlasStockCountWorkspace');
    }
    if (!window.AtlasStockCounts) {
      throw new Error('The canonical Stock Count workspace loaded without installing AtlasStockCounts.');
    }
    installStockCountReentryGuard();
    state.runtimePatched = false;
  }

  async function loadItemMaster() {
    const runtimeConfig = window.VABAR_CONFIG = window.VABAR_CONFIG || {};
    runtimeConfig.ITEM_MASTER_API = runtimeConfig.ITEM_MASTER_API || ITEM_MASTER_API;
    ensureStylesheet(ITEM_MASTER_STYLESHEET, 'atlas-item-master-css');
    if (!window.AtlasItemMaster) {
      await loadScript(ITEM_MASTER_SOURCE, 'atlasItemMaster');
    }
    state.itemMasterReady = Boolean(window.AtlasItemMaster);
  }

  async function performLoad() {
    state.loading = true;
    ensureStylesheet('assets/css/stock-count-workspace.css?v=20260805-l1', 'atlas-stock-count-css');
    try {
      if (!window.AtlasStockCountsL1) {
        await loadScript(EXTENSION_SOURCE, 'atlasStockCountL1Verified');
      }
      await loadStockCountWorkspace();
      state.ready = Boolean(window.AtlasStockCounts && window.AtlasStockCountsL1);
      window.AtlasStockCountsL1?.enhance?.();
    } catch (error) {
      state.ready = false;
      console.error('Checkpoint L1 stock-count assets could not be loaded', error);
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
    if (state.ready && state.itemMasterReady) return Promise.resolve();
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = performLoad();
    return state.loadPromise;
  }

  function replayNavigation(target) {
    if (!(target instanceof Element)) return;
    const stockNav = target.closest('[data-view="inventory"][data-subview="Stock count"]');
    const itemMasterNav = target.closest('[data-item-master-l2]');
    if (!stockNav && !itemMasterNav) return;

    load().then(() => {
      window.setTimeout(() => {
        if (stockNav) {
          const inventory = document.getElementById('inventory-view');
          if (inventory) inventory.style.display = 'block';
          const title = document.getElementById('atlas-page-title');
          if (title) title.textContent = 'Stock count';
          window.AtlasItemMaster?.close?.();
          window.AtlasStockCounts?.open?.();
          return;
        }
        if (itemMasterNav) {
          window.AtlasStockCounts?.close?.();
          window.AtlasItemMaster?.open?.();
        }
      }, 0);
    }).catch((error) => {
      console.error('Inventory workspace navigation could not finish loading', error);
    });
  }

  document.addEventListener('click', (event) => replayNavigation(event.target), true);

  window.AtlasStockCountBootstrap = {
    load,
    ready: () => state.ready,
    runtimePatched: () => state.runtimePatched,
    reentryPatched: () => state.reentryPatched,
    itemMasterReady: () => state.itemMasterReady,
  };
  if (document.readyState === 'complete') load();
  else window.addEventListener('load', load, { once: true });
})();
