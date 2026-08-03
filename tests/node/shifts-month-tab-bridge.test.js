import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const bridge = readFileSync('apps/web/assets/js/shifts-month-tab-bridge.js', 'utf8');
const weekly = readFileSync('apps/web/assets/js/shifts-workspace.js', 'utf8');
const month = readFileSync('apps/web/assets/js/shifts-month-calendar.js', 'utf8');

test('Month bridge loads after the monthly workspace', () => {
  assert.match(config, /assets\/js\/shifts-month-tab-bridge\.js/);
  assert.match(config, /globalName:\s*'AtlasShiftsMonthTabBridge'/);
  assert.ok(config.indexOf('shifts-month-calendar.js') < config.indexOf('shifts-month-tab-bridge.js'));
});

test('bridge keeps the Month tab separate from the weekly bubbling handler', () => {
  assert.match(weekly, /document\.addEventListener\('click', handleClick\)/);
  assert.match(month, /document\.addEventListener\('click', handleClick, true\)/);
  assert.match(bridge, /\[data-shifts-tab=\"month\"\]/);
  assert.match(bridge, /host\.addEventListener\('click', protectMonthTab, true\)/);
  assert.match(bridge, /event\.preventDefault\(\)/);
  assert.match(bridge, /event\.stopPropagation\(\)/);
});

test('every visible Month action has a window-capture fallback', () => {
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
    assert.match(bridge, new RegExp(selector));
  }
  assert.match(bridge, /window\.addEventListener\('click', handleMonthAction, true\)/);
  assert.match(bridge, /window\.addEventListener\('submit', handleMonthSubmit, true\)/);
  assert.match(bridge, /event\.stopImmediatePropagation\?\.\(\)/);
});

test('Add shift and Save shift use the authenticated Shifts gateway', () => {
  assert.match(bridge, /window\.AtlasShiftsMonth\?\.addShift\?\.\(targetDate\)/);
  assert.match(bridge, /data-shifts-month-shift-form/);
  assert.match(bridge, /shiftsApi\('save-shift'/);
  assert.match(bridge, /week_start:\s*mondayFor\(startDate\)/);
  assert.match(bridge, /authorization:\s*`Bearer \$\{session\.access_token\}`/);
});

test('Refresh, publish, edit, remove and weekly navigation are restored', () => {
  assert.match(bridge, /window\.AtlasShiftsMonth\?\.refresh\?\.\(\)/);
  assert.match(bridge, /shiftsApi\('publish-month'/);
  assert.match(bridge, /shiftsApi\('cancel-shift'/);
  assert.match(bridge, /function openEditShift/);
  assert.match(bridge, /function openWeeklyPlanner/);
  assert.match(bridge, /dataset\.shiftsWeek/);
});

test('bridge contains no privileged key or direct table access', () => {
  assert.doesNotMatch(bridge, /SUPABASE_SERVICE_ROLE_KEY|\.from\s*\(|atlas_private\.|public\.shifts/);
  assert.match(bridge, /SHIFTS_API/);
  assert.match(bridge, /touch-action:manipulation/);
  assert.match(bridge, /pointer-events:auto!important/);
});
