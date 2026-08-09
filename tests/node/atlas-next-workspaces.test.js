import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const html = read('apps/web/next.html');
const runtime = read('apps/web/assets/js/atlas-next.js');
const config = read('apps/web/assets/js/atlas-next-config.js');
const bridge = read('apps/web/assets/js/atlas-next-workspaces.js');
const purchasing = read('apps/web/assets/js/atlas-next-purchasing.js');
const unread = read('apps/web/assets/js/team-unread-badge.js');
const workspacesCss = read('apps/web/assets/css/atlas-next-workspaces.css');

const connectedScripts = [
  'inventory-scanner.js',
  'item-master-workspace.js',
  'recipes.js',
  'import-center.js',
  'sprint3-review.js',
  'operations-checkpoint-a.js',
  'operations-checkpoint-a-layout.js',
  'team-messages.js',
  'team-unread-badge.js',
  'marketing-workspace.js',
  'team-profiles.source.js',
  'team-profile-photos.js',
  'shifts-workspace.js',
  'shifts-month-calendar.js',
  'knowledge-workspace.js',
  'read-sources-p22.js',
  'reports-workspace.js',
  'pos-mapping-checkpoint-m.js',
  'system-workspace.js',
  'settings-workspace.js',
  'connection-center.js',
  'brain.js',
  'brain-daily-briefing-v2.js',
  'brain-phase3.js',
  'brain-checkpoint-k.js',
  'business.js',
];

const endpointKeys = [
  'SPRINT3_REVIEW_API', 'SPRINT4_BRIEFING_API', 'PHASE3_BRAIN_API',
  'PHASE3_INTELLIGENCE_API', 'OPERATIONS_CHECKPOINT_A_API',
  'INVENTORY_SCANNER_API', 'STOCK_COUNTS_API', 'ITEM_MASTER_API',
  'TEAM_MESSAGES_API', 'MARKETING_WORKSPACE_API', 'TEAM_PROFILES_API',
  'TEAM_PROFILE_PHOTOS_API', 'SHIFTS_API', 'KNOWLEDGE_API', 'REPORTS_API',
  'SYSTEM_API', 'SETTINGS_API', 'CONNECTIONS_API', 'READ_SOURCES_API',
  'POS_MAPPING_API',
];

test('all existing Atlas workflows load into one replacement shell', () => {
  assert.equal((html.match(/id="auth-screen"/g) || []).length, 1);
  assert.equal((html.match(/id="app-shell"/g) || []).length, 1);
  assert.equal((html.match(/data-view-panel="connected"/g) || []).length, 1);
  for (const script of connectedScripts) {
    assert.match(html, new RegExp(`assets/js/${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `Missing ${script}`);
  }
  assert.doesNotMatch(html, /support\.js|<x-dc|@babel|react(?:-dom)?/i);
});

test('the connected route exposes every approved workspace and service entry point', () => {
  for (const view of [
    'operations', 'inventory', 'recipes', 'purchasing', 'imports', 'review',
    'marketing', 'messages', 'team', 'shifts', 'knowledge', 'brain',
    'business', 'reports', 'settings', 'system',
  ]) {
    assert.match(html, new RegExp(`data-view="${view}"`), `Missing route ${view}`);
    assert.match(runtime, new RegExp(`${view}:`), `Runtime does not title ${view}`);
  }
  assert.match(html, /data-service-action="count"/);
  assert.match(html, /data-service-action="scan"/);
  assert.match(html, /data-service-view="operations"/);
  assert.match(html, /data-service-view="recipes"/);
  assert.match(html, /data-service-view="knowledge"/);
});

test('every private workflow endpoint stays on the approved Atlas gateway host', () => {
  for (const key of endpointKeys) {
    assert.match(config, new RegExp(`${key}:\\s*'https://uhbamqetppqmygesoeeh\\.supabase\\.co/functions/v1/atlas-`), `Missing approved ${key}`);
  }
  assert.doesNotMatch(config, /SUPABASE_SERVICE_ROLE_KEY|sb_secret_|service_role\s*[:=]/i);
  assert.doesNotMatch(bridge + purchasing, /atlas_private\s*\.|SUPABASE_SERVICE_ROLE_KEY|sb_secret_/i);
});

test('the bridge preserves one authenticated client and role-aware shared data', () => {
  assert.match(runtime, /window\.atlasSupabase\s*=\s*client/);
  assert.match(runtime, /window\.AtlasData\?\.configure\?\.\(client\)/);
  assert.match(runtime, /inventory_catalog/);
  assert.match(runtime, /inventory_items/);
  assert.match(runtime, /AtlasData\.getRecipes/);
  assert.match(runtime, /AtlasData\.getSuppliers/);
  assert.match(runtime, /AtlasData\.getInventoryMovements/);
  assert.match(runtime, /new CustomEvent\('atlas:auth'/);
  assert.match(runtime, /new CustomEvent\('atlas:data'/);
  assert.match(runtime, /new CustomEvent\('atlas:navigate'/);
  assert.match(bridge, /window\.atlasSupabase\s*=\s*sb/);
  assert.match(bridge, /window\.currentUser\s*=\s*currentUser/);
});

test('ordinary inventory remains read-only while scanner, L1 and L2 use controlled workflows', () => {
  const inventorySection = html.match(/<section class="view" id="view-inventory"[\s\S]*?<\/section>\s*<section class="view" id="view-connected"/)?.[0] || '';
  assert.doesNotMatch(inventorySection, /data-quantity|quantity-step|adjust_inventory|type="number"/i);
  assert.match(bridge, /AtlasInventoryScanner\?\.open/);
  assert.match(bridge, /AtlasNextStockCounts\?\.open/);
  assert.match(bridge, /AtlasItemMaster\?\.open/);
  assert.match(bridge, /data-atlas-inventory-section="item-master"/);
});

test('purchasing suggestions are exact and cannot submit supplier orders', () => {
  assert.match(purchasing, /Math\.max\(par\s*-\s*current,\s*0\)/);
  assert.match(purchasing, /submissionEnabled:\s*false/);
  assert.match(purchasing, /No supplier order was submitted/);
  assert.match(purchasing, /AtlasData\.adjustInventory/);
  assert.match(purchasing, /AtlasData\.createSupplier/);
  assert.doesNotMatch(purchasing, /purchase\.submit|supplier-order|submit-order|sendOrder|orders\.write/i);
});

test('operations, recipes and import compatibility is explicit rather than simulated', () => {
  assert.match(bridge, /window\.AtlasOperations/);
  assert.match(bridge, /Math\.max\(par\s*-\s*quantity,\s*0\)/);
  assert.match(config, /data-atlas-modal/);
  assert.match(config, /import-queue-upload-button/);
  assert.match(config, /\['ready', 'Ready for review'\]/);
  assert.match(html, /id="operations-center"/);
  assert.match(html, /id="recipe-overlay"/);
  assert.match(html, /id="import-queue-rows"/);
});

test('connected notifications target the visible replacement shell', () => {
  assert.match(unread, /#sidebar-nav \.nav-item\[data-view="messages"\]/);
  assert.match(unread, /id = 'notifications-open'/);
  assert.match(unread, /AtlasNext\?\.navigate\?\.\('messages'\)/);
  assert.doesNotMatch(html, /title="Notifications"[^>]*disabled/);
});

test('new classic browser scripts are syntactically valid', () => {
  for (const [path, source] of [
    ['atlas-next-config.js', config],
    ['atlas-next.js', runtime],
    ['atlas-next-workspaces.js', bridge],
    ['atlas-next-purchasing.js', purchasing],
    ['team-unread-badge.js', unread],
  ]) {
    assert.doesNotThrow(() => new Function(source), `${path} must parse`);
  }
  assert.match(workspacesCss, /connected-workspace-region/);
  assert.match(workspacesCss, /atlas-purchasing/);
  assert.match(workspacesCss, /@media \(max-width: 560px\)/);
});
