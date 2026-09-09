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

test('the repository source is valid and the bootstrap retains scoped runtime safeguards', () => {
  assert.doesNotMatch(workspace, /note: override\.note \?\? note\?\.value\?\.trim\(\) \|\| null/);
  assert.match(workspace, /note: \(override\.note \?\? note\?\.value\?\.trim\(\)\) \|\| null/);
  assert.match(workspace, /AtlasStockCountsL1\?\.handleSubmit/);
  assert.doesNotMatch(bootstrap, /override\.note/);
  assert.match(bootstrap, /await loadStockCountCore\(\)/);
  assert.match(bootstrap, /installStockCountReentryGuard\(\)/);
  assert.match(bootstrap, /mutationIsLucideOnly/);
  assert.match(bootstrap, /observeEnhancementTarget/);
  assert.match(bootstrap, /new Blob\(\[source\]/);
  assert.match(bootstrap, /extensionRuntimePatched/);
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

test('count controls and modal use the shared light-blue visual system', () => {
  assert.match(styles, /\.stock-count-primary\{[^}]*var\(--atlas-home-accent/);
  assert.match(styles, /\.stock-count-controls\{[^}]*minmax\(280px,1fr\)[^}]*minmax\(150px,190px\)/);
  assert.match(styles, /\.stock-count-controls input\{[^}]*width:100%[^}]*min-width:0/);
  assert.match(styles, /\.stock-count-form-grid input,\.stock-count-form-grid select,\.stock-count-form-grid textarea\{[^}]*background:#fff[^}]*color:var\(--atlas-text/);
  assert.match(styles, /\.stock-count-modal h2,\.stock-count-scan-modal h2\{[^}]*color:var\(--atlas-text/);
});
