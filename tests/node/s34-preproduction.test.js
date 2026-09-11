import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const app = read('apps/web/index.html');
const config = read('apps/web/config.js');
const runtime = read('apps/web/assets/js/runtime-module-guard.js');
const design = read('apps/web/assets/css/s34-preproduction.css');
const messages = read('apps/web/assets/js/team-messages.js');
const messageApi = read('supabase/functions/atlas-team-messages/index.ts');
const shiftsApi = read('supabase/functions/atlas-shifts/index.ts');
const notifications = read('apps/web/assets/js/notifications.js');
const worker = read('apps/web/service-worker.js');
const notificationApi = read('supabase/functions/atlas-notifications/index.ts');
const notificationMigration = read('supabase/migrations/20260911124039_s34_notification_and_conversation_stars.sql');
const indexMigration = read('supabase/migrations/20260911124006_s34_foreign_key_indexes.sql');

test('runtime module guard preserves Team destinations when runtime config is reduced', () => {
  assert.match(app, /assets\/js\/runtime-module-guard\.js/);
  for (const asset of ['team-messages.js', 'team-profiles-bootstrap.js', 'team-profile-photos.js', 'team-profile-photo-gallery.js']) {
    assert.match(runtime, new RegExp(asset.replaceAll('.', '\\.')));
  }
  assert.match(runtime, /Object\.freeze/);
  assert.match(runtime, /dataset\.atlasStandalone/);
  assert.doesNotMatch(runtime, /TEAM_MESSAGES_API|TEAM_PROFILES_API/);
});

test('inventory, purchasing, and close-control regressions stay wired', () => {
  assert.match(app, /await loadAll\(\);/);
  assert.match(app, /item\?\.subcategory/);
  assert.match(app, /id="purchase-deliveries-tab"/);
  const purchasing = read('apps/web/assets/js/purchase-orders.js');
  assert.match(purchasing, /openSection\('orders'\)/);
  assert.match(purchasing, /openSection\('deliveries'\)/);
  for (const source of [
    read('apps/web/assets/js/recipes.js'),
    read('apps/web/assets/js/stock-count-workspace.js'),
    read('apps/web/assets/js/shifts-workspace.js'),
    read('apps/web/assets/js/knowledge-workspace.js')
  ]) assert.match(source, /data-[a-z-]*close|data-close-[a-z-]+/);
});

test('one calculation rule gives saved and refetched fixture values', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('apps/web/assets/js/atlas-calculations.js'), sandbox);
  const calculator = sandbox.window.AtlasCalculations;
  const inventory = [{ id: 'item-1', quantity: 10, unit: 'bottles', cost_price: 100, par_level: 2 }];
  const recipe = {
    menu_price: 500,
    yield_quantity: 1,
    recipe_ingredients: [{ item_id: 'item-1', quantity: 2, unit: 'bottle' }]
  };
  const saved = calculator.recipeMetrics(recipe, inventory);
  const refetched = calculator.recipeMetrics(JSON.parse(JSON.stringify(recipe)), JSON.parse(JSON.stringify(inventory)));
  assert.equal(saved.availability.servings, 5);
  assert.equal(saved.financials.perServing, 200);
  assert.equal(saved.financials.profit, 300);
  assert.equal(saved.financials.margin, 60);
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), JSON.parse(JSON.stringify(refetched)));
  assert.equal(calculator.formatIsk(saved.financials.perServing), '200 ISK');
});

test('Recipes, Brain, and Business Intelligence delegate to the shared calculation rule', () => {
  for (const source of [read('apps/web/assets/js/recipes.js'), read('apps/web/assets/js/brain.js'), read('apps/web/assets/js/business.js')]) {
    assert.match(source, /AtlasCalculations/);
  }
  assert.match(app, /assets\/js\/atlas-calculations\.js/);
  const reportsSql = read('supabase/s33/migrations/20260910205055_atlas_s33_runtime_delta.sql');
  assert.match(reportsSql, /ingredient\.item_stock\*ingredient\.pack_quantity\/ingredient\.ingredient_base_quantity/);
  assert.match(reportsSql, /batch_cost\/yield_quantity/);
  assert.match(reportsSql, /\(\(menu_price-\(batch_cost\/yield_quantity\)\)\/menu_price\)\*100/);
});

test('shared launch design uses blue actions, compact search, visible focus, and reduced motion', () => {
  assert.match(design, /--atlas-action:#2d78dc/);
  assert.match(design, /:focus-visible/);
  assert.match(design, /input\[type="search"\]/);
  assert.match(design, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(design, /#home-focus::after/);
  assert.match(app, /assets\/css\/s34-preproduction\.css/);
});

test('conversation stars persist through the private gateway', () => {
  assert.match(messages, /data-team-star/);
  assert.match(messages, /api\('star'/);
  assert.match(messageApi, /atlas_team_conversation_star_set/);
  assert.match(notificationMigration, /create table if not exists atlas_private\.team_conversation_stars/);
  assert.match(notificationMigration, /enable row level security/);
  assert.match(notificationMigration, /revoke all on atlas_private\.team_conversation_stars from public, anon, authenticated/);
});

test('push opt-in covers unsupported, denied, pending, and enabled states', () => {
  for (const value of ['unsupported', 'denied', 'pending', 'enabled']) assert.match(notifications, new RegExp(`'${value}'`));
  assert.match(notifications, /Notification\.requestPermission\(\)/);
  assert.match(notifications, /pushManager\.subscribe/);
  assert.match(worker, /addEventListener\('push'/);
  assert.match(worker, /addEventListener\('notificationclick'/);
  assert.match(worker, /route === 'shifts' \? 'shifts' : 'team'/);
  assert.match(notificationApi, /ATLAS_PUSH_DELIVERY_ENABLED/);
  assert.match(notificationApi, /delivery: "disabled"/);
  assert.match(notificationApi, /npm:web-push@3\.6\.7/);
  assert.match(config, /NOTIFICATIONS_API:\s*""/);
  assert.doesNotMatch(read('supabase/config.toml'), /\[functions\.atlas-notifications\]/);
});

test('Team Messages and published shifts enqueue only scoped notification events', () => {
  assert.match(messageApi, /p_event_type: "team_message"/);
  assert.match(shiftsApi, /p_event_type: "shift_update"/);
  assert.match(shiftsApi, /action === "publish-week"/);
  assert.match(shiftsApi, /action === "publish-month"/);
  assert.match(notificationMigration, /event_type in \('team_message','shift_update'\)/);
  assert.match(notificationMigration, /route in \('team','shifts'\)/);
});

test('performance candidate contains exactly the reviewed 12 indexes and no broad DDL', () => {
  const indexes = [...indexMigration.matchAll(/create index if not exists\s+\w+\s+on\s+([\w.]+)\s*\((\w+)\)/gi)]
    .map((match) => `${match[1]}.${match[2]}`);
  assert.deepEqual(indexes, [
    'atlas_private.inventory_count_events.line_id',
    'atlas_private.inventory_count_publication_lines.count_line_id',
    'atlas_private.inventory_count_publication_lines.session_id',
    'atlas_private.inventory_verified_balances.source_line_id',
    'atlas_private.inventory_verified_balances.source_session_id',
    'atlas_private.report_events.actor_id',
    'atlas_private.routine_item_results.template_item_id',
    'public.atlas_media.uploaded_by',
    'public.inventory_movements.created_by',
    'public.inventory_movements.supplier_id',
    'public.onboarding_progress.completed_by',
    'public.recipes.updated_by'
  ]);
  assert.match(indexMigration, /set lock_timeout = '5s'/);
  assert.match(indexMigration, /set statement_timeout = '2min'/);
  assert.doesNotMatch(indexMigration, /\b(drop|alter|delete|update|insert|grant|revoke|create\s+(table|function|trigger|policy))\b/i);
});

test('the complete page mapping and network-free after-state fixture remain reviewable', () => {
  const checklist = read('docs/release/Atlas_S34_Launch_Fix_Checklist.md');
  for (let page = 1; page <= 15; page += 1) assert.match(checklist, new RegExp(`\\| ${page} \\|`));
  assert.match(checklist, /real staff name/);
  const fixture = read('tests/fixtures/s34-visual-review.html');
  for (const moduleName of ['home', 'operations', 'inventory', 'stock', 'recipes', 'purchasing', 'messages', 'team', 'shifts', 'knowledge', 'brain', 'settings']) {
    assert.match(fixture, new RegExp(`${moduleName}: \\[`));
  }
  assert.match(fixture, /mode.*mobile/);
  assert.doesNotMatch(fixture, /https?:|fetch\(|supabase/i);
});
