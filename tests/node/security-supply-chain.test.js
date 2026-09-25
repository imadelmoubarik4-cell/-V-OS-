import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const index = readFileSync('apps/web/index.html', 'utf8');
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

test('G6: the remaining unsafe-inline is a documented rollout follow-up', () => {
  assert.match(scriptSrc, /'unsafe-inline'/);
  assert.match(netlify, /Known follow-up \(security review S88b G6\): 'unsafe-inline'/);
  assert.match(readFileSync('docs/SECURITY.md', 'utf8'), /Known rollout follow-up \(security review S88b G6\)/);
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
  assert.match(netlify, /script-src[^\n]*blob:/);
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
