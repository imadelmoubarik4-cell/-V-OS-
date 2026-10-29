// KANEL pricing containment. The owner's price snapshot and the business
// baseline (rates, sales, expense lines, supplier costs) used to ship as public
// static files, so anyone could download them without signing in. They were
// removed; the module is off until a manager-authorised server endpoint serves
// them. These checks keep business inputs out of everything Netlify publishes
// (apps/web): a UI role check is not access control for a static file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const WEB = 'apps/web';
const read = (file) => readFileSync(file, 'utf8');

function servedFiles(dir = WEB) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? servedFiles(file) : [file];
  });
}

// Code without its comments, so the checks look at what runs.
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('the price snapshot is not published, and no served file points at one', () => {
  assert.equal(existsSync(path.join(WEB, 'assets/data/kanel-price-lock-v07.json')), false);
  const files = servedFiles();
  assert.deepEqual(files.filter((file) => /price-lock|pricing.*\.json$/i.test(file)), []);
  const text = files.filter((file) => /\.(?:js|mjs|json|html|css|txt|webmanifest)$/.test(file));
  assert.deepEqual(text.filter((file) => /kanel-price-lock/.test(read(file))), []);
  // Snapshot rows (keyed by the snapshot's own field names) may not reappear in
  // any served data or page. The workspace script only reads these keys from a
  // server response, so scripts are checked for literals instead (below).
  const ROW = /"(?:guest_price_incl_vat_isk|modeled_cost_isk|model_5pct_price_floor_isk|cash_5pct_floor_isk)"\s*:/;
  assert.deepEqual(text.filter((file) => ROW.test(read(file))), []);
});

test('Menu Pricing is switched off in the shipped config', () => {
  const config = read(path.join(WEB, 'config.js'));
  assert.match(config, /^\s*KANEL_PRICING_ENABLED: false,$/m);
  assert.doesNotMatch(config, /KANEL_PRICING_ENABLED:\s*true/);
});

test('the workspace fetches nothing static and embeds no prices or costs', () => {
  const source = code(read(path.join(WEB, 'assets/js/finance-pricing-workspace.js')));
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'figures may only come from an authorised server endpoint');
  assert.doesNotMatch(source, /assets\/data\//);
  // Only UI constants: small integers and the public VAT rates / 5% floor.
  // A price or cost literal (three or more digits) fails here.
  const literals = source.match(/(?<![\w.#-])\d+(?:\.\d+)?(?![\w])/g) || [];
  const odd = literals.filter((n) => (n.includes('.') ? !['0.05', '0.11', '0.24'].includes(n) : Number(n) >= 200));
  assert.deepEqual(odd, []);
});

test('the engine ships neutral defaults: no business number in DEFAULT_PROFILE', () => {
  const source = read(path.join(WEB, 'assets/js/kanel-pricing-engine.js'));
  const block = source.slice(source.indexOf('var DEFAULT_PROFILE = {'), source.indexOf('engine.DEFAULT_PROFILE = DEFAULT_PROFILE;'));
  assert.ok(block.length > 0, 'DEFAULT_PROFILE block found');
  const literals = code(block).match(/(?<![\w.])\d+(?:\.\d+)?(?![\w])/g) || [];
  // VAT rates, menu rounding (xx90 in steps of 100) and the two warning thresholds.
  const PUBLIC_RULES = new Set(['0', '0.11', '0.24', '90', '100', '0.60', '2.5']);
  assert.deepEqual(literals.filter((n) => !PUBLIC_RULES.has(n)), []);
  assert.match(block, /expenses: \[\]/);
  assert.match(block, /historicalReconciliations: \[\]/);
  assert.doesNotMatch(source, /KANEL_BASELINE/);
});

test('installed apps drop the old cache that could hold the snapshot', () => {
  // The service worker deletes every cache but the current one on activate;
  // alcedo-shell-v4 was current while the snapshot was public.
  const worker = read(path.join(WEB, 'service-worker.js'));
  const version = Number(worker.match(/const CACHE = 'alcedo-shell-v(\d+)';/)?.[1]);
  assert.ok(version >= 5, `cache version ${version} must be past v4`);
  assert.match(worker, /keys\.filter\(\(key\) => key !== CACHE\)\.map\(\(key\) => caches\.delete\(key\)\)/);
});
