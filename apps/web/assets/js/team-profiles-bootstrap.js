(function () {
  'use strict';

  const JS_BUNDLE = 'assets/js/team-profiles.bundle.js.gz';
  const CSS_BUNDLE = 'assets/css/team-profiles.bundle.css.gz';
  let loading = null;

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

  window.AtlasTeamProfilesBootstrap = { load };
  if (document.readyState === 'complete') load();
  else window.addEventListener('load', load, { once: true });
})();
