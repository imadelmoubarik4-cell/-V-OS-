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
// shell. Lucide's generated SVGs also retain data-lucide, so repeatedly calling
// createIcons from a body MutationObserver can replace the same icons forever.
// Only run Lucide when a source placeholder is actually present, and never allow
// a re-entrant conversion. This keeps the login form responsive on desktop and
// mobile while preserving normal icon rendering throughout the authenticated app.
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

// Real VÁ Data Review is manager-only. In the Phase 3 preview it reads and
// writes the same isolated private graph used by Decision Memory and the Daily
// Briefing, so each significant review decision can become auditable memory.
(function loadAtlasSprint3Review() {
  const stylesheetPath = 'assets/css/sprint3-review.css';
  const scriptPath = 'assets/js/sprint3-review.js';

  if (!document.querySelector(`link[href="${stylesheetPath}"]`)) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = stylesheetPath;
    stylesheet.dataset.atlasSprint3Review = 'true';
    document.head.appendChild(stylesheet);
  }

  const loadScript = () => {
    if (window.AtlasSprint3Review || document.querySelector('script[data-atlas-sprint3-review]')) return;
    const script = document.createElement('script');
    script.src = scriptPath;
    script.dataset.atlasSprint3Review = 'true';
    document.body.appendChild(script);
  };

  if (document.readyState === 'complete') loadScript();
  else window.addEventListener('load', loadScript, { once: true });
})();

// Phase 1 Daily Briefing remains the trusted morning context layer. It now reads
// the same isolated branch as Phase 3 so review progress and Brain readiness stay
// synchronized without exposing private source rows to the browser.
(function loadAtlasDailyBriefing() {
  const stylesheetPath = 'assets/css/brain-daily-briefing.css';
  const scriptPath = 'assets/js/brain-daily-briefing-v2.js';

  if (!document.querySelector(`link[href="${stylesheetPath}"]`)) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = stylesheetPath;
    stylesheet.dataset.atlasDailyBriefing = 'true';
    document.head.appendChild(stylesheet);
  }

  const loadScript = () => {
    if (window.AtlasDailyBriefing || document.querySelector('script[data-atlas-daily-briefing]')) return;
    const script = document.createElement('script');
    script.src = scriptPath;
    script.dataset.atlasDailyBriefing = 'true';
    document.body.appendChild(script);
  };

  if (document.readyState === 'complete') loadScript();
  else window.addEventListener('load', loadScript, { once: true });
})();

// Phase 3 adds evidence-backed shadow recommendations, decision memory and
// outcome feedback while preserving the original Atlas visual system.
(function loadAtlasPhase3Brain() {
  const stylesheetPath = 'assets/css/brain-phase3.css';
  const scriptPath = 'assets/js/brain-phase3.js';

  if (!document.querySelector(`link[href="${stylesheetPath}"]`)) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = stylesheetPath;
    stylesheet.dataset.atlasPhase3Brain = 'true';
    document.head.appendChild(stylesheet);
  }

  const loadScript = () => {
    if (window.AtlasPhase3Brain || document.querySelector('script[data-atlas-phase3-brain]')) return;
    const script = document.createElement('script');
    script.src = scriptPath;
    script.dataset.atlasPhase3Brain = 'true';
    document.body.appendChild(script);
  };

  if (document.readyState === 'complete') loadScript();
  else window.addEventListener('load', loadScript, { once: true });
})();

// Checkpoint A adds recurring weekly routines, daily temperature evidence and
// explicit marketing/reputation connection boundaries to the Operations Center.
(function loadAtlasCheckpointA() {
  const stylesheetPath = 'assets/css/operations-checkpoint-a.css';
  const scriptPath = 'assets/js/operations-checkpoint-a.js';

  if (!document.querySelector(`link[href="${stylesheetPath}"]`)) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = stylesheetPath;
    stylesheet.dataset.atlasCheckpointA = 'true';
    document.head.appendChild(stylesheet);
  }

  const loadScript = () => {
    if (window.AtlasCheckpointA || document.querySelector('script[data-atlas-checkpoint-a]')) return;
    const script = document.createElement('script');
    script.src = scriptPath;
    script.dataset.atlasCheckpointA = 'true';
    document.body.appendChild(script);
  };

  if (document.readyState === 'complete') loadScript();
  else window.addEventListener('load', loadScript, { once: true });
})();

// The compact presentation keeps routine definitions, checklist details and
// integration readiness in the background. Operations and Home surface only
// what is scheduled today; full checklists open contextually in a focused dialog.
(function loadAtlasCheckpointALayout() {
  const stylesheetPath = 'assets/css/operations-checkpoint-a-layout.css';
  const scriptPath = 'assets/js/operations-checkpoint-a-layout.js';

  if (!document.querySelector(`link[href="${stylesheetPath}"]`)) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = stylesheetPath;
    stylesheet.dataset.atlasCheckpointALayout = 'true';
    document.head.appendChild(stylesheet);
  }

  const loadScript = () => {
    if (window.AtlasCheckpointALayout || document.querySelector('script[data-atlas-checkpoint-a-layout]')) return;
    const script = document.createElement('script');
    script.src = scriptPath;
    script.dataset.atlasCheckpointALayout = 'true';
    document.body.appendChild(script);
  };

  if (document.readyState === 'complete') loadScript();
  else window.addEventListener('load', loadScript, { once: true });
})();

// Checkpoint B adds a mobile-first barcode scanner to Inventory. The scanner is
// deliberately not loaded on the login screen. It starts only after the Atlas
// application shell becomes visible, preventing camera/UI observers from doing
// any work while the user is entering credentials.
(function loadAtlasInventoryScanner() {
  const stylesheetPath = 'assets/css/inventory-scanner.css';
  const scriptPath = 'assets/js/inventory-scanner.js';

  const loadAssets = () => {
    if (!document.querySelector(`link[href="${stylesheetPath}"]`)) {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = stylesheetPath;
      stylesheet.dataset.atlasInventoryScanner = 'true';
      document.head.appendChild(stylesheet);
    }

    if (window.AtlasInventoryScanner || document.querySelector('script[data-atlas-inventory-scanner]')) return;
    const script = document.createElement('script');
    script.src = scriptPath;
    script.dataset.atlasInventoryScanner = 'true';
    document.body.appendChild(script);
  };

  const startWhenSignedIn = () => {
    const appScreen = document.getElementById('app-screen');
    if (!appScreen) return;

    const isSignedIn = () => appScreen.style.display === 'block'
      || window.getComputedStyle(appScreen).display !== 'none';

    if (isSignedIn()) {
      loadAssets();
      return;
    }

    const observer = new MutationObserver(() => {
      if (!isSignedIn()) return;
      observer.disconnect();
      loadAssets();
    });
    observer.observe(appScreen, { attributes: true, attributeFilter: ['style', 'class'] });
  };

  if (document.readyState === 'complete') startWhenSignedIn();
  else window.addEventListener('load', startWhenSignedIn, { once: true });
})();
