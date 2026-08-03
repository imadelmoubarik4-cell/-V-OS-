// VÁ Bar Inventory — connection settings

window.VABAR_CONFIG = {
  SUPABASE_URL: "https://dnefgcmjcgxlynycxkts.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp",
  SPRINT3_REVIEW_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-sprint3-review",
  SPRINT4_BRIEFING_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-sprint4-briefing",
  PHASE3_BRAIN_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-phase3-brain",
  OPERATIONS_CHECKPOINT_A_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-operations-checkpoint-a",
  INVENTORY_SCANNER_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-inventory-scanner",
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
  };

  if (install()) return;
  const timer = window.setInterval(() => {
    if (install()) window.clearInterval(timer);
  }, 50);
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

// Real VÁ Data Review is manager-only. It reads and writes the isolated private
// graph shared with Daily Briefing and Phase 3 Decision Memory.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/sprint3-review.css',
  scriptPath: 'assets/js/sprint3-review.js',
  globalName: 'AtlasSprint3Review',
  dataAttribute: 'atlasSprint3Review',
}));

// Phase 1 Daily Briefing remains the trusted context layer.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/brain-daily-briefing.css',
  scriptPath: 'assets/js/brain-daily-briefing-v2.js',
  globalName: 'AtlasDailyBriefing',
  dataAttribute: 'atlasDailyBriefing',
}));

// Phase 3 adds shadow recommendations, decision memory and outcome feedback.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/brain-phase3.css',
  scriptPath: 'assets/js/brain-phase3.js',
  globalName: 'AtlasPhase3Brain',
  dataAttribute: 'atlasPhase3Brain',
}));

// Checkpoint A adds recurring routines and daily temperature evidence.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/operations-checkpoint-a.css',
  scriptPath: 'assets/js/operations-checkpoint-a.js',
  globalName: 'AtlasCheckpointA',
  dataAttribute: 'atlasCheckpointA',
}));

// The compact Checkpoint A presentation loads after the routine engine entry.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/operations-checkpoint-a-layout.css',
  scriptPath: 'assets/js/operations-checkpoint-a-layout.js',
  globalName: 'AtlasCheckpointALayout',
  dataAttribute: 'atlasCheckpointALayout',
}));

// Checkpoint B is intentionally bootstrapped separately. The bootstrap waits
// until the authenticated application shell is visible, then loads:
//   assets/css/inventory-scanner.css
//   assets/js/inventory-scanner.js
// It also isolates scanner taps, DOM observation and API timeout handling so the
// modal cannot block login or become unresponsive while its snapshot is loading.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/inventory-scanner-bootstrap.js',
  globalName: 'AtlasInventoryScannerBootstrap',
  dataAttribute: 'atlasInventoryScannerBootstrap',
}));
