import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyStockTrustToWorkspace,
  buildStockReport,
  quantityTrustState,
  reconcileRecipeStockEvidence,
} from '../../supabase/functions/atlas-reports/stock-provenance.mjs';

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
  const recipeReport = reconcileRecipeStockEvidence({
    summary: {},
    rows: [
      { id: 'historical-recipe', ingredient_count: 1, missing_links: 0, incompatible_units: 0, missing_costs: 0, availability_state: 'unavailable' },
      { id: 'verified-zero-recipe', ingredient_count: 1, missing_links: 0, incompatible_units: 0, missing_costs: 0, availability_state: 'ready' },
      { id: 'healthy-recipe', ingredient_count: 1, missing_links: 0, incompatible_units: 0, missing_costs: 0, availability_state: 'unavailable' },
    ],
  }, [
    { recipe_id: 'historical-recipe', item_id: 'historical' },
    { recipe_id: 'verified-zero-recipe', item_id: 'current-zero' },
    { recipe_id: 'healthy-recipe', item_id: 'current-ok' },
  ], stock);

  assert.equal(recipeReport.rows[0].availability_state, 'incomplete_setup');
  assert.equal(recipeReport.rows[0].estimated_servings_available, null);
  assert.equal(recipeReport.rows[1].availability_state, 'unavailable');
  assert.equal(recipeReport.rows[2].availability_state, 'ready');
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
