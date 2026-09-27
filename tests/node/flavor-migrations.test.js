// S95 Flavor Intelligence: static contracts for the flavor migrations and the
// generated seed (20261005090000_s95a / 091000_s95b / 092000_s95c).
// Local replay acceptance lives in scripts/verify_s95_flavor_replay.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aliasKey, ingredientId, md5Uuid } from '../../scripts/build_flavor_common.mjs';
import { generateSql, SEED_PATH } from '../../scripts/build_flavor_seed.mjs';
import { buildAll } from '../../scripts/build_flavor_item_links.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MIGRATIONS = 'supabase/migrations';
const S95A = read(`${MIGRATIONS}/20261005090000_s95a_flavor_graph.sql`);
const S95B = read(`${MIGRATIONS}/20261005091000_s95b_recipe_draft_kind.sql`);
const S95C = read(`${MIGRATIONS}/20261005092000_s95c_flavor_seed.sql`);
const S90F = read(`${MIGRATIONS}/20260929092000_s90f_ai_update_draft_order_kind.sql`);
const stripComments = (sql) => sql.replace(/--.*$/gm, '');
const TABLES = ['flavor_sources', 'flavor_ingredients', 'flavor_aliases', 'flavor_preparations',
  'flavor_ingredient_preparations', 'flavor_edges', 'flavor_item_links'];

test('s95 migrations are the three expected files, after S94', () => {
  const files = fs.readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => /_s95/.test(f)).sort();
  assert.deepEqual(files, [
    '20261005090000_s95a_flavor_graph.sql',
    '20261005091000_s95b_recipe_draft_kind.sql',
    '20261005092000_s95c_flavor_seed.sql',
  ]);
  const all = fs.readdirSync(path.join(ROOT, MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const s94 = all.indexOf('20261004092000_s94c_marketing_publishing.sql');
  assert.ok(s94 >= 0 && all.indexOf(files[0]) > s94);
});

test('every flavor table lives in atlas_private with RLS on, browser roles revoked, service-role policy', () => {
  const sql = stripComments(S95A);
  for (const t of TABLES) {
    assert.match(sql, new RegExp(`create table if not exists atlas_private\\.${t} \\(`), t);
    assert.ok(sql.includes(`'${t}'`), `${t} is in the RLS/grant loop`);
    assert.doesNotMatch(sql, new RegExp(`create table[^;]*public\\.${t}`), `${t} not in public`);
  }
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on atlas_private\.%I from public, anon, authenticated/);
  assert.match(sql, /create policy %I on atlas_private\.%I for all to service_role using \(true\) with check \(true\)/);
  assert.doesNotMatch(sql, /grant [^;]* to (anon|authenticated)/i);
  assert.doesNotMatch(sql, /to (anon|authenticated|public)\s+using/i);
});

test('the graph keeps evidence types distinct and edges undirected', () => {
  const sql = stripComments(S95A);
  assert.match(sql, /evidence_type text not null check \(evidence_type in \('scientific','culinary','atlas_learned','ai_interpretation'\)\)/);
  assert.match(sql, /relation text not null check \(relation in \('complement','contrast','bridge','substitute'\)\)/);
  assert.match(sql, /check \(a_id <> b_id\)/);
  assert.match(sql, /check \(a_id < b_id\)/);
  assert.match(sql, /create unique index if not exists flavor_edges_identity_idx/);
  assert.match(sql, /explanation text not null/);
  assert.match(sql, /slug text not null unique check \(slug ~ '\^\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$'\)/);
  assert.match(sql, /status text not null check \(status in \('confirmed','needs_review','rejected'\)\)/);
  assert.match(sql, /inventory_item_id uuid not null references public\.inventory_items\(id\) on delete cascade/);
});

test('atlas_flavor_snapshot is a stable security definer reader with empty search_path, service_role only', () => {
  const sql = stripComments(S95A);
  const start = sql.indexOf('create or replace function public.atlas_flavor_snapshot()');
  const fn = sql.slice(start, sql.indexOf('$function$;', start));
  const header = fn.slice(0, fn.indexOf('as $function$'));
  assert.match(header, /returns jsonb/);
  assert.match(header, /\bstable\b/);
  assert.match(header, /security definer/);
  assert.match(header, /set search_path = ''/);
  assert.match(sql, /revoke all on function public\.atlas_flavor_snapshot\(\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.atlas_flavor_snapshot\(\) to service_role;/);
  for (const key of ['version', 'sources', 'ingredients', 'aliases', 'preparations', 'ingredient_preparations', 'edges', 'links']) {
    assert.ok(fn.includes(`'${key}'`), `snapshot has ${key}`);
  }
  assert.match(fn, /where l\.status in \('confirmed','needs_review'\)/);
  // links never copy product facts from inventory
  assert.doesNotMatch(fn, /public\.inventory_items/);
  // every relation in the body is schema-qualified
  for (const m of fn.matchAll(/\b(from|join)\s+([a-z_][a-z0-9_.]*)/g)) {
    if (m[2] === 'body') continue;
    assert.match(m[2], /^(atlas_private|pg_catalog)\./, `unqualified relation ${m[2]}`);
  }
});

test('every s95 function is security definer or invoker with search_path pinned; no definer without it', () => {
  for (const sql of [S95A, S95B]) {
    const fns = stripComments(sql).split(/create or replace function /).slice(1);
    assert.ok(fns.length >= 1);
    for (const fn of fns) {
      const header = fn.slice(0, fn.search(/\bas \$/));
      assert.match(header, /set search_path = ''/, header.slice(0, 80));
    }
  }
});

test('no s95 migration writes to inventory, recipes, suppliers, stock, menus or purchasing', () => {
  const protectedTables = '(inventory_items|inventory_aliases|inventory_movements|recipes|recipe_ingredients|recipe_categories|suppliers|' +
    'purchase_orders|purchase_order_\\w+|inventory_count_\\w+|inventory_verified_balances|items|public_menu|profiles)';
  const write = new RegExp(`\\b(insert\\s+into|update|delete\\s+from|truncate(\\s+table)?|alter\\s+table|drop\\s+table)\\s+(only\\s+)?` +
    `((public|atlas_private|public_menu_private)\\.)?${protectedTables}\\b`, 'i');
  for (const [name, sql] of [['s95a', S95A], ['s95b', S95B], ['s95c', S95C]]) {
    const body = stripComments(sql);
    assert.doesNotMatch(body, write, name);
    // every write in the s95 files targets a flavor table
    for (const m of body.matchAll(/\b(insert\s+into|update|delete\s+from)\s+(?!on\b|set\b)([a-z_][a-z0-9_.]*)/gi)) {
      assert.match(m[2], /^atlas_private\.flavor_/, `${name}: ${m[0]}`);
    }
    // inventory is only ever read (FK + where exists)
    for (const m of body.matchAll(/[^\n]*public\.inventory_items[^\n]*/g)) {
      assert.match(m[0], /(references public\.inventory_items\(id\) on delete cascade|select 1 from public\.inventory_items ii where ii\.id = v\.inventory_item_id)/, m[0]);
    }
  }
});

test('s95b copies the S90F allow-list and only adds recipe.draft for admin/manager', () => {
  const body = (sql) => stripComments(sql.slice(sql.indexOf('create or replace function')));
  const before = body(S90F);
  const after = body(S95B);
  assert.equal(after.replace(",'recipe.draft'", ''), before);
  assert.match(after, /'par_level\.suggestion','recipe\.draft'\) then array\['admin','manager'\]::text\[\]/);
  assert.match(after, /revoke all on function atlas_private\.ai_action_allowed_roles\(text, jsonb\) from public, anon, authenticated;/);
  assert.match(after, /grant execute on function atlas_private\.ai_action_allowed_roles\(text, jsonb\) to service_role;/);
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/verify_s95b_recipe_draft_kind_preview.sql')));
});

test('the seed migration is reproducible from data/flavor (build_flavor_seed --check)', () => {
  const { sql, stats } = generateSql();
  assert.equal(fs.readFileSync(SEED_PATH, 'utf8'), sql, 'run node scripts/build_flavor_seed.mjs');
  assert.equal(generateSql().sql, sql, 'generation is deterministic');
  assert.equal(stats.edges_by_evidence.scientific, 0, 'no scientific evidence without a licensed provider');
  assert.equal(stats.edges_by_evidence.ai_interpretation, 0, 'AI text is never stored as evidence');
  assert.ok(stats.ingredients >= 200 && stats.edges >= 900 && stats.preparations >= 20);
});

test('item links and the mapping report are reproducible (build_flavor_item_links --check)', () => {
  const { linksJson, report } = buildAll();
  assert.equal(read('data/flavor/item-links.json'), linksJson, 'run node scripts/build_flavor_item_links.mjs');
  assert.equal(read('docs/flavor/Mapping_Report.md'), report, 'run node scripts/build_flavor_item_links.mjs');
});

test('seed: upserts only into flavor tables, deterministic ids, links guarded by where exists', () => {
  const body = stripComments(S95C);
  assert.equal((body.match(/on conflict/g) ?? []).length, (body.match(/insert into/g) ?? []).length, 'every insert is an upsert');
  assert.match(body, /where exists \(select 1 from public\.inventory_items ii where ii\.id = v\.inventory_item_id\)/);
  assert.match(body, /where atlas_private\.flavor_item_links\.reviewed_at is null/);
  assert.doesNotMatch(body, /'scientific'|'ai_interpretation'/);
  assert.doesNotMatch(body, /gen_random_uuid/);
  // the md5 uuid is the SQL md5(key)::uuid (value checked against Postgres)
  assert.equal(ingredientId('gin'), 'ebf0f90c-305a-5632-f23f-9bf327ded4d0');
  assert.equal(md5Uuid('flavor:gin'), ingredientId('gin'));
  assert.ok(body.includes(`'${ingredientId('gin')}'::uuid, 'gin'`));
});

test('curated data: kebab slugs, edges reference known slugs, linked ingredients have >= 4 edges', () => {
  const { ingredients } = JSON.parse(read('data/flavor/ingredients.json'));
  const { edges } = JSON.parse(read('data/flavor/pairings.json'));
  const { entries } = JSON.parse(read('data/flavor/item-links.json'));
  const slugs = new Set(ingredients.map((i) => i.slug));
  for (const i of ingredients) {
    assert.match(i.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(i.provider, 'atlas_curated');
    assert.ok(i.confidence > 0 && i.confidence <= 0.7, `${i.slug}: honest confidence`);
    assert.doesNotMatch(i.name, /chartreuse|b[ée]n[ée]dictine-style/i, 'generic display names');
    for (const a of i.aliases) assert.match(aliasKey(a.alias), /^[a-z0-9]+( [a-z0-9]+)*$/);
  }
  const degree = new Map();
  for (const e of edges) {
    assert.ok(slugs.has(e.a) && slugs.has(e.b), `${e.a}~${e.b}`);
    assert.equal(e.evidence_type, 'culinary');
    assert.ok(e.explanation.length > 15, `${e.a}~${e.b}: explanation`);
    assert.doesNotMatch(e.explanation, /^\S+ suits? \S+\.$/, `${e.a}~${e.b}: generic explanation`);
    for (const s of [e.a, e.b]) degree.set(s, (degree.get(s) ?? 0) + 1);
  }
  const linked = new Set(entries.filter((e) => e.status === 'confirmed' || e.status === 'needs_review').map((e) => e.slug));
  for (const s of linked) assert.ok((degree.get(s) ?? 0) >= 4, `${s} has ${degree.get(s) ?? 0} edges`);
  // Icelandic names map through aliases/rules
  const bySlugName = (name) => entries.find((e) => e.item_name === name);
  assert.equal(bySlugName('Mynta / Mint 50 g').slug, 'mint');
  assert.equal(bySlugName('Kókosrjómi 20/22% 400ml').slug, 'coconut-cream');
  assert.equal(bySlugName('Haframjólk Natrue Barista 1L').slug, 'oat-milk');
  assert.equal(bySlugName('Appelsín').slug, 'orange-soda');
  assert.equal(bySlugName("Gordon's London Dry Gin 700ml").slug, 'gin');
  assert.equal(bySlugName("Gordon's Premium Pink Gin 700ml").slug, 'pink-gin');
  // non-ingredients are excluded, never linked
  for (const e of entries.filter((x) => /^(Consumables|Bar Equipment)$/.test(x.category))) assert.equal(e.status, 'excluded');
});

test('inventory snapshot carries names and categories only (no costs, quantities, suppliers)', () => {
  const snap = JSON.parse(read('data/flavor/inventory-snapshot.json'));
  for (const item of snap.items) {
    assert.deepEqual(Object.keys(item).sort(), ['active', 'category', 'id', 'name', 'subcategory', 'unit']);
  }
  const recipes = JSON.parse(read('data/flavor/recipes-snapshot.json'));
  for (const r of recipes.recipes) assert.deepEqual(Object.keys(r).sort(), ['active', 'id', 'name', 'type']);
  for (const l of recipes.lines) assert.deepEqual(Object.keys(l).sort(), ['item_id', 'recipe_id']);
});
