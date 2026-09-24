(function () {
  'use strict';

  // Launch-blocker fix (Settings does not respond):
  // These two constants previously carried a `?v=20260805-1` cache-buster.
  // `loadAtlasAssetOnce()` in apps/web/config.js de-duplicates with
  // `document.querySelector('script[src="assets/js/settings-workspace.js"]')`,
  // an exact-string match that never matched the suffixed element. Both loaders
  // run after window load, so in the race window each one believed the other
  // had not loaded and the Settings IIFE could be evaluated twice — duplicate
  // document click listeners (settings-workspace.js:1100) and duplicate
  // snapshot/API requests. Using the identical path on both sides restores the
  // existing de-duplication guard. No config.js change, no behaviour change.
  const WORKSPACE_SRC = 'assets/js/settings-workspace.js?v=20260926-s88';
  const WORKSPACE_CSS = 'assets/css/settings-workspace.css';
  const BUTTON_CONTRAST_STYLE_ID = 'atlas-settings-button-contrast';
  const state = {
    loading: false,
    initialized: false,
    retryTimer: null
  };

  function host() {
    return document.getElementById('settings-view');
  }

  function settingsVisible() {
    const element = host();
    const app = document.getElementById('app-screen');
    return Boolean(element && app)
      && window.getComputedStyle(element).display !== 'none'
      && window.getComputedStyle(app).display !== 'none';
  }

  function workspaceReady() {
    return Boolean(
      window.AtlasSettings
      && typeof window.AtlasSettings.refresh === 'function'
      && typeof window.AtlasSettings.snapshot === 'function'
    );
  }

  function removeLegacySettings() {
    const element = host();
    if (!element) return;
    // The Operations layout recreates this compatibility section whenever it is
    // removed. Deleting it from this observer therefore creates a cross-observer
    // feedback loop as soon as Settings becomes visible. Keep the node connected
    // but suppressed so Operations sees its current signature and stops writing.
    element.querySelectorAll('#checkpoint-a-integrations-settings, .checkpoint-a-settings-integrations').forEach((section) => {
      if (!section.hidden) section.hidden = true;
    });
  }

  function ensureButtonContrast() {
    if (document.getElementById(BUTTON_CONTRAST_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = BUTTON_CONTRAST_STYLE_ID;
    style.textContent = '.settings-view .settings-primary,.settings-view .settings-hero aside button{color:#fff}#settings-view #checkpoint-a-integrations-settings,#settings-view .checkpoint-a-settings-integrations{display:none!important}';
    document.head.appendChild(style);
  }

  function ensureStylesheet() {
    if (!document.querySelector('link[data-atlas-checkpoint-j-settings]')) {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = WORKSPACE_CSS;
      stylesheet.dataset.atlasCheckpointJSettings = 'true';
      document.head.appendChild(stylesheet);
    }
    ensureButtonContrast();
  }

  function showStartingState() {
    const element = host();
    if (!element || element.querySelector('.settings-shell')) return;
    element.innerHTML = `<section class="settings-shell settings-loading" data-settings-bridge-loading>
      <span class="settings-loading-icon"><i data-lucide="settings-2"></i></span>
      <h2>Loading Atlas Settings</h2>
      <p>Opening Settings.</p>
      <div class="settings-loading-grid"><i></i><i></i><i></i><i></i></div>
    </section>`;
    window.lucide?.createIcons?.();
  }

  async function activateWorkspace() {
    removeLegacySettings();
    if (!workspaceReady()) return false;
    try {
      await window.AtlasSettings.refresh();
      removeLegacySettings();
      return true;
    } catch (error) {
      console.error('Checkpoint J Settings activation failed', error);
      return false;
    }
  }

  // S88: the Settings bundle loads through AtlasShell.load, which deduplicates
  // with config.js (same path, any cache key), so it can never evaluate twice.
  function loadWorkspace() {
    ensureStylesheet();
    if (workspaceReady()) return activateWorkspace();
    if (state.loading) return Promise.resolve(false);
    state.loading = true;
    return window.AtlasShell.load(WORKSPACE_SRC, { global: 'AtlasSettings', dataset: { atlasCheckpointJSettings: 'true' } })
      .then(() => activateWorkspace())
      .catch(() => {
        console.error('Checkpoint J Settings bundle could not be loaded.');
        return false;
      })
      .finally(() => { state.loading = false; });
  }

  function scheduleMount() {
    window.setTimeout(() => {
      if (!settingsVisible()) return;
      removeLegacySettings();
      showStartingState();
      loadWorkspace();
    }, 0);
  }

  function init() {
    if (state.initialized) return true;
    const element = host();
    if (!element) return false;

    state.initialized = true;
    ensureStylesheet();

    // S88: AtlasShell announces when Settings opens (formerly a capture-phase
    // click listener plus a MutationObserver on #settings-view and the app).
    // scheduleMount() runs after the show completes, so a legacy Operations
    // section written during the same show is suppressed.
    window.AtlasShell?.onView?.('settings', { show: scheduleMount });

    if (settingsVisible()) scheduleMount();

    window.addEventListener('pagehide', () => {
      if (state.retryTimer) window.clearInterval(state.retryTimer);
    }, { once: true });
    return true;
  }

  window.AtlasCheckpointJSettingsMount = {
    mount: scheduleMount,
    ready: workspaceReady
  };

  if (!init()) {
    state.retryTimer = window.setInterval(() => {
      if (!init()) return;
      window.clearInterval(state.retryTimer);
      state.retryTimer = null;
    }, 100);
    window.setTimeout(() => {
      if (!state.retryTimer) return;
      window.clearInterval(state.retryTimer);
      state.retryTimer = null;
    }, 12000);
  }
})();
