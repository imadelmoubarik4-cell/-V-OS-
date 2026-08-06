(function () {
  'use strict';

  const state = {
    loading: false,
    ready: false,
    runtimePatched: false,
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
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.dataset[marker] = 'true';
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true });
      document.body.appendChild(script);
    });
  }

  async function loadValidatedWorkspace() {
    const response = await fetch(WORKSPACE_SOURCE, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not read the stock-count workspace (${response.status}).`);
    let source = await response.text();

    // The original L1 draft mixed nullish coalescing and logical OR without
    // parentheses. Repair that parse boundary before execution, then delegate
    // count-form submissions to the unit-aware evidence extension.
    source = source.replace(
      'note: override.note ?? note?.value?.trim() || null,',
      'note: (override.note ?? note?.value?.trim()) || null,'
    );
    const submitGuard = '    if (!(form instanceof HTMLFormElement)) return;\n';
    const delegation = '    if (window.AtlasStockCountsL1?.handleSubmit?.(event, form)) return;\n';
    if (!source.includes(delegation)) {
      if (!source.includes(submitGuard)) throw new Error('The stock-count submit boundary could not be validated.');
      source = source.replace(submitGuard, submitGuard + delegation);
    }
    source += '\n//# sourceURL=stock-count-workspace.validated.js\n';

    const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      await loadScript(blobUrl, 'atlasStockCountWorkspaceValidated');
      state.runtimePatched = true;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  async function loadItemMaster() {
    const runtimeConfig = window.VABAR_CONFIG = window.VABAR_CONFIG || {};
    runtimeConfig.ITEM_MASTER_API = runtimeConfig.ITEM_MASTER_API || ITEM_MASTER_API;
    ensureStylesheet(ITEM_MASTER_STYLESHEET, 'atlas-item-master-css');
    if (!window.AtlasItemMaster && !document.querySelector('script[data-atlas-item-master]')) {
      await loadScript(ITEM_MASTER_SOURCE, 'atlasItemMaster');
    }
    state.itemMasterReady = Boolean(window.AtlasItemMaster);
  }

  async function load() {
    if (state.ready && state.itemMasterReady) return;
    if (state.loading) return;
    state.loading = true;
    ensureStylesheet('assets/css/stock-count-workspace.css?v=20260805-l1', 'atlas-stock-count-css');

    try {
      if (!state.ready) {
        // Install the submission handler first. The validated legacy workspace
        // calls it only when a count form is actually submitted.
        await loadScript(EXTENSION_SOURCE, 'atlasStockCountL1Verified');
        await loadValidatedWorkspace();
        state.ready = Boolean(window.AtlasStockCounts && window.AtlasStockCountsL1);
        window.AtlasStockCountsL1?.enhance?.();
      }
    } catch (error) {
      console.error('Checkpoint L1 stock-count assets could not be loaded', error);
    }

    try {
      // L2 is layered over the authenticated Inventory shell. It has a separate
      // manager-only gateway, private drafts and a disabled preview publication
      // boundary; loading its browser assets cannot change production records.
      await loadItemMaster();
    } catch (error) {
      console.error('Checkpoint L2 item-master assets could not be loaded', error);
    } finally {
      state.loading = false;
    }
  }

  window.AtlasStockCountBootstrap = {
    load,
    ready: () => state.ready,
    runtimePatched: () => state.runtimePatched,
    itemMasterReady: () => state.itemMasterReady,
  };
  if (document.readyState === 'complete') load();
  else window.addEventListener('load', load, { once: true });
})();
