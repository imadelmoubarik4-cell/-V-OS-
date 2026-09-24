// S87: one below-par rule. Before this, Home and Reports' stock section used
// `quantity < par` while Inventory, Operations, Brain, Recipes and Reports'
// recipe mirror used `quantity <= par`, so an item exactly at par was "low" on
// some pages and "healthy" on others. These checks run the shipped browser
// modules and the shipped Reports module against the same rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { buildStockReport, ingredientMetrics } from '../../supabase/functions/_shared/stock-provenance.mjs';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-24T12:00:00Z');

function browser() {
  const context = { Date, Number, Math, Map, Set, String, Array, Object, JSON, console };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('apps/web/assets/js/atlas-stock-truth.js'), context);
  vm.runInContext(read('apps/web/assets/js/atlas-calculations.js'), context);
  return context;
}

const balance = (id, quantity) => ({ inventory_item_id: id, verified_quantity: quantity, freshness_state: 'current', verified_at: '2026-09-23T10:00:00Z', expires_at: '2026-10-20T10:00:00Z' });
const rows = [
  { id: 'at-par', name: 'Exactly at par', quantity: 0, par_level: 6, unit: 'bottles', active: true, cost_price: 1000 },
  { id: 'under', name: 'Under par', quantity: 0, par_level: 6, unit: 'bottles', active: true, cost_price: 1000 },
  { id: 'zero-par', name: 'Zero par', quantity: 0, par_level: 0, unit: 'bottles', active: true, cost_price: 1000 },
  { id: 'unknown', name: 'Not counted', quantity: 0, par_level: 6, unit: 'bottles', active: true, cost_price: 1000 }
];
const balances = [balance('at-par', 6), balance('under', 5), balance('zero-par', 0)];

test('the browser below-par rule is strict, needs a positive par and known stock', () => {
  const { AtlasStockTruth } = browser();
  const projected = AtlasStockTruth.project(rows, balances, [], NOW);
  const low = projected.filter((item) => AtlasStockTruth.belowPar(item)).map((item) => item.id);
  assert.deepEqual(low, ['under']);
});

test('recipe ingredient below-par matches the stock rule in browser and Reports', () => {
  const { AtlasStockTruth, AtlasCalculations } = browser();
  const projected = AtlasStockTruth.project(rows, balances, [], NOW);
  const byId = new Map(projected.map((item) => [item.id, item]));
  for (const item of projected) {
    const ingredient = { item_id: item.id, quantity: 1, unit: 'bottles' };
    const browserResult = AtlasCalculations.ingredientMetrics(ingredient, projected).belowPar;
    const serverResult = ingredientMetrics(ingredient, byId).belowPar;
    assert.equal(browserResult, AtlasStockTruth.belowPar(item), `browser recipe rule for ${item.id}`);
    assert.equal(serverResult, AtlasStockTruth.belowPar(item), `Reports recipe rule for ${item.id}`);
  }
});

test('Reports stock classification agrees with the browser rule', () => {
  const { AtlasStockTruth } = browser();
  const projected = AtlasStockTruth.project(rows, balances, [], NOW);
  const report = buildStockReport(rows, balances, {}, NOW, []);
  const serverLow = new Set((report.rows || report.items || []).filter((row) => row.stock_status === 'below_par' || row.status === 'below_par').map((row) => row.id));
  const browserLow = new Set(projected.filter((item) => AtlasStockTruth.belowPar(item)).map((item) => item.id));
  assert.deepEqual([...serverLow].sort(), [...browserLow].sort());
});

test('no browser module re-implements the below-par comparison', () => {
  for (const file of ['apps/web/index.html', 'apps/web/assets/js/brain.js', 'apps/web/assets/js/operations.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /quantity\)?\s*<=?\s*(Number\()?\s*(i|item)\.par_level/, `${file} must use AtlasStockTruth.belowPar`);
  }
});
