import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const client = readFileSync('apps/web/assets/js/team-profile-photos.js', 'utf8');
const css = readFileSync('apps/web/assets/css/team-profile-photos.css', 'utf8');
const team = readFileSync('apps/web/assets/js/team-profiles.source.js', 'utf8');
const messages = readFileSync('apps/web/assets/js/team-messages.js', 'utf8');

test('profile photos load through the isolated profile-photo API', () => {
  assert.match(config, /TEAM_PROFILE_PHOTOS_API:\s*"https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-team-profile-photos"/);
  assert.match(config, /assets\/js\/team-profile-photos\.js/);
  assert.match(config, /assets\/css\/team-profile-photos\.css/);
  assert.match(config, /AtlasTeamProfilePhotos/);
});

test('pages render photos from photoFor(); the module adds controls to the open profile', () => {
  // Team, Messages and Shifts draw avatars with AtlasTeamProfilePhotos.photoFor(id).
  assert.match(team, /window\.AtlasTeamProfilePhotos\?\.photoFor\?\.\(profile\.id\)/);
  assert.match(messages, /window\.AtlasTeamProfilePhotos\?\.photoFor\?\.\(identity\.id\)/);
  assert.match(client, /document\.querySelectorAll\('\[data-team-profile-detail\]'\)/);
  assert.match(client, /detail\.querySelector\('\.team-profile-detail-actions'\)/);
  assert.match(team, /data-team-profile-detail="\$\{escapeHtml\(profile\.id\)\}"/);
  assert.match(team, /class="team-profile-detail-actions team-detail__actions"/);
  // Schedule-only roster people have no account, so no photo controls.
  assert.match(client, /filter\(\(detail\) => !detail\.closest\('\[data-schedule-only\]'\)\)/);
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
  assert.match(client, /Remove this photo\?/);
  assert.doesNotMatch(client, /window\.(confirm|prompt|alert)\(/);
});

test('phones get the photo library and the camera (no forced capture); the gallery shim is retired', () => {
  assert.doesNotMatch(client, /capture="user"|setAttribute\(['"]capture/);
  assert.match(client, /from camera or library/);
  assert.ok(!existsSync('apps/web/assets/js/team-profile-photo-gallery.js'));
  assert.doesNotMatch(config, /team-profile-photo-gallery/);
});

test('browser uses the authenticated gateway and no direct Storage or table writes', () => {
  // S89: requests go through the shared AtlasApi helper (atlas-api.js), which
  // adds the session bearer token and maps failures to fixed copy.
  assert.match(client, /window\.AtlasApi\.request\(endpoint\(\), \{/);
  assert.match(client, /messages: API_MESSAGES/);
  assert.doesNotMatch(client, /payload\.error/, 'server text is never shown');
  const api = readFileSync('apps/web/assets/js/atlas-api.js', 'utf8');
  assert.match(api, /window\.atlasSupabase/);
  assert.match(api, /authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(client, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(client, /\.from\s*\(/);
  assert.doesNotMatch(client, /storage\.from|storage\/v1\/object/);
  assert.doesNotMatch(client, /team_profile_photos|team_profile_events/);
});

test('photo decoration is idempotent and follows Team render events', () => {
  assert.match(client, /teamProfilePhotoRenderKey === key/);
  assert.doesNotMatch(client, /new MutationObserver/);
  assert.match(client, /window\.AtlasShell\?\.on\?\.\('team-profiles:rendered', refreshVisibleProfiles\)/);
  assert.match(client, /window\.AtlasShell\?\.onView\?\.\('team-profiles', \{ show: refreshVisibleProfiles \}\)/);
  assert.match(client, /requestAnimationFrame/);
  assert.match(team, /window\.AtlasShell\?\.emit\?\.\('team-profiles:rendered'/);
});

test('portrait styling is a small atlas.modules sheet on the shared avatar', () => {
  assert.equal((css.match(/@layer/g) || []).length, 1);
  assert.match(css, /@layer atlas\.modules \{/);
  // The photo fit itself is the shared .atlas-avatar > img component rule.
  assert.match(css, /\.atlas-avatar\.has-profile-photo/);
  assert.match(readFileSync('apps/web/assets/css/atlas-components.css', 'utf8'), /\.atlas-avatar > img \{[^}]*object-fit: cover/);
  assert.doesNotMatch(css, /!important|:root|#[0-9a-f]{3,6}\b|font-size/i);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
