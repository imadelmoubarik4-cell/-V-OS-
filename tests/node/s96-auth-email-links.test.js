// S96: email links (password recovery, invitation) are consumed on Atlas's own
// origin from a single-use token hash, so no bearer or refresh token has to
// travel in an Auth redirect URL (finding MAIN-01: the project's site_url
// fallback pointed at a stale deploy preview).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const recoverySource = fs.readFileSync(new URL('../../apps/web/assets/js/account-recovery.js', import.meta.url), 'utf8');
const invitationSource = fs.readFileSync(new URL('../../apps/web/assets/js/account-invitation.js', import.meta.url), 'utf8');

function recoveryPage(hash, verifyResult = { data: { session: { user: {} } }, error: null }) {
  const elements = Object.fromEntries(['status', 'request-recovery', 'complete-recovery', 'recovery-email', 'new-password', 'confirm-password'].map((id) => [id, {
    value: '', hidden: false, handlers: {}, button: {}, querySelector() { return this.button; }, addEventListener(event, fn) { this.handlers[event] = fn; }, reset() { this.value = ''; },
  }]));
  const calls = [];
  const order = [];
  const location = { href: 'https://isolated.example/recovery.html', pathname: '/recovery.html', hash };
  const client = {
    auth: {
      onAuthStateChange() {},
      async verifyOtp(args) { order.push(`verify:${location.hash}`); calls.push({ verifyOtp: args }); return verifyResult; },
      async resetPasswordForEmail() { return { error: null }; },
      async updateUser(value) { calls.push(value); return { error: null }; },
      async signOut(options) { calls.push({ signOut: options }); return { error: null }; },
    },
  };
  const history = { replaceState(_s, _t, url) { order.push('replace'); location.hash = ''; location.href = `https://isolated.example${url}`; } };
  vm.runInNewContext(recoverySource, {
    document: { getElementById: (id) => elements[id] },
    window: { VABAR_CONFIG: {}, AtlasRehearsalBoundary: { validate() {} }, supabase: { createClient: () => client } },
    location, history, URL, URLSearchParams,
  });
  return { elements, calls, order, submit: (id) => elements[id].handlers.submit({ preventDefault() {} }) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('recovery: a token_hash link is exchanged on this origin after it leaves the address bar', async () => {
  const p = recoveryPage('#token_hash=hash-123&type=recovery');
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls[0])), { verifyOtp: { token_hash: 'hash-123', type: 'recovery' } });
  assert.deepEqual(p.order, ['replace', 'verify:'], 'the hash is removed from the URL before the exchange');
  assert.equal(p.elements['complete-recovery'].hidden, false);
  p.elements['new-password'].value = 'long-test-password';
  p.elements['confirm-password'].value = 'long-test-password';
  await p.submit('complete-recovery');
  assert.equal(p.calls[1].password, 'long-test-password');
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls[2])), { signOut: { scope: 'global' } }, 'every other session ends after a reset');
});

test('recovery: an invalid or expired token_hash never unlocks the new-password form', async () => {
  const p = recoveryPage('#token_hash=bad&type=recovery', { data: { session: null }, error: { message: 'expired' } });
  await flush();
  assert.match(p.elements.status.textContent, /invalid or has expired/);
  p.elements['new-password'].value = 'long-test-password';
  p.elements['confirm-password'].value = 'long-test-password';
  await p.submit('complete-recovery');
  assert.equal(p.calls.filter((call) => call.password).length, 0);
});

test('recovery: a token_hash of another type (invite, magiclink, signup) is ignored', async () => {
  for (const type of ['invite', 'magiclink', 'signup', 'email_change', '']) {
    const p = recoveryPage(`#token_hash=x&type=${type}`);
    await flush();
    assert.equal(p.calls.length, 0, `type=${type} must not be exchanged by the recovery page`);
  }
});

test('invitation: the page exchanges only a token_hash from the fragment and clears it first', () => {
  assert.match(invitationSource, /new URLSearchParams\(location\.hash\.slice\(1\)\)\.get\('token_hash'\)/);
  assert.match(invitationSource, /history\.replaceState\(null, '', location\.pathname\)/);
  assert.match(invitationSource, /verifyOtp\(\{ token_hash: token, type: 'invite' \}\)/);
  assert.match(invitationSource, /detectSessionInUrl: false/, 'the invitation client never consumes URL session tokens');
});
