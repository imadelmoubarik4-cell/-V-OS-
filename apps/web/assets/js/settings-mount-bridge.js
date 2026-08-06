(function () {
  'use strict';

  const WORKSPACE_SRC = 'assets/js/settings-workspace.js?v=20260805-1';
  const WORKSPACE_CSS = 'assets/css/settings-workspace.css?v=20260805-1';
  const CONNECTION_CENTER_SRC = 'assets/js/connection-center.js?v=20260806-p20';
  const CONNECTION_CENTER_CSS = 'assets/css/connection-center.css?v=20260806-p20';
  const READ_SOURCES_SRC = 'assets/js/read-sources-p22.js?v=20260806-p22';
  const READ_SOURCES_CSS = 'assets/css/read-sources-p22.css?v=20260806-p22';
  const POS_MAPPING_SRC = 'assets/js/pos-mapping-checkpoint-m.js?v=20260806-m1';
  const POS_MAPPING_CSS = 'assets/css/pos-mapping-checkpoint-m.css?v=20260806-m1';
  const BUTTON_CONTRAST_STYLE_ID = 'atlas-settings-button-contrast';
  const state = {
    loading: false,
    initialized: false,
    observer: null,
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
    element.querySelector('#checkpoint-a-integrations-settings')?.remove();
    element.querySelectorAll('.checkpoint-a-settings-integrations').forEach((section) => section.remove());
  }

  function ensureButtonContrast() {
    if (document.getElementById(BUTTON_CONTRAST_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = BUTTON_CONTRAST_STYLE_ID;
    style.textContent = '.settings-view .settings-primary,.settings-view .settings-hero aside button{color:#fff}';
    document.head.appendChild(style);
  }

  function loadAssetPair({ css, js, dataset, globalName }) {
    if (css && !document.querySelector(`link[data-${dataset}]`)) {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = css;
      stylesheet.setAttribute(`data-${dataset}`, 'true');
      document.head.appendChild(stylesheet);
    }
    if (!js || window[globalName] || document.querySelector(`script[data-${dataset}]`)) return;
    const script = document.createElement('script');
    script.src = js;
    script.async = false;
    script.setAttribute(`data-${dataset}`, 'true');
    document.body.appendChild(script);
  }

  function ensureConnectionCenterAssets() {
    loadAssetPair({
      css: CONNECTION_CENTER_CSS,
      js: CONNECTION_CENTER_SRC,
      dataset: 'atlas-connection-center',
      globalName: 'AtlasConnectionCenter'
    });
  }

  function ensurePhase2Assets() {
    loadAssetPair({
      css: READ_SOURCES_CSS,
      js: READ_SOURCES_SRC,
      dataset: 'atlas-read-sources-p22',
      globalName: 'AtlasReadSourcesP22'
    });
    loadAssetPair({
      css: POS_MAPPING_CSS,
      js: POS_MAPPING_SRC,
      dataset: 'atlas-pos-mapping-m',
      globalName: 'AtlasCheckpointM'
    });
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
    ensureConnectionCenterAssets();
    ensurePhase2Assets();
  }

  function showStartingState() {
    const element = host();
    if (!element || element.querySelector('.settings-shell')) return;
    element.innerHTML = `<section class="settings-shell settings-loading" data-settings-bridge-loading>
      <span class="settings-loading-icon"><i data-lucide="settings-2"></i></span>
      <h2>Loading Atlas Settings</h2>
      <p>Opening the Checkpoint J control centre.</p>
      <div class="settings-loading-grid"><i></i><i></i><i></i><i></i></div>
    </section>`;
    window.lucide?.createIcons?.();
  }

  async function activateWorkspace() {
    removeLegacySettings();
    ensureConnectionCenterAssets();
    ensurePhase2Assets();
    if (!workspaceReady()) return false;
    try {
      await window.AtlasSettings.refresh();
      removeLegacySettings();
      window.AtlasConnectionCenter?.refresh?.({ silent: true });
      return true;
    } catch (error) {
      console.error('Checkpoint J Settings activation failed', error);
      return false;
    }
  }

  function loadWorkspace() {
    ensureStylesheet();
    if (workspaceReady()) return activateWorkspace();
    if (state.loading) return Promise.resolve(false);

    state.loading = true;
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = WORKSPACE_SRC;
      script.async = false;
      script.dataset.atlasCheckpointJSettings = 'true';
      script.onload = async () => {
        state.loading = false;
        resolve(await activateWorkspace());
      };
      script.onerror = () => {
        state.loading = false;
        console.error('Checkpoint J Settings bundle could not be loaded.');
        resolve(false);
      };
      document.body.appendChild(script);
    });
  }

  function scheduleMount() {
    window.setTimeout(() => {
      if (!settingsVisible()) return;
      removeLegacySettings();
      showStartingState();
      loadWorkspace();
    }, 0);
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest?.('[data-view="settings"]')) return;
    scheduleMount();
  }

  function init() {
    if (state.initialized) return true;
    const element = host();
    if (!element) return false;

    state.initialized = true;
    ensureStylesheet();
    document.addEventListener('click', handleClick, true);

    state.observer = new MutationObserver(() => {
      ensurePhase2Assets();
      if (!settingsVisible()) return;
      removeLegacySettings();
      ensureConnectionCenterAssets();
      if (!element.querySelector('.settings-shell') && !state.loading) scheduleMount();
    });
    state.observer.observe(element, { childList: true, subtree: true, attributes: true });
    state.observer.observe(document.getElementById('app-screen') || document.body, {
      attributes: true,
      attributeFilter: ['class', 'style']
    });

    if (settingsVisible()) scheduleMount();

    window.addEventListener('pagehide', () => {
      document.removeEventListener('click', handleClick, true);
      state.observer?.disconnect();
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
