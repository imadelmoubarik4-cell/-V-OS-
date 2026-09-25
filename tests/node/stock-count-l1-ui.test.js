import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';

// S88 §7.6: the Checkpoint L1 workspace and its verified-count extension are
// one module (stock-count-workspace.js), loaded by index.html like every other
// module. The L1 guarantees are asserted against it.
const workspace = readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8');
const index = readFileSync('apps/web/index.html', 'utf8');
const config = readFileSync('apps/web/config.js', 'utf8');
const styles = readFileSync('apps/web/assets/css/inventory.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('the count module loads directly; the bootstraps and L1 extension are retired', () => {
  for (const file of ['stock-count-bootstrap.js', 'stock-count-l1-verified.js', 'inventory-scanner-bootstrap.js']) {
    assert.equal(existsSync(`apps/web/assets/js/${file}`), false, `${file} is removed`);
    assert.doesNotMatch(index + config, new RegExp(file.replace('.', '\\.')));
  }
  assert.equal(existsSync('apps/web/assets/css/stock-count-workspace.css'), false);
  assert.match(index, /<script src="assets\/js\/stock-count-workspace\.js\?v=[^"]+"><\/script>/);
  assert.match(workspace, /function endpoint\(\) \{ return String\(root\.VABAR_CONFIG\?\.STOCK_COUNTS_API \|\| ''\)\.trim\(\); \}/);
});

test('the count needs no observers and follows the shell routes', () => {
  assert.doesNotMatch(workspace, /new MutationObserver|new Blob|createObjectURL/);
  assert.doesNotMatch(workspace, /addEventListener\('click', \w+, true\)/);
  assert.match(workspace, /shell\?\.on\?\.\('view:before-show'/);
  assert.match(workspace, /params\.section !== 'stock-count' \|\| !params\.session/);
  // The phone tab bar hides while counting (spec §7.6).
  assert.match(workspace, /document\.body\.classList\.add\('stock-count-active'\);\n\s+root\.AtlasChrome\?\.setTabBarHidden\?\.\('stock-count', true\);/);
});

test('count forms expose the supported observation units with a live conversion', () => {
  for (const unit of ['bottle', 'case', 'unit', 'litre', 'millilitre', 'kilogram', 'gram']) {
    assert.match(workspace, new RegExp(`${unit}: `));
  }
  assert.match(workspace, /data-count-unit/);
  assert.match(workspace, /observed_input_quantity/);
  assert.match(workspace, /observed_input_unit/);
  assert.match(workspace, /data-count-hint aria-live="polite"/);
});

test('manager verification and the stock update are separate, explicit actions', () => {
  assert.match(workspace, /title: 'Verify this count\?'/);
  assert.match(workspace, /command\('prepare-publication'/);
  assert.match(workspace, /title: 'Update stock from this count\?'/);
  assert.match(workspace, /p\.production_apply_enabled && policy\.publication_environment_enabled/);
  assert.doesNotMatch(workspace, /window\.confirm/);
});

test('the UI does not write inventory tables directly', () => {
  assert.doesNotMatch(workspace, /\.from\(['"]inventory_items['"]\)/);
  assert.doesNotMatch(workspace, /adjust_inventory/);
  assert.match(workspace, /mutate\('save-line'/);
  assert.match(workspace, /command\('publish'/);
});

test('count styles live in the inventory module stylesheet', () => {
  assert.match(styles, /\.sc-stepper/);
  assert.match(styles, /\.sc-footer/);
  assert.doesNotMatch(styles, /!important/);
  assert.equal((styles.match(/{/g) || []).length, (styles.match(/}/g) || []).length);
});
