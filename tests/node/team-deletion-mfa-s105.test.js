// S105 permanent-deletion MFA gate (server-side). Extracts the real
// requireFreshMfaForDeletion from the edge source and runs it with the REAL
// requireRecentAuth from the shared auth module, so the enforcement is genuinely
// exercised: admin must have an enrolled verified factor, an aal2 session, and a
// RECENT second-factor check — a fresh password alone never satisfies it, and
// ATLAS_REQUIRE_STEP_UP being unset does not relax it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { requireRecentAuth, AuthError } from '../../supabase/functions/_shared/auth.mjs';

const source = fs.readFileSync(new URL('../../supabase/functions/atlas-team-profiles/index.ts', import.meta.url), 'utf8');
const begin = source.indexOf('function requireFreshMfaForDeletion');
const slice = stripTypeScriptTypes(source.slice(begin, source.indexOf('function requireManager', begin)));

function load() {
  const scope = {
    requireRecentAuth,
    AuthError,
    ApiError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
    // No ATLAS_REQUIRE_STEP_UP set — the gate must still enforce MFA regardless.
    Deno: { env: { get: () => undefined } },
  };
  vm.createContext(scope);
  vm.runInContext(slice, scope);
  return scope;
}

const now = Date.now();
const freshTotp = { amr: [{ method: 'totp', timestamp: Math.floor(now / 1000) - 30 }], aal: 'aal2', mfaEnrolled: true };

test('no enrolled factor → enrollment required (code mfa_enrollment_required)', () => {
  const { requireFreshMfaForDeletion } = load();
  assert.throws(() => requireFreshMfaForDeletion({ amr: [], aal: 'aal1', mfaEnrolled: false }), (e) => {
    assert.equal(e.status, 403); assert.equal(e.code, 'mfa_enrollment_required'); return true;
  });
});

test('enrolled but only an aal1 session → must confirm with authenticator (mfa_required)', () => {
  const { requireFreshMfaForDeletion } = load();
  assert.throws(() => requireFreshMfaForDeletion({ amr: [{ method: 'password', timestamp: Math.floor(now / 1000) }], aal: 'aal1', mfaEnrolled: true }), (e) => {
    assert.equal(e.status, 403); assert.equal(e.code, 'mfa_required'); return true;
  });
});

test('aal2 but the second-factor check is stale → re-authentication required', () => {
  const { requireFreshMfaForDeletion } = load();
  const stale = { amr: [{ method: 'totp', timestamp: Math.floor(now / 1000) - 4000 }], aal: 'aal2', mfaEnrolled: true };
  assert.throws(() => requireFreshMfaForDeletion(stale), (e) => {
    assert.equal(e.code, 'mfa_reauthentication_required'); return true;
  });
});

test('aal2 with only a fresh PASSWORD (no recent factor) → still rejected', () => {
  const { requireFreshMfaForDeletion } = load();
  const passwordOnly = { amr: [{ method: 'password', timestamp: Math.floor(now / 1000) }], aal: 'aal2', mfaEnrolled: true };
  assert.throws(() => requireFreshMfaForDeletion(passwordOnly), (e) => {
    assert.equal(e.code, 'mfa_reauthentication_required'); return true;
  });
});

test('enrolled + aal2 + a recent authenticator check → allowed', () => {
  const { requireFreshMfaForDeletion } = load();
  assert.doesNotThrow(() => requireFreshMfaForDeletion(freshTotp));
});
