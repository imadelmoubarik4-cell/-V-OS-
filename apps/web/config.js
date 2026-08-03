// VÁ Bar Inventory — connection settings

window.VABAR_CONFIG = {
  SUPABASE_URL: "https://dnefgcmjcgxlynycxkts.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp",
  SPRINT3_REVIEW_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-sprint3-review",
  SPRINT4_BRIEFING_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-sprint4-briefing",
  PHASE3_BRAIN_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-phase3-brain",
  OPERATIONS_CHECKPOINT_A_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-operations-checkpoint-a",
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