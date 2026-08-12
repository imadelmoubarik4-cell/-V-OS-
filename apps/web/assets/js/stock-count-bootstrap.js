(function () {
  'use strict';

  const state = {
    loading: false,
    loadPromise: null,
    ready: false,
    extensionReady: false,
    runtimePatched: false,
    reentryPatched: false,
    itemMasterReady: false,
  };
  const WORKSPACE_SOURCE = 'assets/js/stock-count-workspace.js?v=20260812-l1-core2';
  const EXTENSION_SOURCE = 'assets/js/stock-count-l1-verified.js?v=20260812-l1-core2';
  const ITEM_MASTER_SOURCE = 'assets/js/item-master-workspace.js?v=20260806-l2';
  const ITEM_MASTER_STYLESHEET = 'assets/css/item-master-workspace.css?v=20260806-l2';
  const ITEM_MASTER_API = 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-item-master';
  const SCRIPT_TIMEOUT_MS = 8000;

  function ensureStylesheet(href, marker) {
    if (document.querySelector(`link[data-${marker}]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset[marker.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = 'true';
    document.head.appendChild(link);
  }

  function markerSelector(marker) {
    return `script[data-${marker.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`;
  }

  function markerReady(marker) {
    return (marker === 'atlasStockCountL1Verified' && Boolean(window.AtlasStockCountsL1))
      || (marker === 'atlasStockCountWorkspace' && Boolean(window.AtlasStockCounts))
      || (marker === 'atlasItemMaster' && Boolean(window.AtlasItemMaster));
  }

  function loadScript(src, marker) {
    return new Promise((resolve, reject) => {
      if (markerReady(marker)) {
        resolve();
        return;
      }

      const selector = markerSelector(marker);
      const existing = document.querySelector(selector);
      if (existing) {
        // A prior failed load can leave a finished script tag behind. Waiting for
        // another load event on that element hangs forever, so discard it unless
        // it is explicitly still loading and let the canonical asset retry.
        if (existing.dataset.atlasLoadState === 'loading') {
          const timer = window.setTimeout(() => {
            reject(new Error(`Timed out while waiting for ${src}`));
          }, SCRIPT_TIMEOUT_MS);
          existing.addEventListener('load', () => {
            window.clearTimeout(timer);
            if (markerReady(marker)) resolve();
            else reject(new Error(`${src} loaded without installing its Atlas runtime.`));
          }, { once: true });
          existing.addEventListener('error', () => {
            window.clearTimeout(timer);
            reject(new Error(`Could not load ${src}`));
          }, { once: true });
          return;
        }
        existing.remove();
      }

      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.dataset[marker] = 'true';
      script.dataset.atlasLoadState = 'loading';
      const timer = window.setTimeout(() => {
        script.dataset.atlasLoadState = 'timeout';
        reject(new Error(`Timed out loading ${src}`));
      }, SCRIPT_TIMEOUT_MS);
      script.addEventListener('load', () => {
        window.clearTimeout(timer);
        script.dataset.atlasLoadState = 'loaded';
        if (markerReady(marker)) resolve();
        else reject(new Error(`${src} loaded without installing its Atlas runtime.`));
      }, { once: true });
      script.addEventListener('error', () => {
        window.clearTimeout(timer);
        script.dataset.atlasLoadState = 'error';
        reject(new Error(`Could not load ${src}`));
      }, { once: true });
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
    state.ready = true;
    state.runtimePatched = false;
  }

  async function loadStockCountExtension() {
    if (!window.AtlasStockCountsL1) {
      await loadScript(EXTENSION_SOURCE, 'atlasStockCountL1Verified');
    }
    state.extensionReady = Boolean(window.AtlasStockCountsL1);
    window.AtlasStockCountsL1?.enhance?.();
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
    ensureStylesheet('assets/css/stock-count-workspace.css?v=20260812-l1-core2', 'atlas-stock-count-css');

    // The canonical core must not be held hostage by an optional enhancement.
    // Load it first so Stock Count can always open and report its own API state.
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

  function openStockCount() {
    const inventory = document.getElementById('inventory-view');
    if (inventory) inventory.style.display = 'block';
    const title = document.getElementById('atlas-page-title');
    if (title) title.textContent = 'Stock count';
    window.AtlasItemMaster?.close?.();
    window.AtlasStockCounts?.open?.();
  }

  function replayNavigation(target) {
    if (!(target instanceof Element)) return;
    const stockNav = target.closest('[data-view="inventory"][data-subview="Stock count"]');
    const itemMasterNav = target.closest('[data-item-master-l2]');
    if (!stockNav && !itemMasterNav) return;

    if (stockNav && window.AtlasStockCounts) {
      openStockCount();
      load().catch((error) => {
        console.error('Inventory workspace background refresh could not finish loading', error);
      });
      return;
    }

    load().then(() => {
      window.setTimeout(() => {
        if (stockNav) {
          openStockCount();
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
    extensionReady: () => state.extensionReady,
    runtimePatched: () => state.runtimePatched,
    reentryPatched: () => state.reentryPatched,
    itemMasterReady: () => state.itemMasterReady,
  };
  if (document.readyState === 'complete') load();
  else window.addEventListener('load', load, { once: true });
})();