// S96 MFA + step-up: high-impact actions need a recent second factor from anyone
// who has one (or from every manager/admin in mandatory mode). A fresh password,
// an email link, a stale factor or a future-dated claim never satisfies it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { MFA_METHODS, requireRecentAuth, requireStepUp } from '../../supabase/functions/_shared/auth.mjs';

const NOW = 2_000_000_000_000;
const at = (secondsAgo) => NOW / 1000 - secondsAgo;
const env = (values) => ({ get: (name) => values[name] });
const ON = env({ ATLAS_REQUIRE_STEP_UP: 'true' });
const ON_MANDATORY = env({ ATLAS_REQUIRE_STEP_UP: 'true', ATLAS_REQUIRE_PRIVILEGED_MFA: 'true' });

const refused = (code) => (error) => error.status === 401 && error.code === code;

test('enrolled user: a fresh password does not satisfy step-up; a fresh TOTP does', () => {
  const passwordOnly = { mfaEnrolled: true, aal: 'aal1', amr: [{ method: 'password', timestamp: at(30) }] };
  assert.throws(() => requireRecentAuth(passwordOnly, 900, NOW), refused('mfa_reauthentication_required'));
  const totp = { mfaEnrolled: true, aal: 'aal2', amr: [{ method: 'password', timestamp: at(3000) }, { method: 'totp', timestamp: at(60) }] };
  assert.equal(requireRecentAuth(totp, 900, NOW), totp);
});

test('aal2 session with a stale factor check is refused', () => {
  const stale = { mfaEnrolled: true, aal: 'aal2', amr: [{ method: 'totp', timestamp: at(7200) }, { method: 'password', timestamp: at(10) }] };
  assert.throws(() => requireRecentAuth(stale, 900, NOW), refused('mfa_reauthentication_required'));
});

test('email-link methods never count as re-authentication', () => {
  for (const method of ['recovery', 'invite', 'magiclink', 'email/signup', 'anonymous']) {
    assert.throws(() => requireRecentAuth({ amr: [{ method, timestamp: at(5) }] }, 900, NOW), refused('reauthentication_required'), method);
    assert.throws(() => requireRecentAuth({ mfaEnrolled: true, amr: [{ method, timestamp: at(5) }] }, 900, NOW), refused('mfa_reauthentication_required'), method);
  }
});

test('future-dated or malformed amr timestamps are ignored', () => {
  const future = { mfaEnrolled: true, amr: [{ method: 'totp', timestamp: at(-86400) }] };
  assert.throws(() => requireRecentAuth(future, 900, NOW), refused('mfa_reauthentication_required'));
  const junk = { mfaEnrolled: true, amr: [{ method: 'totp', timestamp: 'now' }, { method: 'totp' }, null] };
  assert.throws(() => requireRecentAuth(junk, 900, NOW), refused('mfa_reauthentication_required'));
});

test('requireStepUp: off unless configured; mandatory mode demands MFA from unenrolled managers', () => {
  const manager = { role: 'manager', mfaEnrolled: false, aal: 'aal1', amr: [{ method: 'password', timestamp: at(30) }] };
  assert.equal(requireStepUp(manager, env({}), NOW), manager, 'disabled by default (rollout switch)');
  assert.equal(requireStepUp(manager, ON, NOW), manager, 'unenrolled manager passes with a fresh password while MFA is optional');
  assert.throws(() => requireStepUp(manager, ON_MANDATORY, NOW), refused('mfa_reauthentication_required'));
  const bartender = { role: 'bartender', amr: [{ method: 'password', timestamp: at(30) }] };
  assert.equal(requireStepUp(bartender, ON_MANDATORY, NOW), bartender);
});

test('requireStepUp caps the configured window at one hour', () => {
  const actor = { role: 'admin', mfaEnrolled: true, amr: [{ method: 'totp', timestamp: at(5000) }] };
  const wide = env({ ATLAS_REQUIRE_STEP_UP: 'true', ATLAS_STEP_UP_MAX_AGE_SECONDS: '86400' });
  assert.throws(() => requireStepUp(actor, wide, NOW), refused('mfa_reauthentication_required'));
});

test('only real second-factor methods are MFA methods', () => {
  assert.ok(MFA_METHODS.includes('totp'));
  for (const method of ['password', 'otp', 'recovery', 'invite', 'magiclink']) assert.ok(!MFA_METHODS.includes(method), method);
});

// Integrations: credential/connection changes pass through the step-up hook
// before any backend call; read actions do not.
import { createIntegrationsHandler, STEP_UP_ACTIONS } from '../../supabase/functions/atlas-integrations/handler.mjs';
import { readFileSync } from 'node:fs';

test('integrations: start/disconnect/save-api-key/select-resource are refused without step-up, before any RPC', async () => {
  const rpcCalls = [];
  const handle = createIntegrationsHandler({
    env: () => undefined,
    fetchImpl: async () => new Response('{}'),
    rpc: async (name) => { rpcCalls.push(name); return {}; },
    authenticate: async () => ({ user: { id: '6b7f1c2e-4a1d-4c55-9f0e-2d3a4b5c6d7e' }, profile: { role: 'admin', active: true } }),
    stepUp: async () => {
      const { ApiError } = await import('../../supabase/functions/atlas-integrations/handler.mjs');
      throw new ApiError(401, 'Confirm it is you.', { error_code: 'mfa_reauthentication_required' });
    },
  });
  for (const action of ['start', 'disconnect', 'save-api-key', 'select-resource']) {
    assert.ok(STEP_UP_ACTIONS.has(action));
    const response = await handle(new Request(`https://abc123.supabase.co/atlas-integrations?action=${action}`, {
      method: 'POST', headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'google' }),
    }));
    assert.equal(response.status, 401, action);
    assert.equal((await response.json()).error_code, 'mfa_reauthentication_required', action);
  }
  assert.deepEqual(rpcCalls, [], 'nothing reached the database');
});

test('step-up is wired into the deployed entry points for integrations, settings role changes and team access', () => {
  const integrations = readFileSync(new URL('../../supabase/functions/atlas-integrations/index.ts', import.meta.url), 'utf8');
  assert.match(integrations, /requireStepUp\(context\.assurance \?\? \{\}, Deno\.env\)/);
  const settings = readFileSync(new URL('../../supabase/functions/atlas-settings/index.ts', import.meta.url), 'utf8');
  assert.match(settings, /case "save-role": \{\s+requireManager\(context\);\s+\/\/ S96 step-up[^\n]*\n\s+requireStepUp\(context\.assurance, Deno\.env\);/);
  const team = readFileSync(new URL('../../supabase/functions/atlas-team-profiles/index.ts', import.meta.url), 'utf8');
  // S99 added the reset-member-mfa manager action, also step-up gated.
  assert.equal((team.match(/requireStepUp\(context\);/g) || []).length, 5, 'role change, create login, renew setup, invite, reset MFA');
});
