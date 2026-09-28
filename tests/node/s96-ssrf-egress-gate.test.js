// S96 (ssrf, C44 / ADDENDUM 8): consolidated negative regression tests for the
// Atlas outbound-network (SSRF) gate.
//
// The audit found NO server-side sink that fetches a user-supplied or a stored
// hostname: every outbound request goes to a FIXED env host (SUPABASE_URL /
// ATLAS_AUTH_PROJECT_URL / OpenAI base URL), a per-provider ALLOW-LIST, or the
// browser-push vendor allow-list. This file locks that in by attacking the two
// exported allow-list guards that carry the whole gate, so a future change that
// widens them (adds an IP path, follows a redirect, drops the credential /
// scheme / port checks, or loosens a suffix match) fails CI.
//
// It imports the REAL production modules (identical in repo and in the deployed
// sources) and never opens a socket: the fetchImpl is a spy that must not be
// reached for a blocked target.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHttp,
  assertProviderUploadUrl,
  sanitizeMessage,
  storageOrigin,
} from '../../supabase/functions/_shared/publishing/http.mjs';
import {
  isAllowedHost,
  isAllowedRedirectUri,
  buildRedirectUri,
} from '../../supabase/functions/atlas-integrations/oauth-core.mjs';
import { tripadvisorVerifyUrl } from '../../supabase/functions/atlas-integrations/providers.mjs';

const OWN = 'https://dnefgcmjcgxlynycxkts.supabase.co';

// Canonical SSRF target list reused across the guards. Every one of these must
// be refused before a socket is opened.
const SSRF_TARGETS = [
  'http://127.0.0.1:1/',
  'https://127.0.0.1/',
  'http://169.254.169.254/latest/meta-data/',           // AWS/GCP link-local metadata
  'https://169.254.169.254/',
  'http://metadata.google.internal/computeMetadata/v1/', // GCP metadata name
  'http://[::1]/',                                        // IPv6 loopback
  'https://[::ffff:169.254.169.254]/',                   // IPv4-mapped IPv6 metadata
  'http://[fd00::1]/',                                    // IPv6 ULA (private)
  'http://2130706433/',                                   // decimal 127.0.0.1
  'http://0x7f000001/',                                   // hex 127.0.0.1
  'http://0177.0.0.1/',                                   // octal 127.0.0.1
  'http://127.1/',                                        // short-form 127.0.0.1
  'http://10.0.0.5/',                                     // private RFC1918
  'http://192.168.1.1/',
  'http://172.16.0.1/',
  'http://localhost/',
];

function spyFetch() {
  const calls = [];
  const impl = async (input, init) => {
    calls.push(String(input));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

// ---- publishing/http.mjs: the worker's only outbound client -----------------

test('publishing client: allow-listed provider hosts and own storage reach fetch', async () => {
  const fetchImpl = spyFetch();
  const { request } = createHttp({ fetchImpl, supabaseUrl: OWN });
  await request('https://graph.facebook.com/v25.0/me', { method: 'GET' });
  await request('https://open.tiktokapis.com/v2/user/info/', { method: 'GET' });
  await request('https://mybusiness.googleapis.com/v1/accounts', { method: 'GET' });
  await request(`${OWN}/storage/v1/object/sign/atlas-marketing-media/x`, { method: 'POST' });
  assert.equal(fetchImpl.calls.length, 4, 'all four legitimate hosts were fetched');
});

test('publishing client: every SSRF target is blocked before a socket opens', async () => {
  const fetchImpl = spyFetch();
  const { request } = createHttp({ fetchImpl, supabaseUrl: OWN });
  for (const target of SSRF_TARGETS) {
    await assert.rejects(request(target, { method: 'GET' }), (err) => {
      assert.equal(err.name, 'HttpError', target);
      assert.equal(err.blocked, true, target);
      return true;
    }, target);
  }
  assert.equal(fetchImpl.calls.length, 0, 'no blocked target reached fetchImpl');
});

test('publishing client: scheme, credential, port and allow-list-boundary tricks are blocked', async () => {
  const fetchImpl = spyFetch();
  const { request } = createHttp({ fetchImpl, supabaseUrl: OWN });
  for (const target of [
    'file:///etc/passwd',
    'gopher://graph.facebook.com/',
    'ftp://graph.facebook.com/',
    'https://user:pass@graph.facebook.com/me',        // embedded credentials
    'https://graph.facebook.com:8443/me',             // non-default port
    'https://graph.facebook.com.attacker.example/me', // suffix-append trick
    'https://evilgraph.facebook.com/me',              // prefix trick (not a real subdomain)
    'https://graph.facebook.com@attacker.example/me', // userinfo confusion
    'https://open.tiktokapis.com.evil.test/x',
    `${OWN}/rest/v1/rpc/x`,                            // own host but NOT /storage/v1 path
    'https://dnefgcmjcgxlynycxkts.supabase.co.evil/storage/v1/x',
  ]) {
    await assert.rejects(request(target, { method: 'GET' }), (err) => err?.blocked === true, target);
  }
  assert.equal(fetchImpl.calls.length, 0, 'no trick target reached fetchImpl');
});

test('publishing client: a 3xx redirect is never followed', async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
  const { request } = createHttp({ fetchImpl, supabaseUrl: OWN });
  await assert.rejects(request('https://graph.facebook.com/v25.0/me', { method: 'GET' }), (err) => {
    assert.equal(err.name, 'HttpError');
    assert.equal(err.redirect, true);
    return true;
  });
});

test('publishing client: the request carries redirect:"manual" and an abort signal', async () => {
  let seen = null;
  const fetchImpl = async (_input, init) => { seen = init; return new Response('{}', { status: 200 }); };
  const { request } = createHttp({ fetchImpl, supabaseUrl: OWN });
  await request('https://graph.facebook.com/v25.0/me', { method: 'GET' });
  assert.equal(seen.redirect, 'manual', 'redirects are not auto-followed by the runtime');
  assert.ok(seen.signal, 'a timeout AbortSignal is attached to every request');
});

test('publishing client: a slow host trips the timeout (no unbounded outbound wait)', async () => {
  const fetchImpl = (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const { request } = createHttp({ fetchImpl, supabaseUrl: OWN });
  await assert.rejects(request('https://graph.facebook.com/v25.0/me', { method: 'GET', timeoutMs: 20 }), (err) => {
    assert.equal(err.name, 'HttpError');
    assert.equal(err.timeout, true);
    return true;
  });
});

test('assertProviderUploadUrl: provider-returned upload URLs are re-validated', () => {
  // Allowed: TikTok open-upload host family, Meta rupload.
  assert.ok(assertProviderUploadUrl('https://open-upload.tiktokapis.com/upload?upload_id=1', 'tiktok'));
  assert.ok(assertProviderUploadUrl('https://v-open-upload.tiktokapis.com/x', 'tiktok'));
  assert.ok(assertProviderUploadUrl('https://rupload.facebook.com/x', 'meta'));
  // Refused: internal / metadata / alternate host / scheme / creds / port.
  for (const [value, provider] of [
    ['https://169.254.169.254/x', 'tiktok'],
    ['http://open-upload.tiktokapis.com/x', 'tiktok'],           // not https
    ['https://open-upload.tiktokapis.com:8443/x', 'tiktok'],     // port
    ['https://user:pass@open-upload.tiktokapis.com/x', 'tiktok'],// creds
    ['https://open-upload.tiktokapis.com.evil.test/x', 'tiktok'],// suffix trick
    ['https://rupload.facebook.com.evil/x', 'meta'],
    ['https://graph.facebook.com/x', 'meta'],                    // API host, not an upload host
    ['https://127.0.0.1/x', 'meta'],
    ['https://open-upload.tiktokapis.com/x', 'google'],          // no upload rule for google
  ]) {
    assert.throws(() => assertProviderUploadUrl(value, provider), (err) => err?.blocked === true, `${provider}:${value}`);
  }
});

test('storageOrigin: only http(s) origins are honoured', () => {
  assert.equal(storageOrigin(OWN), OWN);
  assert.equal(storageOrigin('file:///etc'), null);
  assert.equal(storageOrigin('not a url'), null);
});

test('sanitizeMessage: URLs, bearer tokens and known secret shapes are redacted', () => {
  const out = sanitizeMessage('see https://x.example/a?token=abc EAAB1234567890123456789 bearer ya29.SECRETVALUE', ['s3cr3tvalue']);
  assert.doesNotMatch(out, /https:\/\/x\.example/);
  assert.doesNotMatch(out, /EAAB1234567890123456789/);
  assert.doesNotMatch(out, /ya29\.SECRETVALUE/);
  assert.ok(out.length <= 240);
});

// ---- atlas-integrations/oauth-core.mjs: redirect-URI / host allow-list -------

// The production wildcard-suffix rule format is "*.netlify.app": it matches
// exactly one extra label (no dots), so nested attacker subdomains are refused.
const ALLOWED = ['os-vabar.netlify.app', '*.netlify.app', 'xn--vbar-5na.is'];

test('isAllowedHost: exact and single-label-suffix matches only', () => {
  assert.equal(isAllowedHost('os-vabar.netlify.app', ALLOWED), true);
  assert.equal(isAllowedHost('deploy-preview-103--os-vabar.netlify.app', ALLOWED), true); // single label before .netlify.app
  assert.equal(isAllowedHost('xn--vbar-5na.is', ALLOWED), true);
  // Boundary tricks must all fail.
  for (const host of [
    'os-vabar.netlify.app.attacker.com',   // suffix append
    'attacker-os-vabar.netlify.app.evil',  // suffix append
    'evilnetlify.app',                     // not a real subdomain of netlify.app
    'a.b.netlify.app',                     // two labels before suffix (not allowed by the single-label rule)
    'netlify.app',                         // bare suffix
    '169.254.169.254',
    'localhost',
    '',
    'xn--vbar-5na.is.evil.com',
  ]) {
    assert.equal(isAllowedHost(host, ALLOWED), false, host);
  }
});

test('isAllowedRedirectUri / buildRedirectUri: https, allow-listed host, fixed callback path', () => {
  const base = 'https://os-vabar.netlify.app';
  const good = buildRedirectUri(base, 'google-business-profile', ALLOWED);
  assert.ok(good && good.startsWith('https://os-vabar.netlify.app/'));
  assert.equal(isAllowedRedirectUri(good, base, 'google-business-profile', ALLOWED), true);
  // A redirect URI on a non-allow-listed or non-https base is rejected.
  assert.equal(buildRedirectUri('http://os-vabar.netlify.app', 'google-business-profile', ALLOWED), null);
  assert.equal(buildRedirectUri('https://attacker.example', 'google-business-profile', ALLOWED), null);
  assert.equal(isAllowedRedirectUri('https://attacker.example/functions/v1/atlas-integrations/callback/google-business-profile', base, 'google-business-profile', ALLOWED), false);
});

// ---- atlas-integrations/providers.mjs: Tripadvisor verify URL (owner env) ----

test('tripadvisorVerifyUrl: pinned to https terra.tripadvisor.com, no credentials, no host hijack via {location_id}', () => {
  const env = (map) => (name) => map[name];
  const ok = tripadvisorVerifyUrl(env({ ATLAS_TRIPADVISOR_VERIFY_URL: 'https://terra.tripadvisor.com/api/locations/{location_id}' }), '12345');
  assert.ok(ok && ok.startsWith('https://terra.tripadvisor.com/'));
  // Any other host / scheme / credentials -> null (never fetched).
  for (const template of [
    'https://terra.tripadvisor.com.evil.test/api/{location_id}',
    'http://terra.tripadvisor.com/api/{location_id}',
    'https://user:pass@terra.tripadvisor.com/api/{location_id}',
    'https://169.254.169.254/{location_id}',
    'https://terra.tripadvisor.com@attacker.example/{location_id}',
    'file:///etc/passwd',
  ]) {
    assert.equal(tripadvisorVerifyUrl(env({ ATLAS_TRIPADVISOR_VERIFY_URL: template }), '1'), null, template);
  }
  // A location id cannot break out of the path to change the host.
  const inj = tripadvisorVerifyUrl(env({ ATLAS_TRIPADVISOR_VERIFY_URL: 'https://terra.tripadvisor.com/api/locations/{location_id}' }), '../../@attacker.example/');
  assert.ok(inj === null || new URL(inj).hostname === 'terra.tripadvisor.com', 'host stays terra.tripadvisor.com');
});
