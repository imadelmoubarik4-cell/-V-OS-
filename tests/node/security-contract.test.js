import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

const migrationsRoot = new URL('../../supabase/migrations/', import.meta.url);
const baselineUrl = new URL('20260801000000_legacy_schema_baseline.sql', migrationsRoot);
const a2Url = new URL('20260802090000_phase_a_02_inventory_staging.sql', migrationsRoot);

const recoveredHistory = [
  {
    file: '20260801105516_atlas_alpha_02_recipe_engine.sql',
    sha256: 'acf5f07b227f510f25d018be76797bbb9bf12eb6ee214bdc1d63178eb8617111',
  },
  {
    file: '20260801125810_atlas_alpha_02_phase1_recipe_architecture.sql',
    sha256: '9ff46e087ccace01a840c2774ed6a1db71c158f06d4d13459716e84577726fba',
  },
  {
    file: '20260801165947_atlas_vision_media_and_import_foundation.sql',
    sha256: '2c849b5196805619c017dd2d2e280419d6bd09ee040ed02d61aa6364fc1ad702',
  },
  {
    file: '20260801180202_atlas_inventory_import_audit_fields.sql',
    sha256: 'fbed5d1a07115ce53bc1d5bb74bb63e774b51bddc66871d33c09a302860bbfe7',
  },
  {
    file: '20260801222046_inventory_imported_at_default.sql',
    sha256: '9cd45ce2b5bdf0204808bd7e86a71f101ea182c278f7d064d7247bcdbc40b44d',
  },
];

function recoveredBody(contents) {
  const lines = contents.split('\n');
  assert.match(lines[0], /^-- Recovered from Supabase migration history/);
  assert.match(lines[1], /^-- This file preserves the SQL already recorded as applied/);
  assert.equal(lines[2], '');
  return lines.slice(3).join('\n').trim();
}

function policy(sql, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sql.match(new RegExp(`create policy "${escaped}"([\\s\\S]*?);`, 'i'));
  assert.ok(match, `Missing policy: ${name}`);
  return match[0];
}

function functionDefinition(sql, qualifiedName) {
  const escaped = qualifiedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sql.match(new RegExp(`create or replace function ${escaped}\\(\\)([\\s\\S]*?)\\$\\$;`, 'i'));
  assert.ok(match, `Missing function: ${qualifiedName}`);
  return match[0];
}

test('repository contains the exact five migrations recorded before A.1', async () => {
  const names = await readdir(migrationsRoot);
  for (const expected of recoveredHistory) {
    assert.ok(names.includes(expected.file), `Missing ${expected.file}`);
    const contents = await readFile(new URL(expected.file, migrationsRoot), 'utf8');
    const digest = createHash('sha256').update(recoveredBody(contents)).digest('hex');
    assert.equal(digest, expected.sha256, `${expected.file} no longer matches recorded live SQL`);
  }
});

test('clean environments start from a schema-only legacy baseline', async () => {
  const [names, sql] = await Promise.all([
    readdir(migrationsRoot),
    readFile(baselineUrl, 'utf8'),
  ]);
  const ordered = names.filter(name => name.endsWith('.sql')).sort();
  assert.equal(ordered[0], '20260801000000_legacy_schema_baseline.sql');
  for (const table of ['profiles', 'suppliers', 'inventory_items', 'recipes', 'import_batches']) {
    assert.match(sql, new RegExp(`create table if not exists public\\."${table}"`, 'i'));
  }
  assert.match(sql, /contains no production rows, user identities, stock quantities, costs, or source data/i);
  assert.doesNotMatch(sql, /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  assert.doesNotMatch(sql, /source-data\/|data\/private\/|@outlook\./i);
});

test('authorization helpers trust only active profile roles', async () => {
  const sql = await readFile(a2Url, 'utf8');
  const activeStaff = functionDefinition(sql, 'private.is_active_staff');
  const manager = functionDefinition(sql, 'private.is_manager_or_admin');
  const batchTrigger = functionDefinition(sql, 'public.atlas_touch_import_batch');

  for (const definition of [activeStaff, manager]) {
    assert.match(definition, /security definer/i);
    assert.match(definition, /set search_path\s*=\s*''/i);
    assert.match(definition, /profile\.id\s*=\s*\(select auth\.uid\(\)\)/i);
    assert.match(definition, /profile\.active is true/i);
  }
  assert.match(manager, /profile\.role::text in \('admin', 'manager'\)/i);
  assert.doesNotMatch(manager, /bartender|viewer/i);
  assert.doesNotMatch(sql, /auth\.role\(\)|user_metadata/i);
  assert.match(batchTrigger, /security invoker/i);
  assert.match(batchTrigger, /set search_path\s*=\s*''/i);
  assert.match(sql, /revoke execute on function private\.is_manager_or_admin\(\) from public, anon, service_role/i);
  assert.match(sql, /grant execute on function private\.is_manager_or_admin\(\) to authenticated/i);
  assert.match(sql, /revoke execute on function public\.handle_new_user\(\) from public, anon, authenticated, service_role/i);
  assert.match(sql, /revoke execute on function private\.is_self_or_manager\(uuid\) from public, anon, authenticated, service_role/i);
});

test('anonymous users have no private inventory or import Data API grants', async () => {
  const sql = await readFile(a2Url, 'utf8');
  const tables = [
    'inventory_items',
    'suppliers',
    'inventory_movements',
    'import_batches',
    'import_review_items',
    'inventory_aliases',
    'import_inventory_rows',
  ];

  for (const table of tables) {
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from anon, authenticated`, 'i'));
  }
  assert.doesNotMatch(sql, /grant\s+[\s\S]*?\s+to\s+anon\s*;/i);
  assert.doesNotMatch(sql, /create policy[\s\S]*?\bto\s+anon\b/i);
  assert.match(sql, /alter default privileges[\s\S]*?revoke all on tables from anon, authenticated, service_role/i);
});

test('bartenders and viewers cannot mutate or read cost-bearing canonical tables', async () => {
  const sql = await readFile(a2Url, 'utf8');
  const policyNames = [
    'active managers read inventory',
    'active managers add inventory',
    'active managers update inventory',
    'active managers delete inventory',
    'active managers read suppliers',
    'active managers read inventory movements',
  ];

  for (const name of policyNames) {
    assert.match(policy(sql, name), /\(select private\.is_manager_or_admin\(\)\)/i);
  }
  assert.doesNotMatch(sql, /using\s*\(\s*true\s*\)|with check\s*\(\s*true\s*\)/i);
  assert.match(sql, /tablename = any \(array\[[\s\S]*?'inventory_items'[\s\S]*?'inventory_movements'[\s\S]*?'import_inventory_rows'/i);
});

test('active staff have a redacted inventory catalogue', async () => {
  const sql = await readFile(a2Url, 'utf8');
  const catalog = functionDefinition(sql, 'private.read_inventory_catalog');
  const forbidden = [
    'cost_price',
    'case_cost',
    'discount_percent',
    'supplier_id',
    'source_file',
    'source_hash',
    'import_note',
  ];

  assert.match(catalog, /security definer/i);
  assert.match(catalog, /set search_path\s*=\s*''/i);
  assert.match(catalog, /\(select auth\.uid\(\)\) is not null/i);
  assert.match(catalog, /\(select private\.is_active_staff\(\)\)/i);
  for (const field of forbidden) assert.doesNotMatch(catalog, new RegExp(`\\b${field}\\b`, 'i'));

  assert.match(sql, /create or replace view public\.inventory_catalog\s+with \(security_invoker = true\)/i);
  assert.match(sql, /revoke all on table public\.inventory_catalog from anon, authenticated, service_role/i);
  assert.match(sql, /grant select on table public\.inventory_catalog to authenticated/i);
});

test('manager browser clients can review staging but cannot create staging rows', async () => {
  const sql = await readFile(a2Url, 'utf8');
  assert.match(policy(sql, 'active managers read staged inventory'), /for select to authenticated/i);
  assert.match(policy(sql, 'active managers review staged inventory'), /for update to authenticated/i);
  assert.match(sql, /grant select on table public\.import_inventory_rows to authenticated/i);
  assert.match(sql, /grant update \([\s\S]*?review_status[\s\S]*?decision_notes[\s\S]*?\) on table public\.import_inventory_rows to authenticated/i);
  assert.doesNotMatch(sql, /grant\s+insert\s*(?:\([^;]*\))?\s+on table public\.import_inventory_rows\s+to authenticated\s*;/i);
  assert.doesNotMatch(sql, /on public\.import_inventory_rows for insert to authenticated/i);
  assert.doesNotMatch(sql, /on public\.inventory_aliases for (?:insert|update|delete) to authenticated/i);
});

test('only active managers access private import files', async () => {
  const sql = await readFile(a2Url, 'utf8');
  for (const action of ['view', 'upload', 'update', 'delete']) {
    const block = policy(sql, `active managers ${action} atlas import files`);
    assert.match(block, /bucket_id = 'atlas-imports'/i);
    assert.match(block, /\(select private\.is_manager_or_admin\(\)\)/i);
  }
  assert.match(policy(sql, 'active managers upload atlas import files'), /storage\.foldername\(name\)/i);
});

test('trusted service worker retains staging and canonical write access', async () => {
  const sql = await readFile(a2Url, 'utf8');
  assert.match(sql, /grant all on table public\.import_inventory_rows to service_role/i);
  assert.match(sql, /grant all on table public\.inventory_aliases to service_role/i);
  assert.match(sql, /grant all on table public\.import_batches to service_role/i);
  assert.match(sql, /grant all on table public\.inventory_items to service_role/i);
});
