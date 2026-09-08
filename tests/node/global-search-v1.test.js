import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shell = readFileSync('apps/web/index.html', 'utf8');

test('Global Search identifies itself as a navigation command field', () => {
  assert.match(shell, /id="global-search"/);
  assert.match(shell, /placeholder="Jump to pages or commands…  \/"/);
  assert.match(shell, /aria-label="Jump to a page or command"/);
  assert.match(shell, /Pages and commands only — operational records are not indexed\./);
  assert.match(shell, /data-search-scope="navigation"/);
});

test('recognized navigation keywords retain their V1 destinations', () => {
  for (const destination of [
    'recipes', 'suppliers', 'team', 'shifts', 'knowledge',
    'imports', 'inventory', 'reports', 'settings', 'dashboard'
  ]) {
    assert.match(shell, new RegExp(`setActiveView\\('${destination}'\\)`));
  }
});

test('unknown record-like queries do not pretend to search Inventory', () => {
  assert.doesNotMatch(shell, /q\.length\s*>\s*1\)\s*setActiveView\('inventory'\)/);
  assert.doesNotMatch(shell, /else\s+setActiveView\('inventory'\)/);
});

test('slash remains the keyboard shortcut for the command field', () => {
  assert.match(shell, /e\.key==='\/'/);
  assert.match(shell, /getElementById\('global-search'\)\.focus\(\)/);
});
