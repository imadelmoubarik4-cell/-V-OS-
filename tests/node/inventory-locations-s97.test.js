import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// S97: first-class managed Storage Locations for Inventory. A location is a
// place, never a quantity. Read is for active staff; every write is authorized
// in the database (RLS + SECURITY DEFINER RPCs that raise 42501), not only in
// the UI. Legacy bin_location is preserved and never rewritten.
const migration = readFileSync('supabase/migrations/20261011090000_s97_inventory_storage_locations.sql', 'utf8');
const gate = readFileSync('scripts/verify_phase1_security_gate.sql', 'utf8');
const appData = readFileSync('apps/web/assets/js/atlas-app.js', 'utf8');
const ui = readFileSync('apps/web/assets/js/atlas-inventory.js', 'utf8');
const count = readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8');

test('the two tables exist with the item-in-many-places, one-primary shape', () => {
  assert.match(migration, /create table if not exists public\.inventory_locations/);
  assert.match(migration, /create table if not exists public\.inventory_item_locations/);
  // At most one primary per item, enforced by a partial unique index.
  assert.match(migration, /create unique index[^\n]*inventory_item_locations_one_primary[^\n]*\n?[^;]*on public\.inventory_item_locations \(inventory_item_id\)[\s\S]*?where[\s\S]*?is_primary/);
  // Case-insensitive unique code.
  assert.match(migration, /create unique index[\s\S]*?inventory_locations_code_lower[\s\S]*?on public\.inventory_locations \(lower\(code\)\)/);
});

test('RLS is on: read for active staff, no anon, writes only via service_role/RPC', () => {
  for (const table of ['inventory_locations', 'inventory_item_locations']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`));
    assert.match(migration, new RegExp(`grant select on table public\\.${table} to authenticated`));
  }
  // Read policies gate on active staff.
  assert.match(migration, /using \(\(select private\.is_active_staff\(\)\)\)/);
});

test('every browser RPC is an invoker wrapper over a definer impl with the 42501 guard', () => {
  const wrappers = [
    'atlas_inventory_location_save',
    'atlas_inventory_location_set_active',
    'atlas_inventory_location_delete',
    'atlas_inventory_item_locations_set'
  ];
  for (const fn of wrappers) {
    assert.match(migration, new RegExp(`create or replace function public\\.${fn}\\(`), `${fn} wrapper missing`);
    assert.match(migration, new RegExp(`function public\\.${fn}[\\s\\S]{0,400}language sql security invoker set search_path = ''`), `${fn} must be SECURITY INVOKER with an empty search_path`);
  }
  // The private implementations are SECURITY DEFINER and carry the exact guard
  // the security gate recognises.
  const impls = [
    'inventory_location_save',
    'inventory_location_set_active',
    'inventory_location_delete',
    'inventory_item_locations_set'
  ];
  for (const fn of impls) {
    assert.match(migration, new RegExp(`create or replace function private\\.${fn}\\(`), `${fn} impl missing`);
  }
  // The exact guard string appears once per private implementation.
  const guards = migration.match(/if auth\.uid\(\) is null or not private\.is_manager_or_admin\(\) then/g) || [];
  assert.ok(guards.length >= 4, `expected the manager/admin guard in each impl, saw ${guards.length}`);
  assert.match(migration, /errcode='42501'/);
});

test('permanent delete is Administrator-only and refuses a location in use', () => {
  assert.match(migration, /if private\.current_profile_role\(\) <> 'admin' then/);
  assert.match(migration, /Only an administrator can permanently delete/);
  assert.match(migration, /atlas:location_in_use/);
  assert.match(migration, /if in_use > 0 or ever_used > 0 then/);
});

test('the 16 canonical VÁ codes are seeded exactly, F04 is the service cooler', () => {
  for (const code of ['S01', 'S02', 'S03', 'F01', 'F02', 'F03', 'F04', 'W01', 'W02', 'B01', 'B02', 'B03', 'D01', 'D02', 'D03', 'D04']) {
    assert.match(migration, new RegExp(`\\('${code}',`), `seed missing ${code}`);
  }
  assert.match(migration, /\('F04','Cooler under coffee machine'/);
  // Idempotent seed, no historical rewrite.
  assert.match(migration, /on conflict \(lower\(code\)\) do nothing/);
});

test('changes are audited on an append-only trail wired to the S96 triggers', () => {
  assert.match(migration, /atlas_private\.inventory_location_events/);
  assert.match(migration, /private\.audit_append_only/);
  for (const event of ['location_created', 'location_archived', 'item_assigned', 'item_unassigned', 'primary_changed']) {
    assert.match(migration, new RegExp(event), `audit event ${event} not logged`);
  }
});

test('legacy bin_location is preserved: no drop, no historical rewrite of counts', () => {
  assert.doesNotMatch(migration, /alter table[^\n]*drop column[^\n]*bin_location/i);
  assert.doesNotMatch(migration, /update public\.inventory_items[\s\S]*set bin_location/i);
  // Only an exact-match, opt-in mapping into the new tables.
  assert.match(migration, /case insensitively equal|case-insensitively equal|lower\(btrim\(/i);
});

test('the security gate registers the four wrapper/impl pairs so exposure stays empty', () => {
  for (const fn of ['atlas_inventory_location_save', 'atlas_inventory_location_set_active', 'atlas_inventory_location_delete', 'atlas_inventory_item_locations_set']) {
    assert.match(gate, new RegExp(fn), `gate does not list ${fn}`);
  }
});

test('the app loads the location catalogue and assignments into AtlasData', () => {
  assert.match(appData, /async function loadLocations\(\)/);
  assert.match(appData, /\.from\('inventory_location_catalog'\)/);
  assert.match(appData, /\.from\('inventory_item_locations'\)/);
  assert.match(appData, /locations: \(\) => locations/);
  assert.match(appData, /itemLocations: \(\) => itemLocations/);
  assert.match(appData, /loadItems\(\), loadRecipes\(\), loadSuppliersData\(\), loadLocations\(\)/);
});

test('the UI assigns locations through the RPC, never a direct table write', () => {
  assert.match(ui, /atlas_inventory_item_locations_set/);
  assert.match(ui, /atlas_inventory_location_save/);
  assert.match(ui, /atlas_inventory_location_set_active/);
  assert.match(ui, /atlas_inventory_location_delete/);
  assert.doesNotMatch(ui, /\.from\(\s*['"]inventory_(?:item_)?locations['"]\s*\)\s*\.\s*(?:insert|update|upsert|delete)/);
});

test('write controls are manager-gated in the UI and read is offered to staff', () => {
  // The picker and management flows refuse non-managers before calling the RPC.
  assert.match(ui, /function openLocationPicker\(item\) \{\s*\n\s*if \(!isManager\(\)\)/);
  assert.match(ui, /function openLocationForm\(loc\) \{\s*\n\s*if \(!isManager\(\)\)/);
  assert.match(ui, /canDeleteLocation[\s\S]{0,120}role\(\) === 'admin'/);
  // The Locations tab is manager-only; the filter/column read is for everyone.
  assert.match(ui, /\['locations', 'Locations', '#inventory\/locations'\]/);
  assert.match(ui, /function locationCellHtml\(item\)/);
});

test('a location filter and a No-location filter exist; nothing here changes stock', () => {
  assert.match(ui, /const NO_LOCATION = '__none__'/);
  assert.match(ui, /No location assigned/);
  // Assigning a location must not call any stock/quantity RPC.
  assert.doesNotMatch(ui.slice(ui.indexOf('function openLocationPicker'), ui.indexOf('function openLocationPicker') + 3000), /adjust_inventory|quantity_change|verified_quantity/);
});

test('stock count scopes by PRIMARY location so an item is counted once', () => {
  assert.match(count, /function primaryLocationId\(/);
  assert.match(count, /counted once|counted exactly once|never\s+double-counted/i);
  // The area option is a client-side primary-location scope resolved to a focus set.
  assert.match(count, /option\('ploc'/);
  assert.match(count, /primaryLocationId\(item\.id, locMap\) === value/);
});
