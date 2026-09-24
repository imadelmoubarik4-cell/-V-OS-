import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { buildStockReport } from '../../supabase/functions/_shared/stock-provenance.mjs';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-24T12:00:00Z');
const LATER = Date.parse('2026-10-06T12:00:00Z');

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

// Active production rows on owner prep / owner count workflows, as S84 left
// them (no evidence). The S84.1 backfill copies updated_at/quantity into the
// dedicated evidence columns.
const AFFECTED = [
  ['Basil Syrup', 'owner_confirmed_prep', '0', 'liters', '2026-09-23T21:23:48.432963+00:00'],
  ['Chupa Chups Infused Patrón', 'owner_confirmed_prep', '1', 'ml', '2026-09-24T04:26:37.854787+00:00'],
  ['Fresh Orange Juice', 'owner_confirmed_prep', '0', 'liters', '2026-09-24T04:28:19.114438+00:00'],
  ['Pear Liquid Syrup (Diadem)', 'owner_confirmed_prep', '0', 'liters', '2026-09-23T22:24:08.218425+00:00'],
  ['Pear Syrup', 'owner_confirmed_prep', '0', 'liters', '2026-09-23T21:23:48.432963+00:00'],
  ['Popcorn-infused Woodford Bourbon', 'owner_confirmed_prep', '0', 'ml', '2026-09-24T04:30:24.814999+00:00'],
  ['Saline Solution', 'owner_confirmed_prep', '0', 'ml', '2026-09-24T04:30:53.398604+00:00'],
  ['Simple Syrup', 'owner_confirmed_prep', '0', 'liters', '2026-09-23T21:23:48.432963+00:00'],
  ['Haframjólk Natrue Barista 1L', 'owner_verified_count', '0', 'units', '2026-09-23T22:15:29.874674+00:00'],
  ['Kirsuber m/stilk rauð 2kg', 'owner_verified_count', '1', 'units', '2026-09-23T22:16:36.06725+00:00'],
  ['Pickwick Finest Earl Grey', 'owner_verified_count', '6', 'boxes', '2026-09-23T22:15:29.874674+00:00'],
  ['Pickwick Finest English Tea', 'owner_verified_count', '6', 'boxes', '2026-09-23T22:15:29.874674+00:00'],
  ['Pickwick Green Tea', 'owner_verified_count', '11', 'boxes', '2026-09-23T22:15:29.874674+00:00'],
  ['Pickwick Peppermint', 'owner_verified_count', '3', 'boxes', '2026-09-23T22:15:29.874674+00:00'],
  ['Teisseire Pomegranate Grenadine', 'owner_verified_count', '1', 'bottles', '2026-09-22T19:49:48.310344+00:00']
].map(([name, source_type, quantity, unit, updated_at], index) => ({
  id: `s84-1-${index}`, name, source_type, source_confidence: 100, quantity, unit, updated_at, active: true,
  source_confirmed_at: null, source_confirmed_quantity: null
}));

const backfilled = (row) => ({ ...row, source_confirmed_at: row.updated_at, source_confirmed_quantity: row.quantity });
const staffView = (row) => ({
  id: row.id, name: row.name, quantity: row.quantity, unit: row.unit, updated_at: row.updated_at,
  size_ml: row.size_ml, owner_confirmed_quantity: row.source_confirmed_quantity, owner_confirmed_at: row.source_confirmed_at
});
const byName = (name) => backfilled(AFFECTED.find((row) => row.name === name));

const ANGELO = {
  id: 'angelo', name: 'Angelo Pinot Grigio', quantity: '10', unit: 'bottles', size_ml: '750', cost_price: 2000,
  source_type: 'owner_confirmed', source_confidence: 100,
  source_confirmed_at: '2026-09-23T22:14:07.789111+00:00', source_confirmed_quantity: '10',
  updated_at: '2026-09-23T22:14:07.789111+00:00'
};
const ANGELO_ZERO = {
  inventory_item_id: 'angelo', verified_quantity: '0', verification_status: 'current', freshness_state: 'current',
  verified_at: '2026-09-21T19:36:22.690674+00:00', expires_at: '2026-09-28T19:36:22.690674+00:00'
};
const ANGELO_RECIPE = {
  id: 'angelo-recipe', name: 'Angelo Pinot Grigio', active: true, yield_quantity: '1', menu_price: 2500,
  recipe_ingredients: [{ item_id: 'angelo', item_name: 'Angelo Pinot Grigio', quantity: '150', unit: 'ml' }]
};

test('before the S84.1 backfill these rows have no evidence and are Unknown (the regression)', () => {
  const atlas = loadAtlas({ inventory: AFFECTED });
  assert.equal(atlas.items.filter((item) => atlas.AtlasStockTruth.known(item)).length, 0);
});

test('1. owner_confirmed_prep with dedicated evidence is known', () => {
  const [item] = loadAtlas({ inventory: [byName('Basil Syrup')] }).items;
  assert.equal(item.freshness_state, 'current');
  assert.equal(item.verified_quantity, 0);
  assert.equal(item.stock_source, 'owner_confirmed');
});

test('2. owner_verified_count with dedicated evidence is known', () => {
  const [item] = loadAtlas({ inventory: [byName('Pickwick Green Tea')] }).items;
  assert.equal(item.freshness_state, 'current');
  assert.equal(item.verified_quantity, 11);
});

test('3. Fresh Orange Juice confirmed at 0 liters shows 0, not Unknown', () => {
  const atlas = loadAtlas({ inventory: [byName('Fresh Orange Juice')] });
  const [item] = atlas.items;
  assert.equal(atlas.AtlasStockTruth.known(item), true);
  assert.equal(item.quantity, 0);
  assert.equal(item.unit, 'liters');
});

test('4. Chupa Chups Infused Patrón confirmed at 1 shows 1, not Unknown', () => {
  const atlas = loadAtlas({ inventory: [byName('Chupa Chups Infused Patrón')] });
  assert.equal(atlas.AtlasStockTruth.known(atlas.items[0]), true);
  assert.equal(atlas.items[0].quantity, 1);
});

test('all 15 affected production rows resolve after backfill, for managers, staff and Reports', () => {
  const rows = AFFECTED.map(backfilled);
  const manager = loadAtlas({ inventory: rows }).items;
  const report = buildStockReport(rows, [], {}, NOW, []);
  assert.equal(manager.length, 15);
  for (const item of manager) assert.equal(item.freshness_state, 'current', item.name);
  for (const row of report.rows) assert.equal(row.quantity_status, 'current', row.name);
  assert.deepEqual(manager.map((item) => item.quantity), rows.map((row) => Number(row.quantity)));
  assert.deepEqual(report.rows.map((row) => row.quantity).sort(), rows.map((row) => Number(row.quantity)).sort());
});

test('5. staff reach the same operational quantity through inventory_catalog', () => {
  const rows = AFFECTED.map(backfilled);
  const manager = loadAtlas({ inventory: rows }).items;
  const staff = loadAtlas({ inventory: rows.map(staffView) }).items;
  assert.deepEqual(staff.map((item) => item.quantity), manager.map((item) => item.quantity));
  assert.ok(staff.every((item) => item.freshness_state === 'current' && !('source_type' in item)));
});

test('6. Angelo still resolves to 10 bottles x 750 ml / 150 ml = 50 servings', () => {
  const atlas = loadAtlas({ inventory: [ANGELO], balances: [ANGELO_ZERO], recipes: [ANGELO_RECIPE] });
  assert.equal(atlas.items[0].verified_quantity, 10);
  const availability = atlas.AtlasRecipes.recipeAvailability(ANGELO_RECIPE);
  assert.equal(availability.servings, 50);
  assert.notEqual(availability.status, 'unavailable');
});

test('7. a newer manager count still beats an older owner confirmation', () => {
  const tea = byName('Pickwick Peppermint');
  const newer = { inventory_item_id: tea.id, verified_quantity: '2', freshness_state: 'current', verified_at: '2026-09-24T08:00:00Z', expires_at: '2026-10-01T08:00:00Z' };
  assert.equal(loadAtlas({ inventory: [tea], balances: [newer] }).items[0].verified_quantity, 2);
  assert.equal(buildStockReport([tea], [newer], {}, NOW, []).rows[0].quantity_source, 'manager_verified_count');
});

test('a newer owner confirmation beats an older manager count, then movements apply once', () => {
  const juice = { ...byName('Fresh Orange Juice'), source_confirmed_quantity: '2', quantity: '1.5', updated_at: '2026-09-24T09:00:00Z' };
  const older = { inventory_item_id: juice.id, verified_quantity: '4', freshness_state: 'current', verified_at: '2026-09-22T13:35:28Z', expires_at: '2026-09-29T13:35:28Z' };
  const movements = [{ item_id: juice.id, movement_type: 'waste', quantity_change: -0.5, created_at: '2026-09-24T09:00:00Z' }];
  assert.equal(loadAtlas({ inventory: [juice], balances: [older], movements }).items[0].verified_quantity, 1.5);
  assert.equal(buildStockReport([juice], [older], {}, NOW, movements).rows[0].quantity, 1.5);
});

test('8. price, par and category edits do not re-date an owner confirmation', () => {
  const tea = byName('Pickwick Finest Earl Grey');
  const edited = { ...tea, cost_price: 999, par_level: 4, category: 'Tea', updated_at: '2026-09-24T11:00:00Z' };
  const between = { inventory_item_id: tea.id, verified_quantity: '5', freshness_state: 'current', verified_at: '2026-09-24T10:00:00Z', expires_at: '2026-10-01T10:00:00Z' };
  assert.equal(loadAtlas({ inventory: [edited], balances: [between] }).items[0].verified_quantity, 5);
  assert.equal(buildStockReport([edited], [between], {}, NOW, []).rows[0].quantity, 5);
});

test('9. owner stock stays known past the freshness window and is flagged recount due', () => {
  const tea = byName('Pickwick Green Tea');
  const [item] = loadAtlas({ inventory: [tea], now: LATER }).items;
  assert.equal(item.verified_quantity, 11);
  assert.equal(item.stock_recount_due, true);
  const report = buildStockReport([tea], [], {}, LATER, []);
  assert.equal(report.rows[0].quantity_status, 'current');
  assert.equal(report.rows[0].recount_due, true);
  assert.equal(loadAtlas({ inventory: [tea] }).items[0].stock_recount_due, false);
});

test('an expired newer manager count does not resurrect older owner evidence', () => {
  const tea = byName('Pickwick Green Tea');
  const expired = { inventory_item_id: tea.id, verified_quantity: '9', freshness_state: 'current', verified_at: '2026-09-25T08:00:00Z', expires_at: '2026-10-02T08:00:00Z' };
  assert.equal(loadAtlas({ inventory: [tea], balances: [expired], now: LATER }).items[0].freshness_state, 'unknown');
});

test('10. reconciliation never rewrites verified balances, movements or inventory rows', () => {
  const rows = [ANGELO, ...AFFECTED.map(backfilled)];
  const balances = [ANGELO_ZERO];
  const movements = [{ item_id: rows[1].id, movement_type: 'restock', quantity_change: 1, created_at: '2026-09-24T10:00:00Z' }];
  const snapshot = structuredClone({ rows, balances, movements });
  loadAtlas({ inventory: rows, balances, movements });
  buildStockReport(rows, balances, {}, NOW, movements);
  assert.deepEqual({ rows, balances, movements }, snapshot);
});

test('runtime trusts server-gated evidence without a source_type whitelist', () => {
  const futureWorkflow = { ...byName('Saline Solution'), source_type: 'owner_workflow_added_later' };
  assert.equal(loadAtlas({ inventory: [futureWorkflow] }).items[0].freshness_state, 'current');
  assert.equal(buildStockReport([futureWorkflow], [], {}, NOW, []).rows[0].quantity_status, 'current');
  for (const file of ['apps/web/assets/js/atlas-stock-truth.js', 'supabase/functions/_shared/stock-provenance.mjs']) {
    assert.doesNotMatch(read(file), /OWNER_CONFIRMED_TYPES/, `${file} must not gate evidence by source_type`);
  }
});

test('pre-S84 rows (no evidence columns) use the legacy rule, now covering prep and owner counts', () => {
  const legacy = AFFECTED.map(({ source_confirmed_at, source_confirmed_quantity, ...row }) => row);
  assert.ok(loadAtlas({ inventory: legacy }).items.every((item) => item.freshness_state === 'current'));
  assert.ok(buildStockReport(legacy, [], {}, NOW, []).rows.every((row) => row.quantity_status === 'current'));
  const untrusted = { ...legacy[0], source_type: 'owner_approved_unverified_stock' };
  assert.equal(loadAtlas({ inventory: [untrusted] }).items[0].freshness_state, 'unknown');
});

test('S84.1 migration keeps evidence server-gated, the staff view safe and history untouched', () => {
  const sql = read('supabase/migrations/20260924150000_s84_1_trusted_owner_stock_workflows.sql');
  const trusted = sql.slice(sql.indexOf('create or replace function private.is_trusted_owner_stock_source'), sql.indexOf('revoke all on function private.is_trusted_owner_stock_source'));
  for (const type of ['owner_confirmed', 'owner_confirmed_supplier_price', 'owner_confirmed_prep', 'owner_verified_count']) {
    assert.match(trusted, new RegExp(`'${type}'`));
  }
  assert.doesNotMatch(trusted, /owner_approved_unverified_stock/);
  assert.match(trusted, /p_source_confidence = 100/);
  assert.match(sql, /if \(at_set or quantity_set\) and not trusted_server then/);
  assert.match(sql, /Owner stock evidence requires a trusted owner workflow with confidence 100/);
  assert.match(sql, /and source_confirmed_at is null\s+and source_confirmed_quantity is null/);
  assert.match(sql, /disable trigger %I/);
  assert.doesNotMatch(sql, /inventory_verified_balances|inventory_count_(?:sessions|lines)|inventory_movements|delete from|truncate/i);
  // The view is not recreated, so security_invoker and grants stay as S84 set them.
  assert.doesNotMatch(sql, /drop view|create (?:or replace )?view/i);
  const returns = sql.slice(sql.indexOf('create or replace function private.read_inventory_catalog()'), sql.indexOf('language sql\nstable\nsecurity definer'));
  assert.match(returns, /owner_confirmed_quantity numeric,\s+owner_confirmed_at timestamptz\s+\)/);
  for (const forbidden of ['source_type', 'source_confidence', 'source_hash', 'source_file', 'cost_price', 'case_cost', 'supplier', 'notes', 'import_note']) {
    assert.doesNotMatch(returns, new RegExp(`\\b${forbidden}\\b`), `${forbidden} must stay out of the staff catalogue`);
  }
  assert.match(sql, /revoke execute on function private\.read_inventory_catalog\(\) from public, anon, service_role;/);
  assert.match(sql, /revoke all on function private\.is_trusted_owner_stock_source\(text, numeric\) from public, anon, authenticated;/);
});
