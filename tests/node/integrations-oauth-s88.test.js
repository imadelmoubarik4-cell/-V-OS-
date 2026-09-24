import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  base64UrlEncode,
  buildRedirectUri,
  buildReturnUrl,
  createOAuthState,
  createPkcePair,
  createStateLedger,
  credentialAad,
  decryptJson,
  encryptJson,
  findSecretKeys,
  hashState,
  importAesKey,
  isAllowedHost,
  isAllowedRedirectUri,
  isValidPkceVerifier,
  isWellFormedState,
  normalizeReturnPath,
  parseAllowedOrigins,
  pkceChallengeS256,
  sanitizeProviderError,
} from '../../supabase/functions/atlas-integrations/oauth-core.mjs';
import {
  PROVIDER_KEYS,
  PROVIDERS,
  buildAuthorizeUrl,
  providerConfiguration,
} from '../../supabase/functions/atlas-integrations/providers.mjs';
import { createIntegrationsHandler, jsonResponse, rpcFailure } from '../../supabase/functions/atlas-integrations/handler.mjs';

const FUNCTION_DIR = 'supabase/functions/atlas-integrations';
const MIGRATION = 'supabase/migrations/20260926095000_s88_integrations_oauth.sql';
const KEK = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEK = Buffer.alloc(32, 9).toString('base64');

// ------------------------------------------------------------------ PKCE

test('PKCE S256 matches the RFC 7636 appendix B vector', async () => {
  assert.equal(
    await pkceChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('PKCE pairs are fresh, unreserved-character verifiers of legal length', async () => {
  const first = await createPkcePair();
  const second = await createPkcePair();
  assert.equal(first.method, 'S256');
  assert.ok(isValidPkceVerifier(first.verifier));
  assert.ok(first.verifier.length >= 43 && first.verifier.length <= 128);
  assert.notEqual(first.verifier, second.verifier);
  assert.equal(first.challenge, await pkceChallengeS256(first.verifier));
  assert.notEqual(first.challenge, first.verifier);
  await assert.rejects(() => pkceChallengeS256('short'));
  assert.equal(isValidPkceVerifier('a'.repeat(129)), false);
  assert.equal(isValidPkceVerifier('a'.repeat(42) + '!'), false);
});

// ------------------------------------------------------------------ state

test('OAuth state is 256-bit, stored only as a sha256 hash', async () => {
  const state = createOAuthState();
  assert.ok(isWellFormedState(state));
  const hash = await hashState(state);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await hashState(state));
  assert.ok(!hash.includes(state));
  assert.notEqual(await hashState(createOAuthState()), hash);
  await assert.rejects(() => hashState('not a state'));
  assert.equal(isWellFormedState(`${state}x`), false);
});

test('state is single-use, provider-bound and expires', async () => {
  let clock = 1_000_000;
  const ledger = createStateLedger(() => clock);
  const state = createOAuthState();
  const hash = await hashState(state);
  ledger.issue(hash, 'google-drive');
  assert.deepEqual(ledger.storedKeys(), [hash]);
  assert.equal(ledger.consume(hash, 'facebook'), null, 'wrong provider');
  assert.deepEqual(ledger.consume(hash, 'google-drive'), { providerKey: 'google-drive' });
  assert.equal(ledger.consume(hash, 'google-drive'), null, 'replay rejected');

  const late = await hashState(createOAuthState());
  ledger.issue(late, 'tiktok');
  clock += 600_001;
  assert.equal(ledger.consume(late, 'tiktok'), null, 'expired after 10 minutes');
});

test('the migration enforces the same single-use rule and stores only hashes', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  assert.match(sql, /state_hash bytea primary key check \(octet_length\(state_hash\) = 32\)/);
  assert.match(sql, /and s\.consumed_at is null\s+and s\.expires_at > now\(\)/);
  assert.match(sql, /set consumed_at = now\(\)/);
  assert.match(sql, /interval '10 minutes'/);
  assert.doesNotMatch(sql, /\bstate text\b/, 'raw state column must not exist');
});

// ------------------------------------------------------------------ AES-GCM

test('AES-256-GCM round trip with provider-bound AAD', async () => {
  const key = await importAesKey(KEK);
  const secret = { access_token: 'ya29.secret-access', refresh_token: '1//secret-refresh' };
  const aad = credentialAad('google-drive', 'oauth_token_set');
  const sealed = await encryptJson(key, secret, aad);
  assert.match(sealed.nonceHex, /^[0-9a-f]{24}$/);
  assert.ok(!sealed.ciphertextHex.includes(Buffer.from('ya29').toString('hex')));
  assert.deepEqual(await decryptJson(key, sealed.ciphertextHex, sealed.nonceHex, aad), secret);
  const again = await encryptJson(key, secret, aad);
  assert.notEqual(again.nonceHex, sealed.nonceHex, 'fresh nonce per encryption');
  assert.notEqual(again.ciphertextHex, sealed.ciphertextHex);
});

test('AES-GCM rejects tampering, the wrong AAD and the wrong key', async () => {
  const key = await importAesKey(KEK);
  const aad = credentialAad('tiktok', 'oauth_token_set');
  const sealed = await encryptJson(key, { access_token: 'x' }, aad);
  const flipped = (sealed.ciphertextHex[0] === 'a' ? 'b' : 'a') + sealed.ciphertextHex.slice(1);
  await assert.rejects(() => decryptJson(key, flipped, sealed.nonceHex, aad));
  const badNonce = (sealed.nonceHex[0] === 'a' ? 'b' : 'a') + sealed.nonceHex.slice(1);
  await assert.rejects(() => decryptJson(key, sealed.ciphertextHex, badNonce, aad));
  await assert.rejects(() => decryptJson(key, sealed.ciphertextHex, sealed.nonceHex, credentialAad('facebook', 'oauth_token_set')));
  await assert.rejects(async () => decryptJson(await importAesKey(OTHER_KEK), sealed.ciphertextHex, sealed.nonceHex, aad));
  await assert.rejects(() => importAesKey(Buffer.alloc(16, 1).toString('base64')), /32 bytes/);
  await assert.rejects(() => importAesKey('not base64 !'), /base64/);
});

// ------------------------------------------------------------------ redirect allow-list

test('redirect URI is an exact https callback on an allow-listed host', () => {
  const hosts = ['*.supabase.co'];
  const uri = buildRedirectUri('https://abc123.supabase.co', 'google-drive', hosts);
  assert.equal(uri, 'https://abc123.supabase.co/functions/v1/atlas-integrations/callback/google-drive');
  assert.ok(isAllowedRedirectUri(uri, 'https://abc123.supabase.co', 'google-drive', hosts));
  assert.equal(isAllowedRedirectUri(`${uri}?x=1`, 'https://abc123.supabase.co', 'google-drive', hosts), false);
  assert.equal(isAllowedRedirectUri(uri, 'https://abc123.supabase.co', 'facebook', hosts), false);
  assert.equal(buildRedirectUri('http://abc123.supabase.co', 'google-drive', hosts), null, 'http rejected');
  assert.equal(buildRedirectUri('https://evil.example.com', 'google-drive', hosts), null, 'host rejected');
  assert.equal(buildRedirectUri('https://a.b.supabase.co', 'google-drive', hosts), null, 'wildcard is one label');
  assert.equal(buildRedirectUri('https://supabase.co.evil.com', 'google-drive', hosts), null);
  assert.equal(buildRedirectUri('https://abc123.supabase.co/path', 'google-drive', hosts), null);
  assert.equal(buildRedirectUri('https://abc123.supabase.co/?q=1', 'google-drive', hosts), null);
  assert.equal(buildRedirectUri('https://user:pw@abc123.supabase.co', 'google-drive', hosts), null);
  assert.equal(buildRedirectUri('https://abc123.supabase.co', '../x', hosts), null);
  assert.equal(isAllowedHost('functions.example.org', ['functions.example.org']), true);
  assert.equal(isAllowedHost('xfunctions.example.org', ['functions.example.org']), false);
});

test('return target is an allow-listed https origin plus an Atlas hash route', () => {
  assert.deepEqual(parseAllowedOrigins('https://os.example.is, http://insecure.example, https://x.example/path, junk'), ['https://os.example.is']);
  assert.equal(normalizeReturnPath('#settings'), '#settings');
  assert.equal(normalizeReturnPath('#marketing/connections'), '#marketing/connections');
  assert.equal(normalizeReturnPath(''), '#settings');
  assert.equal(normalizeReturnPath('https://evil.example'), null);
  assert.equal(normalizeReturnPath('//evil.example'), null);
  assert.equal(normalizeReturnPath('#settings?x=<script>'), null);
  assert.equal(
    buildReturnUrl('https://os.example.is', '#settings', 'tiktok', 'error', 'denied'),
    'https://os.example.is/?integration=tiktok&result=error&reason=denied#settings',
  );
});

// ------------------------------------------------------------------ provider registry

test('registry covers the six providers with documented endpoints and minimal scopes', () => {
  assert.deepEqual([...PROVIDER_KEYS].sort(), ['facebook', 'google-business-profile', 'google-drive', 'instagram', 'tiktok', 'tripadvisor']);
  const env = () => undefined;
  assert.equal(PROVIDERS['google-business-profile'].authorizeUrl(env), 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(PROVIDERS['google-business-profile'].tokenUrl(env), 'https://oauth2.googleapis.com/token');
  assert.deepEqual(PROVIDERS['google-business-profile'].scopes, ['https://www.googleapis.com/auth/business.manage']);
  assert.deepEqual(PROVIDERS['google-drive'].scopes, ['https://www.googleapis.com/auth/drive.file']);
  assert.equal(PROVIDERS.facebook.authorizeUrl(env), 'https://www.facebook.com/v25.0/dialog/oauth');
  assert.equal(PROVIDERS.facebook.tokenUrl(env), 'https://graph.facebook.com/v25.0/oauth/access_token');
  assert.deepEqual(PROVIDERS.instagram.scopes, ['instagram_basic', 'pages_show_list']);
  assert.equal(PROVIDERS.tiktok.authorizeUrl(env), 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(PROVIDERS.tiktok.tokenUrl(env), 'https://open.tiktokapis.com/v2/oauth/token/');
  assert.deepEqual(PROVIDERS.tiktok.scopes, ['user.info.basic']);
  assert.equal(PROVIDERS.tripadvisor.auth_kind, 'api_key');
  assert.equal(PROVIDERS.tripadvisor.endpoint_evidence, 'unverified');
  for (const provider of Object.values(PROVIDERS)) {
    for (const scope of provider.scopes) assert.ok(!provider.future_scopes.includes(scope));
    if (provider.auth_kind === 'oauth2') assert.ok(['S256', 'none'].includes(provider.pkce));
  }
  assert.equal(PROVIDERS['google-drive'].pkce, 'S256');
  assert.equal(PROVIDERS['google-business-profile'].pkce, 'S256');
});

test('authorize URLs carry state, exact redirect, minimal scopes and S256 when used', () => {
  const env = (name) => ({ ATLAS_GOOGLE_OAUTH_CLIENT_ID: 'gid', ATLAS_TIKTOK_CLIENT_KEY: 'tkey' })[name];
  const google = new URL(buildAuthorizeUrl(PROVIDERS['google-drive'], env, { redirectUri: 'https://a.supabase.co/functions/v1/atlas-integrations/callback/google-drive', state: 's', codeChallenge: 'c' }));
  assert.equal(google.searchParams.get('client_id'), 'gid');
  assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(google.searchParams.get('access_type'), 'offline');
  assert.equal(google.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(google.searchParams.get('client_secret'), null);
  const tiktok = new URL(buildAuthorizeUrl(PROVIDERS.tiktok, env, { redirectUri: 'r', state: 's', codeChallenge: null }));
  assert.equal(tiktok.searchParams.get('client_key'), 'tkey');
  assert.equal(tiktok.searchParams.get('code_challenge'), null);
  assert.throws(() => buildAuthorizeUrl(PROVIDERS['google-drive'], env, { redirectUri: 'r', state: 's', codeChallenge: null }));
});

test('providers report exactly what is missing when not configured', () => {
  const empty = () => undefined;
  for (const key of PROVIDER_KEYS) {
    const config = providerConfiguration(PROVIDERS[key], empty);
    assert.equal(config.configured, false, key);
    assert.match(config.message, /^Not available yet — requires /, key);
    assert.match(config.message, /ATLAS_INTEGRATION_KEK_V1/, key);
  }
  assert.match(providerConfiguration(PROVIDERS.tiktok, empty).message, /ATLAS_TIKTOK_CLIENT_KEY/);
  assert.match(providerConfiguration(PROVIDERS.facebook, empty).message, /ATLAS_META_APP_SECRET/);
  assert.match(providerConfiguration(PROVIDERS.tripadvisor, empty).message, /Terra API/);
  const bad = (name) => ({ ATLAS_INTEGRATION_KEK_V1: KEK, ATLAS_INTEGRATIONS_APP_ORIGINS: 'https://os.example.is', ATLAS_TRIPADVISOR_VERIFY_URL: 'https://evil.example/{location_id}', ATLAS_TRIPADVISOR_LOCATION_ID: '1' })[name];
  assert.equal(providerConfiguration(PROVIDERS.tripadvisor, bad).configured, false);
});

test('provider errors are sanitised before storage', () => {
  const cleaned = sanitizeProviderError('invalid_grant access_token=ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz code=4/abc');
  assert.doesNotMatch(cleaned, /ya29|4\/abc|abcdefghijklmnop/);
  assert.ok(cleaned.length <= 240);
});

// ------------------------------------------------------------------ handler (fake DB + provider)

function fakeDatabase() {
  const rows = new Map(PROVIDER_KEYS.map((key) => [key, {
    provider_key: key, status: 'not_connected', authorization_state: 'not_connected', scopes_granted: [],
    external_account_label: null, last_verified_at: null, token_expires_at: null, last_connection_error: null,
  }]));
  const states = new Map();
  const credentials = new Map();
  const events = [];
  const calls = [];
  const manager = (role) => { if (!['admin', 'manager'].includes(role)) throw Object.assign(new Error('forbidden'), { status: 403 }); };
  // Current profiles (the SQL re-checks the initiating user at callback time).
  const profiles = new Map([[OWNER_ID, { role: 'manager', active: true }]]);
  const rpc = async (name, payload) => {
    calls.push({ name, payload: structuredClone(payload) });
    switch (name) {
      case 'atlas_integration_status':
        manager(payload.p_actor_role);
        return [...rows.values()].map((row) => ({
          ...row,
          has_credential: credentials.has(row.provider_key),
          credential_access_expires_at: credentials.get(row.provider_key)?.access_expires_at ?? null,
          recent_events: events.filter((e) => e.provider_key === row.provider_key).slice(-5).reverse(),
        }));
      case 'atlas_integration_begin':
        manager(payload.p_actor_role);
        states.set(payload.p_state_hash, { ...payload, consumed: false, binding: null });
        events.push({ provider_key: payload.p_provider_key, event_type: 'connect_started', created_at: 'now' });
        return { expires_at: '2026-09-24T12:10:00Z' };
      case 'atlas_integration_bind_browser': {
        // Mirrors atlas_private.integration_bind_browser: once, unconsumed.
        const row = states.get(payload.p_state_hash);
        if (!row || row.consumed || row.binding || row.p_provider_key !== payload.p_provider_key) return null;
        row.binding = payload.p_binding_hash;
        return { bound: true, expires_at: '2026-09-24T12:10:00Z' };
      }
      case 'atlas_integration_consume_state': {
        // Mirrors atlas_private.integration_consume_state: bound browser only,
        // and the initiating user must still be an active manager/admin.
        const row = states.get(payload.p_state_hash);
        if (!row || row.consumed || row.p_provider_key !== payload.p_provider_key) return null;
        if (!payload.p_binding_hash || row.binding !== payload.p_binding_hash) return null;
        row.consumed = true;
        const current = profiles.get(row.p_actor_id);
        if (!current || !current.active || !['admin', 'manager'].includes(current.role)) {
          return { provider_key: row.p_provider_key, actor_allowed: false, return_path: row.p_return_path };
        }
        return {
          provider_key: row.p_provider_key, actor_allowed: true, actor_id: row.p_actor_id, actor_label: row.p_actor_label, actor_role: current.role,
          verifier_ciphertext: row.p_verifier_ciphertext, verifier_nonce: row.p_verifier_nonce, key_version: row.p_key_version, return_path: row.p_return_path,
        };
      }
      case 'atlas_integration_store_credential':
        manager(payload.p_actor_role);
        credentials.set(payload.p_provider_key, { kind: payload.p_credential_kind, ciphertext: payload.p_ciphertext, nonce: payload.p_nonce, key_version: payload.p_key_version, access_expires_at: payload.p_access_expires_at });
        if (rows.get(payload.p_provider_key).status !== 'connected') Object.assign(rows.get(payload.p_provider_key), { status: 'authorization_required', authorization_state: 'waiting_authorization' });
        return { stored: true };
      case 'atlas_integration_read_credential': {
        manager(payload.p_actor_role);
        const row = credentials.get(payload.p_provider_key);
        return row ? { credential_kind: row.kind, ciphertext: row.ciphertext, nonce: row.nonce, key_version: row.key_version, access_expires_at: row.access_expires_at } : null;
      }
      case 'atlas_integration_record_result': {
        manager(payload.p_actor_role);
        const row = rows.get(payload.p_provider_key);
        if (payload.p_event_type === 'verified') {
          if (!credentials.has(payload.p_provider_key)) throw new Error('no credential');
          Object.assign(row, { status: 'connected', authorization_state: 'authorized', external_account_label: payload.p_account_label, last_verified_at: '2026-09-24T12:00:00Z', last_connection_error: null, scopes_granted: payload.p_scopes ?? [] });
        } else if (payload.p_event_type !== 'refreshed') {
          Object.assign(row, { status: payload.p_needs_reauthorization ? 'expired' : 'degraded', last_connection_error: payload.p_error });
        }
        events.push({ provider_key: payload.p_provider_key, event_type: payload.p_event_type, created_at: 'now' });
        return { recorded: payload.p_event_type };
      }
      case 'atlas_integration_disconnect':
        manager(payload.p_actor_role);
        credentials.delete(payload.p_provider_key);
        Object.assign(rows.get(payload.p_provider_key), { status: 'not_connected', authorization_state: 'not_connected', external_account_label: null, last_verified_at: null });
        return { disconnected: true };
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  };
  return { rpc, rows, states, credentials, events, calls, profiles };
}

const OWNER_ID = '00000000-0000-4000-8000-000000000088';

const CONFIGURED_ENV = {
  ATLAS_INTEGRATION_KEK_V1: KEK,
  ATLAS_INTEGRATIONS_APP_ORIGINS: 'https://os.example.is',
  SUPABASE_URL: 'https://abc123.supabase.co',
  ATLAS_GOOGLE_OAUTH_CLIENT_ID: 'google-client-id',
  ATLAS_GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret-value',
  ATLAS_TIKTOK_CLIENT_KEY: 'tiktok-key',
  ATLAS_TIKTOK_CLIENT_SECRET: 'tiktok-client-secret-value',
};
const ACCESS_TOKEN = 'ya29.ACCESS-TOKEN-THAT-MUST-NEVER-LEAK';
const REFRESH_TOKEN = '1//REFRESH-TOKEN-THAT-MUST-NEVER-LEAK';

function harness({ env = {}, role = 'manager', verifyOk = true } = {}) {
  const db = fakeDatabase();
  const providerCalls = [];
  const fetchImpl = async (url, init = {}) => {
    providerCalls.push({ url: String(url), init });
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.file', token_type: 'Bearer' }), { status: 200 });
    }
    if (String(url).startsWith('https://www.googleapis.com/drive/v3/about')) {
      return verifyOk
        ? new Response(JSON.stringify({ user: { displayName: 'VÁ Drive', permissionId: '123' } }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: `Request had invalid authentication credentials ${ACCESS_TOKEN}` } }), { status: 401 });
    }
    if (String(url) === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const handle = createIntegrationsHandler({
    env: (name) => env[name],
    fetchImpl,
    rpc: db.rpc,
    authenticate: async (request) => {
      if (!request.headers.get('authorization')) throw Object.assign(new Error('auth'), { status: 401 });
      return { user: { id: OWNER_ID }, profile: { role, display_name: 'Owner', active: true } };
    },
    now: () => Date.parse('2026-09-24T12:00:00Z'),
  });
  const call = (method, action, body) => handle(new Request(`https://abc123.supabase.co/atlas-integrations?action=${action}`, {
    method,
    headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }));
  // Opens the Atlas authorize hop like the browser does: returns the cookie
  // it sets and the provider URL it redirects to.
  const openHop = async (authorizeUrl) => {
    const response = await handle(new Request(authorizeUrl));
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
    return { response, cookie, location: response.headers.get('location') };
  };
  return { handle, call, db, providerCalls, openHop };
}

function assertNoLeak(text) {
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, 'google-client-secret-value', 'tiktok-client-secret-value', KEK, 'ta-api-key-value']) {
    assert.ok(!text.includes(secret), `response leaked ${secret.slice(0, 12)}`);
  }
}

test('unconfigured providers: status says "Not available yet", start and save-api-key refuse', async () => {
  const { call } = harness();
  const status = await call('GET', 'status');
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.providers.length, 6);
  for (const provider of body.providers) {
    assert.equal(provider.connection_state, 'not_configured');
    assert.equal(provider.can_connect, false);
    assert.match(provider.available_message, /^Not available yet — requires /);
  }
  const start = await call('POST', 'start', { provider_key: 'instagram', return_path: '#settings' });
  assert.equal(start.status, 409);
  const startBody = await start.json();
  assert.equal(startBody.error_code, 'not_configured');
  assert.match(startBody.error, /^Not available yet — requires .*ATLAS_META_APP_ID/);
  const save = await call('POST', 'save-api-key', { provider_key: 'tripadvisor', api_key: 'ta-api-key-value' });
  assert.equal(save.status, 409);
  assertNoLeak(await save.text());
});

test('staff and viewers cannot manage integrations', async () => {
  for (const role of ['bartender', 'viewer']) {
    const { call } = harness({ env: CONFIGURED_ENV, role });
    const response = await call('GET', 'status');
    assert.equal(response.status, 403);
  }
});

test('full Google Drive flow: PKCE start, single-use callback, encrypted storage, verified before connected', async () => {
  const { call, handle, db, providerCalls, openHop } = harness({ env: CONFIGURED_ENV });
  const start = await call('POST', 'start', { provider_key: 'google-drive', return_path: '#knowledge' });
  assert.equal(start.status, 200);
  const startText = await start.text();
  assertNoLeak(startText);
  const { authorize_url: authorizeUrl } = JSON.parse(startText);
  assert.match(authorizeUrl, /^https:\/\/abc123\.supabase\.co\/functions\/v1\/atlas-integrations\/authorize\/google-drive\?/);
  const hop = await openHop(authorizeUrl);
  assert.equal(hop.response.status, 302);
  assert.match(hop.response.headers.get('set-cookie'), /^__Host-atlas-oauth-google-drive=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/);
  const authorize = new URL(hop.location);
  assert.equal(authorize.origin + authorize.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const state = authorize.searchParams.get('state');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://abc123.supabase.co/functions/v1/atlas-integrations/callback/google-drive');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');

  const [begin] = db.calls.filter((c) => c.name === 'atlas_integration_begin');
  assert.equal(begin.payload.p_state_hash, await hashState(state), 'only the hash is stored');
  assert.ok(!JSON.stringify(begin.payload).includes(state));

  const before = await (await call('GET', 'status')).json();
  assert.equal(before.providers.find((p) => p.provider_key === 'google-drive').connection_state, 'ready');

  const callbackUrl = `https://abc123.supabase.co/atlas-integrations/callback/google-drive?code=4%2Fauth-code&state=${state}`;
  const callback = await handle(new Request(callbackUrl, { headers: { cookie: hop.cookie } }));
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get('set-cookie'), /^__Host-atlas-oauth-google-drive=; Path=\/; Max-Age=0/);
  assert.equal(callback.headers.get('location'), 'https://os.example.is/?integration=google-drive&result=connected#knowledge');

  const exchange = providerCalls.find((c) => c.url === 'https://oauth2.googleapis.com/token');
  const form = new URLSearchParams(exchange.init.body);
  assert.equal(await pkceChallengeS256(form.get('code_verifier')), authorize.searchParams.get('code_challenge'));
  assert.equal(form.get('redirect_uri'), authorize.searchParams.get('redirect_uri'));

  const stored = db.credentials.get('google-drive');
  const everyRpc = JSON.stringify(db.calls);
  assert.ok(!everyRpc.includes(ACCESS_TOKEN) && !everyRpc.includes(REFRESH_TOKEN), 'database never receives plaintext tokens');
  const opened = await decryptJson(await importAesKey(KEK), stored.ciphertext, stored.nonce, credentialAad('google-drive', 'oauth_token_set'));
  assert.equal(opened.access_token, ACCESS_TOKEN);

  const statusText = await (await call('GET', 'status')).text();
  assertNoLeak(statusText);
  assert.deepEqual(findSecretKeys(JSON.parse(statusText)), []);
  const drive = JSON.parse(statusText).providers.find((p) => p.provider_key === 'google-drive');
  assert.equal(drive.connection_state, 'connected');
  assert.equal(drive.account_label, 'VÁ Drive');

  const replay = await handle(new Request(callbackUrl, { headers: { cookie: hop.cookie } }));
  assert.equal(replay.headers.get('location'), 'https://os.example.is/?integration=google-drive&result=error&reason=invalid_state#settings');
  assert.equal(providerCalls.filter((c) => c.url === 'https://oauth2.googleapis.com/token').length, 1, 'replayed code is never exchanged');

  const tested = await call('POST', 'test', { provider_key: 'google-drive' });
  const testedText = await tested.text();
  assertNoLeak(testedText);
  assert.equal(JSON.parse(testedText).verified, true);

  const disconnected = await call('POST', 'disconnect', { provider_key: 'google-drive' });
  const disconnectedBody = await disconnected.json();
  assert.equal(disconnectedBody.revoked_at_provider, true);
  assert.equal(disconnectedBody.provider.connection_state, 'ready');
  assert.equal(db.credentials.has('google-drive'), false);
});

test('a failed provider check never reports connected and never echoes the provider body', async () => {
  const { call, handle, db, openHop } = harness({ env: CONFIGURED_ENV, verifyOk: false });
  const { authorize_url: authorizeUrl } = await (await call('POST', 'start', { provider_key: 'google-drive' })).json();
  const hop = await openHop(authorizeUrl);
  const state = new URL(hop.location).searchParams.get('state');
  const callback = await handle(new Request(`https://abc123.supabase.co/atlas-integrations/callback/google-drive?code=abc&state=${state}`, { headers: { cookie: hop.cookie } }));
  assert.match(callback.headers.get('location'), /result=error&reason=verify_failed/);
  const statusText = await (await call('GET', 'status')).text();
  assertNoLeak(statusText);
  const drive = JSON.parse(statusText).providers.find((p) => p.provider_key === 'google-drive');
  assert.notEqual(drive.connection_state, 'connected');
  assert.equal(drive.connection_state, 'needs_reauthorization');
  assert.ok(!db.events.some((e) => e.event_type === 'verified'));
});

test('callback rejects malformed, unknown and cross-provider state without calling the provider', async () => {
  const { call, handle, providerCalls, openHop } = harness({ env: CONFIGURED_ENV });
  const { authorize_url: authorizeUrl } = await (await call('POST', 'start', { provider_key: 'google-drive' })).json();
  const hop = await openHop(authorizeUrl);
  const state = new URL(hop.location).searchParams.get('state');
  const providerCallsBefore = providerCalls.length;
  for (const url of [
    'https://abc123.supabase.co/atlas-integrations/callback/google-drive?code=abc&state=bad',
    `https://abc123.supabase.co/atlas-integrations/callback/google-drive?code=abc&state=${createOAuthState()}`,
    `https://abc123.supabase.co/atlas-integrations/callback/google-business-profile?code=abc&state=${state}`,
    `https://abc123.supabase.co/atlas-integrations/callback/nope?code=abc&state=${state}`,
  ]) {
    const response = await handle(new Request(url, { headers: { cookie: hop.cookie } }));
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /^https:\/\/os\.example\.is\/\?integration=[a-z-]+&result=error/);
  }
  assert.equal(providerCalls.length, providerCallsBefore);
  const denied = await handle(new Request(`https://abc123.supabase.co/atlas-integrations/callback/google-drive?error=access_denied&state=${state}`, { headers: { cookie: hop.cookie } }));
  assert.match(denied.headers.get('location'), /reason=denied/);
});

test('start refuses caller-supplied absolute return targets', async () => {
  const { call } = harness({ env: CONFIGURED_ENV });
  const response = await call('POST', 'start', { provider_key: 'google-drive', return_path: 'https://evil.example/' });
  assert.equal(response.status, 400);
});

// ------------------------------------------------------------------ source contract

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test('source contract: responses are built only from metadata, secrets only from env', () => {
  const handler = readFileSync(`${FUNCTION_DIR}/handler.mjs`, 'utf8');
  const publicBlock = handler.slice(handler.indexOf('function publicProvider'), handler.indexOf('async function statusRows'));
  for (const field of ['access_token', 'refresh_token', 'api_key', 'ciphertext', 'nonce', 'verifier', 'client_secret', 'state_hash']) {
    assert.doesNotMatch(publicBlock, new RegExp(`(^|[\\s{,])${field}:`, 'm'), `publicProvider must not emit ${field}`);
  }
  assert.match(handler, /assertNoSecretFields\(value\)/, 'every JSON response is screened');
  const jsonCalls = handler.match(/jsonResponse\(/g) ?? [];
  assert.ok(jsonCalls.length >= 6);
  assert.doesNotMatch(handler, /jsonResponse\([^)]*(tokenSet|secretValue|credential\.value|consumed)\b/);
  const providers = readFileSync(`${FUNCTION_DIR}/providers.mjs`, 'utf8');
  assert.doesNotMatch(providers, /client_secret:\s*["'`]/, 'no literal client secrets');
  const index = readFileSync(`${FUNCTION_DIR}/index.ts`, 'utf8');
  assert.match(index, /env: \(name: string\) => Deno\.env\.get\(name\)/);
  assert.doesNotMatch(index + handler + providers, /console\.(log|info|debug)\(/, 'no logging of request data');
});

test('source contract: the browser bundle holds no integration secret names or token fields', () => {
  const secretNames = /ATLAS_(GOOGLE_OAUTH_CLIENT_SECRET|META_APP_SECRET|TIKTOK_CLIENT_SECRET|INTEGRATION_KEK_V\d)|SUPABASE_SERVICE_ROLE_KEY/;
  for (const file of filesUnder('apps/web').filter((path) => /\.(js|html|json|mjs)$/.test(path))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), secretNames, file);
  }
});

test('source contract: migration keeps credentials away from browser roles', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  for (const table of ['integration_credentials', 'integration_oauth_states', 'integration_events']) {
    assert.match(sql, new RegExp(`create table if not exists atlas_private\\.${table}`));
    assert.match(sql, new RegExp(`alter table atlas_private\\.${table} enable row level security`));
    assert.match(sql, new RegExp(`revoke all on atlas_private\\.${table} from public, anon, authenticated`));
    assert.match(sql, new RegExp(`on atlas_private\\.${table}\\s+for all to service_role`));
  }
  assert.match(sql, /execute format\('revoke all on function %s from public, anon, authenticated'/);
  assert.match(sql, /An integration cannot be connected without a stored credential/);
  assert.doesNotMatch(sql, /vault\./, 'replay DB has no Vault');
  const config = readFileSync('supabase/config.toml', 'utf8');
  assert.match(config, /\[functions\.atlas-integrations\]\nverify_jwt = false/);
  assert.ok(!readdirSync('supabase/functions').includes('_shared') || !filesUnder('supabase/functions/_shared').some((f) => f.includes('integration')));
});

test('response guard withholds any payload with credential-shaped keys', async () => {
  for (const leak of [{ access_token: 'x' }, { provider: { nested: [{ refresh_token: 'x' }] } }, { api_key: 'x' }, { ciphertext: 'x' }, { code: 'x' }]) {
    const response = jsonResponse(leak);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /"x"/);
  }
  assert.equal(jsonResponse({ provider_key: 'tiktok', connection_state: 'ready', credential_expires_at: null }).status, 200);
});

test('base64url helper is URL-safe', () => {
  assert.equal(base64UrlEncode(new Uint8Array([251, 255, 191])), '-_-_');
});

// ------------------------------------------------------------------ S88 hardening (F7, F9, F10)

async function startedFlow(env = CONFIGURED_ENV) {
  const bundle = harness({ env });
  const { authorize_url: authorizeUrl } = await (await bundle.call('POST', 'start', { provider_key: 'google-drive', return_path: '#knowledge' })).json();
  return { ...bundle, authorizeUrl };
}

const callbackFor = (state) => `https://abc123.supabase.co/atlas-integrations/callback/google-drive?code=4%2Fauth-code&state=${state}`;
const tokenCalls = (providerCalls) => providerCalls.filter((c) => c.url === 'https://oauth2.googleapis.com/token').length;

test('F10 the callback needs the binding cookie of the browser that opened the hop; without it nothing is consumed', async () => {
  const { handle, providerCalls, openHop, authorizeUrl } = await startedFlow();
  const hop = await openHop(authorizeUrl);
  const state = new URL(hop.location).searchParams.get('state');
  const noCookie = await handle(new Request(callbackFor(state)));
  assert.match(noCookie.headers.get('location'), /result=error&reason=browser_mismatch/);
  const wrongCookie = await handle(new Request(callbackFor(state), { headers: { cookie: `__Host-atlas-oauth-google-drive=${createOAuthState()}` } }));
  assert.match(wrongCookie.headers.get('location'), /reason=invalid_state/);
  assert.equal(tokenCalls(providerCalls), 0);
  const good = await handle(new Request(callbackFor(state), { headers: { cookie: `other=1; ${hop.cookie}` } }));
  assert.match(good.headers.get('location'), /result=connected/, 'the state was not burned by the refused attempts');
});

test('F10 the authorize hop binds once: a copied authorize_url opened in another browser cannot complete', async () => {
  const { handle, providerCalls, openHop, authorizeUrl } = await startedFlow();
  const owner = await openHop(authorizeUrl);
  const attacker = await openHop(authorizeUrl);
  assert.equal(attacker.response.status, 302);
  assert.match(attacker.location, /^https:\/\/os\.example\.is\/\?integration=google-drive&result=error&reason=invalid_state/);
  assert.equal(attacker.response.headers.get('set-cookie'), null, 'no binding cookie for the second browser');
  const state = new URL(owner.location).searchParams.get('state');
  const hijack = await handle(new Request(callbackFor(state)));
  assert.match(hijack.headers.get('location'), /reason=browser_mismatch/);
  assert.equal(tokenCalls(providerCalls), 0);
});

test('F10 a manager deactivated or demoted after start cannot complete the connection', async () => {
  for (const change of [{ role: 'bartender', active: true }, { role: 'manager', active: false }]) {
    const { handle, db, providerCalls, openHop, authorizeUrl } = await startedFlow();
    const hop = await openHop(authorizeUrl);
    db.profiles.set(OWNER_ID, change);
    const state = new URL(hop.location).searchParams.get('state');
    const callback = await handle(new Request(callbackFor(state), { headers: { cookie: hop.cookie } }));
    assert.equal(callback.headers.get('location'), 'https://os.example.is/?integration=google-drive&result=error&reason=not_authorized#knowledge');
    assert.equal(tokenCalls(providerCalls), 0, 'no token exchange for a user who lost access');
    assert.equal(db.credentials.has('google-drive'), false);
  }
});

test('F10 the hop refuses malformed input and PKCE providers need the challenge', async () => {
  const { openHop, authorizeUrl, db } = await startedFlow();
  const withoutChallenge = new URL(authorizeUrl);
  withoutChallenge.searchParams.delete('cc');
  assert.match((await openHop(withoutChallenge.toString())).location, /reason=invalid_state/);
  const badState = new URL(authorizeUrl);
  badState.searchParams.set('state', 'short');
  assert.match((await openHop(badState.toString())).location, /reason=invalid_state/);
  assert.ok(![...db.states.values()].some((row) => row.binding), 'nothing was bound');
  assert.match((await openHop('https://abc123.supabase.co/functions/v1/atlas-integrations/authorize/nope?state=x')).location, /reason=unknown_provider/);
});

test('F7 every integration RPC receives the verified actor id for the SQL profile re-check', async () => {
  const { call, db } = await startedFlow();
  await call('GET', 'status');
  await call('POST', 'disconnect', { provider_key: 'google-drive' });
  for (const name of ['atlas_integration_status', 'atlas_integration_begin', 'atlas_integration_disconnect']) {
    const entry = db.calls.find((c) => c.name === name);
    assert.equal(entry.payload.p_actor_id, OWNER_ID, name);
  }
  const migration = readFileSync('supabase/migrations/20260926106000_s88_ai_hardening.sql', 'utf8');
  assert.match(migration, /create or replace function atlas_private\.integration_assert_actor\(p_actor_id uuid, p_actor_role text\)/);
  for (const fn of ['integration_status', 'integration_begin', 'integration_store_credential', 'integration_read_credential', 'integration_record_result', 'integration_disconnect']) {
    const body = migration.slice(migration.indexOf(`function atlas_private.${fn}(`));
    assert.match(body.slice(0, body.indexOf('$function$;')), /perform atlas_private\.integration_assert_actor\(p_actor_id, p_actor_role\)/, fn);
  }
});

test('F9 a failed provider check returns fixed text; the provider body stays in the sanitised audit row', async () => {
  const { handle, openHop, authorizeUrl, db } = await startedFlow();
  const hop = await openHop(authorizeUrl);
  const state = new URL(hop.location).searchParams.get('state');
  await handle(new Request(callbackFor(state), { headers: { cookie: hop.cookie } }));
  const bad = harness({ env: CONFIGURED_ENV, verifyOk: false });
  bad.db.credentials.set('google-drive', db.credentials.get('google-drive'));
  const tested = await bad.call('POST', 'test', { provider_key: 'google-drive' });
  const body = await tested.json();
  assert.equal(body.verified, false);
  assert.equal(body.error_code, 'provider_check_failed');
  assert.doesNotMatch(body.message, /invalid authentication|HTTP 401/i);
  assert.ok(bad.db.calls.some((c) => c.name === 'atlas_integration_record_result' && /HTTP 401/.test(c.payload.p_error ?? '')), 'the sanitised detail is audited');
});

test('F9 RPC failures reach the browser as fixed messages with error codes', async () => {
  const raw = 'relation "atlas_private.integration_credentials" does not exist';
  assert.deepEqual([rpcFailure(403, '42501', 'x').status, rpcFailure(403, '42501', 'x').extra.error_code], [403, 'forbidden']);
  assert.equal(rpcFailure(400, '23514', raw).extra.error_code, 'invalid_request');
  const unavailable = rpcFailure(500, '42P01', raw);
  assert.equal(unavailable.extra.error_code, 'unavailable');
  assert.doesNotMatch(unavailable.message, /relation|atlas_private/);
  const handle = createIntegrationsHandler({
    env: (name) => CONFIGURED_ENV[name],
    fetchImpl: async () => new Response('{}'),
    rpc: async () => { throw rpcFailure(500, '42P01', raw); },
    authenticate: async () => ({ user: { id: OWNER_ID }, profile: { role: 'manager', active: true } }),
  });
  const response = await handle(new Request('https://abc123.supabase.co/atlas-integrations?action=status', { headers: { authorization: 'Bearer jwt' } }));
  const text = await response.text();
  assert.equal(response.status, 503);
  assert.doesNotMatch(text, /relation|atlas_private/);
  assert.equal(JSON.parse(text).error_code, 'unavailable');
  const index = readFileSync(`${FUNCTION_DIR}/index.ts`, 'utf8');
  assert.match(index, /throw rpcFailure\(response\.status, code, message\);/);
  assert.doesNotMatch(index, /String\(\(parsed as \{ message: unknown \}\)\.message\)\.slice/);
});

test('F9 other gateways pass only Atlas-authored database messages (safeDbMessage)', () => {
  for (const file of ['atlas-settings', 'atlas-operations-checkpoint-a', 'atlas-item-master']) {
    const source = readFileSync(`supabase/functions/${file}/index.ts`, 'utf8');
    assert.match(source, /function safeDbMessage\(/, file);
    assert.doesNotMatch(source, /\? String\(parsed\.message\)|String\(\(parsed as \{ message: unknown \}\)\.message\)/, file);
  }
  const source = readFileSync('supabase/functions/atlas-item-master/index.ts', 'utf8');
  const start = source.indexOf('const AUTHORED_SQLSTATES');
  const end = source.indexOf('\n}\n', source.indexOf('function safeDbMessage(')) + 3;
  const safeDbMessage = new Function(`${source.slice(start, end)}; return safeDbMessage;`)();
  assert.equal(safeDbMessage({ code: 'P0001', message: 'This item is used by an active recipe.' }, 'fallback'), 'This item is used by an active recipe.');
  assert.equal(safeDbMessage({ code: '23505', message: 'duplicate key value violates unique constraint "x"' }, 'fallback'), 'fallback');
  assert.equal(safeDbMessage({ code: '42501', message: 'permission denied for function atlas_x' }, 'fallback'), 'fallback');
  assert.equal(safeDbMessage({ code: 'P0001', message: 'column "cost" of relation "inventory_items" does not exist' }, 'fallback'), 'fallback');
  assert.equal(safeDbMessage('raw text', 'fallback'), 'fallback');
});
