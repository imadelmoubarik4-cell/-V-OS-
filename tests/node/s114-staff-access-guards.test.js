// S114 security regressions, unit level:
//  - _shared/staff-access.mjs: self-service account setup may activate only a
//    never-active invitation, never a removed, deactivated or demoted member,
//    and never changes the role or access of an active account;
//  - _shared/auth.mjs: the staff MFA rule (S96/S99) is enforced at the edge for
//    every active staff role, from the database policy, failing closed.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCESS_REVOKED_KEY,
  INTENDED_ROLE_KEY,
  INVITATION_MAX_AGE_DAYS,
  INVITED_BY_KEY,
  ONBOARDING_COMPLETED_KEY,
  activationRefusal,
  completionMetadata,
  onboardingDecision,
  pendingInvitationDecision,
  reinstatementMetadata,
  revocationMetadata,
} from '../../supabase/functions/_shared/staff-access.mjs';
import { AuthError, resetAuthPolicyCache, resolveActor } from '../../supabase/functions/_shared/auth.mjs';

// ---------------------------------------------------------------------------
// Account setup decisions
// ---------------------------------------------------------------------------

const INVITED = { [INVITED_BY_KEY]: 'manager-id', [INTENDED_ROLE_KEY]: 'bartender' };
const NEVER_ACTIVE = Object.freeze({
  audited: true, ever_active: false, removed: false, role_changed: false,
  inviter_active: true, inviter_role: 'admin', invitation_age_days: 1,
});
const pending = { role: 'viewer', active: false };

test('a genuine pending invitation is activated with the invited role', () => {
  assert.deepEqual(onboardingDecision({ profile: pending, appMetadata: INVITED, accessState: NEVER_ACTIVE }),
    { ok: true, mode: 'activate', role: 'bartender' });
  for (const role of ['admin', 'manager', 'bartender', 'viewer']) {
    assert.equal(onboardingDecision({ profile: pending, appMetadata: { ...INVITED, [INTENDED_ROLE_KEY]: role }, accessState: NEVER_ACTIVE }).role, role);
  }
  // An unknown or missing intended role falls back to the least privilege.
  for (const value of [undefined, null, 'owner', 'service_role', 'ADMIN', 42]) {
    assert.equal(onboardingDecision({ profile: pending, appMetadata: { ...INVITED, [INTENDED_ROLE_KEY]: value }, accessState: NEVER_ACTIVE }).role, 'viewer');
  }
  assert.deepEqual(pendingInvitationDecision({ profile: pending, appMetadata: INVITED, accessState: NEVER_ACTIVE }).mode, 'activate');
});

test('a removed or deactivated member can never re-activate through setup', () => {
  const removed = { role: 'bartender', active: false };
  const refused = onboardingDecision({ profile: removed, appMetadata: INVITED, accessState: { ...NEVER_ACTIVE, ever_active: true } });
  assert.deepEqual(refused, { ok: false, status: 403, code: 'access_revoked', message: refused.message });
  // The revocation marker refuses on its own, even when the history is unreadable.
  for (const accessState of [null, undefined, NEVER_ACTIVE, { ...NEVER_ACTIVE, audited: false }]) {
    const decision = onboardingDecision({ profile: removed, appMetadata: { ...INVITED, [ACCESS_REVOKED_KEY]: '2026-10-28T10:00:00Z' }, accessState });
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'access_revoked');
  }
  // …and an active account carrying it (a stale marker) is refused too: setup
  // never runs for it.
  assert.equal(onboardingDecision({ profile: { role: 'bartender', active: true }, appMetadata: { ...INVITED, [ACCESS_REVOKED_KEY]: 'x' } }).code, 'access_revoked');
  assert.equal(pendingInvitationDecision({ profile: removed, appMetadata: INVITED, accessState: { ...NEVER_ACTIVE, ever_active: true } }).ok, false);
});

test('a demoted, still active member keeps the demoted role: setup never restores the invited role', () => {
  const demoted = { role: 'viewer', active: true };
  const decision = onboardingDecision({ profile: demoted, appMetadata: { ...INVITED, [INTENDED_ROLE_KEY]: 'admin' } });
  assert.deepEqual(decision, { ok: true, mode: 'finish_active', role: 'viewer' });
  // The other self-service steps are only for an inactive pending invitation.
  assert.equal(pendingInvitationDecision({ profile: demoted, appMetadata: INVITED }).ok, false);
});

test('setup that finished once never runs again', () => {
  for (const profile of [pending, { role: 'bartender', active: true }]) {
    const decision = onboardingDecision({ profile, appMetadata: { ...INVITED, [ONBOARDING_COMPLETED_KEY]: '2026-10-01T00:00:00Z' }, accessState: NEVER_ACTIVE });
    assert.equal(decision.ok, false);
    assert.equal(decision.status, 409);
    assert.equal(decision.code, 'already_onboarded');
  }
});

test('an account that was not invited cannot use setup', () => {
  for (const appMetadata of [{}, null, undefined, [], 'x', { [INVITED_BY_KEY]: '' }, { [INVITED_BY_KEY]: null }, { [INTENDED_ROLE_KEY]: 'admin' }]) {
    const decision = onboardingDecision({ profile: pending, appMetadata, accessState: NEVER_ACTIVE });
    assert.equal(decision.ok, false, JSON.stringify(appMetadata));
    assert.equal(decision.code, 'not_invited');
  }
  // A profile with an unknown role or no profile at all is refused.
  for (const profile of [null, undefined, { role: 'owner', active: false }, 'x']) {
    assert.equal(onboardingDecision({ profile, appMetadata: INVITED, accessState: NEVER_ACTIVE }).ok, false);
  }
});

test('an unknown or unreadable history fails closed (a manager reviews it)', () => {
  for (const accessState of [null, undefined, {}, { ...NEVER_ACTIVE, audited: false }, { audited: true }, { ...NEVER_ACTIVE, audited: 'true' },
    { ...NEVER_ACTIVE, ever_active: 'false' }, { ...NEVER_ACTIVE, ever_active: null }, { ...NEVER_ACTIVE, removed: null },
    { ...NEVER_ACTIVE, role_changed: undefined }, { ...NEVER_ACTIVE, role_changed: 'false' }]) {
    const decision = onboardingDecision({ profile: pending, appMetadata: INVITED, accessState });
    assert.equal(decision.ok, false, JSON.stringify(accessState));
    assert.ok(['invitation_needs_review', 'access_revoked'].includes(decision.code));
  }
});

test('a removed invitation never activates, whatever else its history says', () => {
  const decision = onboardingDecision({ profile: pending, appMetadata: INVITED, accessState: { ...NEVER_ACTIVE, removed: true } });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'access_revoked');
  assert.equal(pendingInvitationDecision({ profile: pending, appMetadata: INVITED, accessState: { ...NEVER_ACTIVE, removed: true } }).ok, false);
});

test('a role a manager set on the pending profile wins over the invited role', () => {
  const changed = { ...NEVER_ACTIVE, role_changed: true };
  assert.deepEqual(onboardingDecision({ profile: { role: 'viewer', active: false }, appMetadata: { ...INVITED, [INTENDED_ROLE_KEY]: 'admin' }, accessState: changed }),
    { ok: true, mode: 'activate', role: 'viewer' });
  assert.equal(onboardingDecision({ profile: { role: 'manager', active: false }, appMetadata: INVITED, accessState: changed }).role, 'manager');
});

test('an invitation expires after the maximum age', () => {
  for (const days of [0, 1, INVITATION_MAX_AGE_DAYS]) {
    assert.equal(onboardingDecision({ profile: pending, appMetadata: INVITED, accessState: { ...NEVER_ACTIVE, invitation_age_days: days } }).ok, true, String(days));
  }
  for (const days of [INVITATION_MAX_AGE_DAYS + 1, 400, -1, null, undefined, '1', Number.NaN, Number.POSITIVE_INFINITY]) {
    const decision = onboardingDecision({ profile: pending, appMetadata: INVITED, accessState: { ...NEVER_ACTIVE, invitation_age_days: days } });
    assert.equal(decision.ok, false, String(days));
    assert.equal(decision.code, 'invitation_expired');
    assert.equal(decision.status, 409);
  }
});

test('an invitation from someone since removed or demoted does not activate on its own', () => {
  const refusedWith = (state, intended = 'bartender') => {
    const decision = onboardingDecision({ profile: pending, appMetadata: { ...INVITED, [INTENDED_ROLE_KEY]: intended }, accessState: { ...NEVER_ACTIVE, ...state } });
    assert.equal(decision.ok, false, JSON.stringify(state));
    assert.equal(decision.code, 'invitation_needs_review');
  };
  refusedWith({ inviter_active: false });
  refusedWith({ inviter_active: null, inviter_role: null });
  refusedWith({ inviter_role: 'bartender' });
  refusedWith({ inviter_role: 'viewer' });
  refusedWith({ inviter_role: 'owner' });
  // Only an administrator may (still) grant the administrator role.
  refusedWith({ inviter_role: 'manager' }, 'admin');
  assert.equal(onboardingDecision({ profile: pending, appMetadata: { ...INVITED, [INTENDED_ROLE_KEY]: 'manager' }, accessState: { ...NEVER_ACTIVE, inviter_role: 'manager' } }).role, 'manager');
  assert.equal(onboardingDecision({ profile: pending, appMetadata: { ...INVITED, [INTENDED_ROLE_KEY]: 'admin' }, accessState: NEVER_ACTIVE }).role, 'admin');
});

test('the locked activation step’s answers map to the same refusals', () => {
  assert.equal(activationRefusal('access_revoked').code, 'access_revoked');
  assert.equal(activationRefusal('already_active').code, 'already_onboarded');
  assert.equal(activationRefusal('already_onboarded').code, 'already_onboarded');
  assert.deepEqual([activationRefusal('role_changed').status, activationRefusal('role_changed').code], [409, 'setup_conflict']);
  for (const reason of ['invitation_needs_review', 'not_found', undefined, null, 'anything']) {
    const refusal = activationRefusal(reason);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.code, 'invitation_needs_review');
  }
});

test('marker patches: completion and removal clear the invited role; reinstatement clears the removal', () => {
  assert.deepEqual(completionMetadata('2026-10-31T00:00:00Z'), { [ONBOARDING_COMPLETED_KEY]: '2026-10-31T00:00:00Z', [INTENDED_ROLE_KEY]: null });
  assert.deepEqual(revocationMetadata('2026-10-31T00:00:00Z'), { [ACCESS_REVOKED_KEY]: '2026-10-31T00:00:00Z', [INTENDED_ROLE_KEY]: null });
  assert.deepEqual(reinstatementMetadata(), { [ACCESS_REVOKED_KEY]: null });
});

// ---------------------------------------------------------------------------
// Staff MFA at the edge (resolveActor)
// ---------------------------------------------------------------------------

const ENV = { ATLAS_AUTH_PROJECT_URL: 'https://auth.test', ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test' };
const USER_ID = '6b7f1c2e-4a1d-4c55-9f0e-2d3a4b5c6d7e';
const b64u = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (claims) => `${b64u({ alg: 'ES256', typ: 'JWT' })}.${b64u({ sub: USER_ID, role: 'authenticated', ...claims })}.sig`;
const request = (jwt) => new Request('https://fn.test/x', { headers: { authorization: `Bearer ${jwt}` } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const VERIFIED = [{ id: 'f1', factor_type: 'totp', status: 'verified' }];
const POLICY_URL = 'https://auth.test/rest/v1/rpc/atlas_auth_policy';

function backend({ role = 'bartender', active = true, factors, policy = { require_privileged_mfa: false, require_all_staff_mfa: false }, policyStatus = 200, policyThrows = false, appMetadata } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://auth.test/auth/v1/user') return json({ id: USER_ID, ...(factors ? { factors } : {}), ...(appMetadata ? { app_metadata: appMetadata } : {}) });
    if (String(url) === POLICY_URL) {
      if (policyThrows) throw new TypeError('network down');
      return json(policyStatus === 200 ? { ...policy, must_enroll: false } : { message: 'x' }, policyStatus);
    }
    return json([{ id: USER_ID, email: 'p@example.test', display_name: 'P', role, active }]);
  };
  return { calls, fetchImpl, policyCalls: () => calls.filter((call) => call.url === POLICY_URL) };
}
const refusedMfa = (promise) => assert.rejects(promise, (error) => error instanceof AuthError && error.status === 403 && error.code === 'mfa_required');

test.beforeEach(() => resetAuthPolicyCache());

test('every staff role with an authenticator must use it: aal1 refused, aal2 accepted', async () => {
  for (const role of ['admin', 'manager', 'bartender', 'viewer']) {
    resetAuthPolicyCache();
    const { fetchImpl } = backend({ role, factors: VERIFIED });
    await refusedMfa(resolveActor(request(token({ aal: 'aal1' })), ENV, fetchImpl));
    const actor = await resolveActor(request(token({ aal: 'aal2' })), ENV, fetchImpl);
    assert.equal(actor.role, role);
    assert.equal(actor.aal, 'aal2');
  }
});

test('an unverified (abandoned) enrolment does not lock anyone out', async () => {
  const { fetchImpl } = backend({ role: 'bartender', factors: [{ id: 'f', status: 'unverified' }] });
  assert.equal((await resolveActor(request(token({ aal: 'aal1' })), ENV, fetchImpl)).role, 'bartender');
});

test('require_all_staff_mfa: every active staff role needs aal2, enrolled or not', async () => {
  for (const role of ['admin', 'manager', 'bartender', 'viewer']) {
    resetAuthPolicyCache();
    const { fetchImpl } = backend({ role, policy: { require_privileged_mfa: false, require_all_staff_mfa: true } });
    await refusedMfa(resolveActor(request(token({ aal: 'aal1' })), ENV, fetchImpl));
  }
  // aal2 is never refused and never needs the policy read.
  const { fetchImpl, policyCalls } = backend({ role: 'viewer', factors: VERIFIED, policy: { require_privileged_mfa: true, require_all_staff_mfa: true } });
  assert.equal((await resolveActor(request(token({ aal: 'aal2' })), ENV, fetchImpl)).role, 'viewer');
  assert.equal(policyCalls().length, 0);
});

test('require_privileged_mfa: admins and managers need aal2; bartenders and viewers do not', async () => {
  const policy = { require_privileged_mfa: true, require_all_staff_mfa: false };
  for (const role of ['admin', 'manager']) {
    resetAuthPolicyCache();
    await refusedMfa(resolveActor(request(token({ aal: 'aal1' })), ENV, backend({ role, policy }).fetchImpl));
  }
  for (const role of ['bartender', 'viewer']) {
    resetAuthPolicyCache();
    assert.equal((await resolveActor(request(token({ aal: 'aal1' })), ENV, backend({ role, policy }).fetchImpl)).role, role);
  }
});

test('flags off and no authenticator: password-only staff keep working (today’s production)', async () => {
  for (const role of ['admin', 'manager', 'bartender', 'viewer']) {
    resetAuthPolicyCache();
    assert.equal((await resolveActor(request(token({ aal: 'aal1' })), ENV, backend({ role }).fetchImpl)).role, role);
  }
});

test('the policy is read with the caller’s own token, once per short window', async () => {
  const { fetchImpl, policyCalls } = backend({ role: 'bartender' });
  const jwt = token({ aal: 'aal1' });
  await resolveActor(request(jwt), ENV, fetchImpl);
  await resolveActor(request(jwt), ENV, fetchImpl);
  assert.equal(policyCalls().length, 1, 'cached');
  const [call] = policyCalls();
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.authorization, `Bearer ${jwt}`);
  assert.equal(call.init.headers.apikey, 'sb_publishable_test');
  resetAuthPolicyCache();
  await resolveActor(request(jwt), ENV, fetchImpl);
  assert.equal(policyCalls().length, 2, 'read again after the window');
});

test('an unreachable, missing or malformed policy fails closed (503) and is never cached', async () => {
  const unavailable = (promise) => assert.rejects(promise, (error) => error instanceof AuthError && error.status === 503);
  await unavailable(resolveActor(request(token({ aal: 'aal1' })), ENV, backend({ policyThrows: true }).fetchImpl));
  resetAuthPolicyCache();
  await unavailable(resolveActor(request(token({ aal: 'aal1' })), ENV, backend({ policyStatus: 500 }).fetchImpl));
  // A missing policy function is not "no flags": the rule is never skipped.
  const missing = backend({ policyStatus: 404 });
  await unavailable(resolveActor(request(token({ aal: 'aal1' })), ENV, missing.fetchImpl));
  await unavailable(resolveActor(request(token({ aal: 'aal1' })), ENV, missing.fetchImpl));
  assert.equal(missing.policyCalls().length, 2, 'a failure is not cached');
  // A session the policy RPC rejects is an expired session.
  await assert.rejects(resolveActor(request(token({ aal: 'aal1' })), ENV, backend({ policyStatus: 401 }).fetchImpl),
    (error) => error instanceof AuthError && error.status === 401);
  for (const policy of [{}, { require_all_staff_mfa: 'true', require_privileged_mfa: false }, { require_all_staff_mfa: null, require_privileged_mfa: null }]) {
    resetAuthPolicyCache();
    await unavailable(resolveActor(request(token({ aal: 'aal1' })), ENV, backend({ policy }).fetchImpl));
  }
});

test('the deployment override still applies to managers without any policy read', async () => {
  const env = { ...ENV, ATLAS_REQUIRE_PRIVILEGED_MFA: 'true' };
  const { fetchImpl, policyCalls } = backend({ role: 'manager' });
  await refusedMfa(resolveActor(request(token({ aal: 'aal1' })), env, fetchImpl));
  assert.equal(policyCalls().length, 0);
  assert.equal((await resolveActor(request(token({ aal: 'aal1' })), env, backend({ role: 'bartender' }).fetchImpl)).role, 'bartender');
});

test('an inactive caller is refused outright; only an explicit setup action may resolve one, MFA-exempt', async () => {
  const { fetchImpl } = backend({ role: 'viewer', active: false, factors: VERIFIED, policy: { require_privileged_mfa: true, require_all_staff_mfa: true } });
  await assert.rejects(resolveActor(request(token({ aal: 'aal1' })), ENV, fetchImpl), (error) => error.status === 403 && error.code !== 'mfa_required');
  const invitee = await resolveActor(request(token({ aal: 'aal1' })), ENV, fetchImpl, { allowInactive: true });
  assert.equal(invitee.active, false);
});

test('app_metadata comes from Auth, never from the token’s own claims', async () => {
  const forgedClaims = token({ aal: 'aal1', app_metadata: { atlas_invited_by: 'me', atlas_intended_role: 'admin' } });
  const fromAuth = await resolveActor(request(forgedClaims), ENV, backend({ appMetadata: { provider: 'email' } }).fetchImpl);
  assert.deepEqual(fromAuth.appMetadata, { provider: 'email' });
  resetAuthPolicyCache();
  const none = await resolveActor(request(forgedClaims), ENV, backend().fetchImpl);
  assert.deepEqual(none.appMetadata, {});
});
