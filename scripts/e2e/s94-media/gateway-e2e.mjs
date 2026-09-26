// Drives atlas-marketing-media and the real Storage API the way the browser
// does (reserve -> signed PUT or TUS with the one-time token -> complete ->
// variants), then checks every hop against Postgres and Storage directly.
// Run with the stack up (setup.sh, then stack.mjs):
//   source env.sh && node gateway-e2e.mjs [--only name,name]
// Prints one line per check and a final JSON verdict; exits 1 on a failure.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceKey, anonKey } from './jwt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const env = process.env;
const WORK = env.E2E_WORK;
const SAMPLES = path.join(WORK, 'samples');
const REF = env.E2E_REF;
const PROJECT = `https://${REF}.supabase.co`;
const HTTP = `http://127.0.0.1:${env.E2E_PROXY_HTTP_PORT}`;
const SERVICE = serviceKey(env.E2E_JWT_SECRET);
const ANON = anonKey(env.E2E_JWT_SECRET);
const DB = env.E2E_DB;
const MIB = 1024 * 1024;
const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  return Boolean(ok);
}
function sql(query) {
  return execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', query], { encoding: 'utf8' }).trim();
}
const sqlJson = (query) => JSON.parse(sql(`select coalesce((${query})::text, 'null')`));

// Hosted URLs -> this proxy's plain HTTP side (the forwarded host is kept).
function net(url, init = {}) {
  const target = new URL(url);
  const headers = new Headers(init.headers || {});
  if (target.hostname.endsWith('.supabase.co')) {
    headers.set('x-e2e-host', target.host);
    return fetch(`${HTTP}${target.pathname}${target.search}`, { ...init, headers });
  }
  return fetch(url, { ...init, headers });
}

async function signIn(email) {
  const response = await net(`${PROJECT}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'content-type': 'application/json', apikey: ANON }, body: JSON.stringify({ email, password: 's94-e2e-password' }),
  });
  const body = await response.json();
  if (!body.access_token) throw new Error(`sign-in failed for ${email}`);
  return body.access_token;
}

function gateway(token) {
  return async (action, { method = 'GET', params = {}, body = null } = {}) => {
    const url = new URL(`${PROJECT}/functions/v1/atlas-marketing-media`);
    url.searchParams.set('action', action);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await net(url.toString(), {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: 'http://localhost:54380' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, body: json, text, headers: response.headers };
  };
}

// Single PUT exactly like the browser (anon apikey, no service credential).
async function put(upload, bytes, mime) {
  const response = await net(upload.url, {
    method: 'PUT', headers: { 'content-type': mime, 'x-upsert': 'false', 'cache-control': 'max-age=3600', apikey: ANON }, body: bytes,
  });
  return { status: response.status, text: await response.text() };
}

// TUS exactly like apps/web/assets/js/marketing-media.js tusUpload.
async function tus(upload, bytes, mime) {
  const b64 = (text) => Buffer.from(String(text)).toString('base64');
  const base = { 'tus-resumable': '1.0.0', 'x-signature': upload.token, apikey: ANON };
  const created = await net(upload.url, {
    method: 'POST',
    headers: { ...base, 'upload-length': String(bytes.length), 'upload-metadata': [`bucketName ${b64(upload.bucket)}`, `objectName ${b64(upload.object_name)}`, `contentType ${b64(mime)}`, `cacheControl ${b64('3600')}`].join(',') },
  });
  const location = created.headers.get('location');
  const trace = { create: created.status, location, patches: [] };
  if (created.status !== 201 || !location) { trace.error = await created.text(); return trace; }
  const target = new URL(location, upload.url).toString();
  trace.target = target;
  let offset = 0;
  const chunk = Number(upload.chunk_size) || 6 * MIB;
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + chunk);
    const sent = await net(target, { method: 'PATCH', headers: { ...base, 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' }, body: bytes.subarray(offset, end) });
    trace.patches.push(sent.status);
    if (sent.status < 200 || sent.status >= 300) { trace.error = await sent.text(); return trace; }
    offset = Number(sent.headers.get('upload-offset')) || end;
  }
  const head = await net(target, { method: 'HEAD', headers: base });
  trace.head = { status: head.status, offset: head.headers.get('upload-offset') };
  trace.ok = true;
  return trace;
}

const MIME_OF = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4' };
const objectRow = (p) => sqlJson(`select jsonb_build_object('size', (metadata->>'size')::bigint, 'mimetype', metadata->>'mimetype') from storage.objects where bucket_id='atlas-marketing-media' and name='${p.replace(/'/g, "''")}'`);
const assetRow = (id) => sqlJson(`select to_jsonb(a) from atlas_private.marketing_media_assets a where id='${id}'`);
const variantRows = (id) => sqlJson(`select coalesce(jsonb_agg(to_jsonb(v) order by v.created_at), '[]') from atlas_private.marketing_media_variants v where asset_id='${id}'`);
const findPaths = (value) => JSON.stringify(value).match(/venues\/[a-z0-9-]+\/\d{4}\/\d{2}\/[0-9a-f-]{36}[^"]*/g) || [];
const hiddenKeys = (value) => { const keys = []; const walk = (node) => { if (Array.isArray(node)) node.forEach(walk); else if (node && typeof node === 'object') for (const [key, entry] of Object.entries(node)) { if (key === 'storage_path' || key.endsWith('_path') || key === 'bucket_id') keys.push(key); walk(entry); } }; walk(value); return keys; };

async function uploadMaster(api, file, { declaredBytes = null, mime = null, name = null } = {}) {
  const bytes = readFileSync(path.join(SAMPLES, file));
  const ext = file.split('.').pop();
  const type = mime || MIME_OF[ext];
  const reserved = await api('reserve', { method: 'POST', body: { client_request_id: randomUUID(), mime_type: type, byte_size: declaredBytes ?? bytes.length, original_filename: name || file, client_hints: {} } });
  let transfer = null;
  if (reserved.status === 200 && reserved.body?.upload) {
    transfer = reserved.body.upload.method === 'tus' ? await tus(reserved.body.upload, bytes, type) : await put(reserved.body.upload, bytes, type);
  }
  return { bytes, type, reserved, transfer };
}

async function uploadVariant(api, assetId, file, facts) {
  const bytes = readFileSync(path.join(SAMPLES, 'derived', file));
  const reserved = await api('reserve-variant', { method: 'POST', body: { client_request_id: randomUUID(), asset_id: assetId, mime_type: 'image/jpeg', byte_size: bytes.length, ...facts } });
  if (reserved.status !== 200) return { reserved };
  const sent = await put(reserved.body.upload, bytes, 'image/jpeg');
  const done = await api('complete-variant', { method: 'POST', body: { variant_id: reserved.body.variant.id } });
  return { reserved, sent, done };
}

const want = (name) => !only.length || only.includes(name);
const ids = {};

async function main() {
  const manager = gateway(await signIn('manager@s94.e2e.test'));
  const admin = gateway(await signIn('admin@s94.e2e.test'));
  const bartender = gateway(await signIn('bartender@s94.e2e.test'));

  // ---------- CORS preflight on the function ----------
  {
    const response = await net(`${PROJECT}/functions/v1/atlas-marketing-media?action=list`, { method: 'OPTIONS', headers: { origin: 'http://localhost:54380', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,content-type' } });
    check('function OPTIONS preflight 200 with CORS', response.status === 200 && response.headers.get('access-control-allow-origin') === '*' && /authorization/.test(response.headers.get('access-control-allow-headers') || ''), `status ${response.status}`);
  }
  // ---------- role boundary ----------
  {
    const refused = await bartender('list');
    check('bartender refused (403 forbidden)', refused.status === 403 && refused.body?.error_code === 'forbidden', refused.status);
    const noSession = await gateway('not-a-token')('list');
    check('invalid session refused (401)', noSession.status === 401, noSession.status);
  }

  // ---------- photos ----------
  const photos = [
    { file: 'bar-counter.jpg', w: 1600, h: 1200, publish: false },
    { file: 'cocktail-menu.png', w: 1200, h: 1200, publish: true },
    { file: 'happy-hour.webp', w: 1080, h: 1350, publish: true },
    { file: 'iphone-terrace.heic', w: 2016, h: 1512, publish: true },
  ];
  for (const photo of photos) {
    if (!want(photo.file)) continue;
    const label = photo.file;
    const { bytes, type, reserved, transfer } = await uploadMaster(manager, photo.file);
    const upload = reserved.body?.upload;
    check(`${label}: reserve 200, single PUT, signed upload URL with token`, reserved.status === 200 && upload?.method === 'put' && /\/storage\/v1\/object\/upload\/sign\/atlas-marketing-media\/venues\/main\/\d{4}\/\d{2}\/[0-9a-f-]{36}\/original\.(jpg|png|webp|heic)\?token=/.test(upload?.url || '') && upload.token && upload.url.includes(upload.token), reserved.status);
    check(`${label}: reserve response carries no storage path keys`, hiddenKeys(reserved.body?.asset).length === 0);
    const assetId = reserved.body?.asset?.id;
    ids[label] = assetId;
    check(`${label}: row pending_upload before PUT`, assetRow(assetId)?.status === 'pending_upload');
    check(`${label}: PUT to Storage 200`, transfer?.status === 200, `${transfer?.status} ${transfer?.status !== 200 ? transfer?.text : ''}`);
    const row = assetRow(assetId);
    const object = objectRow(row.storage_path);
    check(`${label}: object stored with exact size and MIME`, object && object.size === bytes.length && object.mimetype === type, object);
    const replayPut = await put(upload, bytes, type);
    check(`${label}: second PUT with the same token refused (no overwrite)`, replayPut.status >= 400, replayPut.status);
    const done = await manager('complete', { method: 'POST', body: { asset_id: assetId } });
    const ready = assetRow(assetId);
    check(`${label}: complete 200 -> ready, server-verified MIME/size/dimensions/sha256`, done.status === 200 && ready.status === 'ready' && ready.mime_type === type && Number(ready.byte_size) === bytes.length && ready.width === photo.w && ready.height === photo.h && ready.sha256 === createHash('sha256').update(bytes).digest('hex') && ready.server_probe === 'full', { status: done.status, row: { status: ready.status, mime: ready.mime_type, w: ready.width, h: ready.height, probe: ready.server_probe } });
    const thumb = await uploadVariant(manager, assetId, `${photo.file}.thumb.jpg`, { purpose: 'thumb' });
    check(`${label}: thumb variant reserve/PUT/complete`, thumb.reserved.status === 200 && thumb.sent?.status === 200 && thumb.done?.status === 200 && thumb.done.body?.variant?.status === 'ready', { r: thumb.reserved.status, put: thumb.sent?.status, c: thumb.done?.status });
    if (photo.publish) {
      const publish = await uploadVariant(manager, assetId, `${photo.file}.publish.jpg`, { purpose: 'publish', aspect_ratio: 'original' });
      check(`${label}: JPEG publish copy variant ready`, publish.done?.status === 200 && publish.done.body?.variant?.status === 'ready', { r: publish.reserved.status, put: publish.sent?.status, c: publish.done?.status, body: publish.done?.body });
    }
    const variants = variantRows(assetId);
    const afterRow = assetRow(assetId);
    const publishVariant = variants.find((variant) => variant.purpose === 'publish');
    check(`${label}: variant rows ready (${variants.map((variant) => variant.purpose).join(',')})`, variants.every((variant) => variant.status === 'ready') && variants.some((variant) => variant.purpose === 'thumb') && (!photo.publish || Boolean(publishVariant)));
    const view = await manager('asset', { params: { id: assetId } });
    const asset = view.body?.asset;
    check(`${label}: asset view has no storage paths`, view.status === 200 && findPaths(Object.fromEntries(Object.entries(asset || {}).filter(([key]) => !key.endsWith('_url') && key !== 'variants'))).length === 0 && hiddenKeys(asset).length === 0);
    if (photo.publish) check(`${label}: publish_variant_id points at the JPEG copy`, asset?.publish_variant_id === publishVariant?.id, { publish_variant_id: asset?.publish_variant_id, row: afterRow.publish_variant_id ?? null });
    // Preview: a browser-displayable master, else the JPEG publish copy (HEIC).
    const preview = await net(asset.preview_url);
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    const expectedPreview = photo.file.endsWith('.heic') ? readFileSync(path.join(SAMPLES, 'derived', `${photo.file}.publish.jpg`)) : bytes;
    check(`${label}: signed preview URL 200 and serves the ${photo.file.endsWith('.heic') ? 'JPEG publish copy' : 'master'}`, preview.status === 200 && previewBytes.equals(expectedPreview), { status: preview.status, type: preview.headers.get('content-type'), bytes: previewBytes.length });
    const thumbFetch = await net(asset.thumb_url);
    check(`${label}: signed thumb URL 200 image/jpeg`, thumbFetch.status === 200 && /image\/jpeg/.test(thumbFetch.headers.get('content-type') || ''), thumbFetch.status);
    const tokenClaims = JSON.parse(Buffer.from(new URL(asset.preview_url).searchParams.get('token').split('.')[1], 'base64url').toString());
    check(`${label}: preview link lifetime is 300 s`, tokenClaims.exp - tokenClaims.iat === 300, tokenClaims.exp - tokenClaims.iat);
  }

  // ---------- videos ----------
  for (const video of [{ file: 'reel-short.mp4', w: 1080, h: 1920, method: 'put' }, { file: 'reel-large.mp4', w: 1280, h: 720, method: 'tus' }]) {
    if (!want(video.file)) continue;
    const label = video.file;
    const { bytes, reserved, transfer } = await uploadMaster(manager, video.file);
    const upload = reserved.body?.upload;
    check(`${label}: reserve 200 with ${video.method} (${(bytes.length / MIB).toFixed(1)} MiB)`, reserved.status === 200 && upload?.method === video.method, { status: reserved.status, method: upload?.method, url: upload?.url?.replace(/token=.*/, 'token=…') });
    const assetId = reserved.body?.asset?.id;
    ids[label] = assetId;
    if (video.method === 'tus') {
      check(`${label}: TUS create 201 + PATCH chunks + HEAD offset`, transfer?.ok && transfer.create === 201 && transfer.patches.every((status) => status === 204) && Number(transfer.head?.offset) === bytes.length, { create: transfer?.create, patches: transfer?.patches, head: transfer?.head, error: transfer?.error, location: transfer?.location });
    } else {
      check(`${label}: PUT 200`, transfer?.status === 200, transfer);
    }
    const row = assetRow(assetId);
    const object = objectRow(row.storage_path);
    check(`${label}: object stored with exact size and MIME`, object && object.size === bytes.length && object.mimetype === 'video/mp4', object);
    const done = await manager('complete', { method: 'POST', body: { asset_id: assetId } });
    const ready = assetRow(assetId);
    check(`${label}: complete -> ready with server-probed duration/size/audio`, done.status === 200 && ready.status === 'ready' && ready.width === video.w && ready.height === video.h && ready.duration_ms >= 3900 && ready.has_audio === true, { status: done.status, body: done.status !== 200 ? done.body : undefined, row: { status: ready.status, w: ready.width, h: ready.height, d: ready.duration_ms, audio: ready.has_audio, probe: ready.server_probe } });
    const poster = await uploadVariant(manager, assetId, `${video.file}.poster.jpg`, { purpose: 'poster', source_time_ms: 1000 });
    const thumb = await uploadVariant(manager, assetId, `${video.file}.poster.jpg`, { purpose: 'thumb' });
    check(`${label}: poster + thumb variants ready`, poster.done?.status === 200 && thumb.done?.status === 200);
    const view = await manager('asset', { params: { id: assetId } });
    const previewUrl = view.body?.asset?.preview_url;
    const preview = previewUrl ? await net(previewUrl, { headers: { range: 'bytes=0-1023' } }) : { status: 'no preview_url' };
    check(`${label}: signed preview supports Range (206)`, preview.status === 206, preview.status);
  }

  // ---------- list, search, filters, collections, used/unused ----------
  if (want('library')) {
    const list = await manager('list');
    check('list 200 without storage paths or hidden keys', list.status === 200 && findPaths(list.body?.assets?.map(({ thumb_url, ...rest }) => rest)).length === 0 && hiddenKeys(list.body).length === 0, { total: list.body?.total });
    const readyCount = Number(sql("select count(*) from atlas_private.marketing_media_assets where status='ready'"));
    check('list shows every ready asset', list.body?.assets?.length === readyCount, `${list.body?.assets?.length}/${readyCount}`);
    check('every listed asset has a working signed thumb', (await Promise.all(list.body.assets.map(async (asset) => (await net(asset.thumb_url)).status))).every((status) => status === 200));
    const photos = await manager('list', { params: { kind: 'image' } });
    const videos = await manager('list', { params: { kind: 'video' } });
    check('Photos / Videos filters', photos.body.assets.every((asset) => asset.kind === 'image') && videos.body.assets.every((asset) => asset.kind === 'video') && photos.body.assets.length + videos.body.assets.length === list.body.assets.length, `${photos.body.assets.length} photos, ${videos.body.assets.length} videos`);
    const search = await manager('list', { params: { q: 'terrace' } });
    check('search by name', search.body.assets.length === 1 && search.body.assets[0].id === ids['iphone-terrace.heic'], search.body.assets.map((asset) => asset.name || asset.original_filename));
    const collection = await manager('collection-upsert', { method: 'POST', body: { name: 'Autumn menu', asset_ids: [ids['cocktail-menu.png'], ids['bar-counter.jpg']].filter(Boolean) } });
    check('collection created with two items', collection.status === 200 && collection.body.collection?.items?.length === 2, collection.status);
    const inCollection = await manager('list', { params: { collection: collection.body.collection.id } });
    check('collection filter', inCollection.body.assets.length === 2);
    const cols = await manager('collections');
    check('collections list has signed covers, no paths', cols.status === 200 && hiddenKeys(cols.body).length === 0 && cols.body.collections?.length === 1);
    ids.collection = collection.body.collection.id;
  }

  // ---------- protected media and delete ----------
  if (want('delete')) {
    const mgr = '5e940000-0000-4000-8000-00000000a002';
    const scheduled = randomUUID();
    const published = randomUUID();
    sql(`insert into atlas_private.marketing_content_items (id, title, content_type, status, platforms) values ('${scheduled}', 'Friday reel', 'post', 'scheduled', array['instagram']), ('${published}', 'Opening night', 'post', 'published', array['instagram'])`);
    sql(`insert into atlas_private.marketing_content_media (content_id, asset_id, position, added_by) values ('${scheduled}', '${ids['reel-short.mp4']}', 0, '${mgr}')`);
    sql(`insert into atlas_private.marketing_media_publication_uses (asset_id, content_id, platform, fetch_method, outcome) values ('${ids['happy-hour.webp']}', '${published}', 'instagram', 'signed_url', 'published')`);
    const used = await manager('list', { params: { used: 'used' } });
    const unused = await manager('list', { params: { used: 'unused' } });
    check('Used / Unused filters', used.body.assets.some((asset) => asset.id === ids['reel-short.mp4']) && !unused.body.assets.some((asset) => asset.id === ids['reel-short.mp4']) && unused.body.assets.some((asset) => asset.id === ids['bar-counter.jpg']), { used: used.body.assets.length, unused: unused.body.assets.length });
    const blocked = await manager('delete', { method: 'POST', body: { asset_id: ids['reel-short.mp4'] } });
    check('delete refused for media in a scheduled post (409 in_use, reason in_use)', blocked.status === 409 && blocked.body?.error_code === 'in_use' && blocked.body?.block?.reason === 'in_use', blocked.body);
    const blockedPublished = await manager('delete', { method: 'POST', body: { asset_id: ids['happy-hour.webp'] } });
    check('delete refused for published media (reason published)', blockedPublished.status === 409 && blockedPublished.body?.block?.reason === 'published', blockedPublished.body);
    check('protected assets still ready', assetRow(ids['reel-short.mp4']).status === 'ready' && assetRow(ids['happy-hour.webp']).status === 'ready');
    const deleted = await manager('delete', { method: 'POST', body: { asset_id: ids['bar-counter.jpg'] } });
    check('delete unused -> deleted (soft, 30-day purge)', deleted.status === 200 && assetRow(ids['bar-counter.jpg']).status === 'deleted', deleted.status);
    const gone = await manager('list');
    check('deleted asset leaves the list', !gone.body.assets.some((asset) => asset.id === ids['bar-counter.jpg']));
    // Purge: make it due, then the administrator maintenance removes objects then rows.
    const deletedPaths = [assetRow(ids['bar-counter.jpg']).storage_path, ...variantRows(ids['bar-counter.jpg']).map((variant) => variant.storage_path)];
    sql(`update atlas_private.marketing_media_assets set purge_after = now() - interval '1 minute' where id = '${ids['bar-counter.jpg']}'`);
    const refusedMaintenance = await manager('maintenance', { method: 'POST', body: {} });
    check('maintenance is administrators only', refusedMaintenance.status === 403, refusedMaintenance.status);
    const maintenance = await admin('maintenance', { method: 'POST', body: {} });
    check('maintenance purges due media: objects then rows', maintenance.status === 200 && maintenance.body.purged_assets >= 1 && deletedPaths.every((p) => objectRow(p) === null) && assetRow(ids['bar-counter.jpg']) === null, { body: maintenance.body, objects: deletedPaths.map((p) => objectRow(p)) });
  }

  // ---------- failures: rejected content, size mismatch, missing upload, abandon ----------
  if (want('failures')) {
    const svg = await uploadMaster(manager, 'not-a-photo.jpg', { mime: 'image/jpeg' });
    check('SVG named .jpg: Storage accepts the bytes (declared type)', svg.transfer?.status === 200, svg.transfer);
    const svgDone = await manager('complete', { method: 'POST', body: { asset_id: svg.reserved.body.asset.id } });
    const svgRow = assetRow(svg.reserved.body.asset.id);
    check('...complete refuses by content (415 unsupported_type), row rejected magic_bytes, object removed', svgDone.status === 415 && svgRow.status === 'rejected' && svgRow.reject_reason === 'magic_bytes' && objectRow(svgRow.storage_path) === null, { status: svgDone.status, row: svgRow.status, reason: svgRow.reject_reason });

    const early = await manager('reserve', { method: 'POST', body: { client_request_id: randomUUID(), mime_type: 'image/jpeg', byte_size: 1000, original_filename: 'early.jpg', client_hints: {} } });
    const earlyDone = await manager('complete', { method: 'POST', body: { asset_id: early.body.asset.id } });
    check('complete before the upload arrives -> 409 upload_missing, row still pending', earlyDone.status === 409 && earlyDone.body.error_code === 'upload_missing' && assetRow(early.body.asset.id).status === 'pending_upload');
    const abandoned = await manager('abandon', { method: 'POST', body: { asset_id: early.body.asset.id } });
    check('abandon -> abandoned', abandoned.status === 200 && assetRow(early.body.asset.id).status === 'abandoned');

    const bytes = readFileSync(path.join(SAMPLES, 'bar-counter.jpg'));
    const lying = await manager('reserve', { method: 'POST', body: { client_request_id: randomUUID(), mime_type: 'image/jpeg', byte_size: bytes.length + 10, original_filename: 'lying.jpg', client_hints: {} } });
    const lyingPut = await put(lying.body.upload, bytes, 'image/jpeg');
    const lyingDone = await manager('complete', { method: 'POST', body: { asset_id: lying.body.asset.id } });
    const lyingRow = assetRow(lying.body.asset.id);
    check('declared size differs from stored size -> 422 size_mismatch, rejected, object removed', lyingPut.status === 200 && lyingDone.status === 422 && lyingRow.status === 'rejected' && objectRow(lyingRow.storage_path) === null, { put: lyingPut.status, status: lyingDone.status, row: lyingRow.status });

    // A PUT that dies mid-transfer, then the retry path the browser uses (replayed reservation).
    const requestId = randomUUID();
    const first = await manager('reserve', { method: 'POST', body: { client_request_id: requestId, mime_type: 'image/jpeg', byte_size: bytes.length, original_filename: 'retry.jpg', client_hints: {} } });
    await fetch(`${HTTP}/__e2e/fail-next-put`, { method: 'POST' });
    let cutStatus = 'no error';
    try { cutStatus = (await put(first.body.upload, bytes, 'image/jpeg')).status; } catch (error) { cutStatus = `network error (${error.cause?.code || error.name})`; }
    const cutRow = assetRow(first.body.asset.id);
    check('cut PUT leaves no object and the row pending', String(cutStatus).startsWith('network error') && cutRow.status === 'pending_upload' && objectRow(cutRow.storage_path) === null, { cutStatus, row: cutRow.status });
    const again = await manager('reserve', { method: 'POST', body: { client_request_id: requestId, mime_type: 'image/jpeg', byte_size: bytes.length, original_filename: 'retry.jpg', client_hints: {} } });
    check('retry replays the same reservation with a new upload token', again.status === 200 && again.body.asset.id === first.body.asset.id && again.body.replayed === true && Boolean(again.body.upload?.token), { status: again.status, replayed: again.body?.replayed });
    const retryPut = await put(again.body.upload, bytes, 'image/jpeg');
    const retryDone = await manager('complete', { method: 'POST', body: { asset_id: first.body.asset.id } });
    check('retry PUT + complete -> ready', retryPut.status === 200 && retryDone.status === 200 && assetRow(first.body.asset.id).status === 'ready', { put: retryPut.status, complete: retryDone.status });
    // PUT landed but the response was lost: the browser retries -> reserve replays -> PUT again must not wedge the upload.
    const lostId = randomUUID();
    const lost = await manager('reserve', { method: 'POST', body: { client_request_id: lostId, mime_type: 'image/jpeg', byte_size: bytes.length, original_filename: 'lost-response.jpg', client_hints: {} } });
    await put(lost.body.upload, bytes, 'image/jpeg');
    const lostAgain = await manager('reserve', { method: 'POST', body: { client_request_id: lostId, mime_type: 'image/jpeg', byte_size: bytes.length, original_filename: 'lost-response.jpg', client_hints: {} } });
    check('retry after a PUT whose response was lost: reserve verifies and finishes it (upload null, ready)', lostAgain.status === 200 && lostAgain.body?.upload === null && lostAgain.body?.asset?.status === 'ready' && assetRow(lost.body.asset.id).status === 'ready', { status: lostAgain.status, body: lostAgain.status !== 200 ? lostAgain.body : { upload: lostAgain.body?.upload, status: lostAgain.body?.asset?.status } });
  }

  // ---------- signed link expiry (short override through the same Storage services) ----------
  if (want('expiry')) {
    const { createStorageServices } = await import(pathToFileURL(path.join(ROOT, 'supabase/functions/atlas-marketing-media/handler.mjs')).href);
    const storage = createStorageServices({ env: (name) => ({ SUPABASE_URL: PROJECT, SUPABASE_SERVICE_ROLE_KEY: SERVICE }[name]), fetchImpl: net });
    const anyPath = sql("select storage_path from atlas_private.marketing_media_assets where status='ready' limit 1");
    const links = await storage.sign([anyPath], 2);
    const link = links.get(anyPath);
    const before = await net(link);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const after = await net(link);
    check('signed read link works, then expires', before.status === 200 && after.status >= 400, { before: before.status, after: after.status });
  }

  // ---------- storage boundary: no direct browser access ----------
  if (want('boundary')) {
    const userToken = await signIn('manager@s94.e2e.test');
    const anyPath = sql("select storage_path from atlas_private.marketing_media_assets where status='ready' limit 1");
    const direct = await net(`${PROJECT}/storage/v1/object/authenticated/atlas-marketing-media/${anyPath}`, { headers: { authorization: `Bearer ${userToken}`, apikey: ANON } });
    check('manager JWT cannot read an object directly', direct.status >= 400, direct.status);
    const listed = await net(`${PROJECT}/storage/v1/object/list/atlas-marketing-media`, { method: 'POST', headers: { authorization: `Bearer ${userToken}`, apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ prefix: 'venues/main', limit: 100 }) });
    const listedBody = await listed.json().catch(() => null);
    check('manager JWT cannot list the bucket', listed.status >= 400 || (Array.isArray(listedBody) && listedBody.length === 0), { status: listed.status, n: Array.isArray(listedBody) ? listedBody.length : null });
    const write = await net(`${PROJECT}/storage/v1/object/atlas-marketing-media/venues/main/2026/09/${randomUUID()}/original.jpg`, { method: 'POST', headers: { authorization: `Bearer ${userToken}`, apikey: ANON, 'content-type': 'image/jpeg' }, body: readFileSync(path.join(SAMPLES, 'bar-counter.jpg')) });
    check('manager JWT cannot write to the bucket', write.status >= 400, write.status);
    const sign = await net(`${PROJECT}/storage/v1/object/sign/atlas-marketing-media/${anyPath}`, { method: 'POST', headers: { authorization: `Bearer ${userToken}`, apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: 60 }) });
    check('manager JWT cannot mint a signed URL', sign.status >= 400, sign.status);
    const rpc = await net(`${PROJECT}/rest/v1/rpc/atlas_marketing_media_list`, { method: 'POST', headers: { authorization: `Bearer ${userToken}`, apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ p_actor_id: '5e940000-0000-4000-8000-00000000a002', p_filters: {} }) });
    check('media RPCs are not callable with a user JWT', rpc.status === 401 || rpc.status === 403 || rpc.status === 404, rpc.status);
    const posture = sqlJson(`select jsonb_build_object(
      'bucket_public', (select public from storage.buckets where id='atlas-marketing-media'),
      'marketing_media_object_policies', (select count(*) from pg_policies where schemaname='storage' and tablename='objects' and (coalesce(qual,'') || coalesce(with_check,'')) like '%atlas-marketing-media%'),
      'bucket_agnostic_object_policies', (select count(*) from pg_policies where schemaname='storage' and tablename='objects' and (coalesce(qual,'') || coalesce(with_check,'')) not like '%bucket_id = ''%'),
      'authenticated_table_grants', (select count(*) from information_schema.role_table_grants where grantee in ('authenticated','anon') and table_schema='atlas_private' and table_name like 'marketing_media%'),
      'authenticated_rpc_execute', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'atlas_marketing_media%' and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))))`);
    check('bucket private, no storage.objects policy reaches it, no anon/authenticated grants', posture.bucket_public === false && posture.marketing_media_object_policies === 0 && posture.bucket_agnostic_object_policies === 0 && posture.authenticated_table_grants === 0 && posture.authenticated_rpc_execute === 0, posture);
  }

  // ---------- orphans and logs ----------
  if (want('orphans')) {
    const orphans = sqlJson(`select jsonb_build_object(
      'objects_without_live_row', (select coalesce(jsonb_agg(o.name), '[]') from storage.objects o where o.bucket_id='atlas-marketing-media'
         and not exists (select 1 from atlas_private.marketing_media_assets a where a.storage_path=o.name and a.status in ('ready','deleted','pending_upload','verifying'))
         and not exists (select 1 from atlas_private.marketing_media_variants v where v.storage_path=o.name and v.status in ('ready','pending_upload'))),
      'ready_rows_without_object', (select count(*) from atlas_private.marketing_media_assets a where a.status='ready' and not exists (select 1 from storage.objects o where o.bucket_id='atlas-marketing-media' and o.name=a.storage_path))
        + (select count(*) from atlas_private.marketing_media_variants v where v.status='ready' and not exists (select 1 from storage.objects o where o.bucket_id='atlas-marketing-media' and o.name=v.storage_path)),
      'rejected_or_abandoned_with_object', (select count(*) from atlas_private.marketing_media_assets a where a.status in ('rejected','abandoned') and exists (select 1 from storage.objects o where o.bucket_id='atlas-marketing-media' and o.name=a.storage_path)))`);
    check('no orphan objects, no ready rows without objects, no kept rejected bytes', orphans.objects_without_live_row.length === 0 && orphans.ready_rows_without_object === 0 && orphans.rejected_or_abandoned_with_object === 0, orphans);
    const files = sqlJson(`select coalesce(jsonb_agg(name), '[]') from storage.objects where bucket_id='atlas-marketing-media'`);
    const disk = path.join(WORK, 'storage-data');
    const onDisk = existsSync(disk) ? walk(disk).filter((file) => /\/original\.|\/v\//.test(file) && !file.endsWith('.json')) : []; // .json: the TUS store's upload info
    check('objects on disk match storage.objects one to one (file backend)', files.length === onDisk.length && files.every((name) => onDisk.some((file) => file.includes(`/${name}/`))), { rows: files.length, disk: onDisk.length });
  }
  if (want('logs')) {
    const fnLog = readFileSync(path.join(WORK, 'functions.log'), 'utf8');
    const stackLog = readFileSync(path.join(WORK, 'stack.log'), 'utf8');
    const leaks = [/eyJ[A-Za-z0-9_-]{10,}/, /token=/, /venues\/main\//, new RegExp(env.E2E_JWT_SECRET), /s94-e2e-password/].filter((pattern) => pattern.test(fnLog));
    check(`function logs (${fnLog.split('\n').filter(Boolean).length} lines) carry no token, secret, password or storage path`, leaks.length === 0, leaks.map(String));
    const stackLeaks = [/eyJ[A-Za-z0-9_-]{10,}/, /token=/, new RegExp(env.E2E_JWT_SECRET)].filter((pattern) => pattern.test(stackLog));
    check('proxy access log carries no token or secret', stackLeaks.length === 0, stackLeaks.map(String));
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(JSON.stringify({ s94_media_gateway_e2e: failed.length ? 'failed' : 'passed', passed: results.length - failed.length, failed: failed.length, failures: failed.map((entry) => entry.name) }));
  process.exitCode = failed.length ? 1 : 0;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full)); else out.push(full);
  }
  return out;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
