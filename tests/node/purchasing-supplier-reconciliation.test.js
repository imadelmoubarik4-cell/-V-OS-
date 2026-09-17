import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  'supabase/migrations/20260917150500_reconcile_legacy_item_suppliers.sql',
  'utf8',
);

test('legacy item suppliers are reconciled without publishing operational names', () => {
  assert.match(migration, /group by lower\(trim\(i\.supplier\)\)/i);
  assert.match(migration, /not exists[\s\S]+?public\.suppliers/i);
  assert.match(migration, /insert into public\.suppliers \(name, active, notes\)/i);
  assert.match(migration, /where item\.supplier_id is null/i);
  assert.match(migration, /lower\(trim\(supplier\.name\)\) = lower\(trim\(item\.supplier\)\)/i);
  assert.doesNotMatch(migration, /Volcanic|Garri|Mata|Mekka|Ölgerðin/i);
});
