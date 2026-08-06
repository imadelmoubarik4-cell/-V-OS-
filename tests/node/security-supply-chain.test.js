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
const XLSX_SRI = 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';

test('browser dependencies are pinned with reviewed integrity hashes', () => {
  assert.doesNotMatch(browser, /@latest|supabase-js@2(?:[/'"])/i);
  assert.match(index, /xlsx@0\.18\.5/);
  assert.match(index, /lucide@0\.454\.0/);
  assert.match(index + menu, /supabase-js@2\.45\.4/g);
  for (const hash of [SUPABASE_SRI, LUCIDE_SRI, XLSX_SRI]) assert.match(browser, new RegExp(hash));
  assert.match(index, /script\.integrity\s*=\s*SUPABASE_SRI/);
  assert.match(browser, /crossorigin="anonymous"/i);
});

test('no service-role credential is shipped to the browser', () => {
  assert.doesNotMatch(browser, /SUPABASE_SERVICE_ROLE_KEY|service_role\s*[:=]\s*['"][A-Za-z0-9._-]+/i);
  assert.doesNotMatch(browser, /sb_secret_[A-Za-z0-9_-]+/i);
});

test('Netlify headers cover transport, browser capabilities and both Supabase projects', () => {
  assert.match(netlify, /Strict-Transport-Security/);
  assert.match(netlify, /Permissions-Policy\s*=\s*"camera=\(self\), microphone=\(\), geolocation=\(\), payment=\(\)"/);
  assert.match(netlify, /Content-Security-Policy/);
  assert.match(netlify, /dnefgcmjcgxlynycxkts\.supabase\.co/);
  assert.match(netlify, /uhbamqetppqmygesoeeh\.supabase\.co/);
  assert.match(netlify, /frame-ancestors 'self' https:\/\/xn--vbar-5na\.is/);
  assert.match(netlify, /script-src[^
]*blob:/);
  assert.doesNotMatch(netlify, /X-Frame-Options/);
});

test('commercial browser paths are profile-gated and use redacted staff catalogues', () => {
  assert.match(index, /loadActiveProfile/);
  assert.match(index, /inventory_catalog/);
  assert.match(index, /inventory_movement_catalog/);
  assert.match(index, /recipe_catalog/);
  assert.match(index, /atlas-commercial-manager/);
  assert.doesNotMatch(index, /updated_by:\s*currentUser/);
});
