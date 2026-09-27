#!/usr/bin/env node
// S95 Flavor Intelligence: generate the seed migration
// supabase/migrations/20261005092000_s95c_flavor_seed.sql from data/flavor/*.json.
//
// Deterministic: rows sorted, ids = md5 uuids of stable keys (see
// build_flavor_common.mjs; identical to SQL md5(key)::uuid), JSON keys sorted.
// Idempotent: every insert is an upsert; an unchanged row is not touched, a
// changed curated row gets version + 1. Item links are inserted only where the
// inventory item exists (a replay on an empty database inserts none) and never
// overwrite a link a manager has reviewed. Nothing here writes to inventory,
// recipes, suppliers, stock, menus or purchasing.
//
// Usage: node scripts/build_flavor_seed.mjs          write the migration
//        node scripts/build_flavor_seed.mjs --check  fail if the committed file differs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aliasKey, ingredientId, preparationId, edgeId, RELATIONS, EVIDENCE_TYPES, USES, TASTE_KEYS,
  SLUG_RE, ALIAS_KEY_RE,
} from "./build_flavor_common.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data/flavor");
export const SEED_PATH = join(ROOT, "supabase/migrations/20261005092000_s95c_flavor_seed.sql");
const read = (name) => JSON.parse(readFileSync(join(DATA, name), "utf8"));

// ------------------------------------------------------------------ SQL literals
const q = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`not a number: ${v}`);
  return String(v);
};
const bool = (v) => (v ? "true" : "false");
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}
const jsonb = (v) => `${q(JSON.stringify(sortKeys(v ?? {})))}::jsonb`;
const textArr = (arr) => (arr && arr.length ? `array[${arr.map(q).join(",")}]::text[]` : "'{}'::text[]");

// ------------------------------------------------------------------ validation
function fail(msg) {
  throw new Error(`flavor seed: ${msg}`);
}

export function loadAndValidate() {
  const { sources } = read("sources.json");
  const { ingredients } = read("ingredients.json");
  const { preparations } = read("preparations.json");
  const { edges } = read("pairings.json");
  const { entries } = read("item-links.json");

  const sourceIds = new Set();
  for (const s of sources) {
    if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(s.id)) fail(`bad source id ${s.id}`);
    if (sourceIds.has(s.id)) fail(`duplicate source ${s.id}`);
    if (!["use", "use_with_attribution", "do_not_ingest", "needs_legal_review"].includes(s.verdict)) fail(`bad verdict ${s.id}`);
    sourceIds.add(s.id);
  }
  const usable = new Set(sources.filter((s) => s.verdict === "use" || s.verdict === "use_with_attribution").map((s) => s.id));

  const slugs = new Set();
  for (const i of ingredients) {
    if (!SLUG_RE.test(i.slug)) fail(`bad slug ${i.slug}`);
    if (slugs.has(i.slug)) fail(`duplicate slug ${i.slug}`);
    slugs.add(i.slug);
    if (!usable.has(i.provider)) fail(`${i.slug}: provider ${i.provider} is not usable`);
    if (!(i.confidence >= 0 && i.confidence <= 1)) fail(`${i.slug}: confidence`);
    if (i.intensity != null && !(i.intensity >= 1 && i.intensity <= 5)) fail(`${i.slug}: intensity`);
    for (const [k, v] of Object.entries(i.aroma)) if (!(v >= 0 && v <= 1)) fail(`${i.slug}: aroma ${k}`);
    for (const k of Object.keys(i.taste)) if (!TASTE_KEYS.includes(k)) fail(`${i.slug}: taste key ${k}`);
    for (const v of Object.values(i.taste)) if (!(v >= 0 && v <= 5)) fail(`${i.slug}: taste value`);
    for (const u of i.uses) if (!USES.includes(u)) fail(`${i.slug}: use ${u}`);
    for (const a of i.aliases) if (!ALIAS_KEY_RE.test(aliasKey(a.alias))) fail(`${i.slug}: alias ${a.alias}`);
  }
  const prepSlugs = new Set();
  for (const p of preparations) {
    if (!SLUG_RE.test(p.slug) || prepSlugs.has(p.slug)) fail(`bad or duplicate preparation ${p.slug}`);
    prepSlugs.add(p.slug);
  }
  const edgeKeys = new Set();
  for (const e of edges) {
    for (const s of [e.a, e.b]) if (!slugs.has(s)) fail(`edge references unknown slug ${s}`);
    for (const p of [e.a_prep, e.b_prep]) if (p && !prepSlugs.has(p)) fail(`edge references unknown preparation ${p}`);
    if (e.a === e.b) fail(`self edge ${e.a}`);
    if (!RELATIONS.includes(e.relation)) fail(`bad relation ${e.relation}`);
    if (!EVIDENCE_TYPES.includes(e.evidence_type)) fail(`bad evidence ${e.evidence_type}`);
    if (e.evidence_type === "scientific" && !usable.has(e.provider)) fail("scientific edge without a usable provider");
    if (!usable.has(e.provider)) fail(`edge provider ${e.provider} is not usable`);
    if (!(e.strength >= 0 && e.strength <= 1) || !(e.confidence >= 0 && e.confidence <= 1)) fail(`edge ${e.a}~${e.b} range`);
    if (!e.explanation || !e.explanation.trim()) fail(`edge ${e.a}~${e.b} has no explanation`);
    for (const c of e.contexts ?? []) if (!USES.includes(c)) fail(`edge context ${c}`);
    const [x, y] = [e.a, e.b].sort();
    const key = `${x}|${y}|${e.relation}|${e.evidence_type}`;
    if (edgeKeys.has(key)) fail(`duplicate edge ${key}`);
    edgeKeys.add(key);
  }
  for (const l of entries) {
    if (l.slug && !slugs.has(l.slug)) fail(`link to unknown slug ${l.slug}`);
    if (l.preparation && !prepSlugs.has(l.preparation)) fail(`link to unknown preparation ${l.preparation}`);
  }
  return { sources, ingredients, preparations, edges, entries };
}

// ------------------------------------------------------------------ SQL
function chunk(rows, size = 200) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// Undirected edge in canonical order: lower ingredient id first (the table's check).
function orderEdge(e) {
  const aId = ingredientId(e.a);
  const bId = ingredientId(e.b);
  return aId < bId
    ? { ...e, a_prep: e.a_prep ?? null, b_prep: e.b_prep ?? null }
    : { ...e, a: e.b, b: e.a, a_prep: e.b_prep ?? null, b_prep: e.a_prep ?? null };
}

// Cosine similarity of the two aroma vectors: a derived number from the
// curated vectors (not a measurement), exposed as aroma_score.
function cosine(x, y) {
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  let dot = 0, nx = 0, ny = 0;
  for (const k of keys) {
    const a = x[k] ?? 0, b = y[k] ?? 0;
    dot += a * b; nx += a * a; ny += b * b;
  }
  if (!nx || !ny) return null;
  return Math.round((dot / Math.sqrt(nx * ny)) * 1000) / 1000;
}

export function generateSql() {
  const { sources, ingredients, preparations, edges, entries } = loadAndValidate();
  const bySlug = new Map(ingredients.map((i) => [i.slug, i]));
  const prepMatch = new Map();
  for (const p of preparations) for (const m of p.matches ?? []) prepMatch.set(m.replace(/_/g, "-"), p.slug);

  const out = [];
  const add = (s = "") => out.push(s);
  add("-- S95C Atlas Flavor Intelligence: curated seed (GENERATED, do not edit by hand).");
  add("--");
  add("-- Generated by `node scripts/build_flavor_seed.mjs` from data/flavor/sources.json,");
  add("-- ingredients.json, preparations.json, pairings.json and item-links.json.");
  add("-- `node scripts/build_flavor_seed.mjs --check` fails when this file is stale.");
  add("--");
  add("-- * Ids are md5 uuids of stable keys ('flavor:<slug>', 'flavor-prep:<slug>',");
  add("--   'flavor-edge:<a>|<a_prep>|<b>|<b_prep>|<relation>|<evidence>'), so a replay");
  add("--   produces the same ids. Every insert is an upsert: an unchanged row is left");
  add("--   alone, a changed curated row is updated and its version bumped.");
  add("-- * All evidence here is `culinary` from provider `atlas_curated` (Atlas-authored");
  add("--   from general culinary knowledge; draft, needs human review). Nothing is");
  add("--   labelled scientific. atlas_learned evidence is computed at runtime from the");
  add("--   venue's own recipes and is not stored here.");
  add("-- * Item links: only for inventory items that exist (where exists on");
  add("--   public.inventory_items, a read). On an empty database no link is inserted.");
  add("--   A link a manager has reviewed (reviewed_at set) is never overwritten.");
  add("-- * No statement writes to inventory, recipes, suppliers, stock, menus or");
  add("--   purchasing tables.");
  add("");

  // sources
  const srcRows = [...sources].sort((a, b) => a.id.localeCompare(b.id)).map((s) =>
    `  (${q(s.id)}, ${q(s.name)}, ${q(s.url)}, ${q(s.license)}, ${bool(s.commercial_use)}, ${q(s.attribution)}, ${q(s.verdict)}, ${q(s.notes)})`);
  add("-- ------------------------------------------------------------------ sources");
  add("insert into atlas_private.flavor_sources (id, name, url, license, commercial_use, attribution, verdict, notes) values");
  add(srcRows.join(",\n"));
  add("on conflict (id) do update set name = excluded.name, url = excluded.url, license = excluded.license,");
  add("  commercial_use = excluded.commercial_use, attribution = excluded.attribution, verdict = excluded.verdict, notes = excluded.notes");
  add("where (atlas_private.flavor_sources.name, atlas_private.flavor_sources.url, atlas_private.flavor_sources.license,");
  add("       atlas_private.flavor_sources.commercial_use, atlas_private.flavor_sources.attribution,");
  add("       atlas_private.flavor_sources.verdict, atlas_private.flavor_sources.notes)");
  add("  is distinct from (excluded.name, excluded.url, excluded.license, excluded.commercial_use, excluded.attribution,");
  add("       excluded.verdict, excluded.notes);");
  add("");

  // preparations
  const prepRows = [...preparations].sort((a, b) => a.slug.localeCompare(b.slug)).map((p) =>
    `  (${q(preparationId(p.slug))}::uuid, ${q(p.slug)}, ${q(p.name)}, ${jsonb(p.taste_shift)}, ${jsonb(p.aroma_shift)}, ${q(p.texture)}, ${q(p.notes)})`);
  add("-- ------------------------------------------------------------------ preparations");
  add("insert into atlas_private.flavor_preparations (id, slug, name, taste_shift, aroma_shift, texture, notes) values");
  add(prepRows.join(",\n"));
  add("on conflict (slug) do update set name = excluded.name, taste_shift = excluded.taste_shift,");
  add("  aroma_shift = excluded.aroma_shift, texture = excluded.texture, notes = excluded.notes");
  add("where (atlas_private.flavor_preparations.name, atlas_private.flavor_preparations.taste_shift,");
  add("       atlas_private.flavor_preparations.aroma_shift, atlas_private.flavor_preparations.texture,");
  add("       atlas_private.flavor_preparations.notes)");
  add("  is distinct from (excluded.name, excluded.taste_shift, excluded.aroma_shift, excluded.texture, excluded.notes);");
  add("");

  // ingredients
  const ingSorted = [...ingredients].sort((a, b) => a.slug.localeCompare(b.slug));
  add("-- ------------------------------------------------------------------ ingredients");
  const ingCols = ["name", "family", "subfamily", "aroma", "taste", "intensity", "texture", "abv_typical", "allergens",
    "dietary", "uses", "techniques", "attributes", "provider", "confidence"];
  for (const part of chunk(ingSorted, 120)) {
    add("insert into atlas_private.flavor_ingredients (id, slug, name, family, subfamily, aroma, taste, intensity, texture,");
    add("  abv_typical, allergens, dietary, uses, techniques, attributes, provider, confidence, version) values");
    add(part.map((i) => {
      const attributes = { ...(i.attributes ?? {}), seed_origin: i.origin ?? null };
      if (attributes.seed_origin === null) delete attributes.seed_origin;
      return `  (${q(ingredientId(i.slug))}::uuid, ${q(i.slug)}, ${q(i.name)}, ${q(i.family)}, ${q(i.subfamily)}, ${jsonb(i.aroma)}, ${jsonb(i.taste)}, ` +
        `${num(i.intensity)}, ${q(i.texture)}, ${num(i.abv_typical)}, ${textArr(i.allergens)}, ${textArr(i.dietary)}, ` +
        `${textArr(i.uses)}, ${textArr(i.techniques)}, ${jsonb(attributes)}, ${q(i.provider)}, ${num(i.confidence)}, 1)`;
    }).join(",\n"));
    add(`on conflict (slug) do update set ${ingCols.map((c) => `${c} = excluded.${c}`).join(", ")},`);
    add("  version = atlas_private.flavor_ingredients.version + 1");
    add(`where (${ingCols.map((c) => `atlas_private.flavor_ingredients.${c}`).join(", ")})`);
    add(`  is distinct from (${ingCols.map((c) => `excluded.${c}`).join(", ")});`);
    add("");
  }

  // aliases
  const aliasRows = [];
  for (const i of ingSorted) {
    const seen = new Set();
    for (const a of i.aliases ?? []) {
      const key = aliasKey(a.alias);
      if (seen.has(key)) continue;
      seen.add(key);
      aliasRows.push([i.slug, a.alias, key, a.language ?? "en"]);
    }
  }
  aliasRows.sort((x, y) => x[0].localeCompare(y[0]) || x[2].localeCompare(y[2]));
  add("-- ------------------------------------------------------------------ aliases");
  for (const part of chunk(aliasRows, 250)) {
    add("insert into atlas_private.flavor_aliases (ingredient_id, alias, alias_key, language)");
    add("select i.id, v.alias, v.alias_key, v.language");
    add("from (values");
    add(part.map(([slug, alias, key, lang]) => `  (${q(slug)}, ${q(alias)}, ${q(key)}, ${q(lang)})`).join(",\n"));
    add(") as v(slug, alias, alias_key, language)");
    add("join atlas_private.flavor_ingredients i on i.slug = v.slug");
    add("on conflict (ingredient_id, alias_key) do update set alias = excluded.alias, language = excluded.language");
    add("where (atlas_private.flavor_aliases.alias, atlas_private.flavor_aliases.language) is distinct from (excluded.alias, excluded.language);");
    add("");
  }

  // ingredient preparations: technique words + every preparation used by an item link
  const ipSet = new Set();
  for (const i of ingSorted) {
    for (const t of i.techniques ?? []) {
      const p = prepMatch.get(t);
      if (p) ipSet.add(`${i.slug}\t${p}`);
    }
  }
  for (const l of entries) if (l.slug && l.preparation) ipSet.add(`${l.slug}\t${l.preparation}`);
  const ipRows = [...ipSet].sort().map((s) => s.split("\t"));
  add("-- ------------------------------------------------------------------ ingredient preparations");
  add("insert into atlas_private.flavor_ingredient_preparations (ingredient_id, preparation_id)");
  add("select i.id, p.id");
  add("from (values");
  add(ipRows.map(([s, p]) => `  (${q(s)}, ${q(p)})`).join(",\n"));
  add(") as v(slug, preparation)");
  add("join atlas_private.flavor_ingredients i on i.slug = v.slug");
  add("join atlas_private.flavor_preparations p on p.slug = v.preparation");
  add("on conflict (ingredient_id, preparation_id) do nothing;");
  add("");

  // edges
  const edgeRows = edges.map(orderEdge).map((e) => ({
    ...e,
    id: edgeId(e),
    aroma_score: e.aroma_score ?? cosine(bySlug.get(e.a).aroma, bySlug.get(e.b).aroma),
  })).sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.relation.localeCompare(y.relation) || x.evidence_type.localeCompare(y.evidence_type));
  add("-- ------------------------------------------------------------------ edges");
  add("-- aroma_score = cosine similarity of the two curated aroma vectors (derived, not measured).");
  const edgeCols = ["relation", "strength", "aroma_score", "taste_score", "texture_score", "contexts", "evidence_type", "provider", "confidence", "explanation"];
  const upd = ["strength", "aroma_score", "taste_score", "texture_score", "contexts", "provider", "confidence", "explanation"];
  for (const part of chunk(edgeRows, 200)) {
    add("insert into atlas_private.flavor_edges (id, a_id, a_prep, b_id, b_prep, relation, strength, aroma_score, taste_score,");
    add("  texture_score, contexts, evidence_type, provider, confidence, explanation, version)");
    add("select v.id::uuid, ia.id, pa.id, ib.id, pb.id, v.relation, v.strength, v.aroma_score, v.taste_score,");
    add("  v.texture_score, v.contexts, v.evidence_type, v.provider, v.confidence, v.explanation, 1");
    add("from (values");
    add(part.map((e) =>
      `  (${q(e.id)}, ${q(e.a)}, ${q(e.a_prep)}, ${q(e.b)}, ${q(e.b_prep)}, ${q(e.relation)}, ${num(e.strength)}::numeric, ` +
      `${num(e.aroma_score)}::numeric, ${num(e.taste_score ?? null)}::numeric, ${num(e.texture_score ?? null)}::numeric, ` +
      `${textArr(e.contexts)}, ${q(e.evidence_type)}, ${q(e.provider)}, ${num(e.confidence)}::numeric, ${q(e.explanation)})`).join(",\n"));
    add(`) as v(id, a, a_prep, b, b_prep, ${edgeCols.join(", ")})`);
    add("join atlas_private.flavor_ingredients ia on ia.slug = v.a");
    add("join atlas_private.flavor_ingredients ib on ib.slug = v.b");
    add("left join atlas_private.flavor_preparations pa on pa.slug = v.a_prep");
    add("left join atlas_private.flavor_preparations pb on pb.slug = v.b_prep");
    add("on conflict (id) do update set " + upd.map((c) => `${c} = excluded.${c}`).join(", ") + ",");
    add("  version = atlas_private.flavor_edges.version + 1");
    add(`where (${upd.map((c) => `atlas_private.flavor_edges.${c}`).join(", ")})`);
    add(`  is distinct from (${upd.map((c) => `excluded.${c}`).join(", ")});`);
    add("");
  }

  // item links
  const linkRows = entries
    .filter((l) => l.status === "confirmed" || l.status === "needs_review")
    .map((l) => [l.inventory_item_id, l.slug, l.preparation ?? null, l.status, l.match_method, l.confidence, l.note ?? null])
    .sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
  add("-- ------------------------------------------------------------------ item links");
  add("-- Inventory -> canonical ingredient. Reads public.inventory_items only to skip");
  add("-- items that do not exist; a manager-reviewed link is never overwritten.");
  add("insert into atlas_private.flavor_item_links (inventory_item_id, ingredient_id, preparation_id, status, match_method, confidence, note)");
  add("select v.inventory_item_id, i.id, p.id, v.status, v.match_method, v.confidence, v.note");
  add("from (values");
  add(linkRows.map(([id, slug, prep, status, method, conf, note]) =>
    `  (${q(id)}::uuid, ${q(slug)}, ${q(prep)}, ${q(status)}, ${q(method)}, ${num(conf)}::numeric, ${q(note)})`).join(",\n"));
  add(") as v(inventory_item_id, slug, preparation, status, match_method, confidence, note)");
  add("join atlas_private.flavor_ingredients i on i.slug = v.slug");
  add("left join atlas_private.flavor_preparations p on p.slug = v.preparation");
  add("where exists (select 1 from public.inventory_items ii where ii.id = v.inventory_item_id)");
  add("on conflict (inventory_item_id, ingredient_id) do update set preparation_id = excluded.preparation_id,");
  add("  status = excluded.status, match_method = excluded.match_method, confidence = excluded.confidence, note = excluded.note");
  add("where atlas_private.flavor_item_links.reviewed_at is null");
  add("  and (atlas_private.flavor_item_links.preparation_id, atlas_private.flavor_item_links.status,");
  add("       atlas_private.flavor_item_links.match_method, atlas_private.flavor_item_links.confidence,");
  add("       atlas_private.flavor_item_links.note)");
  add("  is distinct from (excluded.preparation_id, excluded.status, excluded.match_method, excluded.confidence, excluded.note);");
  add("");
  const stats = {
    sources: sources.length, ingredients: ingredients.length, aliases: aliasRows.length,
    preparations: preparations.length, ingredient_preparations: ipRows.length, edges: edgeRows.length,
    edges_by_evidence: Object.fromEntries(EVIDENCE_TYPES.map((t) => [t, edgeRows.filter((e) => e.evidence_type === t).length])),
    edges_by_relation: Object.fromEntries(RELATIONS.map((r) => [r, edgeRows.filter((e) => e.relation === r).length])),
    item_links: linkRows.length,
    item_links_by_status: {
      confirmed: linkRows.filter((r) => r[3] === "confirmed").length,
      needs_review: linkRows.filter((r) => r[3] === "needs_review").length,
    },
  };
  add(`-- Seed counts: ${JSON.stringify(stats)}`);
  return { sql: out.join("\n") + "\n", stats };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { sql, stats } = generateSql();
  if (process.argv.includes("--check")) {
    const current = existsSync(SEED_PATH) ? readFileSync(SEED_PATH, "utf8") : "";
    if (current !== sql) {
      console.error("20261005092000_s95c_flavor_seed.sql is stale: run node scripts/build_flavor_seed.mjs");
      process.exit(1);
    }
    console.log("flavor seed up to date", JSON.stringify(stats));
  } else {
    writeFileSync(SEED_PATH, sql);
    console.log("wrote", SEED_PATH, JSON.stringify(stats));
  }
}
