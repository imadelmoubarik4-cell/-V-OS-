// S113 guest booking emails (supabase/functions/atlas-booking-email-worker): the
// worker answers only the Vault-held secret (constant time, no CORS, no claim on a
// refused call); it sends nothing without the SMTP password; it sends each claimed
// email over one SMTP session as a UTF-8 plain-text message; a refused address
// fails only that email, a temporary reply retries it, a refused login retries
// everything claimed, a message handed over without an answer is failed (never
// repeated); responses and stored errors carry counts and codes only — never an
// address, a subject or the password.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADDRESS, RPC, SECRET_HEADER, buildMessage, createEmailWorkerHandler, encodeHeader,
} from '../../supabase/functions/atlas-booking-email-worker/handler.mjs';
import { createSmtpClient, dotStuff } from '../../supabase/functions/atlas-booking-email-worker/smtp.mjs';

const SECRET = 'worker-secret-0123456789abcdef-0123456789abcdef';
const PASSWORD = 'abcd efgh ijkl mnop';
const ENV = { BOOKING_EMAIL_SMTP_PASSWORD: PASSWORD, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role' };
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const mail = (id, to, extra = {}) => ({
  id, to, from: 'kanel@kanel.is', subject: 'Bókunin þín er staðfest · KA-ABC123',
  body: 'Halló Jón,\n\nBókunin þín á KANEL er staðfest.\n.\nKANEL', ...extra,
});

// A scripted SMTP server: answers each command; `reply(line)` may return a code
// to refuse it, or 'drop' to close the connection without an answer.
function fakeServer(reply = () => null) {
  const log = [];
  const messages = [];
  const decoder = new TextDecoder();
  function connect() {
    let inbox = '220 smtp.test ESMTP\r\n';
    let waiting = null;
    let inData = false;
    let data = '';
    let closed = false;
    const push = (text) => {
      inbox += text;
      if (waiting) { const w = waiting; waiting = null; w(); }
    };
    return {
      async read(buffer) {
        while (!inbox && !closed) await new Promise((resolve) => { waiting = resolve; });
        if (!inbox) return null;
        const bytes = new TextEncoder().encode(inbox);
        const n = Math.min(bytes.length, buffer.length);
        buffer.set(bytes.subarray(0, n));
        inbox = decoder.decode(bytes.subarray(n));
        return n;
      },
      async write(bytes) {
        const text = decoder.decode(bytes);
        if (inData) {
          data += text;
          if (data.endsWith('\r\n.\r\n')) {
            inData = false;
            const answer = reply('.');
            if (answer === 'drop') { closed = true; if (waiting) waiting(); return bytes.length; }
            messages.push(data.slice(0, -5));
            data = '';
            push(`${answer ?? 250} ok\r\n`);
          }
          return bytes.length;
        }
        for (const line of text.split('\r\n').filter(Boolean)) {
          log.push(line);
          const answer = reply(line);
          if (answer === 'drop') { closed = true; if (waiting) waiting(); continue; }
          if (answer) { push(`${answer} refused\r\n`); continue; }
          if (line.startsWith('EHLO')) push('250-smtp.test\r\n250-AUTH LOGIN PLAIN\r\n250 SMTPUTF8\r\n');
          else if (line.startsWith('AUTH')) push('235 2.7.0 Accepted\r\n');
          else if (line === 'DATA') { inData = true; push('354 go ahead\r\n'); }
          else if (line === 'QUIT') push('221 bye\r\n');
          else push('250 ok\r\n');
        }
        return bytes.length;
      },
      close() { closed = true; if (waiting) waiting(); },
    };
  }
  return { log, messages, connect };
}

function harness({ emails = [], secret = SECRET, env = ENV, server = fakeServer() } = {}) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === RPC.secret) return secret;
    if (name === RPC.claim) return { enabled: true, emails };
    if (name === RPC.complete) return { ok: true };
    throw new Error(`unexpected rpc ${name}`);
  };
  const smtp = createSmtpClient({ connect: server.connect, timeoutMs: 500 });
  const handle = createEmailWorkerHandler({ env, rpc, smtp, now: () => Date.parse('2026-10-29T12:00:00Z') });
  return { handle, calls, server, completes: () => calls.filter((c) => c.name === RPC.complete).map((c) => c.args) };
}

const wake = (headers = { [SECRET_HEADER]: SECRET }) => new Request('https://x.supabase.co/functions/v1/atlas-booking-email-worker', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"reason":"cron"}',
});

const decodeBody = (message) => {
  const [, body] = message.split('\r\n\r\n');
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
};

test('a missing or wrong secret is refused before any claim; no CORS; the secret is never echoed', async () => {
  for (const headers of [{}, { [SECRET_HEADER]: '' }, { [SECRET_HEADER]: 'wrong' }, { [SECRET_HEADER]: `${SECRET}x` }, { authorization: `Bearer ${SECRET}` }]) {
    const h = harness({ emails: [mail(ID1, 'guest@example.com')] });
    const res = await h.handle(wake(headers));
    assert.equal(res.status, 401, JSON.stringify(Object.keys(headers)));
    assert.deepEqual(h.calls.map((c) => c.name), [RPC.secret], 'only the secret was read');
    for (const [key] of res.headers) assert.doesNotMatch(key, /^access-control-/i);
    assert.doesNotMatch(await res.text(), new RegExp(SECRET));
  }
  const h = harness();
  const preflight = await h.handle(new Request('https://x.supabase.co/functions/v1/atlas-booking-email-worker', { method: 'OPTIONS', headers: { origin: 'https://example.org' } }));
  assert.equal(preflight.status, 404);
  for (const [key] of preflight.headers) assert.doesNotMatch(key, /^access-control-/i);
});

test('without a usable Vault secret the worker is not configured (503) and claims nothing', async () => {
  for (const secret of [null, '', 'short-secret']) {
    const h = harness({ secret });
    const res = await h.handle(wake());
    assert.equal(res.status, 503);
    assert.equal(h.calls.some((c) => c.name === RPC.claim), false);
  }
});

test('without the SMTP password nothing is claimed or sent', async () => {
  const h = harness({ env: { ...ENV, BOOKING_EMAIL_SMTP_PASSWORD: '' }, emails: [mail(ID1, 'guest@example.com')] });
  const res = await h.handle(wake());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, disabled: true });
  assert.equal(h.calls.some((c) => c.name === RPC.claim), false);
  assert.equal(h.server.log.length, 0);
});

test('claimed emails go out over one session as UTF-8 plain text, then are marked sent', async () => {
  const h = harness({ emails: [mail(ID1, 'guest@example.com'), mail(ID2, 'other.guest+bar@example.is', { subject: 'Your booking is confirmed · KA-XYZ789', body: 'Hello,\n\nConfirmed.' })] });
  const res = await h.handle(wake());
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out, { ok: true, claimed: 2, sent: 2, retry: 0, failed: 0 });
  assert.doesNotMatch(JSON.stringify(out), /@|KA-/, 'counts only');
  assert.deepEqual(h.completes(), [{ p_id: ID1, p_outcome: 'sent', p_error: null }, { p_id: ID2, p_outcome: 'sent', p_error: null }]);

  const log = h.server.log;
  assert.equal(log.filter((l) => l.startsWith('EHLO')).length, 1, 'one session');
  const auth = log.find((l) => l.startsWith('AUTH PLAIN '));
  assert.equal(Buffer.from(auth.slice(11), 'base64').toString('utf8'), '\u0000kanel@kanel.is\u0000abcdefghijklmnop', 'logs in as the sender, app-password spaces removed');
  assert.ok(log.includes('MAIL FROM:<kanel@kanel.is>'));
  assert.ok(log.includes('RCPT TO:<guest@example.com>'));
  assert.ok(log.includes('RCPT TO:<other.guest+bar@example.is>'));
  assert.equal(log.at(-1), 'QUIT');

  const [first] = h.server.messages;
  assert.match(first, /^From: KANEL <kanel@kanel\.is>\r\nTo: <guest@example\.com>\r\nReply-To: kanel@kanel\.is\r\n/);
  assert.match(first, /\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(first, /\r\nContent-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n/);
  assert.match(first, new RegExp(`\\r\\nMessage-ID: <${ID1}@kanel\\.is>\\r\\n`));
  assert.match(first, /\r\nDate: Thu, 29 Oct 2026 12:00:00 \+0000\r\n/);
  assert.equal(decodeBody(first), 'Halló Jón,\r\n\r\nBókunin þín á KANEL er staðfest.\r\n.\r\nKANEL');
});

test('a refused address fails only that email; a temporary reply retries it; the session carries on', async () => {
  const server = fakeServer((line) => (line === 'RCPT TO:<gone@example.com>' ? 550 : line === 'RCPT TO:<busy@example.com>' ? 451 : null));
  const h = harness({ server, emails: [mail(ID1, 'gone@example.com'), mail(ID2, 'busy@example.com'), mail(ID3, 'guest@example.com')] });
  const out = await (await h.handle(wake())).json();
  assert.deepEqual(out, { ok: true, claimed: 3, sent: 1, retry: 1, failed: 1 });
  assert.deepEqual(h.completes(), [
    { p_id: ID1, p_outcome: 'failed', p_error: 'smtp 550 at rcpt' },
    { p_id: ID2, p_outcome: 'retry', p_error: 'smtp 451 at rcpt' },
    { p_id: ID3, p_outcome: 'sent', p_error: null },
  ]);
  assert.equal(server.log.filter((l) => l === 'RSET').length, 2, 'each refused transaction is reset');
  assert.equal(server.messages.length, 1);
});

test('a refused login retries every claimed email later and never stores or returns the password', async () => {
  const server = fakeServer((line) => (line.startsWith('AUTH') ? 535 : null));
  const h = harness({ server, emails: [mail(ID1, 'guest@example.com'), mail(ID2, 'other@example.com')] });
  const res = await h.handle(wake());
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { ok: true, claimed: 2, sent: 0, retry: 2, failed: 0 });
  assert.deepEqual(h.completes(), [
    { p_id: ID1, p_outcome: 'retry', p_error: 'smtp login refused' },
    { p_id: ID2, p_outcome: 'retry', p_error: 'smtp login refused' },
  ]);
  assert.doesNotMatch(text + JSON.stringify(h.calls), /abcd ?efgh|YWJjZCBlZmdo|YWJjZGVmZ2g/);
  assert.equal(server.log.some((l) => l.startsWith('MAIL')), false);
});

test('a message handed over without an answer is failed, never sent again; the rest wait', async () => {
  const server = fakeServer((line) => (line === '.' ? 'drop' : null));
  const h = harness({ server, emails: [mail(ID1, 'guest@example.com'), mail(ID2, 'other@example.com')] });
  const out = await (await h.handle(wake())).json();
  assert.deepEqual(out, { ok: true, claimed: 2, sent: 0, retry: 1, failed: 1 });
  assert.deepEqual(h.completes(), [
    { p_id: ID1, p_outcome: 'failed', p_error: 'no answer after the message was sent' },
    { p_id: ID2, p_outcome: 'retry', p_error: 'smtp no reply at data-end' },
  ], 'the next email is not sent on a dead session; it goes back to the queue');
  assert.equal(server.messages.length, 0);
});

test('an undeliverable address from the queue is failed without opening a connection', async () => {
  const h = harness({ emails: [mail(ID1, 'guest@example.com\r\nBcc: x@y.z'), mail(ID2, 'no-at-sign')] });
  const out = await (await h.handle(wake())).json();
  assert.deepEqual(out, { ok: true, claimed: 2, sent: 0, retry: 0, failed: 2 });
  assert.equal(h.server.log.length, 0);
});

test('the Vault secret is cached between wake-ups', async () => {
  const h = harness();
  await h.handle(wake());
  await h.handle(wake());
  assert.equal(h.calls.filter((c) => c.name === RPC.secret).length, 1);
});

test('headers cannot be injected; long subjects fold into ≤ 75-character encoded words', () => {
  assert.equal(encodeHeader('Hello\r\nBcc: x@y.z'), 'Hello Bcc: x@y.z');
  const folded = encodeHeader('Bókuninni þinni hefur verið aflýst · KA-ABC123 · fimmtudagur 29. október 2026');
  for (const word of folded.split('\r\n ')) {
    assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.ok(word.length <= 75, word);
  }
  const decoded = folded.split('\r\n ').map((w) => Buffer.from(w.slice(10, -2), 'base64')).reduce((a, b) => Buffer.concat([a, b]));
  assert.equal(decoded.toString('utf8'), 'Bókuninni þinni hefur verið aflýst · KA-ABC123 · fimmtudagur 29. október 2026');
  assert.equal(ADDRESS.test('guest@example.com'), true);
  assert.equal(ADDRESS.test('guest@example.com\r\nBcc: x@y.z'), false);
  assert.equal(ADDRESS.test('<guest@example.com>'), false);
  assert.equal(dotStuff('a\r\n.b\r\n..c'), 'a\r\n..b\r\n...c');
  const message = buildMessage(mail(ID1, 'guest@example.com'), new Date('2026-10-29T12:00:00Z'));
  for (const line of message.split('\r\n')) assert.ok(line.length <= 998);
});
