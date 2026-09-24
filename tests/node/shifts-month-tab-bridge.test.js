import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const index = readFileSync('apps/web/index.html', 'utf8');
const bridge = readFileSync('apps/web/assets/js/shifts-month-tab-bridge.js', 'utf8');
const weekly = readFileSync('apps/web/assets/js/shifts-workspace.js', 'utf8');
const month = readFileSync('apps/web/assets/js/shifts-month-calendar.js', 'utf8');

test('Month bridge loads after the monthly workspace', () => {
  assert.match(config, /assets\/js\/shifts-month-tab-bridge\.js/);
  assert.match(config, /globalName:\s*'AtlasShiftsMonthTabBridge'/);
  assert.ok(config.indexOf('shifts-month-calendar.js') < config.indexOf('shifts-month-tab-bridge.js'));
});

test('production loads weekly, Month, and bridge assets in deterministic dependency order', () => {
  const weeklyCss = index.indexOf('assets/css/shifts-workspace.css');
  const monthCss = index.indexOf('assets/css/shifts-month-calendar.css');
  const editorCss = index.indexOf('assets/css/shifts-month-editor.css');
  const remediationCss = index.indexOf('assets/css/s38-app-remediation.css');
  const weeklyJs = index.indexOf('assets/js/shifts-workspace.js');
  const monthJs = index.indexOf('assets/js/shifts-month-calendar.js');
  const bridgeJs = index.indexOf('assets/js/shifts-month-tab-bridge.js');

  assert.ok(weeklyCss >= 0 && weeklyCss < monthCss && monthCss < editorCss && editorCss < remediationCss);
  assert.ok(weeklyJs >= 0 && weeklyJs < monthJs && monthJs < bridgeJs);
});

test('the Month tab has one owner and the weekly planner only falls back', () => {
  // S88: the bridge no longer stops propagation. Month owns the tab in the
  // capture phase; the weekly bubbling handler opens Month only if that did not
  // happen (the check the bridge used to make).
  assert.match(weekly, /document\.addEventListener\('click', handleClick\)/);
  assert.match(month, /document\.addEventListener\('click', handleClick, true\)/);
  assert.doesNotMatch(bridge, /addEventListener\('click'|stopPropagation/);
  assert.match(weekly, /if \(tab\.dataset\.shiftsTab === 'month'\) \{\s+event\.preventDefault\(\);/);
  assert.match(weekly, /element\.classList\.contains\('shifts-month-active'\) && element\.querySelector\('\[data-shifts-month-panel\]'\)/);
  assert.match(weekly, /window\.AtlasShiftsMonth\?\.open\?\.\(\)/);
  assert.match(month, /state\.active = true/);
  assert.match(month, /window\.setTimeout\(\(\) => loadMonth\(\), 0\)/);
});

test('the monthly calendar is the sole owner of Month actions and submissions', () => {
  for (const selector of [
    'data-shifts-month-add',
    'data-shifts-month-add-day',
    'data-shifts-month-refresh',
    'data-shifts-month-publish',
    'data-shifts-month-open-week',
    'data-shifts-month-edit',
    'data-shifts-month-remove',
    'data-shifts-month-close'
  ]) {
    assert.match(month, new RegExp(selector));
  }
  assert.match(month, /document\.addEventListener\('click', handleClick, true\)/);
  assert.match(month, /document\.addEventListener\('submit', handleSubmit, true\)/);
  assert.doesNotMatch(bridge, /window\.addEventListener\('click'/);
  assert.doesNotMatch(bridge, /window\.addEventListener\('submit'/);
  assert.doesNotMatch(bridge, /stopImmediatePropagation/);
});

test('Add shift and Save shift use the authenticated monthly gateway', () => {
  assert.match(month, /function openShiftEditor\(date\)/);
  assert.match(month, /openShiftEditor\(addDay\.dataset\.shiftsMonthAddDay\)/);
  assert.match(month, /data-shifts-month-shift-form/);
  assert.match(month, /mutate\('save-shift'/);
  assert.match(month, /week_start:\s*mondayFor\(startDate\)/);
  assert.match(month, /authorization: `Bearer \$\{session\.access_token\}`/);
});

test('Refresh, publish, edit, remove and weekly navigation stay in the monthly calendar', () => {
  assert.match(month, /data-shifts-month-refresh/);
  assert.match(month, /mutate\('publish-month'/);
  assert.match(month, /mutate\('cancel-shift'/);
  assert.match(month, /data-shifts-month-edit/);
  assert.match(month, /function navigateToWeek/);
  assert.match(month, /dataset\.shiftsWeek/);
});

test('bridge contains no privileged key or direct table access', () => {
  assert.doesNotMatch(bridge, /SUPABASE_SERVICE_ROLE_KEY|\.from\s*\(|atlas_private\.|public\.shifts/);
  assert.doesNotMatch(bridge, /SHIFTS_API|fetch\s*\(/);
  assert.match(bridge, /touch-action:manipulation/);
  assert.match(bridge, /pointer-events:auto!important/);
});
