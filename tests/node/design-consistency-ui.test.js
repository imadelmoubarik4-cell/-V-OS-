import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('apps/web/index.html', 'utf8');
const inventoryCss = readFileSync('apps/web/assets/css/inventory-polish.css', 'utf8');
const scanner = readFileSync('apps/web/assets/js/inventory-scanner.js', 'utf8');
const stockCount = readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8');
const itemMaster = readFileSync('apps/web/assets/js/item-master-workspace.js', 'utf8');
const reportsCss = readFileSync('apps/web/assets/css/reports-workspace.css', 'utf8');
const settingsCss = readFileSync('apps/web/assets/css/settings-workspace.css', 'utf8');
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
  assert.match(app, /class="nav-item" data-view="inventory"><i data-lucide="package"><\/i>Inventory<\/button>/);
  assert.match(app, /class="nav-item" data-view="recipes"><i data-lucide="martini"><\/i>Recipes<\/button>/);
  assert.doesNotMatch(app, /data-default="inventory"|data-default="recipes"/);
  assert.doesNotMatch(app, /data-recipe-filter="signature-cocktail"/);
  assert.doesNotMatch(app, /class="nav-item" data-view="imports"/);
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
