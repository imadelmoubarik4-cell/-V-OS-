// VÁ Bar Inventory — connection settings

window.VABAR_CONFIG = {
  SUPABASE_URL: "https://dnefgcmjcgxlynycxkts.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp",
  SPRINT3_REVIEW_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-sprint3-review",
  SPRINT4_BRIEFING_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-sprint4-briefing",
  PHASE3_BRAIN_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-phase3-brain",
  PHASE3_INTELLIGENCE_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-phase3-intelligence",
  OPERATIONS_CHECKPOINT_A_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-operations-checkpoint-a",
  INVENTORY_SCANNER_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-inventory-scanner",
  STOCK_COUNTS_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-stock-counts",
  TEAM_MESSAGES_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-team-messages",
  MARKETING_WORKSPACE_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-marketing-workspace",
  TEAM_PROFILES_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-team-profiles",
  TEAM_PROFILE_PHOTOS_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-team-profile-photos",
  SHIFTS_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-shifts",
  KNOWLEDGE_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-knowledge",
  REPORTS_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-reports",
  SYSTEM_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-system",
  SETTINGS_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-settings",
  CONNECTIONS_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-connections",
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

// Checkpoint K layers four evidence-gated intelligence tracks over the existing
// decision-memory workspace. It reads role-permitted production sources through
// a manager-only gateway and never mutates inventory, orders, menus or waste.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/brain-checkpoint-k.css',
  scriptPath: 'assets/js/brain-checkpoint-k.js',
  globalName: 'AtlasCheckpointK',
  dataAttribute: 'atlasCheckpointK',
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

// Checkpoint L1 adds mobile, unit-aware stock-count sessions. Count
// observations and manager verification remain private; only the explicit
// manager publication boundary may create controlled count adjustments.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/stock-count-bootstrap.js',
  globalName: 'AtlasStockCountBootstrap',
  dataAttribute: 'atlasStockCountBootstrap',
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

// Checkpoint G replaces the Knowledge placeholder with a version-controlled,
// role-aware library. Drafts remain manager-only, while staff receive only
// published versions and their version-specific acknowledgement state.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/knowledge-workspace.css',
  scriptPath: 'assets/js/knowledge-workspace.js',
  globalName: 'AtlasKnowledge',
  dataAttribute: 'atlasKnowledge',
}));

// Published Knowledge updates can appear as linked Team announcements. This
// capture bridge keeps the new Knowledge link type from falling through to the
// older Team Messages default route.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/knowledge-team-link-bridge.js',
  globalName: 'AtlasKnowledgeTeamLinkBridge',
  dataAttribute: 'atlasKnowledgeTeamLinkBridge',
}));

// Checkpoint H replaces the Reports placeholder with a permission-aware,
// read-only analysis workspace. It pulls live source records through the
// authenticated gateway and labels missing integrations instead of inventing data.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/reports-workspace.css',
  scriptPath: 'assets/js/reports-workspace.js',
  globalName: 'AtlasReports',
  dataAttribute: 'atlasReports',
}));

// Checkpoint I adds a manager-only, read-only control room for application
// health, environments, integrations, data freshness, jobs, incidents,
// security posture, audit evidence and recovery references.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/system-workspace.css',
  scriptPath: 'assets/js/system-workspace.js',
  globalName: 'AtlasSystem',
  dataAttribute: 'atlasSystem',
}));

// Checkpoint J replaces the Settings placeholder with a versioned, role-aware
// control centre for venue configuration, operating rules and personal preferences.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/settings-workspace.css',
  scriptPath: 'assets/js/settings-workspace.js',
  globalName: 'AtlasSettings',
  dataAttribute: 'atlasSettings',
}));

// A legacy Operations layout can still append its old connection cards to the
// Settings placeholder. This bridge makes the Checkpoint J workspace authoritative.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/settings-mount-bridge.js',
  globalName: 'AtlasCheckpointJSettingsMount',
  dataAttribute: 'atlasCheckpointJSettingsMount',
}));

/* CHECKPOINT_I_SYSTEM_ASSETS */
;(() => {
  const cfg = window.VABAR_CONFIG = window.VABAR_CONFIG || {};
  cfg.SYSTEM_API = cfg.SYSTEM_API || "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-system";

  const cssHref = "assets/css/system-workspace.css";
  if (!document.querySelector(`link[href="${cssHref}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = cssHref;
    document.head.appendChild(link);
  }

  const scriptSrc = "assets/js/system-workspace.js";
  if (!document.querySelector(`script[src="${scriptSrc}"]`)) {
    const script = document.createElement("script");
    script.src = scriptSrc;
    script.async = false;
    document.head.appendChild(script);
  }
})();
