// S98 Atlas Training gateway (supabase/functions/atlas-training): every request is
// authenticated server-side; storage paths never reach the browser; upload is a signed
// URL (video bytes never traverse the function); playback is a short-lived signed URL;
// DB errors are redacted by hint; retire is manager-gated at the gateway.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTrainingHandler, createServices, mapRpcError, stripPaths, MESSAGES, BUCKET,
} from '../../supabase/functions/atlas-training/handler.mjs';

const ADMIN = { userId: '11111111-1111-4111-8111-111111111111', role: 'admin', active: true, label: 'Admin' };
const MANAGER = { userId: '22222222-2222-4222-8222-222222222222', role: 'manager', active: true, label: 'Manager' };
const BARTENDER = { userId: '33333333-3333-4333-8333-333333333333', role: 'bartender', active: true, label: 'Bar' };
const ARTICLE = '44444444-4444-4444-8444-444444444444';
const VERSION = '55555555-5555-4555-8555-555555555555';
const MEDIA = '66666666-6666-4666-8666-666666666666';
const PATH = 'lessons/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4';

function fakeServices(overrides = {}) {
  const calls = { rpc: [], signUpload: [], sign: [], objectInfo: [] };
  return {
    calls,
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      if (overrides.rpc) { const v = await overrides.rpc(name, args); if (v !== undefined) return v; }
      switch (name) {
        case 'atlas_training_snapshot': return { lessons: [], permissions: { can_manage_training: true }, actor_role: args.p_actor_role };
        case 'atlas_training_lesson':
        case 'atlas_training_start':
          return { article: { id: ARTICLE }, version: { id: VERSION, state: 'published' },
            media: { id: MEDIA, upload_status: 'stored', storage_path: PATH, bucket_id: BUCKET }, chapters: [], steps: [], progress: null };
        case 'atlas_training_reserve_media': return { media: { id: MEDIA, upload_status: 'pending', storage_path: PATH }, storage_path: PATH };
        case 'atlas_training_finalize_media': return { media: { id: MEDIA, upload_status: 'stored', storage_path: PATH } };
        case 'atlas_training_save_draft': return { article_id: ARTICLE, version_id: VERSION };
        case 'atlas_training_attach_media': return { article_id: ARTICLE, version_id: VERSION, media_asset_id: MEDIA };
        case 'atlas_training_publish': return { article_id: ARTICLE, version_id: VERSION };
        case 'atlas_training_playback_path': return PATH;
        case 'atlas_training_save_progress': return { ok: true };
        case 'atlas_training_complete': return { completion_state: 'completed', completed_at: '2026-09-28T00:00:00Z', replayed: false };
        case 'atlas_training_completion_report': return { article_id: ARTICLE, assigned: 3, completed: 1, outstanding: 2, staff: [] };
        case 'atlas_knowledge_retire': return { ok: true };
        default: return {};
      }
    },
    async signUpload(path) { calls.signUpload.push(path); return { url: `https://fn.test/storage/v1/object/upload/sign/${BUCKET}/${path}?token=up`, token: 'up-token' }; },
    async sign(path, seconds) { calls.sign.push({ path, seconds }); return `https://fn.test/storage/v1/object/sign/${BUCKET}/${path}?token=play`; },
    async objectInfo(path) { calls.objectInfo.push(path); return ('objectInfo' in overrides) ? overrides.objectInfo : { size: 1048576, mime: 'video/mp4' }; },
  };
}

function handlerFor({ actor = MANAGER, services } = {}) {
  const svc = services ?? fakeServices();
  const handle = createTrainingHandler({ env: () => undefined, fetchImpl: async () => { throw new Error('no network'); }, resolveActor: async () => actor, services: svc });
  return { handle, svc };
}
const get = (action, params = {}) => new Request(`https://fn.test/atlas-training?${new URLSearchParams({ action, ...params })}`, { headers: { authorization: 'Bearer t' } });
const post = (action, bodyObj) => new Request(`https://fn.test/atlas-training?action=${action}`, {
  method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(bodyObj),
});
const read = async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) });

test('OPTIONS is a CORS preflight', async () => {
  const { handle } = handlerFor();
  const r = await handle(new Request('https://fn.test/atlas-training', { method: 'OPTIONS' }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('unknown action is 404; a PUT is 405', async () => {
  const { handle } = handlerFor();
  assert.equal((await read(await handle(get('nope')))).status, 404);
  const put = new Request('https://fn.test/atlas-training?action=snapshot', { method: 'PUT', headers: { authorization: 'Bearer t' } });
  assert.equal((await read(await handle(put))).status, 405);
});

test('snapshot passes the resolved actor to the RPC (never a browser-sent id)', async () => {
  const { handle, svc } = handlerFor({ actor: BARTENDER });
  const { status, json } = await read(await handle(get('snapshot')));
  assert.equal(status, 200);
  const call = svc.calls.rpc.find((c) => c.name === 'atlas_training_snapshot');
  assert.equal(call.args.p_actor_id, BARTENDER.userId);
  assert.equal(call.args.p_actor_role, 'bartender');
  assert.ok('lessons' in json);
});

test('a lesson response never carries a storage path or bucket id', async () => {
  const { handle } = handlerFor();
  const { json } = await read(await handle(get('lesson', { article_id: ARTICLE })));
  assert.ok(json.media, 'media present');
  assert.equal(json.media.storage_path, undefined, 'storage_path stripped');
  assert.equal(json.media.bucket_id, undefined, 'bucket_id stripped');
  assert.equal(json.media.id, MEDIA);
});

test('reserve-media signs an upload URL and returns the opaque path for finalize', async () => {
  const { handle, svc } = handlerFor();
  const { status, json } = await read(await handle(post('reserve-media', {
    client_request_id: '77777777-7777-4777-8777-777777777777', mime_type: 'video/mp4', declared_bytes: 1048576, original_filename: 'v.mp4',
  })));
  assert.equal(status, 200);
  assert.equal(svc.calls.signUpload[0], PATH);
  assert.ok(json.upload.url.includes('upload/sign'));
  assert.equal(json.upload.token, 'up-token');
  assert.equal(json.upload.path, PATH);
});

test('finalize-media measures the real object and forwards it to the RPC', async () => {
  const { handle, svc } = handlerFor();
  const { status } = await read(await handle(post('finalize-media', { media_id: MEDIA, path: PATH, duration_seconds: 120 })));
  assert.equal(status, 200);
  assert.deepEqual(svc.calls.objectInfo, [PATH]);
  const call = svc.calls.rpc.find((c) => c.name === 'atlas_training_finalize_media');
  assert.equal(call.args.p_object.byte_size, 1048576);
  assert.equal(call.args.p_object.duration_seconds, 120);
});

test('finalize-media fails closed when the object has not finished uploading', async () => {
  const svc = fakeServices({ objectInfo: null });
  const { handle } = handlerFor({ services: svc });
  const { status } = await read(await handle(post('finalize-media', { media_id: MEDIA, path: PATH })));
  assert.equal(status, 400);
});

test('save-draft forwards the payload to the RPC', async () => {
  const { handle, svc } = handlerFor();
  const { status, json } = await read(await handle(post('save-draft', { title: 'Opening', content: '# steps', category_id: ARTICLE, target_roles: ['bartender'] })));
  assert.equal(status, 200);
  assert.equal(json.article_id, ARTICLE);
  const call = svc.calls.rpc.find((c) => c.name === 'atlas_training_save_draft');
  assert.equal(call.args.p_actor_id, MANAGER.userId);
  assert.ok(call.args.p_payload);
});

test('playback returns a short-lived signed URL (300s), never a path', async () => {
  const { handle, svc } = handlerFor();
  const { status, json } = await read(await handle(post('playback', { article_id: ARTICLE, version_id: VERSION })));
  assert.equal(status, 200);
  assert.equal(svc.calls.sign[0].seconds, 300);
  assert.equal(json.expires_in, 300);
  assert.ok(json.url.includes('/object/sign/'));
  assert.equal(json.storage_path, undefined);
});

test('start returns the lesson with paths stripped', async () => {
  const { handle } = handlerFor({ actor: BARTENDER });
  const { status, json } = await read(await handle(post('start', { article_id: ARTICLE, version_id: VERSION })));
  assert.equal(status, 200);
  assert.equal(json.media.storage_path, undefined);
});

test('complete passes through the version-specific result', async () => {
  const { handle } = handlerFor({ actor: BARTENDER });
  const { status, json } = await read(await handle(post('complete', { article_id: ARTICLE, version_id: VERSION })));
  assert.equal(status, 200);
  assert.equal(json.completion_state, 'completed');
});

test('retire is manager-gated at the gateway and needs a reason', async () => {
  const bar = handlerFor({ actor: BARTENDER });
  assert.equal((await read(await bar.handle(post('retire', { article_id: ARTICLE, reason: 'x' })))).status, 403);
  assert.equal(bar.svc.calls.rpc.filter((c) => c.name === 'atlas_knowledge_retire').length, 0);
  const mgr = handlerFor({ actor: MANAGER });
  assert.equal((await read(await mgr.handle(post('retire', { article_id: ARTICLE, reason: '' })))).status, 400);
});

test('mapRpcError redacts by hint to the right status', () => {
  assert.equal(mapRpcError(400, { hint: 'atlas:forbidden' }).status, 403);
  assert.equal(mapRpcError(400, { hint: 'atlas:not_found' }).status, 404);
  assert.equal(mapRpcError(400, { hint: 'atlas:conflict' }).status, 409);
  assert.equal(mapRpcError(400, { hint: 'atlas:too_large' }).status, 400);
});

test('stripPaths removes every path-bearing key at any depth', () => {
  const cleaned = stripPaths({ media: { id: 'x', storage_path: 'p', bucket_id: 'b' }, nested: [{ thumb_path: 'q' }] });
  assert.equal(cleaned.media.storage_path, undefined);
  assert.equal(cleaned.media.bucket_id, undefined);
  assert.equal(cleaned.nested[0].thumb_path, undefined);
  assert.equal(cleaned.media.id, 'x');
});
