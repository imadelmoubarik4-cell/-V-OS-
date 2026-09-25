// S91: a sign-out on one device never ends the person's other sessions.
// supabase-js signOut() defaults to scope 'global' (every session of the
// account). In production that signed the owner's desktop out when the phone
// was used. Every call in the web app names its scope, and only the password
// reset page may end every session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WEB = path.join(ROOT, 'apps/web');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sources(full);
    return /\.(js|mjs|html)$/.test(entry.name) && !entry.name.endsWith('.min.js') ? [full] : [];
  });
}

test('every auth.signOut call in the web app names its scope', () => {
  const calls = [];
  for (const file of sources(WEB)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/auth\.signOut\(([^)]*)\)/g)) calls.push({ file: path.relative(ROOT, file), args: match[1].trim() });
  }
  assert.ok(calls.length >= 3, 'the sign-out calls were found');
  for (const call of calls) assert.match(call.args, /scope:\s*'(local|global)'/, `${call.file}: signOut(${call.args}) must name a scope`);
  const global = calls.filter((call) => /'global'/.test(call.args)).map((call) => call.file);
  assert.deepEqual(global, ['apps/web/assets/js/account-recovery.js'], 'only the password reset ends every session');
});

test('a profile read error never signs out; only an inactive profile clears this device', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const body = html.slice(html.indexOf('async function loadActiveProfile'), html.indexOf('async function onSignedIn'));
  const errorBranch = body.slice(body.indexOf('if (error) {'), body.indexOf('if (!data?.active'));
  assert.ok(errorBranch.includes("'profile_unavailable'"));
  assert.doesNotMatch(errorBranch, /signOut/);
  assert.match(body.slice(body.indexOf('if (!data?.active')), /signOut\(\{ scope: 'local' \}\)/);
});

test('a 401 renews the session before offering sign-in', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const handler = html.slice(html.indexOf("addEventListener('atlas:auth-required'"), html.indexOf('const INACTIVE_PROFILE_MESSAGE'));
  assert.ok(handler.indexOf('refreshSession') > -1 && handler.indexOf('refreshSession') < handler.indexOf('await sessionEnded()'));
  // Only 401s from the Supabase project, never its auth endpoints, start it.
  assert.match(html, /response\.status === 401 && url\.startsWith\(base\) && !url\.startsWith\(`\$\{base\}\/auth\/`\)/);
});
