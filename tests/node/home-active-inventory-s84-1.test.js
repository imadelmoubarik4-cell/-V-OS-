import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, ROOT), 'utf8');
const NOW = Date.parse('2026-09-24T12:00:00Z');

// Runs the real Home module (assets/js/home.js) against the real stock-truth
// projection. Home reads live stock through AtlasHome.stockFacts/stockGlance
// (S88 Team A); the Inventory attention rows are contributed by the Inventory
// module (atlas-inventory.js, key 'inventory', S88 Team B).
// A shell stub: named methods answer; every other member is a harmless no-op.
function stubShell(own) {
  const noop = new Proxy(function () {}, { get: (target, key) => (key === Symbol.toPrimitive ? undefined : noop), apply: () => noop });
  return new Proxy(own, { get: (target, key) => (key in target ? target[key] : noop) });
}
function renderHome(rawItems, balances = [], { role = 'admin' } = {}) {
  const context = {
    Date, Number, Math, Map, Set, String, Array, Object, JSON, console, Intl,
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    AtlasShell: stubShell({ dataLoadedAt: () => NOW, profile: () => ({ id: 'u1', role }) }),
    AtlasData: { items: () => context.items, recipes: () => [], status: () => ({ items: 'ok' }) },
    recipes: []
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('apps/web/assets/js/atlas-stock-truth.js'), context);
  vm.runInContext(read('apps/web/assets/js/home.js'), context);
  vm.runInContext(read('apps/web/assets/js/atlas-inventory.js'), context);
  context.items = context.AtlasStockTruth.project(rawItems, balances, [], NOW);
  const facts = context.AtlasHome.stockFacts();
  const glance = context.AtlasHome.stockGlance(true);
  const rows = context.AtlasInventory.homeRows();
  return {
    items: String(facts.active),
    low: glance.value,
    lowNote: glance.detail,
    unknown: facts.unknown,
    rows: rows.map((row) => row.title).join(' | ')
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
  assert.equal(home.unknown, 0);
});

test('2. an inactive row does not increase the Home inventory item count', () => {
  const rows = [activeCounted('a', 5, 2), activeCounted('b', 5, 2), { ...activeCounted('old', 5, 2), active: false }];
  const home = renderHome(rows, [verified('a', 5), verified('b', 5), verified('old', 5)]);
  assert.equal(home.items, '2');
});

test('3. an inactive below-par row does not increase Home below-par', () => {
  const rows = [activeCounted('a', 5, 2), { ...activeCounted('retired', 0, 4), active: false }];
  const home = renderHome(rows, [verified('a', 5), verified('retired', 0)]);
  assert.equal(home.low, '0');
  assert.equal(home.lowNote, 'Counted items are at or above par');
  assert.doesNotMatch(home.rows, /retired/);
  // Active below-par rows still count.
  const withActiveLow = renderHome([...rows, activeCounted('short', 1, 4)], [verified('a', 5), verified('retired', 0), verified('short', 1)]);
  assert.equal(withActiveLow.low, '1');
  assert.match(withActiveLow.rows, /short is below par/);
});

test('4. active Unknown rows still count', () => {
  const rows = [activeCounted('a', 5, 2), { id: 'uncounted', name: 'Uncounted gin', active: true, quantity: 3, unit: 'bottles' }, { id: 'legacy', name: 'Legacy row', quantity: 1 }];
  const home = renderHome(rows, [verified('a', 5)]);
  // Counted items are judged; the uncounted ones are named as not counted, never as healthy.
  assert.equal(home.low, '0');
  assert.equal(home.lowNote, '2 not counted');
  assert.equal(home.items, '3', 'rows without an active flag stay live');
  assert.equal(home.unknown, 2);
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

test('S88: with nothing counted Home says "Not counted", never "0 below par" or healthy', () => {
  // The S87 bug: a bartender whose catalogue had no verified counts was told
  // "0 below par — Verified stock levels healthy".
  const home = renderHome(REGRESSION, [], { role: 'bartender' });
  assert.equal(home.low, 'Not counted');
  assert.equal(home.lowNote, 'No verified count yet');
  assert.doesNotMatch(home.lowNote, /healthy/);
  assert.match(home.rows, /Stock isn’t counted yet/);
  assert.equal(home.unknown, 15);
});

test('5. after the S84.1 migration the 15 active regression rows no longer produce Unknown', () => {
  const home = renderHome([ANGELO, ...REGRESSION, ...INACTIVE].map(afterS841));
  assert.equal(home.items, '16');
  assert.notEqual(home.low, 'Not counted');
  assert.doesNotMatch(home.lowNote, /not counted/);
  assert.doesNotMatch(home.rows, /isn’t counted/);
});

test('6. inactive recipe references such as Ice and Water may stay unverified without making Home report Unknown', () => {
  const rows = [ANGELO, ...REGRESSION, ...INACTIVE].map(afterS841);
  const stillUnverified = INACTIVE.map(afterS841).filter((row) => row.source_confirmed_at === null).map((row) => row.name);
  assert.ok(stillUnverified.includes('Ice (recipe reference)') && stillUnverified.includes('Water (recipe reference)'));
  assert.equal(stillUnverified.length, 9);
  const home = renderHome(rows);
  assert.doesNotMatch(home.lowNote, /not counted/);
  assert.equal(home.unknown, 0);
});

test('Inventory records keep inactive rows; only live-stock surfaces filter them', () => {
  const html = read('apps/web/index.html');
  assert.match(html, /items = window\.AtlasStockTruth\.project\(data \|\| \[\], balances, inventoryMovements\);/);
  assert.match(read('apps/web/assets/js/home.js'), /const active = items\(\)\.filter\(\(item\) => item\.active !== false\);/);
  assert.doesNotMatch(html, /update\(\{\s*active:\s*true/);
  // S88: the Inventory page (atlas-inventory.js) lists inactive rows under the
  // Inactive filter, and (de)activation goes through set_item_active only.
  const inventory = read('apps/web/assets/js/atlas-inventory.js');
  assert.match(inventory, /if \(item\.active === false\) return \{ key: 'inactive', label: 'Inactive'/);
  assert.match(inventory, /itemMaster\('set_item_active'/);
  assert.doesNotMatch(inventory, /update\(\{\s*active:/);
});
