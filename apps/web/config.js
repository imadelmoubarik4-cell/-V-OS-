// VÁ Bar Inventory — connection settings

window.VABAR_CONFIG = {
  SUPABASE_URL: "https://dnefgcmjcgxlynycxkts.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp",
  SPRINT3_REVIEW_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-sprint3-review",
  SPRINT4_BRIEFING_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-sprint4-briefing",
  PHASE3_BRAIN_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-phase3-brain",
};

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
