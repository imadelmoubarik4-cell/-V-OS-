// VÁ Bar Inventory — connection settings

window.VABAR_CONFIG = {
  SUPABASE_URL: "https://dnefgcmjcgxlynycxkts.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp",
  SPRINT3_REVIEW_API: "https://fvmwfgrrksyddbcyxwpn.supabase.co/functions/v1/atlas-sprint3-review",
  SPRINT4_BRIEFING_API: "https://fvmwfgrrksyddbcyxwpn.supabase.co/functions/v1/atlas-sprint4-briefing",
};

// Sprint 3 Review Center is branch-scoped and manager-only. The browser keeps
// using the production VÁ Auth session while the API reads/writes only the
// isolated PR branch through a custom-auth Edge Function.
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

// Sprint 4 Phase 1 augments the existing Atlas Brain with a deterministic Daily
// Briefing. The module receives aggregates and evidence metadata only; private
// source rows and service credentials never enter browser code.
(function loadAtlasDailyBriefing() {
  const stylesheetPath = 'assets/css/brain-daily-briefing.css';
  const scriptPath = 'assets/js/brain-daily-briefing.js';

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
