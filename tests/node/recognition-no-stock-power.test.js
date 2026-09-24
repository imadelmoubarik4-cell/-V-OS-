// S89 owner gate 6: recognition and scanning output stops at a match.
// No scanner or recognition path may write stock; quantities change only
// through the confirmed count / adjustment / receiving workflows.
// The database half of this proof (the NOLOGIN recognition definer has no
// write grant and no writer execute) runs in
// scripts/verify_s89_visual_inventory_preview.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SCANNER = read('supabase/functions/atlas-inventory-scanner/index.ts');
const IDENTITY = read('supabase/functions/_shared/product-identity.mjs');
const FOUNDATION = read('supabase/migrations/20260927090000_s89_visual_inventory_foundation.sql');
const GOVERNANCE = read('supabase/migrations/20260927091000_s89_catalog_governance.sql');
const SERVICE = read('supabase/migrations/20260927094000_s89_recognition_service.sql');
const RECOGNITION_FILES = [
  'supabase/functions/atlas-inventory-recognition/index.ts',
  'supabase/functions/atlas-inventory-recognition/handler.mjs',
  ...fs.readdirSync(path.join(ROOT, 'supabase/functions/_shared/recognition')).map((file) => `supabase/functions/_shared/recognition/${file}`),
];

const STOCK_WRITERS = [
  /rpc\/adjust_inventory/, /adjust_inventory\s*\(/, /inventory_movements/, /applyLiveCount/,
  /atlas_stock_count_(?:save_line|verify|publish|prepare_publication)/, /atlas_purchase_order_command/,
  /atlas_inventory_scanner_(?:record|finalize)_count/, /quantity\s*:/,
];

function body(source) {
  // Comments may name what was removed; only code counts.
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the scanner has no path that writes stock', () => {
  const code = body(SCANNER);
  for (const pattern of STOCK_WRITERS.slice(0, 7)) assert.doesNotMatch(code, pattern, String(pattern));
  assert.match(code, /if \(action === "count"\) \{\s*throw new ApiError\(410,/);
  assert.match(code, /can_count: false/);
  assert.match(code, /scanner_changes_stock: false/);
  // every remaining RPC is lookup/link/snapshot
  const rpcs = [...code.matchAll(/branchRpc\("([a-z_]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual([...new Set(rpcs)], ['atlas_inventory_scanner_link_code', 'atlas_inventory_scanner_lookup', 'atlas_inventory_scanner_snapshot']);
  assert.doesNotMatch(code, /method:\s*"(?:POST|PATCH|PUT|DELETE)"[\s\S]{0,200}rest\/v1\/inventory_items/);
});

test('the shared identity module has no I/O and names no writer', () => {
  const code = body(IDENTITY);
  for (const pattern of STOCK_WRITERS.slice(0, 7)) assert.doesNotMatch(code, pattern, String(pattern));
  assert.doesNotMatch(code, /\bfetch\s*\(|\bimport\s*\(|rest\/v1|rpc\//);
});

function sqlFunction(source, name) {
  const start = source.indexOf(`create or replace function atlas_private.${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const open = source.indexOf('$function$', start);
  const close = source.indexOf('$function$;', open + 10);
  return source.slice(start, close);
}

test('recognition function bodies never write stock, items, codes or aliases', () => {
  for (const [source, names] of [
    [FOUNDATION, ['recognition_resolve_codes', 'recognition_candidate_features', 'recognition_register_media', 'recognition_record']],
    [GOVERNANCE, ['recognition_record_outcome', 'recognition_propose', 'recognition_find_duplicates', 'recognition_my_requests']],
    [SERVICE, ['recognition_limits', 'recognition_register_media', 'recognition_request_get']],
  ]) {
    for (const name of names) {
      const code = sqlFunction(source, name).toLowerCase();
      assert.doesNotMatch(code, /(insert into|update|delete from)\s+public\.(inventory_items|inventory_movements|inventory_aliases|purchase_orders|recipe_ingredients)/, name);
      assert.doesNotMatch(code, /(insert into|update|delete from)\s+atlas_private\.(inventory_count_|inventory_verified_balances|inventory_item_codes|inventory_scan)/, name);
      assert.doesNotMatch(code, /adjust_inventory|stock_count_(save|verify|publish|start|add_line)|catalog_request_decide|catalog_create_item_core/, name);
      assert.match(code, /security definer/, `${name} runs as the definer`);
    }
  }
  assert.match(FOUNDATION, /create role atlas_recognition_definer nologin noinherit/);
  assert.match(FOUNDATION, /owner to atlas_recognition_definer/);
});

test('no S89 migration backfills canonical inventory rows', () => {
  for (const file of fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((name) => name.startsWith('202609270'))) {
    // Comments (the rollout note names the pg_trgm command) do not count.
    const source = read(`supabase/migrations/${file}`).toLowerCase().replace(/--.*$/gm, '');
    const outsideFunctions = source.replace(/\$function\$[\s\S]*?\$function\$/g, '');
    assert.doesNotMatch(outsideFunctions, /update\s+public\.inventory_items|insert\s+into\s+public\.inventory_items|update\s+public\.inventory_aliases/, file);
    assert.doesNotMatch(source, /create extension[^;]*pg_trgm/, `${file} must not install pg_trgm`);
  }
});

test('the recognition service and its shared modules name no writer and call only atlas_recognition_* RPCs', async () => {
  const { RECOGNITION_RPCS } = await import('../../supabase/functions/_shared/recognition/retrieve.mjs');
  for (const file of RECOGNITION_FILES) {
    const code = body(read(file));
    for (const pattern of STOCK_WRITERS.slice(0, 7)) assert.doesNotMatch(code, pattern, `${file}: ${pattern}`);
    assert.doesNotMatch(code, /atlas-stock-counts|atlas-inventory-scanner|ai-tools\/|purchasing/, `${file} must not reach stock-count, scanner, purchasing or AI tool services`);
    assert.doesNotMatch(code, /rest\/v1\/(?!rpc\/)/, `${file} must not read or write tables directly`);
    for (const [, name] of code.matchAll(/["'](atlas_[a-z_]+)["']/g)) {
      assert.ok(RECOGNITION_RPCS.includes(name), `${file} names ${name}, which is not a recognition RPC`);
    }
  }
  assert.ok(RECOGNITION_RPCS.every((name) => name.startsWith('atlas_recognition_')));
  const handler = body(read('supabase/functions/atlas-inventory-recognition/handler.mjs'));
  assert.match(handler, /return \{ rpc: guardedRpc\(rawRpc\)/, 'every database call goes through the allow-list');
  assert.match(handler, /storage\/v1\/object\/\$\{MEDIA_BUCKET\}/, 'storage writes only to the private media bucket');
  assert.match(read('supabase/config.toml'), /\[functions\.atlas-inventory-recognition\]\nverify_jwt = false/);
});

test('Atlas AI recognition tools reach the pipeline through the guarded client and only propose catalogue changes', () => {
  const tools = body(read('supabase/functions/_shared/ai-tools/tools-recognition.mjs'));
  for (const pattern of STOCK_WRITERS.slice(0, 7)) assert.doesNotMatch(tools, pattern, String(pattern));
  assert.match(tools, /rpc: services\.recognitionRpc/);
  assert.doesNotMatch(tools, /catalogRequestCreate|atlas_catalog_request_decide|atlas_catalog_create_item/, 'tools never write; only approved proposals do');
  const services = body(read('supabase/functions/_shared/ai-tools/services.mjs'));
  assert.match(services, /recognitionRpc: guardedRpc\(/);
  const actions = body(read('supabase/functions/_shared/ai-tools/actions.mjs'));
  assert.match(actions, /p_self_approve: false/, 'an approved AI card only submits a pending request');
  assert.match(actions, /p_source: "ai_proposal"/);
});
