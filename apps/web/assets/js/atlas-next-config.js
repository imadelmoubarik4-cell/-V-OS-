// Atlas replacement route — existing production and private gateway endpoints.
// This file intentionally contains no asset loader and no privileged credential.
window.VABAR_CONFIG = Object.freeze({
  SUPABASE_URL: 'https://dnefgcmjcgxlynycxkts.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp',
  SPRINT3_REVIEW_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-sprint3-review',
  SPRINT4_BRIEFING_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-sprint4-briefing',
  PHASE3_BRAIN_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-phase3-brain',
  PHASE3_INTELLIGENCE_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-phase3-intelligence',
  OPERATIONS_CHECKPOINT_A_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-operations-checkpoint-a',
  INVENTORY_SCANNER_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-inventory-scanner',
  STOCK_COUNTS_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-stock-counts',
  ITEM_MASTER_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-item-master',
  TEAM_MESSAGES_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-team-messages',
  MARKETING_WORKSPACE_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-marketing-workspace',
  TEAM_PROFILES_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-team-profiles',
  TEAM_PROFILE_PHOTOS_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-team-profile-photos',
  SHIFTS_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-shifts',
  KNOWLEDGE_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-knowledge',
  REPORTS_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-reports',
  SYSTEM_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-system',
  SETTINGS_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-settings',
  CONNECTIONS_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-connections',
  READ_SOURCES_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-read-sources',
  POS_MAPPING_API: 'https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-pos-mapping',
});

(() => {
  const install = () => {
    const lucide = window.lucide;
    if (!lucide || typeof lucide.createIcons !== 'function') return false;
    if (lucide.createIcons.__atlasStabilityGuard) return true;
    const original = lucide.createIcons.bind(lucide);
    let rendering = false;
    const guarded = function guardedCreateIcons(options) {
      if (rendering) return undefined;
      if (!document.querySelector('i[data-lucide], span[data-lucide]')) return undefined;
      rendering = true;
      try { return original(options); }
      finally { rendering = false; }
    };
    guarded.__atlasStabilityGuard = true;
    guarded.__atlasOriginal = original;
    lucide.createIcons = guarded;
    return true;
  };
  if (install()) return;
  let attempts = 0;
  const retry = () => {
    attempts += 1;
    if (install() || attempts >= 100) return;
    window.setTimeout(retry, 50);
  };
  retry();
})();
