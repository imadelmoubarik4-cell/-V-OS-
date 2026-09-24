// S88: the shared Edge Function caller check (supabase/functions/_shared/auth.mjs).
// Same /auth/v1/user + own-profile pattern as every Atlas gateway, fail closed.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATLAS_ROLES,
  AuthError,
  MANAGER_ROLES,
  WRITE_ROLES,
  authConfig,
  bearerToken,
  isManager,
  requireRole,
  resolveActor,
} from '../../supabase/functions/_shared/auth.mjs';

const ENV = { ATLAS_AUTH_PROJECT_URL: 'https://auth.test/', ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test' };
const USER_ID = '6b7f1c2e-4a1d-4c55-9f0e-2d3a4b5c6d7e';
const request = (authorization = 'Bearer user-jwt') => new Request('https://fn.test/atlas-ai', {
  headers: authorization ? { authorization } : {},
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

function auth({ user = { id: USER_ID, email: 'Staff@Example.test' }, userStatus = 200, profile, profileStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    if (String(url) === 'https://auth.test/auth/v1/user') return json(user, userStatus);
    if (String(url).startsWith('https://auth.test/rest/v1/profiles?')) {
      return json(profile === undefined ? [{ id: USER_ID, email: 'staff@example.test', display_name: ' Anna ', role: 'bartender', active: true }] : profile, profileStatus);
    }
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
}

async function rejects(promise, status) {
  await assert.rejects(promise, (error) => error instanceof AuthError && error.status === status);
}

test('role names are the public.staff_role values', () => {
  assert.deepEqual([...ATLAS_ROLES], ['admin', 'manager', 'bartender', 'viewer']);
  assert.deepEqual([...MANAGER_ROLES], ['admin', 'manager']);
  assert.deepEqual([...WRITE_ROLES], ['admin', 'manager', 'bartender']);
});

test('resolveActor verifies the session, then reads the caller’s own profile with the caller’s token', async () => {
  const { calls, fetchImpl } = auth();
  const actor = await resolveActor(request(), ENV, fetchImpl);
  assert.deepEqual(actor, {
    userId: USER_ID,
    email: 'staff@example.test',
    role: 'bartender',
    active: true,
    displayName: 'Anna',
    label: 'Anna',
    token: 'user-jwt',
  });
  assert.equal(calls.length, 2);
  const profileUrl = new URL(calls[1].url);
  assert.equal(profileUrl.searchParams.get('id'), `eq.${USER_ID}`);
  assert.equal(profileUrl.searchParams.get('select'), 'id,email,display_name,role,active');
  for (const call of calls) {
    assert.equal(call.headers.authorization, 'Bearer user-jwt');
    assert.equal(call.headers.apikey, 'sb_publishable_test');
  }
});

test('Deno-style env objects and the managed publishable key are supported', async () => {
  const env = { get: (name) => ({ SUPABASE_URL: 'https://auth.test', SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_managed"}' })[name] };
  assert.deepEqual(authConfig(env), { projectUrl: 'https://auth.test', publishableKey: 'sb_publishable_managed' });
  const { calls, fetchImpl } = auth();
  await resolveActor(request(), env, fetchImpl);
  assert.equal(calls[0].headers.apikey, 'sb_publishable_managed');
});

test('missing configuration or a missing bearer token fails closed before any request', async () => {
  const { calls, fetchImpl } = auth();
  await rejects(resolveActor(request(), {}, fetchImpl), 500);
  await rejects(resolveActor(request(), { ATLAS_AUTH_PROJECT_URL: 'http://auth.test', ATLAS_AUTH_PUBLISHABLE_KEY: 'k' }, fetchImpl), 500);
  await rejects(resolveActor(request(null), ENV, fetchImpl), 401);
  await rejects(resolveActor(request('Basic abc'), ENV, fetchImpl), 401);
  assert.equal(calls.length, 0);
  assert.equal(bearerToken({ headers: { authorization: 'bearer abc.def' } }), 'abc.def');
});

test('expired sessions, unknown users and unreadable profiles are rejected', async () => {
  await rejects(resolveActor(request(), ENV, auth({ userStatus: 401 }).fetchImpl), 401);
  await rejects(resolveActor(request(), ENV, auth({ user: {} }).fetchImpl), 401);
  await rejects(resolveActor(request(), ENV, auth({ profileStatus: 500 }).fetchImpl), 403);
  await rejects(resolveActor(request(), ENV, auth({ profile: [] }).fetchImpl), 403);
  await rejects(resolveActor(request(), ENV, auth({ profile: [{ id: 'someone-else', role: 'admin', active: true }] }).fetchImpl), 403);
  await rejects(resolveActor(request(), ENV, async () => { throw new Error('network'); }), 503);
});

test('inactive profiles and unknown roles are rejected', async () => {
  await rejects(resolveActor(request(), ENV, auth({ profile: [{ id: USER_ID, role: 'manager', active: false }] }).fetchImpl), 403);
  await rejects(resolveActor(request(), ENV, auth({ profile: [{ id: USER_ID, role: 'manager', active: 'true' }] }).fetchImpl), 403);
  await rejects(resolveActor(request(), ENV, auth({ profile: [{ id: USER_ID, role: 'owner', active: true }] }).fetchImpl), 403);
  const inactive = await resolveActor(request(), ENV, auth({ profile: [{ id: USER_ID, role: 'viewer', active: false }] }).fetchImpl, { allowInactive: true });
  assert.equal(inactive.active, false);
  assert.throws(() => requireRole(inactive, ATLAS_ROLES), AuthError, 'an inactive actor holds no role');
});

test('requireRole and isManager gate on the verified role', () => {
  const actor = (role) => ({ userId: USER_ID, role, active: true });
  assert.equal(requireRole(actor('manager'), MANAGER_ROLES).role, 'manager');
  assert.equal(requireRole(actor('bartender'), new Set(WRITE_ROLES)).role, 'bartender');
  for (const role of ['bartender', 'viewer']) {
    assert.throws(() => requireRole(actor(role), MANAGER_ROLES), (error) => error instanceof AuthError && error.status === 403);
    assert.equal(isManager(actor(role)), false);
  }
  assert.equal(isManager(actor('admin')), true);
  assert.throws(() => requireRole(null, ATLAS_ROLES), AuthError);
});
