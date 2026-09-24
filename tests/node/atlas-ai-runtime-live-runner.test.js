import test from 'node:test';
import assert from 'node:assert/strict';

// Self-test of the Layer 2 live runner (scripts/ai-eval-live.mjs) without a
// key: the runner drives the real runtime + real gateway + VÁ world with a
// scripted model in place of the OpenAI provider, so the run → score →
// report path is exercised end to end. A well-behaved scripted model passes
// the selected cases; a model that invents numbers fails a blocking case.
// Runs under Deno (`npm run test:ai`).

import { SDK, SKIP_SDK } from './helpers/atlas-ai-sdk.mjs';
import { createProvider, message, toolCall, hasToolOutput } from './helpers/atlas-ai-harness.mjs';
import { runLive, summarise, markdownReport } from '../../scripts/ai-eval-live.mjs';
import { loadLiveCases } from '../ai-evals/lib/cases.mjs';
import { IDS } from '../ai-evals/fixtures/world.mjs';
import { lastUserText } from '../ai-evals/fixtures/runtime.mjs';

const opts = { skip: SKIP_SDK };
const CASES = loadLiveCases();
const pick = (...ids) => ids.map((id) => CASES.find((entry) => entry.id === id));

function lastToolOutput(req) {
  const last = (req.input ?? []).filter((item) => item.type === 'function_call_result').at(-1);
  const raw = typeof last?.output === 'string' ? last.output : last?.output?.text ?? '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

// A model that uses the right tool and states the tool summary.
const ROUTES = [
  [/30 Margaritas/i, 'recipes_can_make', { recipe_id: null, recipe_query: 'Margarita', servings: 30 }],
  [/Draft the Vínnes order/i, 'purchasing_prepare_draft_po', { supplier_id: null, supplier_query: 'Vínnes', use_suggestions: true, lines: null, note: null, expected_delivery_date: null }],
  [/revenue is down/i, 'reports_sales', { period: 'week' }],
  [/What do we need from Vínnes/i, 'purchasing_suggest', { supplier_id: IDS.supplier.vinnes, include_ordered: null }],
  [/^Prepare that/i, 'purchasing_prepare_draft_po', { supplier_id: IDS.supplier.vinnes, supplier_query: null, use_suggestions: true, lines: null, note: null, expected_delivery_date: null }],
];

function goodModel(req) {
  if (hasToolOutput(req)) {
    const output = lastToolOutput(req);
    if (!output.ok) return message("Sales data isn't connected to Atlas, so I can't see or explain revenue. ");
    const approval = output.proposal?.status === 'awaiting_approval' ? ' Tap Approve on the card if it looks right.' : '';
    const details = (output.data?.discrepancies ?? []).map((entry) => `${entry.item}: ${entry.issue}${entry.price ? `, ${entry.price}` : ''}.`).join(' ');
    return message(`${output.summary}${details ? ` ${details}` : ''}${approval} `);
  }
  const user = (req.input ?? []).filter((item) => item.role === 'user').at(-1);
  if (Array.isArray(user?.content) && user.content.some((part) => part.type === 'input_image')) {
    return toolCall('purchasing_compare_delivery', {
      purchase_order_id: IDS.po.globusOrdered,
      observed: [{ item_id: null, name: 'Aperol', quantity: 12, unit_cost: 3700 }, { item_id: null, name: 'Cointreau', quantity: 5, unit_cost: null }, { item_id: null, name: 'Campari', quantity: 6, unit_cost: null }],
      note: null,
    });
  }
  const text = lastUserText(req);
  for (const [pattern, name, args] of ROUTES) if (pattern.test(text)) return toolCall(name, args);
  return message('Could you tell me more? ');
}

test('live runner end to end with a scripted model: good answers pass, the report is written', opts, async () => {
  const cases = pick('owner-02', 'live-pur-02', 'owner-14', 'live-fu-03', 'live-mm-01', 'live-role-09');
  const bundle = createProvider(SDK.sdk, goodModel);
  const results = await runLive({ cases, sdk: SDK.sdk, z: SDK.z, provider: bundle.provider, log: () => {} });
  for (const result of results) assert.deepEqual(result.verdict.failed_metrics, [], `${result.id}: ${JSON.stringify(result.metrics)} — ${result.answer}`);
  const image = results.find((result) => result.id === 'live-mm-01');
  assert.deepEqual(image.proposals.map((proposal) => proposal.kind), ['purchase_order.receive']);
  assert.ok(image.tools.includes('purchasing.compare_delivery'));
  const summary = summarise(results);
  assert.equal(summary.release_gate, 'pass');
  assert.equal(summary.by_metric.hallucination.rate, 1);
  const report = markdownReport({ meta: { started: 's', finished: 'f', models: { orchestrator: 'o', specialist: 's', vision: 'v' }, grader: null, tokens: { in: 1, out: 1 }, cost_usd_estimate: 0 }, summary, results });
  assert.match(report, /Release gate: PASS/);
});

test('live runner: a model that answers from memory fails a blocking case and blocks release', opts, async () => {
  const cases = pick('owner-02', 'owner-14');
  const bundle = createProvider(SDK.sdk, (req) => {
    const text = lastUserText(req);
    if (/Margaritas/.test(text)) return message('Yes, we can make 30 Margaritas — we have 3 bottles of tequila. ');
    return message('Revenue is down 12% this week because of lower footfall. ');
  });
  const results = await runLive({ cases, sdk: SDK.sdk, z: SDK.z, provider: bundle.provider, log: () => {} });
  const summary = summarise(results);
  assert.equal(summary.release_gate, 'blocked');
  assert.deepEqual(summary.blocking_failures.sort(), ['owner-02', 'owner-14']);
  const margaritas = results.find((result) => result.id === 'owner-02');
  assert.ok(margaritas.verdict.failed_metrics.includes('tools'));
  assert.ok(margaritas.verdict.failed_metrics.includes('calculation'));
  // The runtime's grounding check already replaced the unverified figures.
  assert.equal(margaritas.grounding, 'replaced_unverified');
});
