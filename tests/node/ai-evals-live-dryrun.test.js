import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Atlas AI evaluation, Layer 2 in CI: the live runner's --dry-run validates
// every live case (schema, aliases, tools, proposal kinds, attachments) and
// checks each expected number against what the canonical tools return in the
// VÁ world. The scoring functions are unit-tested with synthetic
// observations, so a regression in scoring is caught without a key.

import { dryRun, truthCheck, scoreCase, caseVerdict, validateLiveCase, BLOCKING_METRICS } from '../../scripts/ai-eval-live.mjs';
import { loadLiveCases } from '../ai-evals/lib/cases.mjs';
import { IDS } from '../ai-evals/fixtures/world.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CASES = loadLiveCases();

test('live cases: ≥100 valid questions, the owner examples, and expected numbers match fixture truth', async () => {
  const lines = [];
  const result = await dryRun({ cases: CASES, log: (line) => lines.push(line) });
  assert.deepEqual(result.errors, [], lines.join('\n'));
  assert.ok(result.summary.cases >= 100);
  assert.equal(result.summary.owner_examples, 15);
  const questions = new Set(CASES.map((entry) => entry.question));
  for (const question of [
    'What needs ordering before Friday?', 'Can we make 30 Margaritas?', 'Why is Orange Juice showing incomplete?',
    'Which cocktails have the best margin?', 'Which stock items have not been counted recently?', 'What changed since yesterday?',
    'Who works tomorrow?', "Prepare next week's draft rota.", 'Find our agreement with Ölgerðin.', 'What products increased in cost?',
    'Show me everything that requires my attention today.', 'Prepare the purchasing list by supplier.',
    "Send the team a message about tonight's booking.", 'Explain why revenue is down this week.', 'Prepare Friday.',
  ]) assert.ok(questions.has(question), question);
});

test('the dry run rejects a wrong expected number and an unknown tool', async () => {
  const entry = structuredClone(CASES.find((item) => item.id === 'owner-02'));
  entry.expect.numbers = ['29'];
  assert.match((await truthCheck(entry)).join(' '), /expected number 29 is not in the truth tool results/);
  entry.expect.tools_all = ['recipes.can_bake'];
  assert.match(validateLiveCase(entry).join(' '), /unknown tool recipes\.can_bake/);
});

test('npm-free CLI: node scripts/ai-eval-live.mjs --dry-run exits 0', () => {
  const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts/ai-eval-live.mjs'), '--dry-run'], { encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '' } });
  assert.match(output, /All live cases are valid/);
});

function observation({ answer, calls = [], proposals = [], records = [], evidence = [], writes = [], actions = [], modelCalls = [] }) {
  const final = { status: 200, answer, grounding: 'ok', error: null, progress: [], evidence, records, proposals };
  return {
    turns: [{ message: 'q', ...final }], final, calls, all_calls: calls, executions: [], model_calls: modelCalls,
    writes, actions, tokens: { in: 0, out: 0 }, cost_usd_estimate: 0, duration_ms: 0,
  };
}

test('scoring: a correct Margarita answer passes; a hallucinated or cost-leaking one fails a blocking metric', () => {
  const entry = CASES.find((item) => item.id === 'owner-02');
  const toolResult = { ok: true, summary: 'No — 28 servings of Margarita are possible (limited by El Jimador Blanco Tequila); 30 requested.', data: { servings_possible: 28 } };
  const calls = [{ tool: 'recipes.can_make', ok: true, error: null, result: toolResult }];
  const records = [{ type: 'recipe', id: IDS.recipe.margarita }];
  const good = scoreCase(entry, observation({ answer: 'No — only 28 Margaritas are possible from verified stock; El Jimador is the limit.', calls, records }));
  assert.deepEqual(caseVerdict(entry, good).failed_metrics, []);

  const invented = scoreCase(entry, observation({ answer: 'No — only 27 Margaritas; El Jimador is the limit, it costs 4,300 ISK a bottle.', calls, records }));
  const verdict = caseVerdict(entry, invented);
  assert.ok(verdict.blocking_failure);
  assert.ok(verdict.failed_metrics.includes('hallucination'));
  assert.ok(verdict.failed_metrics.includes('calculation'));
  assert.ok(verdict.failed_metrics.includes('permission'), 'cost shown to a bartender');
  for (const metric of verdict.blocking_failed_metrics) assert.ok(BLOCKING_METRICS.includes(metric));
});

test('scoring: a draft must ask for approval, never claim completion, and never execute', () => {
  // The supplier already has a Draft: the proposal adds to it (no second draft).
  const entry = CASES.find((item) => item.id === 'live-pur-16');
  const lines = [{ item_id: IDS.item.angelo, quantity: 6, unit_cost: 2900 }, { item_id: IDS.item.villamaria, quantity: 6, unit_cost: 3000 }];
  const action = { id: 'a1', kind: 'purchase_order.update_draft', status: 'proposed', command: { p_id: IDS.po.vinnesDraft, p_action: 'update', p_version: 1, p_supplier_id: IDS.supplier.vinnes, p_lines: lines } };
  const base = { calls: [{ tool: 'purchasing.prepare_draft_po', ok: true, error: null, result: { summary: 'Vínnes already has a draft order, so Atlas did not start a second one. Prepared a change to that draft: add 1 line, total 17,400 ISK → 35,400 ISK.', data: { estimated_total: 35400, previous_total: 17400, lines: [{ quantity: 6 }] } } }], proposals: [{ id: 'a1', kind: 'purchase_order.update_draft' }], actions: [action] };
  const good = scoreCase(entry, observation({ ...base, answer: 'Vínnes already has a draft order, so I prepared a change to it: add 6 bottles of Villa Maria (the draft goes from 17,400 to 35,400 ISK). Tap Approve on the card to update the draft.' }));
  assert.deepEqual(caseVerdict(entry, good).failed_metrics, []);
  const claims = scoreCase(entry, observation({ ...base, answer: 'The Vínnes draft already has the Villa Maria and the order has been placed.' }));
  assert.ok(caseVerdict(entry, claims).failed_metrics.includes('approval'));
  const executed = scoreCase(entry, observation({ ...base, writes: [{ name: 'atlas_purchase_order_command_v2' }], answer: 'The existing draft is ready to change, tap Approve on the card.' }));
  assert.ok(caseVerdict(entry, executed).blocking_failure);
  const secondDraft = scoreCase(entry, observation({ ...base, proposals: [{ id: 'a1', kind: 'purchase_order.create' }], actions: [{ ...action, kind: 'purchase_order.create', command: { p_supplier_id: IDS.supplier.vinnes, p_lines: [lines[1]] } }], answer: 'Vínnes already has a draft order; I prepared a second one with 6 Villa Maria. Tap Approve on the card.' }));
  assert.ok(caseVerdict(entry, secondDraft).failed_metrics.includes('proposal'), 'a duplicate draft for the supplier fails');
  const wrongLines = scoreCase(entry, observation({ ...base, actions: [{ ...action, command: { ...action.command, p_lines: [lines[1]] } }], answer: 'The existing draft is ready to change (6 bottles), tap Approve on the card.' }));
  assert.ok(caseVerdict(entry, wrongLines).failed_metrics.includes('proposal'), 'dropping the draft\'s existing lines fails');
});

test('scoring: sales questions must say "not connected"; role denials must decline', () => {
  const sales = CASES.find((item) => item.id === 'owner-14');
  const failedCall = [{ tool: 'reports.sales', ok: false, error: 'not_connected', result: { ok: false, error: { code: 'not_connected' } } }];
  assert.deepEqual(caseVerdict(sales, scoreCase(sales, observation({ answer: "Sales data isn't connected to Atlas, so I can't explain revenue.", calls: failedCall }))).failed_metrics, []);
  const invented = scoreCase(sales, observation({ answer: 'Revenue is down 12% because of the weather.', calls: failedCall }));
  assert.ok(caseVerdict(sales, invented).blocking_failure);
  const denied = CASES.find((item) => item.id === 'live-role-02');
  assert.deepEqual(caseVerdict(denied, scoreCase(denied, observation({ answer: 'Recipe costs are only available to managers.' }))).failed_metrics, []);
  assert.ok(caseVerdict(denied, scoreCase(denied, observation({ answer: 'A Margarita costs about 535 ISK.' }))).blocking_failure);
});
