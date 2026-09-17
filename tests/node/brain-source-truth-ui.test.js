import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const brain = readFileSync('apps/web/assets/js/brain.js', 'utf8');
const briefing = readFileSync('apps/web/assets/js/brain-daily-briefing-v2.js', 'utf8');
const css = readFileSync('apps/web/assets/css/brain.css', 'utf8');
const shell = readFileSync('apps/web/index.html', 'utf8');

test('zero staged rows are not presented as measured maturity', () => {
  assert.match(briefing, /function privateMaturityMarkup\(summary\)/);
  assert.match(briefing, /if \(!staged\)/);
  assert.match(briefing, /Private review maturity/);
  assert.match(briefing, /<strong>Not available<\/strong>/);
  assert.match(briefing, /No staged private records/);
  assert.match(briefing, /No staged private review records are available yet/);
});

test('browser-loaded workspace data is not called live source connectivity', () => {
  assert.match(brain, /function workspaceCoverage\(\)/);
  assert.match(brain, /Workspace data available/);
  assert.match(brain, /Workspace availability/);
  assert.match(brain, /available in this session/);
  assert.match(brain, /Available in this session/);
  assert.match(css, /\.brain-data-dot\.available/);
  assert.doesNotMatch(brain, /Live data sources connected/);
  assert.doesNotMatch(brain, /sources connected/);
});

test('production shell cache-busts the truthful Brain bundle', () => {
  assert.match(shell, /assets\/js\/brain\.js\?v=20260917-s54/);
});
