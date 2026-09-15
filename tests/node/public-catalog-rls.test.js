import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  'supabase/migrations/20260805223000_atlas_public_catalog_rls_hardening.sql',
  'utf8'
);
const cleanup = readFileSync(
  'supabase/migrations/20260805223500_atlas_public_catalog_rls_policy_cleanup.sql',
  'utf8'
);

const TABLES = ['inventory_items', 'recipes', 'recipe_ingredients', 'suppliers'];

test('public operational catalog tables keep RLS enabled', () => {
  for (const table of TABLES) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(migration, new RegExp(`revoke all privileges on table public\\.${table} from anon, authenticated`, 'i'));
  }
});

test('browser roles receive only Data API privileges required by policy', () => {
  assert.match(migration, /grant select, insert, update, delete on table public\.inventory_items to authenticated/i);
  assert.match(migration, /grant select on table public\.recipes to anon/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.recipes to authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.recipe_ingredients to authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.suppliers to authenticated/i);
  assert.doesNotMatch(migration, /grant\s+(?:all|truncate|trigger|references)[^;]*\s+to\s+(?:anon|authenticated)/i);
});

test('legacy permissive recipe write policies are removed', () => {
  for (const policy of [
    'staff can write recipes',
    'staff can update recipes',
    'staff can delete recipes',
    'staff can write recipe ingredients',
    'staff can update recipe ingredients',
    'staff can delete recipe ingredients'
  ]) {
    assert.match(migration, new RegExp(`drop policy if exists "${policy}"`, 'i'));
  }
});

test('recipe, ingredient and supplier writes require manager role', () => {
  for (const resource of ['recipes', 'recipe ingredients', 'suppliers']) {
    for (const action of ['add', 'update', 'delete']) {
      assert.match(migration, new RegExp(`create policy "managers ${action} ${resource}"`, 'i'));
    }
  }
  assert.match(migration, /private\.is_manager_or_admin\(\)/);
});

test('duplicate manager policies are removed after the canonical policy set exists', () => {
  for (const resource of ['inventory', 'suppliers']) {
    for (const action of ['read', 'add', 'update', 'delete']) {
      assert.match(cleanup, new RegExp(`drop policy if exists "active managers ${action} ${resource}"`, 'i'));
    }
  }
});

test('public recipe access remains read-only and menu-visible', () => {
  assert.match(migration, /create policy "public reads visible recipes"/i);
  assert.match(migration, /on public\.recipes for select to anon/i);
  assert.match(migration, /using \(show_on_menu = true\)/i);
});
