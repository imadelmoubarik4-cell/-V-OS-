// S96: session fixation / login CSRF. supabase-js with detectSessionInUrl: true
// stores any #access_token=…&refresh_token=… it finds in the address bar,
// replacing the current session (and a crafted #error_description signs the
// device out). The app page must never consume URL session tokens, and the
// recovery page keeps its session in memory only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const indexHtml = fs.readFileSync(new URL('../../apps/web/index.html', import.meta.url), 'utf8');
// S96 (webstore): the start-up script lives in assets/js/atlas-app.js (strict CSP).
const appSource = fs.readFileSync(new URL('../../apps/web/assets/js/atlas-app.js', import.meta.url), 'utf8');
const recoverySource = fs.readFileSync(new URL('../../apps/web/assets/js/account-recovery.js', import.meta.url), 'utf8');

function inlineScriptContaining(marker) {
  const scripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).concat(appSource);
  const script = scripts.find((source) => source.includes(marker));
  assert.ok(script, `inline script with ${marker}`);
  return script;
}

test('the app client never detects a session in the URL', () => {
  const script = inlineScriptContaining('library.createClient(');
  const options = script.slice(script.indexOf('library.createClient('), script.indexOf('library.createClient(') + 400);
  assert.match(options, /detectSessionInUrl:\s*false/);
  assert.doesNotMatch(indexHtml + appSource, /detectSessionInUrl:\s*true/);
});

test('planted auth fragments are dropped before start-up; view routes are kept', () => {
  const script = inlineScriptContaining('dropAuthFragment');
  const body = script.slice(script.indexOf('(function dropAuthFragment()'), script.indexOf('})();', script.indexOf('(function dropAuthFragment()')) + 5);
  const run = (hash) => {
    const location = { hash, pathname: '/', search: '' };
    let replaced = null;
    vm.runInNewContext(body, { location, URLSearchParams, history: { replaceState(_s, _t, url) { replaced = url; } } });
    return replaced;
  };
  assert.equal(run('#access_token=planted&refresh_token=planted&expires_in=3600&token_type=bearer'), '/');
  assert.equal(run('#error=access_denied&error_description=forced+sign-out'), '/');
  assert.equal(run('#token_hash=x&type=recovery'), '/');
  assert.equal(run('#inventory?item=42'), null, 'ordinary routes are untouched');
  assert.equal(run(''), null);
});

test('the recovery page keeps its session in memory, never in the app session store', () => {
  let options = null;
  const el = () => ({ value: '', hidden: false, addEventListener() {}, querySelector() { return {}; } });
  const elements = {};
  vm.runInNewContext(recoverySource, {
    document: { getElementById: (id) => (elements[id] ??= el()), querySelectorAll: () => [] },
    window: { VABAR_CONFIG: { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'k' }, AtlasRehearsalBoundary: { validate() {} },
      supabase: { createClient: (_u, _k, opts) => { options = opts; return { auth: { onAuthStateChange() {} } }; } } },
    location: { href: 'https://isolated.example/recovery.html', pathname: '/recovery.html', hash: '' }, history: { replaceState() {} }, URL, URLSearchParams,
  });
  assert.equal(options?.auth?.persistSession, false);
  assert.notEqual(options?.auth?.storageKey, undefined);
  assert.doesNotMatch(String(options.auth.storageKey), /^sb-.*-auth-token$/);
});

test('second-factor step: an enrolled person is challenged and verified; others are not asked', async () => {
  const script = inlineScriptContaining('async function ensureAssurance(');
  const start = script.indexOf('async function ensureAssurance(');
  const end = script.indexOf('window.atlasEnsureAssurance = ensureAssurance;');
  const context = { window: {} };
  vm.runInNewContext(`${script.slice(start, end)}; this.ensureAssurance = ensureAssurance;`, context);
  const client = ({ current = 'aal1', next = 'aal2', factors = [{ id: 'f1', status: 'verified' }], okCode = '123456' } = {}) => {
    const calls = [];
    return { calls, auth: { mfa: {
      getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: current, nextLevel: next } }),
      listFactors: async () => ({ data: { totp: factors } }),
      challengeAndVerify: async (args) => { calls.push(args); return { error: args.code === okCode ? null : { message: 'invalid' } }; },
    } } };
  };
  const enrolled = client();
  assert.equal(await context.ensureAssurance(enrolled, () => '123 456'), 'verified');
  assert.deepEqual(JSON.parse(JSON.stringify(enrolled.calls)), [{ factorId: 'f1', code: '123456' }]);
  let asked = 0;
  assert.equal(await context.ensureAssurance(client({ next: 'aal1', factors: [] }), () => { asked += 1; return '1'; }), 'not_required');
  assert.equal(await context.ensureAssurance(client({ current: 'aal2' }), () => { asked += 1; return '1'; }), 'not_required');
  assert.equal(await context.ensureAssurance(client({ factors: [{ id: 'f', status: 'unverified' }] }), () => { asked += 1; return '1'; }), 'not_required');
  assert.equal(asked, 0, 'no prompt without a verified factor');
  const wrong = client();
  assert.equal(await context.ensureAssurance(wrong, () => '000000'), 'failed');
  assert.equal(wrong.calls.length, 3, 'at most three attempts per sign-in');
});
