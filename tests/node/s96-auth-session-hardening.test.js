// S96: caller authentication hardening in supabase/functions/_shared/auth.mjs.
// - privileged roles (admin, manager) with a verified second factor must
//   present an aal2 session; ATLAS_REQUIRE_PRIVILEGED_MFA=true makes aal2
//   mandatory for every privileged caller; staff roles are unaffected
// - Auth outages (5xx/429) read as 503, never as an expired session
// - requireRecentAuth: step-up for high-risk actions from the amr timestamps
import test from 'node:test';
import assert from 'node:assert/strict';

import { AuthError, requireRecentAuth, resolveActor, verifiedTokenClaims } from '../../supabase/functions/_shared/auth.mjs';

const ENV = { ATLAS_AUTH_PROJECT_URL: 'https://auth.test', ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test' };
const USER_ID = '6b7f1c2e-4a1d-4c55-9f0e-2d3a4b5c6d7e';
const b64u = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
// Unsigned test tokens: resolveActor trusts claims only after the (faked) Auth
// server accepted the token, exactly as production relies on /auth/v1/user.
const token = (claims) => `${b64u({ alg: 'ES256', typ: 'JWT' })}.${b64u({ sub: USER_ID, role: 'authenticated', ...claims })}.sig`;
const request = (jwt) => new Request('https://fn.test/x', { headers: { authorization: `Bearer ${jwt}` } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

function fetchFor({ role = 'admin', factors, userStatus = 200 } = {}) {
  return async (url) => {
    if (String(url) === 'https://auth.test/auth/v1/user') {
      return json(userStatus === 200 ? { id: USER_ID, ...(factors ? { factors } : {}) } : { msg: 'x' }, userStatus);
    }
    return json([{ id: USER_ID, email: 'a@example.test', display_name: 'Anna', role, active: true }]);
  };
}
const rejectsWith = (promise, status, code) => assert.rejects(promise, (error) => error instanceof AuthError
  && error.status === status && (code === undefined || error.code === code));

test('verified claims are decoded; garbage decodes to an empty object', () => {
  assert.equal(verifiedTokenClaims(token({ aal: 'aal2' })).aal, 'aal2');
  assert.deepEqual(verifiedTokenClaims('not-a-jwt'), {});
});

test('an admin with a verified factor on an aal1 session is refused (mfa_required)', async () => {
  const fetchImpl = fetchFor({ role: 'admin', factors: [{ id: 'f', status: 'verified', factor_type: 'totp' }] });
  await rejectsWith(resolveActor(request(token({ aal: 'aal1' })), ENV, fetchImpl), 403, 'mfa_required');
  const actor = await resolveActor(request(token({ aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }] })), ENV, fetchImpl);
  assert.equal(actor.aal, 'aal2');
  assert.equal(actor.mfaEnrolled, true);
});

test('an unverified (abandoned) enrolment does not lock a manager out', async () => {
  const fetchImpl = fetchFor({ role: 'manager', factors: [{ id: 'f', status: 'unverified' }] });
  const actor = await resolveActor(request(token({ aal: 'aal1' })), ENV, fetchImpl);
  assert.equal(actor.role, 'manager');
});

test('mandatory mode refuses every aal1 privileged caller but never staff', async () => {
  const env = { ...ENV, ATLAS_REQUIRE_PRIVILEGED_MFA: 'true' };
  await rejectsWith(resolveActor(request(token({ aal: 'aal1' })), env, fetchFor({ role: 'manager' })), 403, 'mfa_required');
  const staff = await resolveActor(request(token({ aal: 'aal1' })), env, fetchFor({ role: 'bartender' }));
  assert.equal(staff.role, 'bartender');
});

test('Auth 5xx and 429 are 503 (unavailable), 401/403 stay 401', async () => {
  await rejectsWith(resolveActor(request(token({})), ENV, fetchFor({ userStatus: 502 })), 503);
  await rejectsWith(resolveActor(request(token({})), ENV, fetchFor({ userStatus: 429 })), 503);
  await rejectsWith(resolveActor(request(token({})), ENV, fetchFor({ userStatus: 403 })), 401);
  await rejectsWith(resolveActor(request(token({})), ENV, fetchFor({ userStatus: 401 })), 401);
});

test('requireRecentAuth accepts a fresh password/TOTP step and refuses a stale one', () => {
  const now = 2_000_000_000_000;
  const fresh = { amr: [{ method: 'password', timestamp: now / 1000 - 60 }] };
  const stale = { amr: [{ method: 'password', timestamp: now / 1000 - 7200 }] };
  const steppedUp = { amr: [{ method: 'totp', timestamp: now / 1000 - 30 }, { method: 'password', timestamp: now / 1000 - 7200 }] };
  assert.equal(requireRecentAuth(fresh, 900, now), fresh);
  assert.equal(requireRecentAuth(steppedUp, 900, now), steppedUp);
  assert.throws(() => requireRecentAuth(stale, 900, now), (error) => error.status === 401 && error.code === 'reauthentication_required');
  assert.throws(() => requireRecentAuth({ amr: [] }, 900, now), (error) => error.code === 'reauthentication_required');
});

// C7 negative regressions: the gateway never authorizes from token claims.
test('forged or unverifiable tokens never reach the profile lookup', async () => {
  for (const status of [401, 403]) {
    let profileCalls = 0;
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/auth/v1/user')) return json({ msg: 'invalid JWT' }, status);
      profileCalls += 1;
      return json([{ id: USER_ID, role: 'admin', active: true }]);
    };
    // alg none, claims of an admin/service role, app_metadata role: Auth refuses -> 401, no profile read.
    const forged = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ sub: USER_ID, role: 'service_role', app_metadata: { role: 'admin' } })}.`;
    await rejectsWith(resolveActor(request(forged), ENV, fetchImpl), 401);
    assert.equal(profileCalls, 0);
  }
});

test('role comes from the protected profile row, never from JWT or metadata claims', async () => {
  const jwt = token({ role: 'service_role', app_metadata: { role: 'admin' }, user_metadata: { role: 'admin', staff_role: 'admin' } });
  const actor = await resolveActor(request(jwt), ENV, fetchFor({ role: 'bartender' }));
  assert.equal(actor.role, 'bartender');
});

test('the user id is the one Auth verified, not the token sub; a mismatching profile is refused', async () => {
  const other = '11111111-2222-4333-8444-555555555555';
  const jwt = `${b64u({ alg: 'ES256' })}.${b64u({ sub: other, role: 'authenticated' })}.sig`;
  let profileQuery = null;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/auth/v1/user')) return json({ id: USER_ID });
    profileQuery = new URL(String(url)).searchParams.get('id');
    return json([{ id: other, role: 'admin', active: true }]);
  };
  await rejectsWith(resolveActor(request(jwt), ENV, fetchImpl), 403);
  assert.equal(profileQuery, `eq.${USER_ID}`);
});

test('the anon/publishable key or a secret key as bearer is refused (Auth has no user for it)', async () => {
  for (const bearer of ['sb_publishable_test', 'sb_secret_example', `${b64u({ alg: 'HS256' })}.${b64u({ role: 'anon', iss: 'supabase' })}.sig`]) {
    const fetchImpl = async (url) => (String(url).endsWith('/auth/v1/user')
      ? json({ code: 403, msg: 'invalid claim: missing sub claim' }, 403)
      : json([{ id: USER_ID, role: 'admin', active: true }]));
    await rejectsWith(resolveActor(request(bearer), ENV, fetchImpl), 401);
  }
});

test('team-profiles: role/active changes, invitations and account setup pass the step-up gate', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../../supabase/functions/atlas-team-profiles/index.ts', import.meta.url), 'utf8');
  for (const name of ['updateProfileAccess', 'inviteAccount', 'createLoginMember', 'renewMemberSetup']) {
    const start = source.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, name);
    const head = source.slice(start, start + 200);
    assert.match(head, /requireManager\(context\);\s*requireStepUp\(context\);/, `${name} requires step-up`);
  }
});
