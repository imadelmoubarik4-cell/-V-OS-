// Shifts (#shifts, spec §7.9, §8.4): one canonical module for the week planner
// and the month calendar. S88 merged shifts-month-calendar.js and its tab
// bridge into shifts-workspace.js; this file carries their coverage (Monday-
// first month grid, month editing and publishing, gateway boundary).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const config = readFileSync('apps/web/config.js', 'utf8');
const index = readFileSync('apps/web/index.html', 'utf8');
const shifts = readFileSync('apps/web/assets/js/shifts-workspace.js', 'utf8');
const css = readFileSync('apps/web/assets/css/shifts-workspace.css', 'utf8');
const gateway = readFileSync('supabase/functions/atlas-shifts/index.ts', 'utf8');
const migration = readFileSync('supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql', 'utf8');
const publishFix = readFileSync('supabase/migrations/20260803225245_atlas_shifts_month_publish_complete_weeks.sql', 'utf8');

test('Shifts loads from the isolated Shifts API as one module', () => {
  assert.match(config, /SHIFTS_API:\s*"https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-shifts"/);
  assert.match(config, /assets\/js\/shifts-workspace\.js/);
  assert.match(config, /assets\/css\/shifts-workspace\.css/);
  assert.match(config, /AtlasShifts/);
  for (const retired of ['assets/js/shifts-month-calendar.js', 'assets/js/shifts-month-tab-bridge.js', 'assets/css/shifts-month-calendar.css', 'assets/css/shifts-month-editor.css', 'assets/css/legacy/shifts-month-tab-bridge--shifts-month.css']) {
    assert.ok(!existsSync(`apps/web/${retired}`), `${retired} is deleted`);
    assert.doesNotMatch(config + index, new RegExp(retired.split('/').pop().replace('.', '\\.')));
  }
  assert.match(index, /<script src="assets\/js\/shifts-workspace\.js\?v=20260926-s88"><\/script>/);
});

test('routes: week, month, availability, time off, confirmations, activity', () => {
  assert.match(shifts, /registerView\('shifts', \{ root: \(\) => document\.getElementById\('shifts-view'\), title: 'Shifts', render, onHide: hide \}\)/);
  for (const key of ['schedule', 'availability', 'time-off', 'confirmations', 'activity']) assert.match(shifts, new RegExp(`key: '${key}'`));
  assert.match(shifts, /if \(section === 'month'\) \{ state\.tab = 'schedule'; state\.mode = 'month'; \}/);
  assert.match(shifts, /if \(valid\(params\.week\)\) state\.weekStart = mondayOf\(params\.week\);/);
  assert.match(shifts, /params\.section = 'month';/);
  assert.match(shifts, /\{ key: 'confirmations', label: 'Confirmations', manager: true \}/);
  assert.match(shifts, /\{ key: 'activity', label: 'Activity', manager: true \}/);
});

test('header: summary line, week navigator, Week · Month, one primary Publish', () => {
  assert.match(shifts, /<h1 class="page-head__title">Shifts<\/h1>/);
  assert.match(shifts, /awaiting confirmation/);
  assert.match(shifts, /data-shifts-step="-1" aria-label="Previous \$\{month \? 'month' : 'week'\}"/);
  assert.match(shifts, /data-shifts-today>Today</);
  assert.match(shifts, /aria-label="Calendar view"><button type="button" data-shifts-mode="week"/);
  assert.match(shifts, /const publishLabel = month \? 'Publish month' : 'Publish week';/);
  assert.match(shifts, /'No changes to publish'/);
  assert.match(shifts, /changed since publishing/);
  // No hero, KPI cards, trust footer, Refresh or Shift handover buttons (spec §7.9).
  assert.doesNotMatch(shifts, /shifts-hero|shift-summary-grid|shift-trust|data-shifts-refresh|data-shifts-handover|People operations/);
});

test('draft versus published is shown in words and on each changed shift', () => {
  assert.match(shifts, /pill\('Draft \\u00b7 not visible to the team', 'warning'\)|Draft · not visible to the team/);
  assert.match(shifts, /Published · changes not published|Published \\u00b7 changes not published/);
  assert.match(shifts, /function isUnpublished\(shift, ws\)/);
  assert.match(shifts, /shift\.last_published_revision == null/);
  assert.match(css, /\.shift-chip\.is-unpublished \{ border-style: dashed;/);
  assert.match(shifts, /Dashed: not published yet/);
});

test('new shifts start at the saved opening time, never a literal default', () => {
  assert.match(shifts, /function defaultStart\(dateKey\)/);
  assert.match(shifts, /window_\?\.state === 'open' && window_\.open\) return \{ time: vc\(\)\.formatTime\(window_\.open\)/);
  assert.match(shifts, /Business hours are not set \\u2014 enter a start time\.|Business hours are not set — enter a start time\./);
  assert.doesNotMatch(shifts, /11:30|17:00:00|T11:30|T17:00/);
  // Overnight: an end before the start ends the next day.
  assert.match(shifts, /const endDate = endValue < startValue \? addDays\(dateValue, 1\) : dateValue;/);
  assert.match(shifts, /Ends the next day\./);
});

test('who is working today and tomorrow uses the venue business date', () => {
  assert.match(shifts, /function businessDateOf\(shift\)[\s\S]+?vc\(\)\?\.businessDate\?\.\(shift\.starts_at\)/);
  assert.match(shifts, /function whoIsOn\(dateKey, ws = state\.week\.workspace\)[\s\S]+?businessDateOf\(shift\) === dateKey/);
  assert.match(shifts, /\[\[today\(\), 'Today'\], \[addDays\(today\(\), 1\), 'Tomorrow'\]\]/);
  assert.match(shifts, /whoIsOn: \(dateKey = today\(\)\) => whoIsOn\(dateKey\)/);
  // No duplicate venue-date helper or literal zone (Atlas_Time_Migration.md, Team D).
  assert.doesNotMatch(shifts, /Atlantic\/Reykjavik|function venueDate\(|toLocaleDateString|getDay\(\)|getHours\(\)/);
});

test('month calendar: Monday-first grid, day sheet, month editing and publishing', () => {
  assert.match(shifts, /const WEEK_ORDER = \[1, 2, 3, 4, 5, 6, 0\];/);
  assert.match(shifts, /const gridStart = mondayOf\(first\);/);
  assert.match(shifts, /const gridEnd = addDays\(mondayOf\(last\), 6\);/);
  assert.match(shifts, /api\('month-snapshot', \{ params: \{ month_start: key \} \}\)/);
  assert.match(shifts, /function openDaySheet\(dateKey\)/);
  assert.match(shifts, /No one scheduled/);
  assert.match(shifts, /mutate\('publish-month', \{ month_start: state\.monthStart/);
  assert.match(shifts, /body: monthMode \? \{ current_month: state\.monthStart, \.\.\.body \} : \{ current_week: state\.weekStart, \.\.\.body \}/);
  assert.match(shifts, /week_start: mondayOf\(dateValue\)/);
  assert.match(gateway, /action === "month-snapshot"/);
  assert.match(gateway, /case "publish-month"/);
  assert.match(gateway, /atlas_shifts_month_snapshot/);
  assert.match(gateway, /atlas_shifts_publish_month/);
  assert.match(migration, /shift_month_publications/);
  assert.match(migration, /staff_visibility','latest_published_month_revision/);
  assert.match(publishFix, /generate_series\(grid_start,grid_end,interval '7 days'\)/);
});

test('week planning: add, edit, remove, copy last week and publish', () => {
  for (const hook of ['data-shifts-add', 'data-shifts-edit', 'data-shifts-remove', 'data-shifts-copy', 'data-shifts-publish', 'data-shifts-shift-form']) assert.match(shifts, new RegExp(hook));
  assert.match(shifts, /mutate\('save-shift'/);
  assert.match(shifts, /mutate\('cancel-shift', \{ shift_id: shift\.id \}/);
  assert.match(shifts, /mutate\('copy-week', \{ source_week: source, target_week: state\.weekStart \}/);
  assert.match(shifts, /mutate\('publish-week', \{ week_start: state\.weekStart/);
  assert.match(shifts, /Copy last week/);
  assert.match(shifts, /No shifts this week/);
  // Decisions use design-system dialogs, not browser prompts.
  assert.doesNotMatch(shifts, /window\.(prompt|confirm|alert)\(/);
});

test('staff: my shifts with Confirm, team view, availability and time off', () => {
  assert.match(shifts, /data-shifts-staff-view="mine"/);
  assert.match(shifts, /data-shifts-staff-view="team"/);
  assert.match(shifts, /data-shifts-respond="confirmed"/);
  assert.match(shifts, /data-shifts-respond="change_requested"/);
  assert.match(shifts, /mutate\('respond', \{ shift_id: shiftId, response, note \}/);
  assert.match(shifts, /data-shifts-availability-form/);
  assert.match(shifts, /role="switch" aria-checked="\$\{available\}"/);
  assert.match(shifts, /mutate\('save-availability'/);
  assert.match(shifts, /data-shifts-time-off-form/);
  assert.match(shifts, /mutate\('request-time-off'/);
  assert.match(shifts, /data-shifts-time-off-decision/);
  assert.match(shifts, /data-shifts-response-decision/);
  assert.match(shifts, /This part of Shifts is for managers/);
});

test('handover lives in Messages and Shifts links to it', () => {
  assert.match(shifts, /href="#messages\/shift-handover"/);
});

test('browser uses the authenticated gateway and keeps production shifts untouched', () => {
  assert.match(shifts, /window\.atlasSupabase/);
  assert.match(shifts, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.match(gateway, /production_shift_sync_enabled:\s*false/);
  assert.doesNotMatch(gateway, /\/rest\/v1\/shifts/);
  assert.doesNotMatch(config + shifts, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(shifts, /(?:atlasSupabase|supabase|client)\s*\.\s*from\s*\(/i);
  assert.doesNotMatch(shifts, /atlas_private/);
});

test('date keys: weeks, months and labels come from AtlasVenueClock arithmetic', () => {
  const start = shifts.indexOf('  function monthStartOf(key) {');
  const end = shifts.indexOf('  function weekday(key) {');
  const scope = {};
  vm.createContext(scope);
  vm.runInContext(shifts.slice(start, end), scope);
  assert.equal(scope.monthStartOf('2026-09-24'), '2026-09-01');
  assert.equal(scope.addMonths('2026-12-01', 1), '2027-01-01');
  assert.equal(scope.addMonths('2026-01-01', -1), '2025-12-01');
  assert.match(shifts, /return vc\(\)\.addDays\(key, n\);/);
  assert.match(shifts, /return vc\(\)\.startOfWeek\(key\);/);
});

test('module stylesheet: one atlas.modules layer, tokens only, nothing under 12 px', () => {
  assert.equal((css.match(/@layer/g) || []).length, 1);
  assert.match(css, /@layer atlas\.modules \{/);
  assert.doesNotMatch(css, /!important|:root|#[0-9a-f]{3,6}\b/i);
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[01])px/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
  for (const fragment of ['s34-preproduction--shifts', 's38-app-remediation--shifts', 's38-app-remediation--shifts-month', 'workspaces-polish--shifts', 'workspaces-polish--shifts-month', 'polish-pass2--shifts-month', 'atlas-glass--shifts-month']) {
    assert.ok(!existsSync(`apps/web/assets/css/legacy/${fragment}.css`), `${fragment} is deleted`);
    assert.doesNotMatch(index, new RegExp(fragment));
  }
});
