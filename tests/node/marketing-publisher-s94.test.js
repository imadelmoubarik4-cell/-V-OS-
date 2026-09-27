// S94C marketing publisher: worker + provider adapters against provider fakes
// and an in-memory fenced RPC store (tests/node/helpers/provider-fakes.mjs).
// Covers report 07 §8.3 (T1-T17) and the worker rows of report 09 §6. No test
// reaches a real provider: every URL outside the fakes throws. The claim/fence
// SQL itself is proven by the DB previews (verify_s94c_publishing_preview.sql)
// and the concurrency script; the fake mirrors that contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadEdgeFunction } from './helpers/edge-function-harness.js';

import {
  createPublisherHandler,
  credentialFailure,
  secretMatches,
  secretConfigured,
  coerceForClaim,
  normalizeClaim,
  SECRET_HEADER,
} from '../../supabase/functions/atlas-marketing-publisher/handler.mjs';
import { createHttp, assertProviderUploadUrl, sanitizeMessage, HttpError } from '../../supabase/functions/_shared/publishing/http.mjs';
import { classifyResponse, classifyFailure, outcomeFor } from '../../supabase/functions/_shared/publishing/classify.mjs';
import { uploadPlan } from '../../supabase/functions/_shared/publishing/tiktok.mjs';
import { isValidStoragePath } from '../../supabase/functions/_shared/publishing/media-urls.mjs';
import { localParts } from '../../supabase/functions/_shared/publishing/gbp.mjs';
import {
  createProviderFakes,
  createFakePublishingDb,
  createFakeCredentials,
  steps,
  uuid,
  mediaPath,
  SUPABASE_URL,
  SERVICE_KEY,
  TOKENS,
  RESOURCES,
} from './helpers/provider-fakes.mjs';

const SECRET = 'publisher-secret-0123456789abcdef-0123456789';
const START = Date.parse('2026-10-02T12:00:00Z');
const MIB = 1024 * 1024;

// ---- console capture: the worker must never log secrets ---------------------
const captured = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level];
  console[level] = (...args) => {
    captured.push(args.map(String).join(' '));
    if (process.env.S94_PUBLISHER_DEBUG) original(...args);
  };
}

const LEAK_MARKERS = [...Object.values(TOKENS), SERVICE_KEY, SECRET, 'SIGNEDURLTOKEN', 'upload_token', 'token=', `${SUPABASE_URL}/storage`, 'open-upload.tiktokapis.com'];

function assertNoLeak(label, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const marker of LEAK_MARKERS) assert.ok(!text.includes(marker), `${label} leaks ${marker.slice(0, 18)}…`);
}

let mediaSeq = 0;

function setup({ env = {}, script = {}, db: dbOptions = {}, credentials: credOptions = {}, slowMs = 0 } = {}) {
  const clock = { t: START };
  const now = () => clock.t;
  const fakes = createProviderFakes({ now, script });
  const db = createFakePublishingDb({ now, ...dbOptions });
  const creds = createFakeCredentials(db, credOptions);
  const events = [];
  const responses = [];
  const sleeps = [];
  const rpc = async (name, payload) => {
    events.push(`rpc:${name.replace('atlas_marketing_delivery_', '')}${name.endsWith('record_step') ? `:${payload.p_step?.step ?? ''}` : ''}`);
    return db.rpc(name, payload);
  };
  const fetchImpl = async (input, init) => {
    try {
      return await fakes.fetchImpl(input, init);
    } finally {
      events.push(`http:${fakes.calls.at(-1)?.op}`);
      clock.t += slowMs;
    }
  };
  const fullEnv = { ATLAS_MARKETING_PUBLISHER_SECRET: SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ...env };
  const makeHandler = () => createPublisherHandler({
    env: fullEnv,
    fetchImpl,
    rpc,
    now,
    random: () => 0.5,
    credentials: creds,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
  });
  const handler = makeHandler();
  async function tick(h = handler, headers = { [SECRET_HEADER]: SECRET }) {
    const res = await h(new Request('https://functions.test/atlas-marketing-publisher?action=tick', { method: 'POST', headers, body: '{}' }));
    const body = await res.json();
    responses.push(body);
    return { status: res.status, body, headers: res.headers };
  }
  function advance(seconds) {
    clock.t += seconds * 1000;
  }
  function image(position, { width = 1080, height = 1350, size = 400_000, mime = 'image/jpeg', altText } = {}) {
    mediaSeq += 1;
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    const path = mediaPath(mediaSeq, ext);
    fakes.world.storageObjects.set(path, size);
    return { asset_id: uuid(mediaSeq), variant_id: null, storage_path: path, mime_type: mime, width, height, duration_ms: null, byte_size: size, sha256: 'ab'.repeat(32), position, role: position === 0 ? 'primary' : 'item', alt_text: altText };
  }
  function video(position, { size = 3 * MIB, duration = 20_000, width = 1080, height = 1920 } = {}) {
    mediaSeq += 1;
    const path = mediaPath(mediaSeq, 'mp4');
    fakes.world.storageObjects.set(path, size);
    return { asset_id: uuid(mediaSeq), variant_id: null, storage_path: path, mime_type: 'video/mp4', width, height, duration_ms: duration, byte_size: size, sha256: 'cd'.repeat(32), position, role: position === 0 ? 'primary' : 'item' };
  }
  function finish() {
    assert.deepEqual(fakes.unexpected, [], 'no request outside the fakes');
    assertNoLeak('rpc payloads', db.rpcLog);
    assertNoLeak('attempt steps', db.attempts);
    assertNoLeak('delivery rows', [...db.deliveries.values()].map(({ payload_snapshot, ...row }) => row));
    assertNoLeak('responses', responses);
    assertNoLeak('console', captured);
    for (const call of fakes.calls) {
      assert.equal(call.redirect, 'manual', `${call.op} must not follow redirects`);
    }
  }
  return { clock, now, fakes, db, creds, events, responses, sleeps, tick, advance, image, video, finish, makeHandler, env: fullEnv };
}

const row = (s, d) => s.db.deliveries.get(d.id);
const opsOf = (s) => s.fakes.calls.map((call) => call.op);

// ---- T1: secret ---------------------------------------------------------------

test('T1 the worker refuses to run without a configured secret (503) and makes no RPC or provider call', async () => {
  for (const value of [undefined, '', 'short-secret', 'x'.repeat(31)]) {
    const s = setup({ env: { ATLAS_MARKETING_PUBLISHER_SECRET: value } });
    s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post' });
    const res = await s.tick();
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: 'not_configured' });
    assert.equal(s.db.rpcLog.length, 0);
    assert.equal(s.fakes.calls.length, 0);
  }
});

test('T1 missing, wrong or differently sized secrets get 401 with zero RPC and provider calls', async () => {
  const wrongSameLength = SECRET.slice(0, -1) + (SECRET.endsWith('9') ? '8' : '9');
  for (const headers of [{}, { [SECRET_HEADER]: '' }, { [SECRET_HEADER]: wrongSameLength }, { [SECRET_HEADER]: `${SECRET}x` }, { [SECRET_HEADER]: 'short' }, { authorization: `Bearer ${SECRET}` }]) {
    const s = setup();
    s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post' });
    const res = await s.tick(undefined, headers);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
    assert.equal(s.db.rpcLog.length, 0);
    assert.equal(s.fakes.calls.length, 0);
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS surface');
  }
});

test('T1 only POST tick/kick; the rotation secret is accepted; responses carry counts only', async () => {
  const s = setup({ env: { ATLAS_MARKETING_PUBLISHER_SECRET_NEXT: 'next-secret-0123456789abcdef-0123456789' } });
  const handler = s.makeHandler();
  const get = await handler(new Request('https://functions.test/atlas-marketing-publisher?action=tick', { headers: { [SECRET_HEADER]: SECRET } }));
  assert.equal(get.status, 404);
  const other = await handler(new Request('https://functions.test/atlas-marketing-publisher?action=run', { method: 'POST', headers: { [SECRET_HEADER]: SECRET } }));
  assert.equal(other.status, 404);
  assert.equal(s.db.rpcLog.length, 0);
  const rotated = await s.tick(handler, { [SECRET_HEADER]: 'next-secret-0123456789abcdef-0123456789' });
  assert.equal(rotated.status, 200);
  const kick = await handler(new Request('https://functions.test/atlas-marketing-publisher?action=kick', { method: 'POST', headers: { [SECRET_HEADER]: SECRET }, body: '{}' }));
  assert.equal(kick.status, 200);
  assert.deepEqual(Object.keys(await kick.json()).sort(), ['claimed', 'errors', 'failed', 'lease_lost', 'needs_attention', 'ok', 'processing', 'published', 'refused', 'retrying', 'verifying'].sort());
  const big = await handler(new Request('https://functions.test/atlas-marketing-publisher', { method: 'POST', headers: { [SECRET_HEADER]: SECRET }, body: 'x'.repeat(5000) }));
  assert.equal(big.status, 413);
});

test('T1 the secret comparison is constant-time over SHA-256 digests', async () => {
  assert.equal(await secretMatches(SECRET, SECRET), true);
  assert.equal(await secretMatches(`${SECRET}!`, SECRET), false);
  assert.equal(await secretMatches('', SECRET), false);
  assert.equal(secretConfigured('x'.repeat(32)), true);
  assert.equal(secretConfigured('x'.repeat(31)), false);
  assert.equal(secretConfigured('ð'.repeat(16)), true, '32 bytes of UTF-8');
  const source = readFileSync('supabase/functions/atlas-marketing-publisher/handler.mjs', 'utf8');
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(source, /diff \|= a\[index\] \^ b\[index\]/);
  assert.doesNotMatch(source, /provided\s*[!=]==?\s*expected|expected\s*[!=]==?\s*provided/);
  assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)/, 'the worker never logs');
});

// ---- happy paths per provider/target kind ----------------------------------------

test('T2 Instagram single image: container persisted before the first poll, then begin_submit, then media_publish', async () => {
  const s = setup();
  const d = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  const res = await s.tick();
  assert.equal(res.status, 200);
  assert.equal(res.body.published, 1);
  assert.deepEqual(opsOf(s), ['storage.sign', 'ig.media', 'ig.status', 'ig.publish', 'ig.permalink']);
  const order = s.events.filter((e) => /rpc:(record_step:container_created|begin_submit|record_step:media_publish)|http:ig\.(status|publish)/.test(e));
  assert.deepEqual(order, ['rpc:record_step:container_created', 'http:ig.status', 'rpc:begin_submit', 'http:ig.publish', 'rpc:record_step:media_publish']);
  const r = row(s, d);
  assert.equal(r.status, 'published');
  assert.equal(r.published_source, 'provider');
  assert.match(r.provider_permalink, /^https:\/\/www\.instagram\.com\/p\//);
  assert.equal(s.fakes.published.instagram.length, 1);
  assert.equal(s.fakes.calls.find((c) => c.op === 'ig.media').form.caption, 'Friday DJ at VÁ from 21:00 #reykjavik');
  assert.deepEqual(s.sleeps, [2000]);
  s.finish();
});

test('Instagram carousel keeps the approved order for children and the parent container', async () => {
  const s = setup();
  const a = s.image(0);
  const b = s.image(1);
  const c = s.image(2);
  // The snapshot arrives out of order; position decides.
  const d = s.db.add({ provider_key: 'instagram', target_kind: 'ig_carousel', media: [c, a, b] });
  await s.tick();
  const signed = s.fakes.calls.filter((call) => call.op === 'storage.sign').map((call) => call.url);
  assert.deepEqual(signed.map((url) => [a, b, c].findIndex((m) => url.includes(m.asset_id))), [0, 1, 2]);
  const children = s.fakes.calls.filter((call) => call.op === 'ig.media' && call.form.is_carousel_item === 'true');
  assert.equal(children.length, 3);
  const parent = s.fakes.calls.find((call) => call.op === 'ig.media' && call.form.media_type === 'CAROUSEL');
  const childIds = [...s.fakes.world.containers.entries()].filter(([, v]) => v.carouselItem).map(([id]) => id);
  assert.equal(parent.form.children, childIds.join(','));
  assert.deepEqual(row(s, d).progress.children_container_ids, childIds);
  assert.equal(row(s, d).status, 'published');
  assert.deepEqual(s.fakes.published.instagram[0].children, childIds);
  s.finish();
});

test('Instagram Reel: processing across ticks (poll claim), then publish on the same container', async () => {
  const s = setup();
  s.fakes.world.igFinishAfter = 3;
  const d = s.db.add({ provider_key: 'instagram', target_kind: 'ig_reel', media: [s.video(0)] });
  let res = await s.tick();
  assert.equal(res.body.processing, 1);
  assert.equal(row(s, d).status, 'processing');
  assert.deepEqual(s.sleeps, [5000, 10000]);
  const reel = s.fakes.calls.find((call) => call.op === 'ig.media');
  assert.equal(reel.form.media_type, 'REELS');
  assert.match(reel.form.video_url, /^https:\/\/branch\.test\/storage\/v1\/object\/sign\//);
  s.advance(61);
  res = await s.tick();
  assert.equal(res.body.published, 1);
  assert.equal(s.fakes.count('ig.media'), 1);
  assert.equal(s.fakes.count('ig.publish'), 1);
  assert.equal(s.db.attempts.filter((a) => a.delivery_id === d.id).map((a) => a.claim_kind).join(','), 'publish,poll');
  assert.equal(row(s, d).attempt_count, 1, 'polls do not consume attempts');
  s.finish();
});

test('Facebook text post, multi-photo (unpublished photos + attached_media in order), video and Reel', async () => {
  const s = setup();
  const text = s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post', caption: 'Quiz night tonight' });
  const p1 = s.image(0);
  const p2 = s.image(1);
  const p3 = s.image(2);
  const multi = s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_photo', caption: 'New menu', media: [p3, p1, p2] });
  let res = await s.tick();
  assert.equal(res.body.published, 2);
  assert.equal(row(s, text).status, 'published');
  const multiRow = row(s, multi);
  assert.equal(multiRow.status, 'published');
  const unpublished = s.fakes.calls.filter((call) => call.op === 'fb.photos');
  assert.ok(unpublished.every((call) => call.form.published === 'false'));
  assert.equal(unpublished.length, 3);
  const signedOrder = s.fakes.calls.filter((c) => c.op === 'storage.sign').map((c) => [p1, p2, p3].findIndex((m) => c.url.includes(m.asset_id)));
  assert.deepEqual(signedOrder, [0, 1, 2], 'photos are prepared in position order');
  const feed = s.fakes.published.facebook.find((post) => post.kind === 'multi_photo');
  assert.deepEqual(feed.attached, multiRow.progress.child_media_ids);

  const vid = s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_video', media: [s.video(0, { width: 1920, height: 1080 })] });
  const reel = s.db.add({ provider_key: 'facebook', target_kind: 'fb_reel', media: [s.video(0)] });
  res = await s.tick();
  assert.equal(res.body.published, 2);
  assert.equal(row(s, vid).status, 'published');
  assert.equal(row(s, reel).status, 'published');
  assert.deepEqual(opsOf(s).filter((op) => op.startsWith('fb.video_reels') || op === 'fb.rupload'), ['fb.video_reels', 'fb.rupload', 'fb.video_reels']);
  assert.equal(s.fakes.published.facebook.length, 4);
  s.finish();
});

test('TikTok inbox upload: FILE_UPLOAD chunks from Storage ranged reads, then status polling', async () => {
  const s = setup({ env: { ATLAS_PUBLISHER_TIKTOK_CHUNK_BYTES: String(5 * MIB) } });
  const clip = s.video(0, { size: 12 * MIB });
  const d = s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_inbox_video', media: [clip] });
  let res = await s.tick();
  assert.equal(res.body.processing, 1);
  const init = s.fakes.calls.find((call) => call.op === 'tt.inbox_init');
  assert.deepEqual(init.json.source_info, { source: 'FILE_UPLOAD', video_size: 12 * MIB, chunk_size: 5 * MIB, total_chunk_count: 2 });
  const puts = s.fakes.calls.filter((call) => call.op === 'tt.upload');
  assert.deepEqual(puts.map((call) => call.headers['content-range']), [`bytes 0-${5 * MIB - 1}/${12 * MIB}`, `bytes ${5 * MIB}-${12 * MIB - 1}/${12 * MIB}`]);
  const reads = s.fakes.calls.filter((call) => call.op === 'storage.read').map((call) => call.range);
  assert.deepEqual(reads, [[0, 0], [0, 5 * MIB - 1], [5 * MIB, 12 * MIB - 1]]);
  // init only after the submit marker; publish_id persisted before any chunk
  const order = s.events.filter((e) => /rpc:begin_submit|http:tt\.(inbox_init|upload)|rpc:record_step:init/.test(e));
  assert.deepEqual(order.slice(0, 4), ['rpc:begin_submit', 'http:tt.inbox_init', 'rpc:record_step:init', 'http:tt.upload']);
  assert.ok(row(s, d).provider_publish_id);
  s.advance(31);
  res = await s.tick();
  assert.equal(res.body.published, 1);
  assert.equal(row(s, d).status, 'published');
  assert.equal(row(s, d).provider_post_id, row(s, d).provider_publish_id, 'inbox uploads have no public id');
  s.finish();
});

test('TikTok Direct Post: creator_info checks, interaction defaults, publish on PUBLISH_COMPLETE', async () => {
  const s = setup();
  const d = s.db.add({
    provider_key: 'tiktok',
    target_kind: 'tiktok_video',
    media: [s.video(0)],
    platform_options: { tiktok: { target_kind: 'tiktok_video', tiktok: { privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, consent_confirmed_at: '2026-10-01T10:00:00Z' } } },
  });
  await s.tick();
  const init = s.fakes.calls.find((call) => call.op === 'tt.init');
  assert.deepEqual(init.json.post_info, {
    title: 'Friday DJ at VÁ from 21:00 #reykjavik',
    privacy_level: 'PUBLIC_TO_EVERYONE',
    disable_comment: false,
    disable_duet: true, // creator disabled duet
    disable_stitch: true, // not chosen -> off
    brand_content_toggle: false,
    brand_organic_toggle: false,
  });
  assert.equal(init.json.source_info.total_chunk_count, 1, 'a small video goes whole');
  assert.deepEqual(opsOf(s).slice(0, 2), ['tt.creator_info', 'storage.read']);
  s.advance(31);
  await s.tick();
  assert.equal(row(s, d).status, 'published');
  assert.match(row(s, d).provider_post_id, /^73/);
  s.finish();
});

test('Google Business Profile event post with CTA and photo: PROCESSING then LIVE with searchUrl', async () => {
  const s = setup();
  const d = s.db.add({
    provider_key: 'google-business-profile',
    target_kind: 'gbp_local_post',
    caption: 'Jazz night on Saturday',
    media: [s.image(0, { width: 1200, height: 900, size: 300_000 })],
    platform_options: { 'google-business-profile': { gbp: { topic_type: 'EVENT', event: { title: 'Jazz night', start: '2026-10-03T20:00', end: '2026-10-03T23:00' }, call_to_action: { action_type: 'LEARN_MORE', url: 'https://vabar.is/jazz' } } } },
  });
  let res = await s.tick();
  assert.equal(res.body.processing, 1);
  const body = s.fakes.calls.find((call) => call.op === 'gbp.create').json;
  assert.equal(body.topicType, 'EVENT');
  assert.equal(body.languageCode, 'is');
  assert.deepEqual(body.event, { title: 'Jazz night', schedule: { startDate: { year: 2026, month: 10, day: 3 }, endDate: { year: 2026, month: 10, day: 3 }, startTime: { hours: 20, minutes: 0, seconds: 0, nanos: 0 }, endTime: { hours: 23, minutes: 0, seconds: 0, nanos: 0 } } });
  assert.deepEqual(body.callToAction, { actionType: 'LEARN_MORE', url: 'https://vabar.is/jazz' });
  assert.equal(body.media.length, 1);
  assert.equal(body.media[0].mediaFormat, 'PHOTO');
  s.advance(61);
  res = await s.tick();
  assert.equal(res.body.published, 1);
  assert.match(row(s, d).provider_permalink, /^https:\/\/local\.google\.com\//);
  assert.match(row(s, d).provider_post_id, /^accounts\/111\/locations\/222\/localPosts\//);
  s.finish();
});

test('publish now uses the same path: identical provider calls for a publish-now and a scheduled delivery', async () => {
  const sequences = [];
  for (const priority of [100, 10]) {
    const s = setup();
    s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)], priority });
    await s.tick();
    sequences.push(opsOf(s));
    s.finish();
  }
  assert.deepEqual(sequences[0], sequences[1]);
});

// ---- partial success, retries, classification -----------------------------------

test('one provider succeeds and another fails: each delivery gets its own outcome', async () => {
  const s = setup({ script: { 'fb.feed': [steps.metaError(400, 100)] } });
  const ig = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  const fb = s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post' });
  const res = await s.tick();
  assert.equal(res.body.published, 1);
  assert.equal(res.body.failed, 1);
  assert.equal(row(s, ig).status, 'published');
  assert.equal(row(s, fb).status, 'failed');
  assert.equal(row(s, fb).attention_reason, 'provider_rejected');
  assert.equal(s.db.notifications.length, 1);
  s.finish();
});

test('T3 Instagram published, TikTok fails before submit and retries: Instagram is never republished', async () => {
  const s = setup({ script: { 'tt.creator_info': [steps.serverError('tiktok', 500)] } });
  const ig = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  const tt = s.db.add({
    provider_key: 'tiktok', target_kind: 'tiktok_video', media: [s.video(0)],
    platform_options: { tiktok: { tiktok: { privacy_level: 'SELF_ONLY', consent_confirmed_at: '2026-10-01T10:00:00Z' } } },
  });
  await s.tick();
  assert.equal(row(s, ig).status, 'published');
  assert.equal(row(s, tt).status, 'retrying');
  assert.equal(row(s, tt).last_error_class, 'transient');
  const igVersion = row(s, ig).row_version;
  const igCallsAfterTick1 = s.fakes.calls.filter((c) => c.op?.startsWith('ig.')).length;
  s.advance(120);
  await s.tick();
  s.advance(31);
  await s.tick();
  assert.equal(row(s, tt).status, 'published');
  assert.equal(s.fakes.count('ig.media'), 1);
  assert.equal(s.fakes.count('ig.publish'), 1);
  assert.equal(s.fakes.calls.filter((c) => c.op?.startsWith('ig.')).length, igCallsAfterTick1, 'no Instagram call after tick 1');
  assert.equal(row(s, ig).row_version, igVersion);
  assert.equal(s.fakes.published.instagram.length, 1);
  s.finish();
});

test('a transient 5xx before submit retries with backoff and then publishes', async () => {
  const s = setup({ script: { 'ig.media': [steps.serverError('meta', 502)] } });
  const d = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  let res = await s.tick();
  assert.equal(res.body.retrying, 1);
  assert.equal(row(s, d).status, 'retrying');
  assert.equal(Date.parse(row(s, d).next_attempt_at) - s.now(), 45_000);
  res = await s.tick();
  assert.equal(res.body.claimed, 0, 'not due yet');
  s.advance(46);
  res = await s.tick();
  assert.equal(res.body.published, 1);
  assert.equal(s.fakes.count('ig.publish'), 1);
  s.finish();
});

test('T11 429 with Retry-After sets the account cooldown; other accounts are still processed', async () => {
  const s = setup({ script: { 'ig.media': [steps.metaRateLimited(120)] } });
  const ig = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  const fb = s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post' });
  const res = await s.tick();
  assert.equal(res.body.retrying, 1);
  assert.equal(res.body.published, 1);
  assert.equal(row(s, ig).last_error_class, 'rate_limited');
  assert.ok(Date.parse(row(s, ig).next_attempt_at) >= s.now() + 120_000);
  assert.ok(s.db.cooldowns.get(`instagram|${RESOURCES.instagram.id}`) >= s.now() + 120_000);
  assert.equal(row(s, fb).status, 'published');
  s.finish();
});

test('permanent rejections: Graph invalid parameter -> failed; TikTok spam policy after init -> needs_attention', async () => {
  const s = setup({ script: { 'ig.media': [steps.metaError(400, 100)], 'tt.inbox_init': [steps.tiktokError(403, 'spam_risk_too_many_posts')] } });
  const ig = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  const tt = s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_inbox_video', media: [s.video(0)] });
  await s.tick();
  assert.equal(row(s, ig).status, 'failed');
  assert.equal(row(s, ig).last_error_class, 'permanent');
  assert.equal(row(s, tt).status, 'needs_attention');
  assert.equal(row(s, tt).attention_reason, 'provider_rejected');
  assert.equal(s.fakes.count('ig.publish'), 0);
  assert.equal(s.db.notifications.length, 2);
  s.advance(3600);
  const res = await s.tick();
  assert.equal(res.body.claimed, 0, 'no retry loop');
  s.finish();
});

test('T12 auth expired (Graph 190) and a failed refresh go to needs_attention(auth_expired) without a retry loop', async () => {
  const s = setup({ script: { 'ig.media': [steps.metaAuthExpired()] }, credentials: { failures: { 'google-business-profile': { code: 'needs_reauthorization', reauthorize: true } } } });
  const ig = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  const g = s.db.add({ provider_key: 'google-business-profile', target_kind: 'gbp_local_post' });
  await s.tick();
  assert.equal(row(s, ig).status, 'needs_attention');
  assert.equal(row(s, ig).attention_reason, 'auth_expired');
  assert.equal(row(s, ig).last_error_class, 'auth');
  assert.equal(row(s, g).status, 'needs_attention');
  assert.equal(row(s, g).attention_reason, 'auth_expired');
  assert.equal(s.fakes.calls.filter((c) => c.host === 'mybusiness.googleapis.com').length, 0);
  // The Graph error body echoed the token; the stored message is sanitised.
  assert.ok(!row(s, ig).last_error_message.includes(TOKENS.instagram));
  s.advance(6 * 3600);
  const res = await s.tick();
  assert.equal(res.body.claimed, 0);
  s.finish();
});

test('credential errors map to the right outcome (CredentialError codes from the S94B module)', async () => {
  const cases = [
    [{ code: 'needs_reauthorization', reauthorize: true }, 'needs_attention', 'auth_expired'],
    [{ code: 'refresh_failed', reauthorize: true }, 'needs_attention', 'auth_expired'],
    [{ code: 'credential_unreadable', reauthorize: true }, 'needs_attention', 'auth_expired'],
    [{ code: 'refresh_failed', retryable: true }, 'retrying', undefined],
    [{ code: 'refresh_in_progress', retryable: true }, 'retrying', undefined],
    [{ code: 'no_resource_selected' }, 'needs_attention', 'no_resource'],
    [{ code: 'resource_changed' }, 'needs_attention', 'no_resource'],
    [{ code: 'publishing_permission_missing' }, 'needs_attention', 'provider_not_ready'],
    [{ code: 'not_approved' }, 'needs_attention', 'manual_hold'],
  ];
  for (const [error, status, reason] of cases) {
    const out = credentialFailure(error);
    assert.equal(out.status, status, error.code);
    assert.equal(out.attention_reason, reason, error.code);
  }
  assert.deepEqual(credentialFailure({ code: 'not_claimed' }), { leaseLost: true });
  const s = setup({ credentials: { failures: { facebook: { code: 'refresh_in_progress', retryable: true } } } });
  const d = s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post' });
  await s.tick();
  assert.equal(row(s, d).status, 'retrying');
  assert.equal(s.fakes.calls.length, 0);
  s.finish();
});

test('end to end with the real S94B credential module: a sealed Page token opens only for the fenced claim', async () => {
  const { openPublishingCredential } = await import('../../supabase/functions/_shared/integrations/credentials.mjs');
  const { importAesKey, encryptJson, credentialAad, resourceCredentialAad } = await import('../../supabase/functions/_shared/integrations/crypto.mjs');
  const kek = Buffer.alloc(32, 7).toString('base64');
  const key = await importAesKey(kek);
  const userSet = await encryptJson(key, { access_token: 'EAABuserTokenNotUsedForPages000111222', access_expires_at: null }, credentialAad('facebook', 'oauth_token'));
  const pageSet = await encryptJson(key, { access_token: TOKENS.facebook }, resourceCredentialAad('facebook', RESOURCES.facebook.id));
  const s = setup({ env: { ATLAS_INTEGRATION_KEK_V1: kek, ATLAS_INTEGRATION_KEK_CURRENT_VERSION: '1' } });
  const d = s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post' });
  const reads = [];
  const rpc = async (name, payload) => {
    if (name === 'atlas_integration_read_credential_for_delivery') {
      reads.push(payload);
      if (!s.db.isOwned(payload.p_delivery_id, payload.p_claim_token)) return { granted: false, reason: 'not_claimed' };
      return {
        granted: true,
        provider_key: 'facebook',
        credential: { ciphertext: userSet.ciphertextHex, nonce: userSet.nonceHex, key_version: 1, credential_kind: 'oauth_token' },
        resource: { ...RESOURCES.facebook, credential: { ciphertext: pageSet.ciphertextHex, nonce: pageSet.nonceHex, key_version: 1 } },
      };
    }
    return s.db.rpc(name, payload);
  };
  const handler = createPublisherHandler({ env: s.env, fetchImpl: s.fakes.fetchImpl, rpc, now: s.now, random: () => 0.5, credentials: { openPublishingCredential }, sleep: async () => {} });
  const res = await s.tick(handler);
  assert.equal(res.body.published, 1);
  assert.equal(row(s, d).status, 'published');
  assert.equal(reads.length, 1);
  assert.deepEqual(Object.keys(reads[0]).sort(), ['p_claim_token', 'p_delivery_id']);
  s.finish();
});

// ---- lost responses and verification ---------------------------------------------

test('T4 Instagram media_publish lost after it applied: verifying, then verified published (one publish)', async () => {
  const s = setup({ script: { 'ig.publish': ['lost'] } });
  const d = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  let res = await s.tick();
  assert.equal(res.body.verifying, 1);
  assert.equal(row(s, d).status, 'verifying');
  s.advance(61);
  res = await s.tick();
  assert.equal(res.body.published, 1);
  const r = row(s, d);
  assert.equal(r.published_source, 'verification');
  assert.equal(r.provider_post_id, s.fakes.published.instagram[0].id);
  assert.equal(s.fakes.count('ig.publish'), 1);
  assert.equal(s.fakes.published.instagram.length, 1);
  s.finish();
});

test('T5 Instagram media_publish lost before it applied: verified absent, retried with the same creation_id', async () => {
  const s = setup({ script: { 'ig.publish': ['drop'] } });
  const d = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  await s.tick();
  assert.equal(row(s, d).status, 'verifying');
  s.advance(61);
  await s.tick();
  assert.equal(row(s, d).status, 'retrying');
  s.advance(3600);
  await s.tick();
  assert.equal(row(s, d).status, 'published');
  const publishes = s.fakes.calls.filter((c) => c.op === 'ig.publish');
  assert.equal(publishes.length, 2);
  assert.equal(publishes[0].form.creation_id, publishes[1].form.creation_id);
  assert.equal(s.fakes.count('ig.media'), 1, 'no second container');
  assert.equal(s.fakes.published.instagram.length, 1);
  s.finish();
});

test('T7 Facebook feed timeout after the post exists: verified published, POST /feed once', async () => {
  const s = setup({ script: { 'fb.feed': ['lost'] } });
  const d = s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post' });
  await s.tick();
  assert.equal(row(s, d).status, 'verifying');
  s.advance(61);
  await s.tick();
  assert.equal(row(s, d).status, 'published');
  assert.equal(row(s, d).published_source, 'verification');
  assert.equal(s.fakes.count('fb.feed'), 1);
  assert.equal(s.fakes.published.facebook.length, 1);
  s.finish();
});

test('T8 Facebook post absent on two reads 2 minutes apart: one automatic retry; a second ambiguity needs attention', async () => {
  const s = setup({ script: { 'fb.feed': ['drop', 'timeout'] } });
  const d = s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post' });
  await s.tick();
  assert.equal(row(s, d).status, 'verifying');
  s.advance(61);
  await s.tick();
  assert.equal(row(s, d).status, 'verifying', 'one empty read is not proof');
  s.advance(121);
  await s.tick();
  assert.equal(row(s, d).status, 'retrying');
  assert.equal(row(s, d).progress.verify_retry_used, true);
  s.advance(3600);
  await s.tick();
  assert.equal(row(s, d).status, 'verifying', 'second post attempt timed out');
  s.advance(61);
  await s.tick();
  s.advance(121);
  await s.tick();
  assert.equal(row(s, d).status, 'needs_attention');
  assert.equal(row(s, d).attention_reason, 'outcome_unknown');
  assert.equal(s.fakes.count('fb.feed'), 2);
  assert.equal(s.fakes.published.facebook.length, 0);
  s.finish();
});

test('Facebook absent twice then the single retry succeeds', async () => {
  const s = setup({ script: { 'fb.feed': ['drop'] } });
  const d = s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post' });
  await s.tick();
  s.advance(61);
  await s.tick();
  s.advance(121);
  await s.tick();
  s.advance(3600);
  await s.tick();
  assert.equal(row(s, d).status, 'published');
  assert.equal(s.fakes.published.facebook.length, 1);
  s.finish();
});

test('Google lost create response: the list is matched before any retry (found -> adopted; absent -> one retry)', async () => {
  const found = setup({ script: { 'gbp.create': ['lost'] } });
  const d1 = found.db.add({ provider_key: 'google-business-profile', target_kind: 'gbp_local_post', caption: 'Happy hour 17-19' });
  await found.tick();
  assert.equal(row(found, d1).status, 'verifying');
  found.advance(61);
  await found.tick();
  assert.match(row(found, d1).provider_post_id, /localPosts/);
  found.advance(61);
  await found.tick();
  assert.equal(row(found, d1).status, 'published');
  assert.equal(found.fakes.count('gbp.create'), 1);
  assert.ok(found.fakes.count('gbp.list') >= 1);
  found.finish();

  const absent = setup({ script: { 'gbp.create': ['drop'] } });
  absent.fakes.world.gbpLiveAfter = 0;
  const d2 = absent.db.add({ provider_key: 'google-business-profile', target_kind: 'gbp_local_post', caption: 'Happy hour 17-19' });
  await absent.tick();
  absent.advance(61);
  await absent.tick();
  absent.advance(121);
  await absent.tick();
  assert.equal(row(absent, d2).status, 'retrying');
  const listsBeforeRetry = absent.fakes.count('gbp.list');
  assert.equal(listsBeforeRetry, 2);
  absent.advance(3600);
  await absent.tick();
  assert.equal(row(absent, d2).status, 'published');
  assert.equal(absent.fakes.count('gbp.create'), 2);
  assert.equal(absent.fakes.published['google-business-profile'].length, 1);
  absent.finish();
});

test('T6 TikTok lost init goes to needs_attention(outcome_unknown); init is never repeated', async () => {
  const s = setup({ script: { 'tt.inbox_init': ['lost'] } });
  const d = s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_inbox_video', media: [s.video(0)] });
  await s.tick();
  assert.equal(row(s, d).status, 'needs_attention');
  assert.equal(row(s, d).attention_reason, 'outcome_unknown');
  assert.equal(s.fakes.world.tiktokInits, 1);
  assert.equal(s.db.notifications.length, 1);
  s.advance(24 * 3600);
  await s.tick();
  assert.equal(s.fakes.world.tiktokInits, 1);
  s.finish();
});

test('an RPC failure right after TikTok init: the worker reports verifying; verify claims poll status and never re-init', async () => {
  const s = setup();
  const d = s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_inbox_video', media: [s.video(0)] });
  // The record_step after init fails (it was stored, the answer was lost).
  s.db.hooks.afterRpc = async (name, payload) => {
    if (name.endsWith('record_step') && payload.p_step?.step === 'init') {
      s.db.hooks.afterRpc = null;
      throw new Error('worker crashed');
    }
  };
  await s.tick();
  assert.equal(row(s, d).status, 'verifying');
  assert.ok(row(s, d).provider_publish_id);
  s.advance(61);
  await s.tick();
  assert.equal(s.fakes.count('tt.status'), 1, 'the verify claim reads the status of the known publish_id');
  assert.equal(row(s, d).status, 'verifying');
  s.advance(25 * 3600);
  await s.tick();
  assert.equal(row(s, d).status, 'needs_attention', 'no confirmation within a day');
  assert.equal(s.fakes.world.tiktokInits, 1);
  assert.ok(['verifying', 'needs_attention', 'published'].includes(row(s, d).status));
  assert.notEqual(row(s, d).status, 'retrying');
  s.finish();
});

// ---- concurrency, leases, gates ------------------------------------------------

test('T17 duplicate worker execution: two handlers at once claim disjoint rows and publish each target once', async () => {
  const s = setup();
  const ids = [
    s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] }),
    s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post' }),
    s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post', caption: 'Second post' }),
    s.db.add({ provider_key: 'google-business-profile', target_kind: 'gbp_local_post', caption: 'Brunch' }),
  ];
  const [a, b] = await Promise.all([s.tick(s.makeHandler()), s.tick(s.makeHandler())]);
  assert.equal(a.body.claimed + b.body.claimed, 4);
  for (const d of ids) assert.equal(s.db.attempts.filter((x) => x.delivery_id === d.id && x.claim_kind === 'publish').length, 1);
  assert.equal(s.fakes.published.instagram.length, 1);
  assert.equal(s.fakes.published.facebook.length, 2);
  assert.equal(s.fakes.published['google-business-profile'].length, 1);
  s.finish();
});

test('T9 lease lost after the submit call: the worker stops (no permalink read, no complete)', async () => {
  const s = setup();
  const d = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  s.db.hooks.afterRpc = async (name) => {
    if (name.endsWith('begin_submit')) s.db.stealLease(d.id);
  };
  const res = await s.tick();
  assert.equal(res.body.lease_lost, 1);
  assert.equal(s.fakes.count('ig.publish'), 1);
  assert.equal(s.fakes.count('ig.permalink'), 0);
  assert.equal(s.db.rpcLog.filter((e) => e.name.endsWith('complete')).length, 0);
  s.finish();
});

test('T10 lease lost before begin_submit: zero non-idempotent calls', async () => {
  const s = setup();
  s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post' });
  s.db.hooks.beforeRpc = async (name, payload) => {
    if (name.endsWith('begin_submit')) s.db.stealLease(payload.p_delivery_id);
  };
  const res = await s.tick();
  assert.equal(res.body.lease_lost, 1);
  assert.equal(s.fakes.count('fb.feed'), 0);
  s.finish();
});

test('T14 content edited between claim and submit: begin_submit refuses, no provider write, no complete', async () => {
  const s = setup();
  const d = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  s.db.hooks.beforeRpc = async (name, payload) => {
    if (name.endsWith('begin_submit')) s.db.deliveries.get(payload.p_delivery_id).gate.fingerprint_ok = false;
  };
  const res = await s.tick();
  assert.equal(res.body.refused, 1);
  assert.equal(row(s, d).status, 'cancelled');
  assert.equal(s.fakes.count('ig.publish'), 0);
  assert.equal(s.db.rpcLog.filter((e) => e.name.endsWith('complete')).length, 0);
  s.finish();
});

test('T13 stale schedule: no provider call (SQL claim guard, and the worker guard when a stale row is claimed)', async () => {
  for (const skipStaleGuard of [false, true]) {
    const s = setup({ db: { skipStaleGuard } });
    const due = new Date(START - 7 * 3600_000).toISOString();
    const d = s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post', due_at: due, latest_acceptable_at: new Date(START - 3600_000).toISOString() });
    await s.tick();
    assert.equal(row(s, d).status, 'needs_attention');
    assert.equal(row(s, d).attention_reason, 'stale_schedule');
    assert.equal(s.fakes.calls.length, 0);
    assert.equal(s.creds.opened.length, 0);
    s.finish();
  }
});

test('T15 work budget: a slow provider stops new claims before the deadline', async () => {
  const s = setup({ env: { ATLAS_PUBLISHER_BUDGET_MS: '20000' }, slowMs: 3000 });
  for (let i = 0; i < 6; i += 1) s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post', caption: `Post ${i}` });
  const res = await s.tick();
  assert.equal(s.db.rpcLog.filter((e) => e.name.endsWith('claim')).length, 1);
  assert.equal(res.body.claimed, 2);
  assert.equal([...s.db.deliveries.values()].filter((r) => r.status === 'queued').length, 4);
  assert.equal([...s.db.deliveries.values()].filter((r) => r.claim_token).length, 0, 'finished rows are released');
  s.finish();
});

// ---- provider readiness cases ------------------------------------------------------

test('TikTok unaudited (private only) or missing privacy option: needs_attention and no init', async () => {
  const s = setup();
  s.fakes.world.tiktokPrivacyOptions = ['SELF_ONLY'];
  const pub = s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_video', media: [s.video(0)], platform_options: { tiktok: { tiktok: { privacy_level: 'PUBLIC_TO_EVERYONE', consent_confirmed_at: '2026-10-01T10:00:00Z' } } } });
  const none = s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_video', media: [s.video(0)], platform_options: { tiktok: { tiktok: { consent_confirmed_at: '2026-10-01T10:00:00Z' } } } });
  await s.tick();
  assert.equal(row(s, pub).status, 'needs_attention');
  assert.equal(row(s, pub).last_error_code, 'tiktok_private_only');
  assert.equal(row(s, none).status, 'needs_attention');
  assert.equal(row(s, none).last_error_code, 'tiktok_privacy_missing');
  assert.equal(s.fakes.count('tt.init'), 0);
  assert.equal(s.fakes.world.tiktokInits, 0);
  s.finish();
});

test('TikTok video longer than the creator maximum fails before init', async () => {
  const s = setup();
  s.fakes.world.tiktokMaxDuration = 60;
  const d = s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_video', media: [s.video(0, { duration: 90_000 })], platform_options: { tiktok: { tiktok: { privacy_level: 'SELF_ONLY', consent_confirmed_at: '2026-10-01T10:00:00Z' } } } });
  await s.tick();
  assert.equal(row(s, d).status, 'failed');
  assert.equal(row(s, d).attention_reason, 'media_invalid');
  assert.equal(s.fakes.world.tiktokInits, 0);
  s.finish();
});

test('Google Business Profile with no usable location: needs_attention(no_resource), zero localPosts calls', async () => {
  for (const resource of [null, { kind: 'gbp_location', id: 'locations/222', label: 'VÁ' }]) {
    const s = setup({ credentials: { resources: { ...RESOURCES, 'google-business-profile': resource } } });
    const d = s.db.add({ provider_key: 'google-business-profile', target_kind: 'gbp_local_post', external_account_id: 'pending' });
    await s.tick();
    assert.equal(row(s, d).status, 'needs_attention');
    assert.equal(row(s, d).attention_reason, 'no_resource');
    assert.equal(s.fakes.calls.filter((c) => c.host === 'mybusiness.googleapis.com').length, 0);
    s.finish();
  }
});

test('SSRF: a provider upload URL outside the allowlist receives no bytes', async () => {
  const s = setup();
  s.fakes.world.tiktokUploadHost = 'https://uploads.evil.example';
  const d = s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_inbox_video', media: [s.video(0)] });
  await s.tick();
  assert.equal(row(s, d).status, 'needs_attention');
  assert.equal(row(s, d).last_error_code, 'upload_url_rejected');
  assert.equal(s.fakes.calls.filter((c) => c.host.includes('evil')).length, 0);
  s.finish();
});

test('missing media in Storage fails before any provider write', async () => {
  const s = setup();
  const img = s.image(0);
  s.fakes.world.storageObjects.delete(img.storage_path);
  const d = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [img] });
  await s.tick();
  assert.equal(row(s, d).status, 'failed');
  assert.equal(row(s, d).attention_reason, 'media_invalid');
  assert.equal(s.fakes.count('ig.media'), 0);
  s.finish();
});

test('Instagram refuses a non-JPEG photo before creating any container', async () => {
  const s = setup();
  const d = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0, { mime: 'image/png' })] });
  await s.tick();
  assert.equal(row(s, d).status, 'failed');
  assert.equal(row(s, d).last_error_code, 'ig_image_not_jpeg');
  assert.equal(s.fakes.count('ig.media'), 0);
  s.finish();
});

test('T17 no token or signed URL in any RPC payload, stored error, response or log (error bodies echo tokens)', async () => {
  const s = setup({
    script: {
      'ig.media': [steps.metaAuthExpired()],
      'fb.feed': [steps.metaError(400, 100)],
      'tt.inbox_init': [steps.tiktokError(400, 'invalid_param')],
      'gbp.create': [steps.googleError(400, 'INVALID_ARGUMENT')],
    },
  });
  s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_post' });
  s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_inbox_video', media: [s.video(0)] });
  s.db.add({ provider_key: 'google-business-profile', target_kind: 'gbp_local_post', media: [s.image(0, { size: 100_000 })] });
  await s.tick();
  const messages = [...s.db.deliveries.values()].map((r) => r.last_error_message).filter(Boolean);
  assert.equal(messages.length, 4);
  for (const message of messages) assert.ok(message.length <= 240);
  s.finish();
});

// ---- unit: http, classify, helpers -----------------------------------------------------

test('http client: allowlist, no redirects, IP literals and foreign hosts refused before fetch', async () => {
  const seen = [];
  const http = createHttp({
    fetchImpl: async (url) => {
      seen.push(url);
      return new Response('', { status: 302, headers: { location: 'https://evil.example/' } });
    },
    supabaseUrl: SUPABASE_URL,
  });
  for (const url of ['http://169.254.169.254/latest', 'https://evil.example/x', 'https://graph.facebook.com.evil.example/', 'https://user:pw@graph.facebook.com/', 'http://graph.facebook.com/', 'https://graph.facebook.com:8443/', 'https://branch.test/rest/v1/rpc/x']) {
    await assert.rejects(http.request(url), (error) => error instanceof HttpError && error.blocked, url);
  }
  assert.equal(seen.length, 0);
  await assert.rejects(http.request('https://graph.facebook.com/v25.0/me'), (error) => error.redirect === true);
  assert.throws(() => assertProviderUploadUrl('https://open-upload.tiktokapis.com.evil.example/x', 'tiktok'));
  assert.throws(() => assertProviderUploadUrl('http://open-upload.tiktokapis.com/x', 'tiktok'));
  assert.throws(() => assertProviderUploadUrl('https://10.0.0.1/x', 'tiktok'));
  assert.equal(assertProviderUploadUrl('https://open-upload.tiktokapis.com/video/?upload_id=1', 'tiktok').hostname, 'open-upload.tiktokapis.com');
  assert.equal(assertProviderUploadUrl('https://rupload.facebook.com/video-upload/v25.0/1', 'meta').hostname, 'rupload.facebook.com');
});

test('sanitizeMessage redacts tokens, bearer values and URLs and caps at 240 characters', () => {
  const text = sanitizeMessage(`bad token ${TOKENS.instagram} Bearer abc.def-123 at https://x.test/a?token=zzz access_token=qwertyuiop ${'x'.repeat(400)}`, [TOKENS.instagram]);
  assert.ok(!text.includes(TOKENS.instagram));
  assert.ok(!text.includes('abc.def-123'));
  assert.ok(!text.includes('https://'));
  assert.ok(!text.includes('qwertyuiop'));
  assert.ok(text.length <= 240);
});

test('classification before and after the submit marker', () => {
  const res = (status, json, headers = {}) => ({ status, json, header: (name) => headers[name] ?? null });
  assert.equal(outcomeFor(classifyResponse('instagram', res(500, null))).status, 'retrying');
  assert.equal(outcomeFor(classifyResponse('instagram', res(500, null), { afterSubmit: true }), { afterSubmit: true }).status, 'verifying');
  assert.equal(outcomeFor(classifyFailure(new HttpError('timeout', { network: true, timeout: true }), { afterSubmit: true }), { afterSubmit: true }).status, 'verifying');
  const rl = classifyResponse('tiktok', res(429, { error: { code: 'rate_limit_exceeded', message: 'slow' } }, { 'retry-after': '90' }), { afterSubmit: true });
  assert.equal(rl.definitive, true);
  const rlOut = outcomeFor(rl, { afterSubmit: true });
  assert.equal(rlOut.status, 'retrying');
  assert.equal(rlOut.retry_after_s, 90);
  assert.equal(rlOut.definitive, true);
  assert.equal(outcomeFor(classifyResponse('facebook', res(400, { error: { code: 190 } }))).attention_reason, 'auth_expired');
  assert.equal(outcomeFor(classifyResponse('google-business-profile', res(401, { error: { status: 'UNAUTHENTICATED' } }))).status, 'needs_attention');
  assert.equal(outcomeFor(classifyResponse('google-business-profile', res(503, { error: { status: 'UNAVAILABLE' } }), { afterSubmit: true }), { afterSubmit: true }).status, 'verifying');
  assert.equal(outcomeFor(classifyResponse('instagram', res(400, { error: { code: 100, error_subcode: 2207026 } }))).attention_reason, 'media_invalid');
  // Unknown 4xx shape after the marker is uncertain, never a blind retry.
  assert.equal(outcomeFor(classifyResponse('facebook', res(418, 'teapot'), { afterSubmit: true }), { afterSubmit: true }).status, 'verifying');
});

test('claim-kind coercion keeps outcomes inside the legal transition table', () => {
  assert.equal(coerceForClaim({ status: 'processing', poll_after_s: 60 }, 'verify').status, 'verifying');
  assert.equal(coerceForClaim({ status: 'failed', attention_reason: 'media_invalid', error: {} }, 'verify').status, 'needs_attention');
  assert.equal(coerceForClaim({ status: 'retrying', error: { class: 'transient' } }, 'verify').status, 'verifying');
  assert.equal(coerceForClaim({ status: 'retrying', definitive: true, error: { class: 'uncertain' } }, 'verify').status, 'retrying');
  assert.equal(coerceForClaim({ status: 'retrying', error: {} }, 'poll').status, 'processing');
  assert.equal(coerceForClaim({ status: 'retrying', error: {} }, 'publish').status, 'retrying');
});

test('helpers: TikTok upload plan, storage path allowlist, venue-local GBP schedule, claim normalisation', () => {
  assert.deepEqual(uploadPlan(3 * MIB, 16 * MIB), { video_size: 3 * MIB, chunk_size: 3 * MIB, total_chunk_count: 1, ranges: [[0, 3 * MIB - 1]] });
  const plan = uploadPlan(100 * MIB, 16 * MIB);
  assert.equal(plan.total_chunk_count, 6);
  assert.deepEqual(plan.ranges.at(-1), [80 * MIB, 100 * MIB - 1]);
  assert.ok(plan.ranges.at(-1)[1] - plan.ranges.at(-1)[0] + 1 <= 128 * MIB);
  assert.equal(isValidStoragePath(mediaPath(1)), true);
  assert.equal(isValidStoragePath('venues/main/2026/10/../../etc/passwd'), false);
  assert.equal(isValidStoragePath('https://evil.example/x.jpg'), false);
  assert.deepEqual(localParts('2026-10-03T20:00:00Z', 'Atlantic/Reykjavik'), { date: { year: 2026, month: 10, day: 3 }, time: { hours: 20, minutes: 0, seconds: 0, nanos: 0 } });
  assert.deepEqual(localParts('2026-10-03', 'Atlantic/Reykjavik'), { date: { year: 2026, month: 10, day: 3 }, time: null });
  const d = normalizeClaim({ claim_token: 't', claim_kind: 'publish', delivery: { id: 'x', provider_key: 'facebook' }, payload_snapshot: { caption: 'c', media: [{ position: 2 }, { position: 0 }], platform_options: { facebook: { link: 'https://vabar.is' } } } });
  assert.deepEqual(d.payload.media.map((m) => m.position), [0, 2]);
  assert.equal(d.payload.options.link, 'https://vabar.is');
});

// ---- source contracts ----------------------------------------------------------------

test('config.toml registers the worker with verify_jwt = false; index.ts stays thin', () => {
  const config = readFileSync('supabase/config.toml', 'utf8');
  assert.match(config, /\[functions\.atlas-marketing-publisher\]\nverify_jwt = false/);
  const index = readFileSync('supabase/functions/atlas-marketing-publisher/index.ts', 'utf8');
  assert.match(index, /createPublisherHandler\(/);
  assert.match(index, /openPublishingCredential/);
  assert.ok(index.split('\n').length < 60);
  assert.doesNotMatch(index, /access-control-allow-origin/i);
});

test('index.ts runs under the Edge harness: secret enforced before any network call', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    throw new Error(`unexpected ${url}`);
  };
  const unconfigured = await loadEdgeFunction('supabase/functions/atlas-marketing-publisher/index.ts', { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY });
  let res = await unconfigured(new Request('https://functions.test/atlas-marketing-publisher?action=tick', { method: 'POST', headers: { [SECRET_HEADER]: SECRET } }), fetchImpl);
  assert.equal(res.status, 503);
  const call = await loadEdgeFunction('supabase/functions/atlas-marketing-publisher/index.ts', { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ATLAS_MARKETING_PUBLISHER_SECRET: SECRET });
  res = await call(new Request('https://functions.test/atlas-marketing-publisher?action=tick', { method: 'POST', headers: { [SECRET_HEADER]: 'wrong' } }), fetchImpl);
  assert.equal(res.status, 401);
  res = await call(new Request('https://functions.test/atlas-marketing-publisher?action=tick', { method: 'GET' }), fetchImpl);
  assert.equal(res.status, 404);
  assert.deepEqual(seen, []);
  // With the right secret the default RPC goes to our own PostgREST only.
  const rpcCalls = [];
  res = await call(new Request('https://functions.test/atlas-marketing-publisher?action=tick', { method: 'POST', headers: { [SECRET_HEADER]: SECRET } }), async (url, init) => {
    rpcCalls.push({ url: String(url), auth: new Headers(init.headers).get('authorization') });
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(rpcCalls.map((c) => c.url), [`${SUPABASE_URL}/rest/v1/rpc/atlas_marketing_delivery_claim`]);
  assert.equal(rpcCalls[0].auth, `Bearer ${SERVICE_KEY}`);
  assert.deepEqual(await res.json(), { ok: true, claimed: 0, published: 0, processing: 0, retrying: 0, verifying: 0, needs_attention: 0, failed: 0, refused: 0, lease_lost: 0, errors: 0 });
});

test('publishing modules never log and never build provider URLs outside the allowlisted hosts', () => {
  for (const name of ['http', 'classify', 'media-urls', 'meta', 'instagram', 'facebook', 'tiktok', 'gbp', 'rules']) {
    const source = readFileSync(`supabase/functions/_shared/publishing/${name}.mjs`, 'utf8');
    assert.doesNotMatch(source, /console\./, `${name}.mjs logs`);
    for (const host of source.match(/https:\/\/[a-z0-9.-]+/g) ?? []) {
      if (!/^https:\/\/[a-z0-9-]+\./.test(host)) continue;
      assert.ok(/(graph\.facebook\.com|rupload\.facebook\.com|www\.facebook\.com|open\.tiktokapis\.com|open-upload\.tiktokapis\.com|mybusiness\.googleapis\.com|mybusinessbusinessinformation\.googleapis\.com|graph-video\.facebook\.com)$/.test(host), `${name}.mjs references ${host}`);
    }
  }
});

// ---- review fixes: auth marking, media uses, upload budget, Facebook video verify ----

test('security P2-1: a provider auth failure marks the connection through the fenced RPC before complete()', async () => {
  const s = setup({ script: { 'ig.media': [steps.metaAuthExpired()] }, credentials: { failures: { 'google-business-profile': { code: 'needs_reauthorization', reauthorize: true } } } });
  const ig = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [s.image(0)] });
  const g = s.db.add({ provider_key: 'google-business-profile', target_kind: 'gbp_local_post' });
  await s.tick();
  assert.equal(row(s, ig).attention_reason, 'auth_expired');
  assert.deepEqual(s.db.authFailures.map((f) => f.delivery_id), [ig.id], 'only the provider refusal marks the connection (the credential failure already reflects it)');
  const log = s.db.rpcLog;
  const mark = log.findIndex((e) => e.name === 'atlas_integration_mark_auth_failed');
  const complete = log.findIndex((e) => e.name === 'atlas_marketing_delivery_complete' && e.payload.p_delivery_id === ig.id);
  assert.ok(mark >= 0 && mark < complete, 'marked while the claim is live, before complete releases it');
  const claimToken = log[complete].payload.p_claim_token;
  assert.equal(log[mark].payload.p_claim_token, claimToken, 'fenced on the same claim');
  assert.ok(log[mark].payload.p_error && !log[mark].payload.p_error.includes(TOKENS.instagram));
  assert.ok(!s.db.authFailures.some((f) => f.delivery_id === g.id));
  s.finish();
});

test('P2 media uses: a published or processing delivery records each media item once per reach (no URLs)', async () => {
  const s = setup({ env: { ATLAS_PUBLISHER_TIKTOK_CHUNK_BYTES: String(5 * MIB) } });
  s.fakes.world.tiktokCompleteAfter = 2;
  const photo = s.image(0);
  const ig = s.db.add({ provider_key: 'instagram', target_kind: 'ig_feed', media: [photo] });
  const clip = s.video(0, { size: 3 * MIB });
  const tt = s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_inbox_video', media: [clip] });
  await s.tick();
  assert.equal(row(s, ig).status, 'published');
  assert.equal(row(s, tt).status, 'processing');
  const igUse = s.db.mediaUses.find((u) => u.platform === 'instagram');
  assert.deepEqual(
    { asset_id: igUse.asset_id, content_id: igUse.content_id, outcome: igUse.outcome, fetch_method: igUse.fetch_method, job: igUse.publication_job_id, media: igUse.provider_media_id },
    { asset_id: photo.asset_id, content_id: row(s, ig).content_id, outcome: 'published', fetch_method: 'signed_url', job: ig.id, media: row(s, ig).provider_post_id },
  );
  assert.deepEqual(s.db.mediaUses.filter((u) => u.platform === 'tiktok').map((u) => [u.asset_id, u.outcome, u.fetch_method]), [[clip.asset_id, 'processing', 'file_upload']]);
  s.advance(31);
  await s.tick();
  assert.equal(row(s, tt).status, 'processing', 'still processing after the first poll');
  assert.equal(s.db.mediaUses.filter((u) => u.platform === 'tiktok').length, 1, 'a poll that stays processing records nothing new');
  s.advance(61);
  await s.tick();
  assert.equal(row(s, tt).status, 'published');
  assert.deepEqual(s.db.mediaUses.filter((u) => u.platform === 'tiktok').map((u) => u.outcome), ['processing', 'published']);
  assertNoLeak('media uses', s.db.mediaUses);
  assert.ok(!JSON.stringify(s.db.mediaUses).includes('https://'));
  s.finish();
});

test('P3 TikTok upload budget counts from the upload start: a second upload in the same run is not cut short', async () => {
  const s = setup({ env: { ATLAS_PUBLISHER_TIKTOK_CHUNK_BYTES: String(5 * MIB), ATLAS_PUBLISHER_UPLOAD_BUDGET_MS: '30000' }, slowMs: 3000 });
  const a = s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_inbox_video', media: [s.video(0, { size: 12 * MIB })] });
  const b = s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_inbox_video', media: [s.video(0, { size: 12 * MIB })] });
  await s.tick();
  for (const d of [a, b]) {
    const publish = s.fakes.world.tiktokPublishes.get(row(s, d).provider_publish_id);
    assert.ok(publish, 'init sent');
    assert.equal(publish.received, publish.size, 'every chunk uploaded');
    assert.equal(row(s, d).status, 'processing');
  }
  assert.equal(s.fakes.count('tt.upload'), 4);
  assert.ok(!s.db.attempts.some((attempt) => attempt.steps.some((step) => step.code === 'upload_budget_exhausted')));
  s.finish();
});

test('P3 TikTok: an upload that could not get enough of the run is not started (no init; retried later)', async () => {
  const s = setup({ env: { ATLAS_PUBLISHER_TIKTOK_CHUNK_BYTES: String(5 * MIB), ATLAS_PUBLISHER_WALL_BUDGET_MS: '60000' }, slowMs: 25_000 });
  const d = s.db.add({ provider_key: 'tiktok', target_kind: 'tiktok_inbox_video', media: [s.video(0, { size: 3 * MIB })] });
  await s.tick();
  assert.equal(s.fakes.count('tt.inbox_init'), 0, 'nothing non-idempotent was sent');
  assert.equal(row(s, d).status, 'retrying');
  assert.equal(row(s, d).last_error_code, 'upload_deferred');
  assert.equal(row(s, d).phase, 'none');
  s.finish();
});

test('P2 Facebook page video: empty published_posts reads are not proof of absence (never re-posted)', async () => {
  const s = setup({ script: { 'fb.videos': ['drop'] } });
  const d = s.db.add({ provider_key: 'facebook', target_kind: 'fb_page_video', media: [s.video(0, { width: 1920, height: 1080 })] });
  await s.tick();
  assert.equal(row(s, d).status, 'verifying');
  const seen = [];
  for (let i = 0; i < 6 && row(s, d).status === 'verifying'; i += 1) {
    s.advance(301);
    await s.tick();
    seen.push(row(s, d).status);
  }
  assert.ok(!seen.includes('retrying'), `statuses: ${seen.join(',')}`);
  assert.equal(row(s, d).status, 'needs_attention');
  assert.equal(row(s, d).attention_reason, 'outcome_unknown');
  assert.equal(s.fakes.count('fb.videos'), 1, 'POST /videos is sent once');
  s.finish();
});
