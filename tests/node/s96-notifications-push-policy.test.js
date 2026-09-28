// S96 (edgea): atlas-notifications must not become an SSRF relay (staff
// register the endpoint the dispatcher POSTs to), must compare the dispatch
// token in constant time, and must catch dispatch failures in its handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { dispatchTokenMatches, pushEndpointAllowed } from '../../supabase/functions/atlas-notifications/push-policy.mjs';

const SOURCE = readFileSync(new URL('../../supabase/functions/atlas-notifications/index.ts', import.meta.url), 'utf8');

test('browser push services are accepted', () => {
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://web.push.apple.com/QOx',
    'https://wns2-by3p.notify.windows.com/w/?token=x',
  ]) assert.equal(pushEndpointAllowed(endpoint), true, endpoint);
});

test('internal, metadata, look-alike and non-https endpoints are refused', () => {
  for (const endpoint of [
    'https://169.254.169.254/latest/meta-data/',
    'https://localhost/x', 'https://127.0.0.1:8443/x', 'https://[::1]/x',
    'https://dnefgcmjcgxlynycxkts.supabase.co/rest/v1/rpc/x',
    'http://fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com.attacker.test/x',
    'https://user:pass@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://notify.windows.com/x',
    'javascript:alert(1)', 'file:///etc/passwd', '', null,
  ]) assert.equal(pushEndpointAllowed(endpoint), false, String(endpoint));
});

test('dispatch token: constant-time digest compare, 32-byte minimum', async () => {
  const token = 'dispatch-token-0123456789abcdef-0123456789';
  assert.equal(await dispatchTokenMatches(token, token), true);
  assert.equal(await dispatchTokenMatches(`${token}x`, token), false);
  assert.equal(await dispatchTokenMatches('', token), false);
  assert.equal(await dispatchTokenMatches(null, token), false);
  assert.equal(await dispatchTokenMatches('short', 'short'), false, 'a short configured token never matches');
});

test('index.ts uses the policy module, awaits dispatch and never echoes setting names', () => {
  assert.match(SOURCE, /from "\.\/push-policy\.mjs"/);
  assert.match(SOURCE, /if \(!pushEndpointAllowed\(endpoint\)\)/);
  assert.match(SOURCE, /await dispatchTokenMatches\(request\.headers\.get\("x-atlas-dispatch-token"\), expected\)/);
  assert.doesNotMatch(SOURCE, /!== expected/);
  assert.match(SOURCE, /return await dispatch\(request\)/);
  assert.doesNotMatch(SOURCE, /`\$\{name\} is not configured\.`/);
});
