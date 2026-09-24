import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const bootstrap = readFileSync('apps/web/assets/js/inventory-scanner-bootstrap.js', 'utf8');
const scanner = readFileSync('apps/web/assets/js/inventory-scanner.js', 'utf8');
const css = readFileSync('apps/web/assets/css/inventory-scanner.css', 'utf8');

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('Checkpoint B loads from the isolated scanner API through its bootstrap', () => {
  assert.match(config, /INVENTORY_SCANNER_API:\s*"https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-inventory-scanner"/);
  assert.match(config, /assets\/js\/inventory-scanner-bootstrap\.js/);
  assert.match(bootstrap, /SCANNER_SCRIPT = 'assets\/js\/inventory-scanner\.js\?v=20260926-s88'/);
  assert.match(bootstrap, /window\.AtlasShell\.load\(SCANNER_SCRIPT/);
  assert.match(bootstrap, /SCANNER_STYLE = 'assets\/css\/inventory-scanner\.css'/);
  assert.equal(count(config, 'SUPABASE_ANON_KEY'), 1);
  assert.doesNotMatch(config + bootstrap + scanner, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('scanner bootstrap waits for the signed-in application shell', () => {
  assert.match(bootstrap, /appIsVisible/);
  assert.match(bootstrap, /#?login-screen|login-screen/);
  assert.match(bootstrap, /#?app-screen|app-screen/);
  assert.match(bootstrap, /window\.getComputedStyle\(app\)\.display !== 'none'/);
  assert.match(bootstrap, /if \(!appIsVisible\(\)/);
  assert.match(config, /bootstrap waits\s*\n?\/\/ until the authenticated application shell is visible|authenticated application shell is visible/);
});

test('scanner interaction layer prevents modal taps from being swallowed', () => {
  assert.match(bootstrap, /inventory-scanner-backdrop\{z-index:0!important/);
  assert.match(bootstrap, /inventory-scanner-panel\{z-index:1!important;pointer-events:auto!important/);
  assert.match(bootstrap, /touch-action:manipulation/);
  // S88: the scanner registers its own capture-phase handlers; the bootstrap no
  // longer replaces document.addEventListener while the scanner evaluates.
  for (const type of ['click', 'submit', 'input', 'change']) {
    assert.match(scanner, new RegExp(`document\\.addEventListener\\('${type}', handle\\w+, true\\)`));
  }
  assert.doesNotMatch(bootstrap, /document\.addEventListener\s*=|nativeDocumentAddEventListener/);
});

test('scanner no longer observes the page and its API requests time out', () => {
  // S88: no global MutationObserver or fetch replacement. Entry points are
  // re-checked on AtlasShell events and the scanner's own requests time out.
  assert.doesNotMatch(bootstrap, /window\.MutationObserver\s*=|window\.fetch\s*=|new MutationObserver/);
  assert.doesNotMatch(scanner, /new MutationObserver/);
  assert.match(scanner, /window\.AtlasShell\?\.on\?\.\('view:show', ensureEntryPoints\)/);
  assert.match(scanner, /SCANNER_TIMEOUT_MS = 15000/);
  assert.match(scanner, /new AbortController\(\)/);
  assert.match(scanner, /signal: controller\.signal/);
  assert.match(scanner, /scanner service took too long to respond/i);
});

test('scanner stepper and close controls are owned by the scanner (S38 fixes moved from remediation)', () => {
  assert.match(scanner, /function stepQuantity\(delta\)[\s\S]+?Math\.max\(0,[\s\S]+?dispatchEvent\(new Event\('change'/);
  assert.match(scanner, /inputmode="decimal" aria-label="Observed inventory quantity"/);
  assert.match(scanner, /target\.closest\('\[data-scanner-close\]'\)/);
  assert.match(scanner, /target\.closest\('\[data-scanner-step\]'\)/);
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
  assert.doesNotMatch(scanner, /(?:atlasSupabase|supabase|client)\s*\.\s*from\s*\(/i);
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
