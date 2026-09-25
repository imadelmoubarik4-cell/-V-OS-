import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('apps/web/index.html', 'utf8');
const inventoryCss = readFileSync('apps/web/assets/css/inventory.css', 'utf8');
const recipesCss = readFileSync('apps/web/assets/css/recipes.css', 'utf8');
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
const homeJs = readFileSync('apps/web/assets/js/home.js', 'utf8');
const iconSources = [
  app,
  readFileSync('apps/web/assets/js/shifts-workspace.js', 'utf8'),
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
  assert.match(app, /'team-profiles': 'team-profiles-view'\n/);
  assert.match(app, /data: 'data-view'/);
  // S88 Team A: Brain and System are retired views (Home, Settings › System health).
  assert.doesNotMatch(app, /brain-view|system-view|restoreAtlasWorkspaceInterior/);
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
  // S88 Team A: Home has no stat grid or Operations prompt; one Home renderer (home.js).
  assert.doesNotMatch(app, /class="stat-grid"|checkpoint-a-home-prompt/);
  assert.doesNotMatch(homeJs, /stat-grid|metric-card|checkpoint-a/);
  // S88: the workspace page-title normalization is part of atlas-components.css.
  // S88: the retired workspace heroes (Item Master, Stock count, Team) have no rules left.
  assert.doesNotMatch(readFileSync('apps/web/assets/css/atlas-components.css', 'utf8'), /\.item-master-hero h1|\.stock-count-hero h1/);
  // S88: Team was rebuilt on the shared table; its retired card grid rules are gone.
  assert.doesNotMatch(readFileSync('apps/web/assets/css/team-profiles.source.css', 'utf8'), /\.team-profile-card-media/);
  // S88 Recipes (spec §7.7): one page header, no hero.
  assert.match(recipes, /window\.AtlasShell\.pageHead\(\{ title: 'Recipes'/);
  assert.doesNotMatch(recipes, /Recipe Library|recipe-hero|recipe-summary-grid/);
});

test('Home uses live values and supports expanded or compact navigation', () => {
  // S88 Team A (spec §7.1): no KPI cards; the date and greeting come from the
  // venue clock, attention rows from AtlasShell.home.rows, facts from the
  // canonical stock and recipe rules.
  assert.doesNotMatch(app, /id="home-date"|id="home-metrics"|id="home-margin"|data-home-action=/);
  assert.doesNotMatch(app, /<strong>8<\/strong><span>Onboarding steps/);
  assert.match(homeJs, /shell\(\)\?\.home\?\.rows\?\.\(\{ role: role\(\) \}\)/);
  assert.match(homeJs, /formatDate\?\.\(new Date\(\), \{ long: true \}\)/);
  assert.match(homeJs, /window\.AtlasStockTruth/);
  // S90: At a glance reads the Recipes page's own summary (canonical recipeStatus).
  assert.match(homeJs, /window\.AtlasRecipes\?\.summary\?\.\(\)/);
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
  assert.match(recipesCss, /@layer atlas\.modules \{/);
  assert.match(recipes, /<div class="atlas-segmented" role="group" aria-label="Availability">/);
  // S88 §7.8: Purchasing is module-owned (atlas-purchasing.js) with Orders, Deliveries and Suppliers tabs.
  assert.match(app, /<div id="suppliers-view" style="display:none;"><\/div>/);
  for (const tab of ['Orders', 'Deliveries', 'Suppliers']) assert.match(purchasing, new RegExp(`'${tab}'`));
  assert.match(purchasing, /shell\.registerView\('suppliers'/);
  assert.match(purchasingCss, /^@layer atlas\.modules \{/m);
});

test('Inventory filters are chips over loaded records, with honest unknowns', () => {
  for (const label of ['Below par', 'Not counted', 'Out or almost out']) assert.match(inventory, new RegExp(`'${label}'`));
  // S89: the chips and pills read the canonical AtlasStockTruth.stockStatus.
  assert.match(inventory, /truth\(\)\?\.stockStatus\?\.\(item\) !== 'below_par'/);
  assert.match(inventory, /if \(status === 'unknown'\) return \{ key: 'not_counted', label: 'Not counted'/);
  assert.match(inventory, /manager \? '<th class="inv-col--supplier" data-priority="2">Supplier<\/th>' : ''/);
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
  // S88 Reports: an .atlas-page with module layout only (spec §7.12).
  assert.match(reportsCss, /@layer atlas\.modules \{/);
  assert.match(readFileSync('apps/web/assets/js/reports-workspace.js', 'utf8'), /<div class="atlas-page reports-page/);
  // S88 Team A (spec §7.15): section nav 220 px + one reading column; one column on phones.
  assert.match(settingsCss, /\.settings-layout \{ display: grid; grid-template-columns: 220px minmax\(0, var\(--reading-max\)\)/);
  assert.match(settingsCss, /@media \(max-width: 767px\)[\s\S]*\.settings-layout, \.settings--single \.settings-layout \{ grid-template-columns: minmax\(0, 1fr\)/);
});

test('all audited Lucide placeholders use icons included in the pinned runtime', () => {
  assert.doesNotMatch(iconSources, /calendar-off-2|database-off/);
  assert.match(iconSources, /data-lucide="calendar-days"/);
  assert.match(iconSources, /data-lucide="database"/);
});
