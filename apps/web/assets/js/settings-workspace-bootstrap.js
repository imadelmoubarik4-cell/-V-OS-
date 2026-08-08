(function () {
  'use strict';

  const state = { loading: false, ready: false, error: null };
  const assetPath = 'assets/js/settings-workspace.js.gz.b64';

  function decodeBase64(value) {
    const binary = atob(value.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser does not support the secure Settings bundle loader.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }

  async function load() {
    if (state.ready || state.loading || window.AtlasSettings) return;
    state.loading = true;
    state.error = null;
    try {
      const response = await fetch(assetPath, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Settings bundle could not be loaded (${response.status}).`);
      const source = await inflate(decodeBase64(await response.text()));
      const script = document.createElement('script');
      script.dataset.atlasSettingsBundle = 'true';
      script.src = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      script.onload = () => {
        URL.revokeObjectURL(script.src);
        state.ready = Boolean(window.AtlasSettings);
        state.loading = false;
      };
      script.onerror = () => {
        URL.revokeObjectURL(script.src);
        state.loading = false;
        state.error = 'The Settings workspace failed to start.';
      };
      document.body.appendChild(script);
    } catch (error) {
      state.loading = false;
      state.error = error instanceof Error ? error.message : 'The Settings workspace failed to load.';
      console.error('Settings bootstrap error', state.error);
    }
  }

  window.AtlasSettingsBootstrap = {
    load,
    ready: () => state.ready,
    error: () => state.error
  };

  load();
})();
