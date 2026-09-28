import test from 'node:test';
import assert from 'node:assert/strict';

// S96 aioauth N-controls: N7 image/decompression bombs (inventory
// recognition), N13 search/index leakage (Atlas AI, Reports), N19 AI error
// leakage, N20 denial-of-wallet (AI chat/voice/recognition). Each test sends
// the attack and asserts refusal before any paid provider call or leak.

import { USERS, createHandler, request } from './helpers/atlas-ai-harness.mjs';
import { json as jsonResponse, loadEdgeFunction } from './helpers/edge-function-harness.js';
import * as realGateway from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { mapRpcError, errorResponse } from '../../supabase/functions/atlas-ai/http.mjs';
import { toolOutputForModel } from '../../supabase/functions/atlas-ai/turn.mjs';
import { createRecognitionHandler } from '../../supabase/functions/atlas-inventory-recognition/handler.mjs';

const DUMMY_SDK = { Agent: class {} };
const LEAK = /atlas_private|relation|column|constraint|does not exist|violates|sqlstate|42P01|service-role-test/i;

// ------------------------------------------------------------------ N7

function recognition({ openaiKey = '' } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin === 'https://api.openai.com') { calls.push({ kind: 'openai' }); return new Response('{}', { status: 500 }); }
    if (url.pathname.startsWith('/storage/v1/object/')) { calls.push({ kind: 'storage', bytes: init.body?.byteLength ?? init.body?.length ?? null }); return new Response('{}'); }
    const name = url.pathname.replace('/rest/v1/rpc/', '');
    calls.push({ kind: 'rpc', name });
    if (name === 'atlas_recognition_request_get') return new Response('null');
    if (name === 'atlas_recognition_limits') return new Response(JSON.stringify({ vision_enabled: true }));
    if (name === 'atlas_recognition_register_media') return new Response(JSON.stringify({ media_id: '00000000-0000-4000-8000-00000000d001', expires_at: null }));
    if (name === 'atlas_recognition_record') return new Response(JSON.stringify({ request_id: '00000000-0000-4000-8000-00000000e001', detections: [] }));
    return new Response('{}');
  };
  const handle = createRecognitionHandler({
    env: (name) => ({ SUPABASE_URL: 'https://branch.example.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test', OPENAI_API_KEY: openaiKey })[name],
    fetchImpl, now: () => 1_790_000_000_000, newId: () => '00000000-0000-4000-8000-00000000f123',
    resolveActor: async () => ({ userId: USERS.bartender.id, role: 'bartender', active: true, label: 'Bar' }),
  });
  return { handle, calls };
}
const photo = (bytes, type) => {
  const form = new FormData();
  form.set('payload', JSON.stringify({ client_request_id: '00000000-0000-4000-8000-000000000a11' }));
  form.set('image', new Blob([bytes], { type }), 'p');
  return new Request('https://fn.example.test/atlas-inventory-recognition?action=identify', { method: 'POST', headers: { authorization: 'Bearer t' }, body: form });
};
// A 45-byte PNG whose IHDR claims 65535 x 65535 pixels (a 17 GB RGBA bitmap if decoded).
const PNG_BOMB = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0xff, 0xff, 0, 0, 0xff, 0xff, 8, 6, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

test('N7 recognition never decodes images server-side: a pixel-bomb PNG is stored as its 45 bytes and not expanded', async () => {
  const { handle, calls } = recognition();
  const started = Date.now();
  const response = await handle(photo(PNG_BOMB, 'image/png'));
  assert.ok(response.status < 300, `status ${response.status}`);
  assert.ok(Date.now() - started < 2000, 'no decode work');
  const upload = calls.find((call) => call.kind === 'storage');
  assert.equal(upload.bytes, PNG_BOMB.byteLength, 'bytes are passed through unchanged');
});

test('N7 archives and other containers disguised as photos are refused before storage; oversized bodies are cut off', async () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0]);
  const gzip = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0]);
  const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (const [bytes, type] of [[zip, 'image/jpeg'], [gzip, 'image/png'], [tiff, 'image/tiff'], [zip, 'application/zip']]) {
    const { handle, calls } = recognition();
    assert.equal((await handle(photo(bytes, type))).status, 415, type);
    assert.ok(!calls.some((call) => call.kind === 'storage'));
  }
  const { handle, calls } = recognition();
  const big = new Uint8Array(13 * 1024 * 1024);
  big.set([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal((await handle(photo(big, 'image/jpeg'))).status, 413);
  assert.ok(!calls.some((call) => call.kind === 'storage' || call.kind === 'openai'));
});

// ------------------------------------------------------------------ N13

test('N13 conversation search is always scoped to the verified caller, whatever the query string says', async () => {
  const { handle, db } = createHandler({ sdk: DUMMY_SDK });
  const response = await handle(request('conversations', { user: USERS.bartender, method: 'GET', query: `&q=payroll&user_id=${USERS.manager.id}&p_actor_id=${USERS.manager.id}&p_actor_role=admin` }));
  assert.equal(response.status, 200);
  const call = db.calls.filter((entry) => entry.name === 'atlas_ai_conversations_list').at(-1);
  assert.equal(call.payload.p_actor_id, USERS.bartender.id);
  assert.equal(call.payload.p_actor_role, 'bartender');
});

test('N13 staff cannot search decision memory, manager data-review or integrations through Atlas AI tools', async () => {
  const ctx = { actor: { userId: USERS.bartender.id, role: 'bartender', active: true, token: 't' }, env: {}, fetch: async () => { throw new Error('no backend call expected'); }, now: () => new Date() };
  for (const [name, args] of [['decisions.history', { query: 'payroll', subject_type: null, subject_key: null, limit: null }], ['data_quality.review_list', null], ['integrations.status', {}], ['reports.spend', null], ['recipes.cost', null]]) {
    const tool = realGateway.getTool(name);
    const full = args ?? Object.fromEntries(Object.keys(tool.parameters.properties).map((key) => [key, null]));
    const result = await realGateway.runTool(name, full, { ...ctx });
    assert.equal(result.ok, false, name);
    assert.equal(result.error.code, 'forbidden', name);
  }
});

test('N13 Reports ask/snapshot for a bartender never reveals costs, supplier names or receipts', async () => {
  const ENV = { ATLAS_AUTH_PROJECT_URL: 'https://auth.test', ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_URL: 'https://branch.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' };
  const item = { id: '00000000-0000-4000-8000-000000000001', name: 'Gin', category: 'Spirits', quantity: 4, unit: 'bottles', par_level: 6, supplier: 'SecretSupplierHf', supplier_id: '00000000-0000-4000-8000-000000000009', cost_price: 7777, active: true, updated_at: new Date().toISOString() };
  const fetchImpl = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === '/auth/v1/user') return jsonResponse({ id: 'b1', email: 'b@example.test' });
    if (url.pathname === '/rest/v1/profiles') return jsonResponse([{ id: 'b1', display_name: 'Bar', role: 'bartender', active: true }]);
    if (url.pathname === '/rest/v1/inventory_items') return jsonResponse([item]);
    if (url.pathname === '/rest/v1/suppliers') return jsonResponse([{ id: item.supplier_id, name: 'SecretSupplierHf', active: true }]);
    if (url.pathname === '/rest/v1/inventory_movements') return jsonResponse([{ id: 'm1', item_id: item.id, item_name: 'Gin', movement_type: 'restock', quantity_change: 6, unit_cost: 7777, total_cost: 46662, supplier_id: item.supplier_id, created_at: new Date().toISOString() }]);
    return jsonResponse([]);
  };
  const handler = await loadEdgeFunction('supabase/functions/atlas-reports/index.ts', ENV);
  for (const question of ['What is our stock value?', 'Which supplier costs the most?', 'What did we spend last month?', 'cost of gin', 'SecretSupplierHf']) {
    const response = await handler(new Request('https://fn.test/atlas-reports?action=ask', { method: 'POST', headers: { authorization: 'Bearer b', 'content-type': 'application/json' }, body: JSON.stringify({ question }) }), fetchImpl);
    const text = await response.text();
    assert.equal(response.status, 200, text.slice(0, 200));
    assert.doesNotMatch(text, /7777|7\.777|46662|46\.662|SecretSupplierHf/, question);
  }
});

// ------------------------------------------------------------------ N19

test('N19 database text never reaches the browser or the model from Atlas AI', async () => {
  const raw = 'relation "atlas_private.ai_actions" does not exist (SQLSTATE 42P01)';
  for (const code of ['42P01', '42703', '23505', 'XX000', '']) {
    const error = mapRpcError('atlas_ai_action_transition', code, raw);
    assert.doesNotMatch(error.message, LEAK, code);
  }
  const unexpected = await errorResponse(new Error(raw)).json();
  assert.equal(unexpected.error_code, 'internal');
  assert.doesNotMatch(JSON.stringify(unexpected), LEAK);
  // A tool whose backend answers with schema text: the model sees fixed wording.
  const ctx = {
    actor: { userId: USERS.manager.id, role: 'manager', active: true, token: 't' },
    env: { get: (name) => ({ SUPABASE_URL: 'https://branch.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test', ATLAS_AUTH_PROJECT_URL: 'https://branch.test', ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_x' })[name] },
    fetch: async () => new Response(JSON.stringify({ code: '42P01', message: raw, hint: 'service-role-test' }), { status: 400 }),
    now: () => new Date(),
  };
  const result = await realGateway.runTool('data_quality.review_list', { issue: null, limit: null, offset: null }, ctx);
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), LEAK);
  assert.doesNotMatch(toolOutputForModel(result, null, 12000), LEAK);
});

test('N19 provider failures on voice/speech return fixed text, never the provider body', async () => {
  const secretBody = JSON.stringify({ error: { message: 'Incorrect API key provided: sk-test-openai-key-never-returned-000000', type: 'invalid_request_error' } });
  const { handle } = createHandler({ sdk: DUMMY_SDK, fetchOptions: { openai: { clientSecret: () => new Response(secretBody, { status: 401 }) } } });
  const response = await handle(request('voice-session', { user: USERS.bartender, body: {} }));
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.doesNotMatch(text, /sk-test|Incorrect API key|invalid_request_error/);
});

// ------------------------------------------------------------------ N20

test('N20 every paid Atlas AI route stops at the daily per-user limit before calling OpenAI', async () => {
  const { handle, db, fetch } = createHandler({ sdk: DUMMY_SDK });
  db.settings.daily_turn_limit_per_user = 0;
  const conversation = { id: null };
  const audio = new FormData();
  audio.set('file', new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])], { type: 'audio/webm' }), 'a.webm');
  const attempts = [
    ['chat', { body: { message: 'hello', client_request_id: 'req-n20-00000001' } }],
    ['speak', { body: { text: 'hello' } }],
    ['transcribe', { body: audio }],
    ['voice-session', { body: {} }],
  ];
  for (const [action, options] of attempts) {
    const response = await handle(request(action, { user: USERS.bartender, ...options }));
    assert.equal(response.status, 429, action);
  }
  assert.ok(conversation);
  assert.ok(!fetch.requests.some((entry) => entry.url.startsWith('https://api.openai.com')), 'no provider call');
});

test('N20 switching Atlas AI off stops every paid route (not_configured) before any provider call', async () => {
  const { handle, db, fetch } = createHandler({ sdk: DUMMY_SDK });
  db.settings.enabled = false;
  for (const action of ['chat', 'speak', 'voice-session']) {
    const body = action === 'chat' ? { message: 'x', client_request_id: 'req-n20-00000002' } : action === 'speak' ? { text: 'x' } : {};
    const response = await handle(request(action, { user: USERS.manager, body }));
    assert.equal(response.status, 503, action);
  }
  assert.ok(!fetch.requests.some((entry) => entry.url.startsWith('https://api.openai.com')));
});

test('N20 recognition vision stops at the database limit (hourly, daily count, org-wide USD budget) before any vision call', async () => {
  for (const reason of ['recognition_hourly', 'recognition_vision_daily', 'recognition_budget']) {
    const calls = [];
    const handle = createRecognitionHandler({
      env: (name) => ({ SUPABASE_URL: 'https://branch.example.test', SUPABASE_SERVICE_ROLE_KEY: 'k', OPENAI_API_KEY: 'sk-test' })[name],
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        calls.push(url.origin + url.pathname);
        if (url.pathname.endsWith('/atlas_recognition_request_get')) return new Response('null');
        if (url.pathname.endsWith('/atlas_recognition_limits')) return new Response(JSON.stringify({ code: '53400', message: `rate_limited: ${reason}` }), { status: 400 });
        return new Response('{}');
      },
      now: () => 1_790_000_000_000, newId: () => '00000000-0000-4000-8000-00000000f124',
      resolveActor: async () => ({ userId: USERS.bartender.id, role: 'bartender', active: true, label: 'Bar' }),
    });
    const response = await handle(photo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 3, 4, 5]), 'image/jpeg'));
    assert.equal(response.status, 429, reason);
    assert.ok(!calls.some((url) => url.startsWith('https://api.openai.com') || url.includes('/storage/')), reason);
  }
});
