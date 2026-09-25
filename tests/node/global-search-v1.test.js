import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// S87 Global Search, S88 command palette (spec §4.6–4.7): one entry point,
// "Search or ask Atlas". atlas-search.js is the provider (records, "Go to"
// destinations, instant answers); atlas-palette.js renders it. Typing shows
// results only. Behaviour is covered end to end in
// tests/browser/search.browser.test.mjs and shell-ui.browser.test.mjs.
const shell = readFileSync('apps/web/index.html', 'utf8');
const search = readFileSync('apps/web/assets/js/atlas-search.js', 'utf8');
const palette = readFileSync('apps/web/assets/js/atlas-palette.js', 'utf8');
const home = readFileSync('apps/web/assets/js/home.js', 'utf8');
const business = readFileSync('apps/web/assets/js/business.js', 'utf8');

test('the top-bar field is a button that opens the palette; the palette owns the input', () => {
  assert.match(shell, /<button type="button" class="atlas-omni" id="atlas-omni" aria-haspopup="dialog"/);
  assert.match(shell, /<span class="atlas-omni__label">Search or ask Atlas<\/span>/);
  assert.doesNotMatch(shell, /id="global-search"/);
  assert.match(palette, /role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="atlas-palette-list"/);
  assert.match(shell, /<script src="assets\/js\/atlas-search\.js\?v=[^"]+"><\/script>\s*<script src="assets\/js\/atlas-chrome\.js\?v=[^"]+"><\/script>\s*<script src="assets\/js\/atlas-palette\.js\?v=[^"]+"><\/script>/);
});

test('no module navigates from a search field while typing', () => {
  for (const source of [shell, home, business]) {
    assert.doesNotMatch(source, /getElementById\('global-search'\)\??\.addEventListener\('input'/);
  }
  // Typing re-renders results; only Enter, click or tap runs a row.
  assert.match(palette, /input\.addEventListener\('input', \(\) => \{\s*state\.query = input\.value;/);
});

test('every former V1 keyword destination remains reachable from Go to', () => {
  // Top-level pages come from AtlasShell.nav; sections from the provider table.
  const shellJs = readFileSync('apps/web/assets/js/atlas-shell.js', 'utf8');
  for (const id of ['home', 'ai', 'messages', 'operations', 'inventory', 'recipes', 'purchasing', 'shifts', 'team', 'knowledge', 'reports', 'marketing', 'data', 'settings']) {
    assert.match(shellJs, new RegExp(`\\{ id: '${id}', label: '`), id);
  }
  for (const route of ['#inventory/movements', '#inventory/waste', '#inventory/counts', '#reports/overview', '#data/import-review', '#settings/notifications', '#settings/preferences', '#settings/system']) {
    assert.ok(search.includes(`'${route}'`), route);
  }
});

test('records are read through the shell accessor, never through eval', () => {
  assert.match(shell, /window\.AtlasData = Object\.freeze\(\{/);
  assert.doesNotMatch(search, /\bFunction\(|\beval\(/);
  assert.doesNotMatch(palette, /\bFunction\(|\beval\(/);
});

test('⌘K / Ctrl K and "/" open the palette; "/" never fires inside a field', () => {
  assert.match(palette, /\(event\.metaKey \|\| event\.ctrlKey\) && !event\.altKey && !event\.shiftKey && event\.key\.toLowerCase\(\) === 'k'/);
  assert.match(palette, /event\.key === '\/' && !event\.metaKey && !event\.ctrlKey && !event\.altKey && !state\.open && !isTyping\(event\.target\)/);
});

test('Ask Atlas routes to the Atlas AI workspace with the query', () => {
  assert.match(palette, /const route = `#ai\/new\$\{params \? `\?\$\{params\}` : ''\}`;/);
  assert.match(palette, /q=\$\{encodeURIComponent\(text\)\}/);
});
