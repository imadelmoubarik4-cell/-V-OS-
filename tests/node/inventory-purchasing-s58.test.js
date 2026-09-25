import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// S88: Inventory lives in assets/js/atlas-inventory.js, Purchasing in
// assets/js/atlas-purchasing.js and the count flow in stock-count-workspace.js.
// The S58 guarantees are asserted against those modules.
const app = readFileSync('apps/web/index.html', 'utf8');
const inventory = readFileSync('apps/web/assets/js/atlas-inventory.js', 'utf8');
const purchasing = readFileSync('apps/web/assets/js/atlas-purchasing.js', 'utf8');
const counts = readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8');
const capture = readFileSync('apps/web/assets/js/atlas-capture.js', 'utf8');

test('Purchasing keeps supplier controls scoped to the Suppliers tab', () => {
  assert.match(purchasing, /const actions = state\.section === 'suppliers'\n\s+\? \[\{ label: 'Add supplier'/);
  assert.match(purchasing, /\['orders', 'Orders', '#purchasing\/orders'\], \['deliveries', 'Deliveries', '#purchasing\/deliveries'\], \['suppliers', 'Suppliers', '#purchasing\/suppliers'\]/);
  // Staff see a permission state instead of manager controls.
  assert.match(purchasing, /Purchasing is for managers/);
});

test('Inventory filters use stored categories and keep inactive rows out of live stock', () => {
  assert.doesNotMatch(app, /function inventoryGroup\(item\)/);
  assert.match(inventory, /if \(state\.activity === 'active' && item\.active === false\) return false;/);
  assert.match(inventory, /if \(state\.activity === 'inactive' && item\.active !== false\) return false;/);
  assert.match(inventory, /items\(\)\.filter\(\(item\) => item\.active !== false\)/);
});

test('Inventory uses supported Lucide icons and controlled waste writes', () => {
  for (const source of [inventory, counts, capture, purchasing]) {
    assert.doesNotMatch(source, /data-lucide="bottle"|icon\('bottle'\)/);
  }
  // Waste is manager-only, capped at the stock on hand and written through
  // the idempotent adjust_inventory_v2 (S90 P2-2: one request id per dialog).
  assert.match(inventory, /shell\.registerView\('waste', \{ \.\.\.definition\('waste'\), guard: \(\) => \(isManager\(\) \? true : 'inventory'\) \}\)/);
  assert.match(inventory, /quantity > \(num\(item\.quantity\) \|\| 0\)/);
  assert.match(inventory, /adjustStock\(\{\s*requestId, itemId: item\.id, change: -quantity, type: 'waste'/);
  assert.match(inventory, /rpc\('adjust_inventory_v2', \{\s*p_request_id: requestId,/);
  assert.match(inventory, /Waste wasn’t recorded\./);
});
