import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// S91 live voice: a short renewable lease (voice-heartbeat) and a same-user
// device handoff (voice-session with takeover). Production (25 Sep): an
// iPhone kept hearing "Live voice is already open in another tab or device"
// because a reserved session whose voice-end never arrived held the slot for
// its 10-minute lease. The SQL side is proven by
// scripts/verify_s91_voice_preview.sql against a replayed database; the
// in-memory RPCs used here mirror that migration.
// Runs under Node (`npm test`) and Deno (`npm run test:ai`).

import { USERS, createHandler, request, startVoice } from './helpers/atlas-ai-harness.mjs';
import { SDK } from './helpers/atlas-ai-sdk.mjs';
import { mapRpcError } from '../../supabase/functions/atlas-ai/http.mjs';
import { LIMITS } from '../../supabase/functions/atlas-ai/config.mjs';

const DUMMY_SDK = SDK?.sdk ?? { Agent: class {} };
const make = (options = {}) => createHandler({ sdk: DUMMY_SDK, z: SDK?.z, ...options });
const json = async (response) => ({ status: response.status, body: await response.json() });
const conversationFor = (services, user) => services.rpc('atlas_ai_conversation_create', { p_actor_id: user.id, p_actor_role: user.role, p_title: 'Voice', p_context: {} });
const MIGRATION = new URL('../../supabase/migrations/20260930092000_s91_voice_lease_and_takeover.sql', import.meta.url);

// The S91 web client says it heartbeats, so the server may use the short lease.
async function startLive(handle, user, conversationId, extra = {}) {
  const response = await handle(request('voice-session', { user, body: { conversation_id: conversationId, heartbeat: true, ...extra } }));
  const body = await response.json();
  if (response.status !== 200) throw new Error(`voice-session failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

test('a client that heartbeats gets a 2-minute lease and is told to heartbeat every 45 seconds', async () => {
  const { handle, db, services } = make();
  const conversation = await conversationFor(services, USERS.bartender);
  const voice = await startLive(handle, USERS.bartender, conversation.id);
  assert.equal(voice.lease_seconds, 120);
  assert.equal(voice.heartbeat_seconds, 45);
  assert.equal(voice.replaced_sessions, 0);
  assert.equal(LIMITS.voiceLeaseSeconds, 120);
  assert.ok(LIMITS.voiceHeartbeatSeconds * 2 < LIMITS.voiceLeaseSeconds, 'two heartbeats fit in one lease, so one lost request does not end the call');
  const row = db.voiceSessions.get(voice.voice_session_id);
  assert.ok(Math.abs(row.lease_expires_at - row.started_at - 120000) < 1000);
  assert.equal(row.hard_expires_at - row.started_at, 3600000, 'the 60-minute hard cap is unchanged');
  const start = db.calls.find((call) => call.name === 'atlas_ai_voice_session_start');
  assert.equal(start.payload.p_takeover, false);
  assert.equal(start.payload.p_lease_seconds, 120);
});

test('an older client that sends no heartbeat flag keeps the 10-minute lease; its first heartbeat shortens it (review P2-A)', async () => {
  const { handle, db, services } = make();
  const conversation = await conversationFor(services, USERS.bartender);
  const voice = await startVoice(handle, USERS.bartender, conversation.id);
  const start = db.calls.find((call) => call.name === 'atlas_ai_voice_session_start');
  assert.ok(!('p_lease_seconds' in start.payload), 'the database default (600 s) applies');
  assert.equal(voice.lease_seconds, 600);
  const row = db.voiceSessions.get(voice.voice_session_id);
  assert.ok(Math.abs(row.lease_expires_at - row.started_at - 600000) < 1000);
  const beat = await json(await handle(request('voice-heartbeat', { user: USERS.bartender, body: { voice_session_id: voice.voice_session_id } })));
  assert.equal(beat.status, 200);
  assert.equal(row.lease_seconds, 120);
  assert.ok(row.lease_expires_at - Date.now() <= 121000, 'a heartbeating client is on the short lease');
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  assert.match(sql, /p_lease_seconds integer default 600/);
  assert.match(sql, /lease_seconds = least\(s\.lease_seconds, 120\)/);
});

test('heartbeats are limited to one per 15 seconds per session (review P3-5)', async () => {
  const { handle, services } = make();
  const conversation = await conversationFor(services, USERS.bartender);
  const voice = await startLive(handle, USERS.bartender, conversation.id);
  const first = await json(await handle(request('voice-heartbeat', { user: USERS.bartender, body: { voice_session_id: voice.voice_session_id } })));
  const second = await json(await handle(request('voice-heartbeat', { user: USERS.bartender, body: { voice_session_id: voice.voice_session_id } })));
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(second.body.error_code, 'rate_limited');
  assert.match(fs.readFileSync(MIGRATION, 'utf8'), /last_heartbeat_at > pg_catalog\.now\(\) - interval '15 seconds'/);
});

test('voice-heartbeat renews the lease; without it the session lapses and a new start works without reloading', async () => {
  const { handle, db, services } = make();
  const conversation = await conversationFor(services, USERS.bartender);
  const voice = await startLive(handle, USERS.bartender, conversation.id);
  const row = db.voiceSessions.get(voice.voice_session_id);
  row.lease_expires_at = Date.now() + 5000; // 5 s left
  const beat = await json(await handle(request('voice-heartbeat', { user: USERS.bartender, body: { voice_session_id: voice.voice_session_id } })));
  assert.equal(beat.status, 200, JSON.stringify(beat.body));
  assert.equal(beat.body.live, true);
  assert.ok(Date.parse(beat.body.lease_expires_at) - Date.now() > 110000, 'renewed to about 2 minutes');
  assert.equal(row.heartbeats, 1);

  // While it is live, a second start is refused (the phone case) ...
  const refused = await json(await handle(request('voice-session', { user: USERS.bartender, body: { conversation_id: conversation.id } })));
  assert.equal(refused.status, 429);
  assert.equal(refused.body.reason, 'concurrent');
  // ... the page died without voice-end, so no heartbeat arrives and the
  // lease lapses (simulated): "Try again" works.
  row.lease_expires_at = Date.now() - 1000;
  const lapsed = await json(await handle(request('voice-heartbeat', { user: USERS.bartender, body: { voice_session_id: voice.voice_session_id } })));
  assert.equal(lapsed.status, 409);
  assert.equal(lapsed.body.error_code, 'voice_session_inactive');
  const retry = await json(await handle(request('voice-session', { user: USERS.bartender, body: { conversation_id: conversation.id } })));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.replaced_sessions, 0);
});

test('tool calls and transcript appends renew the lease too, but never past the hard cap', async () => {
  const { handle, db, services } = make();
  const conversation = await conversationFor(services, USERS.manager);
  const voice = await startLive(handle, USERS.manager, conversation.id);
  const row = db.voiceSessions.get(voice.voice_session_id);
  row.lease_expires_at = Date.now() + 1000;
  const tool = await json(await handle(request('voice-tool', { body: { conversation_id: conversation.id, voice_session_id: voice.voice_session_id, name: 'inventory_current_stock', arguments: { query: null } } })));
  assert.equal(tool.status, 200);
  assert.ok(row.lease_expires_at - Date.now() > 110000);
  row.hard_expires_at = Date.now() + 30000;
  row.lease_expires_at = Date.now() + 1000;
  const append = await json(await handle(request('voice-append', { body: { conversation_id: conversation.id, voice_session_id: voice.voice_session_id, turns: [{ role: 'user', text: 'Six Aperol', client_request_id: 'voice-s91-app-1' }] } })));
  assert.equal(append.status, 200);
  assert.equal(row.lease_expires_at, row.hard_expires_at, 'the lease never extends past the hard cap');
});

test('takeover ("Continue here") ends only the same person\'s live session and reserves the new one', async () => {
  const { handle, db, services } = make();
  const barConversation = await conversationFor(services, USERS.bartender);
  const mgrConversation = await conversationFor(services, USERS.manager);
  const phoneOld = await startVoice(handle, USERS.bartender, barConversation.id);
  const managerCall = await startVoice(handle, USERS.manager, mgrConversation.id);

  const response = await json(await handle(request('voice-session', { user: USERS.bartender, body: { conversation_id: barConversation.id, takeover: true } })));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.replaced_sessions, 1);
  const start = db.calls.filter((call) => call.name === 'atlas_ai_voice_session_start').at(-1);
  assert.equal(start.payload.p_takeover, true);
  assert.equal(start.payload.p_actor_id, USERS.bartender.id, 'the takeover is scoped by the verified actor, never by the body');

  const old = db.voiceSessions.get(phoneOld.voice_session_id);
  assert.equal(old.end_reason, 'replaced');
  assert.equal(old.replaced_by, response.body.voice_session_id);
  assert.deepEqual(db.voiceEvents, [{ voice_session_id: phoneOld.voice_session_id, user_id: USERS.bartender.id, actor_role: 'bartender', event: 'replaced', replaced_by: response.body.voice_session_id }]);
  const other = db.voiceSessions.get(managerCall.voice_session_id);
  assert.equal(other.ended_at, null, 'another person\'s call is never touched');
  assert.equal(other.end_reason, null);

  // Its last transcript lines are still saved for a few minutes, and the
  // result tells it the call moved (review P3-3).
  const lastLines = await json(await handle(request('voice-append', { user: USERS.bartender, body: { conversation_id: barConversation.id, voice_session_id: phoneOld.voice_session_id, turns: [{ role: 'user', text: 'Six limes left', client_request_id: 'voice-s91-old-1' }] } })));
  assert.equal(lastLines.status, 200);
  assert.equal(lastLines.body.voice_replaced, true);
  assert.ok(db.messages.some((entry) => entry.content === 'Six limes left'));
  old.ended_at -= 6 * 60000;
  // The replaced device is told, on its next heartbeat, tool call or (later) append.
  for (const [action, body] of [
    ['voice-heartbeat', { voice_session_id: phoneOld.voice_session_id }],
    ['voice-tool', { conversation_id: barConversation.id, voice_session_id: phoneOld.voice_session_id, name: 'inventory_current_stock', arguments: { query: null } }],
    ['voice-append', { conversation_id: barConversation.id, voice_session_id: phoneOld.voice_session_id, turns: [{ role: 'user', text: 'Still here?', client_request_id: 'voice-s91-old-2' }] }],
  ]) {
    const result = await json(await handle(request(action, { user: USERS.bartender, body })));
    assert.equal(result.status, 409, action);
    assert.deepEqual(result.body, { error_code: 'voice_session_replaced', message: 'Live voice moved to another device.' }, action);
  }
  const end = await json(await handle(request('voice-end', { user: USERS.bartender, body: { voice_session_id: phoneOld.voice_session_id } })));
  assert.equal(end.status, 200, 'voice-end on a replaced session stays idempotent');
  // The new device keeps working.
  const tool = await json(await handle(request('voice-tool', { user: USERS.bartender, body: { conversation_id: barConversation.id, voice_session_id: response.body.voice_session_id, name: 'inventory_current_stock', arguments: { query: null } } })));
  assert.equal(tool.status, 200);
});

test('takeover still counts against the daily quotas and ends nothing when a quota refuses', async () => {
  const { handle, db, services } = make();
  db.settings.voice_sessions_per_day = 1;
  const conversation = await conversationFor(services, USERS.bartender);
  const first = await startVoice(handle, USERS.bartender, conversation.id);
  const refused = await json(await handle(request('voice-session', { user: USERS.bartender, body: { conversation_id: conversation.id, takeover: true } })));
  assert.equal(refused.status, 429);
  assert.equal(refused.body.reason, 'daily_sessions');
  const row = db.voiceSessions.get(first.voice_session_id);
  assert.equal(row.ended_at, null, 'a refused takeover leaves the live call alone');
  assert.equal(db.voiceEvents.length, 0);
  assert.equal((await json(await handle(request('voice-heartbeat', { user: USERS.bartender, body: { voice_session_id: first.voice_session_id } })))).status, 200);
});

test('only a literal true takes over; a heartbeat without a session id is refused', async () => {
  const { handle, db, services } = make();
  const conversation = await conversationFor(services, USERS.viewer);
  await startVoice(handle, USERS.viewer, conversation.id);
  const truthy = await json(await handle(request('voice-session', { user: USERS.viewer, body: { conversation_id: conversation.id, takeover: 'yes' } })));
  assert.equal(truthy.status, 429);
  assert.equal(db.calls.filter((call) => call.name === 'atlas_ai_voice_session_start').at(-1).payload.p_takeover, false);
  const missing = await json(await handle(request('voice-heartbeat', { user: USERS.viewer, body: {} })));
  assert.equal(missing.status, 409);
  assert.equal(missing.body.error_code, 'voice_session_inactive');
  const get = await handle(request('voice-heartbeat', { user: USERS.viewer, method: 'GET' }));
  assert.equal(get.status, 405);
});

test('the replaced error prefix maps to a fixed browser message; the migration keeps the contract', () => {
  const mapped = mapRpcError('atlas_ai_voice_session_touch', '55000', 'voice_session_replaced: live voice moved to another device');
  assert.equal(mapped.status, 409);
  assert.equal(mapped.code, 'voice_session_replaced');
  assert.equal(mapped.message, 'Live voice moved to another device.');
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  assert.match(sql, /drop function if exists public\.atlas_ai_voice_session_start\(uuid, text, uuid, jsonb, integer\)/);
  assert.match(sql, /p_takeover boolean default false,\s*p_lease_seconds integer default 600/);
  assert.match(sql, /where s\.user_id = p_actor_id\s+and s\.ended_at is null/, 'takeover is scoped to the actor');
  assert.match(sql, /end_reason in \('client_end','mint_failed','replaced'\)/);
  assert.match(sql, /'public\.atlas_ai_voice_session_start\(uuid, text, uuid, jsonb, integer, boolean, integer\)'/);
  assert.match(sql, /revoke all on function %s from public, anon, authenticated/);
  assert.doesNotMatch(sql, /security definer/i);
});
