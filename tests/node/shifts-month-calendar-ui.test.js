import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const month = readFileSync('apps/web/assets/js/shifts-month-calendar.js', 'utf8');
const css = readFileSync('apps/web/assets/css/shifts-month-calendar.css', 'utf8');

test('Checkpoint F.1 loads after the weekly Shifts workspace', () => {
  assert.match(config, /assets\/css\/shifts-month-calendar\.css/);
  assert.match(config, /assets\/js\/shifts-month-calendar\.js/);
  assert.match(config, /globalName:\s*'AtlasShiftsMonth'/);
  assert.ok(config.indexOf('shifts-workspace.js') < config.indexOf('shifts-month-calendar.js'));
});

test('month calendar includes month navigation, today and a complete Monday-first grid', () => {
  assert.match(month, /data-shifts-tab=\"month\"/);
  assert.match(month, /Full month/);
  assert.match(month, /data-shifts-month-nav=\"-1\"/);
  assert.match(month, /data-shifts-month-nav=\"1\"/);
  assert.match(month, /data-shifts-month-today/);
  assert.match(month, /WEEKDAY_ORDER = \[1, 2, 3, 4, 5, 6, 0\]/);
  assert.match(month, /gridStart: mondayFor\(start\)/);
  assert.match(month, /gridEnd: addDays\(mondayFor\(monthEnd\), 6\)/);
});

test('month combines authenticated weekly snapshots without writing schedule data', () => {
  assert.match(month, /window\.atlasSupabase/);
  assert.match(month, /authorization: `Bearer \$\{accessToken\}`/);
  assert.match(month, /url\.searchParams\.set\('action', 'snapshot'\)/);
  assert.match(month, /Promise\.all\(weekStarts\.map/);
  assert.match(month, /method: 'GET'/);
  assert.doesNotMatch(month, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(month, /\.from\s*\(/);
  assert.doesNotMatch(month, /\/rest\/v1\/shifts/);
  assert.doesNotMatch(month, /save-shift|publish-week|cancel-shift/);
});

test('manager drafts and staff published visibility continue through the existing gateway', () => {
  assert.match(month, /staff\?\.can_manage_schedule/);
  assert.match(month, /week\.latest_publication/);
  assert.match(month, /Update pending/);
  assert.match(month, /Published r/);
  assert.match(month, /Month view combines private weekly drafts for planning/);
  assert.match(month, /Draft manager changes stay private/);
  assert.match(month, /Production public\.shifts remains unchanged/);
});

test('calendar days expose shifts, leave, confirmation state and weekly drill-through', () => {
  assert.match(month, /data-shifts-month-day/);
  assert.match(month, /shift-month-chip is-/);
  assert.match(month, /approved time off/);
  assert.match(month, /confirmed/);
  assert.match(month, /change_requested/);
  assert.match(month, /declined/);
  assert.match(month, /Open weekly planner/);
  assert.match(month, /data-shifts-month-open-week/);
  assert.match(month, /window\.AtlasShifts\?\.week/);
});

test('full month layout remains responsive and preserves the Atlas design system', () => {
  assert.match(css, /var\(--atlas-surface\)/);
  assert.match(css, /'Fraunces'/);
  assert.match(css, /'IBM Plex Sans'/);
  assert.match(css, /grid-template-columns:repeat\(7/);
  assert.match(css, /overflow-x:auto/);
  assert.match(css, /@media\(max-width:1180px\)/);
  assert.match(css, /@media\(max-width:820px\)/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /@media\(max-width:420px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /Caprasimo|Figtree|--color-accent-2/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
