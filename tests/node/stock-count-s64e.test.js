import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// S88: the S64E count-unit and variance rules now live in
// stock-count-workspace.js (the L1 extension was merged into it). The pure
// helpers are exported on AtlasStockCounts and exercised here.
const source = fs.readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8');

function load() {
  const window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
  const context = vm.createContext({ window, document: { addEventListener() {} }, console });
  vm.runInContext(source, context, { filename: 'stock-count-workspace.js' });
  return window.AtlasStockCounts;
}
const counts = load();

test('unknown baseline is labelled unknown and never generates zero variance', () => {
  assert.equal(counts.varianceText(null), 'No earlier count');
  assert.equal(counts.varianceText(0.8), '+0.8');
  assert.match(source, /if \(baseline === null\) return null;/);
});

test('explicit observed and baseline zero retain no difference', () => {
  assert.equal(counts.varianceText(0), 'No difference');
});

test('empty quantity is not a zero count', () => {
  assert.equal(counts.previewNormalization({ inventory_unit: 'bottles' }, '', 'inventory'), null);
  assert.match(counts.parseQuantity('').error, /Use 0 if there are none/);
  assert.equal(counts.parseQuantity('0').value, 0);
  assert.equal(counts.parseQuantity('1,7').value, 1.7);
  assert.match(counts.parseQuantity('1.2345').error, /three decimal/);
});

test('pieces cannot become boxes even with stale server options', () => {
  const line = { inventory_unit: 'boxes', supported_count_units: ['inventory', 'unit'] };
  assert.equal(counts.previewNormalization(line, 8, 'unit'), null);
  assert.deepEqual([...counts.countUnits(line)], ['inventory']);
  assert.equal(counts.previewNormalization(line, 1, 'inventory').normalized, 1);
});

test('two 400 ml containers convert to 0.8 liters', () => {
  assert.equal(counts.previewNormalization({ inventory_unit: 'liters', size_ml_snapshot: 400 }, 2, 'unit').normalized, 0.8);
  assert.equal(counts.previewText({ inventory_unit: 'liters', size_ml_snapshot: 400 }, '2', 'unit'), 'Saves as 0.8 liters.');
});

test('a case of six 700 ml bottles counts as six bottles, and missing pack sizes are refused', () => {
  assert.equal(counts.previewNormalization({ inventory_unit: 'bottles', units_per_case_snapshot: 6 }, 1, 'case').normalized, 6);
  assert.equal(counts.previewNormalization({ inventory_unit: 'bottles' }, 1, 'case'), null);
  assert.equal(counts.previewNormalization({ inventory_unit: 'bottles', size_ml_snapshot: 700 }, 1.4, 'litre').normalized, 2);
  assert.match(counts.previewText({ inventory_unit: 'kg' }, '3', 'unit'), /missing its pack size/);
  assert.equal(counts.quantityFamily('ml'), 'millilitre');
});
