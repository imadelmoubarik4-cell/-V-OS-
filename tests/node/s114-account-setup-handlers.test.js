// S114 security regressions, behavioural: the real atlas-team-profiles and
// atlas-team-profile-photos handlers run in Node against a scripted Auth /
// PostgREST backend and a fake service-role admin client. They prove that:
//  - a genuine pending invitation finishes setup and is activated with its
//    invited role, once, conditionally on still being inactive;
//  - a removed / deactivated member cannot re-activate through complete-
//    onboarding, cannot save "setup" details and cannot upload a setup photo;
//  - a demoted, still active member keeps the demoted role;
//  - setup that finished once, an account that was never invited and an
//    invitation without a recorded history are refused (fail closed);
//  - an expired invitation, or one from an inviter since removed or demoted,
//    is refused; a role chosen for a pending invitation holds;
//  - every removal path marks the account so setup can never restore it, a
//    manager restoring access clears that mark, and a removal the database did
//    not apply is refused instead of reported as done;
//  - a staff member with an authenticator cannot use an Atlas gateway with a
//    password-only session (the S114 edge MFA rule, end to end).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEdgeFunction } from './helpers/edge-function-harness.js';
import { fakeSupabaseWorld } from './helpers/fake-supabase-admin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SUPABASE = path.join(HERE, 'helpers/fake-supabase-admin.mjs');
const AUTH = 'https://auth.test';
const ENV = {
  ATLAS_AUTH_PROJECT_URL: AUTH,
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_URL: AUTH,
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};

const IDS = {
  admin: '11111111-1111-4111-8111-111111111111',
  pending: '22222222-2222-4222-8222-222222222222',
  removed: '33333333-3333-4333-8333-333333333333',
  demoted: '44444444-4444-4444-8444-444444444444',
  member: '55555555-5555-4555-8555-555555555555',
  manager: '66666666-6666-4666-8666-666666666666',
};
const VERIFIED = [{ id: 'f1', factor_type: 'totp', status: 'verified' }];
const INVITED = (role) => ({ atlas_invited_by: IDS.admin, atlas_intended_role: role });
// atlas_team_profile_access_state for a fresh invitation from an active administrator.
const FRESH = Object.freeze({
  audited: true, ever_active: false, removed: false, role_changed: false,
  inviter_active: true, inviter_role: 'admin', invitation_age_days: 1,
});
const WAS_ACTIVE = Object.freeze({ ...FRESH, ever_active: true });

const b64u = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenFor = (id, aal = 'aal2') => `${b64u({ alg: 'ES256', typ: 'JWT' })}.${b64u({ sub: id, role: 'authenticated', aal, amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] })}.sig`;
const subOf = (authorization) => {
  try { return JSON.parse(Buffer.from(String(authorization).replace(/^Bearer /, '').split('.')[1], 'base64url').toString()).sub; } catch { return null; }
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

// One scripted world: profiles, Auth users (app_metadata, factors) and the
// audited access history; every request and admin call is recorded. As in the
// database, only an administrator's profile update matches a row (RLS).
function world({ users, accessState = {}, accessStateStatus = 200, markersFail = false, beforeActivation = null }) {
  const state = {
    profiles: Object.fromEntries(Object.entries(users).map(([id, user]) => [id, { id, email: `${id.slice(0, 4)}@example.test`, display_name: user.name ?? null, role: user.role, active: user.active }])),
    auth: Object.fromEntries(Object.entries(users).map(([id, user]) => [id, { id, email: `${id.slice(0, 4)}@example.test`, app_metadata: { ...(user.appMetadata ?? {}) }, user_metadata: { full_name: user.name ?? 'New Person' }, factors: user.factors ?? [] }])),
    requests: [],
    rpcs: [],
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init.method || 'GET').toUpperCase();
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null;
    state.requests.push({ method, path: url.pathname, search: url.search, body });
    if (url.pathname === '/auth/v1/user') {
      const user = state.auth[subOf(init.headers?.authorization)];
      return user ? json({ id: user.id, email: user.email, app_metadata: user.app_metadata, factors: user.factors }) : json({ msg: 'bad jwt' }, 401);
    }
    if (url.pathname === '/rest/v1/profiles') {
      const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
      if (method === 'PATCH') {
        if (state.profiles[subOf(init.headers?.authorization)]?.role !== 'admin') return json([]);
        Object.assign(state.profiles[id], body);
        return json([state.profiles[id]]);
      }
      return json(id ? (state.profiles[id] ? [state.profiles[id]] : []) : Object.values(state.profiles));
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.slice('/rest/v1/rpc/'.length);
      state.rpcs.push({ name, body });
      if (name === 'atlas_auth_policy') return json({ require_privileged_mfa: false, require_all_staff_mfa: false, must_enroll: false });
      if (name === 'atlas_team_profile_access_state') {
        return accessStateStatus === 200 ? json(accessState[body.p_profile_id] ?? { audited: false, ever_active: false }) : json({ message: 'down' }, accessStateStatus);
      }
      if (name === 'atlas_team_profile_onboarding_ready') return json({ has_phone: true, has_photo: true });
      if (name === 'atlas_team_profile_activate_invitation') {
        // The locked database step (S114 migration), as the SQL test proves it.
        if (beforeActivation) await beforeActivation(state);
        const id = body.p_profile_id;
        const profile = state.profiles[id];
        const meta = state.auth[id]?.app_metadata ?? {};
        if (!profile) return json({ activated: false, reason: 'not_found' });
        if (profile.active) return json({ activated: false, reason: 'already_active' });
        if (meta.atlas_access_revoked_at) return json({ activated: false, reason: 'access_revoked' });
        if (meta.atlas_onboarding_completed_at) return json({ activated: false, reason: 'already_onboarded' });
        const history = accessState[id] ?? { audited: false, ever_active: false };
        if (history.ever_active || history.removed) return json({ activated: false, reason: 'access_revoked' });
        if (history.audited !== true) return json({ activated: false, reason: 'invitation_needs_review' });
        const expected = history.role_changed ? profile.role
          : ['admin', 'manager', 'bartender', 'viewer'].includes(meta.atlas_intended_role) ? meta.atlas_intended_role : 'viewer';
        if (body.p_role !== expected) return json({ activated: false, reason: 'role_changed' });
        Object.assign(profile, { display_name: body.p_display_name, role: expected, active: true });
        return json({ activated: true, role: expected });
      }
      if (name === 'atlas_team_member_remove_from_team') return json({ archived: true });
      return json({});
    }
    if (url.pathname === '/auth/v1/invite') {
      const id = '77777777-7777-4777-8777-777777777777';
      state.profiles[id] = { id, email: body.email, display_name: null, role: 'viewer', active: false };
      state.auth[id] = { id, email: body.email, app_metadata: {}, user_metadata: {}, factors: [] };
      return json({ id });
    }
    if (url.pathname.startsWith('/storage/v1/')) {
      state.requests.push({ method, path: url.pathname, storage: true });
      return json({ Key: 'ok' });
    }
    return json([]);
  };
  const admin = fakeSupabaseWorld({
    getUserById: async (id) => (state.auth[id] ? { data: { user: structuredClone(state.auth[id]) }, error: null } : { data: { user: null }, error: { message: 'not found' } }),
    updateUserById: async (id, attributes) => {
      if (markersFail) return { data: { user: null }, error: { message: 'Auth is unavailable' } };
      for (const [key, value] of Object.entries(attributes.app_metadata ?? {})) {
        if (value === null) delete state.auth[id].app_metadata[key];
        else state.auth[id].app_metadata[key] = value;
      }
      return { data: { user: { id } }, error: null };
    },
    query: async (request) => {
      if (request.table === 'profiles' && request.op === 'select') {
        const [, , pattern] = request.filters.find(([kind]) => kind === 'ilike') ?? [];
        return { data: Object.values(state.profiles).filter((row) => row.email === pattern).map(({ id, active }) => ({ id, active })), error: null };
      }
      if (request.table !== 'profiles' || request.op !== 'update') return { data: null, error: null };
      const filters = Object.fromEntries(request.filters.map(([, column, value]) => [column, value]));
      const row = state.profiles[filters.id];
      if (!row || ('active' in filters && row.active !== filters.active)) return { data: null, error: null };
      Object.assign(row, request.values);
      return { data: { ...row }, error: null };
    },
  });
  return { state, fetchImpl, admin };
}

async function loadTeamProfiles() {
  return loadEdgeFunction('supabase/functions/atlas-team-profiles/index.ts', ENV, { replaceImports: { 'npm:@supabase/supabase-js@2.45.4': FAKE_SUPABASE } });
}

async function post(handler, scripted, action, callerId, body = {}, aal = 'aal2') {
  globalThis.__fakeSupabase = scripted.admin;
  try {
    const response = await handler(new Request(`https://fn.test/atlas-team-profiles?action=${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(callerId, aal)}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), scripted.fetchImpl);
    return { status: response.status, body: await response.json() };
  } finally {
    delete globalThis.__fakeSupabase;
  }
}

const patches = (scripted, id) => scripted.state.requests.filter((request) => request.method === 'PATCH' && request.path === '/rest/v1/profiles' && request.search.includes(id));
const activations = (scripted) => scripted.state.rpcs.filter((call) => call.name === 'atlas_team_profile_activate_invitation');
const profileUpdates = (scripted) => scripted.admin.calls.filter(([kind, request]) => kind === 'query' && request?.op === 'update');
const markerWrites = (scripted, id) => scripted.admin.calls.filter(([kind, target]) => kind === 'updateUserById' && target === id).map(([, , attributes]) => attributes.app_metadata);

// ---------------------------------------------------------------------------
// complete-onboarding
// ---------------------------------------------------------------------------

test('a genuine pending invitation finishes setup once, activated with the invited role', async () => {
  const handler = await loadTeamProfiles();
  const scripted = world({
    users: { [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('bartender'), factors: VERIFIED, name: 'Nina New' } },
    accessState: { [IDS.pending]: FRESH },
  });
  const done = await post(handler, scripted, 'complete-onboarding', IDS.pending);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.result, { completed: true, role: 'bartender' });
  assert.deepEqual({ role: scripted.state.profiles[IDS.pending].role, active: scripted.state.profiles[IDS.pending].active }, { role: 'bartender', active: true });
  assert.deepEqual(activations(scripted).map((call) => call.body), [{ p_profile_id: IDS.pending, p_role: 'bartender', p_display_name: 'Nina New' }], 'one locked activation');
  assert.equal(profileUpdates(scripted).length, 0, 'never a direct profile write');
  const markers = scripted.state.auth[IDS.pending].app_metadata;
  assert.ok(markers.atlas_onboarding_completed_at, 'completion marked');
  assert.equal(markers.atlas_intended_role, undefined, 'the invited role is cleared');

  // A second run (a replay, or after a later removal) is refused.
  const again = await post(handler, scripted, 'complete-onboarding', IDS.pending);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'already_onboarded');
});

test('a removed member cannot re-activate through complete-onboarding', async () => {
  const handler = await loadTeamProfiles();
  const scripted = world({
    users: { [IDS.removed]: { role: 'bartender', active: false, appMetadata: INVITED('bartender'), factors: VERIFIED, name: 'Rob Removed' } },
    accessState: { [IDS.removed]: WAS_ACTIVE },
  });
  const refused = await post(handler, scripted, 'complete-onboarding', IDS.removed);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'access_revoked');
  assert.equal(scripted.state.profiles[IDS.removed].active, false, 'still inactive');
  assert.equal(profileUpdates(scripted).length + activations(scripted).length, 0, 'no profile write');
  assert.deepEqual(markerWrites(scripted, IDS.removed), [], 'no marker write');
  assert.ok(!scripted.state.rpcs.some((call) => call.name === 'atlas_shifts_sync_profiles'));
});

test('a removal marker refuses even when the access history cannot be read', async () => {
  const handler = await loadTeamProfiles();
  const scripted = world({
    users: { [IDS.removed]: { role: 'bartender', active: false, appMetadata: { ...INVITED('bartender'), atlas_access_revoked_at: '2026-10-28T10:00:00Z' }, factors: VERIFIED } },
    accessStateStatus: 500,
  });
  const refused = await post(handler, scripted, 'complete-onboarding', IDS.removed);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'access_revoked');
  assert.equal(profileUpdates(scripted).length, 0);
});

test('an unreadable history fails closed: no activation, a manager reviews it', async () => {
  const handler = await loadTeamProfiles();
  for (const options of [{ accessStateStatus: 500 }, { accessState: { [IDS.pending]: { ...FRESH, audited: false } } }]) {
    const scripted = world({ users: { [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('manager'), factors: VERIFIED } }, ...options });
    const refused = await post(handler, scripted, 'complete-onboarding', IDS.pending);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'invitation_needs_review');
    assert.equal(scripted.state.profiles[IDS.pending].active, false);
    assert.equal(profileUpdates(scripted).length, 0);
  }
});

test('a demoted, still active member cannot win back the invited role', async () => {
  const handler = await loadTeamProfiles();
  const scripted = world({ users: { [IDS.demoted]: { role: 'viewer', active: true, appMetadata: INVITED('admin'), factors: VERIFIED, name: 'Dana Demoted' } } });
  const done = await post(handler, scripted, 'complete-onboarding', IDS.demoted);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.result.role, 'viewer');
  assert.equal(scripted.state.profiles[IDS.demoted].role, 'viewer');
  for (const [, update] of profileUpdates(scripted)) {
    assert.deepEqual(Object.keys(update.values), ['display_name'], 'never role or active');
  }
  assert.equal(scripted.state.auth[IDS.demoted].app_metadata.atlas_intended_role, undefined, 'the stale invited role is cleared');
  assert.equal(scripted.state.profiles[IDS.demoted].display_name, 'Dana Demoted', 'a recorded name is kept');
});

test('an already-active account records its name only when none is on record', async () => {
  const handler = await loadTeamProfiles();
  const named = world({ users: { [IDS.member]: { role: 'bartender', active: true, appMetadata: INVITED('bartender'), factors: VERIFIED, name: 'Bea Bartender' } } });
  named.state.auth[IDS.member].user_metadata.full_name = 'Someone Else';
  assert.equal((await post(handler, named, 'complete-onboarding', IDS.member)).status, 200);
  assert.equal(named.state.profiles[IDS.member].display_name, 'Bea Bartender', 'a name cannot be swapped for another');
  assert.equal(profileUpdates(named).length, 0);
  const unnamed = world({ users: { [IDS.member]: { role: 'bartender', active: true, appMetadata: INVITED('bartender'), factors: VERIFIED } } });
  assert.equal((await post(handler, unnamed, 'complete-onboarding', IDS.member)).status, 200);
  assert.equal(unnamed.state.profiles[IDS.member].display_name, 'New Person');
  assert.equal(unnamed.state.profiles[IDS.member].role, 'bartender');
});

test('an account that was never invited, or a password-only session, cannot finish setup', async () => {
  const handler = await loadTeamProfiles();
  const notInvited = world({ users: { [IDS.member]: { role: 'viewer', active: false, factors: VERIFIED } }, accessState: { [IDS.member]: FRESH } });
  const refused = await post(handler, notInvited, 'complete-onboarding', IDS.member);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'not_invited');
  assert.equal(profileUpdates(notInvited).length, 0);

  const aal1 = world({ users: { [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('bartender'), factors: VERIFIED } }, accessState: { [IDS.pending]: FRESH } });
  const password = await post(handler, aal1, 'complete-onboarding', IDS.pending, {}, 'aal1');
  assert.equal(password.status, 403);
  assert.equal(password.body.code, 'mfa_required');
  assert.equal(profileUpdates(aal1).length, 0);
});

test('races: whatever changes during setup wins over the earlier decision', async () => {
  const handler = await loadTeamProfiles();
  const invitee = () => ({ [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('manager'), factors: VERIFIED, name: 'Pat Pending' } });
  // Activated by a parallel request: refused, not applied twice.
  const parallel = world({ users: invitee(), accessState: { [IDS.pending]: FRESH }, beforeActivation: (state) => { state.profiles[IDS.pending].active = true; } });
  const twice = await post(handler, parallel, 'complete-onboarding', IDS.pending);
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, 'already_onboarded');
  // Removed by an administrator while setup was finishing: stays inactive.
  const removed = world({ users: invitee(), accessState: { [IDS.pending]: FRESH }, beforeActivation: (state) => { state.auth[IDS.pending].app_metadata.atlas_access_revoked_at = '2026-10-31T10:00:00Z'; } });
  const refused = await post(handler, removed, 'complete-onboarding', IDS.pending);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'access_revoked');
  assert.equal(removed.state.profiles[IDS.pending].active, false);
  // A new role chosen meanwhile: refused; the retry gets the new role.
  const rerolled = world({ users: invitee(), accessState: { [IDS.pending]: FRESH }, beforeActivation: (state) => { state.auth[IDS.pending].app_metadata.atlas_intended_role = 'viewer'; } });
  const conflict = await post(handler, rerolled, 'complete-onboarding', IDS.pending);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'setup_conflict');
  assert.equal(rerolled.state.profiles[IDS.pending].active, false);
  const retry = await post(handler, world({ users: { [IDS.pending]: { ...invitee()[IDS.pending], appMetadata: INVITED('viewer') } }, accessState: { [IDS.pending]: FRESH } }), 'complete-onboarding', IDS.pending);
  assert.deepEqual(retry.body.result, { completed: true, role: 'viewer' });
  // The database step failing is a refusal, never an activation.
  const down = world({ users: invitee(), accessState: { [IDS.pending]: FRESH }, beforeActivation: () => { throw new Error('connection reset'); } });
  const unavailable = await post(handler, down, 'complete-onboarding', IDS.pending).catch(() => ({ status: 503 }));
  assert.ok(unavailable.status >= 500);
  assert.equal(down.state.profiles[IDS.pending].active, false);
});

test('an expired invitation, or one from someone since removed or demoted, needs a manager', async () => {
  const handler = await loadTeamProfiles();
  const cases = [
    [{ ...FRESH, invitation_age_days: 15 }, 'invitation_expired'],
    [{ ...FRESH, inviter_active: false }, 'invitation_needs_review'],
    [{ ...FRESH, inviter_role: 'bartender' }, 'invitation_needs_review'],
    [{ ...FRESH, removed: true }, 'access_revoked'],
  ];
  for (const [accessState, code] of cases) {
    const scripted = world({ users: { [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('bartender'), factors: VERIFIED } }, accessState: { [IDS.pending]: accessState } });
    const refused = await post(handler, scripted, 'complete-onboarding', IDS.pending);
    assert.equal(refused.body.code, code, JSON.stringify(accessState));
    assert.equal(scripted.state.profiles[IDS.pending].active, false);
    assert.equal(profileUpdates(scripted).length, 0);
  }
});

// ---------------------------------------------------------------------------
// save-details and photo upload while inactive
// ---------------------------------------------------------------------------

test('save-details: a removed member is refused; a pending invitation may save their own details', async () => {
  const handler = await loadTeamProfiles();
  const scripted = world({
    users: {
      [IDS.removed]: { role: 'bartender', active: false, appMetadata: INVITED('bartender') },
      [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('bartender') },
    },
    accessState: { [IDS.removed]: WAS_ACTIVE, [IDS.pending]: FRESH },
  });
  const details = (id) => ({ profile_id: id, preferred_name: 'Name', phone: '+354 555 0000', phone_visibility: 'managers_only' });
  const refused = await post(handler, scripted, 'save-details', IDS.removed, details(IDS.removed), 'aal1');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'access_revoked');
  assert.ok(!scripted.state.rpcs.some((call) => call.name === 'atlas_team_profile_upsert_details'));
  const saved = await post(handler, scripted, 'save-details', IDS.pending, details(IDS.pending), 'aal1');
  assert.notEqual(saved.status, 403, JSON.stringify(saved.body));
  assert.ok(scripted.state.rpcs.some((call) => call.name === 'atlas_team_profile_upsert_details' && call.body.p_profile_id === IDS.pending));
});

test('photo upload: a removed member is refused before anything is stored', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-team-profile-photos/index.ts', ENV);
  const scripted = world({
    users: {
      [IDS.removed]: { role: 'bartender', active: false, appMetadata: INVITED('bartender') },
      [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('bartender') },
    },
    accessState: { [IDS.removed]: WAS_ACTIVE, [IDS.pending]: FRESH },
  });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(0)]);
  const upload = (id) => {
    const form = new FormData();
    form.set('profile_id', id);
    form.set('file', new File([png], 'me.png', { type: 'image/png' }));
    return handler(new Request('https://fn.test/atlas-team-profile-photos?action=upload', { method: 'POST', headers: { authorization: `Bearer ${tokenFor(id, 'aal1')}` }, body: form }), scripted.fetchImpl);
  };
  const refused = await upload(IDS.removed);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'access_revoked', 'the wizard can show the right message');
  assert.ok(!scripted.state.requests.some((request) => request.storage), 'nothing reached Storage');
  const before = scripted.state.rpcs.filter((call) => call.name === 'atlas_team_profile_access_state').length;
  const allowed = await upload(IDS.pending);
  assert.notEqual(allowed.status, 403, await allowed.text());
  assert.equal(scripted.state.rpcs.filter((call) => call.name === 'atlas_team_profile_access_state').length, before + 1, 'the history was checked');
});

// ---------------------------------------------------------------------------
// Removal paths mark the account; restoring access clears the mark
// ---------------------------------------------------------------------------

test('remove-from-team and update-access mark the account; restoring access clears the mark', async () => {
  const handler = await loadTeamProfiles();
  const scripted = world({
    users: {
      [IDS.admin]: { role: 'admin', active: true, factors: VERIFIED, name: 'Ada Admin' },
      [IDS.removed]: { role: 'bartender', active: true, appMetadata: INVITED('bartender') },
      [IDS.member]: { role: 'bartender', active: true, appMetadata: INVITED('bartender') },
      [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('bartender') },
    },
  });
  const removed = await post(handler, scripted, 'remove-from-team', IDS.admin, { profile_id: IDS.removed });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(scripted.state.profiles[IDS.removed].active, false);
  assert.ok(scripted.state.auth[IDS.removed].app_metadata.atlas_access_revoked_at, 'remove-from-team marks the account');

  const deactivated = await post(handler, scripted, 'update-access', IDS.admin, { profile_id: IDS.member, role: 'bartender', active: false });
  assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
  assert.ok(scripted.state.auth[IDS.member].app_metadata.atlas_access_revoked_at, 'deactivation marks the account');

  const restored = await post(handler, scripted, 'update-access', IDS.admin, { profile_id: IDS.member, role: 'bartender', active: true });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(scripted.state.auth[IDS.member].app_metadata.atlas_access_revoked_at, undefined, 'a manager restoring access clears the mark');

  // Removing a still-pending invitation cancels it for good.
  const cancelled = await post(handler, scripted, 'remove-from-team', IDS.admin, { profile_id: IDS.pending });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.ok(scripted.state.auth[IDS.pending].app_metadata.atlas_access_revoked_at);

  // A role chosen for a still-pending invitation becomes the role it gets.
  const second = world({ users: { [IDS.admin]: { role: 'admin', active: true, factors: VERIFIED }, [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('manager') } } });
  const rechosen = await post(handler, second, 'update-access', IDS.admin, { profile_id: IDS.pending, role: 'bartender', active: false });
  assert.equal(rechosen.status, 200, JSON.stringify(rechosen.body));
  assert.equal(second.state.auth[IDS.pending].app_metadata.atlas_intended_role, 'bartender');
});

test('a role an administrator sets on a pending invitation holds, even when the profile already shows it', async () => {
  const handler = await loadTeamProfiles();
  const scripted = world({
    users: {
      [IDS.admin]: { role: 'admin', active: true, factors: VERIFIED },
      [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('manager'), factors: VERIFIED, name: 'Pat Pending' },
    },
    accessState: { [IDS.pending]: FRESH },
  });
  // The pending profile shows "viewer" already, so the update changes no column.
  const downgraded = await post(handler, scripted, 'update-access', IDS.admin, { profile_id: IDS.pending, role: 'viewer', active: false });
  assert.equal(downgraded.status, 200, JSON.stringify(downgraded.body));
  assert.equal(scripted.state.auth[IDS.pending].app_metadata.atlas_intended_role, 'viewer');
  const done = await post(handler, scripted, 'complete-onboarding', IDS.pending);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(scripted.state.profiles[IDS.pending].role, 'viewer', 'not the originally invited manager role');

  // If the choice cannot be recorded, nothing changes.
  const down = world({
    users: { [IDS.admin]: { role: 'admin', active: true, factors: VERIFIED }, [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('manager') } },
    markersFail: true,
  });
  const failed = await post(handler, down, 'update-access', IDS.admin, { profile_id: IDS.pending, role: 'bartender', active: false });
  assert.equal(failed.status, 503);
  assert.equal(patches(down, IDS.pending).length, 0, 'no profile change');
  assert.equal(down.state.auth[IDS.pending].app_metadata.atlas_intended_role, 'manager');
});

test('removing access never waits on Auth: the deactivation stands when the marker cannot be written', async () => {
  const handler = await loadTeamProfiles();
  const scripted = world({
    users: { [IDS.admin]: { role: 'admin', active: true, factors: VERIFIED }, [IDS.member]: { role: 'bartender', active: true, appMetadata: INVITED('bartender') } },
    markersFail: true,
  });
  const removed = await post(handler, scripted, 'remove-from-team', IDS.admin, { profile_id: IDS.member });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(scripted.state.profiles[IDS.member].active, false);
});

test('a manager cannot leave a "removed" member active: the removal is refused truthfully', async () => {
  const handler = await loadTeamProfiles();
  const scripted = world({
    users: {
      [IDS.admin]: { role: 'admin', active: true, factors: VERIFIED },
      [IDS.manager]: { role: 'manager', active: true, factors: VERIFIED, name: 'Mo Manager' },
      [IDS.member]: { role: 'bartender', active: true, appMetadata: INVITED('bartender') },
      [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('bartender') },
    },
  });
  // The database lets only administrators change another profile's access.
  const refused = await post(handler, scripted, 'remove-from-team', IDS.manager, { profile_id: IDS.member });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(scripted.state.profiles[IDS.member].active, true);
  assert.ok(!scripted.state.rpcs.some((call) => call.name === 'atlas_team_member_remove_from_team'), 'no removal recorded');
  assert.deepEqual(markerWrites(scripted, IDS.member), []);

  // A pending invitation is already inactive: a manager may still cancel it.
  const cancelled = await post(handler, scripted, 'remove-from-team', IDS.manager, { profile_id: IDS.pending });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.ok(scripted.state.auth[IDS.pending].app_metadata.atlas_access_revoked_at);
  assert.ok(scripted.state.rpcs.some((call) => call.name === 'atlas_team_member_remove_from_team' && call.body.p_profile_id === IDS.pending));
});

test('only an administrator may change a pending invitation, and nothing changes when a manager tries', async () => {
  const handler = await loadTeamProfiles();
  const scripted = world({
    users: {
      [IDS.manager]: { role: 'manager', active: true, factors: VERIFIED, name: 'Mo Manager' },
      [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('admin') },
    },
  });
  const refused = await post(handler, scripted, 'update-access', IDS.manager, { profile_id: IDS.pending, role: 'viewer', active: false });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(scripted.state.auth[IDS.pending].app_metadata.atlas_intended_role, 'admin', 'the invitation is untouched');
  assert.deepEqual(markerWrites(scripted, IDS.pending), []);
  assert.equal(patches(scripted, IDS.pending).length, 0);
});

test('remove-from-team marks the account before deactivating it', async () => {
  const handler = await loadTeamProfiles();
  const scripted = world({ users: { [IDS.admin]: { role: 'admin', active: true, factors: VERIFIED }, [IDS.member]: { role: 'bartender', active: true } } });
  let markedBeforePatch = null;
  const fetchImpl = scripted.fetchImpl;
  scripted.fetchImpl = async (input, init = {}) => {
    if ((init.method || '').toUpperCase() === 'PATCH' && markedBeforePatch === null) {
      markedBeforePatch = Boolean(scripted.state.auth[IDS.member].app_metadata.atlas_access_revoked_at);
    }
    return fetchImpl(input, init);
  };
  const removed = await post(handler, scripted, 'remove-from-team', IDS.admin, { profile_id: IDS.member });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(markedBeforePatch, true, 'a setup finishing meanwhile already sees the removal');
  assert.equal(scripted.state.profiles[IDS.member].active, false);
});

test('invitations: a removed or already-accepted person is not re-invited; a lost invitation marker is reported', async () => {
  const handler = await loadTeamProfiles();
  const removedEmail = `${IDS.removed.slice(0, 4)}@example.test`;
  const pendingEmail = `${IDS.pending.slice(0, 4)}@example.test`;
  const scripted = world({
    users: {
      [IDS.admin]: { role: 'admin', active: true, factors: VERIFIED, name: 'Ada Admin' },
      [IDS.removed]: { role: 'bartender', active: false, appMetadata: { ...INVITED('bartender'), atlas_access_revoked_at: '2026-10-28T10:00:00Z' } },
      [IDS.pending]: { role: 'viewer', active: false, appMetadata: INVITED('bartender') },
    },
    accessState: { [IDS.removed]: WAS_ACTIVE, [IDS.pending]: FRESH },
  });
  const invites = () => scripted.state.requests.filter((request) => request.path === '/auth/v1/invite').length;
  const again = await post(handler, scripted, 'invite-account', IDS.admin, { email: removedEmail, role: 'bartender' });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.match(again.body.error, /access was removed/);
  assert.equal(invites(), 0, 'nothing was sent');

  scripted.state.auth[IDS.pending].email_confirmed_at = '2026-10-20T10:00:00Z';
  const accepted = await post(handler, scripted, 'invite-account', IDS.admin, { email: pendingEmail, role: 'bartender' });
  assert.equal(accepted.status, 409, JSON.stringify(accepted.body));
  assert.equal(invites(), 0);

  const fresh = await post(handler, scripted, 'invite-account', IDS.admin, { email: 'new.person@example.test', role: 'bartender' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  const invitedId = '77777777-7777-4777-8777-777777777777';
  assert.deepEqual(scripted.state.auth[invitedId].app_metadata, { atlas_intended_role: 'bartender', atlas_invited_by: IDS.admin });

  const lost = world({ users: { [IDS.admin]: { role: 'admin', active: true, factors: VERIFIED, name: 'Ada Admin' } }, markersFail: true });
  const untracked = await post(handler, lost, 'invite-account', IDS.admin, { email: 'other.person@example.test', role: 'bartender' });
  assert.equal(untracked.status, 503, 'the manager is told, not shown a success');
});

// ---------------------------------------------------------------------------
// Edge MFA, end to end through a real gateway
// ---------------------------------------------------------------------------

test('a bartender with an authenticator cannot use a gateway with a password-only session', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-team-profile-photos/index.ts', ENV);
  const scripted = world({ users: { [IDS.member]: { role: 'bartender', active: true, factors: VERIFIED } } });
  const call = (aal) => handler(new Request('https://fn.test/atlas-team-profile-photos?action=snapshot', { headers: { authorization: `Bearer ${tokenFor(IDS.member, aal)}` } }), scripted.fetchImpl);
  const refused = await call('aal1');
  assert.equal(refused.status, 403);
  const allowed = await call('aal2');
  assert.notEqual(allowed.status, 403);
});
