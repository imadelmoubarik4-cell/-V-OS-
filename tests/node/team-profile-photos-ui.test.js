import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const client = readFileSync('apps/web/assets/js/team-profile-photos.js', 'utf8');
const css = readFileSync('apps/web/assets/css/team-profile-photos.css', 'utf8');

test('Checkpoint E.1 loads through the isolated profile-photo API', () => {
  assert.match(config, /TEAM_PROFILE_PHOTOS_API:\s*"https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-team-profile-photos"/);
  assert.match(config, /assets\/js\/team-profile-photos\.js/);
  assert.match(config, /assets\/css\/team-profile-photos\.css/);
  assert.match(config, /AtlasTeamProfilePhotos/);
});

test('profile photos decorate the directory, selected profile and signed-in avatar', () => {
  assert.match(client, /\.team-profile-card\[data-team-profile-select\]/);
  assert.match(client, /\.team-profile-avatar/);
  assert.match(client, /\.team-profile-detail-avatar/);
  assert.match(client, /document\.getElementById\('user-avatar'\)/);
  assert.match(client, /photo\.signed_url/);
  assert.match(client, /referrerpolicy="no-referrer"/);
});

test('staff can choose, resize, upload, replace and remove authorized photos', () => {
  assert.match(client, /data-team-profile-photo-upload/);
  assert.match(client, /data-team-profile-photo-remove/);
  assert.match(client, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(client, /window\.createImageBitmap/);
  assert.match(client, /canvas\.width = target/);
  assert.match(client, /const target = 512/);
  assert.match(client, /canvasBlob\(canvas, 'image\/webp', 0\.86\)/);
  assert.match(client, /new FormData\(\)/);
  assert.match(client, /request\('upload'/);
  assert.match(client, /request\('remove'/);
  assert.match(client, /MAX_UPLOAD_BYTES = 2 \* 1024 \* 1024/);
});

test('browser uses the authenticated gateway and no direct Storage or table writes', () => {
  assert.match(client, /window\.atlasSupabase/);
  assert.match(client, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(client, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(client, /\.from\s*\(/);
  assert.doesNotMatch(client, /storage\.from|storage\/v1\/object/);
  assert.doesNotMatch(client, /team_profile_photos|team_profile_events/);
});

test('photo decoration is idempotent and follows Team Profiles render events', () => {
  // S88: Team Profiles announces each render through AtlasShell (the former
  // 'atlas:team-profiles-rendered' window listener waited for an event nobody
  // sent); decoration follows it and the view opening instead of an observer.
  assert.match(client, /teamProfilePhotoKey === key/);
  assert.doesNotMatch(client, /new MutationObserver/);
  assert.match(client, /window\.AtlasShell\?\.on\?\.\('team-profiles:rendered', refreshVisibleProfiles\)/);
  assert.match(client, /window\.AtlasShell\?\.onView\?\.\('team-profiles', \{ show: refreshVisibleProfiles \}\)/);
  assert.match(client, /requestAnimationFrame/);
  assert.doesNotMatch(client, /document\.body.*observe|observe\(document\.body/);
});

test('portrait styling preserves Atlas design and responsive behavior', () => {
  assert.match(css, /var\(--atlas-line\)/);
  assert.match(css, /'IBM Plex Sans'/);
  assert.match(css, /object-fit:cover/);
  assert.match(css, /@media\(max-width:820px\)/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /Caprasimo|Figtree|--color-accent-2/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
