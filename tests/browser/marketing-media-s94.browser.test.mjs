// S94A Media tab (apps/web/assets/js/marketing-media.js; UX spec §4):
// uploads of a photo and a video through the queue (single PUT and TUS with a
// mocked Storage), progress, cancel and retry, client-side refusals, filters,
// the collection builder with reorder, the picker, asset detail edits, the
// deletion guard, phone 390 and the manager-only boundary.
//
// The Media tab is mounted in isolation (AtlasMarketingMedia.mount on a host
// inside the Marketing page), so the test does not depend on how the
// Marketing module lays out its tabs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, SUPABASE, harnessAvailable, launchAtlas, requestsTo, settle, until, USERS } from './harness.mjs';
import { teamCBackend, NOW } from './teamc-fixtures.mjs';
import { JPEG_12x8_BASE64, MP4_1080x1920_24s_BASE64, PNG_8x8_BASE64 } from '../fixtures/s94/media-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const PHONE = { width: 390, height: 844 };
const MIB = 1024 * 1024;
const JPEG = Buffer.from(JPEG_12x8_BASE64, 'base64');
const MP4 = Buffer.from(MP4_1080x1920_24s_BASE64, 'base64');
const PNG = Buffer.from(PNG_8x8_BASE64, 'base64');
const MANAGER = { id: '7d3c1f10-0000-4000-8000-000000000094', email: 'mgr@example.test', display_name: 'Maria Manager', role: 'manager', active: true };

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

// A fake atlas-marketing-media gateway plus a fake Storage (single PUT, TUS,
// signed reads). `controls` lets a test fail or hold one transfer.
function mediaBackend({ assets: seedAssets = [], collections: seedCollections = [], tags = [] } = {}) {
  let next = 100;
  const assets = new Map(seedAssets.map((asset) => [asset.id, { status: 'ready', used_count: 0, tags: [], ...asset }]));
  const collections = new Map(seedCollections.map((collection) => [collection.id, collection]));
  const reservations = new Map();
  const objects = new Map();
  const uploads = [];
  const tus = { created: [], patches: [], heads: 0 };
  const controls = { failPuts: 0, hold: null };
  const signed = (id) => `${SUPABASE}/storage/v1/object/sign/atlas-marketing-media/venues/main/2026/09/${id}/thumb.jpg?token=read`;
  const view = (asset) => ({ ...asset, thumb_url: asset.kind === 'image' || asset.poster ? signed(asset.id) : null });
  const collectionView = (collection) => ({
    ...collection, count: collection.asset_ids.length,
    items: collection.asset_ids.map((id, position) => ({ asset_id: id, position, kind: assets.get(id)?.kind, name: assets.get(id)?.name, status: 'ready', archived: false, thumb_url: signed(id) }))
  });

  function gateway(entry) {
    const params = new URL(`http://x${entry.search}`).searchParams;
    const body = entry.body || {};
    const action = entry.action;
    if (action === 'list') {
      let rows = [...assets.values()].filter((asset) => asset.status === 'ready');
      if (params.get('kind')) rows = rows.filter((asset) => asset.kind === params.get('kind'));
      if (params.get('used')) rows = rows.filter((asset) => (asset.used_count > 0) === (params.get('used') === 'used'));
      if (params.get('q')) rows = rows.filter((asset) => asset.name.toLowerCase().includes(params.get('q').toLowerCase()));
      for (const tag of params.getAll('tag')) rows = rows.filter((asset) => asset.tags.some((entryTag) => entryTag.slug === tag));
      return { assets: rows.map(view), total: rows.length, next_cursor: null, tags, counts: { all: rows.length }, collections_count: collections.size };
    }
    if (action === 'asset') {
      const asset = assets.get(params.get('id'));
      if (!asset) return { __status: 404, body: { error_code: 'not_found', message: 'That photo or video could not be found.' } };
      return { asset: { ...view(asset), preview_url: asset.kind === 'image' ? signed(asset.id) : null, variants: asset.variants || [], used_in: asset.used_in || [], crops: asset.crops || {} } };
    }
    if (action === 'collections') return { collections: [...collections.values()].filter((collection) => !collection.archived).map(collectionView) };
    if (action === 'reserve') {
      const existing = [...reservations.values()].find((entryReservation) => entryReservation.request === body.client_request_id);
      const id = existing?.id || uuid(next += 1);
      const path = `venues/main/2026/09/${id}/original.${{ 'image/jpeg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4', 'video/quicktime': 'mov' }[body.mime_type] || 'bin'}`;
      if (!existing) {
        reservations.set(id, { id, request: body.client_request_id, path, body });
        assets.set(id, { id, status: 'pending_upload', kind: body.mime_type.startsWith('video/') ? 'video' : 'image', name: body.original_filename, mime_type: body.mime_type, byte_size: body.byte_size, width: body.client_hints?.width ?? null, height: body.client_hints?.height ?? null, duration_ms: body.client_hints?.duration_ms ?? null, used_count: 0, tags: [] });
      }
      const upload = body.byte_size <= 6 * MIB
        ? { method: 'put', url: `${SUPABASE}/storage/v1/object/upload/sign/atlas-marketing-media/${path}?token=tok-${id}`, token: `tok-${id}`, expires_at: '2026-09-24T16:00:00.000Z' }
        : { method: 'tus', url: `${SUPABASE}/storage/v1/upload/resumable`, token: `tok-${id}`, expires_at: '2026-09-24T16:00:00.000Z', chunk_size: 6 * MIB, bucket: 'atlas-marketing-media', object_name: path };
      return { asset: { id, status: 'pending_upload' }, upload, replayed: Boolean(existing) };
    }
    if (action === 'complete') {
      const reservation = reservations.get(body.asset_id);
      const size = objects.get(reservation.path);
      if (size === undefined) return { __status: 409, body: { error_code: 'upload_missing', message: 'The upload hasn’t arrived yet.' } };
      if (size !== reservation.body.byte_size) return { __status: 422, body: { error_code: 'size_mismatch', message: 'The uploaded file didn’t match.' } };
      const asset = assets.get(body.asset_id);
      Object.assign(asset, { status: 'ready', ...(asset.kind === 'video' ? { width: 1080, height: 1920, duration_ms: 24000 } : {}) });
      return { asset: view(asset) };
    }
    if (action === 'abandon') {
      const asset = assets.get(body.asset_id);
      if (asset) asset.status = 'abandoned';
      return { asset_id: body.asset_id, status: 'abandoned' };
    }
    if (action === 'reserve-variant') {
      const id = uuid(next += 1);
      const path = `venues/main/2026/09/${body.asset_id}/v/${id}.jpg`;
      reservations.set(id, { id, request: body.client_request_id, path, body, variant: true });
      return { variant: { id, purpose: body.purpose, status: 'pending_upload' }, upload: { method: 'put', url: `${SUPABASE}/storage/v1/object/upload/sign/atlas-marketing-media/${path}?token=tok-${id}`, token: `tok-${id}`, expires_at: '2026-09-24T16:00:00.000Z' } };
    }
    if (action === 'complete-variant') {
      const reservation = reservations.get(body.variant_id);
      const asset = assets.get(reservation.body.asset_id);
      if (reservation.body.purpose === 'poster') asset.poster = true;
      asset.variants = [...(asset.variants || []), { id: body.variant_id, purpose: reservation.body.purpose, aspect_ratio: reservation.body.aspect_ratio || null, width: reservation.body.width, height: reservation.body.height, url: signed(asset.id) }];
      return { variant: { id: body.variant_id, purpose: reservation.body.purpose, status: 'ready', url: signed(asset.id) } };
    }
    if (action === 'update') {
      const asset = assets.get(body.asset_id);
      if ('alt_text' in body) asset.alt_text = body.alt_text;
      if ('title' in body) asset.name = body.title;
      if ('focal_point' in body) asset.focal_point = body.focal_point;
      if ('tags' in body) asset.tags = body.tags.map((label) => ({ slug: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label }));
      if ('crops' in body) asset.crops = { ...(asset.crops || {}), ...body.crops };
      return { asset: view(asset) };
    }
    if (action === 'delete') {
      const asset = assets.get(body.asset_id);
      if (asset.delete_block) return { __status: 409, body: { error_code: 'in_use', message: 'It’s used in a post.' } };
      asset.status = 'deleted';
      return { asset: view(asset), detached: 0 };
    }
    if (action === 'collection-upsert') {
      const collection = body.id ? collections.get(body.id) : { id: uuid(next += 1), name: body.name, asset_ids: [] };
      if (body.name) collection.name = body.name;
      if (body.asset_ids) collection.asset_ids = [...body.asset_ids];
      collections.set(collection.id, collection);
      return { collection: collectionView(collection) };
    }
    if (action === 'collection-reorder') {
      const collection = collections.get(body.collection_id);
      if ([...body.asset_ids].sort().join() !== [...collection.asset_ids].sort().join()) return { __status: 400, body: { error_code: 'invalid_request' } };
      collection.asset_ids = [...body.asset_ids];
      return { collection: collectionView(collection) };
    }
    if (action === 'collection-archive') {
      collections.get(body.collection_id).archived = true;
      return { collection: collectionView(collections.get(body.collection_id)) };
    }
    return { __status: 404, body: { error_code: 'not_found' } };
  }

  async function storage(entry, request) {
    const method = entry.method;
    const signPrefix = '/storage/v1/object/upload/sign/atlas-marketing-media/';
    if (method === 'GET' && entry.path.startsWith('/storage/v1/object/sign/')) return { __raw: { status: 200, contentType: 'image/jpeg', body: JPEG } };
    if (method === 'PUT' && entry.path.startsWith(signPrefix)) {
      const path = decodeURIComponent(entry.path.slice(signPrefix.length));
      const bytes = request.postDataBuffer() || Buffer.alloc(0);
      const headers = request.headers();
      uploads.push({ path, size: bytes.length, contentType: headers['content-type'], upsert: headers['x-upsert'], token: new URLSearchParams(entry.search).get('token') });
      if (controls.hold && controls.hold.match(path)) await controls.hold.promise;
      if (controls.failPuts > 0 && !path.includes('/v/')) { controls.failPuts -= 1; return { __status: 500, body: { message: 'storage down' } }; }
      objects.set(path, bytes.length);
      return { Key: `atlas-marketing-media/${path}` };
    }
    if (method === 'POST' && entry.path === '/storage/v1/upload/resumable') {
      const headers = request.headers();
      const metadata = Object.fromEntries(String(headers['upload-metadata'] || '').split(',').map((pair) => pair.trim().split(' ')).map(([key, value]) => [key, Buffer.from(value || '', 'base64').toString('utf8')]));
      const id = `up-${tus.created.length + 1}`;
      tus.created.push({ id, length: Number(headers['upload-length']), signature: headers['x-signature'], resumable: headers['tus-resumable'], metadata, offset: 0 });
      return { __status: 201, headers: { location: `${SUPABASE}/storage/v1/upload/resumable/${id}`, 'tus-resumable': '1.0.0' } };
    }
    const tusMatch = /^\/storage\/v1\/upload\/resumable\/(up-\d+)$/.exec(entry.path);
    if (tusMatch) {
      const upload = tus.created.find((created) => created.id === tusMatch[1]);
      if (method === 'HEAD') { tus.heads += 1; return { __status: 200, headers: { 'upload-offset': String(upload.offset), 'upload-length': String(upload.length) } }; }
      if (method === 'PATCH') {
        const headers = request.headers();
        const bytes = request.postDataBuffer() || Buffer.alloc(0);
        tus.patches.push({ id: upload.id, offset: Number(headers['upload-offset']), size: bytes.length, contentType: headers['content-type'], signature: headers['x-signature'] });
        if (controls.hold && controls.hold.match(`tus:${tus.patches.length}`)) await controls.hold.promise;
        upload.offset += bytes.length;
        if (upload.offset >= upload.length) objects.set(upload.metadata.objectName, upload.length);
        return { __status: 204, headers: { 'upload-offset': String(upload.offset), 'tus-resumable': '1.0.0' } };
      }
    }
    return null;
  }

  function hold(match) {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    controls.hold = { match, promise };
    return () => { controls.hold = null; release(); };
  }

  return { gateway, storage, assets, collections, uploads, tus, controls, hold };
}

async function launchMedia({ user = USERS.admin, viewport, media = mediaBackend() } = {}) {
  const backend = teamCBackend({ user, overrides: { functions: { 'atlas-marketing-media': (entry) => media.gateway(entry) } } });
  const fixtures = { ...backend.fixtures, profiles: [...Object.values(USERS), MANAGER], storage: (entry, request) => media.storage(entry, request) };
  const session = await launchAtlas({ user, fixtures, hash: '#marketing', viewport, fixedTime: Date.parse(NOW) });
  const { page } = session;
  // config.js loads the module after window load; inject it only if it has not arrived.
  const loaded = await page.waitForFunction(() => Boolean(window.AtlasMarketingMedia?.mount), null, { timeout: 5000 }).then(() => true, () => false);
  if (!loaded) await page.addScriptTag({ url: `${ORIGIN}/assets/js/marketing-media.js` });
  await page.waitForFunction(() => Boolean(window.AtlasMarketingMedia?.mount));
  await page.evaluate(() => {
    const view = document.getElementById('marketing-view');
    view.hidden = true;
    const host = document.createElement('div');
    host.id = 'mm-test-host';
    view.after(host);
    window.__mm = window.AtlasMarketingMedia.mount(host, { mode: 'library' });
  });
  await settle(page);
  return { ...session, media };
}

const readyAsset = (n, overrides = {}) => ({ id: uuid(n), kind: 'image', name: `photo-${n}.jpg`, mime_type: 'image/jpeg', byte_size: 633, width: 1080, height: 1350, used_count: 0, tags: [], ...overrides });

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

// ---------- uploads ----------

test('Media: a photo and a video upload through the queue straight to Storage and appear as tiles', { skip }, async () => {
  const { page, record, media, close } = await launchMedia();
  try {
    await page.waitForSelector('#mm-test-host .atlas-empty');
    assert.match(await page.textContent('#mm-test-host .atlas-empty'), /No photos or videos yet/);
    await page.setInputFiles('#mm-test-host [data-mm-file]', [
      { name: 'espresso-martini.jpg', mimeType: 'image/jpeg', buffer: JPEG },
      { name: 'quiz-night.mp4', mimeType: 'video/mp4', buffer: MP4 }
    ]);
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 2);
    await settle(page);
    const reserves = requestsTo(record, 'atlas-marketing-media', 'reserve');
    assert.equal(reserves.length, 2);
    const photo = reserves.find((entry) => entry.body.mime_type === 'image/jpeg');
    const video = reserves.find((entry) => entry.body.mime_type === 'video/mp4');
    assert.equal(photo.body.byte_size, JPEG.length);
    assert.deepEqual({ width: photo.body.client_hints.width, height: photo.body.client_hints.height }, { width: 12, height: 8 });
    assert.match(photo.body.client_sha256, /^[0-9a-f]{64}$/);
    assert.equal(video.body.byte_size, MP4.length);
    // Bytes went to Storage with the one-time token, never through the gateway, never upserting.
    const masters = media.uploads.filter((upload) => /original\./.test(upload.path));
    assert.deepEqual(masters.map((upload) => upload.size).sort((a, b) => a - b), [JPEG.length, MP4.length].sort((a, b) => a - b));
    assert.ok(masters.every((upload) => upload.upsert === 'false' && /^tok-/.test(upload.token)));
    assert.equal(masters.find((upload) => upload.path.endsWith('.jpg')).contentType, 'image/jpeg');
    assert.equal(requestsTo(record, 'atlas-marketing-media', 'complete').length, 2);
    // A JPEG thumbnail variant was made in the browser for the photo.
    const variants = requestsTo(record, 'atlas-marketing-media', 'reserve-variant');
    assert.ok(variants.some((entry) => entry.body.purpose === 'thumb' && entry.body.mime_type === 'image/jpeg'));
    assert.ok(!variants.some((entry) => entry.body.purpose === 'publish'), 'a JPEG master needs no publish copy');
    assert.ok(media.uploads.some((upload) => upload.path.includes('/v/')));
    assert.equal(await page.$('#mm-test-host [data-mm-queue]'), null, 'the queue empties when every file is done');
    const toast = await page.textContent('.atlas-toast');
    assert.match(toast, /2 files uploaded\./);
    const videoTile = await page.getAttribute('#mm-test-host .mk-asset[aria-label^="quiz-night.mp4"]', 'aria-label');
    assert.match(videoTile, /video, not used yet/);
    assert.match(await page.textContent('#mm-test-host .mk-asset[aria-label^="quiz-night.mp4"] .mk-asset__badge'), /0:24/);
    assert.deepEqual(record.pageErrors, []);
  } finally {
    await close();
  }
});

test('Media: a PNG gets a JPEG publish copy; files over 6 MiB go by TUS in 6 MB chunks with progress', { skip }, async () => {
  const { page, record, media, close } = await launchMedia();
  try {
    await page.setInputFiles('#mm-test-host [data-mm-file]', [{ name: 'menu-board.png', mimeType: 'image/png', buffer: PNG }]);
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 1);
    await settle(page);
    assert.ok(requestsTo(record, 'atlas-marketing-media', 'reserve-variant').some((entry) => entry.body.purpose === 'publish' && entry.body.mime_type === 'image/jpeg'));

    const release = media.hold((key) => key === 'tus:2');
    // A 7 MiB "video" built in the page (MP4 header + padding), not pushed through setInputFiles.
    await page.evaluate(({ header }) => {
      const bytes = new Uint8Array(7 * 1024 * 1024);
      bytes.set(Uint8Array.from(atob(header), (c) => c.charCodeAt(0)));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'long-reel.mp4', { type: 'video/mp4' }));
      const input = document.querySelector('#mm-test-host [data-mm-file]');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { header: MP4_1080x1920_24s_BASE64 });
    await until(() => media.tus.patches.length === 2, { message: 'second TUS chunk' });
    await page.waitForFunction(() => Number(document.querySelector('#mm-test-host [data-mm-job] [role="progressbar"]')?.getAttribute('aria-valuenow')) >= 85);
    const row = await page.textContent('#mm-test-host [data-mm-job]');
    assert.match(row, /long-reel\.mp4/);
    assert.match(row, /%\s·\s6\.0 MB of 7\.0 MB/);
    release();
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 2);
    const created = media.tus.created[0];
    assert.equal(created.length, 7 * MIB);
    assert.equal(created.resumable, '1.0.0');
    assert.match(created.signature, /^tok-/, 'the signed upload token goes in x-signature');
    assert.equal(created.metadata.bucketName, 'atlas-marketing-media');
    assert.match(created.metadata.objectName, /^venues\/main\/2026\/09\/.+\/original\.mp4$/);
    assert.equal(created.metadata.contentType, 'video/mp4');
    assert.deepEqual(media.tus.patches.map((patch) => [patch.offset, patch.size]), [[0, 6 * MIB], [6 * MIB, MIB]]);
    assert.ok(media.tus.patches.every((patch) => patch.contentType === 'application/offset+octet-stream' && patch.signature === created.signature));
    assert.deepEqual(record.pageErrors, []);
  } finally {
    await close();
  }
});

test('Media: cancel stops an upload and abandons it; a failed upload retries with the same reservation', { skip }, async () => {
  const { page, record, media, close } = await launchMedia();
  try {
    const release = media.hold((path) => path.endsWith('original.jpg'));
    await page.setInputFiles('#mm-test-host [data-mm-file]', [{ name: 'hold-me.jpg', mimeType: 'image/jpeg', buffer: JPEG }]);
    await until(() => media.uploads.some((upload) => upload.path.endsWith('original.jpg')), { message: 'the held PUT' });
    await page.click('#mm-test-host [aria-label="Cancel upload of hold-me.jpg"]');
    await until(() => requestsTo(record, 'atlas-marketing-media', 'abandon').length === 1, { message: 'abandon' });
    release();
    await page.waitForFunction(() => !document.querySelector('#mm-test-host [data-mm-job]'));
    const reserved = requestsTo(record, 'atlas-marketing-media', 'reserve')[0];
    const abandoned = requestsTo(record, 'atlas-marketing-media', 'abandon')[0];
    assert.equal(abandoned.body.asset_id, [...media.assets.values()].find((asset) => asset.name === 'hold-me.jpg').id);
    assert.equal(requestsTo(record, 'atlas-marketing-media', 'complete').length, 0, 'a cancelled upload is never completed');
    assert.ok(reserved);

    media.controls.failPuts = 1;
    await page.setInputFiles('#mm-test-host [data-mm-file]', [{ name: 'flaky.jpg', mimeType: 'image/jpeg', buffer: JPEG }]);
    await page.waitForSelector('#mm-test-host [data-mm-job][data-mm-state="failed"]');
    assert.match(await page.textContent('#mm-test-host [data-mm-job][data-mm-state="failed"]'), /The upload stopped\. The other files are fine\. Retry this one\./);
    await page.click('#mm-test-host [data-mm-retry]');
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 1);
    const flaky = requestsTo(record, 'atlas-marketing-media', 'reserve').filter((entry) => entry.body.original_filename === 'flaky.jpg');
    assert.equal(flaky.length, 2);
    assert.equal(flaky[0].body.client_request_id, flaky[1].body.client_request_id, 'retry replays the same reservation');
    assert.deepEqual(record.pageErrors, []);
  } finally {
    await close();
  }
});

test('Media: SVG, PDF and oversized files are refused in the browser before anything is reserved', { skip }, async () => {
  const { page, record, close } = await launchMedia();
  try {
    await page.setInputFiles('#mm-test-host [data-mm-file]', [
      { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') },
      { name: 'menu.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }
    ]);
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(31 * 1024 * 1024)], 'huge.jpg', { type: 'image/jpeg' }));
      const input = document.querySelector('#mm-test-host [data-mm-file]');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host [data-mm-job][data-mm-state="failed"]').length === 3);
    const text = await page.textContent('#mm-test-host [data-mm-queue]');
    assert.match(text, /logo\.svg isn’t a photo or video\. Choose a JPEG, PNG, HEIC, MP4 or MOV file\./);
    assert.match(text, /menu\.pdf isn’t a photo or video/);
    assert.match(text, /huge\.jpg is larger than 30 MB\. Nothing was uploaded\./);
    assert.equal(await page.$('#mm-test-host [data-mm-retry]'), null, 'a refused file cannot be retried');
    assert.equal(requestsTo(record, 'atlas-marketing-media', 'reserve').length, 0);
    await page.click('#mm-test-host [aria-label="Remove logo.svg from uploads"]');
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host [data-mm-job]').length === 2);
  } finally {
    await close();
  }
});

// ---------- library ----------

test('Media: filters (Photos, Videos, Used, Unused), tag menu and search send the gateway filters', { skip }, async () => {
  const media = mediaBackend({
    assets: [
      readyAsset(1, { name: 'espresso-martini.jpg', used_count: 2, tags: [{ slug: 'cocktails', label: 'Cocktails' }] }),
      readyAsset(2, { name: 'quiz-night.mp4', kind: 'video', mime_type: 'video/mp4', duration_ms: 24000 }),
      readyAsset(3, { name: 'terrace.jpg' })
    ],
    tags: [{ slug: 'cocktails', label: 'Cocktails', count: 1 }]
  });
  const { page, record, close } = await launchMedia({ media });
  try {
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 3);
    assert.match(await page.getAttribute('#mm-test-host .mk-asset[aria-label^="espresso"]', 'aria-label'), /photo, used in 2 posts/);
    const lastList = () => new URL(`http://x${requestsTo(record, 'atlas-marketing-media', 'list').at(-1).search}`).searchParams;
    await page.click('#mm-test-host [data-mm-filter="video"]');
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 1);
    assert.equal(lastList().get('kind'), 'video');
    assert.equal(await page.getAttribute('#mm-test-host [data-mm-filter="video"]', 'aria-pressed'), 'true');
    await page.click('#mm-test-host [data-mm-filter="used"]');
    await page.waitForFunction(() => document.querySelector('#mm-test-host .mk-asset')?.getAttribute('aria-label').startsWith('espresso'));
    assert.equal(lastList().get('used'), 'used');
    assert.equal(lastList().get('kind'), null);
    await page.click('#mm-test-host [data-mm-filter="unused"]');
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 2);
    await page.click('#mm-test-host [data-mm-filter="all"]');
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 3);
    await page.click('#mm-test-host [data-mm-tag-trigger]');
    await page.click('#mm-test-host [data-mm-tag="cocktails"]');
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 1);
    assert.deepEqual(lastList().getAll('tag'), ['cocktails']);
    assert.ok(await page.$('#mm-test-host [aria-label="Remove tag filter Cocktails"]'));
    await page.click('#mm-test-host [aria-label="Remove tag filter Cocktails"]');
    await page.fill('#mm-test-host [data-mm-search]', 'terrace');
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 1 && document.querySelector('#mm-test-host .mk-asset').getAttribute('aria-label').startsWith('terrace'));
    assert.equal(lastList().get('q'), 'terrace');
    await page.fill('#mm-test-host [data-mm-search]', 'nothing-like-this');
    await page.waitForSelector('#mm-test-host .atlas-empty');
    assert.match(await page.textContent('#mm-test-host .atlas-empty'), /No photos or videos match “nothing-like-this”\./);
    await page.click('#mm-test-host [data-mm-clear]');
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 3);
    await page.selectOption('#mm-test-host [data-mm-sort]', 'name');
    await until(() => lastList().get('sort') === 'name', { message: 'sort by name' });
  } finally {
    await close();
  }
});

test('Media: the collection builder creates a collection from the picker and reorders by explicit array', { skip }, async () => {
  const media = mediaBackend({ assets: [readyAsset(1, { name: 'first.jpg' }), readyAsset(2, { name: 'second.jpg' }), readyAsset(3, { name: 'third.jpg', kind: 'video', mime_type: 'video/mp4', duration_ms: 9000 })] });
  const { page, record, close } = await launchMedia({ media });
  try {
    await page.click('#mm-test-host [data-mm-filter="collections"]');
    await page.waitForSelector('#mm-test-host .atlas-empty');
    assert.match(await page.textContent('#mm-test-host .atlas-empty'), /No collections yet/);
    await page.click('#mm-test-host [data-mm-new-collection]');
    await page.waitForSelector('#mm-collection-sheet [data-mm-col-name]');
    await page.click('#mm-collection-sheet [data-mm-col-save]');
    assert.equal(await page.isVisible('#mm-col-name-error'), true, 'a collection needs a name');
    await page.fill('#mm-collection-sheet [data-mm-col-name]', 'Autumn carousel');
    await page.click('#mm-collection-sheet [data-mm-col-add]');
    await page.waitForFunction(() => document.querySelectorAll('#mm-picker-sheet .mk-asset').length === 3);
    await page.click('#mm-picker-sheet .mk-asset[aria-label^="second.jpg"]');
    await page.click('#mm-picker-sheet .mk-asset[aria-label^="first.jpg"]');
    await page.click('#mm-picker-sheet .mk-asset[aria-label^="third.jpg"]');
    assert.equal((await page.textContent('#mm-picker-sheet [data-mm-pick-done]')).trim(), 'Add 3');
    await page.click('#mm-picker-sheet [data-mm-pick-done]');
    await page.waitForFunction(() => !document.getElementById('mm-picker-sheet') && document.querySelectorAll('#mm-collection-sheet [data-mm-col-item]').length === 3);
    const order = () => page.$$eval('#mm-collection-sheet [data-mm-col-item] .atlas-row__title', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(await order(), ['second.jpg', 'first.jpg', 'third.jpg']);
    assert.match(await page.textContent('#mm-collection-sheet [data-mm-col-item]'), /1 of 3 · Cover/);
    await page.click('#mm-collection-sheet [aria-label="Move first.jpg up"]');
    assert.deepEqual(await order(), ['first.jpg', 'second.jpg', 'third.jpg']);
    assert.match(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || ''), /^Move first\.jpg /, 'focus stays on the moved row');
    await until(async () => /first\.jpg moved to position 1 of 3\./.test(await page.textContent('#mm-live')), { message: 'live announcement' });
    assert.equal(await page.getAttribute('#mm-collection-sheet [aria-label="Move first.jpg up"]', 'disabled'), '');
    await page.click('#mm-collection-sheet [data-mm-col-save]');
    await page.waitForFunction(() => !document.getElementById('mm-collection-sheet'));
    const created = requestsTo(record, 'atlas-marketing-media', 'collection-upsert')[0];
    assert.deepEqual(created.body, { name: 'Autumn carousel', asset_ids: [readyAsset(1).id, readyAsset(2).id, readyAsset(3).id] });
    await page.waitForSelector('#mm-test-host .mk-collection-tile');
    assert.match(await page.getAttribute('#mm-test-host .mk-collection-tile', 'aria-label'), /Autumn carousel, collection of 3 items/);

    await page.click('#mm-test-host .mk-collection-tile');
    await page.waitForFunction(() => document.querySelectorAll('#mm-collection-sheet [data-mm-col-item]').length === 3);
    await page.click('#mm-collection-sheet [aria-label="Move third.jpg up"]');
    await page.click('#mm-collection-sheet [aria-label="Move third.jpg up"]');
    await page.click('#mm-collection-sheet [data-mm-col-save]');
    await until(() => requestsTo(record, 'atlas-marketing-media', 'collection-reorder').length === 1, { message: 'reorder' });
    assert.deepEqual(requestsTo(record, 'atlas-marketing-media', 'collection-reorder')[0].body.asset_ids, [readyAsset(3).id, readyAsset(1).id, readyAsset(2).id]);
    assert.deepEqual(record.pageErrors, []);
  } finally {
    await close();
  }
});

test('Media: pick() resolves ordered entries for a collection with collection_id', { skip }, async () => {
  const media = mediaBackend({
    assets: [readyAsset(1, { name: 'a.jpg' }), readyAsset(2, { name: 'b.jpg' })],
    collections: [{ id: uuid(50), name: 'Brunch', asset_ids: [uuid(2), uuid(1)] }]
  });
  const { page, close } = await launchMedia({ media });
  try {
    const picked = page.evaluate(() => window.AtlasMarketingMedia.pick({ multiple: true, kinds: ['image', 'video'], allowCollections: true, initialTab: 'collections' }));
    await page.waitForSelector('#mm-picker-sheet .mk-collection-tile');
    await page.click('#mm-picker-sheet .mk-collection-tile');
    const entries = await picked;
    assert.deepEqual(entries.map((entry) => [entry.asset_id, entry.collection_id, entry.collection_name, entry.kind]), [[uuid(2), uuid(50), 'Brunch', 'image'], [uuid(1), uuid(50), 'Brunch', 'image']]);
    assert.ok(entries.every((entry) => entry.thumb_url && 'variant_id' in entry && 'byte_size' in entry && 'duration_ms' in entry));
    const dismissed = page.evaluate(() => window.AtlasMarketingMedia.pick({ multiple: false, kinds: ['video'], allowCollections: false }));
    await page.waitForSelector('#mm-picker-sheet [data-mm-pick-body]');
    await page.keyboard.press('Escape');
    assert.equal(await dismissed, null);
  } finally {
    await close();
  }
});

test('Media: asset detail saves alt text, tags and the focal point; crops follow the focal point; delete is guarded', { skip }, async () => {
  const media = mediaBackend({
    assets: [
      readyAsset(1, { name: 'espresso-martini.jpg', mime_type: 'image/jpeg' }),
      readyAsset(2, { name: 'scheduled.jpg', used_count: 1, delete_block: { reason: 'in_use', count: 1 }, used_in: [{ content_id: 'c1', title: 'Friday quiz night reel', status: 'scheduled', scheduled_for: '2026-09-26T17:00:00.000Z' }] })
    ]
  });
  const { page, record, close } = await launchMedia({ media });
  try {
    await page.click('#mm-test-host .mk-asset[aria-label^="espresso-martini.jpg"]');
    await page.waitForSelector('#mm-asset-sheet [data-mm-field="alt_text"]');
    assert.match(await page.textContent('#mm-asset-sheet .atlas-sheet__desc'), /Photo · 1080 × 1350 · 633 B · uploaded by/);
    assert.equal(await page.isVisible('#mm-asset-sheet [data-mm-save]'), false, 'Save only when something changed');
    await page.fill('#mm-asset-sheet [data-mm-field="alt_text"]', 'An espresso martini on the bar');
    await page.click('#mm-asset-sheet [data-mm-tag-add]');
    await page.fill('#mm-asset-sheet .mk-tag-input', 'Cocktails');
    await page.keyboard.press('Enter');
    await page.focus('#mm-asset-sheet [data-mm-focal]');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.getAttribute('#mm-asset-sheet [data-mm-focal]', 'aria-valuetext'), '40% across, 48% down');
    await page.click('#mm-asset-sheet [data-mm-save]');
    await until(() => requestsTo(record, 'atlas-marketing-media', 'update').some((entry) => entry.body.crops), { message: 'crop copies recorded' });
    const update = requestsTo(record, 'atlas-marketing-media', 'update')[0];
    assert.deepEqual(update.body, { asset_id: uuid(1), alt_text: 'An espresso martini on the bar', tags: ['Cocktails'], focal_point: { x: 0.4, y: 0.48 } });
    const crops = requestsTo(record, 'atlas-marketing-media', 'reserve-variant').filter((entry) => entry.body.purpose === 'crop');
    assert.deepEqual(crops.map((entry) => entry.body.aspect_ratio).sort(), ['1.91:1', '16:9', '1:1', '4:3', '4:5', '9:16']);
    assert.ok(crops.every((entry) => entry.body.crop_rect.x >= 0 && entry.body.crop_rect.w > 0 && entry.body.crop_rect.x + entry.body.crop_rect.w <= 1.0001));
    const cropUpdate = requestsTo(record, 'atlas-marketing-media', 'update').find((entry) => entry.body.crops);
    assert.deepEqual(Object.keys(cropUpdate.body.crops).sort(), ['1.91:1', '16:9', '1:1', '4:3', '4:5', '9:16']);
    assert.ok(Object.values(cropUpdate.body.crops).every((crop) => crop.mode === 'auto'));
    await page.waitForFunction(() => /Saved\./.test(document.querySelector('.atlas-toast')?.textContent || ''));
    await page.click('#mm-asset-sheet .atlas-sheet__close');
    await page.waitForFunction(() => !document.getElementById('mm-asset-sheet'));

    await page.click('#mm-test-host .mk-asset[aria-label^="scheduled.jpg"]');
    await page.waitForSelector('#mm-asset-sheet [data-mm-delete]');
    assert.equal(await page.isDisabled('#mm-asset-sheet [data-mm-delete]'), true);
    assert.match(await page.textContent('#mm-delete-why'), /It’s in 1 post that is waiting, scheduled or published\. Remove it from those posts first\./);
    assert.match(await page.textContent('#mm-asset-sheet [data-mm-alt-warning]'), /Add alt text — 1 scheduled post uses this photo\./);
    assert.match(await page.textContent('#mm-asset-sheet .atlas-record-chip'), /Friday quiz night reel · scheduled/);
    assert.equal(requestsTo(record, 'atlas-marketing-media', 'delete').length, 0);
    assert.deepEqual(record.pageErrors, []);
  } finally {
    await close();
  }
});

// ---------- phone and roles ----------

test('Media at 390: three-column grid, icon Upload with a name, no sideways scroll in the tab or the detail sheet', { skip }, async () => {
  const media = mediaBackend({ assets: Array.from({ length: 7 }, (_, index) => readyAsset(index + 1, { name: `a-very-long-file-name-from-the-phone-camera-${index + 1}.jpg` })) });
  const { page, close } = await launchMedia({ viewport: PHONE, media });
  try {
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 7);
    assert.ok(await noHorizontalScroll(page));
    const columns = await page.$eval('#mm-test-host .mk-media-grid', (grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    assert.equal(columns, 3);
    assert.equal(await page.getAttribute('#mm-test-host [data-mm-upload]', 'aria-label'), 'Upload photos or videos');
    assert.equal(await page.isVisible('#mm-test-host .mk-media__upload-label'), false);
    assert.equal(await page.isVisible('#mm-test-host .mk-asset__name'), false);
    await page.setInputFiles('#mm-test-host [data-mm-file]', [{ name: 'a-very-long-file-name-from-the-phone-camera-upload.jpg', mimeType: 'image/jpeg', buffer: JPEG }]);
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 8);
    assert.ok(await noHorizontalScroll(page));
    await page.click('#mm-test-host .mk-asset');
    await page.waitForSelector('#mm-asset-sheet [data-mm-field="alt_text"]');
    assert.ok(await noHorizontalScroll(page));
    const sheet = await page.$eval('#mm-asset-sheet .atlas-sheet', (node) => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: window.innerWidth }; });
    assert.ok(sheet.left >= 0 && sheet.right <= sheet.width + 1);
  } finally {
    await close();
  }
});

test('Media: a bartender sees that Media is for managers and nothing is requested', { skip }, async () => {
  const { page, record, close } = await launchMedia({ user: USERS.bartender });
  try {
    await page.waitForSelector('#mm-test-host .atlas-empty');
    assert.match(await page.textContent('#mm-test-host .atlas-empty'), /Media is for managers/);
    assert.equal(requestsTo(record, 'atlas-marketing-media').length, 0);
  } finally {
    await close();
  }
});

test('Media: a manager can use the library', { skip }, async () => {
  const media = mediaBackend({ assets: [readyAsset(1)] });
  const { page, record, close } = await launchMedia({ user: MANAGER, media });
  try {
    await page.waitForFunction(() => document.querySelectorAll('#mm-test-host .mk-asset').length === 1);
    assert.ok(requestsTo(record, 'atlas-marketing-media', 'list').length >= 1);
  } finally {
    await close();
  }
});
