import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { legacyCss, linkPosition, layerOf } from './helpers/legacy-css.js';

const app = readFileSync('apps/web/index.html', 'utf8');
const inventoryCss = legacyCss('inventory-polish');
const homeCss = legacyCss('home-polish');
const recipesCss = legacyCss('recipes-gallery');
const purchasingCss = legacyCss('purchasing-polish');
const shellCss = readFileSync('apps/web/assets/css/atlas-shell.css', 'utf8');
const shellJs = readFileSync('apps/web/assets/js/atlas-shell.js', 'utf8');
const chrome = readFileSync('apps/web/assets/js/atlas-chrome.js', 'utf8');
const recipes = readFileSync('apps/web/assets/js/recipes.js', 'utf8');
const scanner = readFileSync('apps/web/assets/js/inventory-scanner.js', 'utf8');
const stockCount = readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8');
const itemMaster = readFileSync('apps/web/assets/js/item-master-workspace.js', 'utf8');
const reportsCss = readFileSync('apps/web/assets/css/reports-workspace.css', 'utf8');
const settingsCss = readFileSync('apps/web/assets/css/settings-workspace.css', 'utf8');
const finalPolishCss = legacyCss('polish-pass2');
const iconSources = [
  app,
  readFileSync('apps/web/assets/js/shifts-workspace.js', 'utf8'),
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
  // S88: Inventory registers with AtlasShell as a grid-displayed view.
  assert.match(app, /\['inventory', \{ display: 'grid'/);
  assert.match(app, /if \(root\) root\.style\.display = entry\.display;/);
});

test('sidebar keeps one destination per workspace without duplicate category menus', () => {
  // S88 redesign (spec §3.1, §4.2): real links, one per destination, keeping
  // the .atlas-nav .nav-item[data-view] contract the harness and modules use.
  assert.match(app, /<a class="nav-item" href="#inventory" data-view="inventory" data-nav-id="inventory" aria-label="Inventory"><i data-lucide="package" aria-hidden="true"><\/i><span class="nav-item-label">Inventory<\/span><\/a>/);
  assert.match(app, /<a class="nav-item" href="#recipes" data-view="recipes" data-nav-id="recipes" aria-label="Recipes"><i data-lucide="martini" aria-hidden="true"><\/i><span class="nav-item-label">Recipes<\/span><\/a>/);
  assert.match(app, /<a class="nav-item" href="#purchasing" data-view="suppliers" data-nav-id="purchasing" aria-label="Purchasing" hidden><i data-lucide="truck" aria-hidden="true"><\/i><span class="nav-item-label">Purchasing<\/span><\/a>/);
  assert.doesNotMatch(app, /<button[^>]+data-default=|<div class="nav-sub"/);
  assert.doesNotMatch(app, /data-recipe-filter="signature-cocktail"/);
  // Retired destinations keep a hidden link only (their modules find it and inject nothing).
  assert.match(app, /<div class="atlas-nav__retired" hidden data-sprint3-review-nav="true">/);
});

test('navigation is organized into the spec groups: Home/Atlas AI/Messages, Venue, People, Business', () => {
  for (const group of ['main', 'venue', 'people', 'business']) assert.match(app, new RegExp(`data-nav-group="${group}"`));
  for (const label of ['Venue', 'People', 'Business']) assert.match(app, new RegExp(`<div class="nav-label" role="presentation">${label}</div>`));
  assert.match(shellJs, /const NAV_GROUPS = Object\.freeze\(\[null, 'Venue', 'People', 'Business'\]\);/);
  // Role visibility comes from one model (AtlasShell.nav), not per-module CSS.
  assert.match(chrome, /link\.hidden = !shell\.nav\.allowed\(link\.dataset\.navId, current\);/);
  assert.doesNotMatch(app, /navigationObserver|organizeAtlasNavigation|scheduleNavigationLayout/);
  assert.match(chrome, /toggle\.setAttribute\('aria-label', overlay \? \(open \? 'Close navigation' : 'Open navigation'\) : \(open \? 'Collapse sidebar' : 'Expand sidebar'\)\);/);
});

test('workspace switching owns visibility, inventory state and scroll reset centrally', () => {
  assert.match(app, /function hideAtlasWorkspaceRoots\(keepView = ''\)/);
  assert.match(app, /'sprint3-review': 'sprint3-review-view', system: 'system-view'/);
  assert.match(app, /restoreAtlasWorkspaceInterior\(view\)/);
  assert.match(app, /window\.scrollTo\(\{ top: 0, left: 0, behavior: 'auto' \}\)/);
  assert.match(app, /document\.body\.dataset\.atlasView = view/);
  assert.match(app, /window\.AtlasStockCounts\?\.close\?\.\(\)/);
  assert.match(app, /window\.AtlasItemMaster\?\.close\?\.\(\)/);
  // S88: one navigation path. AtlasShell routes every sidebar click once and
  // the base shell's chrome is its layout hook; no per-button double binding.
  assert.match(app, /window\.AtlasShell\.setLayout\(layoutAtlasView\)/);
  assert.match(app, /function layoutAtlasView\(view, entry, context\)/);
  assert.match(app, /if \(context\.source === 'nav' \|\| view !== 'inventory'\)/);
  assert.doesNotMatch(app, /atlasBaseViewBound/);
});

test('shared polish removes duplicate Home metrics and normalizes workspace hierarchy', () => {
  assert.match(finalPolishCss, /#dashboard-view > \.stat-grid/);
  assert.match(finalPolishCss, /body\[data-atlas-view\]:not\(\[data-atlas-view="dashboard"\]\) \.checkpoint-a-home-prompt/);
  // S88: the workspace page-title normalization is part of atlas-components.css.
  assert.match(readFileSync('apps/web/assets/css/atlas-components.css', 'utf8'), /\.recipe-hero h1,[\s\S]*\.recipe-alpha03-head h1,[\s\S]*\.settings-hero h1/);
  // S88: Team was rebuilt on the shared table; its retired card grid rules are gone.
  assert.doesNotMatch(finalPolishCss, /\.team-profile-card-media/);
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
  assert.doesNotMatch(app, /id="home-focus"/);
  assert.doesNotMatch(app, /home-focus'\)\.style\.display/);
  // Expanded sidebar (240) or the 64 px rail, per viewer (spec §4.1).
  assert.match(shellCss, /body\.atlas-rail \.atlas-shell \{ grid-template-columns: 64px minmax\(0, 1fr\); \}/);
  assert.match(chrome, /document\.body\.classList\.toggle\('atlas-rail', RAIL\.matches \|\| collapsed\);/);
});

test('Service Mode is retired; Home and the phone tab bar are the service surface', () => {
  // Spec §4.12, owner decision 2.
  assert.doesNotMatch(app, /service-mode|service-view|service-card|Service Mode/);
  assert.doesNotMatch(shellJs, /data-service-view|SERVICE_SELECTOR/);
  assert.match(app, /<nav class="atlas-tabbar" id="atlas-tabbar" aria-label="Main">/);
});

test('Recipes and Purchasing use clean, honest in-page controls', () => {
  assert.match(recipesCss, /#recipes-view \.recipe-status-filters \{[^}]*background: transparent/s);
  assert.match(app, /class="purchasing-workspace-tabs"/);
  assert.match(app, /id="purchase-orders-tab" disabled/);
  assert.match(app, /id="purchase-deliveries-tab" disabled/);
  assert.match(readFileSync('apps/web/assets/js/purchase-orders.js', 'utf8'), /openSection\('orders'\)/);
  assert.match(readFileSync('apps/web/assets/js/purchase-orders.js', 'utf8'), /openSection\('deliveries'\)/);
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
  assert.match(app, /if \(group === 'spirits'\)[\s\S]*if \(stored\) return stored\.replace/);
  assert.match(app, /if \(group === 'beer'\)[\s\S]*if \(stored\) return stored\.replace/);
  assert.match(app, /\/whisk\(\?:e\)\?y\|bourbon\|scotch\|rye/);
  assert.match(app, /\/cider\/\.test\(name\).*?!\/beer\/\.test\(category\)/);
  assert.match(app, /id="subcategory-tabs"/);
  assert.match(app, /result\.set\(label, \(result\.get\(label\) \|\| 0\) \+ 1\)/);
});

test('Inventory insight and table values remain grounded in loaded records', () => {
  assert.match(app, /function renderInventoryIntelligence\(\)/);
  assert.match(app, /currentItems\.filter\(item => window\.AtlasStockTruth\.belowPar\(item\)\)/);
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
