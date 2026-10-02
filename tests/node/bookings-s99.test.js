// S99 Alcedo Bookings gateway (supabase/functions/atlas-bookings): every request is
// authenticated server-side and the resolved actor (never a browser-sent id/role) is passed
// to the service-role RPCs; manager-only actions (config + rules) are gated at the gateway;
// bad input is rejected before the DB; RPC errors are redacted to a hint-mapped status.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBookingsHandler, mapRpcError, MESSAGES, ApiError,
} from '../../supabase/functions/atlas-bookings/handler.mjs';

const MANAGER = { userId: '22222222-2222-4222-8222-222222222222', role: 'manager', active: true, label: 'Manager' };
const BARTENDER = { userId: '33333333-3333-4333-8333-333333333333', role: 'bartender', active: true, label: 'Bar' };
const VIEWER = { userId: '99999999-9999-4999-8999-999999999999', role: 'viewer', active: true, label: 'Viewer' };
const RES = '44444444-4444-4444-8444-444444444444';
const TABLE = '55555555-5555-4555-8555-555555555555';

function fakeServices(overrides = {}) {
  const calls = { rpc: [] };
  return {
    calls,
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      if (overrides.rpc) { const v = await overrides.rpc(name, args); if (v !== undefined) return v; }
      switch (name) {
        case 'atlas_bookings_snapshot': return { date: args.p_date, areas: [], tables: [], reservations: [], holds: [], permissions: { can_configure: true, can_manage_reservations: true }, actor_role: args.p_actor_role };
        case 'atlas_bookings_config': return { areas: [], tables: [], combinations: [], settings: { version: 1 } };
        case 'atlas_bookings_availability': return { party_size: args.p_party_size, duration_minutes: 90, slots: [] };
        case 'atlas_bookings_save_area': return { id: '66666666-6666-4666-8666-666666666666' };
        case 'atlas_bookings_save_table': return { id: TABLE };
        case 'atlas_bookings_save_combination': return { id: '77777777-7777-4777-8777-777777777777' };
        case 'atlas_bookings_save_settings': return { version: 2 };
        case 'atlas_bookings_create': return { reservation: { id: RES, status: 'confirmed', tables: [{ table_id: TABLE, label: 'Bar 1' }] }, replayed: false };
        case 'atlas_bookings_assign': return { reservation: { id: RES, status: 'confirmed' } };
        case 'atlas_bookings_set_status': return { reservation: { id: RES, status: 'arrived' }, unchanged: false };
        case 'atlas_bookings_hold': return { id: '88888888-8888-4888-8888-888888888888' };
        case 'atlas_bookings_release_hold': return { ok: true };
        default: return {};
      }
    },
  };
}

function handlerFor({ actor = MANAGER, services } = {}) {
  const svc = services ?? fakeServices();
  const handle = createBookingsHandler({ env: () => undefined, fetchImpl: async () => { throw new Error('no network'); }, resolveActor: async () => actor, services: svc });
  return { handle, svc };
}
const get = (action, params = {}) => new Request(`https://fn.test/atlas-bookings?${new URLSearchParams({ action, ...params })}`, { headers: { authorization: 'Bearer t' } });
const post = (action, bodyObj) => new Request(`https://fn.test/atlas-bookings?action=${action}`, {
  method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(bodyObj),
});
const read = async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) });

test('OPTIONS is a CORS preflight', async () => {
  const { handle } = handlerFor();
  const r = await handle(new Request('https://fn.test/atlas-bookings', { method: 'OPTIONS' }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('unknown action is 404; a PUT is 405', async () => {
  const { handle } = handlerFor();
  assert.equal((await read(await handle(get('nope')))).status, 404);
  const put = new Request('https://fn.test/atlas-bookings?action=snapshot', { method: 'PUT', headers: { authorization: 'Bearer t' } });
  assert.equal((await read(await handle(put))).status, 405);
});

test('snapshot passes the resolved actor to the RPC (never a browser-sent id)', async () => {
  const { handle, svc } = handlerFor({ actor: BARTENDER });
  const { status, json } = await read(await handle(get('snapshot', { date: '2026-11-03' })));
  assert.equal(status, 200);
  const call = svc.calls.rpc.find((c) => c.name === 'atlas_bookings_snapshot');
  assert.equal(call.args.p_actor_id, BARTENDER.userId);
  assert.equal(call.args.p_actor_role, 'bartender');
  assert.equal(call.args.p_date, '2026-11-03');
  assert.ok('reservations' in json);
});

test('config is manager-only at the gateway', async () => {
  const staff = handlerFor({ actor: BARTENDER });
  const denied = await read(await staff.handle(get('config')));
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error_code, 'forbidden');
  // A manager gets it, and the RPC was not even called for the staff attempt.
  assert.ok(!staff.svc.calls.rpc.some((c) => c.name === 'atlas_bookings_config'));
  const mgr = handlerFor({ actor: MANAGER });
  assert.equal((await read(await mgr.handle(get('config')))).status, 200);
});

test('save-area / save-table / save-settings are manager-only', async () => {
  for (const action of ['save-area', 'save-table', 'save-combination', 'save-settings']) {
    const staff = handlerFor({ actor: BARTENDER });
    const r = await read(await staff.handle(post(action, { name: 'x', label: 'Bar 1', seat_capacity: 2, member_table_ids: [TABLE, RES], combined_capacity: 4 })));
    assert.equal(r.status, 403, `${action} must be manager-only`);
  }
});

test('viewer can read Bookings but cannot mutate reservations', async () => {
  const { handle, svc } = handlerFor({ actor: VIEWER });
  assert.equal((await read(await handle(get('snapshot', { date: '2026-11-03' })))).status, 200);
  assert.equal((await read(await handle(get('availability', {
    from: '2026-11-03T18:00:00Z', to: '2026-11-03T20:00:00Z', party_size: '1'
  })))).status, 200);

  const mutations = [
    ['create', { party_size: 1, start_at: '2026-11-03T18:00:00Z' }],
    ['assign', { reservation_id: RES, table_ids: [TABLE] }],
    ['set-status', { reservation_id: RES, to_status: 'arrived' }],
    ['hold', { table_id: TABLE, start_at: '2026-11-03T18:00:00Z', end_at: '2026-11-03T20:00:00Z' }],
    ['release-hold', { hold_id: '88888888-8888-4888-8888-888888888888' }],
  ];
  for (const [action, body] of mutations) {
    const before = svc.calls.rpc.length;
    const result = await read(await handle(post(action, body)));
    assert.equal(result.status, 403, `${action} must reject viewer`);
    assert.equal(svc.calls.rpc.length, before, `${action} must not reach service-role RPC`);
  }
});

test('availability requires from/to and a party size, then passes them through', async () => {
  const { handle, svc } = handlerFor({ actor: BARTENDER });
  assert.equal((await read(await handle(get('availability', { from: '2026-11-03T18:00:00Z', to: '2026-11-03T20:00:00Z' })))).status, 400);
  const ok = await read(await handle(get('availability', { from: '2026-11-03T18:00:00Z', to: '2026-11-03T20:00:00Z', party_size: '4' })));
  assert.equal(ok.status, 200);
  const call = svc.calls.rpc.find((c) => c.name === 'atlas_bookings_availability');
  assert.equal(call.args.p_party_size, 4);
  assert.equal(call.args.p_from, '2026-11-03T18:00:00Z');
});

test('create requires a party size and a start time', async () => {
  const { handle, svc } = handlerFor({ actor: BARTENDER });
  assert.equal((await read(await handle(post('create', { party_size: 2 })))).status, 400, 'missing start_at');
  assert.equal((await read(await handle(post('create', { party_size: 0, start_at: '2026-11-03T18:00:00Z' })))).status, 400, 'bad party size');
  const ok = await read(await handle(post('create', { party_size: 2, start_at: '2026-11-03T18:00:00Z', guest_name: 'A', guest_phone: '555' })));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.reservation.status, 'confirmed');
  const call = svc.calls.rpc.find((c) => c.name === 'atlas_bookings_create');
  assert.equal(call.args.p_actor_id, BARTENDER.userId);
  assert.equal(call.args.p_payload.party_size, 2);
});

test('assign validates the reservation id and a non-empty table list', async () => {
  const { handle } = handlerFor({ actor: BARTENDER });
  assert.equal((await read(await handle(post('assign', { reservation_id: RES, table_ids: [] })))).status, 400, 'empty tables');
  assert.equal((await read(await handle(post('assign', { reservation_id: 'not-a-uuid', table_ids: [TABLE] })))).status, 400, 'bad reservation id');
  const ok = await read(await handle(post('assign', { reservation_id: RES, table_ids: [TABLE] })));
  assert.equal(ok.status, 200);
});

test('set-status requires a target status', async () => {
  const { handle, svc } = handlerFor({ actor: BARTENDER });
  assert.equal((await read(await handle(post('set-status', { reservation_id: RES })))).status, 400);
  const ok = await read(await handle(post('set-status', { reservation_id: RES, to_status: 'arrived', note: 'here' })));
  assert.equal(ok.status, 200);
  const call = svc.calls.rpc.find((c) => c.name === 'atlas_bookings_set_status');
  assert.equal(call.args.p_to_status, 'arrived');
  assert.equal(call.args.p_note, 'here');
});

test('a double-book conflict from the RPC surfaces as 409', async () => {
  const svc = fakeServices({ rpc: (name) => { if (name === 'atlas_bookings_create') throw mapRpcError(409, { code: '23505', hint: 'atlas:conflict' }); } });
  const { handle } = handlerFor({ actor: BARTENDER, services: svc });
  const r = await read(await handle(post('create', { party_size: 2, start_at: '2026-11-03T18:00:00Z', table_ids: [TABLE] })));
  assert.equal(r.status, 409);
  assert.equal(r.json.error_code, 'conflict');
});

test('mapRpcError maps hints and SQLSTATEs to redacted statuses', () => {
  assert.equal(mapRpcError(400, { hint: 'atlas:conflict' }).status, 409);
  assert.equal(mapRpcError(400, { hint: 'atlas:forbidden' }).status, 403);
  assert.equal(mapRpcError(400, { hint: 'atlas:not_found' }).status, 404);
  assert.equal(mapRpcError(500, { code: '42501' }).status, 403);
  assert.equal(mapRpcError(500, { code: 'P0002' }).status, 404);
  assert.equal(mapRpcError(500, { code: '23505' }).status, 409);
  assert.equal(mapRpcError(500, { code: '23P01' }).status, 409); // exclusion / overlap
  assert.equal(mapRpcError(500, { code: '22023' }).status, 400);
  // An unmapped error never leaks DB text.
  const generic = mapRpcError(500, { message: 'relation does not exist' });
  assert.equal(generic.status, 503);
  assert.equal(generic.message, MESSAGES.unavailable);
});

test('an inactive actor is refused before any RPC', async () => {
  const svc = fakeServices();
  const handle = createBookingsHandler({ env: () => undefined, fetchImpl: async () => { throw new Error('no network'); }, resolveActor: async () => ({ ...BARTENDER, active: false }), services: svc });
  const r = await read(await handle(get('snapshot')));
  assert.equal(r.status, 403);
  assert.equal(svc.calls.rpc.length, 0);
});
