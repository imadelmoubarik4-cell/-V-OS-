import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// S96: the start-up script moved from index.html to assets/js/atlas-app.js.
const index = readFileSync('apps/web/index.html', 'utf8') + readFileSync('apps/web/assets/js/atlas-app.js', 'utf8');
const menu = readFileSync('apps/web/menu.html', 'utf8');
const config = readFileSync('apps/web/config.js', 'utf8');
const netlify = readFileSync('netlify.toml', 'utf8');
const browser = index + menu + config;

const SUPABASE_SRI = 'sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug';
const LUCIDE_SRI = 'sha384-m/CoPp6wBQz6MoZXP+VveuxfvSx0NGXiQyyakzXVOVHgG1fP5bM/UiO4pSNPV6PT';

test('browser dependencies are pinned with reviewed integrity hashes', () => {
  assert.doesNotMatch(browser, /@latest|supabase-js@2(?:[/'\"])/i);
  assert.match(index, /lucide@0\.454\.0/);
  assert.match(index + menu, /supabase-js@2\.45\.4/g);
  for (const hash of [SUPABASE_SRI, LUCIDE_SRI]) assert.ok(browser.includes(hash), `Missing reviewed SRI hash ${hash}`);
  assert.match(index, /script\.integrity\s*=\s*SUPABASE_SRI/);
  assert.match(browser, /crossorigin="anonymous"/i);
});

// Security review S88b G6: the unused SheetJS 0.18.5 (known CVEs) is no longer
// loaded, every external script tag carries SRI, and script-src allows only
// the exact pinned CDN files instead of whole CDN origins.
const PAGES = ['index.html', 'menu.html', 'recovery.html', 'invitation.html']
  .map((name) => [name, readFileSync(`apps/web/${name}`, 'utf8')]);
const scriptSrc = (netlify.match(/Content-Security-Policy = "[^"]*?script-src ([^;]+);/) || [])[1] || '';

test('G6: no page loads SheetJS/xlsx', () => {
  for (const [name, html] of PAGES) assert.doesNotMatch(html, /xlsx(?:@|\.full|\.min)|sheetjs/i, name);
  assert.doesNotMatch(config, /xlsx@|sheetjs/i);
});

test('G6: every external script tag is pinned with SRI and allowed by exact URL in script-src', () => {
  const sources = scriptSrc.split(/\s+/).filter(Boolean);
  assert.ok(!sources.includes('https://cdn.jsdelivr.net') && !sources.includes('https://unpkg.com'), 'no whole-CDN origins');
  assert.ok(!sources.some((source) => source === '*' || source === 'https:' || source === 'data:'), scriptSrc);
  const external = [];
  for (const [name, html] of PAGES) {
    for (const match of html.matchAll(/<script\b[^>]*\bsrc="(https:[^"]+)"[^>]*>/g)) {
      external.push(match[1]);
      assert.match(match[0], /integrity="sha384-[A-Za-z0-9+/=]{64}"/, `${name}: ${match[1]} has SRI`);
      assert.match(match[0], /crossorigin="anonymous"/, `${name}: ${match[1]} is CORS`);
    }
  }
  const dynamic = [...index.matchAll(/'(https:\/\/[^']+\.js)'/g)].map((match) => match[1]);
  for (const url of [...external, ...dynamic]) assert.ok(sources.includes(url), `script-src allows ${url}`);
  assert.ok(external.length >= 2 && dynamic.length >= 2);
});

test('G6 closed (S96): script-src has no unsafe-inline and no blob:', () => {
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'|blob:/);
  assert.match(readFileSync('docs/SECURITY.md', 'utf8'), /S96: 'unsafe-inline' removed from script-src/);
});

test('no service-role credential is shipped to the browser', () => {
  assert.doesNotMatch(browser, /SUPABASE_SERVICE_ROLE_KEY|service_role\s*[:=]\s*['"][A-Za-z0-9._-]+/i);
  assert.doesNotMatch(browser, /sb_secret_[A-Za-z0-9_-]+/i);
});

test('Netlify headers cover transport, browser capabilities and only production Supabase', () => {
  assert.match(netlify, /Strict-Transport-Security/);
  // S88: Atlas AI voice notes and live voice need the microphone on this origin only.
  assert.match(netlify, /Permissions-Policy\s*=\s*"camera=\(self\), microphone=\(self\), geolocation=\(\), payment=\(\)"/);
  // Live voice exchanges its WebRTC offer with the realtime voice service; nothing else is added.
  assert.match(netlify, /connect-src 'self' https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co wss:\/\/dnefgcmjcgxlynycxkts\.supabase\.co https:\/\/api\.openai\.com;/);
  assert.match(netlify, /media-src 'self' blob:/);
  assert.match(netlify, /Content-Security-Policy/);
  assert.match(netlify, /dnefgcmjcgxlynycxkts\.supabase\.co/);
  assert.doesNotMatch(netlify, /uhbamqetppqmygesoeeh\.supabase\.co/);
  assert.doesNotMatch(netlify, /atialqebqxcquzdkezln\.supabase\.co/);
  assert.match(netlify, /frame-ancestors 'self' https:\/\/xn--vbar-5na\.is/);
  assert.doesNotMatch(scriptSrc, /blob:/);
  assert.match(netlify, /worker-src 'self' blob:/);
  assert.doesNotMatch(netlify, /X-Frame-Options/);
});

test('commercial browser paths are profile-gated and use redacted staff catalogues', () => {
  assert.match(index, /loadActiveProfile/);
  assert.match(index, /inventory_catalog/);
  assert.match(index, /inventory_movement_catalog/);
  assert.match(index, /recipe_catalog/);
  assert.match(index, /atlas-commercial-manager/);
  assert.doesNotMatch(index, /updated_by:\s*currentUser(?:\.id|\?\.id)?/);
});

// --- S96 supply chain: Edge Function imports, CI pinning, server credentials ---
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walkFiles(dir, keep) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

const FUNCTION_SOURCES = walkFiles('supabase/functions', (file) => /\.(ts|mts|mjs|js)$/.test(file));
const specifiers = (text) => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']((?:npm|jsr|https?):[^"']+)["']/g)].map((m) => m[1]);

// Reviewed third-party runtime packages (typosquat / dependency-confusion guard):
// adding one is a deliberate review step, not a side effect of an import.
const REVIEWED_NPM = new Map([
  ['@openai/agents', '0.18.0'],
  ['zod', '4.6.5'],
  ['web-push', '3.6.7'],
  ['@supabase/supabase-js', '2.45.4'],
]);

test('S96: every Edge Function npm: import is an exact, reviewed version (no ranges such as npm:zod@4)', () => {
  const seen = [];
  for (const file of FUNCTION_SOURCES) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('npm:')) continue;
      const match = spec.match(/^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+)(?:\/[\w./-]*)?$/);
      assert.ok(match, `${file}: ${spec} must pin an exact x.y.z version`);
      assert.equal(REVIEWED_NPM.get(match[1]), match[2], `${file}: ${spec} is not a reviewed package/version`);
      seen.push(match[1]);
    }
  }
  assert.ok(seen.includes('zod') && seen.includes('@openai/agents'), 'the scan found the Atlas AI imports');
});

test('S96: no remote-URL imports and jsr: is limited to the type-only edge runtime declarations', () => {
  for (const file of FUNCTION_SOURCES) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      assert.ok(!/^https?:/.test(spec), `${file}: remote URL import ${spec} (pin through npm:/jsr: with an exact version)`);
      if (spec.startsWith('jsr:')) {
        assert.ok(spec === 'jsr:@supabase/functions-js/edge-runtime.d.ts' || /^jsr:@[\w-]+\/[\w-]+@\d+\.\d+\.\d+/.test(spec),
          `${file}: ${spec} must be the type-only declaration file or an exact version`);
      }
    }
  }
});

const WORKFLOWS = readdirSync('.github/workflows').filter((name) => /\.ya?ml$/.test(name))
  .map((name) => [name, readFileSync(join('.github/workflows', name), 'utf8')]);

test('S96: every GitHub Action is pinned to a full commit SHA and every service image to a digest', () => {
  assert.ok(WORKFLOWS.length >= 5);
  for (const [name, text] of WORKFLOWS) {
    for (const match of text.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
      const ref = match[1];
      if (ref.startsWith('./')) continue;
      assert.match(ref, /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/, `${name}: ${ref} must be pinned to a commit SHA`);
    }
    for (const match of text.matchAll(/^\s*image:\s*(\S+)/gm)) {
      assert.match(match[1], /@sha256:[0-9a-f]{64}$/, `${name}: image ${match[1]} must be pinned by digest`);
    }
  }
});

test('S96: workflows keep a read-only token, never use pull_request_target and never expose secrets to PR runs', () => {
  for (const [name, text] of WORKFLOWS) {
    assert.doesNotMatch(text, /pull_request_target|workflow_run/, `${name}: privileged PR triggers are not used`);
    assert.match(text, /^permissions:\s*\n\s+contents:\s*read\s*$/m, `${name}: top-level permissions are contents: read`);
    assert.doesNotMatch(text, /:\s*write\b/, `${name}: no write scopes`);
    assert.doesNotMatch(text, /\$\{\{\s*secrets\./, `${name}: no repository secrets in CI`);
    assert.doesNotMatch(text, /\$\{\{\s*github\.event\.(?:pull_request|issue|comment|head_commit)\./, `${name}: no attacker-controlled expression interpolation`);
  }
});

test('S96: the browser key is the reviewed publishable key, never a legacy JWT', () => {
  const key = (config.match(/SUPABASE_ANON_KEY:\s*"([^"]+)"/) || [])[1] || '';
  assert.match(key, /^sb_publishable_[A-Za-z0-9_-]{20,}$/);
  assert.doesNotMatch(browser, /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./, 'no JWT-shaped key in pages or config');
});

test('S96: Python test dependencies agree on one pinned pdfplumber version', () => {
  const pins = ['requirements-dev.txt', 'requirements-test.txt']
    .map((file) => (readFileSync(file, 'utf8').match(/^pdfplumber==(\S+)$/m) || [])[1]);
  assert.ok(pins.every(Boolean), 'pdfplumber is pinned with ==');
  assert.equal(new Set(pins).size, 1, `pdfplumber pins disagree: ${pins.join(' vs ')}`);
});
