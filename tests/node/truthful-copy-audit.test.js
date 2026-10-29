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

test('L42: Menu Pricing never claims figures it does not have: no "saved" or built-in baseline', () => {
  const pricing = read('apps/web/assets/js/finance-pricing-workspace.js');
  assert.doesNotMatch(pricing, /saved baseline/i);
  // No business figures ship with the app (containment), so the copy may not
  // promise a built-in baseline; it says the figures come from the server.
  assert.doesNotMatch(pricing, /built-in launch baseline|bundled with the app\. Nothing/);
  assert.match(pricing, /The pricing profile \(rent, card fees, loan, overhead and VAT\) comes from the secure pricing service\./);
  assert.match(pricing, /Pricing figures are only available from the secure pricing service, which is not connected yet\. No prices were changed\./);
  assert.doesNotMatch(read('apps/web/assets/js/kanel-pricing-engine.js'), /launch baseline|planning inputs/);
});
