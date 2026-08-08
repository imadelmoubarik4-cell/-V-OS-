import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bootstrap = readFileSync('apps/web/assets/js/stock-count-bootstrap.js', 'utf8');
const ui = readFileSync('apps/web/assets/js/item-master-workspace.js', 'utf8');
const css = readFileSync('apps/web/assets/css/item-master-workspace.css', 'utf8');

test('Checkpoint L2 is wired through the authenticated Inventory bootstrap and gateway', () => {
  assert.match(bootstrap, /ITEM_MASTER_API/);
  assert.match(bootstrap, /assets\/css\/item-master-workspace\.css/);
  assert.match(bootstrap, /assets\/js\/item-master-workspace\.js/);
  assert.match(bootstrap, /window\.VABAR_CONFIG/);
  assert.match(bootstrap, /window\.AtlasItemMaster/);
  assert.match(ui, /window\.atlasSupabase/);
  assert.match(ui, /authorization:\s*`Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(bootstrap + ui, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(ui, /\.from\s*\(\s*['"]/);
  assert.doesNotThrow(() => new Function(bootstrap));
  assert.doesNotThrow(() => new Function(ui));
});

test('L2 dynamically adds a dedicated Inventory item-master workspace', () => {
  assert.match(ui, /data-item-master-l2/);
  assert.match(ui, /Item master/);
  assert.match(ui, /data-item-master-l2-workspace/);
  assert.match(ui, /setBaseInventoryVisible/);
  assert.match(ui, /Checkpoint L2 · Verified Inventory Foundation/);
});

test('the editor covers the complete item-master contract', () => {
  for (const label of [
    'Par level', 'Critical minimum', 'Supplier', 'Supplier product reference',
    'Units per case', 'Bottle/package size (ml)', 'Package weight (g)',
    'Package description', 'Unit cost (ISK)', 'Case cost (ISK)',
    'Storage location', 'Lead time (days)', 'Minimum order quantity',
    'Active recipe links', 'Barcode aliases'
  ]) assert.match(ui, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('queue filters and priority evidence are visible', () => {
  assert.match(ui, /Critical priority/);
  assert.match(ui, /All priorities/);
  assert.match(ui, /All missing fields/);
  assert.match(ui, /Private drafts/);
  assert.match(ui, /priority_reasons/);
  assert.match(ui, /missing_field_labels/);
  assert.match(ui, /quantity_status/);
  assert.match(ui, /completion_percent/);
});

test('draft and publication actions preserve the L2 safety boundary', () => {
  assert.match(ui, /Save private draft/);
  assert.match(ui, /action:\s*'save_draft'/);
  assert.match(ui, /action:\s*'publish'/);
  assert.match(ui, /Preview publication disabled/);
  assert.match(ui, /never changes quantity/i);
  assert.match(ui, /creates an inventory movement/i);
  assert.match(ui, /submits a supplier order/i);
  assert.doesNotMatch(ui, /adjust_inventory|inventory_movements|p_quantity_change/);
});

test('source-controlled content is escaped before rendering', () => {
  assert.match(ui, /function escapeHtml/);
  assert.match(ui, /escapeHtml\(item\.name\)/);
  assert.match(ui, /escapeHtml\(reason\)/);
  assert.match(ui, /escapeHtml\(link\.recipe_name\)/);
  assert.match(ui, /escapeHtml\(alias\.code \|\| alias\.normalized_code\)/);
});

test('L2 remains responsive and matches the Atlas visual system', () => {
  assert.match(css, /item-master-summary/);
  assert.match(css, /item-master-queue/);
  assert.match(css, /item-master-drawer/);
  assert.match(css, /var\(--atlas-accent/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /@media\(max-width:480px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
