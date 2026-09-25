import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// S88 §7.5: the Item Master workspace is absorbed into the Inventory item
// detail (#inventory/item/<id>) in assets/js/atlas-inventory.js. Every write
// still goes through the authenticated atlas-item-master gateway.
const app = readFileSync('apps/web/index.html', 'utf8');
const config = readFileSync('apps/web/config.js', 'utf8');
const ui = readFileSync('apps/web/assets/js/atlas-inventory.js', 'utf8');

test('Item Master writes go through the authenticated gateway, never the table', () => {
  assert.equal(existsSync('apps/web/assets/js/item-master-workspace.js'), false);
  assert.equal(existsSync('apps/web/assets/css/item-master-workspace.css'), false);
  assert.doesNotMatch(app + config, /item-master-workspace\.(?:js|css)/);
  assert.match(ui, /const base = String\(root\.VABAR_CONFIG\?\.ITEM_MASTER_API \|\| ''\)\.trim\(\);/);
  assert.match(ui, /authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(ui, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(ui, /\.from\(\s*['"]inventory_items['"]\s*\)\s*\.\s*(?:insert|update|upsert|delete)/);
});

test('the item detail is a route, with the old Item Master tab gone', () => {
  assert.doesNotMatch(app, /data-item-master-l2|>Item master<\/button>/);
  assert.match(ui, /href="#inventory\/item\/\$\{encodeURIComponent\(item\.id\)\}"/);
  assert.match(ui, /function showDetail\(/);
});

test('activation uses set_item_active with the dependency check and a stale-write guard', () => {
  assert.match(ui, /itemMaster\('item_dependencies', \{ method: 'GET', params: \{ item_id: item\.id \} \}\)/);
  assert.match(ui, /itemMaster\('set_item_active', \{ body: \{ item_id: item\.id, active: activate, reason: [^}]+expected_updated_at: /);
});

test('Add item uses create-item and the duplicate-candidate decision', () => {
  assert.match(ui, /itemMaster\('create-item', \{ body \}\)/);
  assert.match(ui, /Use existing item/);
  assert.match(ui, /Create anyway/);
  assert.match(ui, /body\.duplicate_ack = \{ acknowledged: /);
  assert.match(ui, /requires_ack/);
});

test('edits and new codes are governed catalogue changes that never touch quantity', () => {
  assert.match(ui, /itemMaster\('catalog-request', \{ body: \{ kind: 'metadata_correction'/);
  assert.match(ui, /itemMaster\('catalog-request', \{ body: \{ kind: 'code'/);
  const editor = ui.slice(ui.indexOf('const EDITABLE = '), ui.indexOf('\n', ui.indexOf('const EDITABLE = ')));
  assert.doesNotMatch(editor, /'quantity'|'par_level'|verified_quantity/);
  for (const label of ['Supplier', 'Units per case', 'Cost per unit (kr)', 'Case cost (kr)']) {
    assert.match(ui, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('source-controlled content is escaped before rendering', () => {
  assert.match(ui, /const esc = /);
  assert.match(ui, /\$\{esc\(item\.name\)\}/);
  // Plain-text uses (toasts, titles passed to sheetHtml) are escaped by the helper.
  assert.match(ui, /<h2 class="atlas-sheet__title">\$\{esc\(title\)\}<\/h2>/);
  assert.doesNotMatch(ui, />\$\{item\.name\}</);
});
