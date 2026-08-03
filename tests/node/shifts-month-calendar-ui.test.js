import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const month = readFileSync('apps/web/assets/js/shifts-month-calendar.js', 'utf8');
const css = readFileSync('apps/web/assets/css/shifts-month-calendar.css', 'utf8');
const editorCss = readFileSync('apps/web/assets/css/shifts-month-editor.css', 'utf8');
const edge = readFileSync('supabase/functions/atlas-shifts/index.ts', 'utf8');
const migration = readFileSync('supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql', 'utf8');
const publishFix = readFileSync('supabase/migrations/20260803225245_atlas_shifts_month_publish_complete_weeks.sql', 'utf8');

test('Checkpoint F.2 loads the month editor after weekly Shifts', () => {
  assert.match(config, /assets\/css\/shifts-month-calendar\.css/);
  assert.match(config, /assets\/css\/shifts-month-editor\.css/);
  assert.match(config, /assets\/js\/shifts-month-calendar\.js/);
  assert.match(config, /globalName:\s*'AtlasShiftsMonth'/);
  assert.ok(config.indexOf('shifts-workspace.js') < config.indexOf('shifts-month-calendar.js'));
  assert.ok(config.indexOf('shifts-month-calendar.css') < config.indexOf('shifts-month-editor.css'));
});

test('month calendar remains a complete Monday-first monthly grid', () => {
  assert.match(month, /data-shifts-tab=\"month\"/);
  assert.match(month, /Monthly shift plan/);
  assert.match(month, /data-shifts-month-nav=\"-1\"/);
  assert.match(month, /data-shifts-month-nav=\"1\"/);
  assert.match(month, /data-shifts-month-today/);
  assert.match(month, /WEEKDAY_ORDER = \[1, 2, 3, 4, 5, 6, 0\]/);
  assert.match(month, /gridStart: mondayFor\(start\)/);
  assert.match(month, /gridEnd: addDays\(mondayFor\(monthEnd\), 6\)/);
});

test('managers can create, edit and remove shifts directly from the month', () => {
  assert.match(month, /data-shifts-month-add/);
  assert.match(month, /data-shifts-month-add-day/);
  assert.match(month, /data-shifts-month-edit/);
  assert.match(month, /data-shifts-month-remove/);
  assert.match(month, /data-shifts-month-shift-form/);
  assert.match(month, /mutate\('save-shift'/);
  assert.match(month, /mutate\('cancel-shift'/);
  assert.match(month, /week_start: mondayFor\(startDate\)/);
  assert.match(month, /Shift saved to the private monthly draft/);
});

test('one month publication makes the complete plan visible to staff', () => {
  assert.match(month, /data-shifts-month-publish/);
  assert.match(month, /Publish month/);
  assert.match(month, /Publish update/);
  assert.match(month, /mutate\('publish-month'/);
  assert.match(month, /Staff continue seeing revision/);
  assert.match(month, /Manager drafts remain private until the full month is published/);
  assert.match(month, /Staff will immediately see this monthly plan/);
  assert.match(edge, /action === "month-snapshot"/);
  assert.match(edge, /case "publish-month"/);
  assert.match(edge, /atlas_shifts_month_snapshot/);
  assert.match(edge, /atlas_shifts_publish_month/);
});

test('published month revisions preserve weekly drill-down and confirmations', () => {
  assert.match(month, /Open weekly planner/);
  assert.match(month, /data-shifts-month-open-week/);
  assert.match(month, /data-shifts-month-respond/);
  assert.match(month, /confirmed/);
  assert.match(month, /change_requested/);
  assert.match(migration, /shift_month_publications/);
  assert.match(migration, /staff_visibility','latest_published_month_revision/);
  assert.match(publishFix, /generate_series\(grid_start,grid_end,interval '7 days'\)/);
  assert.match(publishFix, /shift_count,planned_hours/);
  assert.match(publishFix, /shift.active=false/);
  assert.match(publishFix, /Monthly schedule published/);
});

test('month browser uses only the authenticated Shifts gateway', () => {
  assert.match(month, /window\.atlasSupabase/);
  assert.match(month, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.match(month, /api\('month-snapshot'/);
  assert.doesNotMatch(month, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(month, /\.from\s*\(/);
  assert.doesNotMatch(month, /\/rest\/v1\/shifts/);
  assert.doesNotMatch(month, /atlas_private/);
});

test('full month editor remains responsive and preserves the Atlas design system', () => {
  const styles = css + editorCss;
  assert.match(styles, /var\(--atlas-surface\)/);
  assert.match(styles, /'Fraunces'/);
  assert.match(styles, /'IBM Plex Sans'/);
  assert.match(styles, /grid-template-columns:repeat\(7/);
  assert.match(styles, /overflow-x:auto/);
  assert.match(styles, /shift-month-publish/);
  assert.match(styles, /shift-month-add-day/);
  assert.match(styles, /@media\(max-width:1180px\)/);
  assert.match(styles, /@media\(max-width:820px\)/);
  assert.match(styles, /@media\(max-width:600px\)/);
  assert.match(styles, /@media\(max-width:420px\)/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(styles, /Caprasimo|Figtree|--color-accent-2/);
  assert.equal((styles.match(/{/g) || []).length, (styles.match(/}/g) || []).length);
});
