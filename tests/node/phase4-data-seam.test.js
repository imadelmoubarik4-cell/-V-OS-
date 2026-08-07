import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
  path.join(root, 'apps/web/assets/js/data/atlas-data.js'),
  'utf8'
);


test('Phase 4 data gateway is DOM-free and exposes plain operations', () => {
  assert.match(source, /global\.AtlasData\s*=\s*Object\.freeze/);
  assert.match(source, /getActiveProfile/);
  assert.match(source, /getItems/);
  assert.match(source, /getInventoryMovements/);
  assert.match(source, /getRecipes/);
  assert.match(source, /getSuppliers/);
  assert.match(source, /saveItem/);
  assert.match(source, /deleteItem/);
  assert.match(source, /adjustInventory/);
  assert.match(source, /ensureSupplier/);
  assert.match(source, /getPublicMenuItems/);
  assert.doesNotMatch(source, /\bdocument\b/);
  assert.doesNotMatch(source, /innerHTML|querySelector|getElementById/);
});


test('Phase 4 data gateway keeps canonical snake_case field names', () => {
  assert.match(source, /\bquantity\b/);
  assert.match(source, /\bpar_level\b/);
  assert.match(source, /\bcost_price\b/);
  assert.match(source, /\bsize_ml\b/);
  assert.doesNotMatch(source, /currentStock|parLevel|minimumStock|averageDailyUsage/);
});


test('Phase 4 data gateway preserves role-aware catalogue boundaries', () => {
  assert.match(source, /inventory_items/);
  assert.match(source, /inventory_catalog/);
  assert.match(source, /inventory_movements/);
  assert.match(source, /inventory_movement_catalog/);
  assert.match(source, /recipe_catalog/);
  assert.match(source, /can_manage_commercial/);
});


test('Phase 4 data gateway reuses the one shared browser client', () => {
  assert.match(source, /global\.atlasSupabase/);
  assert.doesNotMatch(source, /createClient\s*\(/);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY|service_role\s*[:=]/);
});


test('Phase 4 data gateway keeps inventory mutations behind existing operations', () => {
  assert.match(source, /\.rpc\('adjust_inventory'/);
  assert.match(source, /p_item_id/);
  assert.match(source, /p_quantity_change/);
  assert.match(source, /p_movement_type/);
  assert.match(source, /insert\(\{ \.\.\.record, quantity: 0 \}\)/);
});
