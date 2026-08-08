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

(function installAtlasRuntimeLoader() {
  'use strict';

  const query = new URLSearchParams(window.location.search);
  const safeBoot = query.get('safe') === '1' || query.get('atlas_safe') === '1';
  window.VABAR_CONFIG.SAFE_BOOT = safeBoot;

  // Several Atlas modules add Lucide placeholders while observing the application
  // shell. Lucide-generated SVGs can otherwise retrigger those observers forever.
  // Render icons only when unresolved source placeholders exist and block re-entry.
  function installLucideGuard() {
    const lucide = window.lucide;
    if (!lucide || typeof lucide.createIcons !== 'function') return false;
    if (lucide.createIcons.__atlasStabilityGuard) return true;

    const originalCreateIcons = lucide.createIcons.bind(lucide);
    let rendering = false;

    const guardedCreateIcons = function guardedCreateIcons(options) {
      if (rendering) return undefined;
      if (!document.querySelector('i[data-lucide], span[data-lucide]')) return undefined;
      rendering = true;
      try {
        return originalCreateIcons(options);
      } finally {
        rendering = false;
      }
    };

    guardedCreateIcons.__atlasStabilityGuard = true;
    guardedCreateIcons.__atlasOriginal = originalCreateIcons;
    lucide.createIcons = guardedCreateIcons;
    return true;
  }

  if (!installLucideGuard()) {
    const lucideTimer = window.setInterval(() => {
      if (installLucideGuard()) window.clearInterval(lucideTimer);
    }, 50);
    window.setTimeout(() => window.clearInterval(lucideTimer), 10000);
  }

  const loadedGroups = new Set();
  const loadingGroups = new Map();
  let authenticated = Boolean(window.atlasCurrentProfile?.active);

  function addStylesheet(stylesheetPath, dataAttribute) {
    if (!stylesheetPath) return;
    const selector = `link[href="${stylesheetPath}"]`;
    if (document.querySelector(selector)) return;
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = stylesheetPath;
    if (dataAttribute) stylesheet.dataset[dataAttribute] = 'true';
    document.head.appendChild(stylesheet);
  }

  function loadScript(scriptPath, globalName, dataAttribute) {
    if (!scriptPath) return Promise.resolve();
    if ((globalName && window[globalName]) || document.querySelector(`script[src="${scriptPath}"]`)) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = scriptPath;
      script.async = false;
      if (dataAttribute) script.dataset[dataAttribute] = 'true';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Atlas asset could not load: ${scriptPath}`));
      document.body.appendChild(script);
    });
  }

  function loadAtlasAssetOnce({ stylesheetPath, scriptPath, globalName, dataAttribute }) {
    addStylesheet(stylesheetPath, dataAttribute);
    return loadScript(scriptPath, globalName, dataAttribute);
  }

  window.loadAtlasAssetOnce = loadAtlasAssetOnce;

  const groups = {
    dashboard: [
      { stylesheetPath: 'assets/css/brain-daily-briefing.css', scriptPath: 'assets/js/brain-daily-briefing-v2.js', globalName: 'AtlasDailyBriefing', dataAttribute: 'atlasDailyBriefing' },
      { stylesheetPath: 'assets/css/brain-phase3.css', scriptPath: 'assets/js/brain-phase3.js', globalName: 'AtlasPhase3Brain', dataAttribute: 'atlasPhase3Brain' },
      { stylesheetPath: 'assets/css/brain-checkpoint-k.css', scriptPath: 'assets/js/brain-checkpoint-k.js', globalName: 'AtlasCheckpointK', dataAttribute: 'atlasCheckpointK' },
      { stylesheetPath: 'assets/css/operations-checkpoint-a.css', scriptPath: 'assets/js/operations-checkpoint-a.js', globalName: 'AtlasCheckpointA', dataAttribute: 'atlasCheckpointA' },
      { stylesheetPath: 'assets/css/operations-checkpoint-a-layout.css', scriptPath: 'assets/js/operations-checkpoint-a-layout.js', globalName: 'AtlasCheckpointALayout', dataAttribute: 'atlasCheckpointALayout' },
    ],
    inventory: [
      { scriptPath: 'assets/js/inventory-scanner-bootstrap.js', globalName: 'AtlasInventoryScannerBootstrap', dataAttribute: 'atlasInventoryScannerBootstrap' },
      { scriptPath: 'assets/js/stock-count-bootstrap.js', globalName: 'AtlasStockCountBootstrap', dataAttribute: 'atlasStockCountBootstrap' },
    ],
    imports: [
      { stylesheetPath: 'assets/css/sprint3-review.css', scriptPath: 'assets/js/sprint3-review.js', globalName: 'AtlasSprint3Review', dataAttribute: 'atlasSprint3Review' },
    ],
    team: [
      { stylesheetPath: 'assets/css/team-messages.css', scriptPath: 'assets/js/team-messages.js', globalName: 'AtlasTeamMessages', dataAttribute: 'atlasTeamMessages' },
      { scriptPath: 'assets/js/team-unread-badge.js', globalName: 'AtlasTeamUnreadBadge', dataAttribute: 'atlasTeamUnreadBadge' },
      { scriptPath: 'assets/js/team-profiles-bootstrap.js', globalName: 'AtlasTeamProfilesBootstrap', dataAttribute: 'atlasTeamProfilesBootstrap' },
      { stylesheetPath: 'assets/css/team-profile-photos.css', scriptPath: 'assets/js/team-profile-photos.js', globalName: 'AtlasTeamProfilePhotos', dataAttribute: 'atlasTeamProfilePhotos' },
      { scriptPath: 'assets/js/team-profile-photo-gallery.js', globalName: 'AtlasTeamProfileGallery', dataAttribute: 'atlasTeamProfileGallery' },
    ],
    marketing: [
      { stylesheetPath: 'assets/css/marketing-workspace.css', scriptPath: 'assets/js/marketing-workspace.js', globalName: 'AtlasMarketingWorkspace', dataAttribute: 'atlasMarketingWorkspace' },
    ],
    shifts: [
      { stylesheetPath: 'assets/css/shifts-workspace.css', scriptPath: 'assets/js/shifts-workspace.js', globalName: 'AtlasShifts', dataAttribute: 'atlasShifts' },
      { stylesheetPath: 'assets/css/shifts-month-calendar.css', scriptPath: 'assets/js/shifts-month-calendar.js', globalName: 'AtlasShiftsMonth', dataAttribute: 'atlasShiftsMonth' },
      { stylesheetPath: 'assets/css/shifts-month-editor.css', dataAttribute: 'atlasShiftsMonthEditor' },
      { scriptPath: 'assets/js/shifts-month-tab-bridge.js', globalName: 'AtlasShiftsMonthTabBridge', dataAttribute: 'atlasShiftsMonthTabBridge' },
    ],
    knowledge: [
      { stylesheetPath: 'assets/css/knowledge-workspace.css', scriptPath: 'assets/js/knowledge-workspace.js', globalName: 'AtlasKnowledge', dataAttribute: 'atlasKnowledge' },
      { scriptPath: 'assets/js/knowledge-team-link-bridge.js', globalName: 'AtlasKnowledgeTeamLinkBridge', dataAttribute: 'atlasKnowledgeTeamLinkBridge' },
      { stylesheetPath: 'assets/css/read-sources-p22.css?v=20260806-p22', scriptPath: 'assets/js/read-sources-p22.js?v=20260806-p22', globalName: 'AtlasReadSourcesP22', dataAttribute: 'atlasReadSourcesP22' },
    ],
    reports: [
      { stylesheetPath: 'assets/css/reports-workspace.css', scriptPath: 'assets/js/reports-workspace.js', globalName: 'AtlasReports', dataAttribute: 'atlasReports' },
      { stylesheetPath: 'assets/css/pos-mapping-checkpoint-m.css?v=20260806-m1', scriptPath: 'assets/js/pos-mapping-checkpoint-m.js?v=20260806-m1', globalName: 'AtlasCheckpointM', dataAttribute: 'atlasPosMappingM' },
    ],
    settings: [
      { stylesheetPath: 'assets/css/settings-workspace.css', scriptPath: 'assets/js/settings-workspace.js', globalName: 'AtlasSettings', dataAttribute: 'atlasSettings' },
      { stylesheetPath: 'assets/css/connection-center.css?v=20260806-p20', scriptPath: 'assets/js/connection-center.js?v=20260806-p20', globalName: 'AtlasConnectionCenter', dataAttribute: 'atlasConnectionCenter' },
      { scriptPath: 'assets/js/settings-mount-bridge.js', globalName: 'AtlasCheckpointJSettingsMount', dataAttribute: 'atlasCheckpointJSettingsMount' },
    ],
    system: [
      { stylesheetPath: 'assets/css/system-workspace.css', scriptPath: 'assets/js/system-workspace.js', globalName: 'AtlasSystem', dataAttribute: 'atlasSystem' },
      { stylesheetPath: 'assets/css/connection-center.css?v=20260806-p20', scriptPath: 'assets/js/connection-center.js?v=20260806-p20', globalName: 'AtlasConnectionCenter', dataAttribute: 'atlasConnectionCenter' },
    ],
  };

  function idleDelay(milliseconds) {
    return new Promise((resolve) => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => resolve(), { timeout: milliseconds + 250 });
      } else {
        window.setTimeout(resolve, milliseconds);
      }
    });
  }

  async function loadGroup(groupName) {
    if (safeBoot || !authenticated) return false;
    if (loadedGroups.has(groupName)) return true;
    if (loadingGroups.has(groupName)) return loadingGroups.get(groupName);

    const definitions = groups[groupName];
    if (!definitions?.length) return false;

    const task = (async () => {
      for (const definition of definitions) {
        await idleDelay(80);
        try {
          await loadAtlasAssetOnce(definition);
        } catch (error) {
          console.error(`Atlas ${groupName} asset failed`, error);
        }
      }
      loadedGroups.add(groupName);
      return true;
    })().finally(() => loadingGroups.delete(groupName));

    loadingGroups.set(groupName, task);
    return task;
  }

  function viewGroup(view) {
    if (view === 'dashboard') return 'dashboard';
    if (view === 'inventory') return 'inventory';
    if (view === 'imports') return 'imports';
    if (view === 'team') return 'team';
    if (view === 'shifts') return 'shifts';
    if (view === 'knowledge') return 'knowledge';
    if (view === 'reports') return 'reports';
    if (view === 'settings') return 'settings';
    if (view === 'system') return 'system';
    if (view === 'marketing') return 'marketing';
    return null;
  }

  function loadAtlasAssetsAfterWindowLoad(loader) {
    const schedule = () => {
      if (safeBoot) return;
      const run = () => {
        if (!authenticated) return;
        Promise.resolve().then(loader).catch((error) => console.error('Atlas deferred asset failed', error));
      };
      if (authenticated) run();
      else window.addEventListener('atlas:profile-ready', run, { once: true });
    };
    if (document.readyState === 'complete') schedule();
    else window.addEventListener('load', schedule, { once: true });
  }

  window.loadAtlasAssetsAfterWindowLoad = loadAtlasAssetsAfterWindowLoad;
  window.AtlasAssetLoader = {
    safeBoot,
    loadGroup,
    loadedGroups: () => [...loadedGroups],
  };

  window.addEventListener('atlas:profile-ready', (event) => {
    authenticated = Boolean(event.detail?.active);
    if (!authenticated || safeBoot) return;

    // System owns a navigation destination not present in the legacy shell. Load
    // only that lightweight registration path after authentication. Everything
    // else remains lazy and loads on the first visit to its workspace.
    window.setTimeout(() => loadGroup('system'), 250);
  });

  document.addEventListener('click', (event) => {
    if (safeBoot || !authenticated) return;
    const element = event.target instanceof Element
      ? event.target.closest('[data-view], [data-default]')
      : null;
    const view = element?.dataset.view || element?.dataset.default;
    const group = viewGroup(view);
    if (group) loadGroup(group);
  }, true);
})();
