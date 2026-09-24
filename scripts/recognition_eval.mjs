#!/usr/bin/env node
// Visual inventory recognition evaluation (WP10, design §10).
//
//   node scripts/recognition_eval.mjs                 fixture set (same as CI), prints metrics
//   node scripts/recognition_eval.mjs --json          metrics as JSON
//   node scripts/recognition_eval.mjs --images <dir>  live image set: <dir>/manifest.json
//        [{ "file": "giffard-vanille.jpg", "mode": "identify", "client_barcodes": [],
//           "expect": { "item": "Giffard Vanille Syrup", "band": ["medium"], "must_not_match": [] } }]
//        Each photo is read by the real vision model (OPENAI_API_KEY; model
//        ATLAS_RECOGNITION_MODEL_VISION, else ATLAS_AI_MODEL_VISION, else the
//        Atlas AI default) and scored against the catalogue snapshot
//        (--catalog <file>, default tests/fixtures/visual-inventory/catalog.json).
//        Photos stay local; only the model provider sees them. Manual/nightly,
//        never part of PR CI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, loadCases, loadCatalog, localRpc, metricsFor, nameIndex } from '../tests/fixtures/visual-inventory/harness.mjs';
import { callVision } from '../supabase/functions/_shared/recognition/extract.mjs';
import { identify } from '../supabase/functions/_shared/recognition/pipeline.mjs';
import { DEFAULT_MODELS, estimateCostUsd } from '../supabase/functions/atlas-ai/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

function print(metrics, rows) {
  if (flag('--json')) {
    console.log(JSON.stringify({ metrics, rows }, null, 2));
    return;
  }
  console.log(`detections ${metrics.detections} (${metrics.with_expected_item} with an expected item)`);
  console.log(`false merges ${metrics.false_merges} · sibling at rank 1 ${metrics.sibling_at_top}`);
  console.log(`top-1 ${metrics.top1_accuracy} · top-3 ${metrics.top3_accuracy} · medium top-3 ${metrics.top3_accuracy_medium}`);
  console.log(`band accuracy ${metrics.band_accuracy} · abstain ${metrics.abstain_rate} · High share ${metrics.high_band_share}`);
  console.log(`duplicate recall ${metrics.duplicate_guard_recall} (guard alone ${metrics.duplicate_guard_alone_recall})`);
  console.log(`calibration ECE ${metrics.calibration.ece}`);
  for (const bin of metrics.calibration.table.filter((entry) => entry.n)) {
    console.log(`  p ${bin.from.toFixed(1)}-${bin.to.toFixed(1)}  n=${bin.n}  mean p=${bin.mean_p}  accuracy=${bin.accuracy}`);
  }
  for (const row of rows.filter((entry) => entry.false_merge || entry.top1 === false || !entry.band_ok)) {
    console.log(`  ! ${row.id}: expected ${row.expected ?? 'none'} (${row.band}), rank 1 ${row.top_name ?? 'none'} p=${row.p}`);
  }
}

async function liveImages(dir) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for the live image set.');
  const model = process.env.ATLAS_RECOGNITION_MODEL_VISION || process.env.ATLAS_AI_MODEL_VISION || DEFAULT_MODELS.vision;
  const catalog = loadCatalog(option('--catalog') ? path.resolve(option('--catalog')) : undefined);
  const byName = nameIndex(catalog);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const rows = [];
  const latencies = [];
  let cost = 0;
  for (const [index, entry] of manifest.entries()) {
    const bytes = fs.readFileSync(path.join(dir, entry.file));
    const mime = entry.file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const started = Date.now();
    const response = await identify({
      rpc: localRpc(catalog),
      actor: { userId: '00000000-0000-4000-8000-00000000e7a1', role: 'manager', label: 'Evaluation' },
      vision: async ({ imageDataUrl, mode }) => {
        const result = await callVision({ fetchImpl: fetch, apiKey, model, imageDataUrl, mode });
        cost += estimateCostUsd(result.model, result.tokens_in, result.tokens_out) ?? 0;
        return result;
      },
      record: false,
    }, {
      client_request_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      mode: entry.mode ?? 'identify',
      context: entry.context ?? {},
      client_barcodes: entry.client_barcodes ?? [],
      image: { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` },
    });
    latencies.push(Date.now() - started);
    const detection = response.detections[0] ?? { band: 'low', candidates: [] };
    const expectedId = entry.expect?.item ? byName.get(entry.expect.item)?.id ?? null : null;
    const top = detection.candidates[0];
    const mustNot = (entry.expect?.must_not_match ?? []).map((name) => byName.get(name)?.id).filter(Boolean);
    rows.push({
      id: entry.file, group: 'image', expected: entry.expect?.item ?? null, band: detection.band,
      band_ok: (entry.expect?.band ?? ['high', 'medium', 'low']).includes(detection.band),
      top1: expectedId ? top?.item_id === expectedId : null,
      top3: expectedId ? detection.candidates.slice(0, 3).some((candidate) => candidate.item_id === expectedId) : null,
      abstained: expectedId ? detection.band === 'low' : null,
      false_merge: (detection.band === 'high' && top?.item_id !== expectedId) || (Boolean(detection.preselected_item_id) && detection.preselected_item_id !== expectedId),
      sibling_at_top: Boolean(top) && mustNot.includes(top.item_id) && detection.band !== 'low',
      p: top?.score ?? 0, top_name: top?.item?.name ?? null, duplicate_recall: null, duplicate_guard_alone: null,
      field_confidence: detection.field_confidence,
    });
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
  const metrics = metricsFor(rows);
  metrics.latency_ms = { p50: pct(0.5), p95: pct(0.95) };
  metrics.estimated_cost_usd = Math.round(cost * 10000) / 10000;
  metrics.model = model;
  return { metrics, rows };
}

const imageDir = option('--images');
if (imageDir) {
  const { metrics, rows } = await liveImages(path.resolve(imageDir));
  print(metrics, rows);
  if (!flag('--json')) console.log(`latency p50 ${metrics.latency_ms.p50} ms · p95 ${metrics.latency_ms.p95} ms · estimated cost ${metrics.estimated_cost_usd} USD (${metrics.model})`);
} else {
  const { metrics, rows } = await evaluate(loadCases(), loadCatalog());
  print(metrics, rows);
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/visual-inventory/baseline.json'), 'utf8'));
  if (metrics.false_merges > baseline.gates.false_merges || metrics.duplicate_guard_recall < baseline.gates.duplicate_guard_recall) process.exitCode = 1;
}
