// Visual inventory recognition evaluation harness (WP10, design §10).
//
// Each case is what the vision model returns for a photo (a text
// description of the image in the strict extraction schema, in a compact
// form expanded here), plus client barcodes, mode and context, and the
// expected result per detection:
//   { item: "<catalogue item name>" | null, band: [...acceptable bands],
//     must_not_match: [names], top3_includes: [names] }
// The real pipeline (_shared/recognition/pipeline.mjs) runs against the
// catalogue snapshot through the JavaScript twin of the retrieval RPCs, so
// retrieval, scoring, bands and evidence are tested without images or a
// database. scripts/recognition_eval.mjs runs the same metrics on a live
// image set later.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identify, searchText } from '../../../supabase/functions/_shared/recognition/pipeline.mjs';
import { collapseAcronyms, sanitizeExtraction } from '../../../supabase/functions/_shared/recognition/extract.mjs';
import { classForCategory, localCandidates, localResolveCodes } from '../../../supabase/functions/_shared/recognition/retrieve.mjs';
import { duplicateKeys, duplicateScore, DUPLICATE_THRESHOLDS, normalizeCode } from '../../../supabase/functions/_shared/product-identity.mjs';

export const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function loadCatalog(file = path.join(FIXTURE_DIR, 'catalog.json')) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed.items;
}

export function loadCases(dir = path.join(FIXTURE_DIR, 'cases')) {
  return fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()
    .flatMap((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).map((entry) => ({ ...entry, __file: file })));
}

// Name -> id; an active item wins over an inactive one with the same name.
export function nameIndex(catalog) {
  const index = new Map();
  for (const item of catalog) {
    const existing = index.get(item.name);
    if (!existing || (!existing.active && item.active !== false)) index.set(item.name, item);
  }
  return index;
}

const field = (pair, max) => (pair ? { value: pair[0], confidence: pair[1], evidence: pair[2] ?? 'label text' } : null);

// Compact detection -> the model's strict JSON shape.
export function expandDetection(short, index) {
  const s = short ?? {};
  return {
    detection_index: index,
    bbox: s.bbox ?? null,
    visible_text: (s.txt ?? []).map(([text, role, confidence]) => ({ text, role, confidence })),
    brand: field(s.b), product_name: field(s.pn), variant: field(s.v), subcategory: field(s.sub),
    category_class: field(s.cls), packaging_type: field(s.pk),
    unit_size: s.sz ? { quantity: s.sz[0], unit: s.sz[1], text: s.sz[2] ?? null, confidence: s.sz[3] ?? 85, inferred: s.sz[4] === true, evidence: 'label text' }
      : { quantity: null, unit: null, text: null, inferred: false, confidence: 0, evidence: null },
    units_per_case: s.upc ? { value: s.upc[0], text: null, confidence: s.upc[1] ?? 85, evidence: 'label text' } : null,
    barcode_digits: field(s.bc),
    sku_or_supplier_ref: s.ref ? { value: s.ref[0], confidence: s.ref[1], label_text: s.ref[2] ?? null, evidence: 'delivery note' } : null,
    abv_percent: s.abv ? { value: s.abv[0], confidence: s.abv[1], evidence: 'label text' } : null,
    language: s.lang ?? null,
  };
}

function caseContext(entry, byName) {
  const context = { ...(entry.context ?? {}) };
  const local = {
    order_item_ids: (entry.on_order ?? []).map((name) => byName.get(name)?.id).filter(Boolean),
    session_item_ids: (entry.in_session ?? []).map((name) => byName.get(name)?.id).filter(Boolean),
  };
  return { context, local };
}

// Local stand-ins for the recognition RPCs over the catalogue.
export function localRpc(catalog, local = {}) {
  return async (name, args) => {
    if (name === 'atlas_recognition_resolve_codes') return localResolveCodes(catalog, args.p_codes);
    if (name === 'atlas_recognition_candidates') return localCandidates(catalog, args.p_signals, { role: args.p_actor_role, limit: args.p_limit, context: local });
    throw new Error(`unexpected rpc ${name}`);
  };
}

const ACTOR = { userId: '00000000-0000-4000-8000-00000000e7a1', role: 'manager', label: 'Evaluation' };

export async function runCase(entry, catalog, byName) {
  const { context, local } = caseContext(entry, byName);
  const rpc = localRpc(catalog, local);
  if (entry.query !== undefined) {
    const result = await searchText((signals) => localCandidates(catalog, signals, { role: 'manager', limit: 25, context: local }), entry.query, { context });
    return [{ band: result.decision.band, preselected_item_id: result.decision.preselected_item_id, candidates: result.ranked.map((candidate) => ({ item_id: candidate.item_id, score: candidate.score ?? candidate.p, item: candidate.item, explanation: candidate.explanation })), field_confidence: null }];
  }
  const hasImage = Boolean(entry.detections || entry.image_quality);
  const extraction = sanitizeExtraction({
    image_quality: entry.image_quality ?? { usable: true, issues: [] },
    detections: (entry.detections ?? []).map(expandDetection),
    notes: null,
  });
  const response = await identify({
    rpc,
    actor: ACTOR,
    vision: hasImage ? async () => ({ extraction, model: 'fixture', ms: 0 }) : null,
    record: false,
  }, {
    client_request_id: '00000000-0000-4000-8000-0000000e7a1c',
    mode: entry.mode ?? 'identify',
    context,
    client_barcodes: entry.client_barcodes ?? [],
    image: hasImage ? { dataUrl: 'data:image/jpeg;base64,AA==' } : null,
  });
  return response.detections;
}

// The duplicate guard a "Create new product draft" runs (JS twin of
// catalog_find_duplicates_core scoring) for the evidence of one detection.
export function draftFromCase(entry, detectionIndex) {
  if (entry.query !== undefined) {
    const typed = /^[A-Za-z0-9-]{4,40}$/.test(entry.query) && /[0-9]/.test(entry.query);
    return { name: entry.query, codes: typed ? [{ kind: 'gtin', code: entry.query }, { kind: 'sku', code: entry.query }] : [] };
  }
  const short = entry.detections?.[detectionIndex] ?? {};
  // The add-product draft is pre-filled from the normalised reading.
  const name = collapseAcronyms([short.b?.[0], short.pn?.[0], short.v?.[0]].filter(Boolean).join(' ')
    || (short.txt ?? []).map(([text]) => text).join(' '));
  const draft = { name, brand: short.b?.[0] ?? null, item_class: short.cls?.[0] ?? null, codes: [] };
  if (short.sz && !short.sz[4]) {
    const [quantity, unit] = short.sz;
    const factor = { ml: ['ml', 1], cl: ['ml', 10], l: ['ml', 1000], g: ['g', 1], kg: ['g', 1000], count: ['count', 1] }[unit];
    if (factor) { draft.unit_size_quantity = quantity * factor[1]; draft.unit_size_base = factor[0]; }
  }
  const codes = [...(entry.client_barcodes ?? []).map((code) => (typeof code === 'string' ? code : code.raw)), short.bc?.[0], short.ref?.[0]].filter(Boolean);
  for (const raw of codes) {
    const gtin = normalizeCode(raw);
    if (gtin.valid && gtin.kind === 'gtin') draft.codes.push({ kind: 'gtin', code: raw });
    else for (const kind of ['sku', 'other_barcode', 'supplier_ref']) draft.codes.push({ kind, code: raw });
  }
  return draft;
}

export function duplicateCandidates(draft, catalog) {
  const keys = duplicateKeys(draft);
  return catalog.map((item) => {
    const itemKeys = duplicateKeys({ ...item, item_class: item.item_class ?? classForCategory(item.category, item.subcategory),
      aliases: (item.aliases ?? []).filter((alias) => alias.status !== 'retired' && alias.alias_kind !== 'recipe_label'),
      codes: (item.codes ?? []).filter((code) => code.status !== 'retired') });
    return { item, ...duplicateScore(keys, itemKeys) };
  }).filter((entry) => entry.score >= DUPLICATE_THRESHOLDS.listed).sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export async function evaluate(cases, catalog) {
  const byName = nameIndex(catalog);
  const idOf = (name) => {
    const item = byName.get(name);
    if (!item) throw new Error(`Unknown catalogue item in case: ${name}`);
    return item.id;
  };
  const rows = [];
  for (const entry of cases) {
    const detections = await runCase(entry, catalog, byName);
    const expectations = Array.isArray(entry.expect) ? entry.expect : [entry.expect];
    for (const [index, expect] of expectations.entries()) {
      const detection = detections[index] ?? { band: 'low', candidates: [], preselected_item_id: null };
      const expectedId = expect.item ? idOf(expect.item) : null;
      const mustNot = (expect.must_not_match ?? []).map(idOf);
      const top = detection.candidates[0] ?? null;
      const topIds = detection.candidates.slice(0, 3).map((candidate) => candidate.item_id);
      const high = detection.band === 'high';
      const wrongPreselect = Boolean(detection.preselected_item_id) && detection.preselected_item_id !== expectedId;
      const falseMerge = wrongPreselect || (high && (!top || top.item_id !== expectedId)) || (high && top && mustNot.includes(top.item_id));
      const siblingAtTop = Boolean(top) && mustNot.includes(top.item_id) && detection.band !== 'low';
      // "Create new product draft" shows the duplicate guard's possible
      // matches (>= 0.60) and the recognition candidates it already has.
      let guardRecall = null;
      let recall = null;
      if (expectedId) {
        const dup = duplicateCandidates(draftFromCase(entry, index), catalog);
        const hit = dup.find((candidate) => candidate.item.id === expectedId);
        guardRecall = Boolean(hit && (hit.score >= DUPLICATE_THRESHOLDS.possible || hit.code_collision));
        recall = guardRecall || topIds.includes(expectedId);
      }
      rows.push({
        id: `${entry.id}${expectations.length > 1 ? `#${index}` : ''}`,
        group: entry.group ?? entry.id.split('-')[0],
        expected: expect.item ?? null,
        band: detection.band,
        band_ok: (expect.band ?? ['high', 'medium', 'low']).includes(detection.band),
        top1: expectedId ? top?.item_id === expectedId : null,
        top3: expectedId ? topIds.includes(expectedId) : null,
        top3_includes_ok: (expect.top3_includes ?? []).every((name) => topIds.includes(idOf(name))),
        abstained: expectedId ? detection.band === 'low' : null,
        false_merge: falseMerge,
        sibling_at_top: siblingAtTop,
        preselected: detection.preselected_item_id ?? null,
        preselect_ok: expect.preselected === undefined ? true
          : expect.preselected ? detection.preselected_item_id === expectedId : !detection.preselected_item_id,
        p: top ? (top.score ?? 0) : 0,
        top_name: top?.item?.name ?? null,
        duplicate_recall: recall,
        duplicate_guard_alone: guardRecall,
        correct: expectedId ? top?.item_id === expectedId : detection.band === 'low',
        explanation: top?.explanation ?? null,
        field_confidence: detection.field_confidence ?? null,
      });
    }
  }
  return { rows, metrics: metricsFor(rows) };
}

export function calibrationTable(rows, bins = 10) {
  const table = Array.from({ length: bins }, (_, index) => ({ from: index / bins, to: (index + 1) / bins, n: 0, mean_p: 0, accuracy: 0 }));
  // Every detection with a rank-1 candidate: correct when rank 1 is the
  // expected item (a case with no expected item has no correct rank 1).
  const scored = rows.filter((entry) => entry.top_name !== null);
  for (const row of scored) {
    const bin = table[Math.min(bins - 1, Math.floor(row.p * bins))];
    bin.n += 1;
    bin.mean_p += row.p;
    bin.accuracy += row.top1 ? 1 : 0;
  }
  let ece = 0;
  const total = scored.length || 1;
  for (const bin of table) {
    if (bin.n) {
      bin.mean_p = Math.round((bin.mean_p / bin.n) * 1000) / 1000;
      bin.accuracy = Math.round((bin.accuracy / bin.n) * 1000) / 1000;
      ece += (bin.n / total) * Math.abs(bin.mean_p - bin.accuracy);
    }
  }
  return { table, ece: Math.round(ece * 1000) / 1000 };
}

export function metricsFor(rows) {
  const withItem = rows.filter((row) => row.top1 !== null);
  const rate = (list, key) => (list.length ? Math.round((list.filter((row) => row[key]).length / list.length) * 1000) / 1000 : null);
  const medium = withItem.filter((row) => row.band === 'medium');
  const recallRows = rows.filter((row) => row.duplicate_recall !== null);
  const byGroup = {};
  for (const row of withItem) {
    byGroup[row.group] ??= { n: 0, top1: 0 };
    byGroup[row.group].n += 1;
    byGroup[row.group].top1 += row.top1 ? 1 : 0;
  }
  return {
    detections: rows.length,
    with_expected_item: withItem.length,
    false_merges: rows.filter((row) => row.false_merge).length,
    sibling_at_top: rows.filter((row) => row.sibling_at_top).length,
    band_accuracy: rate(rows, 'band_ok'),
    top1_accuracy: rate(withItem, 'top1'),
    top3_accuracy: rate(withItem, 'top3'),
    top3_accuracy_medium: rate(medium, 'top3'),
    abstain_rate: rate(withItem, 'abstained'),
    high_band_share: Math.round((rows.filter((row) => row.band === 'high').length / (rows.length || 1)) * 1000) / 1000,
    duplicate_guard_recall: recallRows.length ? Math.round((recallRows.filter((row) => row.duplicate_recall).length / recallRows.length) * 1000) / 1000 : null,
    duplicate_guard_alone_recall: recallRows.length ? Math.round((recallRows.filter((row) => row.duplicate_guard_alone).length / recallRows.length) * 1000) / 1000 : null,
    top1_by_group: Object.fromEntries(Object.entries(byGroup).map(([group, value]) => [group, Math.round((value.top1 / value.n) * 1000) / 1000])),
    calibration: calibrationTable(rows),
  };
}
