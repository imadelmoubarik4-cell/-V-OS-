import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../apps/web/assets/js/shifts-month-calendar.js', import.meta.url), 'utf8');
const apply = source.slice(source.indexOf('  function apply() {'), source.indexOf('  function scheduleApply()'));

// S88: Month no longer observes the Shifts host. The weekly planner announces
// each render ('shifts:rendered') and apply() re-attaches then, so a Month
// render (including Lucide icon replacement) can never schedule itself.
test('month render cannot schedule itself and always syncs the body state', () => {
  let renders = 0, synced = 0;
  const element = { querySelector: () => ({}), classList: { toggle() {} } };
  const state = { active: true, monthStart: '2026-09-01', loading: false,
    workspace: { month: { month_start: '2026-09-01' } } };
  const scope = { host: () => element, state, ensureMonthTab() {},
    renderPanel() { renders++; }, syncBodyState() { synced++; } };
  vm.createContext(scope);
  vm.runInContext(apply + '\napply();', scope);
  assert.equal(renders, 1);
  assert.equal(synced, 1, 'body.s38-month-active follows every apply');
  assert.doesNotMatch(apply, /observer|MutationObserver/, 'apply() does not pause or resume an observer');
  scope.renderPanel = () => { throw new Error('render failed'); };
  assert.throws(() => vm.runInContext('apply();', scope), /render failed/);
  assert.equal(synced, 2, 'the body state is synced even when rendering fails');
});

test('Month re-attaches on the weekly render event instead of a MutationObserver', () => {
  assert.doesNotMatch(source, /new MutationObserver/);
  assert.match(source, /window\.AtlasShell\?\.on\?\.\('shifts:rendered', scheduleApply\)/);
  const weekly = fs.readFileSync(new URL('../../apps/web/assets/js/shifts-workspace.js', import.meta.url), 'utf8');
  assert.match(weekly, /window\.AtlasShell\?\.emit\?\.\('shifts:rendered', \{ host: element \}\)/);
});
