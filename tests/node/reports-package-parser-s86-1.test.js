import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const MIGRATION = 'supabase/migrations/20260924170000_s86_1_reports_safe_package_parser.sql';
const sql = read(MIGRATION);

function functionBody(name) {
  const start = sql.search(new RegExp(`create or replace function ${name.replace('.', '\\.')}\\(`, 'i'));
  assert.ok(start >= 0, `${name} must be defined`);
  const open = sql.indexOf('$function$', start);
  const close = sql.indexOf('$function$', open + 10);
  return { header: sql.slice(start, open), body: sql.slice(open, close) };
}

test('the private Reports snapshot no longer casts free text with regexp_replace', () => {
  const { header, body } = functionBody('atlas_private.reports_snapshot_v2');
  assert.doesNotMatch(body, /regexp_replace/);
  assert.equal((body.match(/::numeric/g) || []).length, 7, 'only integer/count numeric casts remain');
  assert.match(body, /cross join lateral atlas_private\.reports_parse_pack_measure\(coalesce\(item\.package_size,item\.unit,''\)\) as measure/);
  assert.doesNotMatch(header, /security definer/i);
  assert.match(header, /SET search_path TO ''/);
});

test('the guarded parser only casts digit-only captures and rejects ambiguous text', () => {
  const { header, body } = functionBody('atlas_private.reports_parse_pack_measure');
  assert.match(header, /immutable/i);
  assert.match(header, /set search_path = ''/i);
  assert.doesNotMatch(header, /security definer/i);
  assert.match(body, /'\^\(\[0-9\]\{1,12\}\)\(\?:\(\[\.,\]\)\(\[0-9\]\{1,12\}\)\)\?\[\[:space:\]\]\*\(ml\|/, 'anchored "<number> <unit>" pattern');
  assert.match(body, /parts\[2\] = ',' and pg_catalog\.length\(parts\[3\]\) = 3/, 'thousands-or-decimal comma is ambiguous');
  assert.match(body, /amount := \(parts\[1\] \|\| coalesce\('\.' \|\| parts\[3\], ''\)\)::numeric;/);
});

test('the public wrapper scrubs numeric recordset fields and keeps its contract', () => {
  const { header, body } = functionBody('public.atlas_reports_snapshot_v2');
  assert.match(header, /LANGUAGE sql/);
  assert.match(header, /SET search_path TO ''/);
  assert.doesNotMatch(header, /security definer/i);
  for (const fields of [
    "array['quantity','par_level','cost_price','size_ml','sell_price']",
    "array['yield_quantity','menu_price','happy_hour_price','glass_price','bottle_price']",
    "array['quantity']",
    "array['quantity_change','unit_cost','total_cost']",
  ]) assert.ok(body.includes(fields), fields);
  assert.match(body, /atlas_private\.reports_normalize_package_size\(item->>'package_size'\)/, 'legacy gram normalisation kept');
  assert.match(body, /numeric_inputs\.recipes,\s+numeric_inputs\.recipe_ingredients,/);
});

test('helpers are private: no PUBLIC/anon/authenticated EXECUTE, service_role only', () => {
  for (const signature of [
    'atlas_private.reports_parse_pack_measure(text)',
    'atlas_private.reports_safe_numeric(jsonb)',
    'atlas_private.reports_scrub_numeric_fields(jsonb, text[])',
  ]) {
    assert.ok(sql.includes(`revoke all on function ${signature} from public, anon, authenticated;`), signature);
    assert.ok(sql.includes(`grant execute on function ${signature} to service_role;`), signature);
  }
  assert.doesNotMatch(sql, /grant [a-z, ]+ to (anon|authenticated|public)\b/i);
  assert.doesNotMatch(sql, /security definer/i);
  assert.doesNotMatch(sql, /\b(alter|create|drop) (table|policy)\b|row level security/i, 'no table or RLS change');
});

test('the migration replay runs the S86.1 database acceptance checks', () => {
  const replay = read('scripts/verify_full_migration_replay.sh');
  assert.match(replay, /verify_s86_1_reports_package_parser_preview\.sql/);
  const acceptance = read('scripts/verify_s86_1_reports_package_parser_preview.sql');
  for (const input of ['1 kg / 1 unit', '250gr', '15 kg case / sold by kg', '6 x 1 kg (1 kg per bag)', '4.5 kg box', '25 x 2g tea bags', '750 ml', '1.5 kg', '1,5 kg']) {
    assert.ok(acceptance.includes(`'${input}'`), input);
  }
  assert.match(acceptance, /private_snapshot_survives_legacy_package_text/);
  assert.match(acceptance, /public_snapshot_survives_malformed_numbers/);
  assert.match(acceptance, /\n rollback;\n|\nrollback;\n/);
});

test('the S86 Edge sanitizer and fallback stay in place as a second layer', () => {
  const edge = read('supabase/functions/atlas-reports/index.ts');
  assert.match(edge, /sanitizeSnapshotInventory\(stockReport\.rpc_inventory\)/);
  assert.match(edge, /catch \(error\) \{[\s\S]*?p_inventory: \[\],/);
});
