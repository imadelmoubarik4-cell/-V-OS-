// Start-up assets and sign-in markup (platform audit M15, L25, L26, L28).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(path, 'utf8');
const index = read('apps/web/index.html');
const config = read('apps/web/config.js');
const guard = read('apps/web/assets/js/runtime-module-guard.js');
const app = read('apps/web/assets/js/atlas-app.js');
const netlify = read('netlify.toml');
const indexHrefs = new Set([...index.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((match) => match[1]));

// ---------- L26: one copy of each runtime module stylesheet ----------

test('L26: a runtime stylesheet that index.html links is named by its loaders with the same key', () => {
  const loaders = [
    ...[...config.matchAll(/stylesheetPath: '([^']+)'/g)].map((match) => ['config.js', match[1]]),
    ...[...guard.matchAll(/\['(assets\/css\/[^']+)'/g)].map((match) => ['runtime-module-guard.js', match[1]])
  ];
  assert.ok(loaders.length >= 12, `found ${loaders.length} loaders`);
  const pathOf = (href) => href.split('?')[0];
  let linked = 0;
  for (const [file, href] of loaders) {
    const same = [...indexHrefs].filter((indexHref) => pathOf(indexHref) === pathOf(href));
    // Flag-gated sheets (Menu Pricing) are not linked statically at all.
    if (!same.length) continue;
    linked += 1;
    assert.deepEqual(same, [href], `${file}: ${href} matches the one index.html link`);
  }
  assert.ok(linked >= 11, `${linked} loaders checked against index.html`);
  assert.ok(config.includes("stylesheetPath: 'assets/css/bookings-workspace.css?v=20261026-redesign'"));
  assert.ok(indexHrefs.has('assets/css/bookings-workspace.css?v=20261026-redesign'));
});

// Runs config.js against a minimal document whose head already links the
// given stylesheets, then calls its loader directly.
function loadConfig(linked) {
  const head = { children: [], appendChild(node) { this.children.push(node); } };
  const links = linked.map((href) => ({ rel: 'stylesheet', getAttribute: (name) => (name === 'href' ? href : null) }));
  const document = {
    baseURI: 'https://alcedo.test/index.html',
    readyState: 'loading',
    head,
    body: { dataset: {}, appendChild() {} },
    querySelector: () => null,
    querySelectorAll: (selector) => (selector.startsWith('link') ? [...links, ...head.children.filter((node) => node.rel === 'stylesheet')] : []),
    createElement: () => {
      const node = { dataset: {}, getAttribute(name) { return name === 'href' ? this.href : null; } };
      return node;
    }
  };
  const window = { addEventListener() {}, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1 };
  const context = vm.createContext({ window, document, URL, console });
  window.document = document;
  vm.runInContext(config, context, { filename: 'config.js' });
  return { context, head };
}

test('L26: the stylesheet loader skips a sheet already linked under another cache key', () => {
  const { context, head } = loadConfig(['assets/css/bookings-workspace.css?v=20261026-redesign', 'assets/css/team-profile-photos.css']);
  context.loadAtlasAssetOnce({ stylesheetPath: 'assets/css/bookings-workspace.css?v=20261002-bookings1' });
  context.loadAtlasAssetOnce({ stylesheetPath: 'assets/css/bookings-workspace.css?v=20261026-redesign' });
  context.loadAtlasAssetOnce({ stylesheetPath: 'assets/css/team-profile-photos.css?v=2' });
  assert.equal(head.children.length, 0, 'no second copy of an already-linked sheet');
  // A sheet that is not linked yet still loads, once.
  context.loadAtlasAssetOnce({ stylesheetPath: 'assets/css/finance-pricing-workspace.css?v=20261026-redesign' });
  context.loadAtlasAssetOnce({ stylesheetPath: 'assets/css/finance-pricing-workspace.css?v=20261026-redesign' });
  assert.deepEqual(head.children.map((node) => node.href), ['assets/css/finance-pricing-workspace.css?v=20261026-redesign']);
  // Only the path counts: another file with a similar name is not a match.
  context.loadAtlasAssetOnce({ stylesheetPath: 'assets/css/bookings.css' });
  assert.equal(head.children.length, 2);
});

// ---------- L25: supabase-js and the Supabase origin start early ----------

test('L25: index.html preconnects to Supabase and preloads the exact supabase-js file atlas-app.js loads', () => {
  const cdn = app.match(/SUPABASE_CDN_URLS = \[\s*'([^']+)'/)[1];
  const sri = app.match(/const SUPABASE_SRI = '([^']+)';/)[1];
  const supabaseUrl = config.match(/SUPABASE_URL: "([^"]+)"/)[1];
  const preload = index.match(/<link rel="preload" href="(https:[^"]+)" as="script"([^>]*)>/);
  assert.ok(preload, 'a script preload');
  assert.equal(preload[1], cdn, 'the first CDN URL atlas-app.js tries');
  assert.match(preload[2], new RegExp(`integrity="${sri.replace(/[+/=]/g, '\\$&')}"`), 'the same SRI');
  assert.match(preload[2], /crossorigin="anonymous"/, 'the same CORS mode as the script element');
  assert.match(app, /script\.crossOrigin = 'anonymous';/);
  assert.ok(index.includes(`<link rel="preconnect" href="${new URL(supabaseUrl).origin}" crossorigin>`), 'preconnect to the Supabase origin');
  // No new host: the preload is allowed by exact URL in script-src, and the
  // Supabase origin is already in connect-src.
  const csp = netlify.match(/Content-Security-Policy = "([^"]+)"/)[1];
  assert.ok(csp.match(/script-src ([^;]+);/)[1].split(/\s+/).includes(cdn));
  assert.ok(csp.match(/connect-src ([^;]+);/)[1].split(/\s+/).includes(new URL(supabaseUrl).origin));
  // Both hints come before the stylesheets and scripts, so they start first.
  assert.ok(index.indexOf('rel="preload" href="https://cdn.jsdelivr.net') < index.indexOf('<link rel="stylesheet"'));
});

// ---------- M15: the sign-in form cannot submit natively ----------

test('M15: the sign-in form posts and its button starts disabled until atlas-app.js is ready', () => {
  const form = index.match(/<form id="login-form"[^>]*>/)[0];
  assert.match(form, /method="post"/, 'never a GET with the password in the URL');
  assert.doesNotMatch(form, /action="/);
  const button = index.match(/<button type="submit"[^>]*id="login-btn"[^>]*>([^<]*)<\/button>/);
  assert.ok(button, 'the submit button');
  assert.match(button[0], /\sdisabled[\s>]/, 'disabled in markup: implicit submission (Enter) is blocked before the script binds');
  assert.equal(button[1], 'Connecting…', 'the same busy label init() shows');
  assert.match(app, /loginBtn\.disabled = true;\s*loginBtn\.textContent = 'Connecting…';/);
  assert.match(app, /loginBtn\.disabled = false;\s*loginBtn\.textContent = 'Sign in';/);
});

// ---------- L28: mascot images are sized for their display ----------

function pngSize(path) {
  const png = readFileSync(path);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25], bytes: png.length };
}

test('L28: mascot PNGs stay within the byte budget at about twice their largest display size', () => {
  // Largest CSS display size: badges are clamped to 128 px (AtlasBot.html);
  // the live poster is at most 176 px in Atlas AI (and 230 px for a 320 px
  // live surface); the glass head is the head-framing poster (≤ 230 px).
  const budget = { 'alcedo-mascot-head.png': 256, 'alcedo-mascot-poster.png': 460, 'alcedo-mascot-head-glass.png': 460 };
  for (const [file, maxSide] of Object.entries(budget)) {
    const size = pngSize(`apps/web/assets/atlas-bot/${file}`);
    assert.ok(size.bytes <= 60 * 1024, `${file}: ${size.bytes} B ≤ 60 KB`);
    assert.ok(size.width <= maxSide && size.height <= maxSide, `${file}: ${size.width}x${size.height} ≤ ${maxSide}`);
    assert.ok(size.width >= 256, `${file}: still sharp at 2x (${size.width} px)`);
    assert.equal(size.width, size.height, `${file} keeps its square framing`);
    assert.equal(size.colorType, 6, `${file} keeps its transparency (RGBA)`);
  }
  assert.ok(statSync('apps/web/assets/atlas-bot/alcedo-mascot.glb').size > 0);
});
