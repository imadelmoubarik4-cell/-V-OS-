import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, ROOT), 'utf8');
const NOW = Date.parse('2026-09-24T12:00:00Z');

function extract(html, start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} must exist in index.html`);
  return html.slice(from, to);
}

// Runs the real renderAtlasHome() and renderDashboard() from index.html against
// stubbed DOM nodes, using the real stock-truth projection.
function renderHome(rawItems, balances = [], { html = read('apps/web/index.html'), truth = read('apps/web/assets/js/atlas-stock-truth.js') } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, textContent: '', innerHTML: '', style: {}, onclick: null });
    return nodes.get(id);
  };
  const context = {
    Date, Number, Math, Map, Set, String, Array, Object, JSON, console,
    document: { getElementById: node, querySelectorAll: () => [] },
    formatVenueDay: () => 'Thursday', venueGreeting: () => 'Good morning',
    updateHomeTeamMetric() {}, bindHomeLinks() {}, escapeHtml: (value) => String(value),
    restockLog: [], inventoryMovements: []
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(truth, context);
  context.AtlasRecipes = { getHomeMetrics: () => null, getHomeAlert: () => null };
  context.items = context.AtlasStockTruth.project(rawItems, balances, [], NOW);
  vm.runInContext(extract(html, '  function renderAtlasHome(){', '\n  function bindHomeLinks'), context);
  vm.runInContext('renderAtlasHome();', context);
  // renderDashboard's tail (activity and spend panels) is outside the stock cards under test.
  vm.runInContext(`(${extract(html, '  function renderDashboard() {', '\n    // Recent activity').replace('function renderDashboard() {', 'function () {')}\n})();`, context);
  const text = (id) => String(node(id).textContent);
  return {
    items: text('home-items'),
    low: text('home-low'),
    lowNote: text('home-low-note'),
    headline: text('home-brief-headline'),
    dashboardTotal: text('stat-total-items'),
    dashboardLow: text('stat-low-stock'),
    dashboardRows: node('low-inventory-rows').innerHTML
  };
}

const verified = (id, quantity) => ({
  inventory_item_id: id, verified_quantity: quantity, freshness_state: 'current',
  verified_at: '2026-09-24T08:00:00Z', expires_at: '2026-10-01T08:00:00Z'
});
const activeCounted = (id, quantity, par) => ({ id, name: id, active: true, quantity, par_level: par, unit: 'bottles' });

test('1. an inactive Unknown row does not increase unknownStock', () => {
  const rows = [activeCounted('a', 5, 2), { id: 'ice', name: 'Ice (recipe reference)', active: false, quantity: 0, unit: 'untracked' }];
  const home = renderHome(rows, [verified('a', 5)]);
  assert.equal(home.low, '0');
  assert.doesNotMatch(home.lowNote, /not counted/);
  assert.equal(home.dashboardLow, '0');
});

test('2. an inactive row does not increase the Home inventory item count', () => {
  const rows = [activeCounted('a', 5, 2), activeCounted('b', 5, 2), { ...activeCounted('old', 5, 2), active: false }];
  const home = renderHome(rows, [verified('a', 5), verified('b', 5), verified('old', 5)]);
  assert.equal(home.items, '2');
  assert.equal(home.dashboardTotal, '2');
});

test('3. an inactive below-par row does not increase Home below-par', () => {
  const rows = [activeCounted('a', 5, 2), { ...activeCounted('retired', 0, 4), active: false }];
  const home = renderHome(rows, [verified('a', 5), verified('retired', 0)]);
  assert.equal(home.low, '0');
  assert.equal(home.lowNote, 'Verified stock levels healthy');
  assert.equal(home.dashboardLow, '0');
  assert.doesNotMatch(home.dashboardRows, /retired/);
  // Active below-par rows still count.
  const withActiveLow = renderHome([...rows, activeCounted('short', 1, 4)], [verified('a', 5), verified('retired', 0), verified('short', 1)]);
  assert.equal(withActiveLow.low, '1');
  assert.equal(withActiveLow.dashboardLow, '1');
});

test('4. active Unknown rows still count', () => {
  const rows = [activeCounted('a', 5, 2), { id: 'uncounted', name: 'Uncounted gin', active: true, quantity: 3, unit: 'bottles' }, { id: 'legacy', name: 'Legacy row', quantity: 1 }];
  const home = renderHome(rows, [verified('a', 5)]);
  assert.equal(home.low, 'Unknown');
  assert.equal(home.lowNote, '2 items not counted / verified');
  assert.equal(home.items, '3', 'rows without an active flag stay live');
  assert.equal(home.dashboardLow, 'Unknown');
});

// Production-shaped rows: the 15 S84 regression rows, Angelo, and the 10
// inactive rows (S84.1 backfills Diadem Pear Purée Base; the rest stay unverified).
const REGRESSION = [
  ['Basil Syrup', 'owner_confirmed_prep', 0], ['Chupa Chups Infused Patrón', 'owner_confirmed_prep', 1],
  ['Fresh Orange Juice', 'owner_confirmed_prep', 0], ['Pear Liquid Syrup (Diadem)', 'owner_confirmed_prep', 0],
  ['Pear Syrup', 'owner_confirmed_prep', 0], ['Popcorn-infused Woodford Bourbon', 'owner_confirmed_prep', 0],
  ['Saline Solution', 'owner_confirmed_prep', 0], ['Simple Syrup', 'owner_confirmed_prep', 0],
  ['Haframjólk Natrue Barista 1L', 'owner_verified_count', 0], ['Kirsuber m/stilk rauð 2kg', 'owner_verified_count', 1],
  ['Pickwick Finest Earl Grey', 'owner_verified_count', 6], ['Pickwick Finest English Tea', 'owner_verified_count', 6],
  ['Pickwick Green Tea', 'owner_verified_count', 11], ['Pickwick Peppermint', 'owner_verified_count', 3],
  ['Teisseire Pomegranate Grenadine', 'owner_verified_count', 1]
].map(([name, source_type, quantity], index) => ({
  id: `regression-${index}`, name, active: true, quantity, source_type, source_confidence: 100,
  updated_at: '2026-09-23T22:15:29Z', source_confirmed_at: null, source_confirmed_quantity: null
}));
const INACTIVE = [
  ['Cartron Sureau', 'owner_approved_unverified_stock'], ['White Egg', 'owner_approved_unverified_stock'],
  ['Chili Powder', 'owner_confirmed_addition'], ['Dehydrated Lime', 'owner_confirmed_addition'],
  ['Demerara Sugar Cube', 'owner_confirmed_addition'], ['Ice (recipe reference)', 'owner_confirmed_addition'],
  ['Selected Tea Bag (recipe choice)', 'owner_confirmed_addition'], ['Water (recipe reference)', 'owner_confirmed_addition'],
  ['English Breakfast Tea 20 stk', 'owner_confirmed_product'], ['Diadem Pear Purée Base', 'owner_confirmed_prep']
].map(([name, source_type], index) => ({
  id: `inactive-${index}`, name, active: false, quantity: 0, source_type, source_confidence: 100,
  updated_at: '2026-09-23T19:49:24Z', source_confirmed_at: null, source_confirmed_quantity: null
}));
const ANGELO = {
  id: 'angelo', name: 'Angelo Pinot Grigio', active: true, quantity: 10, source_type: 'owner_confirmed', source_confidence: 100,
  updated_at: '2026-09-23T22:14:07Z', source_confirmed_at: '2026-09-23T22:14:07Z', source_confirmed_quantity: 10
};
const trustedBackfill = new Set(['owner_confirmed', 'owner_confirmed_supplier_price', 'owner_confirmed_prep', 'owner_verified_count']);
const afterS841 = (row) => (trustedBackfill.has(row.source_type) && row.source_confirmed_at === null
  ? { ...row, source_confirmed_at: row.updated_at, source_confirmed_quantity: row.quantity }
  : row);

test('the pre-fix Home reproduces the production "Unknown — 25 items not counted / verified"', () => {
  // Reconstruct the old live-metric behavior from the current shell instead of
  // depending on a historical git object. GitHub Actions uses a shallow
  // checkout, so historical commits are intentionally unavailable there.
  let legacyHtml = read('apps/web/index.html');
  legacyHtml = legacyHtml
    .replace(
      `    // Home reports live stock: inactive rows stay in Inventory records but never count here.
    const activeItems = items.filter(item => item.active !== false);
    const low = activeItems.filter(
      item =>
        window.AtlasStockTruth.known(item) &&
        item.par_level != null &&
        Number(item.quantity) < Number(item.par_level)
    );`,
      `    const low=items.filter(i=>window.AtlasStockTruth.known(i) && i.par_level!=null && Number(i.quantity)<Number(i.par_level));`
    )
    .replace("document.getElementById('home-items').textContent = activeItems.length;", "document.getElementById('home-items').textContent=items.length;")
    .replace(
      `    const unknownStock = activeItems.filter(
      item => !window.AtlasStockTruth.known(item)
    ).length;`,
      `    const unknownStock = items.filter(item => !window.AtlasStockTruth.known(item)).length;`
    )
    .replace("document.getElementById('home-items-note').textContent=activeItems.length===1?'Live catalog item':'Live catalog items';", "document.getElementById('home-items-note').textContent=items.length===1?'Live catalog item':'Live catalog items';")
    .replace(
      `    // Stock cards describe live inventory; inactive rows are records, not stock.
    const activeItems = items.filter(item => item.active !== false);
    const lowCount = activeItems.filter(i => window.AtlasStockTruth.known(i) && i.par_level != null && i.quantity <= i.par_level).length;`,
      `    const lowCount = items.filter(i => window.AtlasStockTruth.known(i) && i.par_level != null && i.quantity <= i.par_level).length;`
    )
    .replace("document.getElementById('stat-total-items').textContent = activeItems.length;", "document.getElementById('stat-total-items').textContent = items.length;")
    .replace("document.getElementById('stat-low-stock').textContent = activeItems.some(item => !window.AtlasStockTruth.known(item)) ? 'Unknown' : lowCount;", "document.getElementById('stat-low-stock').textContent = items.some(item => !window.AtlasStockTruth.known(item)) ? 'Unknown' : lowCount;")
    .replace("const lowItems = activeItems.filter(i => window.AtlasStockTruth.known(i) && i.par_level != null && i.quantity <= i.par_level);", "const lowItems = items.filter(i => window.AtlasStockTruth.known(i) && i.par_level != null && i.quantity <= i.par_level);")
    .replace("lowRows.innerHTML = activeItems.some(item => !window.AtlasStockTruth.known(item)) ? '<div class=\"empty-dash\">Stock status unknown — verify a physical count.</div>' : '<div class=\"empty-dash\">Nothing below par in verified stock.</div>';", "lowRows.innerHTML = items.some(item => !window.AtlasStockTruth.known(item)) ? '<div class=\"empty-dash\">Stock status unknown — verify a physical count.</div>' : '<div class=\"empty-dash\">Nothing below par in verified stock.</div>';");

  const home = renderHome([ANGELO, ...REGRESSION, ...INACTIVE], [], { html: legacyHtml });
  assert.equal(home.low, 'Unknown');
  assert.equal(home.lowNote, '25 items not counted / verified');
});

test('5. after the S84.1 migration the 15 active regression rows no longer produce Unknown', () => {
  const home = renderHome([ANGELO, ...REGRESSION, ...INACTIVE].map(afterS841));
  assert.equal(home.items, '16');
  assert.notEqual(home.low, 'Unknown');
  assert.doesNotMatch(home.lowNote, /not counted/);
  assert.notEqual(home.headline, 'Stock verification is incomplete.');
  assert.notEqual(home.dashboardLow, 'Unknown');
});

test('6. inactive recipe references such as Ice and Water may stay unverified without making Home report Unknown', () => {
  const rows = [ANGELO, ...REGRESSION, ...INACTIVE].map(afterS841);
  const stillUnverified = INACTIVE.map(afterS841).filter((row) => row.source_confirmed_at === null).map((row) => row.name);
  assert.ok(stillUnverified.includes('Ice (recipe reference)') && stillUnverified.includes('Water (recipe reference)'));
  assert.equal(stillUnverified.length, 9);
  const home = renderHome(rows);
  assert.doesNotMatch(home.lowNote, /not counted/);
  assert.notEqual(home.dashboardLow, 'Unknown');
});

test('Inventory records keep inactive rows; only live-stock surfaces filter them', () => {
  const html = read('apps/web/index.html');
  assert.match(html, /items = window\.AtlasStockTruth\.project\(data \|\| \[\], balances, inventoryMovements\);/);
  assert.match(html, /const lowCount = items\.filter\(i => i\.active !== false && window\.AtlasStockTruth\.belowPar\(i\)\)/);
  assert.doesNotMatch(html, /update\(\{\s*active:\s*true/);
});
