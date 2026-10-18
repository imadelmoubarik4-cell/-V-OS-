// S105 Team member removal & permanent deletion — gateway guard logic.
// Extracts removeFromTeam/deleteMember (+ helpers) from the Deno edge source and
// runs them in a VM with hand-mocked deps (same technique as team-login-s64f),
// since the Deno function can't execute in Node. Proves the authorization and
// safety guards; the real data semantics are proven by the SQL migration tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../../supabase/functions/atlas-team-profiles/index.ts', import.meta.url), 'utf8');
const begin = source.indexOf('async function ensureNotLastActiveManager');
const handler = stripTypeScriptTypes(source.slice(begin, source.indexOf('Deno.serve', begin)));

function setup(overrides = {}) {
  const calls = [];
  const admin = {
    storage: { from: () => ({ remove: async () => { calls.push('storage.remove'); return { error: null }; } }) },
    auth: { admin: { deleteUser: async () => { calls.push('auth.deleteUser'); return { error: overrides.authDeleteError || null }; } } },
  };
  const scope = {
    URL,
    console,
    createClient: () => admin,
    Deno: { env: { get: (k) => (k === 'SUPABASE_URL' ? 'https://test.invalid' : 'secret') } },
    productionAuthUrl: () => 'https://test.invalid',
    ApiError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
    requireManager: (c) => { if (!['admin', 'manager'].includes(c.profile.role)) throw new scope.ApiError(403, 'manager required'); },
    requireStepUp: () => {},
    optionalUuid: (v) => (v == null ? null : v),
    requiredText: (v) => { if (!v) throw new scope.ApiError(400, 'required'); return String(v); },
    profileLabel: () => 'Owner',
    logExternalEvent: async () => calls.push('audit'),
    productionJson: async () => { calls.push('deactivate'); return [{ active: false }]; },
    branchRpc: async (name) => {
      calls.push(name);
      if (name === 'atlas_team_member_deletion_preview') return { found: true, display_name: 'Pat Casual', shift_entry_count: 0 };
      if (name === 'atlas_team_member_purge_branch') return { ok: true, mode: 'anonymized_kept_shifts', shift_entry_count: 2, photo_storage_path: 'profiles/x/y.webp' };
      if (name === 'atlas_team_member_remove_from_team') return { ok: true, roster_archived: true };
      return {};
    },
    profileById: async () => ({ id: 'emp1', display_name: 'Jane Doe', role: 'bartender', active: true }),
    profiles: async () => [{ id: 'admin1', role: 'admin', active: true }, { id: 'emp1', role: 'bartender', active: true }],
    ...overrides,
  };
  vm.createContext(scope);
  vm.runInContext(handler, scope);
  return { scope, calls, admin };
}

const admin = { user: { id: 'admin1' }, profile: { id: 'admin1', role: 'admin', display_name: 'Owner' } };

// ---- delete-member authorization + safety guards ----
test('only an administrator can permanently delete', async () => {
  const { scope, calls } = setup();
  await assert.rejects(scope.deleteMember({ user: { id: 'm1' }, profile: { role: 'manager' } }, { profile_id: 'emp1', confirm_name: 'Jane Doe' }), /administrator/);
  assert.deepEqual(calls, []);
});

test('an administrator cannot delete their own account', async () => {
  const { scope, calls } = setup();
  await assert.rejects(scope.deleteMember(admin, { profile_id: 'admin1', confirm_name: 'Owner' }), /your own account/);
  assert.deepEqual(calls, []);
});

test('the typed name must match before anything is deleted', async () => {
  const { scope, calls } = setup();
  await assert.rejects(scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'Wrong Name' }), /doesn.t match/);
  assert.deepEqual(calls, [], 'no deactivate/purge/auth-delete on a bad confirmation');
});

test('cannot delete the last active administrator/manager', async () => {
  const { scope, calls } = setup({
    profileById: async () => ({ id: 'emp1', display_name: 'Jane Doe', role: 'admin', active: true }),
    profiles: async () => [{ id: 'emp1', role: 'admin', active: true }, { id: 'x', role: 'manager', active: false }],
  });
  await assert.rejects(scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'Jane Doe' }), /at least one active/);
  assert.deepEqual(calls, []);
});

test('eligible login member: deactivate → purge → remove photo → delete auth user', async () => {
  const { scope, calls } = setup();
  const r = await scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'jane  doe' }); // case/space-insensitive
  assert.equal(r.ok, true);
  assert.equal(r.auth_deleted, true);
  assert.equal(r.shifts_retained, 2);
  assert.deepEqual(calls, ['deactivate', 'atlas_team_member_purge_branch', 'storage.remove', 'auth.deleteUser']);
});

test('a failed auth-user delete returns a truthful partial result, not false success', async () => {
  const { scope } = setup({ authDeleteError: { message: 'boom' } });
  const r = await scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'Jane Doe' });
  assert.equal(r.ok, false);
  assert.equal(r.partial, true);
  assert.equal(r.auth_deleted, false);
  assert.match(r.message, /safe to retry/);
});

test('schedule-only member: name checked via preview, no auth-user delete', async () => {
  const { scope, calls } = setup();
  const r = await scope.deleteMember(admin, { person_id: 'person1', confirm_name: 'Pat Casual' });
  assert.equal(r.ok, true);
  assert.equal(r.account_kind, 'schedule_only');
  assert.ok(calls.includes('atlas_team_member_deletion_preview'));
  assert.ok(calls.includes('atlas_team_member_purge_branch'));
  assert.ok(!calls.includes('auth.deleteUser'), 'no auth user to delete for a schedule-only person');
});

// ---- remove-from-team ----
test('remove-from-team is refused for non-managers', async () => {
  const { scope, calls } = setup();
  await assert.rejects(scope.removeFromTeam({ user: { id: 'b1' }, profile: { role: 'bartender' } }, { profile_id: 'emp1' }), /manager/);
  assert.deepEqual(calls, []);
});

test('remove-from-team deactivates + archives a login member (reversible)', async () => {
  const { scope, calls } = setup();
  const r = await scope.removeFromTeam(admin, { profile_id: 'emp1' });
  assert.equal(r.removed, true);
  assert.ok(calls.includes('deactivate'));
  assert.ok(calls.includes('atlas_team_member_remove_from_team'));
  assert.ok(!calls.includes('auth.deleteUser'), 'remove never deletes the auth account');
});

test('you cannot remove your own account from the team', async () => {
  const { scope } = setup();
  await assert.rejects(scope.removeFromTeam(admin, { profile_id: 'admin1' }), /your own account/);
});
