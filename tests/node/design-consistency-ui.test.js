import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { legacyCss, linkPosition, layerOf } from './helpers/legacy-css.js';

const app = readFileSync('apps/web/index.html', 'utf8');
const inventoryCss = readFileSync('apps/web/assets/css/inventory.css', 'utf8');
const homeCss = legacyCss('home-polish');
const recipesCss = legacyCss('recipes-gallery');
const purchasingCss = readFileSync('apps/web/assets/css/purchasing.css', 'utf8');
const inventory = readFileSync('apps/web/assets/js/atlas-inventory.js', 'utf8');
const purchasing = readFileSync('apps/web/assets/js/atlas-purchasing.js', 'utf8');
const shellCss = readFileSync('apps/web/assets/css/atlas-shell.css', 'utf8');
const shellJs = readFileSync('apps/web/assets/js/atlas-shell.js', 'utf8');
const chrome = readFileSync('apps/web/assets/js/atlas-chrome.js', 'utf8');
const recipes = readFileSync('apps/web/assets/js/recipes.js', 'utf8');
const capture = readFileSync('apps/web/assets/js/atlas-capture.js', 'utf8');
const stockCount = readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8');
const reportsCss = readFileSync('apps/web/assets/css/reports-workspace.css', 'utf8');
const settingsCss = readFileSync('apps/web/assets/css/settings-workspace.css', 'utf8');
const finalPolishCss = legacyCss('polish-pass2');
const iconSources = [
  app,
  readFileSync('apps/web/assets/js/shifts-workspace.js', 'utf8'),
  readFileSync('apps/web/assets/js/shifts-month-calendar.js', 'utf8'),
  readFileSync('apps/web/assets/js/reports-workspace.js', 'utf8'),
  readFileSync('apps/web/assets/js/system-workspace.js', 'utf8'),
].join('\n');

test('Inventory is one module-owned page with in-page tabs (S88 §7.5)', () => {
  // The inventory markup lives in assets/js/atlas-inventory.js; index.html keeps an empty root.
  assert.match(app, /<div id="inventory-view" style="display:none;"><\/div>/);
  assert.doesNotMatch(app, /id="inventory-section-header"|data-inventory-section=|syncInventorySectionHeader/);
  for (const view of ['inventory', 'movements', 'waste']) assert.match(inventory, new RegExp(`shell\\.registerView\\('${view}'`));
  assert.match(inventory, /shell\.pageHead\(\{ title: 'Inventory'/);
  assert.match(inventoryCss, /^@layer atlas\.modules \{/m);
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
  // S88: one navigation path. AtlasShell routes every sidebar click once and
  // the base shell's chrome is its layout hook; no per-button double binding.
  assert.match(app, /window\.AtlasShell\.setLayout\(layoutAtlasView\)/);
  assert.match(app, /function layoutAtlasView\(view, entry, context\)/);
  // Leaving Inventory pauses an open stock count (atlas-inventory.js onHide).
  assert.match(inventory, /function onHide\(\) \{[\s\S]*?root\.AtlasStockCounts\?\.leave\?\.\(\);/);
  assert.doesNotMatch(app, /atlasBaseViewBound/);
});

test('shared polish removes duplicate Home metrics and normalizes workspace hierarchy', () => {
  assert.match(finalPolishCss, /#dashboard-view > \.stat-grid/);
  assert.match(finalPolishCss, /body\[data-atlas-view\]:not\(\[data-atlas-view="dashboard"\]\) \.checkpoint-a-home-prompt/);
  // S88: the workspace page-title normalization is part of atlas-components.css.
  assert.match(readFileSync('apps/web/assets/css/atlas-components.css', 'utf8'), /\.recipe-hero h1,[\s\S]*\.recipe-alpha03-head h1,[\s\S]*\.settings-hero h1/);
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
  // S88 §7.8: Purchasing is module-owned (atlas-purchasing.js) with Orders, Deliveries and Suppliers tabs.
  assert.match(app, /<div id="suppliers-view" style="display:none;"><\/div>/);
  for (const tab of ['Orders', 'Deliveries', 'Suppliers']) assert.match(purchasing, new RegExp(`'${tab}'`));
  assert.match(purchasing, /shell\.registerView\('suppliers'/);
  assert.match(purchasingCss, /^@layer atlas\.modules \{/m);
});

test('Inventory filters are chips over loaded records, with honest unknowns', () => {
  for (const label of ['Below par', 'Not counted', 'Out or almost out']) assert.match(inventory, new RegExp(`'${label}'`));
  assert.match(inventory, /truth\(\)\?\.belowPar\(item\)/);
  assert.match(inventory, /if \(!truth\(\)\?\.known\(item\)\) return \{ key: 'not_counted', label: 'Not counted'/);
  assert.match(inventory, /manager \? '<th data-priority="2">Supplier<\/th>' : ''/);
  assert.doesNotMatch(inventory, /Flóki Single Malt barely moves|45,000 ISK in stock/);
  // The owner's primary and contextual category model (S38 decisions).
  for (const label of ['Spirits', 'Wine', 'Beer', 'Mixers', 'Syrups', 'Bitters', 'Fresh fruit', 'Fresh herbs', 'Garnish', 'Bar ingredients', 'Consumables', 'Bar equipment', 'Coffee']) {
    assert.match(inventory, new RegExp(`'${label}'\\]`));
  }
  assert.match(inventory, /function inventoryGroup\(item\)/);
  assert.match(inventory, /function inventorySubcategory\(item, group = inventoryGroup\(item\)\)/);
  assert.match(inventory, /const WINE_TYPES = \['Red', 'White', 'Rosé', 'Sparkling'\];/);
});

test('scan, add and stock count share one capture module and the shell top bar', () => {
  assert.match(capture, /root\.AtlasCapture = /);
  assert.match(inventory, /root\.AtlasCapture/);
  assert.match(stockCount, /root\.AtlasCapture/);
  assert.match(stockCount, /document\.body\.classList\.add\('stock-count-active'\)/);
  assert.match(inventory, /AtlasChrome\?\.setTopBar\?\./);
  assert.match(app, /requireCommercialManager\(action = 'This action'\)/);
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
