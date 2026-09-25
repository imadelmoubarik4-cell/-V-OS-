// Team (#team, #team/<profileId>, spec §7.10): the S88 rebuild on the design
// system, shipped as a gzip bundle that must match its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const config = readFileSync('apps/web/config.js', 'utf8');
const index = readFileSync('apps/web/index.html', 'utf8');
const bootstrap = readFileSync('apps/web/assets/js/team-profiles-bootstrap.js', 'utf8');
const source = readFileSync('apps/web/assets/js/team-profiles.source.js', 'utf8');
const cssSource = readFileSync('apps/web/assets/css/team-profiles.source.css', 'utf8');
const ui = gunzipSync(readFileSync('apps/web/assets/js/team-profiles.bundle.js.gz')).toString('utf8');
const css = gunzipSync(readFileSync('apps/web/assets/css/team-profiles.bundle.css.gz')).toString('utf8');

test('Team loads through the isolated Team Profiles API as a repository-owned bundle', () => {
  assert.match(config, /TEAM_PROFILES_API:\s*"https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-team-profiles"/);
  assert.match(config, /assets\/js\/team-profiles-bootstrap\.js/);
  assert.match(bootstrap, /team-profiles\.bundle\.js\.gz/);
  assert.match(bootstrap, /team-profiles\.bundle\.css\.gz/);
  assert.match(bootstrap, /DecompressionStream\('gzip'\)/);
  assert.match(bootstrap, /document\.createElement\('style'\)/);
  assert.match(bootstrap, /style\.textContent = source/);
  assert.doesNotMatch(bootstrap, /eval\s*\(|new Function|window\.alert/);
});

test('the shipped bundles match their sources (scripts/build_team_profiles_bundle.mjs)', () => {
  assert.equal(ui, source);
  assert.equal(css, cssSource);
  execFileSync(process.execPath, ['scripts/build_team_profiles_bundle.mjs', '--check']);
});

test('directory: header, search, filters, table on wider screens, rows on phones', () => {
  assert.match(ui, /<h1 class="page-head__title">Team<\/h1>/);
  assert.match(ui, /with training due/);
  assert.match(ui, /placeholder="Search people" aria-label="Search people"/);
  assert.match(ui, /data-team-profiles-filter="\$\{key\}"/);
  assert.match(ui, /Training due/);
  assert.match(ui, /Contact missing/);
  assert.match(ui, /<table class="atlas-table team-table">/);
  assert.match(ui, /<th scope="col">On shift today<\/th>/);
  assert.match(ui, /class="atlas-table-list team-list"/);
  assert.match(ui, /No team members yet/);
  assert.match(ui, /registerView\?\.\('team-profiles', \{ root: host, title: 'Team', render, onHide: hide \}\)/);
  // No hero, KPI cards, trust footer or Messages/Refresh buttons (spec §7.10).
  assert.doesNotMatch(ui, /team-profiles-hero|team-profiles-summary|team-profiles-trust|data-team-profiles-messages|Checkpoint E/);
});

test('profile: #team/<id> opens a sheet (a page on phones) with contact, shifts, training, access', () => {
  assert.match(ui, /const next = params\.profile \? String\(params\.profile\) : null;/);
  assert.match(ui, /id: 'team-profile-sheet'/);
  assert.match(ui, /window\.AtlasChrome\?\.setTopBar\?\.\(\{ title: profile\?\.name \|\| 'Team', back: \(\) => routeTo\('team-profiles', \{\}\) \}\)/);
  for (const label of ['Contact', 'Emergency contact', 'Shifts this week', 'Onboarding', 'Access', 'History', 'Manager note']) assert.match(ui, new RegExp(`>${label}<`));
  assert.match(ui, /href="tel:/);
  assert.match(ui, /href="mailto:/);
  assert.match(ui, /preferred_name/);
  assert.match(ui, /employment_type/);
  assert.match(ui, /phone_visibility/);
  assert.match(ui, /manager_notes/);
  assert.match(ui, /mutate\('update-access'/);
  assert.match(ui, /mutate\('update-onboarding'/);
  assert.match(ui, /live_training_writes_enabled/);
});

test('sensitive details are bounded: emergency contacts manager-only and masked until Show', () => {
  assert.match(ui, /if \(!profile\.can_view_sensitive\) return '';/);
  assert.match(ui, /const masked = isManager\(\) && !own && !state\.revealed\.has\(profile\.id\);/);
  assert.match(ui, /Show emergency contact/);
  assert.match(ui, /You can\\u2019t change your own role or turn off your own access\.|You can’t change your own role or turn off your own access\./);
  assert.match(ui, /Only an administrator can change an administrator\./);
  assert.match(ui, /Shared with managers only/);
  assert.match(ui, /email: isManager\(\) \? person\.email : null/);
});

test('people management: add, invite, setup links (managers and administrators)', () => {
  assert.match(ui, /Add team member/);
  assert.match(ui, /Invite by email/);
  assert.match(ui, /data-team-profile-invite-form/);
  assert.match(ui, /mutate\('invite-account'/);
  assert.match(ui, /api\(login \? 'create-login-member' : 'create-person'/);
  assert.match(ui, /api\('renew-member-setup'/);
  assert.match(ui, /Share the setup link/);
  assert.match(ui, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(ui, /window\.(prompt|confirm|alert)\(/);
});

test('times and dates use the venue clock', () => {
  assert.match(ui, /return vc\(\)\?\.startOfWeek\?\.\(today\(\)\) \|\| today\(\);/);
  assert.match(ui, /function businessDateOf\(shift\)[\s\S]+?vc\(\)\?\.businessDate\?\.\(shift\.starts_at\)/);
  assert.doesNotMatch(ui, /getUTCDay\(\)|toLocaleDateString|Intl\.DateTimeFormat/);
});

test('browser uses authenticated gateway and no direct database writes', () => {
  assert.match(ui, /window\.atlasSupabase/);
  assert.match(ui, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(ui, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(ui, /\.from\s*\(/);
  assert.doesNotMatch(ui, /team_profile_details|team_emergency_contacts|onboarding_progress/);
});

test('dialogs and sheets are AtlasModal layers (Esc, focus return, scrim)', () => {
  assert.match(ui, /root\.setAttribute\('data-atlas-modal', ''\)/);
  assert.match(ui, /window\.AtlasModal\.register\(root, \{ initialFocus, onClose:/);
  assert.match(ui, /initialFocus: '\.atlas-sheet__close'/);
});

test('module stylesheet: one atlas.modules layer, tokens only, nothing under 12 px', () => {
  assert.equal((css.match(/@layer/g) || []).length, 1);
  assert.match(css, /@layer atlas\.modules \{/);
  assert.doesNotMatch(css, /!important|:root|#[0-9a-f]{3,6}\b/i);
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[01])px/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
  for (const fragment of ['polish-pass2--team-profiles', 's38-app-remediation--team-profiles', 'workspaces-polish--team-profiles']) {
    assert.ok(!existsSync(`apps/web/assets/css/legacy/${fragment}.css`), `${fragment} is deleted`);
    assert.doesNotMatch(index, new RegExp(fragment));
  }
});
