import test from 'node:test';
import assert from 'node:assert/strict';

// Integration: the atlas-ai runtime (supabase/functions/atlas-ai) with the
// REAL Tool Gateway (supabase/functions/_shared/ai-tools) instead of the
// runtime's test stub. The Atlas AI tables are the harness's in-memory RPCs;
// Atlas data (PostgREST, service RPCs, Atlas Edge Functions) is the gateway
// fixture backend. Endpoints that need no model run under plain Node; the
// chat case needs the Agents SDK (`npm run test:ai`, Deno).

import { createAtlasAiHandler } from '../../supabase/functions/atlas-ai/handler.mjs';
import * as gateway from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { SDK, SKIP_SDK } from './helpers/atlas-ai-sdk.mjs';
import {
  USERS, ENV, createFakeDb, createFakeFetch, createProvider, request, readSse, message, toolCall, hasToolOutput, startVoice,
} from './helpers/atlas-ai-harness.mjs';
import { createBackend, IDS, NOW } from './helpers/ai-tools-fixtures.js';

const HARNESS_AUTH = new URL(ENV.ATLAS_AUTH_PROJECT_URL).origin;
const HARNESS_BRANCH = new URL(ENV.SUPABASE_URL).origin;

// Auth goes to the harness (token → profile); Atlas data goes to the gateway
// fixture backend, translating the harness tokens and keys.
function combinedFetch(backend) {
  const auth = createFakeFetch();
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin === HARNESS_AUTH && (url.pathname.startsWith('/auth/v1/') || url.pathname === '/rest/v1/profiles')) {
      return auth.fetchImpl(input, init);
    }
    if (url.origin !== HARNESS_AUTH && url.origin !== HARNESS_BRANCH) return auth.fetchImpl(input, init);
    const target = new URL(url.pathname + url.search, url.origin === HARNESS_AUTH ? 'https://prod.test' : 'https://branch.test');
    const headers = { ...(init.headers || {}) };
    const bearer = String(headers.authorization || '').replace(/^Bearer\s+/i, '');
    const role = bearer.match(/^token-([a-z]+)-on$/)?.[1];
    if (role) headers.authorization = `Bearer tok-${role}`;
    else if (bearer === ENV.SUPABASE_SERVICE_ROLE_KEY) headers.authorization = 'Bearer service-key';
    return backend.fetch(target.toString(), { ...init, headers });
  };
}

function make({ sdk = SDK?.sdk ?? { Agent: class {} }, respond = null } = {}) {
  const fake = createFakeDb();
  const backend = createBackend();
  const bundle = respond && SDK ? createProvider(SDK.sdk, respond) : { provider: null, log: [] };
  const handle = createAtlasAiHandler({
    env: (name) => ENV[name],
    fetchImpl: combinedFetch(backend),
    now: () => NOW,
    sdk,
    z: SDK?.z,
    gateway,
    modelProvider: () => bundle.provider,
    services: fake.services,
  });
  return { handle, db: fake.db, services: fake.services, backend, modelLog: bundle.log };
}

const json = async (response) => ({ status: response.status, body: await response.json() });

async function conversationFor(services, user) {
  return services.rpc('atlas_ai_conversation_create', { p_actor_id: user.id, p_actor_role: user.role, p_title: 'Gateway', p_context: {} });
}

test('voice-tool runs the real recipes.can_make with the JWT actor; one audit record, no duplicate', async () => {
  const { handle, db, services, backend } = make();
  const conversation = await conversationFor(services, USERS.bartender);
  const voice = await startVoice(handle, USERS.bartender, conversation.id);
  const response = await json(await handle(request('voice-tool', {
    user: USERS.bartender,
    body: { conversation_id: conversation.id, voice_session_id: voice.voice_session_id, name: 'recipes_can_make', arguments: JSON.stringify({ recipe_id: null, recipe_query: 'Pinot Spritz', servings: 40 }), call_id: 'call_1' },
  })));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(response.body.output, /Yes — 50 servings of Pinot Spritz/);
  assert.ok(response.body.evidence.some((entry) => entry.kind === 'calculation' && /^50 /.test(entry.value)));
  assert.equal(db.toolCalls.length, 1, 'the gateway audits once; the runtime does not duplicate it');
  assert.equal(db.toolCalls[0].p_tool_name, 'recipes.can_make');
  assert.equal(db.toolCalls[0].p_actor_role, 'bartender');
  assert.equal(db.toolCalls[0].p_status, 'ok');
  assert.ok(backend.calls.length > 0);
  assert.ok(!backend.calls.some((call) => call.kind === 'rest' && ['inventory_items', 'recipes'].includes(call.name)), 'staff read the redacted catalogs');
  assert.ok(backend.calls.filter((call) => call.kind === 'serviceRpc').every((call) => !call.args?.p_actor_role || call.args.p_actor_role === 'bartender'));
  const context = db.conversations.get(conversation.id).context;
  assert.equal(context.last_tool, 'recipes.can_make');
  assert.equal(context.last_subject.id, IDS.spritz);
});

test('voice-tool: role checks and strict arguments from the real registry', async () => {
  const { handle, db, services } = make();
  const conversation = await conversationFor(services, USERS.bartender);
  const voice = await startVoice(handle, USERS.bartender, conversation.id);
  const forbidden = await json(await handle(request('voice-tool', {
    user: USERS.bartender, body: { conversation_id: conversation.id, voice_session_id: voice.voice_session_id, name: 'recipes_cost', arguments: '{"recipe_id":null,"recipe_query":"Margarita"}', call_id: 'c2' },
  })));
  assert.equal(forbidden.status, 403);
  const padded = await json(await handle(request('voice-tool', {
    user: USERS.bartender,
    body: { conversation_id: conversation.id, voice_session_id: voice.voice_session_id, name: 'inventory_below_par', arguments: { category: null, limit: null, actor: { role: 'admin' } }, call_id: 'c3' },
  })));
  assert.equal(padded.status, 200);
  assert.match(padded.body.output, /Could not check that: Invalid arguments: arguments\.actor is not an accepted argument/);
  assert.equal(db.toolCalls.at(-1).p_status, 'failed');
});

test('voice note count: draft proposal stored (no message id), approved by the proposer, runs atlas-stock-counts', async () => {
  const { handle, db, services, backend } = make();
  const conversation = await conversationFor(services, USERS.bartender);
  const voice = await startVoice(handle, USERS.bartender, conversation.id);
  const draft = await json(await handle(request('voice-tool', {
    user: USERS.bartender,
    body: {
      conversation_id: conversation.id,
      voice_session_id: voice.voice_session_id,
      name: 'inventory_prepare_count',
      arguments: { entries: [{ item_id: null, item_query: 'Tanqueray', quantity: 6, unit: 'bottle', note: null }, { item_id: null, item_query: 'Campari', quantity: 2, unit: 'bottle', note: null }], title: null, note: null },
      call_id: 'c4',
    },
  })));
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.equal(draft.body.proposal.kind, 'stock_count.draft');
  const [action] = [...db.actions.values()];
  assert.equal(action.message_id, null);
  assert.deepEqual(action.required_roles, ['admin', 'manager', 'bartender']);
  assert.equal(action.preview.headline, 'New stock count with 2 counted lines');
  assert.deepEqual(backend.writes, [], 'nothing changed before approval');
  const executed = await json(await handle(request('execute-action', { user: USERS.bartender, body: { action_id: action.id } })));
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.equal(executed.body.ok, true);
  assert.deepEqual(backend.writes.map((write) => write.name), ['stock-counts:start', 'stock-counts:save-line', 'stock-counts:save-line']);
  assert.equal(db.actions.get(action.id).status, 'executed');
});

test('draft purchase order: bartender cannot approve; manager approval runs atlas_purchase_order_command_v2 with the stored command', async () => {
  const { handle, db, services, backend } = make();
  const conversation = await conversationFor(services, USERS.manager);
  const voice = await startVoice(handle, USERS.manager, conversation.id);
  const draft = await json(await handle(request('voice-tool', {
    user: USERS.manager,
    body: { conversation_id: conversation.id, voice_session_id: voice.voice_session_id, name: 'purchasing_prepare_draft_po', arguments: { supplier_id: IDS.supplierVin, supplier_query: null, use_suggestions: true, lines: null, note: null, expected_delivery_date: null }, call_id: 'c5' },
  })));
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const [action] = [...db.actions.values()];
  assert.equal(action.kind, 'purchase_order.create');
  const byBartender = await json(await handle(request('execute-action', { user: USERS.bartender, body: { action_id: action.id } })));
  assert.notEqual(byBartender.status, 200);
  assert.deepEqual(backend.writes, []);
  const approved = await json(await handle(request('execute-action', { user: USERS.manager, body: { action_id: action.id, command: { p_lines: [] } } })));
  assert.equal(approved.body.ok, true, JSON.stringify(approved.body));
  assert.equal(backend.writes.length, 1);
  assert.equal(backend.writes[0].args.p_id, action.command.p_id);
  assert.deepEqual(backend.writes[0].args.p_lines, [{ item_id: IDS.angelo, quantity: 18, unit_cost: 3000 }], 'stored command, never the client payload');
});

test('background signals come from the real operations.alerts, shifts.schedule and data quality tools', async () => {
  const { handle, db } = make();
  const response = await json(await handle(request('refresh-signals', { user: USERS.manager })));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const tools = response.body.checked.map((entry) => entry.tool);
  assert.ok(tools.includes('operations.alerts') && tools.includes('shifts.schedule') && tools.includes('data_quality.review_list'));
  assert.ok(response.body.checked.every((entry) => entry.ok), JSON.stringify(response.body.checked));
  const sources = new Set([...db.signals.values()].map((signal) => signal.source_tool));
  assert.ok(sources.has('operations.alerts') && sources.has('data_quality.review_list'));
  assert.ok([...db.signals.values()].some((signal) => /below par/.test(signal.title)));
});

test('every real registry tool converts to a strict SDK tool, with all 11 specialists, for an admin', { skip: SKIP_SDK }, async () => {
  const { buildAtlasAgent } = await import('../../supabase/functions/atlas-ai/agents.mjs');
  const built = buildAtlasAgent({
    sdk: SDK.sdk, z: SDK.z, gateway, actor: { userId: USERS.manager.id, role: 'admin', label: 'Admin' },
    venue: { name: 'VÁ', timezone: 'Atlantic/Reykjavik' }, nowIso: '2026-09-24T12:00:00Z', preferences: {}, models: { orchestrator: 'o', specialist: 's' },
  });
  for (const entry of gateway.TOOL_REGISTRY) assert.ok(built.toolNames.includes(entry.fnName), entry.fnName);
  assert.equal(built.specialistNames.length, 11);
  const viewer = buildAtlasAgent({
    sdk: SDK.sdk, z: SDK.z, gateway, actor: { userId: USERS.viewer.id, role: 'viewer', label: 'Viewer' },
    venue: { name: 'VÁ', timezone: 'Atlantic/Reykjavik' }, nowIso: '2026-09-24T12:00:00Z', preferences: {}, models: { orchestrator: 'o', specialist: 's' },
  });
  for (const name of ['recipes_cost', 'purchasing_suggest', 'inventory_prepare_count', 'decisions_history']) assert.ok(!viewer.toolNames.includes(name), name);
});

test('chat: the model calls the real recipes.can_make and the answer is grounded with its evidence', { skip: SKIP_SDK }, async () => {
  const { handle, db } = make({
    sdk: SDK?.sdk,
    respond: (req) => {
      if (!hasToolOutput(req)) return toolCall('recipes_can_make', { recipe_id: null, recipe_query: 'Pinot Spritz', servings: 40 });
      return message('Yes. We can make 50 Pinot Spritz from verified stock, limited by Angelo Pinot Grigio. ');
    },
  });
  const response = await handle(request('chat', { user: USERS.bartender, body: { message: 'Can we make 40 Pinot Spritz?', client_request_id: 'req-gateway-01' } }));
  assert.equal(response.status, 200);
  const events = await readSse(response);
  const done = events.find((entry) => entry.event === 'done')?.data;
  assert.ok(done, JSON.stringify(events.filter((entry) => entry.event === 'error')));
  assert.equal(done.grounding, 'ok');
  const evidence = events.find((entry) => entry.event === 'evidence').data.items;
  assert.ok(evidence.some((entry) => entry.label === 'Stock of Angelo Pinot Grigio' && entry.value === '10 bottle'));
  assert.deepEqual(events.filter((entry) => entry.event === 'progress').map((entry) => entry.data.label), ['Checking whether we can make it']);
  assert.equal(db.toolCalls.filter((entry) => entry.p_tool_name === 'recipes.can_make').length, 1);
});
