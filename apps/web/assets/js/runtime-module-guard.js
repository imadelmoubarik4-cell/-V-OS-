(function () {
  'use strict';

  // This repository-owned manifest is deliberately separate from config.js.
  // A deployment may replace connection values, but it must not remove the
  // scripts that make an authorized navigation destination functional.
  const REQUIRED_MODULES = Object.freeze([
    ['assets/css/team-messages.css', 'assets/js/team-messages.js', 'AtlasTeamMessages'],
    [null, 'assets/js/team-unread-badge.js', 'AtlasTeamUnreadBadge'],
    [null, 'assets/js/team-profiles-bootstrap.js', 'AtlasTeamProfilesBootstrap'],
    ['assets/css/team-profile-photos.css', 'assets/js/team-profile-photos.js', 'AtlasTeamProfilePhotos'],
    [null, 'assets/js/team-profile-photo-gallery.js', 'AtlasTeamProfileGallery'],
    ['assets/css/shifts-workspace.css', 'assets/js/shifts-workspace.js', 'AtlasShifts'],
    ['assets/css/knowledge-workspace.css', 'assets/js/knowledge-workspace.js', 'AtlasKnowledge'],
    ['assets/css/settings-workspace.css', 'assets/js/settings-workspace.js', 'AtlasSettings'],
    [null, 'assets/js/notifications.js', 'AtlasNotifications']
  ]);

  function install([stylesheetPath, scriptPath, globalName]) {
    if (stylesheetPath && !document.querySelector(`link[href="${stylesheetPath}"]`)) {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = stylesheetPath;
      stylesheet.dataset.atlasRuntimeGuard = 'true';
      document.head.appendChild(stylesheet);
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
