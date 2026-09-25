import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

// S88 visual inventory: one shared capture module (assets/js/atlas-capture.js)
// replaces the Checkpoint B scanner (inventory-scanner.js and its bootstrap).
// It consumes the atlas-inventory-recognition contract and never writes stock.
const config = readFileSync('apps/web/config.js', 'utf8');
const index = readFileSync('apps/web/index.html', 'utf8');
const capture = readFileSync('apps/web/assets/js/atlas-capture.js', 'utf8');
const inventory = readFileSync('apps/web/assets/js/atlas-inventory.js', 'utf8');
const counts = readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8');
const purchasing = readFileSync('apps/web/assets/js/atlas-purchasing.js', 'utf8');
const css = readFileSync('apps/web/assets/css/inventory.css', 'utf8');

test('the old scanner and its bootstraps are retired, with no references left', () => {
  for (const file of [
    'apps/web/assets/js/inventory-scanner.js', 'apps/web/assets/js/inventory-scanner-bootstrap.js',
    'apps/web/assets/js/stock-count-bootstrap.js', 'apps/web/assets/css/inventory-scanner.css',
  ]) assert.equal(existsSync(file), false, `${file} is removed`);
  assert.doesNotMatch(config + index, /inventory-scanner(?:-bootstrap)?\.(?:js|css)|stock-count-bootstrap\.js/);
  assert.match(index, /<script src="assets\/js\/atlas-capture\.js\?v=[^"]+"><\/script>/);
  assert.equal(config.split('SUPABASE_ANON_KEY').length - 1, 1);
  assert.doesNotMatch(config + capture, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('capture uses the rear camera, native barcode detection and a photo-only fallback', () => {
  assert.match(capture, /root\.isSecureContext/);
  assert.match(capture, /navigator\.mediaDevices\.getUserMedia\(\{ audio: false, video: \{ facingMode: \{ ideal: 'environment' \}/);
  assert.match(capture, /playsinline/);
  assert.match(capture, /if \(!\('BarcodeDetector' in root\)\) return null;/);
  // No third-party decoder is loaded from a CDN.
  assert.doesNotMatch(capture, /zxing|import\(/i);
  assert.match(capture, /NO_CODE_HINT_MS = 1500/);
  assert.match(capture, /data-capture-manual/);
  // Photos are re-encoded (EXIF and GPS dropped) and capped at 1600 px.
  assert.match(capture, /MAX_EDGE = 1600/);
  assert.match(capture, /canvas\.toBlob\(\(blob\) => resolve\(blob\), 'image\/jpeg'/);
});

test('capture is a modal surface: background inert, tab bar hidden, no observers', () => {
  assert.match(capture, /root\.AtlasChrome\?\.setTabBarHidden\?\.\('capture', true\)/);
  assert.match(capture, /root\.AtlasChrome\?\.setTabBarHidden\?\.\('capture', false\)/);
  assert.match(capture, /node\.inert = true/);
  assert.doesNotMatch(capture, /new MutationObserver|window\.fetch\s*=|document\.addEventListener\s*=/);
  assert.doesNotMatch(capture, /!important/);
});

test('browser capture has no direct table writes and never writes stock', () => {
  assert.doesNotMatch(capture, /(?:atlasSupabase|supabase|client)\s*\.\s*from\s*\(/i);
  assert.doesNotMatch(capture, /adjust_inventory|save-line|inventory_scan_aliases|inventory_scan_events/);
  // Stock count saves a scanned line through save-line with the recognition evidence only.
  assert.match(counts, /evidence: \{[^}]*recognition: /);
  assert.match(purchasing, /mode: 'receiving'/);
});

test('entry points: identify, add by camera, count scan and delivery photo', () => {
  assert.match(inventory, /AtlasCapture\.open\(\{/);
  assert.match(counts, /AtlasCapture\.open\(\{/);
  assert.match(purchasing, /AtlasCapture\?\.open|AtlasCapture\.open/);
  assert.match(css, /\.atlas-capture/);
});

function loadCapture({ response = {}, status = 200 } = {}) {
  const calls = [];
  const context = {
    URL, AbortController, FormData, Blob, console,
    setTimeout, clearTimeout,
    crypto: globalThis.crypto,
    navigator: { onLine: true },
    VABAR_CONFIG: { SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'anon' },
    atlasSupabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token-1' } }, error: null }) } },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const body = typeof response === 'function' ? response(url, init) : response;
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  };
  vm.createContext(context);
  vm.runInContext(capture, context, { filename: 'atlas-capture.js' });
  return { capture: context.AtlasCapture, calls };
}

test('codes alone take the JSON fast path to the recognition endpoint', async () => {
  const { capture: api, calls } = loadCapture({ response: { detections: [], stock_changed: false } });
  await api.identify({ mode: 'stock_count', codes: ['5010677850209'], context: { session_id: 's-1', empty: '' } });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://example.test/functions/v1/atlas-inventory-recognition');
  assert.equal(url.searchParams.get('action'), 'identify');
  assert.equal(calls[0].init.headers.authorization, 'Bearer token-1');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.mode, 'stock_count');
  assert.deepEqual(body.context, { session_id: 's-1' });
  assert.deepEqual(body.client_barcodes.map((code) => code.raw), ['5010677850209']);
  assert.match(body.client_request_id, /^[0-9a-f-]{36}$/);
});

test('outcomes and proposals carry fresh idempotency keys', async () => {
  const { capture: api, calls } = loadCapture({ response: { ok: true } });
  await api.outcome({ detection_id: 'd-1', outcome: 'confirmed' });
  await api.outcome({ detection_id: 'd-1', outcome: 'confirmed' });
  await api.propose({ kind: 'new_item' });
  const [first, second, third] = calls.map((call) => JSON.parse(call.init.body));
  assert.match(first.client_outcome_id, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.client_outcome_id, second.client_outcome_id);
  assert.match(third.request_id, /^[0-9a-f-]{36}$/);
});

test('errors map to fixed copy and a reported stock change is refused', async () => {
  const limited = loadCapture({ status: 429, response: { error_code: 'rate_limited', error: 'raw server text' } });
  await assert.rejects(limited.capture.identify({ codes: ['1'] }), (error) => error.code === 'rate_limited' && !/raw server text/.test(error.message));
  const odd = loadCapture({ status: 500, response: { error_code: 'something_new' } });
  await assert.rejects(odd.capture.identify({ codes: ['1'] }), (error) => error.message === odd.capture.ERROR_COPY.unavailable);
  const changed = loadCapture({ response: { detections: [], stock_changed: true } });
  await assert.rejects(changed.capture.identify({ codes: ['1'] }), (error) => error.code === 'internal');
  const none = loadCapture();
  await assert.rejects(none.capture.identify({ codes: [] }), (error) => error.code === 'invalid_request');
});
