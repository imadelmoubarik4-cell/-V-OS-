(function () {
  'use strict';

  const state = {
    loading: false,
    loadPromise: null,
    ready: false,
    extensionReady: false,
    extensionRuntimePatched: false,
    reentryPatched: false,
    itemMasterReady: false,
  };
  const WORKSPACE_SOURCE = 'assets/js/stock-count-workspace.js?v=20260813-l1-core5';
  const EXTENSION_SOURCE = 'assets/js/stock-count-l1-verified.js?v=20260813-l1-core5';
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

  // The temporary global observer replacement that used to wrap this load is gone.
  // It masked a recursion that lives in stock-count-workspace.js itself, and it only
  // held while that one script was evaluating - any other load order brought the loop
  // straight back. The workspace now scopes its own observer, so the global no longer
  // needs patching (patching it globally also silently narrowed every observer any
  // other module happened to construct meanwhile).
  async function loadStockCountCore() {
    await loadScript(WORKSPACE_SOURCE, 'atlasStockCountWorkspace');
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
      await loadStockCountCore();
    }
    if (!window.AtlasStockCounts) {
      throw new Error('The canonical Stock Count workspace loaded without installing AtlasStockCounts.');
    }
    installStockCountReentryGuard();
    state.ready = true;
  }

  // The optional L1 enhancement observes the whole document, then calls Lucide,
  // whose SVG replacements are document mutations too. Guard its private
  // scheduler at load time so one enhancement pass cannot schedule itself.
  // This keeps the repository change inside the approved bootstrap boundary
  // without replacing the page's global MutationObserver.
  async function loadStockCountExtensionRuntime() {
    const response = await fetch(EXTENSION_SOURCE, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Could not read ${EXTENSION_SOURCE} (${response.status}).`);
    }

    let source = await response.text();
    const schedulerSource = `  function scheduleEnhance() {
    window.requestAnimationFrame(enhance);
  }`;
    const guardedSchedulerSource = `  let enhanceFrame = null;

  function mutationIsLucideOnly(record) {
    if (record.type !== 'childList') return false;
    const changedNodes = [...record.addedNodes, ...record.removedNodes];
    if (!changedNodes.length) return false;
    return changedNodes.every((node) => {
      if (!(node instanceof Element)) return false;
      return node.matches('i[data-lucide], svg[data-lucide]')
        || Boolean(node.closest('svg[data-lucide]'));
    });
  }

  function observeEnhancementTarget() {
    const target = document.getElementById('inventory-view');
    if (target) state.observer?.observe(target, { childList: true, subtree: true });
  }

  function scheduleEnhance() {
    if (enhanceFrame !== null) return;
    enhanceFrame = window.requestAnimationFrame(() => {
      enhanceFrame = null;
      state.observer?.disconnect();
      try {
        enhance();
      } finally {
        observeEnhancementTarget();
      }
    });
  }`;

    const observerSource = '    state.observer = new MutationObserver(scheduleEnhance);';
    const guardedObserverSource = `    state.observer = new MutationObserver((records) => {
      if (records.some((record) => !mutationIsLucideOnly(record))) scheduleEnhance();
    });`;
    const observerTargetSource = '    state.observer.observe(document.body, { childList: true, subtree: true });';
    const guardedObserverTargetSource = '    observeEnhancementTarget();';

    if (!source.includes(schedulerSource)
        || !source.includes(observerSource)
        || !source.includes(observerTargetSource)) {
      throw new Error('The Stock Count enhancement observer boundary could not be validated.');
    }
    source = source
      .replace(schedulerSource, guardedSchedulerSource)
      .replace(observerSource, guardedObserverSource)
      .replace(observerTargetSource, guardedObserverTargetSource);
    source += '\n//# sourceURL=stock-count-l1-verified.guarded.js\n';

    const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      await loadScript(blobUrl, 'atlasStockCountL1Verified');
      state.extensionRuntimePatched = true;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  async function loadStockCountExtension() {
    if (!window.AtlasStockCountsL1) {
      await loadStockCountExtensionRuntime();
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

  function showUnavailable(label) {
    const message = `${label} is not available in this V1 preview yet.`;
    if (typeof window.showToast === 'function') {
      window.showToast(message);
      return;
    }
    const toast = document.getElementById('atlas-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function activateInventorySubview(label) {
    document.querySelectorAll('[data-view="inventory"][data-subview]').forEach((item) => {
      item.classList.toggle('active', item.dataset.subview === label);
    });
  }

  function openStockCount() {
    const inventory = document.getElementById('inventory-view');
    if (inventory) inventory.style.display = 'block';
    const title = document.getElementById('atlas-page-title');
    if (title) title.textContent = 'Stock count';
    activateInventorySubview('Stock count');
    // The legacy bubbling handler runs after this capture listener and can add
    // another active class without clearing Items. Normalize once it finishes.
    window.setTimeout(() => activateInventorySubview('Stock count'), 0);
    window.AtlasItemMaster?.close?.();
    window.AtlasStockCounts?.open?.();
  }

  function replayNavigation(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const movementsNav = target.closest('[data-subview="Inventory movements"]');
    const wasteNav = target.closest('[data-subview="Waste"]');
    if (movementsNav || wasteNav) {
      event.preventDefault();
      event.stopPropagation();
      showUnavailable(movementsNav ? 'Inventory movements' : 'Waste');
      return;
    }

    const stockNav = target.closest('[data-view="inventory"][data-subview="Stock count"]');
    const itemMasterNav = target.closest('[data-item-master-l2]');
    const inventorySubview = target.closest('[data-view="inventory"][data-subview]');
    if (!stockNav && !itemMasterNav) {
      if (inventorySubview?.dataset.subview === 'Items') {
        window.setTimeout(() => activateInventorySubview('Items'), 0);
      } else if (!inventorySubview && document.body.classList.contains('stock-count-active')) {
        window.setTimeout(() => activateInventorySubview('Stock count'), 0);
      }
      return;
    }

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

  document.addEventListener('click', replayNavigation, true);

  window.AtlasStockCountBootstrap = {
    load,
    ready: () => state.ready,
    extensionReady: () => state.extensionReady,
    extensionRuntimePatched: () => state.extensionRuntimePatched,
    reentryPatched: () => state.reentryPatched,
    itemMasterReady: () => state.itemMasterReady,
  };
  if (document.readyState === 'complete') load();
  else window.addEventListener('load', load, { once: true });
})();
