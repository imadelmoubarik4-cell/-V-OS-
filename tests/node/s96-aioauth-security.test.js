import test from 'node:test';
import assert from 'node:assert/strict';

// S96 security regression tests (agent aioauth): Atlas AI, the Tool Gateway,
// visual inventory recognition and atlas-integrations. Every test drives the
// real handler or module with an attack input and asserts that it is refused
// before anything is stored, sent to a provider or executed.

import { USERS, createHandler, request, startVoice } from './helpers/atlas-ai-harness.mjs';
import * as realGateway from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { validateArgs } from '../../supabase/functions/_shared/ai-tools/schema.mjs';
import { executeProposal, validateCommand } from '../../supabase/functions/_shared/ai-tools/actions.mjs';
import { createRecognitionHandler } from '../../supabase/functions/atlas-inventory-recognition/handler.mjs';
import {
  buildRedirectUri, buildReturnUrl, createOAuthState, hashState, isAllowedHost, normalizeReturnPath, parseAllowedOrigins,
} from '../../supabase/functions/atlas-integrations/oauth-core.mjs';
import { createIntegrationsHandler } from '../../supabase/functions/atlas-integrations/handler.mjs';

const json = async (response) => ({ status: response.status, body: await response.json() });
const DUMMY_SDK = { Agent: class {} };

// ---------------------------------------------------------------- Atlas AI

test('C14/C15 execute-action: another staff member, a viewer, a replay and an expired proposal are refused', async () => {
  const { handle, services, db } = createHandler({ sdk: DUMMY_SDK, gateway: realGateway });
  const conversation = await services.rpc('atlas_ai_conversation_create', { p_actor_id: USERS.bartender.id, p_actor_role: 'bartender', p_title: 'x', p_context: {} });
  const action = await services.rpc('atlas_ai_action_create', {
    p_actor_id: USERS.bartender.id, p_actor_role: 'bartender', p_conversation_id: conversation.id, p_message_id: null,
    p_kind: 'stock_count.draft', p_title: 'Count', p_preview: {}, p_command: { title: 'x' },
    p_required_roles: ['admin', 'manager', 'bartender'],
  });
  const other = { ...USERS.bartender, id: '00000000-0000-4000-8000-0000000000e5' };
  // The viewer (not owner, not manager) gets "not found", never the command.
  const viewer = await json(await handle(request('execute-action', { user: USERS.viewer, body: { action_id: action.id } })));
  assert.equal(viewer.status, 404);
  assert.ok(!JSON.stringify(viewer.body).includes('"command"'));
  // A client-supplied command or kind is ignored: only action_id is read.
  const first = await json(await handle(request('execute-action', { user: USERS.bartender, body: { action_id: action.id, command: { channel_key: 'announcements' }, kind: 'team_message.send' } })));
  assert.equal(first.body.error?.code, 'invalid_arguments', 'the stored (invalid) command is what gets validated');
  const replay = await json(await handle(request('execute-action', { user: USERS.bartender, body: { action_id: action.id } })));
  assert.equal(replay.status, 409, 'single use');
  assert.ok(other);
  const expired = await services.rpc('atlas_ai_action_create', {
    p_actor_id: USERS.bartender.id, p_actor_role: 'bartender', p_conversation_id: conversation.id, p_message_id: null,
    p_kind: 'stock_count.draft', p_title: 'Count', p_preview: {}, p_command: { title: 'x' }, p_required_roles: ['admin', 'manager', 'bartender'],
  });
  db.actions.get(expired.id).expires_at = new Date(Date.now() - 1000).toISOString();
  const late = await json(await handle(request('execute-action', { user: USERS.bartender, body: { action_id: expired.id } })));
  assert.equal(late.status, 409, 'expired proposals are refused');
});

test('C15 a stored command is re-validated and re-authorised at execute time (tampered command, lower role)', async () => {
  const ctx = (role) => ({ actor: { userId: USERS[role === 'bartender' ? 'bartender' : 'manager'].id, role, active: true, token: 't' }, env: {}, fetch: async () => { throw new Error('no network'); }, now: () => new Date() });
  const po = {
    p_id: '00000000-0000-4000-8000-00000000aa01', p_action: 'create', p_supplier_id: '00000000-0000-4000-8000-00000000aa02',
    p_lines: [{ item_id: '00000000-0000-4000-8000-00000000aa03', quantity: 1, unit_cost: 1 }], p_note: '', p_expected_delivery_date: null,
  };
  assert.equal((await executeProposal('purchase_order.create', po, ctx('bartender'))).error.code, 'forbidden');
  assert.equal((await executeProposal('purchase_order.create', { ...po, p_action: 'place' }, ctx('manager'))).error.code, 'invalid_arguments');
  assert.equal((await executeProposal('purchase_order.create', { ...po, p_actor_id: USERS.manager.id }, ctx('manager'))).error.code, 'invalid_arguments');
  const announcement = { channel_key: 'announcements', body: 'hi', link_type: 'none', link_key: null, link_label: null, client_request_id: '00000000-0000-4000-8000-00000000aa04' };
  assert.equal((await executeProposal('team_message.send', announcement, ctx('bartender'))).error.code, 'forbidden');
  assert.equal((await executeProposal('settings.change', {}, ctx('manager'))).error.code, 'not_found');
});

test('C14 voice-tool re-applies the role gate server-side: a bartender cannot run manager-only tools through a live session', async () => {
  const { handle, services, db } = createHandler({ sdk: DUMMY_SDK, gateway: realGateway });
  const conversation = await services.rpc('atlas_ai_conversation_create', { p_actor_id: USERS.bartender.id, p_actor_role: 'bartender', p_title: 'v', p_context: {} });
  const voice = await startVoice(handle, USERS.bartender, conversation.id);
  for (const name of ['recipes_cost', 'reports_margin', 'purchasing_suggest', 'integrations_status', 'decisions_history', 'recipes.cost']) {
    const response = await json(await handle(request('voice-tool', { user: USERS.bartender, body: { conversation_id: conversation.id, voice_session_id: voice.voice_session_id, name, arguments: {} } })));
    assert.equal(response.status, 403, name);
  }
  // Another user's conversation is refused even with the caller's own live session.
  const managerConversation = await services.rpc('atlas_ai_conversation_create', { p_actor_id: USERS.manager.id, p_actor_role: 'manager', p_title: 'm', p_context: {} });
  const cross = await json(await handle(request('voice-tool', { user: USERS.bartender, body: { conversation_id: managerConversation.id, voice_session_id: voice.voice_session_id, name: 'inventory_current_stock', arguments: { query: null } } })));
  assert.ok([400, 404].includes(cross.status), `cross-conversation voice tool refused (${cross.status})`);
  assert.ok(!db.toolCalls.some((call) => call.p_tool_name === 'recipes.cost' && call.p_decision === 'allowed'));
});

test('C9/C12 scheduler routes refuse a missing, wrong or short service secret', async () => {
  for (const [env, header] of [[{}, null], [{}, 'wrong-secret'], [{ ATLAS_AI_SERVICE_SECRET: 'short' }, 'short'], [{ ATLAS_AI_SERVICE_SECRET: '' }, '']]) {
    const { handle } = createHandler({ sdk: DUMMY_SDK, env });
    const headers = header === null ? {} : { 'x-atlas-ai-service-secret': header };
    const response = await handle(new Request('https://branch.example.test/functions/v1/atlas-ai?action=maintenance', { method: 'POST', headers }));
    assert.equal(response.status, 401);
  }
  const { handle } = createHandler({ sdk: DUMMY_SDK });
  const staff = await json(await handle(request('refresh-signals', { user: USERS.bartender })));
  assert.equal(staff.status, 403);
});

test('C20 prototype-pollution keys in tool arguments and stored commands are rejected, and nothing is polluted', () => {
  const polluted = JSON.parse('{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"isAdmin":true}},"query":null}');
  const schema = realGateway.getTool('inventory.current_stock').parameters;
  const checked = validateArgs(schema, polluted);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join(' '), /__proto__ is not an accepted argument/);
  assert.equal(validateArgs(schema, '{"__proto__":{"x":1},"query":null}').ok, false);
  const command = JSON.parse('{"__proto__":{"channel_key":"general"},"channel_key":"announcements","body":"x","link_type":"none","link_key":null,"link_label":null,"client_request_id":"00000000-0000-4000-8000-00000000aa05"}');
  assert.equal(validateCommand('team_message.send', command).ok, false);
  assert.equal({}.isAdmin, undefined);
  assert.equal(Object.prototype.channel_key, undefined);
});

test('C20 preferences/settings patches only copy allow-listed own keys (no prototype keys reach the RPC)', async () => {
  const { handle, db } = createHandler({ sdk: DUMMY_SDK });
  const body = '{"patch":{"__proto__":{"reply_length":"long"},"constructor":{"x":1},"language":"is"}}';
  const response = await handle(new Request('https://branch.example.test/functions/v1/atlas-ai?action=preferences', {
    method: 'POST', headers: { authorization: `Bearer token-manager-on`, 'content-type': 'application/json' }, body,
  }));
  assert.equal(response.status, 200);
  const call = db.calls.filter((entry) => entry.name === 'atlas_ai_preferences_set').at(-1);
  assert.deepEqual(Object.keys(call.payload.p_patch), ['language']);
  assert.equal({}.reply_length, undefined);
});

// ------------------------------------------------------- inventory recognition

const RECOGNITION_ACTOR = { userId: '00000000-0000-4000-8000-0000000000b2', role: 'bartender', active: true, label: 'Bjarni Bar' };
function recognition() {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/storage/v1/object/')) { calls.push({ kind: 'storage', path: url.pathname }); return new Response('{}'); }
    const name = url.pathname.replace('/rest/v1/rpc/', '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ kind: 'rpc', name, args: body });
    if (name === 'atlas_recognition_request_get') return new Response('null');
    if (name === 'atlas_recognition_limits') return new Response(JSON.stringify({ vision_enabled: false }));
    if (name === 'atlas_recognition_register_media') return new Response(JSON.stringify({ media_id: '00000000-0000-4000-8000-00000000d001', expires_at: null }));
    if (name === 'atlas_recognition_record') return new Response(JSON.stringify({ request_id: '00000000-0000-4000-8000-00000000e001', detections: [] }));
    return new Response('{}');
  };
  const handle = createRecognitionHandler({
    env: (name) => ({ SUPABASE_URL: 'https://branch.example.test', SUPABASE_SERVICE_ROLE_KEY: 'k', OPENAI_API_KEY: '' })[name],
    fetchImpl, now: () => 1_790_000_000_000, newId: () => '00000000-0000-4000-8000-00000000f123', resolveActor: async () => RECOGNITION_ACTOR,
  });
  return { handle, calls };
}
function photo(payload, bytes, type, filename = 'photo.jpg') {
  const form = new FormData();
  form.set('payload', JSON.stringify(payload));
  form.set('image', new Blob([bytes], { type }), filename);
  return new Request('https://fn.example.test/atlas-inventory-recognition?action=identify', { method: 'POST', headers: { authorization: 'Bearer t' }, body: form });
}
const RID = '00000000-0000-4000-8000-000000000a11';
const enc = (text) => new TextEncoder().encode(text);

test('C2 recognition refuses spoofed MIME types, SVG/HTML active content and polyglot-looking files before storage', async () => {
  const cases = [
    [enc('<html><script>alert(1)</script></html>'), 'image/png'],
    [enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/jpeg'],
    [enc('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
    [enc('%PDF-1.7 /JavaScript (app.alert(1))'), 'application/pdf'],
    [enc('GIF89a<script>alert(1)</script>'), 'image/gif'],
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x3c, 0x68, 0x74]), 'text/html'],
  ];
  for (const [bytes, type] of cases) {
    const { handle, calls } = recognition();
    const response = await handle(photo({ client_request_id: RID }, bytes, type));
    assert.equal(response.status, 415, `${type} refused`);
    assert.ok(!calls.some((call) => call.kind === 'storage'), `${type} never stored`);
  }
});

test('C2 recognition refuses oversized photos with a 413 before reading them into storage', async () => {
  const { handle, calls } = recognition();
  const big = new Uint8Array(20 * 1024 * 1024 + 10);
  big.set([0xff, 0xd8, 0xff, 0xe0]);
  // A fixed-size (Uint8Array) body carries a content-length, so readBytes refuses it
  // at the declared-length guard before it opens the body stream — the primary path a
  // real oversized upload hits. (A FormData body streams with no content-length, and
  // cancelling that undici stream mid-read leaves a dangling encoder rejection.)
  const oversized = new Request('https://fn.example.test/atlas-inventory-recognition?action=identify', {
    method: 'POST', headers: { authorization: 'Bearer t' }, body: big,
  });
  const response = await handle(oversized);
  assert.equal(response.status, 413);
  assert.ok(!calls.some((call) => call.kind === 'storage'));
});

test('C3/C15 recognition ignores client-supplied paths, owners and actor fields; objects go under the caller\'s own prefix', async () => {
  const { handle, calls } = recognition();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 3, 4, 5]);
  const payload = {
    client_request_id: RID, path: '../../00000000-0000-4000-8000-0000000000a1/x.jpg', p_path: '/etc/passwd', user_id: USERS.manager.id,
    p_actor_id: USERS.manager.id, p_actor_role: 'admin', bucket: 'atlas-accounting-documents',
  };
  const response = await handle(photo(payload, jpeg, 'image/jpeg', '../../../evil.svg'));
  assert.ok(response.status < 300, `accepted as a normal photo (${response.status})`);
  const upload = calls.find((call) => call.kind === 'storage');
  assert.equal(upload.path, `/storage/v1/object/atlas-ai-media/${RECOGNITION_ACTOR.userId}/unsorted/00000000-0000-4000-8000-00000000f123.jpg`);
  for (const call of calls.filter((entry) => entry.kind === 'rpc')) {
    if (call.args && 'p_actor_id' in call.args) assert.equal(call.args.p_actor_id, RECOGNITION_ACTOR.userId, call.name);
    if (call.args && 'p_actor_role' in call.args) assert.equal(call.args.p_actor_role, 'bartender', call.name);
  }
});

// ---------------------------------------------------------------- integrations

test('C4 OAuth redirect and return targets are exact allow-listed values (no open redirect, no attacker host)', () => {
  const hosts = ['*.supabase.co'];
  assert.equal(buildRedirectUri('https://abc.supabase.co', 'google-drive', hosts), 'https://abc.supabase.co/functions/v1/atlas-integrations/callback/google-drive');
  for (const base of ['https://evil.example', 'http://abc.supabase.co', 'https://abc.supabase.co/x', 'https://abc.supabase.co?x=1', 'https://u:p@abc.supabase.co',
    'https://abc.supabase.co.evil.example', 'https://a.b.supabase.co', 'javascript:alert(1)', 'https://abc.supabase.co#x']) {
    assert.equal(buildRedirectUri(base, 'google-drive', hosts), null, base);
  }
  assert.equal(isAllowedHost('supabase.co', hosts), false);
  for (const path of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '#settings/../../x', '#settings?next=//evil', '#Settings', '#settings\u0000', '#a'.padEnd(80, 'b')]) {
    assert.equal(normalizeReturnPath(path), null, JSON.stringify(path));
  }
  assert.deepEqual(parseAllowedOrigins('http://os.example.is, https://os.example.is/app, https://os.example.is, https://u@x.example'), ['https://os.example.is']);
  assert.equal(buildReturnUrl('https://os.example.is', '//evil.example', 'google-drive', 'error'), 'https://os.example.is/?integration=google-drive&result=error#settings');
});

function integrations({ role = 'manager', consume = null, bind = null } = {}) {
  const rpcCalls = [];
  const providerCalls = [];
  const handle = createIntegrationsHandler({
    env: (name) => ({
      ATLAS_INTEGRATION_KEK_V1: Buffer.alloc(32, 7).toString('base64'), ATLAS_INTEGRATIONS_APP_ORIGINS: 'https://os.example.is',
      SUPABASE_URL: 'https://abc123.supabase.co', ATLAS_GOOGLE_OAUTH_CLIENT_ID: 'id', ATLAS_GOOGLE_OAUTH_CLIENT_SECRET: 'secret-value',
    })[name],
    fetchImpl: async (url) => { providerCalls.push(String(url)); return new Response('{}', { status: 500 }); },
    rpc: async (name, payload) => {
      rpcCalls.push({ name, payload });
      if (name === 'atlas_integration_consume_state') return consume;
      if (name === 'atlas_integration_bind_browser') return bind;
      if (name === 'atlas_integration_status') return [];
      return {};
    },
    authenticate: async (req) => {
      if (!req.headers.get('authorization')) throw Object.assign(new Error('auth'), { status: 401 });
      return { user: { id: '00000000-0000-4000-8000-000000000088' }, profile: { role, display_name: 'X', active: true } };
    },
    now: () => Date.parse('2026-09-28T00:00:00Z'),
  });
  return { handle, rpcCalls, providerCalls };
}

test('C1/C12 OAuth callback: no binding cookie, a wrong cookie or a replayed state never reaches the token endpoint', async () => {
  const state = createOAuthState();
  const url = `https://abc123.supabase.co/functions/v1/atlas-integrations/callback/google-drive?state=${state}&code=attacker-code`;
  const noCookie = integrations();
  const first = await noCookie.handle(new Request(url));
  assert.equal(first.status, 302);
  assert.match(first.headers.get('location'), /^https:\/\/os\.example\.is\/\?integration=google-drive&result=error&reason=browser_mismatch#settings$/);
  assert.ok(!noCookie.rpcCalls.some((call) => call.name === 'atlas_integration_consume_state'));
  assert.deepEqual(noCookie.providerCalls, []);
  const replay = integrations({ consume: null });
  const cookie = `__Host-atlas-oauth-google-drive=${createOAuthState()}`;
  const second = await replay.handle(new Request(url, { headers: { cookie } }));
  assert.match(second.headers.get('location'), /reason=invalid_state/);
  assert.deepEqual(replay.providerCalls, [], 'no token exchange for an unknown, consumed or unbound state');
  const consume = replay.rpcCalls.find((call) => call.name === 'atlas_integration_consume_state').payload;
  assert.equal(consume.p_state_hash, await hashState(state), 'only the hash of the state is sent to the database');
  const demoted = integrations({ consume: { provider_key: 'google-drive', actor_allowed: false, return_path: '#settings' } });
  const third = await demoted.handle(new Request(url, { headers: { cookie } }));
  assert.match(third.headers.get('location'), /reason=not_authorized/);
  assert.deepEqual(demoted.providerCalls, []);
  // A POST to the callback (cross-site form) is refused the same way.
  const post = integrations();
  const posted = await post.handle(new Request(url, { method: 'POST', headers: { cookie } }));
  assert.match(posted.headers.get('location'), /reason=(method|browser_mismatch)/);
  assert.deepEqual(post.providerCalls, []);
});

test('C1 OAuth authorize hop: an unbindable (already bound, expired or unknown) state is never forwarded to the provider', async () => {
  const { handle, rpcCalls } = integrations({ bind: null });
  const state = createOAuthState();
  const response = await handle(new Request(`https://abc123.supabase.co/functions/v1/atlas-integrations/authorize/google-drive?state=${state}&cc=${createOAuthState()}`));
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^https:\/\/os\.example\.is\/.*reason=invalid_state/);
  assert.equal(response.headers.get('set-cookie'), null, 'no binding cookie for a state that was not bound');
  assert.equal(rpcCalls.filter((call) => call.name === 'atlas_integration_bind_browser').length, 1);
});

test('C14/C15 integrations: staff roles and unauthenticated callers cannot start, test, disconnect or select; role comes from the profile', async () => {
  for (const role of ['bartender', 'viewer']) {
    const { handle, rpcCalls } = integrations({ role });
    for (const action of ['start', 'test', 'disconnect', 'save-api-key', 'list-resources', 'select-resource', 'set-review-state']) {
      const response = await handle(new Request(`https://abc123.supabase.co/atlas-integrations?action=${action}`, {
        method: 'POST', headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ provider_key: 'google-drive', p_actor_role: 'admin', role: 'admin', actor: { role: 'admin' } }),
      }));
      assert.equal(response.status, 403, `${role} ${action}`);
    }
    assert.deepEqual(rpcCalls, []);
  }
  const { handle } = integrations({ role: 'manager' });
  const anonymous = await handle(new Request('https://abc123.supabase.co/atlas-integrations?action=start', { method: 'POST', body: '{}' }));
  assert.ok([401, 500].includes(anonymous.status));
  const managerReview = await handle(new Request('https://abc123.supabase.co/atlas-integrations?action=set-review-state', {
    method: 'POST', headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' }, body: JSON.stringify({ provider_key: 'facebook', review_state: 'approved', p_actor_role: 'admin' }),
  }));
  assert.equal(managerReview.status, 403, 'set-review-state is administrator-only whatever the body claims');
});

test('C20 integrations JSON bodies with prototype keys do not change the caller or pollute objects', async () => {
  const { handle, rpcCalls } = integrations({ role: 'manager' });
  const body = '{"__proto__":{"provider_key":"facebook","role":"admin"},"constructor":{"prototype":{"polluted":true}},"provider_key":"google-drive","return_path":"#settings"}';
  const response = await handle(new Request('https://abc123.supabase.co/atlas-integrations?action=start', { method: 'POST', headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' }, body }));
  assert.equal(response.status, 200);
  const begin = rpcCalls.find((call) => call.name === 'atlas_integration_begin').payload;
  assert.equal(begin.p_provider_key, 'google-drive');
  assert.equal(begin.p_actor_role, 'manager');
  assert.equal({}.polluted, undefined);
  assert.equal({}.provider_key, undefined);
});
