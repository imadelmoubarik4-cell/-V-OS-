import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// S88: Movements and Waste are tabs of the Inventory page, owned by
// assets/js/atlas-inventory.js (routes #inventory/movements, #inventory/waste).
const app = readFileSync('apps/web/index.html', 'utf8');
const inventory = readFileSync('apps/web/assets/js/atlas-inventory.js', 'utf8');

test('Movements and Waste navigate to dedicated views inside Inventory', () => {
  assert.match(inventory, /shell\.registerView\('movements', \{ \.\.\.definition\('movements'\)/);
  assert.match(inventory, /shell\.registerView\('waste', \{ \.\.\.definition\('waste'\)/);
  assert.match(app, /movements: 'inventory-view', waste: 'inventory-view'/);
  assert.doesNotMatch(app, /id="movements-view"|id="waste-view"/);
});

test('both views use live movement evidence instead of placeholder pages', () => {
  // S89: movements are read in pages up to AtlasStockTruth.MOVEMENT_ROW_LIMIT.
  assert.match(app, /rows\.push\(\.\.\.\(data \|\| \[\]\)\);/);
  assert.match(app, /inventoryMovements = rows;/);
  assert.match(app, /movements: \(\) => inventoryMovements,/);
  assert.match(inventory, /function movements\(\) \{ return root\.AtlasData\?\.movements\?\.\(\) \|\| \[\]; \}/);
  // Ordinary negative adjustments are never reclassified as waste.
  assert.match(inventory, /const list = movements\(\)\.filter\(\(entry\) => entry\.movement_type === 'waste'\);/);
  assert.match(inventory, /p_movement_type: 'waste'/);
  assert.match(inventory, /p_quantity_change: -quantity/);
  assert.doesNotMatch(app + inventory, /data-unavailable-view="(?:movements|waste)"|showUnavailable/);
});

test('search recognizes Movements and Waste as pages', () => {
  // S88: the palette's "Go to" section lists them under Inventory (spec §3.4 routes).
  const search = readFileSync('apps/web/assets/js/atlas-search.js', 'utf8');
  assert.match(search, /\['inventory', 'Inventory › Movements', '#inventory\/movements', \['movement'/);
  assert.match(search, /\['inventory', 'Inventory › Waste', '#inventory\/waste', \['waste', 'spoilage', 'breakage'\]\]/);
});
