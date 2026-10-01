import test from 'node:test';
import assert from 'node:assert/strict';

// S100 security & cost hardening — the atlas-ai edge wiring added around the new
// DB controls. The SQL side (service-role-only RPCs, append-only trails, the
// recipe price/flag audit and the role matrix) is proven by
// scripts/verify_s100_security_cost.sh against a replayed database; these cover
// the Edge Function behaviour: how a `rate_limited:` RPC error is classified, the
// Retry-After header on the 429, and that a 429 records a block event out-of-band.

import { mapRpcError, errorResponse, ApiError } from '../../supabase/functions/atlas-ai/http.mjs';
import { startRun } from '../../supabase/functions/atlas-ai/chat.mjs';

test('S100 rate_limited messages are classified into vetted reasons', () => {
  const cases = [
    ['rate_limited: too many AI requests, slow down', 'slow_down'],
    ['rate_limited: daily AI budget reached', 'budget_daily'],
    ['rate_limited: monthly AI budget reached', 'budget_monthly'],
    ['rate_limited: daily Atlas AI limit reached', 'turn_limit'],
    ['rate_limited: something new', 'rate_limited'],
  ];
  for (const [message, reason] of cases) {
    const err = mapRpcError('atlas_ai_run_start', '53400', message);
    assert.equal(err.status, 429, message);
    assert.equal(err.code, 'rate_limited', message);
    assert.equal(err.extra.reason, reason, message);
  }
});

test('S100 a 429 carries a Retry-After header; the throttle is a soon-retry, caps are longer', async () => {
  const slow = errorResponse(mapRpcError('x', '53400', 'rate_limited: too many AI requests, slow down'));
  assert.equal(slow.status, 429);
  assert.equal(slow.headers.get('retry-after'), '30');
  const body = await slow.json();
  assert.equal(body.error_code, 'rate_limited');
  assert.equal(body.reason, 'slow_down');

  const budget = errorResponse(mapRpcError('x', '53400', 'rate_limited: daily AI budget reached'));
  assert.equal(budget.headers.get('retry-after'), '3600');

  // a non-rate-limited error never promises a retry window
  const forbidden = errorResponse(mapRpcError('x', '42501', 'forbidden: nope'));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('retry-after'), null);
});

test('S100 startRun records a block event out-of-band on a 429, then rethrows', async () => {
  const actor = { userId: '00000000-0000-4000-8000-0000000000c1', role: 'bartender' };
  const recorded = [];
  const services = {
    async rpc(name, payload) {
      if (name === 'atlas_ai_run_start') {
        throw mapRpcError(name, '53400', 'rate_limited: too many AI requests, slow down');
      }
      if (name === 'atlas_ai_record_block') { recorded.push(payload); return null; }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  await assert.rejects(
    () => startRun(services, actor, null, 'text', {}),
    (err) => err instanceof ApiError && err.status === 429 && err.code === 'rate_limited',
  );
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    [recorded[0].p_actor_id, recorded[0].p_actor_role, recorded[0].p_kind, recorded[0].p_channel],
    [actor.userId, actor.role, 'rate_limited', 'text'],
  );
  assert.equal(recorded[0].p_detail.reason, 'slow_down');
});

test('S100 startRun maps each budget/turn 429 to its block kind', async () => {
  const actor = { userId: '00000000-0000-4000-8000-0000000000c2', role: 'manager' };
  const expect = [
    ['rate_limited: daily AI budget reached', 'budget_daily'],
    ['rate_limited: monthly AI budget reached', 'budget_monthly'],
    ['rate_limited: daily Atlas AI limit reached', 'turn_limit'],
  ];
  for (const [message, kind] of expect) {
    const recorded = [];
    const services = {
      async rpc(name, payload) {
        if (name === 'atlas_ai_run_start') throw mapRpcError(name, '53400', message);
        if (name === 'atlas_ai_record_block') { recorded.push(payload); return null; }
        throw new Error(`unexpected rpc ${name}`);
      },
    };
    await assert.rejects(() => startRun(services, actor, null, 'text', {}));
    assert.equal(recorded[0].p_kind, kind, message);
  }
});

test('S100 a block-record failure never masks the original 429', async () => {
  const actor = { userId: '00000000-0000-4000-8000-0000000000c3', role: 'viewer' };
  const services = {
    async rpc(name) {
      if (name === 'atlas_ai_run_start') throw mapRpcError(name, '53400', 'rate_limited: too many AI requests, slow down');
      if (name === 'atlas_ai_record_block') throw new Error('block recorder down');
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  await assert.rejects(
    () => startRun(services, actor, null, 'text', {}),
    (err) => err.code === 'rate_limited',
  );
});

test('S100 a non-429 start failure does not record a block event', async () => {
  const actor = { userId: '00000000-0000-4000-8000-0000000000c4', role: 'bartender' };
  const recorded = [];
  const services = {
    async rpc(name, payload) {
      if (name === 'atlas_ai_run_start') throw mapRpcError(name, '55000', 'not_configured: Atlas AI is disabled');
      if (name === 'atlas_ai_record_block') { recorded.push(payload); return null; }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  await assert.rejects(() => startRun(services, actor, null, 'text', {}));
  assert.equal(recorded.length, 0);
});
