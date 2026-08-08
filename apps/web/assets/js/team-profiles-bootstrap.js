(function () {
  'use strict';

  const JS_BUNDLE = 'assets/js/team-profiles.bundle.js.gz';
  const CSS_BUNDLE = 'assets/css/team-profiles.bundle.css.gz';
  let loading = null;
  let navTimer = null;

  async function decompressText(path) {
    if (!('DecompressionStream' in window)) {
      throw new Error('This browser cannot open the Team Profiles bundle. Update the browser and reload Atlas.');
    }
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error(`Team Profiles asset failed to load (${response.status}).`);
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }

  function installCss(source) {
    if (document.querySelector('link[data-atlas-team-profiles-bundle]')) return;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/css' }));
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.dataset.atlasTeamProfilesBundle = 'true';
    link.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    document.head.appendChild(link);
  }

  function installJs(source) {
    return new Promise((resolve, reject) => {
      if (window.AtlasTeamProfiles) { resolve(); return; }
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const script = document.createElement('script');
      script.src = url;
      script.dataset.atlasTeamProfilesBundle = 'true';
      script.addEventListener('load', () => { URL.revokeObjectURL(url); resolve(); }, { once: true });
      script.addEventListener('error', () => { URL.revokeObjectURL(url); reject(new Error('Team Profiles JavaScript could not start.')); }, { once: true });
      document.body.appendChild(script);
    });
  }

  async function load() {
    if (window.AtlasTeamProfiles) return window.AtlasTeamProfiles;
    if (loading) return loading;
    loading = Promise.all([decompressText(CSS_BUNDLE), decompressText(JS_BUNDLE)])
      .then(async ([css, js]) => { installCss(css); await installJs(js); return window.AtlasTeamProfiles; })
      .catch((error) => { console.error('Team Profiles bootstrap failed:', error); throw error; })
      .finally(() => { loading = null; });
    return loading;
  }

  function setButtonLoading(button, active) {
    if (!button) return;
    button.disabled = active;
    button.classList.toggle('is-loading', active);
    if (active) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }

  async function openProfiles(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const button = event?.currentTarget instanceof Element
      ? event.currentTarget
      : document.querySelector('.nav-item[data-view="team-profiles"]');

    if (window.AtlasTeamProfiles) {
      window.AtlasTeamProfiles.open();
      return;
    }

    setButtonLoading(button, true);
    try {
      const profiles = await load();
      profiles?.open?.();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Team Profiles could not open.');
    } finally {
      setButtonLoading(button, false);
    }
  }

  function ensureNavigation() {
    let button = document.querySelector('.nav-item[data-view="team-profiles"]');
    if (!button) {
      const teamButton = document.querySelector('.nav-item[data-view="team"]');
      if (!teamButton) return false;
      button = document.createElement('button');
      button.className = 'nav-item';
      button.dataset.view = 'team-profiles';
      button.innerHTML = '<i data-lucide="contact-round"></i>Profiles';
      teamButton.insertAdjacentElement('afterend', button);
    }

    if (button.dataset.teamProfilesBootstrapBound !== 'true') {
      button.dataset.teamProfilesBootstrapBound = 'true';
      button.addEventListener('click', openProfiles, true);
      button.addEventListener('pointerenter', () => load().catch(() => null), { once: true, passive: true });
      button.addEventListener('focus', () => load().catch(() => null), { once: true, passive: true });
    }
    window.lucide?.createIcons?.();
    return true;
  }

  function init() {
    if (ensureNavigation()) return;
    navTimer = window.setInterval(() => {
      if (!ensureNavigation()) return;
      window.clearInterval(navTimer);
      navTimer = null;
    }, 250);
    window.setTimeout(() => {
      if (navTimer) window.clearInterval(navTimer);
      navTimer = null;
    }, 10000);
  }

  window.AtlasTeamProfilesBootstrap = { load, open: () => openProfiles() };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
