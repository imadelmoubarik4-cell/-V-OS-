// VÁ Bar Inventory — connection settings

window.VABAR_CONFIG = {
  SUPABASE_URL: "https://dnefgcmjcgxlynycxkts.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp",
  SPRINT3_REVIEW_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-sprint3-review",
  SPRINT4_BRIEFING_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-sprint4-briefing",
  PHASE3_BRAIN_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-phase3-brain",
  OPERATIONS_CHECKPOINT_A_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-operations-checkpoint-a",
  INVENTORY_SCANNER_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-inventory-scanner",
  TEAM_MESSAGES_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-team-messages",
  MARKETING_WORKSPACE_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-marketing-workspace",
  TEAM_PROFILES_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-team-profiles",
  TEAM_PROFILE_PHOTOS_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-team-profile-photos",
  SHIFTS_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-shifts",
};

// Several Atlas modules add Lucide placeholders while observing the application
// shell. Lucide-generated SVGs can otherwise retrigger those observers forever.
// Render icons only when unresolved source placeholders exist and block re-entry.
(function installAtlasLucideStabilityGuard() {
  const install = () => {
    const lucide = window.lucide;
    if (!lucide || typeof lucide.createIcons !== 'function') return false;
    if (lucide.createIcons.__atlasStabilityGuard) return true;

    const originalCreateIcons = lucide.createIcons.bind(lucide);
    let rendering = false;

    const guardedCreateIcons = function (options) {
      if (rendering) return undefined;
      if (!document.querySelector('i[data-lucide], span[data-lucide]')) return undefined;
      rendering = true;
      try { return originalCreateIcons(options); }
      finally { rendering = false; }
    };

    guardedCreateIcons.__atlasStabilityGuard = true;
    guardedCreateIcons.__atlasOriginal = originalCreateIcons;
    lucide.createIcons = guardedCreateIcons;
    return true;
  };

  if (install()) return;
  const timer = window.setInterval(() => { if (install()) window.clearInterval(timer); }, 50);
  window.setTimeout(() => window.clearInterval(timer), 10000);
})();

function loadAtlasAssetOnce({ stylesheetPath, scriptPath, globalName, dataAttribute }) {
  if (stylesheetPath && !document.querySelector(`link[href="${stylesheetPath}"]`)) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = stylesheetPath;
    if (dataAttribute) stylesheet.dataset[dataAttribute] = 'true';
    document.head.appendChild(stylesheet);
  }
  if (!scriptPath) return;
  if ((globalName && window[globalName]) || document.querySelector(`script[src="${scriptPath}"]`)) return;
  const script = document.createElement('script');
  script.src = scriptPath;
  if (dataAttribute) script.dataset[dataAttribute] = 'true';
  document.body.appendChild(script);
}

function loadAtlasAssetsAfterWindowLoad(loader) {
  if (document.readyState === 'complete') loader();
  else window.addEventListener('load', loader, { once: true });
}

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/sprint3-review.css',
  scriptPath: 'assets/js/sprint3-review.js',
  globalName: 'AtlasSprint3Review',
  dataAttribute: 'atlasSprint3Review',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/brain-daily-briefing.css',
  scriptPath: 'assets/js/brain-daily-briefing-v2.js',
  globalName: 'AtlasDailyBriefing',
  dataAttribute: 'atlasDailyBriefing',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/brain-phase3.css',
  scriptPath: 'assets/js/brain-phase3.js',
  globalName: 'AtlasPhase3Brain',
  dataAttribute: 'atlasPhase3Brain',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/operations-checkpoint-a.css',
  scriptPath: 'assets/js/operations-checkpoint-a.js',
  globalName: 'AtlasCheckpointA',
  dataAttribute: 'atlasCheckpointA',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/operations-checkpoint-a-layout.css',
  scriptPath: 'assets/js/operations-checkpoint-a-layout.js',
  globalName: 'AtlasCheckpointALayout',
  dataAttribute: 'atlasCheckpointALayout',
}));

// Checkpoint B waits until the authenticated application shell is visible.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/inventory-scanner-bootstrap.js',
  globalName: 'AtlasInventoryScannerBootstrap',
  dataAttribute: 'atlasInventoryScannerBootstrap',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/team-messages.css',
  scriptPath: 'assets/js/team-messages.js',
  globalName: 'AtlasTeamMessages',
  dataAttribute: 'atlasTeamMessages',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/team-unread-badge.js',
  globalName: 'AtlasTeamUnreadBadge',
  dataAttribute: 'atlasTeamUnreadBadge',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/marketing-workspace.css',
  scriptPath: 'assets/js/marketing-workspace.js',
  globalName: 'AtlasMarketingWorkspace',
  dataAttribute: 'atlasMarketingWorkspace',
}));

// Checkpoint E loads a compressed, repository-owned Team Profiles bundle. The
// bootstrap uses browser-native gzip decompression, then installs the Atlas CSS
// and JavaScript through Blob URLs without inline eval.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/team-profiles-bootstrap.js',
  globalName: 'AtlasTeamProfilesBootstrap',
  dataAttribute: 'atlasTeamProfilesBootstrap',
}));

// Checkpoint E.1 layers private profile portraits over the existing directory.
// Photos are resized on-device, then pass through an authenticated server gateway;
// the browser never receives direct Storage credentials or privileged server keys.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/team-profile-photos.css',
  scriptPath: 'assets/js/team-profile-photos.js',
  globalName: 'AtlasTeamProfilePhotos',
  dataAttribute: 'atlasTeamProfilePhotos',
}));

// Mobile profile-photo selection uses the normal operating-system image picker.
// This preserves both gallery/file access and any camera option offered by the
// device instead of forcing a front-camera capture.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/team-profile-photo-gallery.js',
  globalName: 'AtlasTeamProfileGallery',
  dataAttribute: 'atlasTeamProfileGallery',
}));

// Checkpoint F replaces the Shifts placeholder with a private weekly planner,
// availability, time-off, publishing and confirmation workspace.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/shifts-workspace.css',
  scriptPath: 'assets/js/shifts-workspace.js',
  globalName: 'AtlasShifts',
  dataAttribute: 'atlasShifts',
}));

// Checkpoint F.1 introduced the complete month grid. F.2 turns that grid into
// the primary monthly planning surface: managers edit any date in the month and
// publish one immutable month revision for staff while weekly drill-down remains
// available for detailed review and confirmations.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/shifts-month-calendar.css',
  scriptPath: 'assets/js/shifts-month-calendar.js',
  globalName: 'AtlasShiftsMonth',
  dataAttribute: 'atlasShiftsMonth',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/shifts-month-editor.css',
  dataAttribute: 'atlasShiftsMonthEditor',
}));

// The weekly workspace and the Month extension both listen to the shared tab
// bar. This bridge keeps the dedicated Month capture handler authoritative so
// the older weekly bubbling handler cannot rebuild the tabs during the click.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/shifts-month-tab-bridge.js',
  globalName: 'AtlasShiftsMonthTabBridge',
  dataAttribute: 'atlasShiftsMonthTabBridge',
}));
