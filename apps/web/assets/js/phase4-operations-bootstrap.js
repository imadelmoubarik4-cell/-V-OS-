(function () {
  'use strict';

  const VERSION = 'atlas-phase4-operations-bootstrap/0.1.0';
  const OPERATIONS_SRC = 'assets/js/phase4-operations.js';
  const INTERNAL_ROOTS = [
    '#phase4-home-operations',
    '#phase4-purchasing-workspace',
    '#phase4-inventory-secondary',
    '.phase4-home-actions',
    '.phase4-operational-hero',
    '.service-grid',
    '.stock-count-workspace',
    '.item-master-workspace',
    '.inventory-scanner-overlay',
  ].join(',');

  function mutationIsInternal(record) {
    const target = record?.target;
    const element = target instanceof Element
      ? target
      : target?.parentElement instanceof Element
        ? target.parentElement
        : null;
    return Boolean(element?.closest(INTERNAL_ROOTS));
  }

  function createFilteredObserver(NativeMutationObserver) {
    return class AtlasPhase4OperationalObserver {
      constructor(callback) {
        this.callback = callback;
        this.native = new NativeMutationObserver((records) => {
          const relevant = records.filter((record) => !mutationIsInternal(record));
          if (relevant.length) this.callback(relevant, this);
        });
      }

      observe(target, options) { this.native.observe(target, options); }
      disconnect() { this.native.disconnect(); }
      takeRecords() { return this.native.takeRecords().filter((record) => !mutationIsInternal(record)); }
    };
  }

  function installRoleGuard() {
    if (document.getElementById('phase4-operations-role-guard')) return;
    const style = document.createElement('style');
    style.id = 'phase4-operations-role-guard';
    style.textContent = `
      body:not(.atlas-commercial-manager) [data-phase4-action="item-master"],
      body:not(.atlas-commercial-manager) [data-phase4-action="new-recipe"],
      body:not(.atlas-commercial-manager) [data-phase4-action="purchasing"],
      body:not(.atlas-commercial-manager) [data-phase4-action="delivery"],
      body:not(.atlas-commercial-manager) [data-phase4-inventory-mode="master"],
      body:not(.atlas-commercial-manager) [data-phase4-purchasing-mode] {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function guardOperationsRender() {
    const api = window.AtlasOperations;
    if (!api?.render || api.render.__atlasPhase4Guard) return;
    const original = api.render.bind(api);
    let rendering = false;
    let lastRenderedAt = 0;
    const guarded = function (...args) {
      const now = performance.now();
      if (rendering || now - lastRenderedAt < 40) return undefined;
      rendering = true;
      try {
        const result = original(...args);
        lastRenderedAt = performance.now();
        return result;
      } finally {
        requestAnimationFrame(() => { rendering = false; });
      }
    };
    guarded.__atlasPhase4Guard = true;
    guarded.__atlasOriginal = original;
    api.render = guarded;
  }

  function installPostLoadGuards() {
    installRoleGuard();
    guardOperationsRender();
    const timer = window.setInterval(() => {
      guardOperationsRender();
      if (window.AtlasPhase4Operations && window.AtlasOperations?.render?.__atlasPhase4Guard) {
        window.clearInterval(timer);
      }
    }, 100);
    window.setTimeout(() => window.clearInterval(timer), 10000);
  }

  function load() {
    installRoleGuard();
    if (window.AtlasPhase4Operations || document.querySelector(`script[src="${OPERATIONS_SRC}"]`)) {
      installPostLoadGuards();
      return;
    }

    const NativeMutationObserver = window.MutationObserver;
    const FilteredMutationObserver = createFilteredObserver(NativeMutationObserver);
    window.MutationObserver = FilteredMutationObserver;

    const restore = () => {
      if (window.MutationObserver === FilteredMutationObserver) window.MutationObserver = NativeMutationObserver;
    };

    const script = document.createElement('script');
    script.src = OPERATIONS_SRC;
    script.async = false;
    script.dataset.atlasPhase4Operations = 'true';
    script.addEventListener('load', () => {
      restore();
      installPostLoadGuards();
    }, { once: true });
    script.addEventListener('error', () => {
      restore();
      console.error('Atlas Phase 4 operational interface could not be loaded.');
    }, { once: true });
    document.body.appendChild(script);
  }

  window.AtlasPhase4OperationsBootstrap = Object.freeze({ version: VERSION, load });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();
