import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('apps/web/index.html', 'utf8');
const bootstrap = readFileSync('apps/web/assets/js/stock-count-bootstrap.js', 'utf8');

test('Movements and Waste navigate to dedicated V1 views', () => {
  assert.match(app, /data-view="movements" data-subview="Inventory movements"/);
  assert.match(app, /data-view="waste" data-subview="Waste"/);
  assert.match(app, /movements: document\.getElementById\('movements-view'\)/);
  assert.match(app, /waste: document\.getElementById\('waste-view'\)/);
  assert.match(app, /movements:'Inventory movements'/);
  assert.match(app, /waste:'Waste'/);
});

test('both views use live movement evidence instead of placeholder pages', () => {
  assert.match(app, /id="movements-view" class="inventory-ledger-view"/);
  assert.match(app, /id="movement-history-body"/);
  assert.match(app, /inventoryMovements = data \|\| \[\]/);
  assert.match(app, /id="waste-view" class="inventory-ledger-view"/);
  assert.match(app, /id="inventory-waste-form"/);
  assert.match(app, /p_movement_type: 'waste'/);
  assert.match(app, /p_quantity_change: -quantity/);
  assert.match(app, /Ordinary negative adjustments are never reclassified as waste/);
  assert.doesNotMatch(app, /data-unavailable-view="(?:movements|waste)"/);
  assert.doesNotMatch(bootstrap, /showUnavailable/);
  assert.doesNotMatch(bootstrap, /target\.closest\('\[data-subview="Inventory movements"\]'\)/);
});

test('navigation search recognizes Movements and Waste as commands', () => {
  assert.match(app, /q\.includes\('movement'\)\)setActiveView\('movements'\)/);
  assert.match(app, /q\.includes\('waste'\).*setActiveView\('waste'\)/);
});
