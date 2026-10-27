// Audit L32, L41, L42: copy that promised behaviour the platform does not have.
// Rendered behaviour is checked in tests/browser/truthful-copy.browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(file, 'utf8');

test('L32: the venue Language is read-only and saved unchanged', () => {
  const settings = read('apps/web/assets/js/settings-workspace.js');
  assert.doesNotMatch(settings, /select\('primary_language'/, 'no editable venue Language select');
  assert.doesNotMatch(settings, /fieldValue\(form, 'primary_language'\)/);
  assert.match(settings, /primary_language: current\.primary_language \|\| 'en',/);
  assert.match(settings, /<dt>Language<\/dt><dd data-settings-venue-language>/);
});

test('L41: with file reading off, Data stores files and promises no import', () => {
  const data = read('apps/web/assets/js/data-workspace.js');
  assert.match(read('apps/web/config.js'), /IMPORT_WORKER_API:\s*""/, 'production still ships reading off');
  assert.match(data, /return readingOn\(\) \? 'Import a file' : 'Store a file';/);
  assert.match(data, /label: uploadLabel\(\), icon: 'upload'/);
  assert.match(data, /const steps = storedOnly \? '' :/);
  assert.match(data, /title: 'File reading is off\.'/);
  // The activation gate itself is unchanged.
  assert.match(data, /cfg\.IMPORT_WORKER_API === `\$\{target\}\/functions\/v1\/atlas-import-worker` \? cfg\.IMPORT_WORKER_API : ''/);
});

test('L42: Menu Pricing names its baseline as the built-in launch baseline, never "saved"', () => {
  const pricing = read('apps/web/assets/js/finance-pricing-workspace.js');
  assert.doesNotMatch(pricing, /saved baseline/i);
  assert.match(pricing, /KANEL’s built-in launch baseline \(October 2026 planning figures/);
  assert.match(pricing, /over the built-in launch baseline \(October 2026 planning figures\), not live menu prices/);
  // The figures really are the engine's built-in profile.
  assert.match(read('apps/web/assets/js/kanel-pricing-engine.js'), /KANEL launch baseline \(October 2026 planning inputs\)/);
});
