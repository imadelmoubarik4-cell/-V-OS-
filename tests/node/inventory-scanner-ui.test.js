import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const scanner = readFileSync('apps/web/assets/js/inventory-scanner.js', 'utf8');
const css = readFileSync('apps/web/assets/css/inventory-scanner.css', 'utf8');

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('Checkpoint B loads from the isolated scanner API', () => {
  assert.match(config, /INVENTORY_SCANNER_API:\s*"https:\/\/uhbamqetppqmygesoeeh\.supabase\.co\/functions\/v1\/atlas-inventory-scanner"/);
  assert.match(config, /assets\/js\/inventory-scanner\.js/);
  assert.match(config, /assets\/css\/inventory-scanner\.css/);
  assert.equal(count(config, 'SUPABASE_ANON_KEY'), 1);
  assert.doesNotMatch(config + scanner, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('scanner supports phone camera, native detection and pinned ZXing fallback', () => {
  assert.match(scanner, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(scanner, /window\.isSecureContext/);
  assert.match(scanner, /BarcodeDetector/);
  assert.match(scanner, /@zxing\/browser@0\.2\.1\/\+esm/);
  assert.match(scanner, /decodeFromVideoDevice/);
  assert.match(scanner, /facingMode:\s*\{ ideal: 'environment' \}/);
  assert.match(scanner, /playsinline/);
});

test('barcode photos are processed locally and manual entry remains available', () => {
  assert.match(scanner, /createImageBitmap/);
  assert.match(scanner, /decodeFromImageUrl/);
  assert.match(scanner, /URL\.createObjectURL/);
  assert.match(scanner, /Camera frames and uploaded barcode photos are processed on this device/);
  assert.match(scanner, /data-scanner-manual-form/);
  assert.doesNotMatch(scanner, /storage\.from|upload\s*\(/i);
});

test('unmatched codes require a confirmed manager link', () => {
  assert.match(scanner, /A manager must link this barcode/);
  assert.match(scanner, /Confirm barcode link/);
  assert.match(scanner, /state\.staff\?\.can_link/);
  assert.match(scanner, /Atlas will never infer a product from an uncertain image match/);
});

test('preview counts are visibly shadow-only until live apply is enabled', () => {
  assert.match(scanner, /Preview · no live quantity change/);
  assert.match(scanner, /Test count safely/);
  assert.match(scanner, /Live inventory will remain unchanged/);
  assert.match(scanner, /payload\.mode === 'shadow'/);
});

test('browser scanner uses the authenticated API and no direct table writes', () => {
  assert.match(scanner, /api\('lookup'/);
  assert.match(scanner, /api\('link'/);
  assert.match(scanner, /api\('count'/);
  assert.doesNotMatch(scanner, /\.from\s*\(/);
  assert.doesNotMatch(scanner, /adjust_inventory/);
  assert.doesNotMatch(scanner, /inventory_scan_aliases|inventory_scan_events/);
});

test('scanner preserves the original Atlas design and responsive mobile layout', () => {
  assert.match(css, /var\(--atlas-surface\)/);
  assert.match(css, /'Fraunces'/);
  assert.match(css, /'IBM Plex Sans'/);
  assert.match(css, /@media\(max-width:650px\)/);
  assert.match(css, /@media\(max-width:420px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /Caprasimo|Figtree|--color-accent-2/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
