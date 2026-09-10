import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('apps/web/index.html', 'utf8');
const inventoryCss = readFileSync('apps/web/assets/css/inventory-polish.css', 'utf8');
const homeCss = readFileSync('apps/web/assets/css/home-polish.css', 'utf8');
const recipesCss = readFileSync('apps/web/assets/css/recipes-gallery.css', 'utf8');
const purchasingCss = readFileSync('apps/web/assets/css/purchasing-polish.css', 'utf8');
const shellCss = readFileSync('apps/web/assets/css/atlas-glass.css', 'utf8');
const recipes = readFileSync('apps/web/assets/js/recipes.js', 'utf8');
const scanner = readFileSync('apps/web/assets/js/inventory-scanner.js', 'utf8');
const stockCount = readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8');
const itemMaster = readFileSync('apps/web/assets/js/item-master-workspace.js', 'utf8');
const reportsCss = readFileSync('apps/web/assets/css/reports-workspace.css', 'utf8');
const settingsCss = readFileSync('apps/web/assets/css/settings-workspace.css', 'utf8');
const finalPolishCss = readFileSync('apps/web/assets/css/polish-pass2.css', 'utf8');
const iconSources = [
  app,
  readFileSync('apps/web/assets/js/shifts-workspace.js', 'utf8'),
  readFileSync('apps/web/assets/js/shifts-month-calendar.js', 'utf8'),
  readFileSync('apps/web/assets/js/reports-workspace.js', 'utf8'),
  readFileSync('apps/web/assets/js/system-workspace.js', 'utf8'),
].join('\n');

test('Inventory uses one compact section rail for every approved workspace', () => {
  assert.match(app, /id="inventory-section-header"/);
  for (const section of ['items', 'stock-count', 'item-master', 'movements', 'waste', 'imports']) {
    assert.match(app, new RegExp(`data-inventory-section="${section}"`));
  }
  assert.match(inventoryCss, /\.inventory-workspace-tabs/);
  assert.match(app, /syncInventorySectionHeader\(view\)/);
  assert.match(app, /view === 'inventory' \? 'grid' : 'block'/);
});

test('sidebar keeps one destination per workspace without duplicate category menus', () => {
  assert.match(app, /class="nav-item" data-view="inventory"><i data-lucide="package"><\/i><span>Inventory<\/span><\/button>/);
  assert.match(app, /class="nav-item" data-view="recipes"><i data-lucide="martini"><\/i><span>Recipes<\/span><\/button>/);
  assert.match(app, /class="nav-item" data-view="suppliers"><i data-lucide="truck"><\/i><span>Purchasing<\/span><\/button>/);
  assert.doesNotMatch(app, /<button[^>]+data-default=|<div class="nav-sub"/);
  assert.doesNotMatch(app, /data-recipe-filter="signature-cocktail"/);
  assert.doesNotMatch(app, /class="nav-item" data-view="imports"/);
});

test('navigation is organized into one-row workspace groups', () => {
  for (const group of ['home', 'operations', 'people', 'growth', 'insights', 'system']) assert.match(app, new RegExp(`\\['${group}'`));
  assert.match(app, /team:'Messages','team-profiles':'Team'/);
  assert.match(app, /operations:'Operations Center'/);
  assert.match(app, /brain:'Atlas Brain',business:'Business Intelligence'/);
  assert.match(app, /new MutationObserver/);
  assert.match(app, /button\.setAttribute\('aria-label',label\)/);
  assert.match(app, /updateMenuButtonLabel\(collapsed\)/);
});

test('workspace switching owns visibility, inventory state and scroll reset centrally', () => {
  assert.match(app, /function hideAtlasWorkspaceRoots\(keepView = ''\)/);
  assert.match(app, /'sprint3-review': 'sprint3-review-view', system: 'system-view'/);
  assert.match(app, /restoreAtlasWorkspaceInterior\(view\)/);
  assert.match(app, /window\.scrollTo\(\{ top: 0, left: 0, behavior: 'auto' \}\)/);
  assert.match(app, /document\.body\.dataset\.atlasView = view/);
  assert.match(app, /window\.AtlasStockCounts\?\.close\?\.\(\)/);
  assert.match(app, /window\.AtlasItemMaster\?\.close\?\.\(\)/);
  assert.match(app, /sidebarDestination\.dataset\.atlasBaseViewBound !== 'true' && viewMap\[view\]/);
  assert.match(app, /btn\.dataset\.atlasBaseViewBound = 'true'/);
});

test('shared polish removes duplicate Home metrics and normalizes workspace hierarchy', () => {
  assert.match(finalPolishCss, /#dashboard-view > \.stat-grid/);
  assert.match(finalPolishCss, /body\[data-atlas-view\]:not\(\[data-atlas-view="dashboard"\]\) \.checkpoint-a-home-prompt/);
  assert.match(finalPolishCss, /\.recipe-hero h1,[\s\S]*\.recipe-alpha03-head h1,[\s\S]*\.settings-hero h1/);
  assert.match(finalPolishCss, /\.team-profile-card-media[\s\S]*height: 176px !important/);
  assert.match(recipes, /<h1>Recipe Library<\/h1>/);
});

test('Home uses live values and supports expanded or compact navigation', () => {
  assert.match(app, /id="home-date"/);
  assert.match(app, /data-home-action="stock-count"/);
  assert.match(app, /data-home-action="new-order"/);
  assert.match(app, /id="home-margin">—<\/strong>/);
  assert.doesNotMatch(app, /<strong>8<\/strong><span>Onboarding steps/);
  assert.match(app, /window\.AtlasRecipes\?\.getHomeMetrics/);
  assert.match(recipes, /function getHomeMetrics\(\)/);
  assert.match(homeCss, /#home-focus\.atlas-home-focus/);
  assert.match(app, /home-focus'\)\.style\.display = view === 'dashboard' \? 'grid' : 'none'/);
  assert.match(homeCss, /\.atlas-home-brief-icon \{ grid-column: 1; grid-row: 1/);
  assert.match(shellCss, /body\.atlas-sidebar-collapsed/);
});

test('Recipes and Purchasing use clean, honest in-page controls', () => {
  assert.match(recipesCss, /#recipes-view \.recipe-status-filters \{[^}]*background: transparent/s);
  assert.match(app, /class="purchasing-workspace-tabs"/);
  assert.match(app, /id="purchase-orders-tab" disabled/);
  assert.match(app, /Orders are not enabled in this environment/);
  assert.match(app, /Delivery records are not connected yet/);
  assert.match(app, /id="purchasing-intelligence-title"/);
  assert.match(app, /Spend appears only when a costed restock is recorded/);
  assert.match(purchasingCss, /\.purchasing-intelligence \{[^}]*var\(--atlas-home-accent-soft/s);
});

test('Inventory filters use the approved primary and contextual category model', () => {
  for (const label of [
    'Spirits', 'Wine', 'Beer', 'Mixers', 'Syrups', 'Bitters', 'Fresh Fruit',
    'Fresh Herbs', 'Garnish', 'Bar Ingredients', 'Consumables', 'Bar Equipment', 'Coffee',
  ]) {
    assert.match(app, new RegExp(`'${label.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')}'`));
  }
  assert.match(app, /function inventoryGroup\(item\)/);
  assert.match(app, /function inventorySubcategory\(item/);
  assert.match(app, /\/cider\/\.test\(name\).*?!\/beer\/\.test\(category\)/);
  assert.match(app, /id="subcategory-tabs"/);
  assert.match(app, /result\.set\(label, \(result\.get\(label\) \|\| 0\) \+ 1\)/);
});

test('Inventory insight and table values remain grounded in loaded records', () => {
  assert.match(app, /function renderInventoryIntelligence\(\)/);
  assert.match(app, /items\.filter\(item => item\.par_level/);
  assert.match(app, /item\.cost_price/);
  assert.match(app, /item\.supplier \|\| '—'/);
  assert.match(app, /<th data-commercial-only>Supplier<\/th>/);
  assert.match(app, /<th data-commercial-only class="numeric">Cost<\/th>/);
  assert.doesNotMatch(app, /Flóki Single Malt barely moves|45,000 ISK in stock/);
});

test('scan, add, stock count and Item Master share the Inventory header safely', () => {
  assert.match(scanner, /document\.querySelector\('\.inventory-section-actions'\)/);
  assert.match(stockCount, /const actions = document\.querySelector\('\.inventory-section-actions'\)/);
  assert.match(itemMaster, /document\.body\.classList\.add\('item-master-active'\)/);
  assert.match(itemMaster, /document\.querySelectorAll\('\[data-item-master-l2\]'\)/);
  assert.match(app, /requireCommercialManager\('Direct inventory adjustment'\)/);
  assert.match(app, /requireCommercialManager\('Inventory master editing'\)/);
});

test('Reports and Settings stay inside the shared responsive content rail', () => {
  assert.match(reportsCss, /#reports-view,[\s\S]*\.reports-shell[\s\S]*overflow-x: clip/);
  assert.match(reportsCss, /\.reports-layout > \*/);
  assert.match(settingsCss, /\.settings-tabs\{display:flex;flex-wrap:wrap;gap:5px;overflow-x:visible/);
  assert.match(settingsCss, /@media\(max-width:680px\)[\s\S]*\.settings-tabs\{[^}]*flex-wrap:nowrap;overflow-x:auto/);
});

test('all audited Lucide placeholders use icons included in the pinned runtime', () => {
  assert.doesNotMatch(iconSources, /calendar-off-2|database-off/);
  assert.match(iconSources, /data-lucide="calendar-days"/);
  assert.match(iconSources, /data-lucide="database"/);
});
