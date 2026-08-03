import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const bridge = readFileSync('apps/web/assets/js/shifts-month-tab-bridge.js', 'utf8');
const weekly = readFileSync('apps/web/assets/js/shifts-workspace.js', 'utf8');
const month = readFileSync('apps/web/assets/js/shifts-month-calendar.js', 'utf8');

test('Month tab bridge is loaded with the Shifts month extension', () => {
  assert.match(config, /assets\/js\/shifts-month-tab-bridge\.js/);
  assert.match(config, /globalName:\s*'AtlasShiftsMonthTabBridge'/);
  assert.ok(config.indexOf('shifts-month-calendar.js') < config.indexOf('shifts-month-tab-bridge.js'));
});

test('bridge isolates Month from the older weekly bubbling handler', () => {
  assert.match(weekly, /document\.addEventListener\('click', handleClick\)/);
  assert.match(month, /document\.addEventListener\('click', handleClick, true\)/);
  assert.match(bridge, /\[data-shifts-tab=\"month\"\]/);
  assert.match(bridge, /host\.addEventListener\('click', protectMonthClick, true\)/);
  assert.match(bridge, /event\.preventDefault\(\)/);
  assert.match(bridge, /event\.stopPropagation\(\)/);
});

test('bridge has a safe fallback and no direct data access', () => {
  assert.match(bridge, /window\.AtlasShiftsMonth\?\.open\?\.\(\)/);
  assert.match(bridge, /window\.requestAnimationFrame/);
  assert.doesNotMatch(bridge, /SUPABASE_SERVICE_ROLE_KEY|\.from\s*\(|fetch\s*\(/);
});
