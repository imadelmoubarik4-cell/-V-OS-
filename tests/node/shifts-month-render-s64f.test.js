import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../apps/web/assets/js/shifts-month-calendar.js', import.meta.url), 'utf8');
const apply = source.slice(source.indexOf('  function apply() {'), source.indexOf('  function scheduleApply()'));

test('month render ignores its own icon mutations and resumes observing external changes', () => {
  let observing = true, queued = 0, renders = 0;
  const element = { querySelector: () => ({}), classList: { toggle() {} } };
  const state = { active: true, monthStart: '2026-09-01', loading: false,
    workspace: { month: { month_start: '2026-09-01' } },
    observer: { disconnect() { observing = false; }, observe() { observing = true; } } };
  const scope = { host: () => element, state, ensureMonthTab() {},
    renderPanel() { renders++; if (observing) queued++; } };
  vm.createContext(scope);
  vm.runInContext(apply + '\napply();', scope);
  assert.equal(renders, 1);
  assert.equal(queued, 0, 'render must not schedule itself from icon replacement');
  assert.equal(observing, true, 'external workspace changes must remain observable');
  scope.renderPanel = () => { throw new Error('render failed'); };
  assert.throws(() => vm.runInContext('apply();', scope), /render failed/);
  assert.equal(observing, true, 'observer must recover even when rendering fails');
});
