(function () {
  'use strict';

  const state = { loading: false, ready: false };

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
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.atlasLoaded === 'true') resolve();
        else existing.addEventListener('load', resolve, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.dataset[marker] = 'true';
      script.addEventListener('load', () => {
        script.dataset.atlasLoaded = 'true';
        resolve();
      }, { once: true });
      script.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true });
      document.body.appendChild(script);
    });
  }

  async function load() {
    if (state.ready || state.loading) return;
    state.loading = true;
    ensureStylesheet('assets/css/stock-count-workspace.css?v=20260805-l1', 'atlas-stock-count-css');
    try {
      await loadScript('assets/js/stock-count-workspace.js?v=20260805-l1', 'atlasStockCountWorkspace');
      await loadScript('assets/js/stock-count-l1-verified.js?v=20260805-l1', 'atlasStockCountL1Verified');
      state.ready = true;
    } catch (error) {
      console.error('Checkpoint L1 stock-count assets could not be loaded', error);
    } finally {
      state.loading = false;
    }
  }

  window.AtlasStockCountBootstrap = { load, ready: () => state.ready };
  if (document.readyState === 'complete') load();
  else window.addEventListener('load', load, { once: true });
})();
