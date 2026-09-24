// Runs the product-identity parity corpus through the SQL twin on a replayed
// loopback database and writes the vectors the Node parity test compares with
// the JS module:
//
//   PGDATABASE=vaos_replay node scripts/generate_product_identity_vectors.mjs
//
// tests/fixtures/product-identity/sql-vectors.json is committed so the Node
// suite checks parity without a database; with ATLAS_PARITY_PGDATABASE set the
// test also queries the database live.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CORPUS_FILE = path.join(ROOT, 'tests/fixtures/product-identity/corpus.json');
export const VECTORS_FILE = path.join(ROOT, 'tests/fixtures/product-identity/sql-vectors.json');

export function vectorQuery(corpus) {
  const literal = JSON.stringify(corpus);
  if (literal.includes('$corpus$')) throw new Error('corpus may not contain $corpus$');
  return `
with corpus as (select $corpus$${literal}$corpus$::jsonb as c)
select jsonb_build_object(
  'version', atlas_private.product_identity_constants()->>'version',
  'texts', (select jsonb_agg(jsonb_build_object(
      'text', t,
      'fold', atlas_private.product_text_fold(t),
      'search_fold', atlas_private.product_search_fold(t),
      'name_tokens', to_jsonb(atlas_private.product_name_tokens(t)),
      'match_tokens', to_jsonb(atlas_private.product_match_tokens(t)),
      'name_key', atlas_private.product_name_key(null, null, null, t),
      'match_key', atlas_private.product_match_key(null, null, null, t),
      'package', atlas_private.product_parse_package(t)) order by ord)
    from corpus, jsonb_array_elements_text(c->'texts') with ordinality e(t, ord)),
  'items', (select jsonb_agg(jsonb_build_object(
      'item', i,
      'package', atlas_private.product_parse_item_package(nullif(i->>'unit_size_quantity','')::numeric, i->>'unit_size_base',
        nullif(i->>'size_ml','')::numeric, nullif(i->>'package_weight_g','')::numeric, i->>'package_size', i->>'name', i->>'unit'),
      'pack_key', atlas_private.product_pack_key(nullif(i->>'unit_size_quantity','')::numeric, i->>'unit_size_base',
        nullif(i->>'size_ml','')::numeric, nullif(i->>'package_weight_g','')::numeric, i->>'package_size', i->>'name', i->>'unit'),
      'name_key', atlas_private.product_name_key(i->>'brand', i->>'product_name', i->>'variant', i->>'name'),
      'match_key', atlas_private.product_match_key(i->>'brand', i->>'product_name', i->>'variant', i->>'name'),
      'identity_key', atlas_private.product_identity_key(i->>'brand', i->>'product_name', i->>'variant', i->>'name',
        nullif(i->>'unit_size_quantity','')::numeric, i->>'unit_size_base', nullif(i->>'size_ml','')::numeric,
        nullif(i->>'package_weight_g','')::numeric, i->>'package_size', i->>'unit')) order by ord)
    from corpus, jsonb_array_elements(c->'items') with ordinality e(i, ord)),
  'codes', (select jsonb_agg(jsonb_build_object(
      'input', x,
      'result', atlas_private.product_code_normalize(x->>'kind', x->>'raw', x->>'symbology')) order by ord)
    from corpus, jsonb_array_elements(c->'codes') with ordinality e(x, ord)),
  'duplicates', (select jsonb_agg(jsonb_build_object(
      'case', x,
      'draft_keys', atlas_private.catalog_duplicate_keys(x->'draft'),
      'item_keys', atlas_private.catalog_duplicate_keys(x->'item'),
      'result', atlas_private.catalog_duplicate_score(
        atlas_private.catalog_duplicate_keys(x->'draft'), atlas_private.catalog_duplicate_keys(x->'item'))) order by ord)
    from corpus, jsonb_array_elements(c->'duplicates') with ordinality e(x, ord))
)::text;`;
}

export function runVectorQuery(corpus, env = process.env) {
  const host = env.PGHOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`Refusing non-loopback PGHOST: ${host}`);
  const result = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: vectorQuery(corpus),
    env: { ...env, PGHOST: host, PGUSER: env.PGUSER || 'postgres' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8'));
  const vectors = runVectorQuery(corpus);
  fs.writeFileSync(VECTORS_FILE, `${JSON.stringify(vectors, null, 1)}\n`);
  console.log(`wrote ${path.relative(ROOT, VECTORS_FILE)} (${vectors.texts.length} texts, ${vectors.items.length} items, ${vectors.codes.length} codes, ${vectors.duplicates.length} duplicate cases)`);
}
