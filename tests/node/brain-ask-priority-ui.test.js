import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const brain = readFileSync('apps/web/assets/js/brain.js', 'utf8');
const daily = readFileSync('apps/web/assets/js/brain-daily-briefing-v2.js', 'utf8');
const phase3 = readFileSync('apps/web/assets/js/brain-phase3.js', 'utf8');
const shell = readFileSync('apps/web/index.html', 'utf8');

test('Ask Atlas appears directly after the Brain hero and before summary dashboards', () => {
  const hero = brain.indexOf('<header class="brain-hero">');
  const assistant = brain.indexOf('<section class="brain-card brain-ask-card">');
  const metrics = brain.indexOf('<section class="brain-metric-grid"');
  const intelligence = brain.indexOf('<div class="brain-intelligence-grid">');

  assert.ok(hero >= 0);
  assert.ok(hero < assistant);
  assert.ok(assistant < metrics);
  assert.ok(metrics < intelligence);
});

test('dynamic Brain dashboards preserve Ask Atlas as the first panel', () => {
  assert.match(daily, /const assistant = shell\.querySelector\('\.brain-ask-card'\)/);
  assert.match(daily, /if \(assistant\) assistant\.insertAdjacentElement\('afterend', next\)/);
  assert.match(phase3, /const daily = shell\.querySelector\('\[data-daily-briefing\]'\)/);
  assert.match(phase3, /const assistant = shell\.querySelector\('\.brain-ask-card'\)/);
  assert.match(phase3, /if \(daily\) daily\.insertAdjacentElement\('afterend', next\)/);
  assert.match(phase3, /else if \(assistant\) assistant\.insertAdjacentElement\('afterend', next\)/);
});

test('production shell cache-busts the reordered Brain bundle', () => {
  assert.match(shell, /assets\/js\/brain\.js\?v=20260917-s53/);
});
