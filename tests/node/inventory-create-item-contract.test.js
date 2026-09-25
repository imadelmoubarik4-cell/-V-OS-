import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// S89 release gate: browsers can no longer insert inventory items
// (20260927099000_s89_revoke_direct_item_insert.sql). This ships together with
// the Inventory UI that creates items through atlas-item-master create-item,
// so no browser code may insert or upsert inventory_items directly.
const WEB = 'apps/web';

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return name === 'vendor' ? [] : sources(file);
    return /\.(?:js|mjs|html)$/.test(name) ? [file] : [];
  });
}

test('no browser code inserts or upserts inventory_items directly', () => {
  const offenders = [];
  for (const file of sources(WEB)) {
    const text = readFileSync(file, 'utf8');
    if (/from\(\s*['"`]inventory_items['"`]\s*\)\s*\.\s*(?:insert|upsert)\s*\(/.test(text)) offenders.push(file);
    // A relation chosen at runtime must not be written either.
    for (const match of text.matchAll(/from\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\.\s*(?:insert|upsert)\s*\(/g)) {
      const declared = new RegExp(`(?:const|let|var)\\s+${match[1]}\\s*=[^;\\n]*inventory_items`).test(text);
      if (declared) offenders.push(`${file} (${match[1]})`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('Add item goes through create-item with the duplicate guard', () => {
  const inventory = readFileSync(`${WEB}/assets/js/atlas-inventory.js`, 'utf8');
  assert.match(inventory, /itemMaster\('create-item', \{ body \}\)/);
  const index = readFileSync(`${WEB}/index.html`, 'utf8');
  assert.doesNotMatch(index, /id="item-form"|id="item-modal"/);
});

test('the revoke migration ships in the same change, unchanged', () => {
  const sql = readFileSync('supabase/migrations/20260927099000_s89_revoke_direct_item_insert.sql', 'utf8');
  assert.match(sql, /^revoke insert on table public\.inventory_items from anon, authenticated;$/m);
  assert.match(sql, /drop policy if exists "active managers add inventory items" on public\.inventory_items;/);
});
