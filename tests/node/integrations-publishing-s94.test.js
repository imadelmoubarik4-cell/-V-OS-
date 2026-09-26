// S94B Social Publishing Connections: scope split, publishing readiness,
// resource listing/selection (no [0] defaults), Page-token encryption, the
// administrator-only review state, Meta disconnect coupling and the shared
// publishing credential module (decrypt, refresh under the lease, refusals).
// Provider HTTP is scripted; nothing reaches a real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createOAuthState,
  credentialAad,
  decryptJson,
  encryptJson,
  findSecretKeys,
  importAesKey,
  resourceCredentialAad,
} from '../../supabase/functions/atlas-integrations/oauth-core.mjs';
import { PROVIDERS, buildAuthorizeUrl, requestedScopes, supportsPublishing } from '../../supabase/functions/atlas-integrations/providers.mjs';
import { createIntegrationsHandler } from '../../supabase/functions/atlas-integrations/handler.mjs';
import { credentialFailure } from '../../supabase/functions/atlas-marketing-publisher/handler.mjs';
import { ProviderError } from '../../supabase/functions/_shared/integrations/provider-http.mjs';
import {
  CredentialError,
  refreshFailureKind,
  __testing,
  openPublishingCredential,
  readTikTokCreatorInfo,
  refreshWithLock,
} from '../../supabase/functions/_shared/integrations/credentials.mjs';
import * as sharedCrypto from '../../supabase/functions/_shared/integrations/crypto.mjs';
import * as oauthCore from '../../supabase/functions/atlas-integrations/oauth-core.mjs';

const MIGRATION = 'supabase/migrations/20261004091000_s94b_publishing_connections.sql';
const KEK = Buffer.alloc(32, 7).toString('base64');
const MANAGER_ID = '00000000-0000-4000-8000-000000094b01';
const ADMIN_ID = '00000000-0000-4000-8000-000000094b02';
const NOW = Date.parse('2026-10-04T12:00:00Z');
const GRAPH = 'https://graph.facebook.com/v25.0';

const USER_TOKEN = 'EAAG-USER-TOKEN-THAT-MUST-NEVER-LEAK-0001';
const PAGE_TOKEN_111 = 'EAAG-PAGE-TOKEN-111-THAT-MUST-NEVER-LEAK';
const PAGE_TOKEN_222 = 'EAAG-PAGE-TOKEN-222-THAT-MUST-NEVER-LEAK';
const TIKTOK_ACCESS = 'act.TIKTOK-ACCESS-THAT-MUST-NEVER-LEAK';
const TIKTOK_REFRESH = 'rft.TIKTOK-REFRESH-THAT-MUST-NEVER-LEAK';
const TIKTOK_ACCESS_2 = 'act.TIKTOK-ACCESS-2-THAT-MUST-NEVER-LEAK';
const TIKTOK_REFRESH_2 = 'rft.TIKTOK-REFRESH-2-THAT-MUST-NEVER-LEAK';
const GOOGLE_ACCESS = 'ya29.GOOGLE-ACCESS-THAT-MUST-NEVER-LEAK';
const SECRETS = [USER_TOKEN, PAGE_TOKEN_111, PAGE_TOKEN_222, TIKTOK_ACCESS, TIKTOK_REFRESH, TIKTOK_ACCESS_2, TIKTOK_REFRESH_2, GOOGLE_ACCESS,
  'meta-app-secret-value', 'tiktok-client-secret-value', 'google-client-secret-value', KEK];

const ENV = {
  ATLAS_INTEGRATION_KEK_V1: KEK,
  ATLAS_INTEGRATIONS_APP_ORIGINS: 'https://os.example.is',
  SUPABASE_URL: 'https://abc123.supabase.co',
  ATLAS_GOOGLE_OAUTH_CLIENT_ID: 'google-client-id',
  ATLAS_GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret-value',
  ATLAS_META_APP_ID: 'meta-app-id',
  ATLAS_META_APP_SECRET: 'meta-app-secret-value',
  ATLAS_TIKTOK_CLIENT_KEY: 'tiktok-key',
  ATLAS_TIKTOK_CLIENT_SECRET: 'tiktok-client-secret-value',
};

function assertNoLeak(text, label = 'payload') {
  for (const secret of SECRETS) assert.ok(!String(text).includes(secret), `${label} leaked ${secret.slice(0, 14)}`);
}

async function seal(value, aad) {
  return encryptJson(await importAesKey(KEK), value, aad);
}

// ------------------------------------------------------------------ fake database (mirrors the S94B SQL rules)

const PUBLISH_SCOPES = {
  facebook: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management'],
  instagram: ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'business_management'],
  tiktok: ['video.upload', 'video.publish'],
  'google-business-profile': ['https://www.googleapis.com/auth/business.manage'],
};
const PRIMARY = { facebook: 'facebook_page', instagram: 'instagram_account', tiktok: 'tiktok_account', 'google-business-profile': 'gbp_location' };

function fakeDatabase() {
  const keys = ['google-business-profile', 'google-drive', 'facebook', 'instagram', 'tiktok', 'tripadvisor'];
  const rows = new Map(keys.map((key) => [key, {
    provider_key: key, status: 'not_connected', authorization_state: 'not_connected', scopes_granted: [],
    publishing_permission_state: 'not_requested', publishing_review_state: 'unknown',
    external_account_label: null, last_verified_at: null, last_connection_error: null,
  }]));
  const credentials = new Map();
  const resources = new Map(); // provider -> [{...}]
  const resourceCredentials = new Map(); // `${provider}|${id}` -> sealed
  const states = new Map();
  const deliveries = new Map();
  const events = [];
  const calls = [];
  const profiles = new Map([[MANAGER_ID, 'manager'], [ADMIN_ID, 'admin']]);
  const actor = (payload) => {
    if (!['admin', 'manager'].includes(payload.p_actor_role) || profiles.get(payload.p_actor_id) !== payload.p_actor_role) {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    }
  };
  const derive = (key) => {
    const row = rows.get(key);
    if (!PUBLISH_SCOPES[key]) return;
    const list = resources.get(key) ?? [];
    let value;
    if (!credentials.has(key) || row.status === 'not_connected' || !row.last_verified_at) value = 'not_requested';
    else if (key === 'google-business-profile') {
      if (!PUBLISH_SCOPES[key].every((s) => row.scopes_granted.includes(s))) value = 'missing';
      else value = list.some((r) => r.resource_kind === 'gbp_location' && r.selected) && !['required', 'pending', 'rejected'].includes(row.publishing_review_state) ? 'granted' : 'pending';
    } else value = PUBLISH_SCOPES[key].every((s) => row.scopes_granted.includes(s)) ? 'granted' : 'missing';
    row.publishing_permission_state = value;
  };
  const resourcesJson = (key) => (resources.get(key) ?? []).map((r) => ({ ...r, has_resource_credential: resourceCredentials.has(`${key}|${r.resource_id}`) }));
  const lock = { token: null, until: 0 };
  const rpc = async (name, payload) => {
    calls.push({ name, payload: structuredClone(payload) });
    switch (name) {
      case 'atlas_integration_status':
        actor(payload);
        return [...rows.values()].map((row) => ({
          ...row,
          has_credential: credentials.has(row.provider_key),
          credential_access_expires_at: credentials.get(row.provider_key)?.access_expires_at ?? null,
          resources: resourcesJson(row.provider_key),
          recent_events: events.filter((e) => e.provider_key === row.provider_key).slice(-5).reverse().map(({ provider_key, payload: _p, ...rest }) => rest),
        }));
      case 'atlas_integration_begin':
        actor(payload);
        states.set(payload.p_state_hash, { provider: payload.p_provider_key, purpose: 'connect', binding: null, actor: payload.p_actor_id });
        return { expires_at: '2026-10-04T12:10:00Z' };
      case 'atlas_integration_set_state_purpose': {
        actor(payload);
        const row = states.get(payload.p_state_hash);
        if (!row || row.binding || row.actor !== payload.p_actor_id) throw Object.assign(new Error('not found'), { status: 400 });
        row.purpose = payload.p_purpose;
        if (payload.p_purpose === 'publishing') events.push({ provider_key: payload.p_provider_key, event_type: 'publish_scope_requested', payload: { scope_count: PUBLISH_SCOPES[payload.p_provider_key].length } });
        return { purpose: payload.p_purpose };
      }
      case 'atlas_integration_bind_browser': {
        const row = states.get(payload.p_state_hash);
        if (!row || row.binding) return null;
        row.binding = payload.p_binding_hash;
        return { bound: true, expires_at: '2026-10-04T12:10:00Z', purpose: row.purpose };
      }
      case 'atlas_integration_read_credential': {
        actor(payload);
        const row = credentials.get(payload.p_provider_key);
        return row ? { credential_kind: row.kind, ciphertext: row.ciphertext, nonce: row.nonce, key_version: row.key_version, access_expires_at: row.access_expires_at } : null;
      }
      case 'atlas_integration_record_result': {
        actor(payload);
        const row = rows.get(payload.p_provider_key);
        if (payload.p_event_type === 'verified') Object.assign(row, { status: 'connected', authorization_state: 'authorized', last_verified_at: '2026-10-04T12:00:00Z', scopes_granted: payload.p_scopes ?? row.scopes_granted, external_account_label: payload.p_account_label });
        else if (payload.p_event_type !== 'refreshed') Object.assign(row, { status: payload.p_needs_reauthorization ? 'expired' : 'degraded' });
        derive(payload.p_provider_key);
        events.push({ provider_key: payload.p_provider_key, event_type: payload.p_event_type, payload: { error: payload.p_error ?? undefined } });
        return { recorded: payload.p_event_type };
      }
      case 'atlas_integration_resources_store': {
        actor(payload);
        if (!credentials.has(payload.p_provider_key)) throw Object.assign(new Error('not connected'), { status: 400 });
        const previous = new Map((resources.get(payload.p_provider_key) ?? []).map((r) => [r.resource_id, r]));
        const next = payload.p_resources.map((r) => ({
          resource_kind: r.resource_kind, resource_id: r.resource_id, parent_resource_id: r.parent_resource_id ?? null, label: r.label,
          metadata: r.metadata ?? {}, selected: previous.get(r.resource_id)?.selected === true && r.metadata?.selectable !== false,
        }));
        if (findSecretKeys(next).length) throw Object.assign(new Error('secret metadata'), { status: 400 });
        if (payload.p_provider_key === 'tiktok' && next.length === 1) next[0].selected = true;
        resources.set(payload.p_provider_key, next);
        for (const key of [...resourceCredentials.keys()]) {
          const [provider, id] = key.split('|');
          if (provider === payload.p_provider_key && !next.some((r) => r.resource_id === id && r.selected)) resourceCredentials.delete(key);
        }
        derive(payload.p_provider_key);
        events.push({ provider_key: payload.p_provider_key, event_type: 'resource_listed', payload: { resource_count: next.length } });
        return { resources: resourcesJson(payload.p_provider_key), publishing_permission_state: rows.get(payload.p_provider_key).publishing_permission_state };
      }
      case 'atlas_integration_resource_select': {
        actor(payload);
        const list = resources.get(payload.p_provider_key) ?? [];
        const target = list.find((r) => r.resource_kind === payload.p_resource_kind && r.resource_id === payload.p_resource_id);
        if (!target) throw Object.assign(new Error('not listed'), { status: 400 });
        const needs = ['facebook_page', 'instagram_account'].includes(payload.p_resource_kind);
        if (needs !== Boolean(payload.p_ciphertext)) throw Object.assign(new Error('credential mismatch'), { status: 400 });
        for (const r of list) if (r.resource_kind === payload.p_resource_kind || (payload.p_resource_kind === 'gbp_location' && r.resource_kind === 'gbp_account')) r.selected = false;
        target.selected = true;
        if (target.parent_resource_id && payload.p_resource_kind === 'gbp_location') {
          const parent = list.find((r) => r.resource_kind === 'gbp_account' && r.resource_id === target.parent_resource_id);
          if (parent) parent.selected = true;
        }
        for (const key of [...resourceCredentials.keys()]) if (key.startsWith(`${payload.p_provider_key}|`)) resourceCredentials.delete(key);
        if (needs) resourceCredentials.set(`${payload.p_provider_key}|${payload.p_resource_id}`, { ciphertext: payload.p_ciphertext, nonce: payload.p_nonce, key_version: payload.p_key_version });
        derive(payload.p_provider_key);
        events.push({ provider_key: payload.p_provider_key, event_type: 'resource_selected', payload: { resource_kind: payload.p_resource_kind, resource_id: payload.p_resource_id } });
        return { selected: { kind: target.resource_kind, id: target.resource_id, label: target.label }, resources: resourcesJson(payload.p_provider_key) };
      }
      case 'atlas_integration_set_review_state': {
        actor(payload);
        if (payload.p_actor_role !== 'admin') throw Object.assign(new Error('admin only'), { status: 403 });
        const row = rows.get(payload.p_provider_key);
        events.push({ provider_key: payload.p_provider_key, event_type: 'review_state_set', payload: { previous: row.publishing_review_state, review: payload.p_review_state } });
        row.publishing_review_state = payload.p_review_state;
        derive(payload.p_provider_key);
        return { publishing_review_state: payload.p_review_state };
      }
      case 'atlas_integration_disconnect':
        actor(payload);
        credentials.delete(payload.p_provider_key);
        resources.delete(payload.p_provider_key);
        Object.assign(rows.get(payload.p_provider_key), { status: 'not_connected', authorization_state: 'not_connected', last_verified_at: null, publishing_permission_state: 'not_requested', scopes_granted: [] });
        return { disconnected: true };
      case 'atlas_integration_read_credential_for_delivery': {
        const d = deliveries.get(payload.p_delivery_id);
        if (!d) return { granted: false, reason: 'not_found' };
        if (d.claim_token !== payload.p_claim_token || d.claimed_until <= NOW) return { granted: false, reason: 'not_claimed' };
        const row = rows.get(d.provider_key);
        const cred = credentials.get(d.provider_key);
        if (!cred || row.status !== 'connected') return { granted: false, reason: 'not_connected' };
        if (row.publishing_permission_state !== 'granted') return { granted: false, reason: 'publishing_permission_missing' };
        const selected = (resources.get(d.provider_key) ?? []).find((r) => r.selected && r.resource_kind === PRIMARY[d.provider_key]);
        if (!selected) return { granted: false, reason: 'no_resource_selected' };
        if (selected.resource_id !== d.external_account_id) return { granted: false, reason: 'resource_changed' };
        const rc = resourceCredentials.get(`${d.provider_key}|${selected.resource_id}`) ?? null;
        events.push({ provider_key: d.provider_key, event_type: 'credential_used', payload: { delivery_id: payload.p_delivery_id, resource_kind: selected.resource_kind } });
        return {
          granted: true, provider_key: d.provider_key, delivery_id: payload.p_delivery_id,
          credential: { credential_kind: cred.kind, ciphertext: cred.ciphertext, nonce: cred.nonce, key_version: cred.key_version, access_expires_at: cred.access_expires_at, refresh_expires_at: null },
          resource: { kind: selected.resource_kind, id: selected.resource_id, label: selected.label, credential: rc },
        };
      }
      case 'atlas_integration_refresh_lock': {
        const cred = credentials.get(payload.p_provider_key);
        if (payload.p_actor_id) actor(payload);
        else {
          const d = deliveries.get(payload.p_delivery_id);
          if (!d || d.claim_token !== payload.p_claim_token || d.provider_key !== payload.p_provider_key) throw Object.assign(new Error('not claimed'), { status: 403 });
        }
        let acquired = false;
        if (!lock.token || lock.until <= NOW) { lock.token = createOAuthState(); lock.until = NOW + 60_000; acquired = true; }
        return { acquired, ...(acquired ? { lock_token: lock.token } : {}), credential: { credential_kind: cred.kind, ciphertext: cred.ciphertext, nonce: cred.nonce, key_version: cred.key_version, access_expires_at: cred.access_expires_at } };
      }
      case 'atlas_integration_refresh_store': {
        if (payload.p_lock_token !== lock.token) return { stored: false, reason: 'lock_lost' };
        credentials.set(payload.p_provider_key, { kind: credentials.get(payload.p_provider_key).kind, ciphertext: payload.p_ciphertext, nonce: payload.p_nonce, key_version: payload.p_key_version, access_expires_at: payload.p_access_expires_at });
        lock.token = null;
        events.push({ provider_key: payload.p_provider_key, event_type: 'refreshed', payload: { key_version: payload.p_key_version } });
        return { stored: true };
      }
      case 'atlas_integration_refresh_release': {
        if (payload.p_lock_token !== lock.token) return { released: false };
        lock.token = null;
        if (payload.p_error) {
          // Mirrors SQL: null = transient (connection untouched), true = expired, false = degraded.
          if (payload.p_needs_reauthorization !== null && payload.p_needs_reauthorization !== undefined) {
            rows.get(payload.p_provider_key).status = payload.p_needs_reauthorization ? 'expired' : 'degraded';
          }
          events.push({ provider_key: payload.p_provider_key, event_type: 'refresh_failed', payload: { error: payload.p_error, transient: payload.p_needs_reauthorization === null } });
        }
        return { released: true };
      }
      case 'atlas_integration_publish_targets':
        return [{ provider_key: 'tiktok', target_kinds: rows.get('tiktok').publishing_review_state === 'approved' ? ['tiktok_inbox_video', 'tiktok_video'] : ['tiktok_inbox_video'] }];
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  };
  return { rpc, rows, credentials, resources, resourceCredentials, states, deliveries, events, calls, profiles, lock };
}

// Stores an encrypted token set and a verified row, as a completed connect would.
async function connect(db, key, tokenSet, { scopes = [], kind = 'oauth_token_set' } = {}) {
  const sealed = await seal(tokenSet, credentialAad(key, kind));
  db.credentials.set(key, { kind, ciphertext: sealed.ciphertextHex, nonce: sealed.nonceHex, key_version: 1, access_expires_at: tokenSet.access_expires_at ?? null });
  Object.assign(db.rows.get(key), { status: 'connected', authorization_state: 'authorized', last_verified_at: '2026-10-04T11:00:00Z', scopes_granted: scopes });
  await db.rpc('noop', {}).catch(() => undefined);
  db.calls.pop();
}

function derivedAfterConnect(db, key) {
  // Mirrors what record_result does after connect in SQL.
  return db.rpc('atlas_integration_record_result', {
    p_provider_key: key, p_event_type: 'verified', p_account_id: null, p_account_label: 'x', p_scopes: db.rows.get(key).scopes_granted,
    p_access_expires_at: null, p_needs_reauthorization: null, p_error: null, p_actor_id: MANAGER_ID, p_actor_label: 'M', p_actor_role: 'manager',
  });
}

// ------------------------------------------------------------------ scripted providers

function metaProvider({ pages, pageTokens = {}, permissions = [], failPages = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    calls.push({ url: text, init });
    const parsed = new URL(text);
    if (parsed.hostname !== 'graph.facebook.com') return new Response('{}', { status: 404 });
    const path = parsed.pathname.replace('/v25.0/', '');
    if (path === 'me/permissions' && (init.method ?? 'GET') === 'GET') {
      return Response.json({ data: permissions.map((permission) => ({ permission, status: 'granted' })) });
    }
    if (path.startsWith('me/permissions') && init.method === 'DELETE') return Response.json({ success: true });
    if (path === 'me/accounts') {
      if (failPages) return Response.json({ error: { message: `Invalid OAuth access token ${USER_TOKEN}` } }, { status: 400 });
      const after = parsed.searchParams.get('after');
      const first = pages.slice(0, 2);
      const rest = pages.slice(2);
      if (!after) {
        // Meta echoes the token in paging.next; the module must strip it.
        return Response.json({ data: first.map(({ access_token: _t, ...page }) => ({ ...page, access_token: 'EAAG-ECHOED-SHOULD-NOT-BE-USED' })), paging: rest.length ? { next: `${GRAPH}/me/accounts?fields=x&access_token=${USER_TOKEN}&after=cursor2` } : {} });
      }
      return Response.json({ data: rest });
    }
    const pageMatch = path.match(/^(\d+)$/);
    if (pageMatch && parsed.searchParams.get('fields') === 'id,access_token') {
      const token = pageTokens[pageMatch[1]];
      return token ? Response.json({ id: pageMatch[1], access_token: token }) : Response.json({ error: { message: 'no role' } }, { status: 403 });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, calls };
}

function handlerFor(db, fetchImpl, { role = 'manager', id = null } = {}) {
  const handle = createIntegrationsHandler({
    env: (name) => ENV[name],
    fetchImpl,
    rpc: db.rpc,
    authenticate: async () => ({ user: { id: id ?? (role === 'admin' ? ADMIN_ID : MANAGER_ID) }, profile: { role, display_name: role === 'admin' ? 'Owner' : 'Þórdís', active: true } }),
    now: () => NOW,
    sleep: async () => undefined,
  });
  const call = async (action, body, method = 'POST') => {
    const response = await handle(new Request(`https://abc123.supabase.co/atlas-integrations?action=${action}`, {
      method,
      headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    }));
    const text = await response.text();
    assertNoLeak(text, action);
    assert.deepEqual(findSecretKeys(JSON.parse(text)), [], `${action} response has no credential-shaped keys`);
    return { status: response.status, body: JSON.parse(text) };
  };
  return { handle, call };
}

const PAGES = [
  { id: '111', name: 'VÁ Bar', category: 'Bar', tasks: ['MANAGE', 'CREATE_CONTENT', 'MODERATE'] },
  { id: '222', name: 'VÁ Events', category: 'Event', tasks: ['CREATE_CONTENT'] },
  { id: '333', name: 'Old Page', tasks: ['ANALYZE'] },
  { id: '444', name: 'Kitchen', tasks: ['CREATE_CONTENT'], instagram_business_account: { id: '17840000000000444', username: 'va.kitchen' } },
];

// ------------------------------------------------------------------ scope split

test('publish scopes follow contract §4; connect scopes are unchanged and verify needs only them', () => {
  assert.deepEqual(PROVIDERS.facebook.scopes, ['pages_show_list', 'pages_read_engagement']);
  assert.deepEqual(PROVIDERS.facebook.publish_scopes, ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management']);
  assert.deepEqual(PROVIDERS.instagram.scopes, ['instagram_basic', 'pages_show_list']);
  assert.deepEqual(PROVIDERS.instagram.publish_scopes, ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'business_management']);
  assert.deepEqual(PROVIDERS.tiktok.scopes, ['user.info.basic']);
  assert.deepEqual(PROVIDERS.tiktok.publish_scopes, ['video.upload', 'video.publish']);
  assert.deepEqual(PROVIDERS['google-business-profile'].publish_scopes, []);
  assert.equal(supportsPublishing(PROVIDERS['google-drive']), false);
  assert.equal(supportsPublishing(PROVIDERS.tripadvisor), false);
  for (const key of ['facebook', 'instagram', 'tiktok', 'google-business-profile']) {
    for (const scope of PROVIDERS[key].publish_scopes) assert.ok(!PROVIDERS[key].future_scopes.includes(scope), `${key}: ${scope} is not a future scope`);
  }
  assert.deepEqual(requestedScopes(PROVIDERS.tiktok, 'publishing'), ['user.info.basic', 'video.upload', 'video.publish']);
  assert.deepEqual(requestedScopes(PROVIDERS.tiktok, 'connect'), ['user.info.basic']);
  assert.deepEqual(requestedScopes(PROVIDERS.instagram, 'publishing'), ['instagram_basic', 'pages_show_list', 'instagram_content_publish', 'pages_read_engagement', 'business_management']);
  const env = (name) => ENV[name];
  const connect = new URL(buildAuthorizeUrl(PROVIDERS.facebook, env, { redirectUri: 'r', state: 's', codeChallenge: null }));
  assert.equal(connect.searchParams.get('scope'), 'pages_show_list,pages_read_engagement');
  assert.equal(connect.searchParams.get('auth_type'), null);
  const publish = new URL(buildAuthorizeUrl(PROVIDERS.facebook, env, { redirectUri: 'r', state: 's', codeChallenge: null, purpose: 'publishing' }));
  assert.equal(publish.searchParams.get('scope'), 'pages_show_list,pages_read_engagement,pages_manage_posts,business_management');
  assert.equal(publish.searchParams.get('auth_type'), 'rerequest');
  const tiktok = new URL(buildAuthorizeUrl(PROVIDERS.tiktok, env, { redirectUri: 'r', state: 's', codeChallenge: null, purpose: 'publishing' }));
  assert.equal(tiktok.searchParams.get('scope'), 'user.info.basic,video.upload,video.publish');
});

test('the shared crypto module is the one atlas-integrations uses (behaviour unchanged)', async () => {
  for (const name of ['encryptJson', 'decryptJson', 'importAesKey', 'credentialAad', 'sanitizeProviderError', 'bytesToHex', 'hexToBytes', 'parseKeyMaterial']) {
    assert.equal(oauthCore[name], sharedCrypto[name], `${name} is re-exported, not copied`);
  }
  const key = await importAesKey(KEK);
  const sealed = await encryptJson(key, { access_token: 'x' }, credentialAad('facebook', 'oauth_token_set'));
  assert.deepEqual(await sharedCrypto.decryptJson(key, sealed.ciphertextHex, sealed.nonceHex, 'atlas-integrations|facebook|oauth_token_set'), { access_token: 'x' });
  assert.equal(resourceCredentialAad('instagram', '1784'), 'atlas-integrations|instagram|resource|1784');
  const source = readFileSync('supabase/functions/atlas-integrations/oauth-core.mjs', 'utf8');
  assert.match(source, /from "\.\.\/_shared\/integrations\/crypto\.mjs"/);
  assert.doesNotMatch(source, /subtle\(\)\.encrypt/, 'no second AES implementation');
});

test('verify with only the connect scopes succeeds and names no default Page', async () => {
  const meta = metaProvider({ pages: PAGES, permissions: ['pages_show_list', 'pages_read_engagement'] });
  const result = await PROVIDERS.facebook.verify(PROVIDERS.facebook, (n) => ENV[n], meta.fetchImpl, { access_token: USER_TOKEN });
  assert.equal(result.account_id, null, 'several Pages: no [0] default');
  assert.equal(result.account_label, '4 Pages', 'every page of /me/accounts is read');
  assert.deepEqual(result.scopes, ['pages_show_list', 'pages_read_engagement']);
  const twoLinked = PAGES.map((page) => (page.id === '111' ? { ...page, instagram_business_account: { id: '17841400000000111', username: 'vabar.reykjavik' } } : page));
  const ig = metaProvider({ pages: twoLinked, permissions: ['instagram_basic', 'pages_show_list'] });
  const igResult = await PROVIDERS.instagram.verify(PROVIDERS.instagram, (n) => ENV[n], ig.fetchImpl, { access_token: USER_TOKEN });
  assert.equal(igResult.account_id, null, 'two linked accounts: verify picks neither');
  assert.equal(igResult.account_label, '2 Instagram accounts');
  const source = readFileSync('supabase/functions/atlas-integrations/providers.mjs', 'utf8');
  assert.doesNotMatch(source, /(accounts|pages|linked)\[0\]\.(name|id|instagram_business_account)/, 'no [0] defaults');
});

// ------------------------------------------------------------------ start / hop with purpose

test('Allow publishing: start with purpose publishing asks for connect ∪ publish scopes through the bound hop', async () => {
  const db = fakeDatabase();
  const { handle, call } = handlerFor(db, async () => new Response('{}', { status: 404 }));
  const started = await call('start', { provider_key: 'instagram', purpose: 'publishing', return_path: '#settings/integrations' });
  assert.equal(started.status, 200);
  assert.equal(started.body.purpose, 'publishing');
  assert.deepEqual(started.body.scopes_requested, requestedScopes(PROVIDERS.instagram, 'publishing'));
  const purposeCall = db.calls.find((c) => c.name === 'atlas_integration_set_state_purpose');
  assert.equal(purposeCall.payload.p_purpose, 'publishing');
  assert.equal(purposeCall.payload.p_actor_id, MANAGER_ID);
  assert.ok(db.events.some((e) => e.event_type === 'publish_scope_requested'));
  const hop = await handle(new Request(started.body.authorize_url));
  const location = new URL(hop.headers.get('location'));
  assert.equal(location.origin + location.pathname, 'https://www.facebook.com/v25.0/dialog/oauth');
  assert.equal(location.searchParams.get('scope'), 'instagram_basic,pages_show_list,instagram_content_publish,pages_read_engagement,business_management');
  assert.equal(location.searchParams.get('auth_type'), 'rerequest');

  const plain = await call('start', { provider_key: 'instagram', return_path: '#settings/integrations' });
  const plainHop = new URL((await handle(new Request(plain.body.authorize_url))).headers.get('location'));
  assert.equal(plainHop.searchParams.get('scope'), 'instagram_basic,pages_show_list', 'Connect keeps the minimal scopes');
  assert.equal(db.calls.filter((c) => c.name === 'atlas_integration_set_state_purpose').length, 1);

  assert.equal((await call('start', { provider_key: 'google-drive', purpose: 'publishing' })).status, 400);
  assert.equal((await call('start', { provider_key: 'facebook', purpose: 'post-everything' })).status, 400);
});

// ------------------------------------------------------------------ list / select

test('list-resources lists every Facebook Page (paging, tasks) and selects none; select stores the encrypted Page token', async () => {
  const db = fakeDatabase();
  await connect(db, 'facebook', { access_token: USER_TOKEN, access_expires_at: '2026-12-01T00:00:00Z' }, { scopes: PUBLISH_SCOPES.facebook });
  await derivedAfterConnect(db, 'facebook');
  const meta = metaProvider({ pages: PAGES, pageTokens: { 111: PAGE_TOKEN_111, 222: PAGE_TOKEN_222 } });
  const { call } = handlerFor(db, meta.fetchImpl);

  const listed = await call('list-resources', { provider_key: 'facebook' });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.resources.map((r) => r.resource_id), ['111', '222', '333', '444']);
  assert.ok(listed.body.resources.every((r) => r.selected === false), 'no [0] default');
  assert.deepEqual(listed.body.resources.map((r) => r.selectable), [true, true, false, true]);
  assert.equal(listed.body.resources[2].unavailable_reason, 'no_create_content');
  assert.equal(listed.body.provider.publishing.reason, 'no_resource_selected');
  assert.equal(listed.body.provider.publishing.ready, false);
  // Paging followed on graph.facebook.com only, with the echoed token removed from the query.
  const accountCalls = meta.calls.filter((c) => c.url.includes('/me/accounts'));
  assert.equal(accountCalls.length, 2);
  assert.ok(!accountCalls[1].url.includes('access_token'), 'the token never rides in a URL');
  assert.ok(accountCalls.every((c) => c.init.headers.authorization === `Bearer ${USER_TOKEN}`));
  assert.doesNotMatch(accountCalls[0].url, /fields=[^&]*access_token/, 'Page tokens are not requested while listing');
  const stored = db.calls.find((c) => c.name === 'atlas_integration_resources_store');
  assertNoLeak(JSON.stringify(stored.payload), 'stored resources');
  assert.ok(!JSON.stringify(stored.payload).includes('EAAG-ECHOED'), 'echoed tokens are not stored');

  assert.equal((await call('select-resource', { provider_key: 'facebook', resource_id: '999' })).body.error_code, 'resource_not_listed');
  assert.equal((await call('select-resource', { provider_key: 'facebook', resource_id: '333' })).body.error_code, 'resource_not_selectable');
  assert.equal((await call('select-resource', { provider_key: 'facebook', resource_id: '111', resource_kind: 'gbp_location' })).status, 400);

  const selected = await call('select-resource', { provider_key: 'facebook', resource_id: '222' });
  assert.equal(selected.status, 200);
  assert.deepEqual(selected.body.selected, { kind: 'facebook_page', id: '222', label: 'VÁ Events' });
  assert.equal(selected.body.provider.publishing.ready, true);
  assert.deepEqual(selected.body.provider.publishing.resource, { kind: 'facebook_page', id: '222', label: 'VÁ Events' });
  const tokenCall = meta.calls.find((c) => c.url === `${GRAPH}/222?fields=id,access_token`);
  assert.ok(tokenCall, 'Page token fetched from /{page-id}?fields=id,access_token');
  const selectCall = db.calls.find((c) => c.name === 'atlas_integration_resource_select');
  assertNoLeak(JSON.stringify(selectCall.payload), 'select rpc');
  const sealed = db.resourceCredentials.get('facebook|222');
  const key = await importAesKey(KEK);
  const opened = await decryptJson(key, sealed.ciphertext, sealed.nonce, resourceCredentialAad('facebook', '222'));
  assert.equal(opened.access_token, PAGE_TOKEN_222);
  await assert.rejects(() => decryptJson(key, sealed.ciphertext, sealed.nonce, resourceCredentialAad('facebook', '111')), 'AAD binds the Page id');
  await assert.rejects(() => decryptJson(key, sealed.ciphertext, sealed.nonce, resourceCredentialAad('instagram', '222')), 'AAD binds the provider');
  await assert.rejects(() => decryptJson(key, sealed.ciphertext, sealed.nonce, credentialAad('facebook', 'oauth_token_set')));

  const status = await call('status', null, 'GET');
  const facebook = status.body.providers.find((p) => p.provider_key === 'facebook');
  assert.equal(facebook.publishing.permission_state, 'granted');
  assert.equal(facebook.publishing.resource_count, 4);
  assert.equal(facebook.publishing.can_set_review_state, false, 'managers cannot set review');
});

test('Instagram accounts come from the Pages; Pages without one are counted, not offered; the Page token is the parent Page', async () => {
  const db = fakeDatabase();
  await connect(db, 'instagram', { access_token: USER_TOKEN }, { scopes: PUBLISH_SCOPES.instagram });
  await derivedAfterConnect(db, 'instagram');
  const pages = [
    { id: '111', name: 'VÁ Bar', tasks: ['CREATE_CONTENT'], instagram_business_account: { id: '17841400000000111', username: 'vabar.reykjavik' } },
    { id: '222', name: 'VÁ Events', tasks: ['CREATE_CONTENT'] },
    { id: '444', name: 'Kitchen', tasks: ['ANALYZE'], instagram_business_account: { id: '17841400000000444', username: 'va.kitchen' } },
  ];
  const meta = metaProvider({ pages, pageTokens: { 111: PAGE_TOKEN_111 } });
  const { call } = handlerFor(db, meta.fetchImpl);
  const listed = await call('list-resources', { provider_key: 'instagram' });
  assert.deepEqual(listed.body.resources.map((r) => [r.resource_id, r.parent_resource_id, r.label, r.selectable]), [
    ['17841400000000111', '111', '@vabar.reykjavik', true],
    ['17841400000000444', '444', '@va.kitchen', false],
  ]);
  assert.equal(listed.body.notes.pages_without_instagram, 1);
  assert.equal(listed.body.resources[0].details.page_name, 'VÁ Bar');
  const selected = await call('select-resource', { provider_key: 'instagram', resource_id: '17841400000000111' });
  assert.equal(selected.status, 200);
  assert.ok(meta.calls.some((c) => c.url === `${GRAPH}/111?fields=id,access_token`), 'the linked Page token');
  const sealed = db.resourceCredentials.get('instagram|17841400000000111');
  const opened = await decryptJson(await importAesKey(KEK), sealed.ciphertext, sealed.nonce, resourceCredentialAad('instagram', '17841400000000111'));
  assert.equal(opened.access_token, PAGE_TOKEN_111);
});

test('Business Profile: accounts (Account Management v1) and locations (Business Information v1, readMask); location id is the v4 parent', async () => {
  const db = fakeDatabase();
  await connect(db, 'google-business-profile', { access_token: GOOGLE_ACCESS, refresh_token: 'r', access_expires_at: '2026-10-04T13:00:00Z' }, { scopes: PUBLISH_SCOPES['google-business-profile'] });
  await derivedAfterConnect(db, 'google-business-profile');
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const parsed = new URL(String(url));
    if (parsed.hostname === 'mybusinessaccountmanagement.googleapis.com') {
      return parsed.searchParams.get('pageToken')
        ? Response.json({ accounts: [{ name: 'accounts/2', accountName: 'Managed by agency', role: 'SITE_MANAGER', type: 'PERSONAL' }] })
        : Response.json({ accounts: [{ name: 'accounts/1', accountName: 'VÁ Group', role: 'OWNER', type: 'LOCATION_GROUP' }], nextPageToken: 'p2' });
    }
    if (parsed.hostname === 'mybusinessbusinessinformation.googleapis.com') {
      assert.equal(parsed.searchParams.get('readMask'), 'name,title,storefrontAddress,metadata');
      if (parsed.pathname === '/v1/accounts/1/locations') {
        return Response.json({ locations: [
          { name: 'locations/10', title: 'VÁ Bar', storefrontAddress: { addressLines: ['Laugavegur 1'], postalCode: '101', locality: 'Reykjavík' }, metadata: { hasVoiceOfMerchant: true } },
          { name: 'locations/11', title: 'VÁ Pop-up', metadata: { hasVoiceOfMerchant: false } },
        ] });
      }
      return Response.json({ locations: [{ name: 'locations/20', title: 'Agency spot' }] });
    }
    return new Response('{}', { status: 404 });
  };
  const { call } = handlerFor(db, fetchImpl);
  const listed = await call('list-resources', { provider_key: 'google-business-profile' });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.resources.map((r) => [r.resource_id, r.parent_resource_id, r.selectable, r.unavailable_reason]), [
    ['accounts/1/locations/10', 'accounts/1', true, null],
    ['accounts/1/locations/11', 'accounts/1', false, 'not_verified'],
    ['accounts/2/locations/20', 'accounts/2', false, 'site_manager'],
  ]);
  assert.equal(listed.body.resources[0].details.address, 'Laugavegur 1, 101 Reykjavík');
  const stored = db.calls.find((c) => c.name === 'atlas_integration_resources_store').payload.p_resources;
  assert.equal(stored.filter((r) => r.resource_kind === 'gbp_account').length, 2, 'accounts are stored as parents');
  assert.ok(calls.every((c) => c.init.headers.authorization === `Bearer ${GOOGLE_ACCESS}`));
  assert.equal(listed.body.provider.publishing.reason, 'no_resource_selected');
  const selected = await call('select-resource', { provider_key: 'google-business-profile', resource_id: 'accounts/1/locations/10' });
  assert.equal(selected.status, 200);
  assert.equal(db.calls.find((c) => c.name === 'atlas_integration_resource_select').payload.p_ciphertext, null, 'no separate credential for a location');
  assert.equal(selected.body.provider.publishing.permission_state, 'granted');
  assert.equal(selected.body.provider.publishing.ready, true);
});

test('TikTok: the single account is the target; verify records it; direct post only after review approval', async () => {
  const db = fakeDatabase();
  await connect(db, 'tiktok', { access_token: TIKTOK_ACCESS, refresh_token: TIKTOK_REFRESH, access_expires_at: '2026-10-05T12:00:00Z' }, { scopes: ['user.info.basic', 'video.upload', 'video.publish'] });
  await derivedAfterConnect(db, 'tiktok');
  const fetchImpl = async (url) => String(url).startsWith('https://open.tiktokapis.com/v2/user/info/')
    ? Response.json({ data: { user: { open_id: 'open-1', display_name: 'VÁ Bar' } }, error: { code: 'ok' } })
    : new Response('{}', { status: 404 });
  const { call } = handlerFor(db, fetchImpl);
  const listed = await call('list-resources', { provider_key: 'tiktok' });
  assert.deepEqual(listed.body.resources.map((r) => [r.resource_id, r.label, r.selected]), [['open-1', 'VÁ Bar', true]]);
  assert.equal(listed.body.provider.publishing.ready, true);
  assert.equal(listed.body.provider.publishing.direct_post, false);
  const admin = handlerFor(db, fetchImpl, { role: 'admin' });
  await admin.call('set-review-state', { provider_key: 'tiktok', review_state: 'approved' });
  const status = await call('status', null, 'GET');
  assert.equal(status.body.providers.find((p) => p.provider_key === 'tiktok').publishing.direct_post, true);
  // The callback's verify also records the account (no listing needed).
  const handler = readFileSync('supabase/functions/atlas-integrations/handler.mjs', 'utf8');
  assert.match(handler, /provider\.key === "tiktok" && result\.account_id/);
});

// ------------------------------------------------------------------ readiness states

test('publishing readiness covers every Settings state in contract §4', async () => {
  const db = fakeDatabase();
  const meta = metaProvider({ pages: PAGES, pageTokens: { 111: PAGE_TOKEN_111 } });
  const { call } = handlerFor(db, meta.fetchImpl);
  const view = async (key) => (await call('status', null, 'GET')).body.providers.find((p) => p.provider_key === key);

  let facebook = await view('facebook');
  assert.equal(facebook.connection_state, 'ready');
  assert.equal(facebook.publishing.reason, 'not_connected');
  assert.equal(facebook.publishing.can_allow_publishing, false);

  await connect(db, 'facebook', { access_token: USER_TOKEN }, { scopes: ['pages_show_list', 'pages_read_engagement'] });
  await derivedAfterConnect(db, 'facebook');
  facebook = await view('facebook');
  assert.equal(facebook.publishing.permission_state, 'missing');
  assert.equal(facebook.publishing.reason, 'publishing_permission_missing');
  assert.equal(facebook.publishing.can_allow_publishing, true);

  db.rows.get('facebook').scopes_granted = PUBLISH_SCOPES.facebook;
  await derivedAfterConnect(db, 'facebook');
  facebook = await view('facebook');
  assert.equal(facebook.publishing.reason, 'no_resource_selected');
  assert.equal(facebook.publishing.can_allow_publishing, false);

  await call('list-resources', { provider_key: 'facebook' });
  await call('select-resource', { provider_key: 'facebook', resource_id: '111' });
  assert.equal((await view('facebook')).publishing.ready, true);

  const admin = handlerFor(db, meta.fetchImpl, { role: 'admin' });
  for (const [review, reason] of [['required', 'review_required'], ['rejected', 'review_required'], ['pending', 'review_pending'], ['approved', null], ['not_required', null], ['unknown', null]]) {
    const set = await admin.call('set-review-state', { provider_key: 'facebook', review_state: review });
    assert.equal(set.status, 200);
    assert.equal(set.body.provider.publishing.reason, reason, review);
    assert.equal(set.body.provider.publishing.can_set_review_state, true);
  }

  db.rows.get('facebook').status = 'degraded';
  facebook = await view('facebook');
  assert.equal(facebook.connection_state, 'verification_failed');
  assert.equal(facebook.publishing.reason, 'needs_reauthorization');
  db.rows.get('facebook').status = 'expired';
  facebook = await view('facebook');
  assert.equal(facebook.connection_state, 'needs_reauthorization');

  const unconfigured = createIntegrationsHandler({
    env: () => undefined, fetchImpl: meta.fetchImpl, rpc: db.rpc, now: () => NOW,
    authenticate: async () => ({ user: { id: MANAGER_ID }, profile: { role: 'manager', active: true } }),
  });
  const body = await (await unconfigured(new Request('https://abc123.supabase.co/atlas-integrations?action=status', { headers: { authorization: 'Bearer x' } }))).json();
  assert.equal(body.providers.find((p) => p.provider_key === 'tiktok').publishing.reason, 'not_configured');
  assert.equal(body.providers.find((p) => p.provider_key === 'google-drive').publishing, null, 'Drive does not publish');
});

test('the review state is administrator-only, checked before any database write', async () => {
  const db = fakeDatabase();
  const manager = handlerFor(db, async () => new Response('{}'));
  const refused = await manager.call('set-review-state', { provider_key: 'tiktok', review_state: 'approved' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error_code, 'forbidden');
  assert.equal(db.calls.filter((c) => c.name === 'atlas_integration_set_review_state').length, 0);
  const admin = handlerFor(db, async () => new Response('{}'), { role: 'admin' });
  assert.equal((await admin.call('set-review-state', { provider_key: 'tiktok', review_state: 'maybe' })).status, 400);
  assert.equal((await admin.call('set-review-state', { provider_key: 'google-drive', review_state: 'approved' })).status, 400);
  const ok = await admin.call('set-review-state', { provider_key: 'tiktok', review_state: 'pending' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.provider.publishing.review_state, 'pending');
  const sql = readFileSync(MIGRATION, 'utf8');
  const body = sql.slice(sql.indexOf('function atlas_private.integration_set_review_state('));
  assert.match(body.slice(0, body.indexOf('$function$;')), /perform atlas_private\.integration_assert_admin\(p_actor_id, p_actor_role\)/);
  for (const role of ['bartender', 'viewer']) {
    const staff = handlerFor(db, async () => new Response('{}'), { role });
    for (const action of ['list-resources', 'select-resource', 'set-review-state']) {
      assert.equal((await staff.call(action, { provider_key: 'facebook' })).status, 403, `${role} ${action}`);
    }
  }
});

// ------------------------------------------------------------------ Meta disconnect coupling

test('disconnecting one Meta provider while the other is connected revokes only its own permissions', async () => {
  const db = fakeDatabase();
  await connect(db, 'facebook', { access_token: USER_TOKEN }, { scopes: PUBLISH_SCOPES.facebook });
  await connect(db, 'instagram', { access_token: USER_TOKEN }, { scopes: PUBLISH_SCOPES.instagram });
  const meta = metaProvider({ pages: PAGES });
  const { call } = handlerFor(db, meta.fetchImpl);
  const response = await call('disconnect', { provider_key: 'facebook' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.revoked_permissions, ['pages_manage_posts']);
  const deletes = meta.calls.filter((c) => c.init.method === 'DELETE').map((c) => c.url);
  assert.deepEqual(deletes, [`${GRAPH}/me/permissions/pages_manage_posts`]);

  const last = await call('disconnect', { provider_key: 'instagram' });
  assert.equal(last.body.revoked_at_provider, true);
  assert.equal(last.body.revoked_permissions, undefined);
  assert.equal(meta.calls.filter((c) => c.init.method === 'DELETE').at(-1).url, `${GRAPH}/me/permissions`, 'the last Meta connection revokes the app');

  const db2 = fakeDatabase();
  await connect(db2, 'facebook', { access_token: USER_TOKEN }, { scopes: PUBLISH_SCOPES.facebook });
  await connect(db2, 'instagram', { access_token: USER_TOKEN }, { scopes: PUBLISH_SCOPES.instagram });
  const meta2 = metaProvider({ pages: PAGES });
  const ig = await handlerFor(db2, meta2.fetchImpl).call('disconnect', { provider_key: 'instagram' });
  assert.deepEqual(ig.body.revoked_permissions, ['instagram_basic', 'instagram_content_publish']);
});

// ------------------------------------------------------------------ Google disconnect coupling

// Google's revoke endpoint removes every scope granted to the client, so while
// the other Google provider is connected the revoke is skipped.
function googleRevokeRecorder() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  };
  return { fetchImpl, revokes: () => calls.filter((c) => c.url === 'https://oauth2.googleapis.com/revoke') };
}

for (const [key, other] of [['google-drive', 'google-business-profile'], ['google-business-profile', 'google-drive']]) {
  test(`disconnecting ${key} while ${other} is connected keeps the Google grant`, async () => {
    const db = fakeDatabase();
    await connect(db, key, { access_token: GOOGLE_ACCESS, refresh_token: 'r-this' });
    await connect(db, other, { access_token: GOOGLE_ACCESS, refresh_token: 'r-other' });
    const google = googleRevokeRecorder();
    const response = await handlerFor(db, google.fetchImpl).call('disconnect', { provider_key: key });
    assert.equal(response.status, 200);
    assert.equal(response.body.revoked_at_provider, false);
    assert.equal(response.body.revoked_permissions, undefined);
    assert.equal(google.revokes().length, 0, 'no Google revoke while the other provider is connected');
    assert.equal(db.credentials.has(key), false, 'the local credential is still removed');
    assert.equal(db.credentials.has(other), true);
    assert.ok(db.calls.some((c) => c.name === 'atlas_integration_disconnect' && c.payload.p_provider_key === key));
  });

  test(`disconnecting ${key} when ${other} is not connected revokes at Google`, async () => {
    const db = fakeDatabase();
    await connect(db, key, { access_token: GOOGLE_ACCESS, refresh_token: 'r-this' });
    const google = googleRevokeRecorder();
    const response = await handlerFor(db, google.fetchImpl).call('disconnect', { provider_key: key });
    assert.equal(response.status, 200);
    assert.equal(response.body.revoked_at_provider, true);
    assert.equal(google.revokes().length, 1);
    assert.equal(new URLSearchParams(google.revokes()[0].init.body).get('token'), 'r-this');
    assert.equal(db.credentials.has(key), false);
  });
}

// ------------------------------------------------------------------ credential module

function delivery(db, provider, externalAccountId, overrides = {}) {
  const id = overrides.id ?? `00000000-0000-4000-8000-00000000d${Math.floor(Math.random() * 1e3).toString().padStart(3, '0')}`;
  const claimToken = overrides.claimToken ?? '00000000-0000-4000-8000-0000000c1a1e';
  db.deliveries.set(id, { provider_key: provider, external_account_id: externalAccountId, claim_token: claimToken, claimed_until: NOW + 300_000, ...overrides });
  return { deliveryId: id, claimToken };
}

async function facebookReady() {
  const db = fakeDatabase();
  await connect(db, 'facebook', { access_token: USER_TOKEN }, { scopes: PUBLISH_SCOPES.facebook });
  await derivedAfterConnect(db, 'facebook');
  const meta = metaProvider({ pages: PAGES, pageTokens: { 111: PAGE_TOKEN_111 } });
  const { call } = handlerFor(db, meta.fetchImpl);
  await call('list-resources', { provider_key: 'facebook' });
  await call('select-resource', { provider_key: 'facebook', resource_id: '111' });
  return db;
}

test('openPublishingCredential returns the selected Page token for a claimed delivery, never in JSON', async () => {
  const db = await facebookReady();
  const claim = delivery(db, 'facebook', '111');
  const fetchCalls = [];
  const credential = await openPublishingCredential({ rpc: db.rpc, env: (n) => ENV[n], fetchImpl: async (u) => { fetchCalls.push(u); return new Response('{}'); }, now: () => NOW }, claim);
  assert.equal(credential.provider_key, 'facebook');
  assert.equal(credential.access_token, PAGE_TOKEN_111, 'Facebook publishing uses the Page token, not the user token');
  assert.deepEqual(credential.resource, { kind: 'facebook_page', id: '111', label: 'VÁ Bar' });
  assert.equal(fetchCalls.length, 0, 'a Page token needs no provider call');
  assertNoLeak(JSON.stringify(credential), 'credential JSON');
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(credential))).sort(), ['expires_at', 'provider_key', 'resource']);
  const { access_token: token } = { ...credential };
  assert.equal(token, PAGE_TOKEN_111, 'spread and destructuring still work for the worker');
  assert.ok(db.events.some((e) => e.event_type === 'credential_used' && e.payload.delivery_id === claim.deliveryId));
  for (const call of db.calls) assertNoLeak(JSON.stringify(call.payload), call.name);
});

test('openPublishingCredential refuses without a live claim, approval, permission or the selected Page — no provider call', async () => {
  const db = await facebookReady();
  const deps = { rpc: db.rpc, env: (n) => ENV[n], fetchImpl: async () => { throw new Error('no provider call expected'); }, now: () => NOW };
  const expectCode = async (claim, code) => {
    await assert.rejects(() => openPublishingCredential(deps, claim), (error) => error instanceof CredentialError && error.code === code);
  };
  await expectCode({}, 'not_claimed');
  const good = delivery(db, 'facebook', '111');
  await expectCode({ deliveryId: good.deliveryId, claimToken: '00000000-0000-4000-8000-00000000beef' }, 'not_claimed');
  await expectCode(delivery(db, 'facebook', '111', { claimed_until: NOW - 1 }), 'not_claimed');
  await expectCode(delivery(db, 'facebook', '222'), 'resource_changed');
  await expectCode({ deliveryId: '00000000-0000-4000-8000-000000000404', claimToken: good.claimToken }, 'not_found');
  db.rows.get('facebook').scopes_granted = ['pages_show_list'];
  await derivedAfterConnect(db, 'facebook');
  await expectCode(good, 'publishing_permission_missing');
  const error = await openPublishingCredential(deps, good).catch((e) => e);
  assertNoLeak(`${error.message} ${JSON.stringify(error)}`, 'error');
});

test('a wrong key or tampered ciphertext is credential_unreadable; a missing key is not_configured', async () => {
  const db = await facebookReady();
  const claim = delivery(db, 'facebook', '111');
  const other = Buffer.alloc(32, 9).toString('base64');
  await assert.rejects(
    () => openPublishingCredential({ rpc: db.rpc, env: (n) => (n === 'ATLAS_INTEGRATION_KEK_V1' ? other : ENV[n]), now: () => NOW }, claim),
    (error) => error.code === 'credential_unreadable' && error.reauthorize === true,
  );
  await assert.rejects(
    () => openPublishingCredential({ rpc: db.rpc, env: (n) => (n === 'ATLAS_INTEGRATION_KEK_V1' ? undefined : ENV[n]), now: () => NOW }, claim),
    (error) => error.code === 'not_configured',
  );
});

async function tiktokReady(expiresAt = '2026-10-04T12:02:00Z') {
  const db = fakeDatabase();
  await connect(db, 'tiktok', { access_token: TIKTOK_ACCESS, refresh_token: TIKTOK_REFRESH, access_expires_at: expiresAt, scopes: ['user.info.basic', 'video.upload', 'video.publish'] }, { scopes: ['user.info.basic', 'video.upload', 'video.publish'] });
  await derivedAfterConnect(db, 'tiktok');
  db.resources.set('tiktok', [{ resource_kind: 'tiktok_account', resource_id: 'open-1', parent_resource_id: null, label: 'VÁ Bar', metadata: { selectable: true }, selected: true }]);
  return db;
}

function tiktokTokenEndpoint({ fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://open.tiktokapis.com/v2/oauth/token/') {
      if (fail) return Response.json({ error: 'invalid_grant', error_description: `refresh token ${TIKTOK_REFRESH} is expired` }, { status: 400 });
      return Response.json({ access_token: TIKTOK_ACCESS_2, refresh_token: TIKTOK_REFRESH_2, expires_in: 86400, refresh_expires_in: 31536000, scope: 'user.info.basic,video.upload,video.publish' });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('an expiring TikTok token is refreshed under the lease, re-stored encrypted, and the rotated refresh token is kept', async () => {
  const db = await tiktokReady();
  const claim = delivery(db, 'tiktok', 'open-1');
  const tiktok = tiktokTokenEndpoint();
  const credential = await openPublishingCredential({ rpc: db.rpc, env: (n) => ENV[n], fetchImpl: tiktok.fetchImpl, now: () => NOW }, claim);
  assert.equal(credential.access_token, TIKTOK_ACCESS_2);
  assert.deepEqual(credential.resource, { kind: 'tiktok_account', id: 'open-1', label: 'VÁ Bar' });
  assert.equal(tiktok.calls.length, 1);
  const form = new URLSearchParams(tiktok.calls[0].init.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), TIKTOK_REFRESH);
  const lock = db.calls.find((c) => c.name === 'atlas_integration_refresh_lock');
  assert.equal(lock.payload.p_delivery_id, claim.deliveryId);
  assert.equal(lock.payload.p_claim_token, claim.claimToken);
  const stored = db.credentials.get('tiktok');
  const opened = await decryptJson(await importAesKey(KEK), stored.ciphertext, stored.nonce, credentialAad('tiktok', 'oauth_token_set'));
  assert.equal(opened.refresh_token, TIKTOK_REFRESH_2, 'the rotated refresh token is stored');
  assert.ok(db.events.some((e) => e.event_type === 'refreshed'));
  for (const call of db.calls) assertNoLeak(JSON.stringify(call.payload), call.name);
  assert.equal(db.lock.token, null, 'the lease is released');
});

test('two workers opening at once refresh once: the second waits for the lease and uses the stored result', async () => {
  const db = await tiktokReady();
  const a = delivery(db, 'tiktok', 'open-1', { id: '00000000-0000-4000-8000-0000000000a1', claimToken: '00000000-0000-4000-8000-0000000000c1' });
  const b = delivery(db, 'tiktok', 'open-1', { id: '00000000-0000-4000-8000-0000000000a2', claimToken: '00000000-0000-4000-8000-0000000000c2' });
  const tiktok = tiktokTokenEndpoint();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowFetch = async (url, init) => { await gate; return tiktok.fetchImpl(url, init); };
  const sleeps = [];
  const deps = { rpc: db.rpc, env: (n) => ENV[n], fetchImpl: slowFetch, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); release(); await new Promise((r) => setTimeout(r, 5)); } };
  const [first, second] = await Promise.all([openPublishingCredential(deps, a), openPublishingCredential(deps, b)]);
  assert.equal(first.access_token, TIKTOK_ACCESS_2);
  assert.equal(second.access_token, TIKTOK_ACCESS_2);
  assert.equal(tiktok.calls.length, 1, 'one refresh call');
  assert.ok(sleeps.length >= 1, 'the second caller waited');
});

test('a refused refresh releases the lease, records refresh_failed and asks for reconnecting; nothing leaks', async () => {
  const db = await tiktokReady();
  const claim = delivery(db, 'tiktok', 'open-1');
  const tiktok = tiktokTokenEndpoint({ fail: true });
  const error = await openPublishingCredential({ rpc: db.rpc, env: (n) => ENV[n], fetchImpl: tiktok.fetchImpl, now: () => NOW }, claim).catch((e) => e);
  assert.ok(error instanceof CredentialError);
  assert.equal(error.code, 'needs_reauthorization');
  assert.equal(error.reauthorize, true);
  const released = db.calls.find((c) => c.name === 'atlas_integration_refresh_release');
  assert.equal(released.payload.p_needs_reauthorization, true);
  assertNoLeak(released.payload.p_error, 'release error');
  assert.equal(db.rows.get('tiktok').status, 'expired');
  assert.equal(db.lock.token, null);
  assertNoLeak(`${error.message}`, 'error');
});

// P1-3: one transient refresh failure must not park the channel.
for (const [label, failure] of [
  ['HTTP 503', () => new Response('upstream unavailable', { status: 503 })],
  ['HTTP 500 with an error body', () => Response.json({ error: 'server_error', error_description: 'try later' }, { status: 500 })],
  ['HTTP 429', () => Response.json({ error: 'rate_limited' }, { status: 429 })],
  ['a network failure', () => { throw new TypeError('fetch failed'); }],
]) {
  test(`a transient refresh failure (${label}) releases the lease, keeps the connection and is retryable`, async () => {
    const db = await tiktokReady();
    const claim = delivery(db, 'tiktok', 'open-1');
    const before = db.rows.get('tiktok').status;
    const fetchImpl = async (url) => {
      if (String(url) === 'https://open.tiktokapis.com/v2/oauth/token/') return failure();
      return new Response('{}', { status: 404 });
    };
    const error = await openPublishingCredential({ rpc: db.rpc, env: (n) => ENV[n], fetchImpl, now: () => NOW }, claim).catch((e) => e);
    assert.ok(error instanceof CredentialError);
    assert.equal(error.code, 'refresh_failed');
    assert.equal(error.retryable, true);
    assert.equal(error.reauthorize, false);
    const released = db.calls.find((c) => c.name === 'atlas_integration_refresh_release');
    assert.equal(released.payload.p_needs_reauthorization, null, 'transient: the connection is not degraded or expired');
    assert.ok(released.payload.p_error, 'the failure is still recorded');
    assertNoLeak(released.payload.p_error, 'release error');
    assert.equal(db.rows.get('tiktok').status, before);
    assert.equal(db.lock.token, null, 'the lease is released');
    assert.ok(db.events.some((e) => e.event_type === 'refresh_failed' && e.payload.transient === true));
    // The worker maps it to a normal retry, never to "reconnect".
    assert.equal(credentialFailure(error).status, 'retrying');
  });
}

test('refresh failure kinds: invalid_grant/400/401 reauthorize, 5xx/429/network transient, others failed', () => {
  assert.equal(refreshFailureKind(new ProviderError('x', { status: 400, reauthorize: true })), 'reauthorize');
  assert.equal(refreshFailureKind(new ProviderError('x', { status: 401, reauthorize: true })), 'reauthorize');
  assert.equal(refreshFailureKind(new ProviderError('x', { status: 503 })), 'transient');
  assert.equal(refreshFailureKind(new ProviderError('x', { status: 429 })), 'transient');
  assert.equal(refreshFailureKind(new TypeError('fetch failed')), 'transient');
  assert.equal(refreshFailureKind(new ProviderError('x', { status: 403 })), 'failed');
});

test('a worker that never gets the lease gives up as retryable refresh_in_progress', async () => {
  const db = await tiktokReady();
  const claim = delivery(db, 'tiktok', 'open-1');
  db.lock.token = 'held-by-someone-else';
  db.lock.until = NOW + 60_000;
  const sleeps = [];
  const error = await refreshWithLock(
    { rpc: db.rpc, env: (n) => ENV[n], fetchImpl: async () => { throw new Error('no call'); }, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); } },
    { providerKey: 'tiktok', lockArgs: claim },
  ).catch((e) => e);
  assert.equal(error.code, 'refresh_in_progress');
  assert.equal(error.retryable, true);
  assert.equal(sleeps.length, __testing.LOCK_ATTEMPTS);
});

test('Settings Test refreshes under the same lease as the worker', async () => {
  const db = await tiktokReady();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url) === 'https://open.tiktokapis.com/v2/oauth/token/') return tiktokTokenEndpoint().fetchImpl(url, init);
    return Response.json({ data: { user: { open_id: 'open-1', display_name: 'VÁ Bar' } }, error: { code: 'ok' } });
  };
  const { call } = handlerFor(db, fetchImpl);
  const tested = await call('test', { provider_key: 'tiktok' });
  assert.equal(tested.body.verified, true, JSON.stringify(tested.body));
  const lock = db.calls.find((c) => c.name === 'atlas_integration_refresh_lock');
  assert.equal(lock.payload.p_actor_id, MANAGER_ID);
  assert.equal(lock.payload.p_delivery_id, null);
  assert.ok(db.calls.some((c) => c.name === 'atlas_integration_refresh_store'));
  assert.ok(!db.calls.some((c) => c.name === 'atlas_integration_store_credential'), 'no unlocked re-store');
});

test('readTikTokCreatorInfo returns the composer fields only (no avatar URL, no token)', async () => {
  const db = await tiktokReady('2026-10-05T12:00:00Z');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ data: { creator_nickname: 'VÁ Bar', creator_username: 'vabar', creator_avatar_url: 'https://p16.tiktokcdn.com/signed?x=1', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY', 'bad option'], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600 }, error: { code: 'ok' } });
  };
  const info = await readTikTokCreatorInfo({ rpc: db.rpc, env: (n) => ENV[n], fetchImpl, now: () => NOW }, { actorId: MANAGER_ID, actorRole: 'manager' });
  assert.deepEqual(info, {
    creator_nickname: 'VÁ Bar', creator_username: 'vabar', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
    comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600, direct_post_allowed: false,
  });
  assert.equal(calls[0].url, 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TIKTOK_ACCESS}`);
  await assert.rejects(() => readTikTokCreatorInfo({ rpc: db.rpc, env: (n) => ENV[n], fetchImpl, now: () => NOW }, { actorId: MANAGER_ID, actorRole: 'bartender' }));
});

// ------------------------------------------------------------------ source contracts

test('source contract: migration keeps resources and Page tokens service-role only and derives publishing state', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  for (const table of ['integration_resources', 'integration_resource_credentials']) {
    assert.match(sql, new RegExp(`create table if not exists atlas_private\\.${table}`));
    assert.match(sql, new RegExp(`alter table atlas_private\\.${table} enable row level security`));
    assert.match(sql, new RegExp(`revoke all on atlas_private\\.${table} from public, anon, authenticated`));
  }
  assert.match(sql, /create unique index if not exists integration_resources_one_selected\s+on atlas_private\.integration_resources\(provider_key, resource_kind\) where selected/);
  assert.match(sql, /publishing_review_state in \('not_required','unknown','required','pending','approved','rejected'\)/);
  for (const event of ['publish_scope_requested', 'resource_listed', 'resource_selected', 'credential_used', 'review_state_set']) assert.match(sql, new RegExp(`'${event}'`));
  const recordResult = sql.slice(sql.indexOf('function atlas_private.integration_record_result('));
  const body = recordResult.slice(0, recordResult.indexOf('$function$;'));
  assert.match(body, /perform atlas_private\.integration_assert_actor\(p_actor_id, p_actor_role\)/, 'S88 hardening kept');
  assert.match(body, /perform atlas_private\.integration_derive_publishing\(p_provider_key\)/);
  const delivery = sql.slice(sql.indexOf('function atlas_private.integration_read_credential_for_delivery('));
  const deliveryBody = delivery.slice(0, delivery.indexOf('$function$;'));
  assert.match(deliveryBody, /language plpgsql/, 'plpgsql: the S94C table is resolved at run time');
  assert.match(deliveryBody, /to_regclass\('atlas_private\.marketing_deliveries'\) is null/);
  assert.match(deliveryBody, /d\.claimed_until|v_until <= now\(\)/);
  assert.match(deliveryBody, /'credential_used'/);
  assert.match(sql, /execute format\('revoke all on function %s from public, anon, authenticated', v_signature\)/);
  assert.doesNotMatch(sql, /grant execute on function [^;]* to (anon|authenticated)/);
  assert.doesNotMatch(sql, /vault\./);
});

test('source contract: the credential module and new handler paths never log or return tokens', () => {
  const credentials = readFileSync('supabase/functions/_shared/integrations/credentials.mjs', 'utf8');
  assert.doesNotMatch(credentials, /console\./);
  assert.match(credentials, /export async function openPublishingCredential\(deps, \{ deliveryId, claimToken \} = \{\}\)/);
  const handler = readFileSync('supabase/functions/atlas-integrations/handler.mjs', 'utf8');
  assert.doesNotMatch(handler, /jsonResponse\([^)]*(pageToken|tokenSet|listing\.resources)\b/);
  assert.doesNotMatch(handler, /console\.(log|info|debug)\(/);
  const index = readFileSync('supabase/functions/atlas-integrations/index.ts', 'utf8');
  assert.doesNotMatch(index, /console\.(log|info|debug)\(/);
});
