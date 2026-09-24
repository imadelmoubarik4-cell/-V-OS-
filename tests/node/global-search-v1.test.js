import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// S87: Global Search is owned by one module (atlas-search.js). Typing shows
// results only; the removed per-keystroke keyword handlers navigated away
// mid-word and three of them fired at once. Behaviour is covered end to end in
// tests/browser/search.browser.test.mjs; these checks pin the wiring.
const shell = readFileSync('apps/web/index.html', 'utf8');
const search = readFileSync('apps/web/assets/js/atlas-search.js', 'utf8');
const brain = readFileSync('apps/web/assets/js/brain.js', 'utf8');
const business = readFileSync('apps/web/assets/js/business.js', 'utf8');

test('Global Search is a records-and-questions field owned by atlas-search.js', () => {
  assert.match(shell, /id="global-search"/);
  assert.match(shell, /placeholder="Search or ask Atlas…"/);
  assert.match(shell, /aria-label="Search Atlas or ask a question"/);
  assert.match(shell, /data-search-scope="records"/);
  assert.match(shell, /<script src="assets\/js\/atlas-search\.js\?v=[^"]+"><\/script>/);
});

test('no module navigates from the search field while typing', () => {
  for (const source of [shell, brain, business]) {
    assert.doesNotMatch(source, /getElementById\('global-search'\)\??\.addEventListener\('input'/);
  }
});

test('every former V1 keyword destination remains reachable as a page result', () => {
  for (const destination of ['recipes', 'suppliers', 'team', 'team-profiles', 'shifts', 'knowledge', 'imports', 'movements', 'waste', 'inventory', 'reports', 'settings', 'dashboard', 'brain', 'business']) {
    assert.match(search, new RegExp(`\\['${destination}', '`));
  }
});

test('records are read through the shell accessor, never through eval', () => {
  assert.match(shell, /window\.AtlasData = Object\.freeze\(\{/);
  assert.doesNotMatch(search, /\bFunction\(|\beval\(/);
});

test('slash remains the keyboard shortcut for the search field', () => {
  assert.match(shell, /e\.key==='\/'/);
  assert.match(shell, /getElementById\('global-search'\)\.focus\(\)/);
});
