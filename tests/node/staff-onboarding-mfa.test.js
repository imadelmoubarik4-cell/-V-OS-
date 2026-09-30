// S99 staff onboarding + mandatory TOTP two-factor.
//
// Static contract checks: the migration is non-breaking and OFF by default and
// its all-staff gate mirrors the S96 privileged gate; the invitation wizard runs
// all four steps and requires a confirmed photo before completing; the
// atlas-team-profiles edge function captures the invite role, completes
// onboarding without letting the caller pick an elevated role, and offers the
// manager MFA reset; and the login gate blocks entry without a verified factor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, ROOT), 'utf8');

const S99 = read('supabase/migrations/20261016093000_s99_all_staff_mfa.sql');
const S96 = read('supabase/migrations/20261010091000_s96_privileged_mfa_rls.sql');
const INVITE_JS = read('apps/web/assets/js/account-invitation.js');
const INVITE_HTML = read('apps/web/invitation.html');
const MFA_JS = read('apps/web/assets/js/atlas-mfa-enroll.js');
const TEAM_FN = read('supabase/functions/atlas-team-profiles/index.ts');
const PHOTO_FN = read('supabase/functions/atlas-team-profile-photos/index.ts');
const APP_JS = read('apps/web/assets/js/atlas-app.js');

// Extracts the plpgsql body of `create or replace function <name>` up to its `$$;`.
function functionBody(sql, name) {
  const start = sql.indexOf(`create or replace function ${name}`);
  assert.notEqual(start, -1, `${name} is defined`);
  const bodyStart = sql.indexOf('$$', start);
  const bodyEnd = sql.indexOf('$$;', bodyStart + 2);
  assert.ok(bodyStart !== -1 && bodyEnd !== -1, `${name} has a body`);
  return sql.slice(bodyStart + 2, bodyEnd);
}

// SQL with `--` comment lines removed, so prose in comments never satisfies a
// "does the migration DO x" check.
const S99_CODE = S99.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

test('s99 migration adds require_all_staff_mfa defaulting false and never enables it', () => {
  assert.match(S99, /add column if not exists require_all_staff_mfa boolean not null default false/i);
  // The migration must not turn enforcement on for anyone (ignore comment prose).
  assert.doesNotMatch(S99_CODE, /require_all_staff_mfa\s*=\s*true/i);
  assert.doesNotMatch(S99_CODE, /update\s+private\.auth_policy[\s\S]*require_all_staff_mfa/i);
  assert.match(S99, /notify pgrst, 'reload schema';/);
});

test('private.staff_session_ok mirrors private.privileged_session_ok exactly', () => {
  const privileged = functionBody(S96, 'private.privileged_session_ok()');
  const staff = functionBody(S99, 'private.staff_session_ok()');
  // The only intended difference is which policy column is read.
  const normalized = privileged.replace(/require_privileged_mfa/g, 'require_all_staff_mfa');
  assert.equal(staff.trim(), normalized.trim(), 'staff gate is a faithful mirror of the privileged gate');
});

test('s99 wires staff_session_ok into is_active_staff without changing the base staff test', () => {
  const start = S99.indexOf('create or replace function private.is_active_staff()');
  assert.notEqual(start, -1, 'is_active_staff is redefined');
  const body = S99.slice(start, S99.indexOf('$function$;', start));
  assert.match(body, /profile\.active is true/);
  assert.match(body, /and private\.staff_session_ok\(\)/, 'is_active_staff now requires the staff MFA gate');
});

test('s99 lets a person read their own profile row (so onboarding auth resolves)', () => {
  assert.match(S99, /create policy "read own profile" on public\.profiles/);
  assert.match(S99, /using \(id = \(select auth\.uid\(\)\)\)/);
});

test('the invitation wizard runs all four steps', () => {
  for (const id of ['step-password', 'step-details', 'step-photo', 'step-mfa']) {
    assert.ok(INVITE_HTML.includes(`id="${id}"`), `invitation.html has ${id}`);
  }
  for (const key of ['password', 'details', 'photo', 'mfa']) {
    assert.ok(INVITE_JS.includes(`showStep('${key}')`), `wizard advances to ${key}`);
  }
  // Name + phone via the existing save-details action, self-scoped.
  assert.match(INVITE_JS, /save-details/);
  // Photo via the existing photo function, and only completes after a confirmed upload.
  assert.match(INVITE_JS, /TEAM_PROFILE_PHOTOS_API, 'upload'/);
  assert.match(INVITE_JS, /photoUploaded = true/);
  assert.match(INVITE_JS, /if \(!photoUploaded\)/, 'photo is required before leaving the photo step');
  assert.match(INVITE_JS, /AtlasMfaEnroll\.mount/);
  assert.match(INVITE_JS, /complete-onboarding/);
});

test('the enrolment module enrols, verifies and cleans up an abandoned factor', () => {
  assert.match(MFA_JS, /mfa\.enroll\(\{ factorType: 'totp'/);
  assert.match(MFA_JS, /mfa\.challengeAndVerify\(\{ factorId, code \}\)/);
  assert.match(MFA_JS, /mfa\.unenroll\(\{ factorId \}\)/, 'abandoned factor is unenrolled');
  assert.match(MFA_JS, /totp\??\.qr_code/);
  assert.match(MFA_JS, /totp\??\.secret/);
});

test('the invite path captures a role and restricts admin to admins', () => {
  assert.match(TEAM_FN, /atlas_intended_role/);
  assert.match(TEAM_FN, /Only an administrator can invite an administrator/);
  // A manager may set manager/bartender/viewer, not admin, at invite time.
  assert.match(TEAM_FN, /role === "admin" && context\.profile\.role !== "admin"/);
});

test('complete-onboarding takes the role only from the invite, never from the caller', () => {
  assert.match(TEAM_FN, /case "complete-onboarding":/);
  // Role is read from app_metadata.atlas_intended_role, validated, defaulting viewer.
  assert.match(TEAM_FN, /atlas_intended_role \?\? "viewer"/);
  assert.match(TEAM_FN, /PROFILE_ROLES\.has\(intended\) \? intended : "viewer"/);
  // It requires an aal2 session and a verified factor, and a saved phone + photo.
  assert.match(TEAM_FN, /context\.aal !== "aal2"/);
  assert.match(TEAM_FN, /readiness\?\.has_phone/);
  assert.match(TEAM_FN, /readiness\?\.has_photo/);
});

test('manager MFA reset guards admins and the last active admin', () => {
  assert.match(TEAM_FN, /case "reset-member-mfa":/);
  assert.match(TEAM_FN, /Only an administrator can reset an administrator/);
  assert.match(TEAM_FN, /at least one administrator with two-factor/);
  assert.match(TEAM_FN, /mfa\.deleteFactor/);
});

test('the photo function accepts an inactive onboarding self-upload only', () => {
  assert.match(PHOTO_FN, /action === "upload"/);
  assert.match(PHOTO_FN, /allowInactive/);
  assert.match(PHOTO_FN, /context\.profile\.active === true && MANAGER_ROLES\.has/);
});

test('the login gate blocks entry without a verified authenticator', () => {
  assert.match(APP_JS, /function enforceEntryMfa/);
  assert.match(APP_JS, /mountLoginEnrollment/);
  // No verified factor => route to enrolment (does not enter the app).
  assert.match(APP_JS, /return 'enroll';/);
  assert.match(APP_JS, /if \(gate === 'enroll' \|\| gate === 'blocked'\) return;/);
});
