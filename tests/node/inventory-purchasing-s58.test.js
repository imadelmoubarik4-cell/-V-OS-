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

test('Wine grouping uses stored category and excludes inactive rows from live inventory', () => {
  assert.match(app, /test\(category\)\) return 'wine'/);
  assert.match(app, /const categoryValue = `\$\{stored\} \$\{category\}`\.toLowerCase\(\)/);
  assert.match(app, /if \(item\.active === false\) return false/);
  assert.match(app, /const currentItems = items\.filter\(item => item\.active !== false\)/);
});

test('Inventory grouping prioritizes stored category over misleading product-name words', () => {
  assert.match(app, /if \(\/soda\|mixer\|juice\|tonic\|soft drink\|energy drink\/\.test\(category\)\) return 'mixers'/);
  assert.match(app, /if \(\/vodka\|gin\|whisk/);
  assert.match(app, /Product-name words such as/);
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
