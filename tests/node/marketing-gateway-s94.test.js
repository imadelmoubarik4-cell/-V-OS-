// S94: atlas-marketing-workspace gateway (handler pattern). Drives every
// action through createMarketingHandler with an injected fetch that plays the
// service-role RPCs, Storage signing and the publisher wake. Nothing reaches a
// network or a social provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createMarketingHandler,
  contentPatch,
  findSecretKeys,
  mediaItems,
  platformOptions,
  rpcFailure,
  scrub,
  RPC,
} from '../../supabase/functions/atlas-marketing-workspace/handler.mjs';

const BASE = 'https://branch.test';
const SERVICE_KEY = 'service-role-test-key';
const WORKER_SECRET = 'worker-secret-value-0123456789abcdef';
const ACCESS_TOKEN = 'EAAG-provider-access-token-should-never-leak';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONTENT_ID = '22222222-2222-4222-8222-222222222222';
const DELIVERY_ID = '33333333-3333-4333-8333-333333333333';
const ASSET_A = '44444444-4444-4444-8444-444444444444';
const ASSET_B = '55555555-5555-4555-8555-555555555555';
const NOW = Date.parse('2026-09-24T14:00:00Z');
const ENV = {
  SUPABASE_URL: BASE,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  ATLAS_AUTH_PROJECT_URL: 'https://auth.test',
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  ATLAS_MARKETING_PUBLISHER_SECRET: WORKER_SECRET,
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function snapshotRow(overrides = {}) {
  return {
    version: 'atlas-marketing-workspace/0.2.0',
    venue_date: '2026-09-24',
    content_items: [{
      id: CONTENT_ID, title: 'Quiz night', status: 'scheduled', version: 3, platforms: ['instagram', 'tiktok'],
      platform_options: { tiktok: { tiktok: { privacy_level: 'SELF_ONLY' } } },
      media: [
        { asset_id: ASSET_A, kind: 'image', position: 0, role: 'cover', thumb_storage_path: 'venues/main/2026/09/a/v/t.jpg', storage_path: 'venues/main/2026/09/a/original.jpg' },
        { asset_id: ASSET_B, kind: 'video', position: 1, role: 'item', thumb_storage_path: 'venues/main/2026/09/b/v/t.jpg' },
      ],
      deliveries: [
        { id: DELIVERY_ID, provider_key: 'tiktok', target_kind: 'tiktok_inbox_video', status: 'failed', attention_reason: null },
        { id: '66666666-6666-4666-8666-666666666666', provider_key: 'instagram', target_kind: 'ig_carousel', status: 'published', provider_permalink: 'https://www.instagram.com/p/abc/' },
      ],
      publication_state: 'partial',
    }],
    publish_targets: [{ provider_key: 'instagram', ready: true, reason: null, target_kinds: ['ig_feed'], resource: { kind: 'instagram_account', id: '1784', label: 'vabar.rvk' } }],
    automatic_publishing_enabled: true,
    attention: { needs_attention: 0, failed: 1, verifying: 0, total: 1 },
    ...overrides,
  };
}

// A scripted backend. `rpc[name]` returns a body or { status, body }.
function backend({ rpc = {}, wake = 'ok' } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null;
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: url.href, path: url.pathname, body, headers });
    if (url.origin === 'https://auth.test' && url.pathname === '/rest/v1/profiles') return json([{ id: USER_ID, display_name: 'Sara', role: 'manager', active: true }]);
    if (url.origin !== BASE) throw new Error(`Unexpected request ${url.href}`);
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.slice('/rest/v1/rpc/'.length);
      const handler = rpc[name] ?? defaultRpc[name];
      if (!handler) throw new Error(`Unexpected rpc ${name}`);
      const out = typeof handler === 'function' ? await handler(body) : handler;
      if (out && out.__status) return json(out.body, out.__status);
      return json(out ?? null);
    }
    if (url.pathname === '/storage/v1/object/sign/atlas-marketing-media') {
      return json(body.paths.map((path) => ({ path, signedURL: `/object/sign/atlas-marketing-media/${path}?token=sig-${path.length}`, error: null })));
    }
    if (url.pathname === '/functions/v1/atlas-marketing-publisher') {
      assert.equal(url.searchParams.get('action'), 'kick');
      if (wake === 'throw') throw new TypeError('fetch failed');
      return json({ ok: true }, wake === 'fail' ? 500 : 200);
    }
    throw new Error(`Unexpected request ${url.href}`);
  };
  const defaultRpc = {
    atlas_marketing_workspace_snapshot: () => snapshotRow(),
    atlas_marketing_recommendations: () => [],
    atlas_settings_venue_clock: () => ({ venue_date: '2026-09-24', timezone: 'Atlantic/Reykjavik' }),
    atlas_integration_publish_targets: () => [],
  };
  return { calls, fetchImpl, rpcCalls: (name) => calls.filter((c) => c.path === `/rest/v1/rpc/${name}`) };
}

function handlerFor(role = 'manager', options = {}) {
  const b = backend(options);
  const handle = createMarketingHandler({
    env: (name) => (options.env ?? ENV)[name],
    fetchImpl: b.fetchImpl,
    now: () => NOW,
    resolveActor: async () => ({ token: 'user-jwt', userId: USER_ID, profile: { id: USER_ID, role, active: true, display_name: 'Sara' } }),
  });
  return { ...b, handle };
}

const get = (handle, action, params = {}) => handle(new Request(`https://fn.test/atlas-marketing-workspace?${new URLSearchParams({ action, ...params })}`, { headers: { authorization: 'Bearer user-jwt' } }));
const post = (handle, action, body) => handle(new Request(`https://fn.test/atlas-marketing-workspace?action=${action}`, {
  method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify({ start_date: '2026-09-01', end_date: '2026-09-30', ...body }),
}));

function assertNoLeak(text) {
  for (const secret of [SERVICE_KEY, WORKER_SECRET, ACCESS_TOKEN, 'original.jpg', 'storage_path']) {
    assert.ok(!text.includes(secret), `response leaked ${secret}`);
  }
}

// ---------------------------------------------------------------- snapshot

test('snapshot: media thumbs are batch-signed for 5 minutes, paths never reach the browser', async () => {
  const { handle, calls } = handlerFor('manager');
  const response = await get(handle, 'snapshot', { start: '2026-09-01', end: '2026-09-30' });
  assert.equal(response.status, 200);
  const text = await response.text();
  assertNoLeak(text);
  const payload = JSON.parse(text);
  const media = payload.workspace.content_items[0].media;
  assert.equal(media.length, 2);
  assert.match(media[0].thumb_url, /^https:\/\/branch\.test\/storage\/v1\/object\/sign\/atlas-marketing-media\/venues\/main\/2026\/09\/a\/v\/t\.jpg\?token=/);
  assert.equal(media[0].thumb_expires_at, new Date(NOW + 300_000).toISOString());
  assert.equal(media[0].thumb_storage_path, undefined);
  const signs = calls.filter((c) => c.path.startsWith('/storage/v1/object/sign/'));
  assert.equal(signs.length, 1, 'one batch sign per response');
  assert.equal(signs[0].body.expiresIn, 300);
  assert.deepEqual(signs[0].body.paths, ['venues/main/2026/09/a/v/t.jpg', 'venues/main/2026/09/b/v/t.jpg']);
  assert.equal(payload.workspace.publication_state, undefined);
  assert.equal(payload.workspace.content_items[0].publication_state, 'partial');
  assert.equal(payload.workspace.automatic_publishing_enabled, true);
  assert.deepEqual(payload.workspace.attention, { needs_attention: 0, failed: 1, verifying: 0, total: 1 });
  assert.equal(payload.staff.can_publish, true);
  assert.equal(payload.policy.oauth_tokens_in_browser, false);
  assert.equal(payload.policy.provider_calls_from_gateway, false);
});

test('snapshot: venue date comes from the database, never a literal zone', async () => {
  const { handle, rpcCalls } = handlerFor('manager', { rpc: { atlas_marketing_workspace_snapshot: () => snapshotRow({ venue_date: '2026-10-02' }) } });
  await get(handle, 'snapshot', { start: '2026-10-01', end: '2026-10-31' });
  assert.equal(rpcCalls('atlas_marketing_recommendations')[0].body.p_local_date, '2026-10-02');
  assert.equal(rpcCalls('atlas_settings_venue_clock').length, 0, 'range given, snapshot carries the venue date');

  const second = handlerFor('manager', { rpc: { atlas_settings_venue_clock: () => ({ venue_date: '2026-11-15' }) } });
  await get(second.handle, 'snapshot');
  const call = second.rpcCalls('atlas_marketing_workspace_snapshot')[0];
  assert.equal(call.body.p_start_date, '2026-11-01');
  assert.equal(call.body.p_end_date, '2026-11-30');
  assert.deepEqual(second.rpcCalls('atlas_settings_venue_clock')[0].body, { p_actor_role: 'manager', p_actor_id: USER_ID });
  const source = readFileSync('supabase/functions/atlas-marketing-workspace/handler.mjs', 'utf8');
  assert.doesNotMatch(source, /Atlantic\/Reykjavik/);
});

test('snapshot: publish targets are read when the snapshot lacks them; bartender may read the plan', async () => {
  const { handle, rpcCalls } = handlerFor('bartender', {
    rpc: {
      atlas_marketing_workspace_snapshot: () => snapshotRow({ publish_targets: undefined }),
      atlas_integration_publish_targets: () => [{ provider_key: 'facebook', ready: false, reason: 'no_resource_selected', access_token: ACCESS_TOKEN }],
    },
  });
  const response = await get(handle, 'snapshot', { start: '2026-09-01', end: '2026-09-30' });
  assert.equal(response.status, 200);
  const text = await response.text();
  assertNoLeak(text);
  const payload = JSON.parse(text);
  assert.equal(payload.workspace.publish_targets[0].reason, 'no_resource_selected');
  assert.equal(rpcCalls('atlas_integration_publish_targets').length, 1);
  assert.equal(payload.staff.can_publish, false);
  assert.equal(payload.staff.can_create, true);
});

// ---------------------------------------------------------------- roles

const S94_POSTS = [
  ['cancel-content', { content_id: CONTENT_ID }],
  ['reschedule-content', { content_id: CONTENT_ID, version: 3, scheduled_for: '2026-10-01T18:00:00.000Z' }],
  ['duplicate-content', { content_id: CONTENT_ID }],
  ['set-content-media', { content_id: CONTENT_ID, items: [{ asset_id: ASSET_A }] }],
  ['publish-now', { content_id: CONTENT_ID }],
  ['retry-delivery', { delivery_id: DELIVERY_ID }],
  ['cancel-delivery', { delivery_id: DELIVERY_ID }],
  ['mark-delivery-posted', { delivery_id: DELIVERY_ID, permalink: 'https://www.tiktok.com/@vabar/video/1' }],
];

for (const role of ['bartender', 'viewer']) {
  test(`roles: ${role} gets 403 on every S94 action with zero RPC writes`, async () => {
    for (const [action, body] of S94_POSTS) {
      const { handle, calls } = handlerFor(role);
      const response = await post(handle, action, body);
      assert.equal(response.status, 403, action);
      assert.equal((await response.json()).error_code, 'forbidden');
      assert.equal(calls.filter((c) => c.path.startsWith('/rest/v1/rpc/') && !/snapshot|venue_clock/.test(c.path)).length, 0, `${action}: no RPC`);
      assert.equal(calls.filter((c) => c.path.startsWith('/functions/')).length, 0, `${action}: no wake`);
    }
    for (const action of ['history', 'publish-targets', 'tiktok-creator-info']) {
      const { handle } = handlerFor(role);
      assert.equal((await get(handle, action, { content_id: CONTENT_ID })).status, 403, action);
    }
    const { handle } = handlerFor(role);
    assert.equal((await post(handle, 'decide-approval', { content_id: CONTENT_ID, decision: 'approved' })).status, 403);
  });
}

test('roles: admin and manager reach every S94 action with the actor id; SQL 42501 maps to 403', async () => {
  for (const role of ['admin', 'manager']) {
    for (const [action, body] of S94_POSTS) {
      const { handle, calls } = handlerFor(role, {
        rpc: {
          atlas_marketing_content_cancel: { content: { id: CONTENT_ID, version: 4 } },
          atlas_marketing_content_reschedule: { content: { id: CONTENT_ID, version: 4 } },
          atlas_marketing_content_duplicate: { content: { id: ASSET_B } },
          atlas_marketing_content_media_set: { ok: true },
          atlas_marketing_publish_now: { status: 'queued', wake: true, deliveries: [] },
          atlas_marketing_delivery_manager_action: { ok: true },
        },
      });
      const response = await post(handle, action, body);
      assert.equal(response.status, 200, `${role} ${action}`);
      const rpcCall = calls.find((c) => c.path.startsWith('/rest/v1/rpc/') && !/snapshot|recommendations|venue_clock|publish_targets/.test(c.path));
      assert.equal(rpcCall.body.p_actor_id, USER_ID, action);
      assert.equal(rpcCall.headers.authorization, `Bearer ${SERVICE_KEY}`);
    }
  }
  const { handle } = handlerFor('manager', { rpc: { atlas_marketing_publish_now: { __status: 400, body: { code: '42501', message: 'forbidden', hint: 'atlas:forbidden' } } } });
  const refused = await post(handle, 'publish-now', { content_id: CONTENT_ID });
  assert.equal(refused.status, 403);
});

// ---------------------------------------------------------------- update-content

test('update-content is a partial patch with the expected version; untouched fields are never sent', async () => {
  const { handle, rpcCalls } = handlerFor('manager', { rpc: { atlas_marketing_update_content: { content: { id: CONTENT_ID, version: 4 } } } });
  const response = await post(handle, 'update-content', { content_id: CONTENT_ID, version: 3, caption_draft: 'New caption', note: null });
  assert.equal(response.status, 200);
  const call = rpcCalls('atlas_marketing_update_content')[0].body;
  assert.deepEqual(Object.keys(call).sort(), ['p_actor_id', 'p_content_id', 'p_expected_version', 'p_note', 'p_patch']);
  assert.equal(call.p_expected_version, 3);
  assert.deepEqual(call.p_patch, { caption_draft: 'New caption' });
  for (const kept of ['frames', 'creative_brief', 'suggested_format', 'event_starts_at', 'owner_id', 'media_requirements', 'title']) {
    assert.ok(!(kept in call.p_patch), `${kept} is not cleared`);
  }
});

test('update-content: an explicit null clears only that field; legacy full payloads still work', async () => {
  const patch = contentPatch({ scheduled_for: null, content_type: 'post', platforms: ['instagram'] });
  assert.deepEqual(patch, { scheduled_for: null, platforms: ['instagram'] });
  const { handle, rpcCalls } = handlerFor('manager', { rpc: { atlas_marketing_update_content: { content: { id: CONTENT_ID } } } });
  const legacy = { content_id: CONTENT_ID, title: 'Old', content_type: 'post', campaign_id: null, platforms: ['facebook'], caption_draft: 'x', media_requirements: { notes: 'n' }, scheduled_for: '2026-10-01T18:00:00.000Z', reminder_at: null, priority: 'normal', note: null };
  assert.equal((await post(handle, 'update-content', legacy)).status, 200);
  const call = rpcCalls('atlas_marketing_update_content')[0].body;
  assert.equal(call.p_expected_version, null);
  assert.equal(call.p_patch.title, 'Old');
  assert.ok(!('frames' in call.p_patch));
  assert.ok(!('content_type' in call.p_patch));
});

test('update-content: a stale version is a 409 stale_request', async () => {
  const { handle } = handlerFor('manager', { rpc: { atlas_marketing_update_content: { __status: 400, body: { code: '40001', message: 'stale', hint: 'atlas:stale_request' } } } });
  const response = await post(handle, 'update-content', { content_id: CONTENT_ID, version: 2, title: 'x' });
  assert.equal(response.status, 409);
  const superseded = handlerFor('manager', { rpc: { atlas_marketing_publish_now: { __status: 409, body: { code: '55000', message: 'superseded', hint: 'atlas:superseded' } } } });
  assert.equal((await (await post(superseded.handle, 'publish-now', { content_id: CONTENT_ID })).json()).error_code, 'superseded');
  const payload = await response.json();
  assert.equal(payload.error_code, 'stale_request');
  assert.match(payload.error, /changed while you were working/);
});

test('update-content: platform options need a manager, are validated and bounded', async () => {
  const bartender = handlerFor('bartender');
  assert.equal((await post(bartender.handle, 'update-content', { content_id: CONTENT_ID, platform_options: {} })).status, 403);
  const options = platformOptions({
    tiktok: { caption: 'Hi', target_kind: 'tiktok_inbox_video', tiktok: { privacy_level: 'mutual_follow_friends', disable_comment: false } },
    'google-business-profile': { gbp: { topic_type: 'event', call_to_action: { action_type: 'book', url: 'https://vabar.is/book' }, event: { title: 'Quiz', start: '2026-10-01T18:00:00Z', end: '2026-10-01T21:00:00Z' } } },
  });
  assert.equal(options.tiktok.tiktok.privacy_level, 'MUTUAL_FOLLOW_FRIENDS');
  assert.equal(options.tiktok.tiktok.disable_comment, false);
  assert.equal(options.tiktok.tiktok.disable_duet, true, 'interactions are off unless turned on');
  assert.equal(options['google-business-profile'].gbp.call_to_action.action_type, 'BOOK');
  assert.throws(() => platformOptions({ tiktok: { tiktok: { privacy_level: 'SELF_ONLY', brand_content_toggle: true } } }), /Branded content can't be private/);
  // TikTok consent: the time is kept (bounded), consent_by is always the saving actor.
  const consent = platformOptions({ tiktok: { tiktok: { privacy_level: 'PUBLIC_TO_EVERYONE', consent_confirmed_at: '2026-09-24T13:59:00.000Z', consent_by: '99999999-9999-4999-8999-999999999999' } } }, { actorId: USER_ID, nowMs: NOW });
  assert.equal(consent.tiktok.tiktok.consent_confirmed_at, '2026-09-24T13:59:00.000Z');
  assert.equal(consent.tiktok.tiktok.consent_by, USER_ID);
  assert.equal(platformOptions({ tiktok: { tiktok: {} } }, { actorId: USER_ID, nowMs: NOW }).tiktok.tiktok.consent_by, null, 'no consent, no consenter');
  assert.throws(() => platformOptions({ tiktok: { tiktok: { consent_confirmed_at: '2026-12-24T13:59:00.000Z' } } }, { actorId: USER_ID, nowMs: NOW }), /confirmation time/);
  assert.throws(() => platformOptions({ myspace: {} }), /unsupported/);
  assert.throws(() => platformOptions({ 'google-business-profile': { gbp: { call_to_action: { action_type: 'book', url: 'http://x.test' } } } }), /https/);
  assert.throws(() => platformOptions({ instagram: { target_kind: 'ig_story' } }), /Format/);
});

test('scheduled times must carry an offset (venue wall time is converted in the browser)', async () => {
  const { handle } = handlerFor('manager', { rpc: { atlas_marketing_update_content: { content: {} } } });
  const response = await post(handle, 'update-content', { content_id: CONTENT_ID, scheduled_for: '2026-10-01T18:00' });
  assert.equal(response.status, 400);
});

// ---------------------------------------------------------------- create

test('create-content returns the new id from the RPC and attaches options and media in order', async () => {
  const { handle, rpcCalls } = handlerFor('manager', {
    rpc: {
      atlas_marketing_create_content: { id: CONTENT_ID, content_id: CONTENT_ID, content: { id: CONTENT_ID, version: 1 } },
      atlas_marketing_update_content: { content: { id: CONTENT_ID, version: 2 } },
      atlas_marketing_content_media_set: { ok: true },
    },
  });
  const response = await post(handle, 'create-content', {
    client_request_id: '77777777-7777-4777-8777-777777777777', title: 'Autumn menu', content_type: 'post', platforms: ['instagram'],
    platform_options: { instagram: { caption: 'IG only' } }, media: [{ asset_id: ASSET_B }, { asset_id: ASSET_A, collection_id: '88888888-8888-4888-8888-888888888888' }],
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.content_id, CONTENT_ID);
  assert.equal(rpcCalls('atlas_marketing_update_content')[0].body.p_expected_version, 1);
  const media = rpcCalls('atlas_marketing_content_media_set')[0].body.p_items;
  assert.deepEqual(media.map((m) => [m.asset_id, m.position, m.role]), [[ASSET_B, 0, 'cover'], [ASSET_A, 1, 'item']]);
  assert.equal(media[1].collection_id, '88888888-8888-4888-8888-888888888888');
});

test('media items: explicit order, duplicates and bad ids refused', () => {
  assert.deepEqual(mediaItems([{ asset_id: ASSET_A }, { asset_id: ASSET_B, role: 'item' }]).map((m) => m.position), [0, 1]);
  assert.throws(() => mediaItems([{ asset_id: ASSET_A }, { asset_id: ASSET_A }]), /twice/);
  assert.throws(() => mediaItems([{ asset_id: 'nope' }]), /invalid/);
  assert.throws(() => mediaItems(Array.from({ length: 36 }, () => ({ asset_id: ASSET_A }))), /up to 35/);
});

// ---------------------------------------------------------------- publish-now

test('publish-now wakes the worker server-side with the secret header; the secret never reaches the browser', async () => {
  const { handle, calls } = handlerFor('manager', { rpc: { atlas_marketing_publish_now: { status: 'queued', wake: true, content_id: CONTENT_ID, deliveries: [{ id: DELIVERY_ID, provider_key: 'instagram', status: 'queued' }] } } });
  const response = await post(handle, 'publish-now', { content_id: CONTENT_ID });
  assert.equal(response.status, 200);
  const text = await response.text();
  assertNoLeak(text);
  assert.ok(!/x-atlas-publisher-secret/i.test(text));
  const wake = calls.filter((c) => c.path === '/functions/v1/atlas-marketing-publisher');
  assert.equal(wake.length, 1);
  assert.equal(wake[0].headers['x-atlas-publisher-secret'], WORKER_SECRET);
  assert.equal(wake[0].headers.authorization, undefined, 'no service key on the wake');
  const order = calls.map((c) => c.path);
  assert.ok(order.indexOf('/rest/v1/rpc/atlas_marketing_publish_now') < order.indexOf('/functions/v1/atlas-marketing-publisher'), 'wake after commit');
  assert.equal(JSON.parse(text).result.status, 'queued');
});

test('publish-now: a failed or impossible wake is not an error (cron picks it up)', async () => {
  for (const wake of ['fail', 'throw']) {
    const { handle } = handlerFor('manager', { wake, rpc: { atlas_marketing_publish_now: { status: 'queued', wake: true } } });
    assert.equal((await post(handle, 'publish-now', { content_id: CONTENT_ID })).status, 200, wake);
  }
  const unset = handlerFor('manager', { env: { ...ENV, ATLAS_MARKETING_PUBLISHER_SECRET: '' }, rpc: { atlas_marketing_publish_now: { status: 'queued', wake: true } } });
  assert.equal((await post(unset.handle, 'publish-now', { content_id: CONTENT_ID })).status, 200);
  assert.equal(unset.calls.filter((c) => c.path.startsWith('/functions/')).length, 0, 'no wake without a secret');
  const idle = handlerFor('manager', { rpc: { atlas_marketing_publish_now: { status: 'queued', wake: false } } });
  await post(idle.handle, 'publish-now', { content_id: CONTENT_ID });
  assert.equal(idle.calls.filter((c) => c.path.startsWith('/functions/')).length, 0, 'nothing due, no wake');
});

test('publish-now with automatic publishing off is a clear 409', async () => {
  const { handle, calls } = handlerFor('manager', { rpc: { atlas_marketing_publish_now: { __status: 400, body: { code: 'P0001', message: 'automatic publishing is disabled', hint: 'atlas:automatic_publishing_disabled' } } } });
  const response = await post(handle, 'publish-now', { content_id: CONTENT_ID });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.error_code, 'automatic_publishing_disabled');
  assert.match(payload.error, /Automatic publishing is off/);
  assert.equal(calls.filter((c) => c.path.startsWith('/functions/')).length, 0);
});

test('the gateway never calls a social provider', () => {
  const source = readFileSync('supabase/functions/atlas-marketing-workspace/handler.mjs', 'utf8') + readFileSync('supabase/functions/atlas-marketing-workspace/index.ts', 'utf8');
  assert.doesNotMatch(source, /graph\.facebook\.com|open\.tiktokapis\.com|open-api\.tiktok\.com|mybusiness[a-z]*\.googleapis\.com|localPosts/);
  assert.match(source, /x-atlas-publisher-secret/);
});

// ---------------------------------------------------------------- deliveries

test('retry-delivery retries one channel through the manager action and wakes the worker', async () => {
  const { handle, rpcCalls, calls } = handlerFor('manager', { rpc: { atlas_marketing_delivery_manager_action: { ok: true, action: 'retry', delivery: { id: DELIVERY_ID, provider_key: 'tiktok', status: 'queued' } } } });
  assert.equal((await post(handle, 'retry-delivery', { delivery_id: DELIVERY_ID })).status, 200);
  const call = rpcCalls('atlas_marketing_delivery_manager_action')[0].body;
  assert.equal(call.p_action, 'retry');
  assert.equal(call.p_delivery_id, DELIVERY_ID);
  assert.equal(call.p_payload.confirmed_not_posted, false);
  assert.equal(calls.filter((c) => c.path === '/functions/v1/atlas-marketing-publisher').length, 1);
});

test('retry after an uncertain submit needs the attestation (409)', async () => {
  const { handle } = handlerFor('manager', { rpc: { atlas_marketing_delivery_manager_action: { __status: 400, body: { code: 'P0001', message: 'attestation required', hint: 'atlas:attestation_required' } } } });
  const response = await post(handle, 'retry-delivery', { delivery_id: DELIVERY_ID });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error_code, 'attestation_required');
});

test('cancel-delivery and mark-delivery-posted map to the manager action; the permalink must be https', async () => {
  const { handle, rpcCalls } = handlerFor('manager', { rpc: { atlas_marketing_delivery_manager_action: { ok: true } } });
  await post(handle, 'cancel-delivery', { delivery_id: DELIVERY_ID });
  await post(handle, 'mark-delivery-posted', { delivery_id: DELIVERY_ID, permalink: 'https://www.tiktok.com/@vabar/video/1', published_at: '2026-09-24T13:00:00.000Z' });
  const [cancel, posted] = rpcCalls('atlas_marketing_delivery_manager_action').map((c) => c.body);
  assert.equal(cancel.p_action, 'cancel');
  assert.equal(posted.p_action, 'mark_posted');
  assert.equal(posted.p_payload.permalink, 'https://www.tiktok.com/@vabar/video/1');
  const bad = handlerFor('manager');
  assert.equal((await post(bad.handle, 'mark-delivery-posted', { delivery_id: DELIVERY_ID, permalink: 'javascript:alert(1)' })).status, 400);
  assert.equal((await post(bad.handle, 'mark-delivery-posted', { delivery_id: DELIVERY_ID })).status, 400);
});

test('in-flight edits are refused with a plain 409', async () => {
  const { handle } = handlerFor('manager', { rpc: { atlas_marketing_content_reschedule: { __status: 400, body: { code: 'P0001', message: 'in flight', hint: 'atlas:in_flight' } } } });
  const response = await post(handle, 'reschedule-content', { content_id: CONTENT_ID, version: 3, scheduled_for: '2026-10-01T18:00:00Z' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error_code, 'in_flight');
  const missing = handlerFor('manager');
  assert.equal((await post(missing.handle, 'reschedule-content', { content_id: CONTENT_ID, scheduled_for: '2026-10-01T18:00:00Z' })).status, 400, 'version required');
});

// ---------------------------------------------------------------- history

test('history: per-platform deliveries with attempts, scrubbed of tokens, claim tokens and paths', async () => {
  const { handle, rpcCalls } = handlerFor('manager', {
    rpc: {
      atlas_marketing_publication_history: {
        content: { id: CONTENT_ID, title: 'Quiz night', status: 'scheduled', version: 3, publication_state: 'partial' },
        deliveries: [
          { id: DELIVERY_ID, provider_key: 'tiktok', target_kind: 'tiktok_inbox_video', status: 'failed', attempt_count: 2, last_error_message: 'TikTok rejected the video.', claim_token: 'aaaa', attempts: [{ attempt_no: 1, outcome: 'failed', steps: [{ step: 'init', access_token: ACCESS_TOKEN, upload_url: 'https://upload.tiktok.test/x' }] }] },
          { id: '66666666-6666-4666-8666-666666666666', provider_key: 'instagram', target_kind: 'ig_feed', status: 'published', provider_permalink: 'https://www.instagram.com/p/abc/', attempts: [] },
        ],
        approvals: [{ decision: 'approved', actor_label: 'Imad' }],
        revisions: [], events: [],
      },
    },
  });
  const response = await get(handle, 'history', { content_id: CONTENT_ID });
  assert.equal(response.status, 200);
  const text = await response.text();
  assertNoLeak(text);
  assert.ok(!text.includes('upload.tiktok.test'));
  assert.ok(!text.includes('claim_token'));
  const payload = JSON.parse(text);
  assert.deepEqual(payload.history.deliveries.map((d) => [d.provider_key, d.status]), [['tiktok', 'failed'], ['instagram', 'published']]);
  assert.equal(payload.history.deliveries[0].attempts[0].steps[0].step, 'init');
  assert.equal(payload.history.deliveries[1].provider_permalink, 'https://www.instagram.com/p/abc/');
  assert.deepEqual(rpcCalls('atlas_marketing_publication_history')[0].body, { p_actor_id: USER_ID, p_content_id: CONTENT_ID });
  const bad = handlerFor('manager');
  assert.equal((await get(bad.handle, 'history', { content_id: 'nope' })).status, 400);
});

test('tiktok-creator-info reads through the credential module and returns only the safe fields', async () => {
  const b = backend();
  const seen = [];
  const handle = createMarketingHandler({
    env: (name) => ENV[name], fetchImpl: b.fetchImpl, now: () => NOW,
    resolveActor: async () => ({ token: 't', userId: USER_ID, profile: { role: 'admin', active: true, display_name: 'Sara' } }),
    readTikTokCreatorInfo: async (deps, actor) => { seen.push(actor); assert.equal(typeof deps.rpc, 'function'); return { creator_username: 'vabar.rvk', creator_nickname: 'VÁ', privacy_level_options: ['SELF_ONLY', 'EVIL'], duet_disabled: true, max_video_post_duration_sec: 600, direct_post_allowed: true, access_token: ACCESS_TOKEN }; },
  });
  const response = await get(handle, 'tiktok-creator-info');
  const text = await response.text();
  assertNoLeak(text);
  const info = JSON.parse(text).creator_info;
  assert.deepEqual(info, { available: true, nickname: 'VÁ', username: 'vabar.rvk', privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600, direct_post_allowed: true });
  assert.deepEqual(seen[0], { actorId: USER_ID, actorRole: 'admin', actorLabel: 'Sara' });
  const failing = createMarketingHandler({ env: (n) => ENV[n], fetchImpl: b.fetchImpl, now: () => NOW, resolveActor: async () => ({ token: 't', userId: USER_ID, profile: { role: 'manager', active: true } }), readTikTokCreatorInfo: async () => { throw Object.assign(new Error('x'), { code: 'needs_reauthorization', reauthorize: true }); } });
  assert.deepEqual((await (await get(failing, 'tiktok-creator-info')).json()).creator_info, { available: false, reason: 'needs_reauthorization' });
});

test('publish-targets returns readiness only; tiktok-creator-info never returns a token', async () => {
  const { handle } = handlerFor('manager', { rpc: { atlas_integration_publish_targets: [{ provider_key: 'tiktok', ready: true, target_kinds: ['tiktok_inbox_video'], access_token: ACCESS_TOKEN }] } });
  const response = await get(handle, 'publish-targets');
  const text = await response.text();
  assertNoLeak(text);
  assert.equal(JSON.parse(text).publish_targets[0].provider_key, 'tiktok');
  const info = await get(handle, 'tiktok-creator-info');
  assert.equal(info.status, 200);
  const infoText = await info.text();
  assertNoLeak(infoText);
  assert.equal(typeof JSON.parse(infoText).creator_info.available, 'boolean');
});

// ---------------------------------------------------------------- guards

test('scrub and the response guard remove credential-shaped and path fields', () => {
  const dirty = { a: 1, access_token: 'x', nested: [{ refresh_token: 'y', storage_path: 'p', thumb_url: 'ok', upload_url: 'u' }] };
  assert.deepEqual(scrub(dirty), { a: 1, nested: [{ thumb_url: 'ok' }] });
  assert.deepEqual(findSecretKeys({ ok: { client_secret: 1 } }), ['$.ok.client_secret']);
});

test('rpc failures: database wording never leaks, known codes map to stable errors', () => {
  assert.equal(rpcFailure(400, { code: '42P01', message: 'relation "atlas_private.x" does not exist' }).message, 'The request was not valid. Nothing was changed.');
  assert.equal(rpcFailure(400, { code: 'P0001', message: 'Choose a time in the future.' }).message, 'Choose a time in the future.');
  assert.equal(rpcFailure(500, { message: 'boom' }).status, 503);
  assert.equal(rpcFailure(400, { code: 'P0002', message: 'x', hint: 'atlas:not_found' }).status, 404);
});

test('existing actions keep their names and payloads', async () => {
  const { handle, rpcCalls } = handlerFor('manager', {
    rpc: {
      atlas_marketing_decide_approval: { ok: true },
      atlas_marketing_submit_approval: { ok: true },
      atlas_marketing_mark_published: { ok: true },
      atlas_marketing_convert_recommendation_occurrence: { ok: true },
    },
  });
  assert.equal((await post(handle, 'decide-approval', { content_id: CONTENT_ID, decision: 'approved', note: '' })).status, 200);
  assert.equal(rpcCalls('atlas_marketing_decide_approval')[0].body.p_actor_label, 'Sara');
  assert.equal((await post(handle, 'submit-approval', { content_id: CONTENT_ID })).status, 200);
  assert.equal((await post(handle, 'mark-published', { content_id: CONTENT_ID, published_at: '2026-09-24T13:00:00.000Z', external_publication_ids: {} })).status, 200);
  assert.equal((await post(handle, 'convert-recommendation', { recommendation_id: ASSET_A, client_request_id: ASSET_B })).status, 200);
  assert.equal(rpcCalls('atlas_marketing_convert_recommendation_occurrence')[0].body.p_occurrence_date, '2026-09-24', 'from the venue clock');
  assert.equal((await post(handle, 'nope', {})).status, 404);
  assert.equal((await handle(new Request('https://fn.test/x?action=snapshot', { method: 'PUT', headers: { authorization: 'Bearer x' } }))).status, 405);
});
