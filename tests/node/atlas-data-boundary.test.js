import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..', '..');
const data = readFileSync(
  path.join(root, 'apps/web/assets/js/data/atlas-data.js'),
  'utf8'
);
const index = readFileSync(
  path.join(root, 'apps/web/index.html'),
  'utf8'
);

const directSupabaseFrom = /(?:\bsb\b|\bclient\b|\bsupabase\b|\batlasSupabase\b)\s*\.\s*from\s*\(/i;
const directSupabaseRpc = /(?:\bsb\b|\bclient\b|\bsupabase\b|\batlasSupabase\b)\s*\.\s*rpc\s*\(/i;

function inventoryMasterFields() {
  const match = data.match(
    /const\s+INVENTORY_MASTER_FIELDS\s*=\s*Object\.freeze\s*\(\s*\[(.*?)\]\s*\)\s*;/s
  );
  assert.ok(match, 'INVENTORY_MASTER_FIELDS must be declared as a frozen array');
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
}

test('Atlas data boundary is DOM-free and does not ship privileged or design runtimes', () => {
  assert.match(data, /global\.AtlasData\s*=\s*Object\.freeze/);
  assert.doesNotMatch(data, /\bdocument\b|innerHTML|querySelector|getElementById|MutationObserver/);
  assert.doesNotMatch(data, /SUPABASE_SERVICE_ROLE_KEY|service_role\s*[:=]|support\.js|Babel\.transform|ReactDOM|new\s+Function\s*\(/i);
});

test('inventory master fields use canonical names and cannot write quantity', () => {
  const fields = inventoryMasterFields();
  assert.ok(fields.length > 0);
  assert.equal(fields.includes('quantity'), false);
  for (const field of [
    'name', 'category', 'unit', 'par_level', 'supplier', 'supplier_id',
    'sku', 'barcode', 'bin_location', 'units_per_case', 'case_cost',
    'cost_price', 'discount_percent', 'size_ml'
  ]) assert.ok(fields.includes(field), `missing canonical inventory field: ${field}`);
  for (const forbidden of ['currentStock', 'parLevel', 'minimumStock', 'averageDailyUsage']) {
    assert.equal(fields.includes(forbidden), false);
  }
});

test('role-aware commercial and redacted relations remain explicit', () => {
  for (const relation of [
    'inventory_items',
    'inventory_catalog',
    'inventory_movements',
    'inventory_movement_catalog',
    'recipes',
    'recipe_catalog'
  ]) assert.match(data, new RegExp(`['"]${relation}['"]`));
  assert.match(data, /canManageCommercial/);
  assert.match(data, /canManageCommercial\s*\?\s*['"]inventory_items['"]\s*:\s*['"]inventory_catalog['"]/);
  assert.match(data, /canManageCommercial[\s\S]{0,120}['"]inventory_movements['"][\s\S]{0,120}['"]inventory_movement_catalog['"]/);
  assert.match(data, /if\s*\(canManageCommercial\)[\s\S]{0,180}\.from\(['"]recipes['"]\)/);
  assert.match(data, /\.from\(['"]recipe_catalog['"]\)/);
});

test('legacy application configures one shared data gateway before loading data', () => {
  const configIndex = index.indexOf('<script src="config.js"></script>');
  const dataIndex = index.indexOf('<script src="assets/js/data/atlas-data.js"></script>');
  const inlineIndex = index.indexOf('<script>\n  const SUPABASE_CDN_URLS');
  assert.ok(configIndex >= 0);
  assert.ok(dataIndex > configIndex);
  assert.ok(inlineIndex > dataIndex);
  assert.match(index, /window\.AtlasData\.configure\s*\(\s*[A-Za-z_$][\w$]*\s*\)/);
  assert.match(data, /configuredClient\s*\|\|\s*global\.atlasSupabase/);
  assert.doesNotMatch(data, /\bcreateClient\s*\(/);
});

test('index delegates every Supabase data and RPC operation to AtlasData', () => {
  assert.doesNotMatch(index, directSupabaseFrom);
  assert.doesNotMatch(index, directSupabaseRpc);
  for (const operation of [
    'getActiveProfile', 'getItems', 'getInventoryMovements', 'getRecipes',
    'getSuppliers', 'saveItem', 'deleteItem', 'adjustInventory',
    'ensureSupplier', 'createSupplier'
  ]) assert.match(index, new RegExp(`AtlasData\\.${operation}\\s*\\(`));
});

test('item master writes are structurally filtered and quantity is initialized only on create', () => {
  assert.match(data, /pickFields\s*\(\s*payload\s*,\s*INVENTORY_MASTER_FIELDS\s*\)/);
  assert.match(data, /\.update\s*\(\s*record\s*\)/);
  assert.match(
    data,
    /\.insert\s*\(\s*\{\s*\.\.\.\s*record\s*,\s*quantity\s*:\s*0\s*\}\s*\)/s
  );
  const payloadMatch = index.match(/const\s+payload\s*=\s*\{([\s\S]*?)\};\s*try\s*\{\s*await\s+window\.AtlasData\.saveItem/);
  assert.ok(payloadMatch, 'item master payload must be passed to AtlasData.saveItem');
  assert.doesNotMatch(payloadMatch[1], /\bquantity\s*:/);
});

test('the published web root does not expose a legacy archive directory', () => {
  assert.equal(existsSync(path.join(root, 'apps/web/old')), false);
});
