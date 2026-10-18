// S105 Team member removal & permanent deletion — gateway guard logic.
// Extracts removeFromTeam/deleteMember/deletePreview (+ helpers) from the Deno
// edge source and runs them in a VM with hand-mocked deps (same technique as
// team-login-s64f), since the Deno function can't execute in Node. Proves the
// authorization and safety guards; the real data semantics are proven by the SQL
// migration tests, and the fresh-MFA primitive by team-deletion-mfa-s105.test.js.
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
    storage: { from: () => ({ remove: async () => { calls.push('storage.remove'); return { error: overrides.storageError || null }; } }) },
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
    // Defined earlier in the module than the extracted slice, so it is mocked
    // here; its real enforcement is proven by team-deletion-mfa-s105.test.js.
    requireFreshMfaForDeletion: overrides.requireFreshMfaForDeletion || (() => {}),
    optionalUuid: (v) => (v == null ? null : v),
    requiredText: (v) => { if (!v) throw new scope.ApiError(400, 'required'); return String(v); },
    profileLabel: () => 'Owner',
    logExternalEvent: async () => calls.push('audit'),
    productionJson: async (_ctx, url) => {
      calls.push('deactivate');
      const id = url?.searchParams?.get?.('id')?.replace('eq.', '') || null;
      return overrides.deactivateResult ? overrides.deactivateResult(id) : [{ id, active: false }];
    },
    branchRpc: async (name) => {
      calls.push(name);
      if (name === 'atlas_team_member_deletion_preview') return overrides.preview || { found: true, display_name: 'Pat Casual', shift_entry_count: 0 };
      if (name === 'atlas_team_member_purge_branch') return overrides.purge || { ok: true, mode: 'anonymized_kept_shifts', shift_entry_count: 2, photo_storage_path: 'profiles/x/y.webp' };
      if (name === 'atlas_team_member_remove_from_team') return { ok: true, roster_archived: true };
      if (name === 'atlas_team_member_list_photo_orphans') return overrides.orphans || [];
      if (name === 'atlas_team_member_record_photo_orphan') return { ok: true };
      if (name === 'atlas_team_member_resolve_photo_orphan') return { ok: true };
      return {};
    },
    profileById: overrides.profileById || (async () => ({ id: 'emp1', display_name: 'Jane Doe', role: 'bartender', active: true })),
    profiles: overrides.profiles || (async () => [{ id: 'admin1', role: 'admin', active: true }, { id: 'emp1', role: 'bartender', active: true }]),
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

test('a stale or unverified admin is stopped by the MFA gate before any work', async () => {
  const { scope, calls } = setup({ requireFreshMfaForDeletion: () => { const e = new Error('reauthentication_required'); throw e; } });
  await assert.rejects(scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'Jane Doe' }), /reauthentication_required/);
  assert.deepEqual(calls, [], 'no deactivate/purge/auth-delete without fresh MFA');
});

test('an administrator cannot delete their own account', async () => {
  const { scope, calls } = setup();
  await assert.rejects(scope.deleteMember(admin, { profile_id: 'admin1', confirm_name: 'Owner' }), /your own account/);
  assert.deepEqual(calls, []);
});

test('exactly one identifier is required — both or neither is rejected', async () => {
  const { scope, calls } = setup();
  await assert.rejects(scope.deleteMember(admin, { profile_id: 'emp1', person_id: 'person1', confirm_name: 'x' }), /exactly one/);
  await assert.rejects(scope.deleteMember(admin, { confirm_name: 'x' }), /exactly one/);
  assert.deepEqual(calls, []);
});

test('the typed name must match before anything is deleted', async () => {
  const { scope, calls } = setup();
  await assert.rejects(scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'Wrong Name' }), /doesn.t match/);
  assert.deepEqual(calls, [], 'no deactivate/purge/auth-delete on a bad confirmation');
});

test('cannot delete the last active administrator (managers do not count)', async () => {
  const { scope, calls } = setup({
    profileById: async () => ({ id: 'emp1', display_name: 'Jane Doe', role: 'admin', active: true }),
    profiles: async () => [{ id: 'emp1', role: 'admin', active: true }, { id: 'x', role: 'manager', active: true }],
  });
  await assert.rejects(scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'Jane Doe' }), /at least one active administrator/);
  assert.deepEqual(calls, []);
});

test('the schedule-only route refuses a login-linked employee', async () => {
  const { scope, calls } = setup({ preview: { found: true, display_name: 'Pat Casual', person_profile_id: 'prof-x' } });
  await assert.rejects(scope.deleteMember(admin, { person_id: 'person1', confirm_name: 'Pat Casual' }), /Alcedo login/);
  assert.ok(calls.includes('atlas_team_member_deletion_preview'));
  assert.ok(!calls.includes('atlas_team_member_purge_branch'), 'never purges a login-linked person via the roster route');
  assert.ok(!calls.includes('auth.deleteUser'));
});

test('eligible login member: deactivate → purge → remove photo → delete auth user', async () => {
  const { scope, calls } = setup();
  const r = await scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'jane  doe' }); // case/space-insensitive
  assert.equal(r.ok, true);
  assert.equal(r.auth_deleted, true);
  assert.equal(r.shifts_retained, 2);
  assert.deepEqual(calls, ['deactivate', 'audit', 'atlas_team_member_purge_branch', 'storage.remove', 'auth.deleteUser']);
});

test('fail-closed: an unconfirmed deactivation stops the delete before any purge', async () => {
  const { scope, calls } = setup({ deactivateResult: () => [{ id: 'emp1', active: true }] }); // still active → not confirmed
  await assert.rejects(scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'Jane Doe' }), /could not be confirmed as revoked|could not be revoked/);
  assert.ok(calls.includes('deactivate'));
  assert.ok(!calls.includes('atlas_team_member_purge_branch'), 'no purge while the login may still be active');
  assert.ok(!calls.includes('auth.deleteUser'));
});

test('fail-closed: a deactivation request error stops the delete', async () => {
  const { scope, calls } = setup({ deactivateResult: () => { throw new Error('network'); } });
  await assert.rejects(scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'Jane Doe' }), /could not be revoked/);
  assert.ok(!calls.includes('atlas_team_member_purge_branch'));
});

test('a failed auth-user delete returns a truthful partial result, not false success', async () => {
  const { scope } = setup({ authDeleteError: { message: 'boom' } });
  const r = await scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'Jane Doe' });
  assert.equal(r.ok, false);
  assert.equal(r.partial, true);
  assert.equal(r.auth_deleted, false);
  assert.match(r.message, /safe to retry/);
});

test('a failed photo removal never reports complete erasure and keeps the path to retry', async () => {
  const { scope } = setup({ storageError: { message: 'storage down' } });
  const r = await scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'Jane Doe' });
  assert.equal(r.ok, false);
  assert.equal(r.partial, true);
  assert.equal(r.photo_removed, false);
  assert.equal(r.storage_cleanup_required, true);
  assert.equal(r.storage_path, 'profiles/x/y.webp');
  assert.match(r.message, /profile photo/);
});

test('an unknown target cannot return false success (the RPC refuses a no-op)', async () => {
  const { scope } = setup({ purge: { ok: false } });
  await assert.rejects(scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'Jane Doe' }), /could not be removed/);
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

// ---- resumable retry + invitation ----
test('a resumed delete after a failed Auth deletion finishes cleanly (idempotent, no re-purge destruction)', async () => {
  // Second attempt: branch data already gone → purge is already_clean, no photo.
  const { scope, calls } = setup({ purge: { ok: true, already_clean: true, mode: 'full_delete', shift_entry_count: 0, photo_storage_path: null } });
  const r = await scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'Jane Doe' });
  assert.equal(r.ok, true);
  assert.equal(r.auth_deleted, true);
  // deactivate (idempotent) → purge (no-op) → delete the Auth user. No storage.remove.
  assert.deepEqual(calls, ['deactivate', 'audit', 'atlas_team_member_purge_branch', 'auth.deleteUser']);
});

test('an unaccepted invitation (Auth user, no roster/details) is deleted, confirmed by email', async () => {
  const { scope, calls } = setup({
    profileById: async () => ({ id: 'emp1', display_name: '', email: 'invitee@example.invalid', role: 'viewer', active: false }),
    purge: { ok: true, already_clean: true, mode: 'full_delete', shift_entry_count: 0, photo_storage_path: null },
  });
  const r = await scope.deleteMember(admin, { profile_id: 'emp1', confirm_name: 'invitee@example.invalid' });
  assert.equal(r.ok, true);
  assert.ok(calls.includes('auth.deleteUser'));
});

// ---- orphan photo cleanup ----
test('photo-orphan cleanup is admin-only and removes + resolves each tracked file', async () => {
  const { scope, calls } = setup({ orphans: [{ storage_path: 'profiles/x/y.webp' }, { storage_path: 'profiles/a/b.webp' }] });
  const r = await scope.cleanupPhotoOrphans(admin);
  assert.equal(r.ok, true);
  assert.equal(r.attempted, 2);
  assert.equal(r.removed, 2);
  assert.equal(r.remaining, 0);
  assert.ok(calls.includes('atlas_team_member_list_photo_orphans'));
  assert.equal(calls.filter((c) => c === 'storage.remove').length, 2);
  assert.equal(calls.filter((c) => c === 'atlas_team_member_resolve_photo_orphan').length, 2);
});

test('a still-failing orphan removal is reported as remaining, not resolved', async () => {
  const { scope, calls } = setup({ orphans: [{ storage_path: 'profiles/x/y.webp' }], storageError: { message: 'down' } });
  const r = await scope.cleanupPhotoOrphans(admin);
  assert.equal(r.ok, false);
  assert.equal(r.remaining, 1);
  assert.equal(r.removed, 0);
  assert.ok(!calls.includes('atlas_team_member_resolve_photo_orphan'), 'never resolve what was not removed');
});

test('photo-orphan cleanup is refused for non-admins', async () => {
  const { scope } = setup();
  await assert.rejects(scope.cleanupPhotoOrphans({ user: { id: 'm1' }, profile: { role: 'manager' } }), /administrator/);
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

test('remove-from-team cannot strip the last active administrator', async () => {
  const { scope } = setup({
    profileById: async () => ({ id: 'emp1', display_name: 'Jane Doe', role: 'admin', active: true }),
    profiles: async () => [{ id: 'emp1', role: 'admin', active: true }, { id: 'x', role: 'manager', active: true }],
  });
  await assert.rejects(scope.removeFromTeam(admin, { profile_id: 'emp1' }), /at least one active administrator/);
});

test('you cannot remove your own account from the team', async () => {
  const { scope } = setup();
  await assert.rejects(scope.removeFromTeam(admin, { profile_id: 'admin1' }), /your own account/);
});
