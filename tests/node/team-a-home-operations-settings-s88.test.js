// S88 Team A: Home (command centre), Operations (server checklists), Settings
// (incl. System health, Atlas AI settings and integrations) and the retired
// Brain. Replaces the S87-era source tests for brain-daily-briefing-v2.js,
// brain-phase3.js, brain-checkpoint-k.js, operations-checkpoint-a(-layout).js
// and settings-mount-bridge.js, which no longer ship.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(path, 'utf8');
const config = read('apps/web/config.js');
const index = read('apps/web/index.html');
const home = read('apps/web/assets/js/home.js');
const operations = read('apps/web/assets/js/operations.js');
const settings = read('apps/web/assets/js/settings-workspace.js');
const system = read('apps/web/assets/js/system-workspace.js');
const homeCss = read('apps/web/assets/css/home.css');
const operationsCss = read('apps/web/assets/css/operations.css');
const settingsCss = read('apps/web/assets/css/settings-workspace.css');

const RETIRED = [
  'apps/web/assets/js/brain.js', 'apps/web/assets/js/brain-daily-briefing-v2.js', 'apps/web/assets/js/brain-phase3.js',
  'apps/web/assets/js/brain-checkpoint-k.js', 'apps/web/assets/js/operations-checkpoint-a.js',
  'apps/web/assets/js/operations-checkpoint-a-layout.js', 'apps/web/assets/js/settings-mount-bridge.js',
  'apps/web/assets/css/brain.css', 'apps/web/assets/css/brain-daily-briefing.css', 'apps/web/assets/css/brain-phase3.css',
  'apps/web/assets/css/brain-checkpoint-k.css', 'apps/web/assets/css/operations-checkpoint-a.css',
  'apps/web/assets/css/operations-checkpoint-a-layout.css', 'apps/web/assets/css/system-workspace.css'
];

test('the Brain page and the Checkpoint A/K layers are retired and unreferenced', () => {
  for (const file of RETIRED) {
    assert.ok(!existsSync(file), `${file} is deleted`);
    const name = file.split('/').pop();
    assert.ok(!index.includes(name), `index.html no longer links ${name}`);
    assert.ok(!config.includes(name), `config.js no longer loads ${name}`);
  }
  assert.doesNotMatch(index, /brain-view|brain-shell|data-view="brain"|data-view="system"/);
  // The endpoints stay: Decisions (Atlas AI) reads PHASE3_BRAIN_API. Home runs
  // the one intelligence producer (Atlas AI background signals, architecture
  // §12a) once per manager session; it no longer triggers the Checkpoint K
  // refresh, which wrote a second set of recommendations for the same signals.
  for (const name of ['PHASE3_BRAIN_API', 'PHASE3_INTELLIGENCE_API', 'SPRINT4_BRIEFING_API', 'OPERATIONS_CHECKPOINT_A_API']) {
    assert.match(config, new RegExp(`${name}: "https://dnefgcmjcgxlynycxkts\\.supabase\\.co/functions/v1/`));
  }
  assert.doesNotMatch(home, /PHASE3_INTELLIGENCE_API/);
  assert.match(home, /ATLAS_AI_API/);
  assert.match(home, /searchParams\.set\('action', 'refresh-signals'\)/);
  assert.match(home, /if \(state\.intelligenceRequested \|\| !isManager\(\)\) return;/);
  // Team Messages links to Brain recommendations open Atlas AI › Decisions.
  assert.match(home, /links\?\.register\?\.\('brain_recommendation', \(\) => \{ atlas\.navigate\('#ai\/decisions'\)/);
  assert.match(operations, /links\?\.register\?\.\('routine'/);
  assert.doesNotMatch(config, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('Home is the command centre: attention rows, venue clock, briefing entry, no KPI dump', () => {
  assert.match(index, /<div id="dashboard-view" style="display:none;"><\/div>/);
  assert.match(index, /<script src="assets\/js\/home\.js\?v=20260926-s88"><\/script>/);
  assert.match(home, /atlas\.registerHomeSection\('home', render, 0\)/);
  assert.match(home, /shell\(\)\?\.home\?\.rows\?\.\(\{ role: role\(\) \}\)/);
  assert.match(home, /const VISIBLE_ROWS = 5;/);
  assert.match(home, /Nothing needs you right now/);
  assert.match(home, /window\.AtlasAI\.askAbout\(\{ type: 'briefing', id: date, label: 'Today’s briefing' \}\)/);
  assert.match(home, /Opening hours aren’t set/);
  assert.match(home, /venue\.nextEvent\(now, \{ types: \['closes'\] \}\)/);
  // Viewers see the attention rows only (spec §3.3, §11 decision 4).
  assert.match(home, /\$\{viewer \? '' : `<div class="home-grid">/);
  assert.match(home, /function briefingMarkup\(\) \{\s+if \(isViewer\(\)\) return '';/);
  // No bookings, events, weather or sales without a source (spec §11 decision 8).
  assert.doesNotMatch(home, /booked|bookings\b|weather|quiz/i);
  // Design rules: no gradients, uppercase eyebrows or !important in the module sheet.
  for (const css of [homeCss, operationsCss, settingsCss]) {
    assert.match(css.replace(/\/\*[\s\S]*?\*\//g, '').trim(), /^@layer atlas\.modules \{[\s\S]*\}$/);
    assert.doesNotMatch(css, /!important|gradient|text-transform:\s*uppercase|:root/);
  }
});

test('Operations is one server-backed implementation with no device checklist', () => {
  assert.doesNotMatch(operations, /CHECKLISTS\s*=|checklistStorageKey|saved on this device|Reset today|setItem\(/);
  assert.doesNotMatch(operations, /localStorage\.setItem|store\.setItem/);
  assert.match(operations, /write\('set-item', \{/);
  assert.match(operations, /api\('daily-checklists'\)/);
  assert.match(operations, /write\('complete-routine'/);
  assert.match(operations, /write\('log-temperature'/);
  assert.match(operations, /write\('update-template'/);
  assert.match(operations, /write\('update-temperature-point'/);
  // Old device ticks are never imported silently: only "Tick them as me", then discarded.
  assert.match(operations, /const IMPORT_EVIDENCE = \{ source: 'device_checklist_import_s88' \};/);
  assert.match(operations, /Tick them as me/);
  assert.match(operations, /store\.removeItem\(key\)/);
  // Readiness moved to Home; suggested purchasing to Purchasing.
  assert.doesNotMatch(operations, /Service readiness|Suggested purchasing|Operations Intelligence|Tripadvisor/);
  // Public API kept for Purchasing, Search, Atlas AI and Reports.
  assert.match(operations, /window\.AtlasOperations = \{[\s\S]*orderSuggestions,[\s\S]*readinessData,/);
  assert.doesNotMatch(operations, /(?:atlasSupabase|\bsb|\bclient)\.from\s*\(/);
  assert.match(operations, /checklist_day_closed/);
});

function loadOperations(storageEntries = {}) {
  const store = new Map(Object.entries(storageEntries));
  const localStorage = {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };
  const context = { Date, Number, Math, Map, Set, String, Array, Object, JSON, console, URL, localStorage, document: { readyState: 'loading', addEventListener() {} } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(operations, context);
  return { context, store };
}

test('readiness applies no checklist penalty while the server checklist is unknown', () => {
  const { context } = loadOperations();
  const readiness = context.AtlasOperations.readinessData();
  assert.equal(readiness.opening, null);
  assert.equal(readiness.score, 100);
});

test('Settings has the spec sections, per-form save bars and truthful integrations', () => {
  for (const key of ['venue', 'hours', 'team-access', 'notifications', 'rules', 'ai', 'integrations', 'security', 'system', 'preferences', 'activity']) {
    assert.match(settings, new RegExp(`key: '${key}'`));
  }
  assert.match(settings, /Unsaved changes/);
  assert.match(settings, /data-settings-savebar/);
  // Offer drafts start empty: hours come from the manager, never 15:00–18:00.
  assert.match(settings, /start_time: '', end_time: ''/);
  // Time zone errors from the server appear under the field, in fixed words.
  assert.match(settings, /isn’t a time zone Atlas recognises/);
  // Atlas AI settings render from the actual response, incl. the S88 limits.
  for (const key of ['voice_sessions_per_day', 'voice_minutes_per_day', 'max_concurrent_voice_sessions', 'upload_bytes_per_day', 'upload_files_per_day']) {
    assert.match(settings, new RegExp(`key: '${key}'`));
  }
  assert.match(settings, /AI_FIELDS\.filter\(\(entry\) => Object\.prototype\.hasOwnProperty\.call\(value, entry\.key\)\)/);
  assert.match(settings, /aiApi\('settings', \{ method: 'POST', body: \{ patch \} \}\)/);
  // Integrations: server-side OAuth hop, error codes, callback handled once.
  assert.match(config, /INTEGRATIONS_API: "https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-integrations"/);
  assert.match(settings, /window\.location\.assign\(payload\.authorize_url\)/);
  assert.match(settings, /return_path: '#settings\/integrations'/);
  for (const code of ['browser_mismatch', 'not_authorized', 'provider_check_failed', 'provider_refresh_failed', 'credential_unreadable']) {
    assert.match(settings, new RegExp(`case '${code}':`));
  }
  assert.match(settings, /\['integration', 'result', 'reason'\]\.forEach\(\(key\) => params\.delete\(key\)\)/);
  assert.match(settings, /window\.history\.replaceState/);
  // Server text only classifies errors (409, time zone); it is never rendered.
  assert.doesNotMatch(settings, /\$\{[^}]*(?:serverText|payload\.error|error\.message)|textContent = [^;]*(?:serverText|error\.message)/, 'server text is never shown');
  // System health is a Settings section (administrators).
  assert.match(settings, /\{ key: 'system', label: 'System health', icon: 'activity', roles: \['admin'\] \}/);
  assert.match(settings, /window\.AtlasSystem\?\.mount\?\./);
});

test('System health is read only and says "Not checked yet" instead of Unknown', () => {
  assert.match(system, /window\.AtlasSystem = \{\s+mount,/);
  assert.doesNotMatch(system, /registerView|method:\s*['"]POST['"]|Checkpoint|'Unknown'/);
  assert.match(system, /Not checked yet/);
  assert.match(system, /Retry controls are disabled/);
  assert.match(system, /Rollback unavailable/);
  assert.match(system, /Passwords, keys and sign-in secrets are never shown here/);
});

test('the notifications feed carries one item per conversation with unread messages', () => {
  const chrome = read('apps/web/assets/js/atlas-chrome.js');
  assert.doesNotMatch(chrome, /contribute\('messages-unread'/);
  const context = { Date, Number, Math, Map, Set, String, Array, Object, JSON, console, document: { readyState: 'loading', addEventListener() {} } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(home, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.AtlasHome.messageItems())), []);
});
