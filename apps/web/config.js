// VÁ Bar Inventory — connection settings

window.VABAR_CONFIG = {
  MODE: "production",
  SUPABASE_URL: "https://dnefgcmjcgxlynycxkts.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp",
  SPRINT3_REVIEW_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-sprint3-review",
  SPRINT4_BRIEFING_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-sprint4-briefing",
  PHASE3_BRAIN_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-phase3-brain",
  PHASE3_INTELLIGENCE_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-phase3-intelligence",
  OPERATIONS_CHECKPOINT_A_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-operations-checkpoint-a",
  INVENTORY_SCANNER_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-inventory-scanner",
  STOCK_COUNTS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-stock-counts",
  TEAM_MESSAGES_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-team-messages",
  MARKETING_WORKSPACE_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-marketing-workspace",
  TEAM_PROFILES_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-team-profiles",
  TEAM_PROFILE_PHOTOS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-team-profile-photos",
  SHIFTS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-shifts",
  KNOWLEDGE_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-knowledge",
  REPORTS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-reports",
  SYSTEM_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-system",
  SETTINGS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-settings",
  // Settings › Integrations: status and server-side OAuth (connect hop, test, disconnect).
  INTEGRATIONS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-integrations",
  ITEM_MASTER_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-item-master",
  // Atlas AI: conversations, approvals and voice. Answers "not configured" until the owner switches it on.
  ATLAS_AI_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-ai",
  // Import processing remains fail-closed until its separate activation gate.
  IMPORT_WORKER_API: "",
  // Device subscriptions are opt-in; server-side push delivery remains disabled.
  NOTIFICATIONS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-notifications",
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
  // S88: AtlasShell.load (assets/js/atlas-shell.js) is the one runtime script
  // loader; it deduplicates by path whatever the cache key. Pages without the
  // shell (the public menu) keep the direct fallback.
  if (window.AtlasShell?.load) {
    window.AtlasShell.load(scriptPath, { global: globalName, async: true, dataset: dataAttribute ? { [dataAttribute]: 'true' } : {} })
      .catch((error) => console.error(error));
    return;
  }
  if ((globalName && window[globalName]) || document.querySelector(`script[src="${scriptPath}"]`)) return;
  const script = document.createElement('script');
  script.src = scriptPath;
  if (dataAttribute) script.dataset[dataAttribute] = 'true';
  document.body.appendChild(script);
}

function loadAtlasAssetsAfterWindowLoad(loader) {
  if (document.body?.dataset.atlasStandalone === 'true') return;
  if (document.readyState === 'complete') loader();
  else window.addEventListener('load', loader, { once: true });
}

// S88: the Brain page, its daily briefing, Phase 3 and Checkpoint K panels and
// the Checkpoint A routine layers are retired. Home (assets/js/home.js) holds the
// briefing, Atlas AI › Decisions the decision ledger, and Operations
// (assets/js/operations.js, loaded by index.html) the server checklists.

// Inventory, stock count, Purchasing and the shared Visual Inventory capture
// (atlas-inventory.js, stock-count-workspace.js, atlas-purchasing.js,
// atlas-capture.js) load with index.html. Recognition never changes stock; a
// count changes stock only after a manager verifies it.


loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/team-messages.css',
  scriptPath: 'assets/js/team-messages.js?v=20260926-s88',
  globalName: 'AtlasTeamMessages',
  dataAttribute: 'atlasTeamMessages',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/team-unread-badge.js',
  globalName: 'AtlasTeamUnreadBadge',
  dataAttribute: 'atlasTeamUnreadBadge',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/marketing-workspace.css?v=20260926-s88',
  scriptPath: 'assets/js/marketing-workspace.js?v=20260926-s88',
  globalName: 'AtlasMarketingWorkspace',
  dataAttribute: 'atlasMarketingWorkspace',
}));

// Checkpoint E loads a compressed, repository-owned Team Profiles bundle. The
// bootstrap uses browser-native gzip decompression, then installs the Atlas CSS
// and JavaScript through Blob URLs without inline eval.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/team-profiles-bootstrap.js?v=20260926-s88',
  globalName: 'AtlasTeamProfilesBootstrap',
  dataAttribute: 'atlasTeamProfilesBootstrap',
}));

// Checkpoint E.1 layers private profile portraits over the existing directory.
// Photos are resized on-device, then pass through an authenticated server gateway;
// the browser never receives direct Storage credentials or privileged server keys.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/team-profile-photos.css',
  scriptPath: 'assets/js/team-profile-photos.js?v=20260926-s88',
  globalName: 'AtlasTeamProfilePhotos',
  dataAttribute: 'atlasTeamProfilePhotos',
}));

// Checkpoint F replaces the Shifts placeholder with a private weekly planner,
// availability, time-off, publishing and confirmation workspace.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/shifts-workspace.css',
  scriptPath: 'assets/js/shifts-workspace.js?v=20260926-s88',
  globalName: 'AtlasShifts',
  dataAttribute: 'atlasShifts',
}));

// Checkpoint G replaces the Knowledge placeholder with a version-controlled,
// role-aware library. Drafts remain manager-only, while staff receive only
// published versions and their version-specific acknowledgement state.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/knowledge-workspace.css',
  scriptPath: 'assets/js/knowledge-workspace.js?v=20260926-s88',
  globalName: 'AtlasKnowledge',
  dataAttribute: 'atlasKnowledge',
}));

// Checkpoint H replaces the Reports placeholder with a permission-aware,
// read-only analysis workspace. It pulls live source records through the
// authenticated gateway and labels missing integrations instead of inventing data.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/reports-workspace.css?v=20260926-s88',
  scriptPath: 'assets/js/reports-workspace.js?v=20260928-s89t',
  globalName: 'AtlasReports',
  dataAttribute: 'atlasReports',
}));

// Settings › System health (administrators): read-only application health,
// environments, data freshness, jobs, incidents and recovery references.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/system-workspace.js?v=20260926-s88',
  globalName: 'AtlasSystem',
  dataAttribute: 'atlasSystem',
}));

// Checkpoint J replaces the Settings placeholder with a versioned, role-aware
// control centre for venue configuration, operating rules and personal preferences.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/settings-workspace.css',
  scriptPath: 'assets/js/settings-workspace.js?v=20260926-s88',
  globalName: 'AtlasSettings',
  dataAttribute: 'atlasSettings',
}));

// Notification subscriptions remain opt-in. Server-side delivery stays disabled
// until its separate production activation gate is approved.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/notifications.js',
  globalName: 'AtlasNotifications',
  dataAttribute: 'atlasNotifications',
}));
