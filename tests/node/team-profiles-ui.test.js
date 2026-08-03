import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const bootstrap = readFileSync('apps/web/assets/js/team-profiles-bootstrap.js', 'utf8');
const ui = gunzipSync(readFileSync('apps/web/assets/js/team-profiles.bundle.js.gz')).toString('utf8');
const css = gunzipSync(readFileSync('apps/web/assets/css/team-profiles.bundle.css.gz')).toString('utf8');

test('Checkpoint E loads through the isolated Team Profiles API', () => {
  assert.match(config, /TEAM_PROFILES_API:\s*"https:\/\/uhbamqetppqmygesoeeh\.supabase\.co\/functions\/v1\/atlas-team-profiles"/);
  assert.match(config, /assets\/js\/team-profiles-bootstrap\.js/);
  assert.match(bootstrap, /team-profiles\.bundle\.js\.gz/);
  assert.match(bootstrap, /team-profiles\.bundle\.css\.gz/);
  assert.match(bootstrap, /DecompressionStream\('gzip'\)/);
  assert.match(bootstrap, /Blob/);
  assert.doesNotMatch(bootstrap, /eval\s*\(|new Function/);
});

test('Team Profiles adds a dedicated People navigation and directory', () => {
  assert.match(ui, /data-view="team-profiles"/);
  assert.match(ui, /<\/i>Profiles/);
  assert.match(ui, /Team directory/);
  assert.match(ui, /Search name, role or department/);
  assert.match(ui, /Training due/);
  assert.match(ui, /Contact missing/);
});

test('profile details cover employment, contacts, access and training', () => {
  for (const label of [
    'Profile completeness', 'Role at VÁ', 'Staff details', 'Emergency contacts',
    'Role and account status', 'Onboarding and training', 'Recent profile activity'
  ]) assert.match(ui, new RegExp(label));
  assert.match(ui, /preferred_name/);
  assert.match(ui, /employment_type/);
  assert.match(ui, /phone_visibility/);
  assert.match(ui, /manager_notes/);
  assert.match(ui, /update-access/);
  assert.match(ui, /update-onboarding/);
});

test('sensitive controls are explicitly bounded', () => {
  assert.match(ui, /Emergency contacts are visible only to the team member and managers/);
  assert.match(ui, /You cannot change your own role or deactivate your own account here/);
  assert.match(ui, /Only an administrator can modify an administrator profile/);
  assert.match(ui, /Account invitations are not connected yet/);
  assert.match(ui, /audit event will be preserved/i);
});

test('browser uses authenticated gateway and no direct database writes', () => {
  assert.match(ui, /window\.atlasSupabase/);
  assert.match(ui, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(ui, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(ui, /\.from\s*\(/);
  assert.doesNotMatch(ui, /team_profile_details|team_emergency_contacts|onboarding_progress/);
});

test('Team Profiles preserves Atlas design and responsive behavior', () => {
  assert.match(css, /var\(--atlas-surface\)/);
  assert.match(css, /'Fraunces'/);
  assert.match(css, /'IBM Plex Sans'/);
  assert.match(css, /@media\(max-width:820px\)/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /Caprasimo|Figtree|--color-accent-2/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
