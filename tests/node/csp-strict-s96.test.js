// S96 (webstore): the production CSP allows scripts only from this origin and
// the pinned, SRI-checked CDN files. That holds only while no page carries an
// inline script or inline event handler and no module runs a Blob script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const toml = readFileSync('netlify.toml', 'utf8');
const csp = /Content-Security-Policy = "([^"]+)"/.exec(toml)[1];
const directive = (name) => (csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) || '').split(/\s+/).slice(1);
const PAGES = readdirSync('apps/web').filter((file) => file.endsWith('.html'));
const MODULES = readdirSync('apps/web/assets/js').filter((file) => file.endsWith('.js')).map((file) => [file, readFileSync(`apps/web/assets/js/${file}`, 'utf8')]);

test('script-src has no unsafe-inline, unsafe-eval, blob:, data: or wildcard sources', () => {
  const sources = directive('script-src');
  assert.ok(sources.includes("'self'"));
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", 'blob:', 'data:', '*', 'https:']) assert.ok(!sources.includes(bad), `script-src allows ${bad}`);
  for (const source of sources.filter((value) => value.startsWith('https://'))) assert.match(source, /@\d+\.\d+\.\d+\/.+\.js$/, `CDN source is not a pinned file: ${source}`);
  assert.deepEqual(directive('object-src'), ["'none'"]);
  assert.deepEqual(directive('base-uri'), ["'self'"]);
  assert.ok(directive('frame-ancestors').length > 0);
  assert.ok(!directive('img-src').includes('https://api.qrserver.com'), 'unused third-party image host');
});

test('no page has an inline script or an inline event handler attribute', () => {
  for (const page of PAGES) {
    const html = readFileSync(`apps/web/${page}`, 'utf8');
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([, attrs, body]) => !/\bsrc=/.test(attrs) && body.trim());
    assert.equal(inline.length, 0, `${page} has an inline <script>`);
    assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+\s*=/i, `${page} has an inline event handler`);
    for (const [, src] of html.matchAll(/<script[^>]*src="(https:[^"]+)"[^>]*>/g)) {
      const tag = html.slice(html.indexOf(src) - 20, html.indexOf('</script>', html.indexOf(src)));
      assert.match(tag, /integrity="sha384-/, `${page}: ${src} has no SRI`);
    }
  }
});

test('no module creates inline handlers, string timers, eval or Blob scripts', () => {
  for (const [file, source] of MODULES) {
    assert.doesNotMatch(source, /setAttribute\(\s*['"]on/i, `${file} sets an on* attribute`);
    assert.doesNotMatch(source, /\beval\(|new Function\(/, `${file} evaluates strings`);
    assert.doesNotMatch(source, /set(Timeout|Interval)\(\s*['"`]/, `${file} passes a string to a timer`);
    assert.doesNotMatch(source, /new Blob\(\[[^\]]*\][^)]*text\/javascript/, `${file} builds a Blob script`);
    // Inline handler markup inside HTML templates would be blocked by the CSP.
    assert.doesNotMatch(source, /<[a-z][^<>`]*\son(click|load|error|input|change|submit|mouseover)=/i, `${file} renders an inline handler`);
  }
});

test('the plain Team Profiles script is byte-identical to its gzip bundle', () => {
  const bundle = gunzipSync(readFileSync('apps/web/assets/js/team-profiles.bundle.js.gz'));
  assert.ok(bundle.equals(readFileSync('apps/web/assets/js/team-profiles.source.js')));
});

test('HSTS in netlify.toml does not blindly bind subdomains', () => {
  const hsts = /Strict-Transport-Security = "([^"]+)"/.exec(toml)[1];
  assert.match(hsts, /max-age=\d{8,}/);
  assert.doesNotMatch(hsts, /includeSubDomains|preload/);
});
