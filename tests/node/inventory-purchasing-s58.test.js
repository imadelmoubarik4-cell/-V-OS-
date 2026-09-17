import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('apps/web/index.html', 'utf8');
const css = readFileSync('apps/web/assets/css/inventory-operations-s58.css', 'utf8');
const purchasing = readFileSync('apps/web/assets/js/purchase-orders.js', 'utf8');
const scanner = readFileSync('apps/web/assets/js/inventory-scanner.js', 'utf8');
const counts = readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8');

test('Purchasing keeps supplier controls scoped to the Suppliers tab', () => {
  assert.match(purchasing, /addSupplierButton\.hidden = !suppliersSelected/);
  assert.match(css, /#add-supplier-btn\[hidden\]\{display:none!important\}/);
  assert.match(css, /#purchase-suppliers-panel\{display:grid;gap:12px/);
  assert.match(css, /#purchase-suppliers-panel>\.toolbar/);
});

test('Wine always exposes the four approved subcategory filters', () => {
  assert.match(app, /\['Red', 'White', 'Rosé', 'Sparkling'\]\.map/);
  assert.match(app, /counts\.get\(label\) \|\| 0/);
});

test('Inventory uses supported Lucide icons and controlled waste writes', () => {
  assert.doesNotMatch(scanner, /data-lucide="bottle"/);
  assert.doesNotMatch(counts, /data-lucide="bottle"/);
  assert.match(scanner, /data-lucide="wine"/);
  assert.match(counts, /data-lucide="wine"/);
  assert.match(app, /requireCommercialManager\('Waste recording'\)/);
  assert.match(app, /quantity > Number\(item\.quantity \|\| 0\)/);
  assert.match(app, /This reduces live stock immediately/);
});
