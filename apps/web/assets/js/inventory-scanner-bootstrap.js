(function () {
  'use strict';

  const SCANNER_SCRIPT = 'assets/js/inventory-scanner.js';
  const SCANNER_STYLE = 'assets/css/inventory-scanner.css';
  const SCANNER_API_FRAGMENT = '/functions/v1/atlas-inventory-scanner';
  const state = {
    loading: false,
    loaded: false,
    observer: null,
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

  function installScannerFetchTimeout() {
    if (window.fetch.__atlasScannerTimeout) return;
    const nativeFetch = window.fetch.bind(window);

    const guardedFetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (!String(url).includes(SCANNER_API_FRAGMENT) || init?.signal) {
        return nativeFetch(input, init);
      }

      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 15000);
      try {
        return await nativeFetch(input, { ...(init || {}), signal: controller.signal });
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error('The scanner service took too long to respond. Close the scanner, check the connection, and try again.');
        }
        throw error;
      } finally {
        window.clearTimeout(timer);
      }
    };

    guardedFetch.__atlasScannerTimeout = true;
    guardedFetch.__atlasNativeFetch = nativeFetch;
    window.fetch = guardedFetch;
  }

  function scannerMutationIsInternal(record) {
    const target = record?.target;
    if (!(target instanceof Node)) return false;
    const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    return Boolean(element?.closest?.('.inventory-scanner-overlay'));
  }

  function createScannerMutationObserver(NativeMutationObserver) {
    return class AtlasScannerMutationObserver {
      constructor(callback) {
        this.callback = callback;
        this.target = null;
        this.options = null;
        this.connected = false;
        this.frame = null;
        this.native = new NativeMutationObserver((records) => {
          if (!this.connected) return;
          const relevant = records.filter((record) => !scannerMutationIsInternal(record));
          if (!relevant.length) return;

          this.native.disconnect();
          if (this.frame) window.cancelAnimationFrame(this.frame);
          this.frame = window.requestAnimationFrame(() => {
            this.frame = null;
            if (!this.connected) return;
            try {
              this.callback(relevant, this);
            } finally {
              if (this.connected && this.target && this.options) {
                this.native.observe(this.target, this.options);
              }
            }
          });
        });
      }

      observe(target, options) {
        this.target = target;
        this.options = options;
        this.connected = true;
        this.native.observe(target, options);
      }

      disconnect() {
        this.connected = false;
        if (this.frame) {
          window.cancelAnimationFrame(this.frame);
          this.frame = null;
        }
        this.native.disconnect();
      }

      takeRecords() {
        return this.native.takeRecords();
      }
    };
  }

  function loadStylesheet() {
    if (document.querySelector(`link[href="${SCANNER_STYLE}"]`)) return;
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = SCANNER_STYLE;
    stylesheet.dataset.atlasInventoryScanner = 'true';
    document.head.appendChild(stylesheet);
  }

  function loadScanner() {
    if (!appIsVisible() || state.loading || state.loaded || window.AtlasInventoryScanner) return;
    if (document.querySelector('script[data-atlas-inventory-scanner]')) {
      state.loaded = true;
      return;
    }

    state.loading = true;
    loadStylesheet();
    installInteractionStyles();
    installScannerFetchTimeout();

    const NativeMutationObserver = window.MutationObserver;
    const ScannerMutationObserver = createScannerMutationObserver(NativeMutationObserver);
    const nativeDocumentAddEventListener = document.addEventListener;
    const captureTypes = new Set(['click', 'submit', 'input', 'change']);

    // The scanner uses document-level delegation. Register those handlers in the
    // capture phase so other page modules cannot swallow scanner taps on mobile.
    document.addEventListener = function (type, listener, options) {
      if (captureTypes.has(type) && typeof listener === 'function') {
        return nativeDocumentAddEventListener.call(document, type, listener, true);
      }
      return nativeDocumentAddEventListener.call(document, type, listener, options);
    };
    window.MutationObserver = ScannerMutationObserver;

    const restoreRuntime = () => {
      document.addEventListener = nativeDocumentAddEventListener;
      if (window.MutationObserver === ScannerMutationObserver) {
        window.MutationObserver = NativeMutationObserver;
      }
    };

    const script = document.createElement('script');
    script.src = SCANNER_SCRIPT;
    script.async = true;
    script.dataset.atlasInventoryScanner = 'true';
    script.onload = () => {
      restoreRuntime();
      state.loading = false;
      state.loaded = true;
    };
    script.onerror = () => {
      restoreRuntime();
      state.loading = false;
      script.remove();
      console.error('Atlas bottle scanner could not load.');
    };
    document.body.appendChild(script);
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
  }

  function init() {
    installInteractionStyles();
    installScannerFetchTimeout();
    checkState();

    state.observer = new MutationObserver(checkState);
    const app = document.getElementById('app-screen');
    const login = document.getElementById('login-screen');
    if (app) state.observer.observe(app, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    if (login) state.observer.observe(login, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });

    state.pollTimer = window.setInterval(() => {
      checkState();
      if (state.loaded) {
        window.clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    }, 400);

    window.addEventListener('pagehide', () => {
      state.observer?.disconnect();
      if (state.pollTimer) window.clearInterval(state.pollTimer);
      window.AtlasInventoryScanner?.stop?.();
    }, { once: true });
  }

  window.AtlasInventoryScannerBootstrap = {
    load: checkState,
    loaded: () => state.loaded
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
