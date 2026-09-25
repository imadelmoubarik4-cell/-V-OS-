import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// S64F fixed a render loop driven by a class-attribute MutationObserver. Since
// S88 the shell tells Settings when it opens (registerView render), so there is
// no observer to settle; render only removes the placeholder class, which is
// idempotent and never re-triggers rendering.
const source = fs.readFileSync(new URL('../../apps/web/assets/js/settings-workspace.js', import.meta.url), 'utf8');
test('Settings rendering needs no DOM observer and cannot loop', () => {
  assert.doesNotMatch(source, /MutationObserver/);
  const render = source.slice(source.indexOf('  function render() {'), source.indexOf('  function formKey'));
  assert.match(render, /element\.classList\.remove\('placeholder-view'\)/);
  assert.doesNotMatch(render, /classList\.add\(/);
  assert.match(source, /registerView\?\.\('settings', \{ root: 'settings-view', title: 'Settings', render: \(params\) => show\(params\) \}\)/);
});
