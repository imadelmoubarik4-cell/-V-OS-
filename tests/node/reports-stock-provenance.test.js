import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyStockTrustToWorkspace,
  buildStockReport,
  buildRecipeReport,
  quantityTrustState,
} from '../../supabase/functions/atlas-reports/stock-provenance.mjs';

test('S64F unknown valuation and alert coverage are not displayed as zero', () => {
  const items = [{id:'unverified', name:'Test item', quantity:0, cost_price:100}];
  const stock = buildStockReport(items, []);
  const result = applyStockTrustToWorkspace({kpis:[{key:'inventory_value',value:0},{key:'stock_alerts',value:1}]}, stock);
  assert.equal(stock.summary.estimated_value, null);
  assert.equal(stock.categories[0].estimated_value, null);
  assert.equal(result.kpis[0].value, null);
  assert.equal(result.kpis[1].value, null);
  const verified = buildStockReport(items, [{inventory_item_id:'unverified', freshness_state:'current',verified_quantity:0}]);
  assert.equal(verified.summary.estimated_value, 0);
  assert.equal(verified.rows[0].estimated_value, 0);
});

const NOW = Date.parse('2026-09-15T12:00:00Z');
const inventory = [
  { id: 'historical', name: 'Historical zero', quantity: 0, par_level: 2, active: true, source_updated_at: '2026-07-26', cost_price: 100 },
  { id: 'unverified', name: 'Unverified zero', quantity: 0, par_level: 2, active: true, source_updated_at: '2026-09-01', cost_price: 100 },
  { id: 'stale', name: 'Stale zero', quantity: 0, par_level: 2, active: true, source_updated_at: '2026-09-01', cost_price: 100 },
  { id: 'current-zero', name: 'Verified zero', quantity: 8, par_level: 2, active: true, source_updated_at: '2026-09-01', cost_price: 100 },
  { id: 'current-low', name: 'Verified low', quantity: 8, par_level: 5, active: true, source_updated_at: '2026-09-01', cost_price: 100 },
  { id: 'current-ok', name: 'Verified healthy', quantity: 0, par_level: 2, active: true, source_updated_at: '2026-09-01', cost_price: 100 },
].map((item) => ({ ...item, supplier: 'Test supplier' }));
const balances = [
  { inventory_item_id: 'stale', verified_quantity: 0, freshness_state: 'stale', verified_at: '2026-08-01T00:00:00Z' },
  { inventory_item_id: 'current-zero', verified_quantity: 0, freshness_state: 'current', verified_at: '2026-09-15T10:00:00Z', expires_at: '2026-09-20T00:00:00Z' },
  { inventory_item_id: 'current-low', verified_quantity: 2, freshness_state: 'current', verified_at: '2026-09-15T10:00:00Z', expires_at: '2026-09-20T00:00:00Z' },
  { inventory_item_id: 'current-ok', verified_quantity: 6, freshness_state: 'current', verified_at: '2026-09-15T10:00:00Z', expires_at: '2026-09-20T00:00:00Z' },
];

test('quantity trust requires an unexpired verified balance', () => {
  assert.equal(quantityTrustState(inventory[0], null, NOW), 'historical');
  assert.equal(quantityTrustState(inventory[1], null, NOW), 'unverified');
  assert.equal(quantityTrustState(inventory[2], balances[0], NOW), 'stale');
  assert.equal(quantityTrustState(inventory[3], balances[1], NOW), 'current');
});

test('historical, stale and unverified zeros never become live stock alerts', () => {
  const report = buildStockReport(inventory, balances, {}, NOW);
  assert.deepEqual(report.summary, {
    active_items: 6,
    current_items: 3,
    stale_items: 1,
    historical_items: 1,
    unverified_items: 1,
    needs_current_count: 3,
    estimated_value: 800,
    current_missing_cost: 0,
    valuation_excluded_items: 3,
    below_par: 1,
    out_of_stock: 1,
    missing_cost: 0,
    missing_supplier: 0,
    missing_par: 0,
    recently_updated: 3,
  });
  assert.equal(report.rows.find((row) => row.id === 'historical').status, 'historical');
  assert.equal(report.rows.find((row) => row.id === 'unverified').status, 'unverified');
  assert.equal(report.rows.find((row) => row.id === 'stale').status, 'stale');
  assert.equal(report.rows.find((row) => row.id === 'current-zero').status, 'out_of_stock');
  assert.equal(report.rows.find((row) => row.id === 'current-low').status, 'below_par');
  assert.equal(report.rows.find((row) => row.id === 'current-ok').status, 'ok');
  assert.equal(report.rpc_inventory.find((row) => row.id === 'historical').quantity, null);
  assert.equal(report.rpc_inventory.find((row) => row.id === 'current-ok').quantity, 6);
});

test('recipe availability refuses to treat unverified stock as unavailable', () => {
  const stock = buildStockReport(inventory, balances, {}, NOW);
  const recipes = ['historical-recipe', 'verified-zero-recipe', 'healthy-recipe'].map((id) => ({ id, name: id, active: true, yield_quantity: 1 }));
  const recipeReport = buildRecipeReport(recipes, [
    { recipe_id: 'historical-recipe', item_id: 'historical', quantity: 0.25, unit: 'bottle' },
    { recipe_id: 'verified-zero-recipe', item_id: 'current-zero', quantity: 0.25, unit: 'bottle' },
    { recipe_id: 'healthy-recipe', item_id: 'current-ok', quantity: 0.25, unit: 'bottle' },
  ], inventory, stock);
  const state = (id) => recipeReport.rows.find((row) => row.id === id);

  assert.equal(state('historical-recipe').availability_state, 'incomplete_setup');
  assert.equal(state('historical-recipe').estimated_servings_available, null);
  assert.equal(state('verified-zero-recipe').availability_state, 'unavailable');
  assert.equal(state('healthy-recipe').availability_state, 'ready');
  assert.equal(state('healthy-recipe').estimated_servings_available, 24);
  assert.equal(recipeReport.summary.unavailable, 1);
  assert.equal(recipeReport.summary.stock_evidence_unverified, 1);
});

test('workspace stock KPI and attention use reconciled verified counts', () => {
  const stock = buildStockReport(inventory, balances, {}, NOW);
  const reconciled = applyStockTrustToWorkspace({
    reports: { inventory: {}, overview: { summary: {} } },
    kpis: [{ key: 'stock_alerts', value: 18, detail: 'raw quantity alerts' }],
    attention: [{ key: 'inventory-out-stock', title: '18 items are out of stock' }],
    data_sources: [{ key: 'inventory', status: 'connected' }],
    filter_options: { statuses: ['ok', 'out_of_stock'] },
    trust: {},
  }, stock, null);

  assert.equal(reconciled.reports.inventory.summary.out_of_stock, 1);
  assert.equal(reconciled.kpis[0].value, 2);
  assert.equal(reconciled.attention.some((item) => item.title === '18 items are out of stock'), false);
  assert.equal(reconciled.trust.historical_stock_used_as_live_alert, false);
  assert.match(reconciled.data_sources[0].note, /current manager-verified counts only/i);
});

test('newer owner-confirmed physical stock replaces an older verified zero in reports', () => {
  const now = Date.parse('2026-09-24T09:00:00Z');
  const items = [{
    id:'angelo',
    name:'Angelo Pinot Grigio',
    quantity:10,
    unit:'bottles',
    par_level:2,
    active:true,
    source_type:'owner_confirmed',
    source_confidence:100,
    updated_at:'2026-09-23T22:14:07Z',
    cost_price:1874,
    supplier:'Ölgerðin'
  }];
  const balances = [{
    inventory_item_id:'angelo',
    verified_quantity:0,
    freshness_state:'current',
    verified_at:'2026-09-21T19:36:22Z',
    expires_at:'2026-09-28T19:36:22Z'
  }];
  const report = buildStockReport(items, balances, {}, now, []);
  assert.equal(report.rows[0].quantity,10);
  assert.equal(report.rows[0].quantity_status,'current');
  assert.equal(report.rows[0].quantity_source,'owner_confirmed');
  assert.equal(report.rows[0].status,'ok');
  assert.equal(report.summary.out_of_stock,0);
});

test('post-baseline movements are applied to report stock truth', () => {
  const now = Date.parse('2026-09-24T09:00:00Z');
  const items = [{
    id:'a',
    name:'Test',
    quantity:10,
    active:true,
    source_type:'owner_confirmed_supplier_price',
    source_confidence:100,
    updated_at:'2026-09-23T20:00:00Z',
    cost_price:100,
    supplier:'Supplier'
  }];
  const balances = [{
    inventory_item_id:'a',
    verified_quantity:7,
    freshness_state:'current',
    verified_at:'2026-09-22T10:00:00Z',
    expires_at:'2026-09-29T10:00:00Z'
  }];
  const movements = [
    {item_id:'a',movement_type:'sale',quantity_change:-2,created_at:'2026-09-23T21:00:00Z'},
    {item_id:'a',movement_type:'restock',quantity_change:1,created_at:'2026-09-24T08:00:00Z'}
  ];
  const report = buildStockReport(items, balances, {}, now, movements);
  assert.equal(report.rows[0].quantity,9);
  assert.equal(report.rows[0].movement_delta,-1);
});
