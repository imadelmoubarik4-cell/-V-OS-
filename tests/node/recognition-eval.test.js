// WP10 CI gate for visual inventory recognition (design §10.3).
// The real recognition pipeline runs every fixture case (vision output as
// text, client barcodes, context) against the catalogue snapshot through
// the JavaScript twin of the recognition RPCs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, FIXTURE_DIR, loadCases, loadCatalog } from '../fixtures/visual-inventory/harness.mjs';
import { SCORER_VERSION } from '../../supabase/functions/_shared/recognition/bands.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'baseline.json'), 'utf8'));
const CATALOG = loadCatalog();
const CASES = loadCases();
const RESULT = await evaluate(CASES, CATALOG);
const { rows, metrics } = RESULT;
const gates = BASELINE.gates;

test('the fixture set is large, unique and covers every design group', () => {
  assert.ok(CASES.length >= gates.min_cases, `${CASES.length} cases`);
  assert.equal(new Set(CASES.map((entry) => entry.id)).size, CASES.length);
  for (const group of ['G', 'F', 'T', 'I', 'S', 'P', 'O', 'K', 'C', 'R', 'M', 'N', 'X', 'W', 'Q', 'D']) {
    assert.ok(CASES.some((entry) => entry.id.startsWith(`${group}-`)), `group ${group}`);
  }
  assert.equal(BASELINE.scorer_version, SCORER_VERSION, 'refresh baseline.json when the scorer version changes');
});

test('the catalogue snapshot is product data only', () => {
  const allowed = new Set(['id', 'name', 'category', 'subcategory', 'unit', 'size_ml', 'package_weight_g', 'package_size',
    'units_per_case', 'brand', 'active', 'canonical_key', 'supplier_id', 'codes', 'aliases']);
  for (const item of CATALOG) for (const key of Object.keys(item)) assert.ok(allowed.has(key), `${item.name}: ${key}`);
  const text = fs.readFileSync(path.join(FIXTURE_DIR, 'catalog.json'), 'utf8');
  assert.doesNotMatch(text, /cost_price|case_cost|email|phone|display_name|@/i);
});

test('false merges = 0: never High or pre-selected on the wrong item', () => {
  const merges = rows.filter((row) => row.false_merge);
  assert.deepEqual(merges.map((row) => `${row.id}: ${row.top_name} (${row.band})`), []);
  assert.equal(metrics.false_merges, gates.false_merges);
});

test('a must-not-match sibling is never rank 1 outside the Low band', () => {
  assert.deepEqual(rows.filter((row) => row.sibling_at_top).map((row) => `${row.id}: ${row.top_name}`), []);
});

test('pre-selection only where expected, and bands as expected', () => {
  assert.deepEqual(rows.filter((row) => !row.preselect_ok).map((row) => `${row.id}: ${row.preselected}`), []);
  assert.deepEqual(rows.filter((row) => !row.band_ok).map((row) => `${row.id}: ${row.band}`), []);
  assert.deepEqual(rows.filter((row) => !row.top3_includes_ok).map((row) => row.id), []);
  assert.ok(metrics.band_accuracy >= gates.min_band_accuracy);
});

test('duplicate-guard recall on the new-product draft path is 100 %', () => {
  assert.deepEqual(rows.filter((row) => row.duplicate_recall === false).map((row) => row.id), []);
  assert.equal(metrics.duplicate_guard_recall, gates.duplicate_guard_recall);
});

test('top-1 / top-3 accuracy, abstain rate and calibration meet the thresholds', () => {
  assert.ok(metrics.top1_accuracy >= gates.min_top1_accuracy, `top-1 ${metrics.top1_accuracy}`);
  assert.ok(metrics.top1_accuracy >= BASELINE.measured.top1_accuracy - gates.max_top1_regression, `top-1 regressed to ${metrics.top1_accuracy}`);
  assert.ok(metrics.top3_accuracy >= gates.min_top3_accuracy, `top-3 ${metrics.top3_accuracy}`);
  assert.ok(metrics.abstain_rate <= gates.max_abstain_rate, `abstain ${metrics.abstain_rate}`);
  assert.ok(metrics.calibration.ece <= gates.max_ece, `ECE ${metrics.calibration.ece}`);
  const report = [
    `recognition eval (${SCORER_VERSION}): ${metrics.detections} detections, ${metrics.with_expected_item} with an expected item`,
    `top-1 ${metrics.top1_accuracy} · top-3 ${metrics.top3_accuracy} · medium top-3 ${metrics.top3_accuracy_medium} · abstain ${metrics.abstain_rate} · High share ${metrics.high_band_share}`,
    `false merges ${metrics.false_merges} · duplicate recall ${metrics.duplicate_guard_recall} (guard alone ${metrics.duplicate_guard_alone_recall}) · ECE ${metrics.calibration.ece}`,
    ...metrics.calibration.table.filter((bin) => bin.n).map((bin) => `  p ${bin.from.toFixed(1)}-${bin.to.toFixed(1)}: n=${bin.n} mean p=${bin.mean_p} accuracy=${bin.accuracy}`),
  ];
  console.log(report.join('\n'));
});

test('every Medium result carries evidence sentences in the owner §7 form', () => {
  for (const row of rows.filter((entry) => entry.band === 'medium')) {
    assert.match(row.explanation, /^Candidate 1 — .+, \d{1,3}%: /, row.id);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/recognition_eval.mjs')));
});
