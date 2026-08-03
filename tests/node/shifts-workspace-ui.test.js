import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const shifts = readFileSync('apps/web/assets/js/shifts-workspace.js', 'utf8');
const css = readFileSync('apps/web/assets/css/shifts-workspace.css', 'utf8');
const gallery = readFileSync('apps/web/assets/js/team-profile-photo-gallery.js', 'utf8');

test('Checkpoint F loads from the isolated Shifts API', () => {
  assert.match(config, /SHIFTS_API:\s*"https:\/\/uhbamqetppqmygesoeeh\.supabase\.co\/functions\/v1\/atlas-shifts"/);
  assert.match(config, /assets\/js\/shifts-workspace\.js/);
  assert.match(config, /assets\/css\/shifts-workspace\.css/);
  assert.match(config, /AtlasShifts/);
});

test('weekly planner includes navigation, drafting, copying and publication', () => {
  assert.match(shifts, /data-shifts-week/);
  assert.match(shifts, /data-shifts-today/);
  assert.match(shifts, /Copy previous week/);
  assert.match(shifts, /data-shifts-add-shift/);
  assert.match(shifts, /data-shifts-edit-shift/);
  assert.match(shifts, /data-shifts-cancel-shift/);
  assert.match(shifts, /data-shifts-publish/);
  assert.match(shifts, /Publish week/);
  assert.match(shifts, /Unpublished changes/);
  assert.match(shifts, /immutable revision/);
});

test('availability, time off, confirmations and handover are operational', () => {
  assert.match(shifts, /data-shifts-availability-form/);
  assert.match(shifts, /data-shifts-time-off-form/);
  assert.match(shifts, /data-shifts-time-off-decision/);
  assert.match(shifts, /data-shifts-respond/);
  assert.match(shifts, /data-shifts-response-decision/);
  assert.match(shifts, /shift-handover/);
  for (const tab of ['Schedule', 'Availability', 'Time off', 'Confirmations', 'Activity']) {
    assert.match(shifts, new RegExp(tab));
  }
});

test('schedule-only people are supported without creating login accounts', () => {
  assert.match(shifts, /Add team member/);
  assert.match(shifts, /schedule-only person/);
  assert.match(shifts, /does not create an Atlas login account/);
  assert.match(shifts, /no Atlas confirmation/);
});

test('browser uses the authenticated gateway and keeps production shifts untouched', () => {
  assert.match(shifts, /window\.atlasSupabase/);
  assert.match(shifts, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.match(shifts, /Production public\.shifts remains unchanged/);
  assert.match(shifts, /production_shift_sync_enabled/);
  assert.doesNotMatch(config + shifts + gallery, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(shifts, /\.from\s*\(/);
  assert.doesNotMatch(shifts, /\/rest\/v1\/shifts/);
});

test('mobile profile photo picker exposes the gallery instead of forcing camera capture', () => {
  assert.match(config, /assets\/js\/team-profile-photo-gallery\.js/);
  assert.match(gallery, /removeAttribute\('capture'\)/);
  assert.match(gallery, /image\/jpeg,image\/png,image\/webp/);
  assert.match(gallery, /camera or gallery/);
  assert.match(gallery, /Choose photo/);
  assert.doesNotMatch(gallery, /setAttribute\(['"]capture/);
});

test('Shifts preserves Atlas styling and responsive mobile behavior', () => {
  assert.match(css, /var\(--atlas-surface\)/);
  assert.match(css, /'Fraunces'/);
  assert.match(css, /'IBM Plex Sans'/);
  assert.match(css, /@media\(max-width:1180px\)/);
  assert.match(css, /@media\(max-width:820px\)/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /@media\(max-width:420px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /Caprasimo|Figtree|--color-accent-2/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
