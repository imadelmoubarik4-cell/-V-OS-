// S94A Marketing Media gateway (supabase/functions/atlas-marketing-media).
// The handler runs with an injected fetch that fakes Auth, the service-role
// RPCs (an in-memory mirror of the SQL rules, incl. the role re-check) and
// Storage (signed upload tokens, batch signing, ranged reads, deletes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BUCKET,
  LIMITS,
  classifyUpload,
  createMarketingMediaHandler,
  imageDimensions,
  mapRpcError,
  parseMoov,
  sniffType,
  stripPaths,
  withSignedUrls,
} from '../../supabase/functions/atlas-marketing-media/handler.mjs';
import {
  JPEG_12x8_BASE64,
  MP4_1080x1920_24s_BASE64,
  PDF_BASE64,
  PNG_8x8_BASE64,
  SVG_BASE64,
  bytes,
} from '../fixtures/s94/media-fixtures.mjs';

const SUPABASE = 'https://abcdefghijklmnopqrst.supabase.co';
const SERVICE_KEY = 'service-role-secret-key-s94a-do-not-leak';
const PUBLISHABLE = 'sb_publishable_s94a';
const MIB = 1024 * 1024;
const NOW = Date.parse('2026-09-24T14:00:00Z');
const ENV = {
  SUPABASE_URL: SUPABASE,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  ATLAS_AUTH_PROJECT_URL: SUPABASE,
  ATLAS_AUTH_PUBLISHABLE_KEY: PUBLISHABLE,
};
const USERS = {
  'tok-admin': { id: '00000000-0000-4000-8000-0000000000a1', role: 'admin', active: true, display_name: 'Ada Admin' },
  'tok-manager': { id: '00000000-0000-4000-8000-0000000000a2', role: 'manager', active: true, display_name: 'Maria Manager' },
  'tok-bartender': { id: '00000000-0000-4000-8000-0000000000a3', role: 'bartender', active: true, display_name: 'Bo Bartender' },
  'tok-viewer': { id: '00000000-0000-4000-8000-0000000000a4', role: 'viewer', active: true, display_name: 'Vi Viewer' },
  'tok-gone': { id: '00000000-0000-4000-8000-0000000000a5', role: 'manager', active: false, display_name: 'Gone Manager' },
};
const PROFILE_BY_ID = Object.fromEntries(Object.values(USERS).map((user) => [user.id, user]));
let counter = 0;
const uuid = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};
const PATH_RE = /^venues\/main\/\d{4}\/\d{2}\/[0-9a-f-]{36}\/(original|v\/[0-9a-f-]{36})\.(jpg|png|webp|heic|heif|mp4|mov)$/;

class RpcError extends Error {
  constructor(code, hint, details = null) {
    super(hint);
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

// In-memory mirror of the SQL rules the gateway relies on.
function fakeBackend({ rangeSupported = true } = {}) {
  const assets = new Map();
  const variants = new Map();
  const objects = new Map();
  const collections = new Map();
  const calls = [];
  const signed = [];
  const uploads = [];
  const removed = [];
  const pinned = new Map();

  const manager = (actorId) => {
    const profile = PROFILE_BY_ID[actorId];
    if (!profile || !profile.active || !['admin', 'manager'].includes(profile.role)) throw new RpcError('42501', 'atlas:forbidden');
    return profile;
  };
  const assetJson = (asset, full = false) => {
    const thumb = [...variants.values()].find((v) => v.asset_id === asset.id && v.purpose === 'thumb' && v.status === 'ready');
    const base = {
      id: asset.id, kind: asset.kind, status: asset.status, name: asset.title || asset.original_filename || 'Photo',
      title: asset.title ?? null, original_filename: asset.original_filename, mime_type: asset.mime_type ?? asset.declared_mime,
      byte_size: asset.byte_size ?? asset.declared_bytes, width: asset.width ?? null, height: asset.height ?? null,
      duration_ms: asset.duration_ms ?? null, rotation: asset.rotation ?? null, alt_text: asset.alt_text ?? null, tags: asset.tags ?? [],
      focal_point: asset.focal_point ?? null, trim: asset.trim ?? null, sha256: asset.sha256 ?? null,
      thumb_path: thumb?.storage_path ?? (asset.kind === 'image' && asset.status === 'ready' ? asset.storage_path : null),
      used_count: 0, delete_block: pinned.get(asset.id) ?? null, uploaded_by_label: 'Team member',
    };
    if (!full) return base;
    return { ...base, storage_path: asset.storage_path, publish_variant_id: null,
      variants: [...variants.values()].filter((v) => v.asset_id === asset.id && v.status === 'ready').map((v) => ({ id: v.id, purpose: v.purpose, storage_path: v.storage_path, status: v.status })),
      collections: [], used_in: [] };
  };
  const collectionJson = (collection) => ({
    id: collection.id, name: collection.name, count: collection.asset_ids.length, asset_ids: [...collection.asset_ids],
    items: collection.asset_ids.map((id, position) => ({ asset_id: id, position, thumb_path: assets.get(id)?.storage_path ?? null })),
  });

  const rpcs = {
    atlas_marketing_media_list({ p_actor_id, p_filters }) {
      manager(p_actor_id);
      const rows = [...assets.values()].filter((a) => a.status === 'ready' && (!p_filters.kind || a.kind === p_filters.kind));
      return { assets: rows.map((a) => assetJson(a)), total: rows.length, next_cursor: null, tags: [], counts: {}, filters_seen: p_filters };
    },
    atlas_marketing_media_get({ p_actor_id, p_asset_id }) {
      manager(p_actor_id);
      const asset = assets.get(p_asset_id);
      if (!asset) throw new RpcError('P0002', 'atlas:not_found');
      return assetJson(asset, true);
    },
    atlas_marketing_media_reserve({ p_actor_id, p_request }) {
      const profile = manager(p_actor_id);
      const existing = [...assets.values()].find((a) => a.client_request_id === p_request.client_request_id);
      if (existing) {
        if (existing.uploaded_by !== profile.id) throw new RpcError('23505', 'atlas:conflict');
        return { asset: assetJson(existing), storage_path: existing.storage_path, replayed: true };
      }
      const id = uuid();
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'video/mp4': 'mp4', 'video/quicktime': 'mov' }[p_request.mime_type];
      if (!ext) throw new RpcError('22023', 'atlas:unsupported_type');
      const asset = {
        id, client_request_id: p_request.client_request_id, kind: p_request.kind, status: 'pending_upload',
        storage_path: `venues/main/2026/09/${id}/original.${ext}`, declared_mime: p_request.mime_type, declared_bytes: p_request.byte_size,
        original_filename: p_request.original_filename, uploaded_by: profile.id, request: p_request,
      };
      assets.set(id, asset);
      return { asset: assetJson(asset), storage_path: asset.storage_path, replayed: false };
    },
    atlas_marketing_media_upload_state({ p_actor_id, p_asset_id, p_variant_id }) {
      manager(p_actor_id);
      const row = p_variant_id ? variants.get(p_variant_id) : assets.get(p_asset_id);
      if (!row) throw new RpcError('P0002', 'atlas:not_found');
      const object = objects.get(row.storage_path);
      return {
        status: row.status, kind: p_variant_id ? 'image' : row.kind, declared_mime: row.declared_mime, declared_bytes: row.declared_bytes,
        storage_path: row.storage_path, object: object ? { size: object.byteLength, mimetype: row.declared_mime } : null,
      };
    },
    atlas_marketing_media_complete({ p_actor_id, p_asset_id, p_result }) {
      manager(p_actor_id);
      const asset = assets.get(p_asset_id);
      if (asset.status === 'ready') return { asset: assetJson(asset), replayed: true };
      if (p_result.outcome === 'rejected') {
        Object.assign(asset, { status: 'rejected', reject_reason: p_result.reject_reason });
        return { asset: assetJson(asset), storage_path: asset.storage_path };
      }
      const object = objects.get(asset.storage_path);
      if (!object) throw new RpcError('22023', 'atlas:upload_missing');
      if (object.byteLength !== asset.declared_bytes || p_result.byte_size !== asset.declared_bytes) throw new RpcError('22023', 'atlas:size_mismatch');
      Object.assign(asset, { status: 'ready', mime_type: p_result.mime_type, byte_size: p_result.byte_size, width: p_result.width,
        height: p_result.height, duration_ms: p_result.duration_ms ?? null, rotation: p_result.rotation ?? null, sha256: p_result.sha256 ?? null,
        has_audio: p_result.has_audio ?? null, server_probe: p_result.server_probe });
      return { asset: assetJson(asset), replayed: false };
    },
    atlas_marketing_media_abandon({ p_actor_id, p_asset_id }) {
      manager(p_actor_id);
      const asset = assets.get(p_asset_id);
      asset.status = 'abandoned';
      return { asset_id: asset.id, status: 'abandoned', storage_path: asset.storage_path };
    },
    atlas_marketing_media_reserve_variant({ p_actor_id, p_request }) {
      const profile = manager(p_actor_id);
      const asset = assets.get(p_request.asset_id);
      if (!asset) throw new RpcError('P0002', 'atlas:not_found');
      const id = uuid();
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[p_request.mime_type];
      const variant = { id, asset_id: asset.id, purpose: p_request.purpose, status: 'pending_upload', declared_mime: p_request.mime_type,
        declared_bytes: p_request.byte_size, storage_path: asset.storage_path.replace(/original\.[a-z0-9]+$/, `v/${id}.${ext}`), created_by: profile.id, request: p_request };
      variants.set(id, variant);
      return { variant: { id, purpose: variant.purpose, status: variant.status, storage_path: variant.storage_path }, storage_path: variant.storage_path, replayed: false };
    },
    atlas_marketing_media_complete_variant({ p_actor_id, p_variant_id, p_result }) {
      manager(p_actor_id);
      const variant = variants.get(p_variant_id);
      if (variant.status === 'ready') return { variant: { id: variant.id, status: 'ready', storage_path: variant.storage_path }, replayed: true };
      if (p_result.outcome === 'rejected') { variant.status = 'rejected'; return { variant: { id: variant.id, status: 'rejected' } }; }
      Object.assign(variant, { status: 'ready', mime_type: p_result.mime_type, width: p_result.width, height: p_result.height });
      return { variant: { id: variant.id, purpose: variant.purpose, status: 'ready', width: variant.width, height: variant.height, storage_path: variant.storage_path }, replayed: false };
    },
    atlas_marketing_media_update({ p_actor_id, p_asset_id, p_patch }) {
      manager(p_actor_id);
      const asset = assets.get(p_asset_id);
      if (!asset) throw new RpcError('P0002', 'atlas:not_found');
      Object.assign(asset, p_patch, p_patch.tags ? { tags: p_patch.tags.map((label) => ({ slug: label.toLowerCase(), label })) } : {});
      return assetJson(asset, true);
    },
    atlas_marketing_media_lifecycle({ p_actor_id, p_asset_id, p_action }) {
      manager(p_actor_id);
      const asset = assets.get(p_asset_id);
      if (p_action === 'delete' && pinned.has(p_asset_id)) throw new RpcError('22023', 'atlas:in_use', JSON.stringify(pinned.get(p_asset_id)));
      if (p_action === 'delete') asset.status = 'deleted';
      if (p_action === 'archive') asset.archived_at = new Date(NOW).toISOString();
      return { asset: assetJson(asset), detached: 0 };
    },
    atlas_marketing_media_collections({ p_actor_id }) {
      manager(p_actor_id);
      return { collections: [...collections.values()].map(collectionJson) };
    },
    atlas_marketing_media_collection_upsert({ p_actor_id, p_collection }) {
      manager(p_actor_id);
      const collection = p_collection.id ? collections.get(p_collection.id) : { id: uuid(), name: p_collection.name, asset_ids: [] };
      if (p_collection.asset_ids) collection.asset_ids = [...p_collection.asset_ids];
      collections.set(collection.id, collection);
      return collectionJson(collection);
    },
    atlas_marketing_media_collection_reorder({ p_actor_id, p_collection_id, p_asset_ids }) {
      manager(p_actor_id);
      const collection = collections.get(p_collection_id);
      if ([...p_asset_ids].sort().join() !== [...collection.asset_ids].sort().join() || new Set(p_asset_ids).size !== p_asset_ids.length) {
        throw new RpcError('22023', 'atlas:invalid_request');
      }
      collection.asset_ids = [...p_asset_ids];
      return collectionJson(collection);
    },
    atlas_marketing_media_collection_archive({ p_actor_id, p_collection_id }) {
      manager(p_actor_id);
      return collectionJson(collections.get(p_collection_id));
    },
    atlas_marketing_media_maintenance_candidates({ p_actor_id }) {
      if (manager(p_actor_id).role !== 'admin') throw new RpcError('42501', 'atlas:forbidden');
      return {
        assets: [...assets.values()].filter((a) => ['abandoned', 'rejected'].includes(a.status)).map((a) => ({ asset_id: a.id, paths: [a.storage_path] })),
        variants: [],
      };
    },
    atlas_marketing_media_purge_confirm({ p_actor_id, p_asset_ids }) {
      if (manager(p_actor_id).role !== 'admin') throw new RpcError('42501', 'atlas:forbidden');
      for (const id of p_asset_ids) assets.delete(id);
      return { assets: p_asset_ids.length, variants: 0 };
    },
  };

  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    if (url.origin !== SUPABASE) throw new Error(`Unexpected request ${url}`);
    if (url.pathname === '/auth/v1/user') {
      const token = (headers.get('authorization') || '').replace(/^Bearer /, '');
      assert.equal(headers.get('apikey'), PUBLISHABLE);
      const user = USERS[token];
      return user ? json({ id: user.id }) : json({ message: 'bad jwt' }, 401);
    }
    if (url.pathname === '/rest/v1/profiles') {
      const id = url.searchParams.get('id').replace(/^eq\./, '');
      const profile = PROFILE_BY_ID[id];
      return json(profile ? [{ ...profile, email: `${profile.role}@example.invalid` }] : []);
    }
    // Every service-role call carries the key in headers only.
    assert.equal(headers.get('apikey'), SERVICE_KEY);
    assert.equal(headers.get('authorization'), `Bearer ${SERVICE_KEY}`);
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.slice('/rest/v1/rpc/'.length);
      const args = JSON.parse(init.body || '{}');
      calls.push({ name, args });
      const fn = rpcs[name];
      if (!fn) throw new Error(`Unexpected rpc ${name}`);
      try {
        return json(fn(args));
      } catch (error) {
        if (error instanceof RpcError) return json({ code: error.code, message: 'database text that must not leak', hint: error.hint, details: error.details }, 400);
        throw error;
      }
    }
    const prefix = `/storage/v1/object/upload/sign/${BUCKET}/`;
    if (method === 'POST' && url.pathname.startsWith(prefix)) {
      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      assert.match(path, PATH_RE);
      assert.equal(headers.get('x-upsert'), null, 'never upsert');
      const token = `upload-token-${uploads.length + 1}`;
      uploads.push({ path, token });
      return json({ url: `/object/upload/sign/${BUCKET}/${path}?token=${token}` });
    }
    if (method === 'POST' && url.pathname === `/storage/v1/object/sign/${BUCKET}`) {
      const body = JSON.parse(init.body);
      signed.push({ expiresIn: body.expiresIn, paths: body.paths });
      return json(body.paths.map((path) => ({ path, error: null, signedURL: `/object/sign/${BUCKET}/${path}?token=read-${body.expiresIn}` })));
    }
    const readPrefix = `/storage/v1/object/authenticated/${BUCKET}/`;
    if (method === 'GET' && url.pathname.startsWith(readPrefix)) {
      const path = decodeURIComponent(url.pathname.slice(readPrefix.length));
      const data = objects.get(path);
      if (!data) return json({ error: 'not found' }, 404);
      const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get('range') || '');
      if (rangeSupported && match) {
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), data.byteLength - 1);
        return new Response(data.slice(start, end + 1), { status: 206 });
      }
      return new Response(data, { status: 200 });
    }
    if (method === 'DELETE' && url.pathname === `/storage/v1/object/${BUCKET}`) {
      const { prefixes } = JSON.parse(init.body);
      for (const path of prefixes) { objects.delete(path); removed.push(path); }
      return json(prefixes.map((name) => ({ name })));
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  }
  return { fetchImpl, assets, variants, objects, collections, calls, signed, uploads, removed, pinned };
}

function harness(options = {}) {
  const backend = fakeBackend(options);
  const handle = createMarketingMediaHandler({ env: (name) => ENV[name], fetchImpl: backend.fetchImpl, now: () => NOW });
  const responses = [];
  async function call(token, action, { method = 'GET', body = null, params = {} } = {}) {
    const url = new URL('https://functions.test/atlas-marketing-media');
    url.searchParams.set('action', action);
    for (const [key, value] of Object.entries(params)) {
      for (const entry of [].concat(value)) url.searchParams.append(key, entry);
    }
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await handle(new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined }));
    const text = await response.text();
    responses.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  }
  return { ...backend, call, responses };
}

// Every browser response: no service key, no storage paths, no internal routes.
function assertNoLeak(texts) {
  for (const text of texts) {
    assert.ok(!text.includes(SERVICE_KEY), 'service key leaked');
    assert.ok(!/storage_path|_path"/.test(text), `storage path key leaked: ${text.slice(0, 200)}`);
    assert.ok(!text.includes('/object/authenticated/'), 'authenticated object route leaked');
    assert.ok(!text.includes('/rest/v1'), 'PostgREST route leaked');
    assert.ok(!text.includes('database text that must not leak'), 'database message leaked');
  }
}

async function uploadAsset(h, token, { name, mime, data, kind }) {
  const reserve = await h.call(token, 'reserve', {
    method: 'POST',
    body: { client_request_id: uuid(), mime_type: mime, byte_size: data.byteLength, original_filename: name, kind, client_hints: { width: 1, height: 1 } },
  });
  assert.equal(reserve.status, 200, JSON.stringify(reserve.body));
  const asset = h.assets.get(reserve.body.asset.id);
  h.objects.set(asset.storage_path, data);
  return { reserve, asset };
}

// ------------------------------------------------------------------ roles

test('admin and manager may use Media; bartender, viewer and a deactivated manager get 403 before any RPC', async () => {
  const h = harness();
  for (const token of ['tok-admin', 'tok-manager']) {
    const result = await h.call(token, 'list');
    assert.equal(result.status, 200);
  }
  const before = h.calls.length;
  for (const token of ['tok-bartender', 'tok-viewer', 'tok-gone']) {
    for (const [action, method] of [['list', 'GET'], ['reserve', 'POST'], ['complete', 'POST'], ['delete', 'POST'], ['collection-upsert', 'POST']]) {
      const result = await h.call(token, action, { method, body: method === 'POST' ? { asset_id: uuid() } : null });
      assert.equal(result.status, 403, `${token} ${action}`);
      assert.equal(result.body.error_code, 'forbidden');
    }
  }
  assert.equal(h.calls.length, before, 'no RPC for refused roles');
  const anonymous = await h.call(null, 'list');
  assert.equal(anonymous.status, 401);
  const unknown = await h.call('tok-nobody', 'list');
  assert.equal(unknown.status, 401);
  assertNoLeak(h.responses);
});

test('the SQL role re-check is honoured: a forbidden RPC reads as 403', async () => {
  const error = mapRpcError(400, { code: '42501', hint: 'atlas:forbidden', message: 'x' });
  assert.equal(error.status, 403);
  assert.equal(mapRpcError(400, { code: 'P0002' }).status, 404);
  assert.equal(mapRpcError(400, { code: '22023', hint: 'atlas:size_mismatch' }).status, 422);
  assert.equal(mapRpcError(400, { code: '22023', hint: 'atlas:in_use', details: '{"reason":"in_use","count":2}' }).extra.block.count, 2);
  assert.equal(mapRpcError(500, { code: 'XX000' }).status, 503);
  assert.equal(mapRpcError(400, { code: 'XX000', message: 'secret db text' }).message.includes('secret'), false);
});

// ------------------------------------------------------------------ reserve

test('reserve: a small photo gets a one-time single-PUT token for exactly the server path', async () => {
  const h = harness();
  const result = await h.call('tok-manager', 'reserve', {
    method: 'POST',
    body: { client_request_id: uuid(), mime_type: 'image/jpeg', byte_size: 633, original_filename: 'espresso-martini.jpg', client_hints: { width: 12, height: 8 } },
  });
  assert.equal(result.status, 200);
  const { asset, upload } = result.body;
  assert.equal(asset.status, 'pending_upload');
  assert.equal(upload.method, 'put');
  assert.equal(h.uploads.length, 1);
  const stored = h.assets.get(asset.id);
  assert.match(stored.storage_path, PATH_RE);
  assert.equal(h.uploads[0].path, stored.storage_path);
  assert.equal(upload.token, h.uploads[0].token);
  assert.equal(upload.url, `${SUPABASE}/storage/v1/object/upload/sign/${BUCKET}/${stored.storage_path}?token=${upload.token}`);
  const expires = Date.parse(upload.expires_at);
  assert.ok(expires > NOW && expires <= NOW + 2 * 3600 * 1000, 'upload token lives at most 2 hours');
  assert.equal(stored.request.kind, 'image');
  assert.deepEqual(stored.request.client_hints, { width: 12, height: 8, duration_ms: null });
  assertNoLeak(h.responses);
});

test('reserve: a large video uses TUS on the direct storage host with 6 MB chunks', async () => {
  const h = harness();
  const result = await h.call('tok-admin', 'reserve', {
    method: 'POST',
    body: { client_request_id: uuid(), mime_type: 'video/quicktime', byte_size: 200 * MIB, original_filename: 'IMG_2231.MOV', client_hints: { duration_ms: 24000 } },
  });
  assert.equal(result.status, 200);
  const { upload } = result.body;
  assert.equal(upload.method, 'tus');
  assert.equal(upload.url, 'https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/upload/resumable');
  assert.equal(upload.chunk_size, 6 * MIB);
  assert.equal(upload.bucket, BUCKET);
  assert.equal(upload.object_name, h.assets.get(result.body.asset.id).storage_path);
  assert.ok(upload.token);
  // The single-PUT threshold is 6 MiB.
  assert.equal(LIMITS.singleUploadBytes, 6 * MIB);
});

test('reserve replays on the same request id and re-signs a pending upload', async () => {
  const h = harness();
  const body = { client_request_id: uuid(), mime_type: 'image/png', byte_size: 77, original_filename: 'menu.png' };
  const first = await h.call('tok-manager', 'reserve', { method: 'POST', body });
  const second = await h.call('tok-manager', 'reserve', { method: 'POST', body });
  assert.equal(second.body.asset.id, first.body.asset.id);
  assert.equal(second.body.replayed, true);
  assert.equal(h.assets.size, 1);
  const other = await h.call('tok-admin', 'reserve', { method: 'POST', body });
  assert.equal(other.status, 409);
});

test('MIME and extension allowlist: SVG, HTML, GIF, executables and mismatches are refused before any RPC', async () => {
  const h = harness();
  const refused = [
    { mime_type: 'image/svg+xml', original_filename: 'logo.svg' },
    { mime_type: 'text/html', original_filename: 'page.html' },
    { mime_type: 'image/gif', original_filename: 'fun.gif' },
    { mime_type: 'application/x-msdownload', original_filename: 'setup.exe' },
    { mime_type: 'application/pdf', original_filename: 'menu.pdf' },
    { mime_type: 'image/jpeg', original_filename: 'logo.svg' },
    { mime_type: 'video/mp4', original_filename: 'photo.jpg' },
    { mime_type: 'image/jpeg', original_filename: 'clip.jpg', kind: 'video' },
    { mime_type: '', original_filename: 'no-extension' },
  ];
  for (const entry of refused) {
    const result = await h.call('tok-manager', 'reserve', { method: 'POST', body: { client_request_id: uuid(), byte_size: 100, ...entry } });
    assert.equal(result.status, 415, JSON.stringify(entry));
    assert.equal(result.body.error_code, 'unsupported_type');
  }
  assert.equal(h.calls.length, 0);
  // HEIC from a browser that sends no type is recognised by its extension.
  assert.deepEqual(classifyUpload({ mime_type: '', original_filename: 'IMG_0001.HEIC' }), { mime: 'image/heic', kind: 'image' });
  assert.deepEqual(classifyUpload({ mime_type: 'video/quicktime', original_filename: 'clip.mov' }), { mime: 'video/quicktime', kind: 'video' });
  assert.deepEqual(classifyUpload({ mime_type: 'image/jpeg', original_filename: 'a.JPEG' }), { mime: 'image/jpeg', kind: 'image' });
});

test('size limits: photos over 30 MB and videos over 1 GB are refused; sizes must be positive integers', async () => {
  const h = harness();
  const photo = await h.call('tok-manager', 'reserve', { method: 'POST', body: { client_request_id: uuid(), mime_type: 'image/jpeg', byte_size: 30 * MIB + 1, original_filename: 'a.jpg' } });
  assert.equal(photo.status, 413);
  const video = await h.call('tok-manager', 'reserve', { method: 'POST', body: { client_request_id: uuid(), mime_type: 'video/mp4', byte_size: 1024 * MIB + 1, original_filename: 'a.mp4' } });
  assert.equal(video.status, 413);
  for (const size of [0, -1, 1.5, '12', null]) {
    const result = await h.call('tok-manager', 'reserve', { method: 'POST', body: { client_request_id: uuid(), mime_type: 'image/jpeg', byte_size: size, original_filename: 'a.jpg' } });
    assert.equal(result.status, 400, String(size));
  }
  const noId = await h.call('tok-manager', 'reserve', { method: 'POST', body: { mime_type: 'image/jpeg', byte_size: 10, original_filename: 'a.jpg' } });
  assert.equal(noId.status, 400);
  assert.equal(h.calls.length, 0);
});

// ------------------------------------------------------------------ complete

test('complete verifies a JPEG by content: ready with server dimensions and sha256', async () => {
  const h = harness();
  const data = bytes(JPEG_12x8_BASE64);
  const { asset } = await uploadAsset(h, 'tok-manager', { name: 'espresso.jpg', mime: 'image/jpeg', data });
  const result = await h.call('tok-manager', 'complete', { method: 'POST', body: { asset_id: asset.id } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.asset.status, 'ready');
  assert.equal(result.body.asset.width, 12);
  assert.equal(result.body.asset.height, 8);
  assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(asset.server_probe, 'full');
  assert.match(result.body.asset.thumb_url, /\/storage\/v1\/object\/sign\/atlas-marketing-media\/.+token=read-300$/);
  const again = await h.call('tok-manager', 'complete', { method: 'POST', body: { asset_id: asset.id } });
  assert.equal(again.body.replayed, true);
  assertNoLeak(h.responses);
});

test('complete parses a video by ranged reads: moov after mdat, duration, rotation, audio', async () => {
  const h = harness();
  const data = bytes(MP4_1080x1920_24s_BASE64);
  const { asset } = await uploadAsset(h, 'tok-admin', { name: 'IMG_2231.MOV', mime: 'video/quicktime', data });
  const result = await h.call('tok-admin', 'complete', { method: 'POST', body: { asset_id: asset.id } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  // The .mov is really an ISO MP4: the sniffed type wins within the kind.
  assert.equal(asset.mime_type, 'video/mp4');
  assert.equal(asset.duration_ms, 24000);
  assert.equal(asset.width, 1080);
  assert.equal(asset.height, 1920);
  assert.equal(asset.rotation, 90);
  assert.equal(asset.has_audio, true);
  assert.equal(asset.server_probe, 'full');
});

test('complete reads a video without loading it whole even when Range is ignored', async () => {
  const h = harness({ rangeSupported: false });
  const data = bytes(MP4_1080x1920_24s_BASE64);
  const { asset } = await uploadAsset(h, 'tok-admin', { name: 'clip.mp4', mime: 'video/mp4', data });
  const result = await h.call('tok-admin', 'complete', { method: 'POST', body: { asset_id: asset.id } });
  assert.equal(result.status, 200);
  assert.equal(asset.duration_ms, 24000);
});

test('complete refuses a size mismatch: rejected, the object removed, nothing kept', async () => {
  const h = harness();
  const data = bytes(JPEG_12x8_BASE64);
  const { asset } = await uploadAsset(h, 'tok-manager', { name: 'a.jpg', mime: 'image/jpeg', data });
  h.objects.set(asset.storage_path, new Uint8Array([...data, 0]));
  const result = await h.call('tok-manager', 'complete', { method: 'POST', body: { asset_id: asset.id } });
  assert.equal(result.status, 422);
  assert.equal(result.body.error_code, 'size_mismatch');
  assert.equal(asset.status, 'rejected');
  assert.equal(asset.reject_reason, 'size_mismatch');
  assert.ok(h.removed.includes(asset.storage_path));
  assert.equal(h.objects.has(asset.storage_path), false);
});

test('complete refuses wrong magic bytes: a PDF named .jpg, SVG bytes, a photo that is a video', async () => {
  const h = harness();
  for (const [name, mime, data] of [
    ['menu.jpg', 'image/jpeg', bytes(PDF_BASE64)],
    ['logo.png', 'image/png', bytes(SVG_BASE64)],
    ['still.jpg', 'image/jpeg', bytes(MP4_1080x1920_24s_BASE64)],
    ['clip.mp4', 'video/mp4', bytes(PNG_8x8_BASE64)],
  ]) {
    const { asset } = await uploadAsset(h, 'tok-manager', { name, mime, data });
    const result = await h.call('tok-manager', 'complete', { method: 'POST', body: { asset_id: asset.id } });
    assert.equal(result.status, 415, name);
    assert.equal(asset.status, 'rejected');
    assert.equal(asset.reject_reason, 'magic_bytes');
    assert.equal(h.objects.has(asset.storage_path), false, `${name} removed`);
  }
});

test('complete before the upload arrived is a retryable 409, nothing rejected', async () => {
  const h = harness();
  const reserve = await h.call('tok-manager', 'reserve', { method: 'POST', body: { client_request_id: uuid(), mime_type: 'image/png', byte_size: 77, original_filename: 'a.png' } });
  const result = await h.call('tok-manager', 'complete', { method: 'POST', body: { asset_id: reserve.body.asset.id } });
  assert.equal(result.status, 409);
  assert.equal(result.body.error_code, 'upload_missing');
  assert.equal(h.assets.get(reserve.body.asset.id).status, 'pending_upload');
});

test('abandon ends a pending upload and removes whatever arrived', async () => {
  const h = harness();
  const { asset } = await uploadAsset(h, 'tok-manager', { name: 'a.png', mime: 'image/png', data: bytes(PNG_8x8_BASE64) });
  const result = await h.call('tok-manager', 'abandon', { method: 'POST', body: { asset_id: asset.id } });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'abandoned');
  assert.ok(h.removed.includes(asset.storage_path));
});

// ------------------------------------------------------------------ variants

test('variants: JPEG thumbnail reserve + complete; the variant type must match its bytes', async () => {
  const h = harness();
  const { asset } = await uploadAsset(h, 'tok-manager', { name: 'a.png', mime: 'image/png', data: bytes(PNG_8x8_BASE64) });
  await h.call('tok-manager', 'complete', { method: 'POST', body: { asset_id: asset.id } });
  const reserve = await h.call('tok-manager', 'reserve-variant', {
    method: 'POST',
    body: { client_request_id: uuid(), asset_id: asset.id, purpose: 'thumb', mime_type: 'image/jpeg', byte_size: 633, width: 12, height: 8 },
  });
  assert.equal(reserve.status, 200, JSON.stringify(reserve.body));
  assert.equal(reserve.body.upload.method, 'put');
  const variant = h.variants.get(reserve.body.variant.id);
  assert.match(variant.storage_path, PATH_RE);
  assert.ok(variant.storage_path.startsWith(asset.storage_path.replace(/original\.png$/, 'v/')));
  h.objects.set(variant.storage_path, bytes(JPEG_12x8_BASE64));
  const done = await h.call('tok-manager', 'complete-variant', { method: 'POST', body: { variant_id: variant.id } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.variant.status, 'ready');
  assert.equal(done.body.variant.width, 12);
  assert.match(done.body.variant.url, /token=read-300$/);

  const wrong = await h.call('tok-manager', 'reserve-variant', {
    method: 'POST', body: { client_request_id: uuid(), asset_id: asset.id, purpose: 'crop', mime_type: 'image/jpeg', byte_size: 77, aspect_ratio: '4:5', crop_rect: { x: 0, y: 0, w: 0.8, h: 1 } },
  });
  const wrongVariant = h.variants.get(wrong.body.variant.id);
  h.objects.set(wrongVariant.storage_path, bytes(PNG_8x8_BASE64));
  const refused = await h.call('tok-manager', 'complete-variant', { method: 'POST', body: { variant_id: wrongVariant.id } });
  assert.equal(refused.status, 415);
  assert.equal(wrongVariant.status, 'rejected');
  assert.equal(h.objects.has(wrongVariant.storage_path), false);

  for (const body of [
    { purpose: 'thumb', mime_type: 'image/svg+xml' },
    { purpose: 'thumb', mime_type: 'image/heic' },
    { purpose: 'sticker', mime_type: 'image/jpeg' },
    { purpose: 'crop', mime_type: 'image/jpeg', aspect_ratio: '2:3' },
    { purpose: 'crop', mime_type: 'image/jpeg', aspect_ratio: '1:1', crop_rect: { x: 'a', y: 0, w: 1, h: 1 } },
  ]) {
    const result = await h.call('tok-manager', 'reserve-variant', { method: 'POST', body: { client_request_id: uuid(), asset_id: asset.id, byte_size: 10, ...body } });
    assert.ok([400, 415].includes(result.status), JSON.stringify(body));
  }
  assertNoLeak(h.responses);
});

// ------------------------------------------------------------------ signed URLs

test('library thumbnails and previews are 5-minute signed links, signed in one batch; paths never leave', async () => {
  const h = harness();
  for (let index = 0; index < 3; index += 1) {
    const { asset } = await uploadAsset(h, 'tok-manager', { name: `p${index}.jpg`, mime: 'image/jpeg', data: bytes(JPEG_12x8_BASE64) });
    await h.call('tok-manager', 'complete', { method: 'POST', body: { asset_id: asset.id } });
  }
  h.signed.length = 0;
  const list = await h.call('tok-manager', 'list', { params: { kind: 'image', tag: ['cocktails,friday-quiz'], q: 'martini', sort: 'name', limit: '24' } });
  assert.equal(list.status, 200);
  assert.equal(list.body.assets.length, 3);
  assert.equal(h.signed.length, 1, 'one batch sign call');
  assert.equal(h.signed[0].expiresIn, 300);
  assert.ok(list.body.assets.every((asset) => /token=read-300$/.test(asset.thumb_url)));
  assert.deepEqual(h.calls.at(-1).args.p_filters, { kind: 'image', tags: ['cocktails', 'friday-quiz'], q: 'martini', sort: 'name', limit: 24 });
  const one = await h.call('tok-manager', 'asset', { params: { id: list.body.assets[0].id } });
  assert.equal(one.status, 200);
  assert.match(one.body.asset.preview_url, /token=read-300$/);
  assert.ok(h.signed.every((entry) => entry.expiresIn === LIMITS.signedPreviewSeconds));
  for (const bad of [{ kind: 'gif' }, { used: 'maybe' }, { collection: 'x' }, { sort: 'size' }, { limit: '500' }]) {
    const result = await h.call('tok-manager', 'list', { params: bad });
    assert.equal(result.status, 400, JSON.stringify(bad));
  }
  assertNoLeak(h.responses);
});

test('withSignedUrls rewrites thumb/preview paths to URLs and drops every storage path', async () => {
  const seen = [];
  const storage = { sign: async (paths, seconds) => { seen.push(seconds); return new Map(paths.map((path) => [path, `https://x.test/${path}`])); } };
  const out = await withSignedUrls(storage, { media: [{ asset_id: 'a', thumb_path: 'p/1', storage_path: 'p/0' }], nested: { preview_path: 'p/2', bucket_id: 'b' } });
  assert.deepEqual(out, { media: [{ asset_id: 'a', thumb_url: 'https://x.test/p/1' }], nested: { preview_url: 'https://x.test/p/2' } });
  assert.deepEqual(seen, [300]);
  assert.deepEqual(stripPaths({ a: 1, storage_path: 'x', deep: [{ thumb_path: 'y', keep: true }] }), { a: 1, deep: [{ keep: true }] });
});

// ------------------------------------------------------------------ edits, deletion, collections

test('update validates focal point, trim and tags before the RPC and sends only the keys given', async () => {
  const h = harness();
  const { asset } = await uploadAsset(h, 'tok-manager', { name: 'a.jpg', mime: 'image/jpeg', data: bytes(JPEG_12x8_BASE64) });
  await h.call('tok-manager', 'complete', { method: 'POST', body: { asset_id: asset.id } });
  const before = h.calls.length;
  for (const body of [
    { focal_point: { x: 1.2, y: 0.5 } },
    { focal_point: { x: 'left', y: 0.5 } },
    { trim: { start_ms: 5000, end_ms: 1000 } },
    { tags: 'cocktails' },
    { tags: Array.from({ length: 21 }, (_, index) => `t${index}`) },
    { rights_status: 'stolen' },
    { variant: 'not-a-uuid' },
  ]) {
    const result = await h.call('tok-manager', 'update', { method: 'POST', body: { asset_id: asset.id, ...body } });
    assert.equal(result.status, 400, JSON.stringify(body));
  }
  assert.equal(h.calls.length, before);
  const ok = await h.call('tok-manager', 'update', { method: 'POST', body: { asset_id: asset.id, alt_text: 'An espresso martini', focal_point: { x: 0.4, y: 0.3 }, tags: ['Cocktails'] } });
  assert.equal(ok.status, 200);
  const sent = h.calls.find((entry) => entry.name === 'atlas_marketing_media_update');
  assert.deepEqual(sent.args.p_patch, { alt_text: 'An espresso martini', focal_point: { x: 0.4, y: 0.3 }, tags: ['Cocktails'] });
  assert.equal(ok.body.asset.alt_text, 'An espresso martini');
});

test('deletion guard: media in a scheduled or published post is refused with the reason', async () => {
  const h = harness();
  const { asset } = await uploadAsset(h, 'tok-manager', { name: 'a.jpg', mime: 'image/jpeg', data: bytes(JPEG_12x8_BASE64) });
  await h.call('tok-manager', 'complete', { method: 'POST', body: { asset_id: asset.id } });
  h.pinned.set(asset.id, { reason: 'in_use', count: 2 });
  const refused = await h.call('tok-manager', 'delete', { method: 'POST', body: { asset_id: asset.id } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error_code, 'in_use');
  assert.deepEqual(refused.body.block, { reason: 'in_use', count: 2 });
  assert.equal(asset.status, 'ready');
  h.pinned.delete(asset.id);
  const done = await h.call('tok-manager', 'delete', { method: 'POST', body: { asset_id: asset.id } });
  assert.equal(done.status, 200);
  assert.equal(done.body.asset.status, 'deleted');
  assert.equal(h.objects.has(asset.storage_path), true, 'soft delete keeps the object until the purge');
});

test('collections: create with order, reorder by explicit array, invalid ids refused', async () => {
  const h = harness();
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const { asset } = await uploadAsset(h, 'tok-manager', { name: `p${index}.jpg`, mime: 'image/jpeg', data: bytes(JPEG_12x8_BASE64) });
    await h.call('tok-manager', 'complete', { method: 'POST', body: { asset_id: asset.id } });
    ids.push(asset.id);
  }
  const created = await h.call('tok-manager', 'collection-upsert', { method: 'POST', body: { name: 'Autumn carousel', asset_ids: ids } });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.collection.asset_ids, ids);
  assert.ok(created.body.collection.items.every((item) => item.thumb_url && !('thumb_path' in item)));
  const order = [ids[2], ids[0], ids[1]];
  const reordered = await h.call('tok-manager', 'collection-reorder', { method: 'POST', body: { collection_id: created.body.collection.id, asset_ids: order } });
  assert.deepEqual(reordered.body.collection.asset_ids, order);
  const partial = await h.call('tok-manager', 'collection-reorder', { method: 'POST', body: { collection_id: created.body.collection.id, asset_ids: order.slice(1) } });
  assert.equal(partial.status, 400);
  const badId = await h.call('tok-manager', 'collection-reorder', { method: 'POST', body: { collection_id: created.body.collection.id, asset_ids: ['x'] } });
  assert.equal(badId.status, 400);
  const noName = await h.call('tok-manager', 'collection-upsert', { method: 'POST', body: { asset_ids: ids } });
  assert.equal(noName.status, 400);
  const list = await h.call('tok-manager', 'collections');
  assert.equal(list.body.collections.length, 1);
  assertNoLeak(h.responses);
});

test('maintenance is for administrators and purges rows only after their objects are removed', async () => {
  const h = harness();
  const { asset } = await uploadAsset(h, 'tok-manager', { name: 'a.png', mime: 'image/png', data: bytes(PNG_8x8_BASE64) });
  await h.call('tok-manager', 'abandon', { method: 'POST', body: { asset_id: asset.id } });
  const refused = await h.call('tok-manager', 'maintenance', { method: 'POST', body: {} });
  assert.equal(refused.status, 403);
  const done = await h.call('tok-admin', 'maintenance', { method: 'POST', body: {} });
  assert.equal(done.status, 200);
  assert.equal(done.body.purged_assets, 1);
  assert.equal(h.assets.has(asset.id), false);
});

test('unknown actions, methods and malformed JSON are refused', async () => {
  const h = harness();
  assert.equal((await h.call('tok-manager', 'nope')).status, 404);
  assert.equal((await h.call('tok-manager', 'nope', { method: 'POST', body: {} })).status, 404);
  assert.equal((await h.call('tok-manager', 'list', { method: 'PUT', body: {} })).status, 405);
  const handle = createMarketingMediaHandler({ env: (name) => ENV[name], fetchImpl: h.fetchImpl });
  const response = await handle(new Request('https://functions.test/x?action=reserve', { method: 'POST', headers: { authorization: 'Bearer tok-manager' }, body: '{not json' }));
  assert.equal(response.status, 400);
  const options = await handle(new Request('https://functions.test/x', { method: 'OPTIONS' }));
  assert.equal(options.status, 200);
  const missing = createMarketingMediaHandler({ env: (name) => (name === 'SUPABASE_SERVICE_ROLE_KEY' ? undefined : ENV[name]), fetchImpl: h.fetchImpl });
  const unavailable = await missing(new Request('https://functions.test/x?action=list', { headers: { authorization: 'Bearer tok-manager' } }));
  assert.equal(unavailable.status, 503);
});

// ------------------------------------------------------------------ sniffing units

test('sniffType recognises only the allowlisted formats', () => {
  assert.equal(sniffType(bytes(JPEG_12x8_BASE64)), 'image/jpeg');
  assert.equal(sniffType(bytes(PNG_8x8_BASE64)), 'image/png');
  assert.equal(sniffType(bytes(MP4_1080x1920_24s_BASE64)), 'video/mp4');
  assert.equal(sniffType(bytes(SVG_BASE64)), null);
  assert.equal(sniffType(bytes(PDF_BASE64)), null);
  assert.equal(sniffType(new TextEncoder().encode('<!doctype html><html><script>x</script>')), null);
  assert.equal(sniffType(new TextEncoder().encode('GIF89a\x01\x00\x01\x00\x00\x00\x00')), null);
  const ftyp = (major, ...compat) => new TextEncoder().encode(`\x00\x00\x00\x18ftyp${major}\x00\x00\x00\x00${compat.join('')}`);
  assert.equal(sniffType(ftyp('qt  ', 'qt  ')), 'video/quicktime');
  assert.equal(sniffType(ftyp('heic', 'mif1')), 'image/heic');
  assert.equal(sniffType(ftyp('mif1', 'heic')), 'image/heic');
  assert.equal(sniffType(ftyp('mp42', 'isom')), 'video/mp4');
  assert.equal(sniffType(ftyp('abcd', 'efgh')), null);
  assert.equal(sniffType(new TextEncoder().encode('\x00\x00\x00\x10wide\x00\x00\x00\x00\x00\x00\x00\x00')), 'video/quicktime');
  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode('RIFF\x00\x00\x00\x00WEBPVP8X'));
  webp.set([9, 0, 0, 5, 0, 0], 24);
  assert.equal(sniffType(webp), 'image/webp');
  assert.deepEqual(imageDimensions('image/webp', webp), { width: 10, height: 6 });
});

test('imageDimensions applies EXIF orientation; parseMoov reads mvhd/tkhd', () => {
  assert.deepEqual(imageDimensions('image/png', bytes(PNG_8x8_BASE64)), { width: 8, height: 8 });
  assert.deepEqual(imageDimensions('image/jpeg', bytes(JPEG_12x8_BASE64)), { width: 12, height: 8, rotation: 0 });
  // Insert an APP1 Exif segment with orientation 6 (rotate 90) after SOI.
  const jpeg = bytes(JPEG_12x8_BASE64);
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0];
  const payload = [...new TextEncoder().encode('Exif\x00\x00'), ...tiff];
  const app1 = [0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
  const rotated = new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
  assert.deepEqual(imageDimensions('image/jpeg', rotated), { width: 8, height: 12, rotation: 90 });
  const moov = parseMoov(bytes(MP4_1080x1920_24s_BASE64));
  assert.deepEqual(moov, { duration_ms: 24000, width: 1080, height: 1920, rotation: 90, has_audio: true });
  assert.equal(imageDimensions('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff])), null);
});

// ------------------------------------------------------------------ source contracts

test('source contract: config, thin index, private bucket, service-role RPCs, no URLs stored', () => {
  const config = readFileSync('supabase/config.toml', 'utf8');
  assert.match(config, /\[functions\.atlas-marketing-media\]\s*\nverify_jwt = false/);
  const index = readFileSync('supabase/functions/atlas-marketing-media/index.ts', 'utf8');
  assert.match(index, /createMarketingMediaHandler/);
  assert.ok(index.split('\n').length < 40);
  const handler = readFileSync('supabase/functions/atlas-marketing-media/handler.mjs', 'utf8');
  assert.ok(!/console\.(log|warn|error)\([^)]*(url|token|path)/i.test(handler.replace(/\[atlas-marketing-media\] rpc \$\{name\} failed/, '')), 'no URL, token or path is logged');
  assert.ok(!/x-upsert["']?\s*:\s*["']true/.test(handler), 'never upsert');
  const migration = readFileSync('supabase/migrations/20261004090000_s94a_marketing_media.sql', 'utf8');
  assert.match(migration, /'atlas-marketing-media',\s*\n\s*'atlas-marketing-media',\s*\n\s*false,\s*\n\s*1073741824/);
  assert.ok(!/create policy[^;]*on storage\.objects/i.test(migration), 'no storage.objects policy');
  assert.ok(!/image\/svg|text\/html|image\/gif/.test(migration.split('-- Tables')[0]), 'no SVG/HTML/GIF in the bucket allowlist');
  assert.match(migration, /collection_id uuid references atlas_private\.marketing_media_collections/);
  assert.match(migration, /public\.atlas_marketing_media_resolve\(p_asset_ids uuid\[\], p_variant_ids uuid\[\]\)/);
  assert.match(migration, /public\.atlas_marketing_content_media_set\(p_actor_id uuid, p_content_id uuid, p_items jsonb\)/);
  assert.match(migration, /grant execute on function %s to service_role/);
  assert.match(migration, /revoke all on function %s from public, anon, authenticated/);
  assert.ok(!/\bsigned_url text\b|\burl text\b/i.test(migration), 'no URL column');
});
