import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Security review S88b G4: browsers can no longer UPDATE inventory_items
// (release-gated 20260928095000_s89_revoke_direct_item_update.sql, applied
// after the new web deploy). Every item change goes through a governed,
// audited server/RPC path (20260928093000_s89_item_change_audit.sql).
const WEB = 'apps/web';
const MIGRATIONS = 'supabase/migrations';

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return name === 'vendor' ? [] : sources(file);
    return /\.(?:js|mjs|html)$/.test(name) ? [file] : [];
  });
}

test('G4: no browser code updates, upserts or PATCHes inventory_items directly', () => {
  const offenders = [];
  for (const file of sources(WEB)) {
    const text = readFileSync(file, 'utf8');
    if (/from\(\s*['"`]inventory_items['"`]\s*\)\s*\.\s*(?:update|upsert|insert)\s*\(/.test(text)) offenders.push(file);
    for (const match of text.matchAll(/from\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\.\s*(?:update|upsert|insert)\s*\(/g)) {
      const declared = new RegExp(`(?:const|let|var)\\s+${match[1]}\\s*=[^;\\n]*inventory_items`).test(text);
      if (declared) offenders.push(`${file} (${match[1]})`);
    }
    if (/rest\/v1\/inventory_items[^'"`]*['"`][\s\S]{0,200}?method:\s*['"`](?:PATCH|POST|PUT)/i.test(text)) offenders.push(`${file} (REST write)`);
  }
  assert.deepEqual(offenders, []);
});

test('G4: the item edit sheet goes through the governed catalogue request', () => {
  const inventory = readFileSync(`${WEB}/assets/js/atlas-inventory.js`, 'utf8');
  assert.match(inventory, /itemMaster\('catalog-request', \{ body: \{ kind: 'metadata_correction'/);
});

test('G4: the release-gated revoke migration sorts after the audit migration and revokes UPDATE', () => {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
  const audit = files.indexOf('20260928093000_s89_item_change_audit.sql');
  const revoke = files.indexOf('20260928095000_s89_revoke_direct_item_update.sql');
  assert.ok(audit >= 0 && revoke > audit, 'the audit/adjust_inventory migration precedes the revoke');
  const sql = readFileSync(`${MIGRATIONS}/20260928095000_s89_revoke_direct_item_update.sql`, 'utf8');
  assert.match(sql, /^-- S89 RELEASE-GATED:/);
  assert.match(sql, /^revoke update on table public\.inventory_items from anon, authenticated;$/m);
  assert.match(sql, /drop policy if exists "active managers update inventory items" on public\.inventory_items;/);
  assert.doesNotMatch(sql, /revoke (?:select|delete)/i);
});

test('G4: every catalogue change is audited and adjust_inventory no longer needs the UPDATE grant', () => {
  const sql = readFileSync(`${MIGRATIONS}/20260928093000_s89_item_change_audit.sql`, 'utf8');
  assert.match(sql, /after update of name, category, par_level, supplier, supplier_id, cost_price, case_cost on public\.inventory_items/);
  assert.match(sql, /insert into atlas_private\.item_master_events\(event_type, external_item_id, actor_id, actor_label, actor_role, payload\)\s+values \('item_changed'/);
  assert.match(sql, /create or replace function private\.adjust_inventory_apply\([\s\S]+?security definer/);
  assert.match(sql, /create or replace function public\.adjust_inventory\([\s\S]+?security invoker[\s\S]+?return private\.adjust_inventory_apply\(/);
  assert.match(sql, /revoke all on function private\.adjust_inventory_apply\(uuid, numeric, text, numeric, uuid, text\) from public, anon;/);
});

test('G7: stock_count_add_line resolves the actor role from the profile', () => {
  const sql = readFileSync(`${MIGRATIONS}/20260928094000_s89_stock_count_add_line_actor.sql`, 'utf8');
  assert.match(sql, /select profile\.role::text into actor_role from public\.profiles profile\s+where profile\.id = p_actor_id and profile\.active is true;/);
  assert.match(sql, /p_actor_role is not null and p_actor_role is distinct from actor_role/);
  assert.doesNotMatch(sql, /if p_actor_role not in/);
});
