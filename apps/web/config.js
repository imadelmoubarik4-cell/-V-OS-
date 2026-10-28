// VÁ Bar Inventory — connection settings

window.VABAR_CONFIG = {
  MODE: "production",
  SUPABASE_URL: "https://dnefgcmjcgxlynycxkts.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp",
  SPRINT3_REVIEW_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-sprint3-review",
  PHASE3_BRAIN_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-phase3-brain",
  PHASE3_INTELLIGENCE_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-phase3-intelligence",
  OPERATIONS_CHECKPOINT_A_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-operations-checkpoint-a",
  STOCK_COUNTS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-stock-counts",
  TEAM_MESSAGES_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-team-messages",
  MARKETING_WORKSPACE_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-marketing-workspace",
  // Marketing › Media: private photo and video library (signed uploads, 5-minute previews).
  MARKETING_MEDIA_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-marketing-media",
  TEAM_PROFILES_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-team-profiles",
  TEAM_PROFILE_PHOTOS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-team-profile-photos",
  SHIFTS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-shifts",
  KNOWLEDGE_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-knowledge",
  // Knowledge › Training: private video SOPs (signed uploads, short-lived playback),
  // chapters, procedure steps, progress and explicit completion.
  TRAINING_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-training",
  // Bookings: authoritative staff availability + reservation service.
  BOOKINGS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-bookings",
  REPORTS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-reports",
  SYSTEM_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-system",
  SETTINGS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-settings",
  // Settings › Integrations: status and server-side OAuth (connect hop, test, disconnect).
  INTEGRATIONS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-integrations",
  ITEM_MASTER_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-item-master",
  // Accounting (administrators): invoices, receipts and reimbursements; private files, signed links.
  ACCOUNTING_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-accounting",
  // Atlas AI: conversations, approvals and voice. Answers "not configured" until the owner switches it on.
  ATLAS_AI_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-ai",
  // Import processing remains fail-closed until its separate activation gate.
  IMPORT_WORKER_API: "",
  // Device subscriptions are opt-in; server-side push delivery remains disabled.
  NOTIFICATIONS_API: "https://dnefgcmjcgxlynycxkts.supabase.co/functions/v1/atlas-notifications",
  // Sign-in / recovery CAPTCHA (OWNER-GATED, off by default). Empty provider =
  // feature off: no widget renders, no provider script loads, and no captchaToken
  // is ever threaded, so sign-in and password reset behave exactly as today.
  // To turn it on the owner must (1) enable the SAME provider in the Supabase
  // dashboard (Auth › Attack Protection), (2) set AUTH_CAPTCHA_PROVIDER to
  // "hcaptcha" or "turnstile" and AUTH_CAPTCHA_SITE_KEY to that provider's site
  // key, and (3) add the provider's script + frame origins to the netlify CSP
  // (script-src / frame-src). The CSP is intentionally NOT broadened here; it
  // stays locked down until a provider is actually enabled. Supabase Auth's own
  // server-side rate limits remain the real abuse control either way.
  AUTH_CAPTCHA_PROVIDER: "",
  AUTH_CAPTCHA_SITE_KEY: "",
  // KANEL Pricing & Profitability (Finance › Menu Pricing). FEATURE-FLAGGED: the
  // destination only appears when this is true, and only for admin/manager roles.
  // It is a client-side calculation workspace — it never writes to live POS/menu
  // prices, invoices or accounting records. DISABLED (containment): its business
  // inputs were removed from the public files, and it stays off until a
  // manager-authorised server endpoint serves the pricing profile.
  KANEL_PRICING_ENABLED: false,
  // Public (guest) online booking — Reserve a Table / Bóka borð on the public
  // website, backed by the existing Alcedo bookings system. FEATURE-FLAGGED and
  // OFF by default: while false, no public booking endpoint is advertised, no
  // guest booking UI loads, and the staff bookings workspace behaves exactly as
  // today. Turning it on is deliberate and owner-gated — it must not happen until
  // the booking engine corrections, the scoped public API and the website form
  // are complete and verified (KANEL × ALCEDO online-bookings handoff, phased).
  PUBLIC_BOOKING_ENABLED: false,
  // Staff in-app booking notifications (the manager/admin booking inbox in the
  // notification bell). Explicitly enabled for KANEL staff, INDEPENDENT of
  // PUBLIC_BOOKING_ENABLED: this only turns on the staff-facing inbox worker
  // (bookings-notifications.js). While false, the worker is completely inert — it
  // registers nothing, adds no listeners and never calls atlas-bookings — so no
  // page makes an unexpected booking request. S109 and the authenticated staff
  // edge notifications actions are now deployed. This is separate from, and must not be
  // conflated with, activating the public guest-booking website.
  BOOKING_NOTIFICATIONS_ENABLED: true,
  // Optional visible manager/admin inbox refresh. 0 disables timed refreshes;
  // only whole seconds in 30–300 are accepted. Visible managers refresh once
  // per minute; public website activation and its live test remain separate.
  BOOKING_NOTIFICATIONS_REFRESH_SECONDS: 60,
};

// Several Atlas modules add icon placeholders (<i data-lucide>, rendered by the
// ALCEDO icon set in assets/js/alcedo-icons.js) while observing the application
// shell. Rendered SVGs could otherwise retrigger those observers forever.
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

// A stylesheet counts as present when any linked sheet is the same file,
// whatever its ?v= cache key (L26): index.html links every runtime module
// sheet, and a second copy under another key would be appended last and win
// the cascade with stale rules.
function atlasStylesheetPresent(stylesheetPath) {
  const pathOf = (href) => { try { return new URL(href, document.baseURI).pathname; } catch (_) { return String(href).split('?')[0]; } };
  const wanted = pathOf(stylesheetPath);
  return [...document.querySelectorAll('link[rel~="stylesheet"][href]')].some((link) => pathOf(link.getAttribute('href')) === wanted);
}

function loadAtlasAssetOnce({ stylesheetPath, scriptPath, globalName, dataAttribute }) {
  if (stylesheetPath && !atlasStylesheetPresent(stylesheetPath)) {
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
  stylesheetPath: 'assets/css/team-messages.css?v=20261026-redesign',
  scriptPath: 'assets/js/team-messages.js?v=20261026-redesign',
  globalName: 'AtlasTeamMessages',
  dataAttribute: 'atlasTeamMessages',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/team-unread-badge.js?v=20261027-poll',
  globalName: 'AtlasTeamUnreadBadge',
  dataAttribute: 'atlasTeamUnreadBadge',
}));

// S109: KANEL online-booking notifications for managers/admins. A small,
// event-driven (no-poll) worker that feeds the app-wide notification bell from
// the server-side booking inbox; independent of web-push delivery. Loads after
// window load so it never delays startup.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/bookings-notifications.js?v=20261027-audit',
  globalName: 'AtlasBookingsNotifications',
  dataAttribute: 'atlasBookingsNotifications',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/marketing-workspace.css?v=20261026-redesign',
  scriptPath: 'assets/js/marketing-workspace.js?v=20261027-audit',
  globalName: 'AtlasMarketingWorkspace',
  dataAttribute: 'atlasMarketingWorkspace',
}));

// S92 Accounting (administrators only): invoices, receipts, reimbursements
// and the accountant's monthly export, through the atlas-accounting gateway.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/accounting-workspace.js?v=20261026-redesign',
  globalName: 'AtlasAccounting',
  dataAttribute: 'atlasAccounting',
}));

// S94: the composer's shared platform checks (generated from the publisher's
// rules) and the Marketing media library (library, picker and upload queue).
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/marketing-platform-rules.js?v=20261004-s94b',
  globalName: 'AtlasPlatformRules',
  dataAttribute: 'atlasPlatformRules',
}));

loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/marketing-media.js?v=20261026-redesign',
  globalName: 'AtlasMarketingMedia',
  dataAttribute: 'atlasMarketingMedia',
}));

// Checkpoint E loads a compressed, repository-owned Team Profiles bundle. The
// bootstrap uses browser-native gzip decompression, then installs the Atlas CSS
// and JavaScript through Blob URLs without inline eval.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/team-profiles-bootstrap.js?v=20261026-redesign',
  globalName: 'AtlasTeamProfilesBootstrap',
  dataAttribute: 'atlasTeamProfilesBootstrap',
}));

// Checkpoint E.1 layers private profile portraits over the existing directory.
// Photos are resized on-device, then pass through an authenticated server gateway;
// the browser never receives direct Storage credentials or privileged server keys.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/team-profile-photos.css',
  scriptPath: 'assets/js/team-profile-photos.js?v=20261002-s93r',
  globalName: 'AtlasTeamProfilePhotos',
  dataAttribute: 'atlasTeamProfilePhotos',
}));

// Checkpoint F replaces the Shifts placeholder with a private weekly planner,
// availability, time-off, publishing and confirmation workspace.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/shifts-workspace.css?v=20261026-redesign',
  scriptPath: 'assets/js/shifts-workspace.js?v=20261026-redesign',
  globalName: 'AtlasShifts',
  dataAttribute: 'atlasShifts',
}));

// Checkpoint G replaces the Knowledge placeholder with a version-controlled,
// role-aware library. Drafts remain manager-only, while staff receive only
// published versions and their version-specific acknowledgement state.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/knowledge-workspace.css?v=20261026-redesign',
  scriptPath: 'assets/js/knowledge-workspace.js?v=20261026-redesign',
  globalName: 'AtlasKnowledge',
  dataAttribute: 'atlasKnowledge',
}));

// S98: Knowledge › Training. Private video SOPs, chapters, procedure steps, progress
// and explicit completion. Registers the shell view 'training' for #knowledge/training
// and #knowledge/training/<lesson>.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/training-workspace.css?v=20261026-redesign',
  scriptPath: 'assets/js/training-workspace.js?v=20261026-redesign',
  globalName: 'AtlasTraining',
  dataAttribute: 'atlasTraining',
}));

// Bookings: staff day view + manager room/rules configuration.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/bookings-workspace.css?v=20261026-redesign',
  scriptPath: 'assets/js/bookings-workspace.js?v=20261027-audit',
  globalName: 'AtlasBookings',
  dataAttribute: 'atlasBookings',
}));

// KANEL Pricing & Profitability (Finance › Menu Pricing): admin/manager-only,
// feature-flagged. A client-side calculation workspace over the shared pricing
// engine; registers the shell view 'pricing'. Loads only when the flag is on.
if (window.VABAR_CONFIG && window.VABAR_CONFIG.KANEL_PRICING_ENABLED) {
  // The shared, decimal-safe calculation engine (window.KanelPricing). Pure and
  // dependency-free; the workspace waits for it before it renders.
  loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
    scriptPath: 'assets/js/kanel-pricing-engine.js?v=20261028-contain',
    globalName: 'KanelPricing',
    dataAttribute: 'kanelPricingEngine',
  }));
  loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
    stylesheetPath: 'assets/css/finance-pricing-workspace.css?v=20261026-redesign',
    scriptPath: 'assets/js/finance-pricing-workspace.js?v=20261028-contain',
    globalName: 'AtlasFinancePricing',
    dataAttribute: 'atlasFinancePricing',
  }));
}

// Checkpoint H replaces the Reports placeholder with a permission-aware,
// read-only analysis workspace. It pulls live source records through the
// authenticated gateway and labels missing integrations instead of inventing data.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/reports-workspace.css?v=20261026-redesign',
  scriptPath: 'assets/js/reports-workspace.js?v=20261027-audit',
  globalName: 'AtlasReports',
  dataAttribute: 'atlasReports',
}));

// Settings › System health (administrators): read-only application health,
// environments, data freshness, jobs, incidents and recovery references.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  scriptPath: 'assets/js/system-workspace.js?v=20261026-redesign',
  globalName: 'AtlasSystem',
  dataAttribute: 'atlasSystem',
}));

// Checkpoint J replaces the Settings placeholder with a versioned, role-aware
// control centre for venue configuration, operating rules and personal preferences.
loadAtlasAssetsAfterWindowLoad(() => loadAtlasAssetOnce({
  stylesheetPath: 'assets/css/settings-workspace.css?v=20261026-redesign',
  scriptPath: 'assets/js/settings-workspace.js?v=20261027-audit',
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
