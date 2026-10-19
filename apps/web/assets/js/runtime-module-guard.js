(function () {
  'use strict';

  // This repository-owned manifest is deliberately separate from config.js.
  // A deployment may replace connection values, but it must not remove the
  // scripts that make an authorized navigation destination functional.
  //
  // Each entry is [stylesheetPath, scriptPath, globalName, lazyViewKey?]. A fourth
  // element marks a REQUIRED module that is meant to load lazily (on first
  // navigation to that view) rather than eagerly at boot. The guard still protects
  // it: it confirms the shell has it registered as that lazy view, and if the
  // registration is missing — a reduced or broken deployment where the module would
  // otherwise silently never load — the guard falls back to loading it eagerly now.
  // So a required module can never silently disappear, whether eager or lazy.
  const REQUIRED_MODULES = Object.freeze([
    ['assets/css/team-messages.css?v=20261002-s93r', 'assets/js/team-messages.js', 'AtlasTeamMessages'],
    [null, 'assets/js/team-unread-badge.js', 'AtlasTeamUnreadBadge'],
    [null, 'assets/js/team-profiles-bootstrap.js', 'AtlasTeamProfilesBootstrap'],
    ['assets/css/team-profile-photos.css', 'assets/js/team-profile-photos.js', 'AtlasTeamProfilePhotos'],
    ['assets/css/shifts-workspace.css', 'assets/js/shifts-workspace.js', 'AtlasShifts', 'shifts'],
    ['assets/css/knowledge-workspace.css', 'assets/js/knowledge-workspace.js', 'AtlasKnowledge', 'knowledge'],
    ['assets/css/settings-workspace.css', 'assets/js/settings-workspace.js', 'AtlasSettings'],
    [null, 'assets/js/notifications.js', 'AtlasNotifications']
  ]);

  function install([stylesheetPath, scriptPath, globalName, lazyViewKey]) {
    // A required module declared lazy is loaded on navigation by the shell, not
    // here — but only once the shell confirms it is registered as that lazy view.
    // If that registration is absent, the destination would silently never load, so
    // the guard loads it eagerly now (fail-safe). A confirmed lazy module is left
    // for navigation to load, and its stylesheet loads with it, so neither is
    // preloaded here.
    if (lazyViewKey && window.AtlasShell?.isLazyView?.(lazyViewKey)) return;
    if (stylesheetPath && !document.querySelector(`link[href="${stylesheetPath}"]`)) {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = stylesheetPath;
      stylesheet.dataset.atlasRuntimeGuard = 'true';
      document.head.appendChild(stylesheet);
    }
    // S88: AtlasShell.load deduplicates against config.js by path (any cache key).
    if (window.AtlasShell?.load) {
      window.AtlasShell.load(scriptPath, { global: globalName, async: true, dataset: { atlasRuntimeGuard: 'true' } })
        .catch((error) => console.error(error));
      return;
    }
    if (window[globalName] || document.querySelector(`script[src="${scriptPath}"]`)) return;
    const script = document.createElement('script');
    script.src = scriptPath;
    script.dataset.atlasRuntimeGuard = 'true';
    document.body.appendChild(script);
  }

  function ensure() {
    if (document.body?.dataset.atlasStandalone === 'true') return;
    REQUIRED_MODULES.forEach(install);
  }

  window.AtlasRuntimeModules = { ensure, manifest: () => REQUIRED_MODULES.map((entry) => [...entry]) };
  if (document.readyState === 'complete') ensure();
  else window.addEventListener('load', ensure, { once: true });
})();
