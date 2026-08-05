import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workspace = readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8');
const extension = readFileSync('apps/web/assets/js/stock-count-l1-verified.js', 'utf8');
const bootstrap = readFileSync('apps/web/assets/js/stock-count-bootstrap.js', 'utf8');
const inventoryBootstrap = readFileSync('apps/web/assets/js/inventory-scanner-bootstrap.js', 'utf8');
const styles = readFileSync('apps/web/assets/css/stock-count-workspace.css', 'utf8');

test('Checkpoint L1 assets are wired through the authenticated inventory bootstrap', () => {
  assert.match(inventoryBootstrap, /STOCK_COUNTS_API/);
  assert.match(inventoryBootstrap, /stock-count-bootstrap\.js/);
  assert.match(inventoryBootstrap, /loadStockCounts/);
  assert.match(bootstrap, /stock-count-workspace\.js/);
  assert.match(bootstrap, /stock-count-l1-verified\.js/);
  assert.match(bootstrap, /await loadScript/);
});

test('the bootstrap validates and repairs the original draft before execution', () => {
  assert.match(workspace, /override\.note \?\? note\?\.value\?\.trim\(\) \|\| null/);
  assert.match(bootstrap, /note: \(override\.note \?\? note\?\.value\?\.trim\(\)\) \|\| null/);
  assert.match(bootstrap, /AtlasStockCountsL1\?\.handleSubmit/);
  assert.match(bootstrap, /new Blob/);
  assert.match(bootstrap, /runtimePatched/);
});

test('mobile count forms expose all supported observation units', () => {
  for (const unit of ['bottle', 'case', 'unit', 'litre', 'millilitre', 'kilogram', 'gram']) {
    assert.match(extension, new RegExp(`${unit}:`));
  }
  assert.match(extension, /data-l1-count-unit/);
  assert.match(extension, /observed_input_quantity/);
  assert.match(extension, /observed_input_unit/);
  assert.match(extension, /l1-conversion-preview/);
});

test('quantity provenance is visible as current, stale, historical or unverified', () => {
  for (const state of ['current', 'stale', 'historical', 'unverified']) {
    assert.match(extension, new RegExp(state));
    assert.match(styles, new RegExp(`is-${state}`));
  }
  assert.match(extension, /l1-classification-strip/);
});

test('manager publication is a separate explicit action', () => {
  assert.match(extension, /prepare-publication/);
  assert.match(extension, /Publish verified count/);
  assert.match(extension, /only L1 step that may change live stock/i);
  assert.match(extension, /window\.confirm/);
  assert.match(extension, /publication_environment_enabled/);
});

test('the UI does not write inventory tables directly', () => {
  assert.doesNotMatch(extension, /\.from\(['"]inventory_items['"]\)/);
  assert.doesNotMatch(extension, /adjust_inventory/);
  assert.match(extension, /api\('save-line'/);
  assert.match(extension, /api\('publish'/);
});

test('mobile layouts and count evidence states have dedicated styles', () => {
  assert.match(styles, /@media\(max-width:680px\)/);
  assert.match(styles, /stock-count-scan-modal/);
  assert.match(styles, /has-source-conflict/);
  assert.match(styles, /l1-publication-banner/);
  assert.match(styles, /l1-conversion-preview/);
});
