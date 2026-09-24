import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const reports = readFileSync('apps/web/assets/js/reports-workspace.js', 'utf8');
const business = readFileSync('apps/web/assets/js/business.js', 'utf8');
const config = readFileSync('apps/web/config.js', 'utf8');
const shell = readFileSync('apps/web/index.html', 'utf8');

test('Reports presents source coverage without contradicting partial live sources', () => {
  assert.match(reports, /availableSources = connectedSources \+ partialSources/);
  assert.match(reports, /sources available · \$\{connectedSources\} fully connected/);
  assert.doesNotMatch(reports, /\$\{activeSources\}\/\$\{totalSources\} sources connected/);
});

test('Reports handles empty refresh sentinels and switches sections immediately', () => {
  assert.match(reports, /date\.getUTCFullYear\(\) <= 1970/);
  assert.match(reports, /aria-current="page"/);
  assert.match(reports, /function changeSection[\s\S]+?render\(\);[\s\S]+?loadSnapshot/);
});

test('Business Intelligence coverage copy agrees with each displayed state', () => {
  assert.match(business, /status: inventoryReady \? 'connected' : inventoryLoaded \? 'incomplete'/);
  assert.match(business, /Inventory is connected; current cost data is still required/);
  assert.match(business, /status: recipesReady \? 'connected' : recipesLoaded \? 'incomplete'/);
  assert.match(business, /No costed restock movements are recorded/);
  assert.doesNotMatch(business, /connected: false, note: 'Live from/);
});

test('BI period state and report search expose accessible names and selection', () => {
  assert.match(business, /aria-pressed="\$\{state\.periodDays === entry\.value\}"/);
  assert.match(reports, /aria-label="Search the current report"/);
});

test('production loads the S60 Reports and BI assets with a cache key', () => {
  assert.match(config, /reports-workspace\.js\?v=20260917-s60/);
  assert.match(shell, /business\.js\?v=20260917-s60/);
  assert.match(shell, /business\.css\?v=20260926-s88/);
});
