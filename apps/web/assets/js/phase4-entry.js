(function () {
  'use strict';

  const VERSION = 'atlas-phase4-entry/1.0.0';
  const SHELL_SRC = 'assets/js/phase4-shell.js';
  const OPERATIONS_SRC = 'assets/js/phase4-operations.js';
  let readinessTask = null;

  function domReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', resolve, { once: true });
    });
  }

  function loadScriptOnce(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);

    const existing = Array.from(document.scripts).find((script) => {
      try {
        return new URL(script.src, document.baseURI).pathname.endsWith('/' + src);
      } catch (_) {
        return script.getAttribute('src') === src;
      }
    });

    if (existing) {
      return new Promise((resolve, reject) => {
        if (!globalName || window[globalName]) {
          resolve(globalName ? window[globalName] : true);
          return;
        }
        existing.addEventListener('load', () => resolve(window[globalName] || true), { once: true });
        existing.addEventListener('error', () => reject(new Error('Atlas interface asset could not load: ' + src)), { once: true });
      });
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.dataset.atlasInterfaceAsset = 'true';
      script.addEventListener('load', () => resolve(globalName ? window[globalName] : true), { once: true });
      script.addEventListener('error', () => reject(new Error('Atlas interface asset could not load: ' + src)), { once: true });
      document.body.appendChild(script);
    });
  }

  function ensureAtlasInterface() {
    if (readinessTask) return readinessTask;

    readinessTask = (async () => {
      await domReady();
      await loadScriptOnce(SHELL_SRC, 'AtlasPhase4Shell');
      await loadScriptOnce(OPERATIONS_SRC, 'AtlasPhase4Operations');
      window.AtlasPhase4Operations?.refresh?.();
      document.documentElement.dataset.atlasInterface = 'ready';
      document.dispatchEvent(new CustomEvent('atlas:interface-ready', {
        detail: { version: VERSION }
      }));
      return true;
    })().catch((error) => {
      readinessTask = null;
      document.documentElement.dataset.atlasInterface = 'error';
      throw error;
    });

    return readinessTask;
  }

  window.ensureAtlasInterface = ensureAtlasInterface;
  window.AtlasInterfaceEntry = Object.freeze({
    version: VERSION,
    ensure: ensureAtlasInterface,
  });

  window.addEventListener('atlas:profile-ready', (event) => {
    if (!event.detail?.active) return;
    ensureAtlasInterface().catch((error) => {
      console.error('Atlas interface could not be initialized.', error);
    });
  });

  if (window.atlasCurrentProfile?.active) {
    ensureAtlasInterface().catch((error) => {
      console.error('Atlas interface could not be initialized.', error);
    });
  }
})();
