import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

import { buildStockReport } from '../../supabase/functions/_shared/stock-provenance.mjs';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-24T10:00:00Z');

// Live Angelo rows as returned by PostgREST and the stock-counts snapshot.
const ANGELO = {
  id: 'ef1c8e31-b5a5-42a6-88a5-a47cd3f77051',
  name: 'Angelo Pinot Grigio',
  quantity: '10',
  unit: 'bottles',
  size_ml: '750',
  cost_price: 2000,
  source_type: 'owner_confirmed',
  source_confidence: 100,
  source_confirmed_at: '2026-09-23T22:14:07.789111+00:00',
  source_confirmed_quantity: '10',
  updated_at: '2026-09-23T22:14:07.789111+00:00'
};
// The same item as active staff read it from public.inventory_catalog.
const ANGELO_STAFF = {
  id: ANGELO.id,
  name: ANGELO.name,
  quantity: '10',
  unit: 'bottles',
  size_ml: '750',
  updated_at: ANGELO.updated_at,
  owner_confirmed_quantity: '10',
  owner_confirmed_at: ANGELO.source_confirmed_at
};
const OLDER_VERIFIED_ZERO = {
  inventory_item_id: ANGELO.id,
  verified_quantity: '0',
  verification_status: 'current',
  freshness_state: 'current',
  verified_at: '2026-09-21T19:36:22.690674+00:00',
  expires_at: '2026-09-28T19:36:22.690674+00:00'
};
const ANGELO_RECIPE = {
  id: 'de5c9bae-06c1-45da-a72a-66d4e5502830',
  name: 'Angelo Pinot Grigio',
  active: true,
  yield_quantity: '1',
  menu_price: 2500,
  recipe_ingredients: [{ item_id: ANGELO.id, item_name: ANGELO.name, quantity: '150', unit: 'ml' }]
};

// Loads the same script chain index.html loads, in the same order, without a DOM.
function loadAtlas({ inventory = [], balances = [], movements = [], recipes = [], now = NOW } = {}) {
  const context = {
    Date, Number, Math, Map, Set, String, Array, Object, JSON, console,
    localStorage: { getItem: () => null, setItem() {} },
    document: { readyState: 'loading', addEventListener() {} }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('apps/web/assets/js/atlas-stock-truth.js'), context);
  vm.runInContext(read('apps/web/assets/js/atlas-calculations.js'), context);
  context.items = context.AtlasStockTruth.project(inventory, balances, movements, now);
  context.recipes = recipes;
  vm.runInContext(read('apps/web/assets/js/recipes.js'), context);
  return context;
}

test('newer owner-confirmed 10 bottles beats an older verified 0 and keeps the balance intact', () => {
  const balance = structuredClone(OLDER_VERIFIED_ZERO);
  const atlas = loadAtlas({ inventory: [ANGELO], balances: [balance] });
  const [item] = atlas.items;
  assert.equal(item.verified_quantity, 10);
  assert.equal(item.quantity, 10);
  assert.equal(item.freshness_state, 'current');
  assert.equal(item.stock_source, 'owner_confirmed');
  assert.equal(atlas.AtlasStockTruth.known(item), true);
  assert.deepEqual(balance, OLDER_VERIFIED_ZERO, 'historical verified evidence is never rewritten');
});

test('parsePackSize reads bottles with size_ml=750 as a 750 ml pack', () => {
  const atlas = loadAtlas();
  const pack = atlas.AtlasCalculations.parsePackSize(ANGELO);
  assert.equal(pack.quantity, 750);
  assert.equal(pack.unit, 'ml');
});

test('10 bottles x 750 ml / 150 ml = 50 servings through the Recipes path', () => {
  const atlas = loadAtlas({ inventory: [ANGELO], balances: [OLDER_VERIFIED_ZERO], recipes: [ANGELO_RECIPE] });
  const metrics = atlas.AtlasCalculations.recipeMetrics(ANGELO_RECIPE, atlas.items);
  assert.equal(metrics.rows[0].batches, 50);
  assert.equal(metrics.availability.servings, 50);
  const availability = atlas.AtlasRecipes.recipeAvailability(ANGELO_RECIPE);
  assert.equal(availability.servings, 50);
});

test('Recipes card status is ready or attention, never unavailable', () => {
  const atlas = loadAtlas({ inventory: [ANGELO], balances: [OLDER_VERIFIED_ZERO], recipes: [ANGELO_RECIPE] });
  const { status } = atlas.AtlasRecipes.recipeAvailability(ANGELO_RECIPE);
  assert.notEqual(status, 'unavailable');
  assert.ok(['ready', 'attention'].includes(status), status);
});

test('Atlas Intelligence no longer says Angelo cannot currently be served', () => {
  const atlas = loadAtlas({ inventory: [ANGELO], balances: [OLDER_VERIFIED_ZERO], recipes: [ANGELO_RECIPE] });
  const alert = atlas.AtlasRecipes.getHomeAlert();
  assert.doesNotMatch(alert?.text || '', /cannot currently be served/);
});

test('a newer manager-verified count still beats an older owner-confirmed count', () => {
  const newerCount = {
    ...OLDER_VERIFIED_ZERO,
    verified_quantity: '4',
    verified_at: '2026-09-24T08:00:00Z',
    expires_at: '2026-10-01T08:00:00Z'
  };
  const atlas = loadAtlas({ inventory: [ANGELO], balances: [newerCount], recipes: [ANGELO_RECIPE] });
  assert.equal(atlas.items[0].verified_quantity, 4);
  assert.equal(atlas.items[0].stock_source, 'manager_verified_count');
  assert.equal(atlas.AtlasRecipes.recipeAvailability(ANGELO_RECIPE).servings, 20);
});

// Issue 1: staff reconcile from the same evidence, without source metadata.
test('staff catalogue rows reach the same 50 servings as managers', () => {
  const atlas = loadAtlas({ inventory: [ANGELO_STAFF], balances: [OLDER_VERIFIED_ZERO], recipes: [ANGELO_RECIPE] });
  assert.equal(atlas.items[0].verified_quantity, 10);
  assert.equal(atlas.items[0].stock_source, 'owner_confirmed');
  assert.equal(atlas.AtlasRecipes.recipeAvailability(ANGELO_RECIPE).servings, 50);
  assert.doesNotMatch(atlas.AtlasRecipes.getHomeAlert()?.text || '', /cannot currently be served/);
});

test('staff rows without an owner baseline still follow the verified count', () => {
  const { owner_confirmed_quantity, owner_confirmed_at, ...plain } = ANGELO_STAFF;
  const atlas = loadAtlas({ inventory: [plain], balances: [OLDER_VERIFIED_ZERO] });
  assert.equal(atlas.items[0].verified_quantity, 0);
  assert.equal(atlas.items[0].stock_source, 'manager_verified_count');
});

// Issue 2: one reconciled quantity for the Inventory table and its stepper.
test('Inventory table and quick adjustments read the reconciled quantity, never raw live stock', () => {
  const html = read('apps/web/index.html');
  assert.doesNotMatch(html, /live_quantity|hasManagerLiveQuantity|liveQuantityById/);
  assert.match(html, /items = window\.AtlasStockTruth\.project\(data \|\| \[\], balances, inventoryMovements\);/);
  // S88: the Inventory page lives in atlas-inventory.js and shows a quantity
  // only when AtlasStockTruth knows it; quick adjustments were retired.
  const inventory = read('apps/web/assets/js/atlas-inventory.js');
  assert.doesNotMatch(inventory, /live_quantity|hasManagerLiveQuantity|liveQuantityById/);
  assert.match(inventory, /if \(key === 'onhand'\) return truth\(\)\?\.known\(item\) \? num\(item\.quantity\) : null;/);
  assert.match(inventory, /\['On hand', known \? `\$\{qty\(item\.quantity\)\}/);
});

// Issue 3: the confirmation has its own timestamp and quantity.
test('a later master edit does not re-date an owner confirmation past a newer manager count', () => {
  const edited = { ...ANGELO, updated_at: '2026-09-24T09:00:00Z', cost_price: 2100 };
  const newerCount = { ...OLDER_VERIFIED_ZERO, verified_quantity: '4', verified_at: '2026-09-24T08:00:00Z', expires_at: '2026-10-01T08:00:00Z' };
  const atlas = loadAtlas({ inventory: [edited], balances: [newerCount] });
  assert.equal(atlas.items[0].verified_quantity, 4);
  assert.equal(atlas.items[0].stock_source, 'manager_verified_count');
  const report = buildStockReport([{ ...edited, active: true }], [newerCount], {}, NOW, []);
  assert.equal(report.rows[0].quantity, 4);
  assert.equal(report.rows[0].quantity_source, 'manager_verified_count');
});

test('movements after the confirmation are applied once, whatever the live quantity says', () => {
  // adjust_inventory moved live stock to 8 and re-dated the row; the confirmation stays at 10.
  const afterSale = { ...ANGELO, quantity: '8', updated_at: '2026-09-24T09:00:00Z' };
  const movements = [{ item_id: ANGELO.id, movement_type: 'sale', quantity_change: -2, created_at: '2026-09-24T09:00:00Z' }];
  const atlas = loadAtlas({ inventory: [afterSale], balances: [OLDER_VERIFIED_ZERO], movements });
  assert.equal(atlas.items[0].verified_quantity, 8);
  assert.equal(buildStockReport([{ ...afterSale, active: true }], [OLDER_VERIFIED_ZERO], {}, NOW, movements).rows[0].quantity, 8);
});

test('an owner-confirmed row without recorded confirmation evidence is not a baseline', () => {
  const unrecorded = { ...ANGELO, source_confirmed_at: null, source_confirmed_quantity: null };
  const atlas = loadAtlas({ inventory: [unrecorded], balances: [OLDER_VERIFIED_ZERO] });
  assert.equal(atlas.items[0].verified_quantity, 0);
  assert.equal(atlas.items[0].stock_source, 'manager_verified_count');
});

// Issue 4: owner confirmations do not expire; they are flagged for recount.
test('owner-confirmed stock stays known after its freshness window and is flagged for recount', () => {
  const later = Date.parse('2026-10-05T10:00:00Z');
  const atlas = loadAtlas({ inventory: [ANGELO], balances: [OLDER_VERIFIED_ZERO], recipes: [ANGELO_RECIPE], now: later });
  assert.equal(atlas.items[0].verified_quantity, 10);
  assert.equal(atlas.items[0].stock_recount_due, true);
  assert.equal(atlas.AtlasRecipes.recipeAvailability(ANGELO_RECIPE).servings, 50);
  const report = buildStockReport([{ ...ANGELO, active: true, cost_price: 2000, supplier: 'Supplier', par_level: 2 }], [OLDER_VERIFIED_ZERO], {}, later, []);
  assert.equal(report.rows[0].quantity, 10);
  assert.equal(report.rows[0].quantity_status, 'current');
  assert.equal(report.rows[0].recount_due, true);
});

test('within the window the owner baseline is not flagged', () => {
  const atlas = loadAtlas({ inventory: [ANGELO], balances: [OLDER_VERIFIED_ZERO] });
  assert.equal(atlas.items[0].stock_recount_due, false);
});

test('an expired newer manager count does not resurrect an older owner confirmation', () => {
  const later = Date.parse('2026-10-05T10:00:00Z');
  const newerCount = { ...OLDER_VERIFIED_ZERO, verified_quantity: '4', verified_at: '2026-09-24T08:00:00Z', expires_at: '2026-10-01T08:00:00Z' };
  const atlas = loadAtlas({ inventory: [ANGELO], balances: [newerCount], now: later });
  assert.equal(atlas.items[0].verified_quantity, null);
  assert.equal(atlas.items[0].freshness_state, 'unknown');
});

test('migration records owner evidence behind a trusted-writer guard and projects only the baseline to staff', () => {
  const sql = read('supabase/migrations/20260924120000_s84_owner_confirmed_stock_evidence.sql');
  assert.match(sql, /add column if not exists source_confirmed_at timestamptz/);
  assert.match(sql, /add column if not exists source_confirmed_quantity numeric/);
  assert.match(sql, /if \(at_set or quantity_set\) and not trusted_server then/);
  assert.match(sql, /create trigger inventory_items_s84_owner_confirmation\s+before insert or update on public\.inventory_items/);
  assert.match(sql, /revoke all on function private\.inventory_owner_confirmation_guard\(\) from public, anon, authenticated;/);
  // The backfill must not re-date rows or touch verified balances, counts or movements.
  assert.match(sql, /disable trigger %I/);
  assert.doesNotMatch(sql, /inventory_verified_balances|inventory_count_lines|inventory_movements/);
  const returns = sql.slice(sql.indexOf('create function private.read_inventory_catalog()'), sql.indexOf('language sql'));
  assert.match(returns, /owner_confirmed_quantity numeric,\s+owner_confirmed_at timestamptz/);
  for (const forbidden of ['source_type', 'source_confidence', 'source_hash', 'source_file', 'cost_price', 'supplier', 'notes', 'import_note']) {
    assert.doesNotMatch(returns, new RegExp(`\\b${forbidden}\\b`), `${forbidden} must stay out of the staff catalogue`);
  }
  assert.match(sql, /revoke all on table public\.inventory_catalog from anon, authenticated, service_role;/);
  assert.match(sql, /grant select on table public\.inventory_catalog to authenticated;/);
  assert.match(sql, /where \(select auth\.uid\(\)\) is not null\s+and \(select private\.is_active_staff\(\)\);/);
});

test('Reports reads the owner confirmation evidence columns', () => {
  const source = read('supabase/functions/atlas-reports/index.ts');
  assert.match(source, /source_type,source_confidence,source_confirmed_at,source_confirmed_quantity/);
});

// The browser only picks up a changed stock-truth module when its cache key
// changes. The pre-S84 module (same URL) kept the older verified zero authoritative.
test('index.html cache keys track the shipped stock-truth and calculation modules', () => {
  const html = read('apps/web/index.html');
  const pins = {
    'atlas-stock-truth.js': { version: '20260924-s87', sha256: 'b0df5d3302ab53985861fd0899a84bc405753fbc4bf4561f0f6754929ec12da0' },
    'atlas-calculations.js': { version: '20260924-s87', sha256: '756c533a507f7d1edf9f7870dfb687a9408e87050f5852b3004e0bc8923f4fb9' }
  };
  for (const [file, pin] of Object.entries(pins)) {
    const sha256 = crypto.createHash('sha256').update(read(`apps/web/assets/js/${file}`)).digest('hex');
    assert.equal(sha256, pin.sha256, `${file} changed: bump its ?v= token in index.html and repin here`);
    assert.ok(html.includes(`<script src="assets/js/${file}?v=${pin.version}"></script>`), `${file} must load with ?v=${pin.version}`);
  }
  assert.ok(!html.includes('atlas-stock-truth.js?v=20260921-s64f'), 'stale pre-S84 stock-truth cache key must not be served');
});
