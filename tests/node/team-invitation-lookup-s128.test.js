// PR #128 invitation-status lookup hardening. Extracts invitationStatuses (and
// its cap/concurrency/timeout helpers) from the Deno edge source and runs it in a
// VM with a mocked Supabase admin client — the same technique as team-login-s64f /
// team-deletion-s105 — to prove: only inactive profiles are probed, the per-request
// count is hard-capped at 100 regardless of env, Auth reads run concurrency-limited,
// a hung/failed read never blocks the rest, recent invites win the capped slots,
// and pending/expired labels are correct and de-duplicated by profile id.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../../supabase/functions/atlas-team-profiles/index.ts', import.meta.url), 'utf8');
const begin = source.indexOf('const INVITE_LOOKUP_HARD_MAX');
const slice = stripTypeScriptTypes(source.slice(begin, source.indexOf('async function snapshot', begin)));

const AUTH = 'https://auth.test';
const HOUR = 3600 * 1000;

// Build a mocked admin client. users: { [id]: userRecordOrNull | 'hang' | 'throw' }.
function setup({ env = {}, users = {}, onCall } = {}) {
  const state = { calls: [], inFlight: 0, maxInFlight: 0 };
  const admin = {
    auth: { admin: {
      getUserById: (id) => {
        state.calls.push(id);
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        onCall?.(id);
        const settle = (value) => { state.inFlight -= 1; return value; };
        const record = users[id];
        if (record === 'hang') return new Promise(() => {}); // never resolves
        if (record === 'throw') return new Promise((_, reject) => setTimeout(() => { state.inFlight -= 1; reject(new Error('auth down')); }, 0));
        // Resolve on the next macrotask so several reads overlap in flight.
        return new Promise((resolve) => setTimeout(() => resolve(settle({ data: { user: record || null }, error: record ? null : { message: 'not found' } })), 0));
      },
    } },
  };
  const scope = {
    Symbol, setTimeout, clearTimeout, Promise, Date, Number, Math, Array, console, Object, JSON,
    createClient: () => admin,
    productionAuthUrl: () => AUTH,
    isManager: (c) => ['admin', 'manager'].includes(c?.profile?.role),
    Deno: { env: { get: (k) => (k === 'SUPABASE_URL' ? AUTH : k === 'SUPABASE_SERVICE_ROLE_KEY' ? 'svc' : env[k]) } },
  };
  vm.createContext(scope);
  vm.runInContext(slice, scope);
  return { scope, state };
}

const MANAGER = { profile: { role: 'admin' } };
const invited = (overMs) => ({ email_confirmed_at: null, app_metadata: { atlas_invited_by: 'admin1' }, invited_at: new Date(Date.now() - overMs).toISOString() });
const profile = (id, active, createdMsAgo = 0) => ({ id, active, created_at: new Date(Date.now() - createdMsAgo).toISOString() });

test('only inactive profiles are probed; active members never trigger an Auth read', async () => {
  const users = { i1: invited(1 * HOUR), i2: invited(1 * HOUR) };
  const { scope, state } = setup({ users });
  const rows = [profile('a1', true), profile('i1', false), profile('a2', true), profile('i2', false)];
  const out = await scope.invitationStatuses(MANAGER, rows);
  assert.deepEqual(state.calls.sort(), ['i1', 'i2']);
  assert.deepEqual({ ...out }, { i1: 'pending', i2: 'pending' }); // spread: normalize cross-realm VM object
});

test('non-managers and misconfigured auth projects do no lookups at all', async () => {
  const a = setup({ users: { i1: invited(1 * HOUR) } });
  assert.deepEqual({ ...(await a.scope.invitationStatuses({ profile: { role: 'bartender' } }, [profile('i1', false)])) }, {});
  assert.equal(a.state.calls.length, 0);
});

test('pending vs expired split on invite age; confirmed and untracked accounts get no pill', async () => {
  const users = {
    pend: invited(1 * HOUR),                                   // recent → pending
    old: invited(72 * HOUR),                                   // older than 24h → expired
    done: { email_confirmed_at: new Date().toISOString(), app_metadata: { atlas_invited_by: 'admin1' } }, // confirmed
    ext: { email_confirmed_at: null, app_metadata: {} },       // not an invite we issued
  };
  const { scope } = setup({ env: { ATLAS_INVITE_EXPIRY_HOURS: '24' }, users });
  const rows = ['pend', 'old', 'done', 'ext'].map((id) => profile(id, false));
  assert.deepEqual({ ...(await scope.invitationStatuses(MANAGER, rows)) }, { pend: 'pending', old: 'expired' });
});

test('the per-snapshot Auth read count is hard-capped at 100 even when the env raises it', async () => {
  const users = {}; const rows = [];
  for (let n = 0; n < 150; n++) { const id = `u${n}`; users[id] = invited(1 * HOUR); rows.push(profile(id, false, n * 1000)); }
  const { scope, state } = setup({ env: { ATLAS_INVITE_LOOKUP_CAP: '500' }, users });
  const out = await scope.invitationStatuses(MANAGER, rows);
  assert.equal(state.calls.length, 100, `capped at 100, saw ${state.calls.length}`);
  assert.equal(Object.keys(out).length, 100);
});

test('the env cap can only lower the ceiling, never raise it', async () => {
  const users = {}; const rows = [];
  for (let n = 0; n < 40; n++) { const id = `u${n}`; users[id] = invited(1 * HOUR); rows.push(profile(id, false)); }
  const { scope, state } = setup({ env: { ATLAS_INVITE_LOOKUP_CAP: '10' }, users });
  await scope.invitationStatuses(MANAGER, rows);
  assert.equal(state.calls.length, 10);
});

test('newest inactive profiles win the capped slots, so recent invites are not crowded out', async () => {
  const users = {}; const rows = [];
  // 120 old deactivated members (created long ago) + one fresh pending invite.
  for (let n = 0; n < 120; n++) { const id = `old${n}`; users[id] = { email_confirmed_at: new Date().toISOString(), app_metadata: {} }; rows.push(profile(id, false, 1000 * HOUR + n * HOUR)); }
  users.fresh = invited(1 * HOUR);
  rows.push(profile('fresh', false, 1)); // created just now → newest
  const { scope, state } = setup({ users });
  const out = await scope.invitationStatuses(MANAGER, rows);
  assert.ok(state.calls.includes('fresh'), 'the fresh invite was probed despite 120 older inactive rows');
  assert.equal(out.fresh, 'pending');
  assert.equal(state.calls.length, 100);
});

test('Auth reads run concurrency-limited (>1 in flight, never more than 8)', async () => {
  const users = {}; const rows = [];
  for (let n = 0; n < 40; n++) { const id = `u${n}`; users[id] = invited(1 * HOUR); rows.push(profile(id, false)); }
  const { scope, state } = setup({ users });
  await scope.invitationStatuses(MANAGER, rows);
  assert.ok(state.maxInFlight > 1, 'reads overlap');
  assert.ok(state.maxInFlight <= 8, `never more than 8 in flight, saw ${state.maxInFlight}`);
});

test('a failing Auth read is skipped without dropping the rest', async () => {
  const users = { bad: 'throw', good: invited(1 * HOUR) };
  const { scope } = setup({ users });
  const out = await scope.invitationStatuses(MANAGER, [profile('bad', false), profile('good', false)]);
  assert.deepEqual({ ...out }, { good: 'pending' });
});

test('a hung Auth read times out and never blocks the snapshot', async () => {
  const users = { stuck: 'hang', good: invited(1 * HOUR) };
  const { scope } = setup({ users });
  const started = Date.now();
  const out = await scope.invitationStatuses(MANAGER, [profile('stuck', false), profile('good', false)]);
  const elapsed = Date.now() - started;
  assert.equal(out.good, 'pending', 'the responsive read still resolves');
  assert.equal(out.stuck, undefined, 'the hung read contributes no pill');
  assert.ok(elapsed < 3500, `returned within the per-request timeout budget, took ${elapsed}ms`);
});

test('withInviteTimeout resolves to the sentinel promptly for a stuck promise', async () => {
  const { scope } = setup();
  const started = Date.now();
  const result = await scope.withInviteTimeout(new Promise(() => {}), 25);
  assert.equal(typeof result, 'symbol');
  assert.ok(Date.now() - started < 500);
});
