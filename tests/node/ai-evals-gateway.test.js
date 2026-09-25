import test from 'node:test';
import assert from 'node:assert/strict';

// Atlas AI evaluation, Layer 1: deterministic gateway evals
// (docs/ai/Atlas_AI_Evaluation_Plan.md). Every case in tests/ai-evals/cases
// runs the REAL Tool Gateway against the VÁ fixture world (injected fetch
// emulating PostgREST + RLS, service RPCs and Atlas Edge Functions) and
// checks the result, the evidence, the records, unknown disclosure, role
// redaction and the approval boundary. No network, no model.

import { runTool, executeProposal, TOOL_REGISTRY } from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { createWorld, gatewayCtx, ACTORS, tokenFor } from '../ai-evals/fixtures/world.mjs';
import {
  GATEWAY_CATEGORIES, loadGatewayCases, validateGatewayCase, resolveAliases, checkGatewayResult, getPath, matches,
} from '../ai-evals/lib/cases.mjs';

const CASES = loadGatewayCases();
const TOOL_NAMES = TOOL_REGISTRY.map((entry) => entry.name);
const MANAGER_TABLES = new Set(['inventory_items', 'inventory_movements', 'recipes', 'suppliers', 'purchase_orders']);
const STAFF = new Set(['bartender', 'viewer']);

// Minimum cases per category (the plan's taxonomy).
const MINIMUM_PER_CATEGORY = {
  inventory: 10, recipes: 8, purchasing: 10, reports: 6, operations: 5, shifts: 6, knowledge: 6, team: 4, settings: 4,
  ambiguous: 6, missing_evidence: 6, role_restriction: 10, multimodal: 5, voice_transcript: 5, approval_boundary: 8, prompt_injection: 5,
};

function setPath(object, dotted, value) {
  const parts = String(dotted).replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = object;
  for (const part of parts.slice(0, -1)) current = current[part];
  current[parts.at(-1)] = value;
}

// Unknown is never zero: any stock row that is not current has no quantity.
function unknownIsNeverZero(value, trail = 'result') {
  if (Array.isArray(value)) return value.flatMap((entry, index) => unknownIsNeverZero(entry, `${trail}[${index}]`));
  if (!value || typeof value !== 'object') return [];
  const problems = [];
  if (typeof value.quantity_status === 'string' && value.quantity_status !== 'current' && value.quantity !== null && value.quantity !== undefined) {
    problems.push(`${trail}: ${value.name} has quantity ${value.quantity} with status ${value.quantity_status}`);
  }
  for (const [key, entry] of Object.entries(value)) problems.push(...unknownIsNeverZero(entry, `${trail}.${key}`));
  return problems;
}

test('Layer 1 case files are valid and cover the taxonomy (≥120 cases)', () => {
  const errors = CASES.flatMap((entry) => validateGatewayCase(entry, TOOL_NAMES));
  assert.deepEqual(errors, []);
  const ids = CASES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'case ids are unique');
  assert.ok(CASES.length >= 120, `${CASES.length} cases`);
  const counts = Object.fromEntries(GATEWAY_CATEGORIES.map((category) => [category, CASES.filter((entry) => entry.category === category).length]));
  for (const [category, minimum] of Object.entries(MINIMUM_PER_CATEGORY)) {
    assert.ok(counts[category] >= minimum, `${category}: ${counts[category]} cases, need ${minimum}`);
  }
  for (const role of ['admin', 'manager', 'bartender', 'viewer', 'deactivated']) {
    assert.ok(CASES.some((entry) => entry.actor === role), `a case runs as ${role}`);
  }
  // Every registry tool is exercised at least once.
  const used = new Set(CASES.map((entry) => entry.tool));
  assert.deepEqual(TOOL_NAMES.filter((name) => !used.has(name)), []);
});

test('the Layer 1 checker itself fails on wrong numbers, missing evidence and staff leaks', async () => {
  const world = createWorld();
  const { ctx } = gatewayCtx('manager', world);
  const result = await runTool('purchasing.suggest', { supplier_id: null, include_ordered: null }, ctx);
  const base = { id: 'self-test', expected: { ok: true } };
  assert.deepEqual(checkGatewayResult({ ...base, expected: { ok: true, data: { 'data.estimated_total': 170760 } } }, result, { isStaff: false }), []);
  assert.equal(checkGatewayResult({ ...base, expected: { ok: true, data: { 'data.estimated_total': 170761 } } }, result, { isStaff: false }).length, 1);
  assert.equal(checkGatewayResult({ ...base, expected: { ok: true, evidence: [{ kind: 'fact', label: 'Order Angelo' }] } }, result, { isStaff: false }).length, 1, 'wrong evidence kind');
  assert.equal(checkGatewayResult({ ...base, expected: { ok: true, unknown: null } }, result, { isStaff: false }).length, 1, 'unknown disclosure required');
  assert.ok(checkGatewayResult(base, result, { isStaff: true }).some((failure) => /leaked/.test(failure)), 'manager data would leak to staff');
  assert.equal(checkGatewayResult({ ...base, expected: { ok: false, error: 'forbidden' } }, result, { isStaff: false }).length, 1);
});

for (const entry of CASES) {
  test(`[${entry.category}] ${entry.id}: ${entry.question}`, async () => {
    const world = createWorld({ hours: entry.world === 'hours', catalog: entry.world === 'catalog' });
    const { ctx, audits } = gatewayCtx(entry.actor, world);
    const args = resolveAliases(entry.args);
    const result = await runTool(entry.tool, args, ctx);
    const isStaff = STAFF.has(ACTORS[entry.actor].role);

    const failures = checkGatewayResult(entry, result, { isStaff });
    assert.deepEqual(failures, [], `${entry.id} (${entry.__file})`);

    // Draft and read never change anything.
    assert.deepEqual(world.writes, [], 'no write before approval');
    // One audit record per call, with the server-side actor.
    assert.equal(audits.length, 1, 'exactly one audit record');
    assert.equal(audits[0].actor_role, ACTORS[entry.actor].role);
    assert.equal(audits[0].actor_id, ACTORS[entry.actor].id);
    // The data backend saw only the verified actor.
    if (isStaff) {
      assert.ok(!world.calls.some((call) => call.kind === 'rest' && MANAGER_TABLES.has(call.name)), 'staff never read manager tables');
      assert.ok(!world.calls.some((call) => call.kind === 'userRpc'), 'staff never call manager RPCs');
    }
    for (const call of world.calls.filter((item) => item.kind === 'serviceRpc' && item.role)) {
      assert.equal(call.role, ACTORS[entry.actor].role, `${call.name} carries the verified role`);
    }
    for (const call of world.calls.filter((item) => item.token)) {
      assert.equal(call.token, tokenFor(ACTORS[entry.actor]), `${call.name} uses the caller's own JWT`);
    }
    assert.ok(!world.calls.some((call) => call.kind === 'unexpected'), JSON.stringify(world.calls.filter((call) => call.kind === 'unexpected')));
    if (result.ok) {
      assert.deepEqual(unknownIsNeverZero(result.data), []);
      for (const record of result.records) assert.match(String(record.route ?? '#'), /^#/);
    }

    if (entry.execute) {
      const execute = resolveAliases(entry.execute);
      const command = structuredClone(result.proposal.command);
      for (const [dotted, value] of Object.entries(execute.tamper ?? {})) setPath(command, dotted, value);
      if (execute.add_field) Object.assign(command, execute.add_field);
      const { ctx: approverCtx } = gatewayCtx(execute.as, world);
      const outcome = await executeProposal(execute.kind ?? result.proposal.kind, command, approverCtx);
      assert.equal(outcome.ok, execute.expected.ok, JSON.stringify(outcome));
      if (!outcome.ok) {
        assert.equal(outcome.error.code, execute.expected.error);
        assert.deepEqual(world.writes, [], 'a refused execution writes nothing');
      } else {
        assert.deepEqual(world.writes.map((write) => write.name), execute.expected.writes);
        const approver = ACTORS[execute.as];
        for (const write of world.writes) assert.equal(write.token, tokenFor(approver), 'the command runs with the approver JWT');
        for (const text of execute.expected.summary ?? []) assert.match(outcome.result.summary, new RegExp(text, 'i'));
        for (const [dotted, matcher] of Object.entries(execute.expected.write_args ?? {})) {
          assert.ok(matches(getPath(world.writes, dotted), matcher), `${dotted}: ${JSON.stringify(getPath(world.writes, dotted))}`);
        }
      }
      if (execute.after) {
        const { ctx: afterCtx } = gatewayCtx(execute.after.actor ?? execute.as, world);
        const after = await runTool(execute.after.tool, resolveAliases(execute.after.args), afterCtx);
        assert.equal(after.ok, true, JSON.stringify(after));
        for (const [dotted, matcher] of Object.entries(execute.after.data ?? {})) {
          assert.ok(matches(getPath(after, dotted), matcher), `after ${dotted}: ${JSON.stringify(getPath(after, dotted))}`);
        }
      }
    }
  });
}
