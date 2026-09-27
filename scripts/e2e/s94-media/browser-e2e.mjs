// Real apps/web in Chromium against the local stack (real Storage, PostgREST,
// the real media handler). Signs in through the sign-in form as a manager,
// opens Marketing › Media and uploads real files through the file input.
// Chromium resolves https://<ref>.supabase.co and https://<ref>.storage.supabase.co
// to the local HTTPS proxy, so requests, preflights and CORS are real.
//   source env.sh && ATLAS_BROWSER_LIBS=/path/to/node_modules node browser-e2e.mjs
// Prints one line per check and a JSON verdict; exits 1 on a failure.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { serviceKey } from './jwt.mjs';

const env = process.env;
const WORK = env.E2E_WORK;
const SAMPLES = path.join(WORK, 'samples');
const SHOTS = path.join(WORK, 'shots');
mkdirSync(SHOTS, { recursive: true });
const REF = env.E2E_REF;
const PROJECT_HOST = `${REF}.supabase.co`;
const STORAGE_HOST = `${REF}.storage.supabase.co`;
const APP = `http://localhost:${env.E2E_APP_PORT}`;
const CONTROL = `http://127.0.0.1:${env.E2E_PROXY_HTTP_PORT}`;
const SERVICE = serviceKey(env.E2E_JWT_SECRET);
const DB = env.E2E_DB;
const LIBS = env.ATLAS_BROWSER_LIBS;

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const candidate of [env.ATLAS_PLAYWRIGHT, 'playwright', path.join(path.dirname(process.execPath), '../lib/node_modules/playwright')].filter(Boolean)) {
    try { return require(candidate); } catch { /* next */ }
  }
  throw new Error('Playwright is not installed');
}
const { chromium } = loadPlaywright();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  return Boolean(ok);
}
const sql = (query) => execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', query], { encoding: 'utf8' }).trim();
const sqlJson = (query) => JSON.parse(sql(`select coalesce((${query})::text, 'null')`));
const control = (name, query = '') => fetch(`${CONTROL}/__e2e/${name}${query}`, { method: 'POST' });
const assetsNamed = (name) => sqlJson(`select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'status', a.status, 'mime', a.mime_type, 'reject', a.reject_reason,
  'variants', (select coalesce(jsonb_agg(v.purpose || ':' || v.status order by v.purpose), '[]') from atlas_private.marketing_media_variants v where v.asset_id = a.id))), '[]')
  from atlas_private.marketing_media_assets a where a.original_filename = '${name}'`);
const until = async (fn, { timeout = 60000, interval = 200, what = 'condition' } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
};

async function newSession(browser, { viewport = { width: 1440, height: 900 }, email = 'manager@s94.e2e.test', isMobile = false } = {}) {
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, serviceWorkers: 'block', isMobile, hasTouch: isMobile });
  await context.route('https://cdn.jsdelivr.net/**', (route) => (route.request().url().includes('supabase-js')
    ? route.fulfill({ contentType: 'text/javascript', body: readFileSync(path.join(LIBS, '@supabase/supabase-js/dist/umd/supabase.js')) })
    : route.fulfill({ status: 404, body: '' })));
  await context.route('https://unpkg.com/**', (route) => {
    const url = route.request().url();
    if (url.includes('lucide')) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(path.join(LIBS, 'lucide/dist/umd/lucide.min.js')) });
    if (url.includes('supabase-js')) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(path.join(LIBS, '@supabase/supabase-js/dist/umd/supabase.js')) });
    return route.fulfill({ status: 404, body: '' });
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com|api\.qrserver\.com/, (route) => route.fulfill({ status: 404, body: '' }));
  const page = await context.newPage();
  const log = { requests: [], failed: [], console: [], pageErrors: [] };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.hostname.endsWith('.supabase.co')) return;
    const headers = request.headers();
    log.requests.push({ method: request.method(), host: url.hostname, path: url.pathname, action: url.searchParams.get('action'), serviceKey: Object.values(headers).some((value) => String(value).includes(SERVICE)), status: null, request });
  });
  page.on('response', async (response) => {
    const entry = log.requests.find((item) => item.request === response.request());
    if (entry) { entry.status = response.status(); entry.acao = response.headers()['access-control-allow-origin'] ?? null; }
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    log.failed.push({ method: request.method(), host: url.hostname, path: url.pathname, action: url.searchParams.get('action'), error: request.failure()?.errorText });
  });
  page.on('console', (message) => { if (message.type() === 'error') log.console.push(message.text()); });
  page.on('pageerror', (error) => log.pageErrors.push(String(error?.message || error)));
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
  await page.goto(`${APP}/index.html`, { waitUntil: 'load' });
  await page.fill('#email', email);
  await page.fill('#password', 's94-e2e-password');
  await page.click('#login-form button[type="submit"]');
  await page.waitForFunction(() => document.body.dataset.atlasReady === 'true', null, { timeout: 30000 });
  return { context, page, log };
}

async function openMedia(page) {
  await page.evaluate(() => { window.location.hash = '#marketing/media'; });
  await page.waitForSelector('.mk-media [data-mm-body]', { timeout: 20000 });
  await page.waitForFunction(() => {
    const body = document.querySelector('.mk-media [data-mm-body]');
    return body && !body.querySelector('[aria-busy="true"]');
  }, null, { timeout: 20000 });
}
const bannerText = (page) => page.evaluate(() => document.querySelector('.mk-media [data-mm-body] .atlas-alert--danger')?.innerText ?? null);
const tiles = (page) => page.$$eval('.mk-media [data-mm-body] [data-mm-asset]', (nodes) => nodes.map((node) => ({ id: node.dataset.mmAsset, name: node.querySelector('.mk-asset__name')?.textContent, img: Boolean(node.querySelector('img')), loaded: Boolean(node.querySelector('img')?.naturalWidth) })));
const queueRows = (page) => page.$$eval('[data-mm-job]', (nodes) => nodes.map((node) => ({ id: node.dataset.mmJob, state: node.dataset.mmState, text: node.innerText })));
async function waitQueueIdle(page, timeout = 120000) {
  await until(async () => (await queueRows(page)).every((row) => ['failed'].includes(row.state)), { timeout, what: 'upload queue to finish' });
}
async function upload(page, files) {
  await page.setInputFiles('.mk-media [data-mm-file]', files.map((file) => path.join(SAMPLES, file)));
}
async function waitTilesLoaded(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.mk-media [data-mm-body] [data-mm-asset] img')].every((img) => img.complete && img.naturalWidth > 0), null, { timeout: 20000 }).catch(() => {});
}

async function main() {
  const browser = await chromium.launch({
    executablePath: env.ATLAS_CHROMIUM || undefined,
    // No proxy (the sandbox's outbound proxy would tunnel the fake hosts away):
    // only the two mapped hosts and localhost are reachable.
    env: Object.fromEntries(Object.entries(env).filter(([key]) => !/proxy/i.test(key))),
    args: ['--no-proxy-server', `--host-resolver-rules=MAP ${PROJECT_HOST} 127.0.0.1:${env.E2E_PROXY_HTTPS_PORT}, MAP ${STORAGE_HOST} 127.0.0.1:${env.E2E_PROXY_HTTPS_PORT}`],
  });
  try {
    const { page, log, context } = await newSession(browser);
    check('signed in through the real form (password grant) as a manager', true);
    await openMedia(page);
    check('Media tab loads with no red banner (empty library)', (await bannerText(page)) === null, await bannerText(page));

    // ---------- JPG, PNG, WebP, short MP4 through the UI ----------
    const since = log.requests.length;
    await upload(page, ['bar-counter.jpg', 'cocktail-menu.png', 'happy-hour.webp', 'reel-short.mp4', 'reel-vp9.mp4']);
    await waitQueueIdle(page);
    await page.waitForFunction(() => document.querySelectorAll('.mk-media [data-mm-body] [data-mm-asset]').length >= 5, null, { timeout: 30000 });
    await waitTilesLoaded(page);
    const expectations = {
      'bar-counter.jpg': { mime: 'image/jpeg', variants: ['thumb:ready'] },
      'cocktail-menu.png': { mime: 'image/png', variants: ['publish:ready', 'thumb:ready'] },
      'happy-hour.webp': { mime: 'image/webp', variants: ['publish:ready', 'thumb:ready'] },
      // Playwright's Chromium build has no H.264 decoder: the master is verified
      // and ready (server probe), but the browser cannot draw a poster frame.
      'reel-short.mp4': { mime: 'video/mp4', variants: [] },
      'reel-vp9.mp4': { mime: 'video/mp4', variants: ['poster:ready', 'thumb:ready'] },
    };
    for (const [name, expected] of Object.entries(expectations)) {
      const rows = assetsNamed(name);
      check(`${name}: one asset row, ready, ${expected.mime}, variants ${expected.variants.join(' ')}`, rows.length === 1 && rows[0].status === 'ready' && rows[0].mime === expected.mime && JSON.stringify(rows[0].variants) === JSON.stringify(expected.variants), rows);
    }
    const hop = log.requests.slice(since);
    const puts = hop.filter((entry) => entry.method === 'PUT' && entry.path.startsWith('/storage/v1/object/upload/sign/'));
    check('every Storage PUT (5 masters + 7 variants) returned 200 with CORS', puts.length === 12 && puts.every((entry) => entry.status === 200 && entry.acao === '*'), puts.map((entry) => entry.status));
    const actions = hop.filter((entry) => entry.path === '/functions/v1/atlas-marketing-media' && entry.method !== 'OPTIONS');
    check('gateway calls reserve/complete/reserve-variant/complete-variant all 200', ['reserve', 'complete', 'reserve-variant', 'complete-variant'].every((action) => actions.some((entry) => entry.action === action)) && actions.every((entry) => entry.status === 200), actions.filter((entry) => entry.status !== 200).map((entry) => `${entry.action}:${entry.status}`));
    const mediaFailures = () => log.failed.filter((entry) => entry.path === '/functions/v1/atlas-marketing-media' || entry.host === STORAGE_HOST || entry.path.startsWith('/storage/v1/'));
    check('no failed gateway or Storage request (preflights and CORS pass)', mediaFailures().length === 0, mediaFailures());
    const allTiles = await tiles(page);
    check('five tiles; every one with a thumbnail shows it loaded (H.264 reel: icon)', allTiles.length === 5 && allTiles.filter((tile) => tile.name !== 'reel-short.mp4').every((tile) => tile.loaded) && !allTiles.find((tile) => tile.name === 'reel-short.mp4').img, allTiles);

    // ---------- HEIC in Chromium: refused before any reservation ----------
    const heicSince = log.requests.length;
    await upload(page, ['iphone-terrace.heic']);
    await until(async () => (await queueRows(page)).some((row) => row.state === 'failed'), { what: 'HEIC refusal' });
    const heicRow = (await queueRows(page)).find((row) => row.state === 'failed');
    check('HEIC in Chromium: clear refusal in the queue', /can’t be read in this browser\. Export it as JPEG, or upload it from Safari on an iPhone or Mac\./.test(heicRow?.text || ''), heicRow?.text);
    check('HEIC in Chromium: no reservation, no row, nothing stored', !log.requests.slice(heicSince).some((entry) => entry.action === 'reserve') && assetsNamed('iphone-terrace.heic').length === 0);
    check('HEIC refusal has no Retry (permanent)', !(await page.$('[data-mm-retry]')));
    await page.click('[data-mm-remove]').catch(() => {});

    // ---------- large MP4 through TUS ----------
    const tusSince = log.requests.length;
    await upload(page, ['reel-large.mp4']);
    await waitQueueIdle(page, 180000);
    const tusHop = log.requests.slice(tusSince).filter((entry) => entry.host === STORAGE_HOST);
    const created = tusHop.find((entry) => entry.method === 'POST' && entry.path === '/storage/v1/upload/resumable/sign');
    const patches = tusHop.filter((entry) => entry.method === 'PATCH' && entry.path.startsWith('/storage/v1/upload/resumable/sign/'));
    check('large MP4: TUS create 201 on the direct storage host, PATCH chunks 204', created?.status === 201 && patches.length >= 3 && patches.every((entry) => entry.status === 204), { create: created?.status, patches: patches.map((entry) => entry.status) });
    const large = assetsNamed('reel-large.mp4');
    check('large MP4: row ready (server-verified; no poster: H.264 in this Chromium)', large.length === 1 && large[0].status === 'ready', large);

    // ---------- retry of a deliberately failed PUT ----------
    await control('fail-puts', '?ms=1500');
    const cutAt = Date.now();
    const retrySince = log.requests.length;
    await upload(page, ['cocktail-menu.png']);
    await until(async () => (await queueRows(page)).some((row) => row.state === 'failed'), { what: 'the cut upload to fail' });
    const failedRow = (await queueRows(page)).find((row) => row.state === 'failed');
    check('cut PUT: queue says the upload stopped, with Retry', /The upload stopped\. The other files are fine\. Retry this one\./.test(failedRow?.text || '') && Boolean(await page.$('[data-mm-retry]')), failedRow?.text);
    const pendingBefore = sqlJson(`select count(*) from atlas_private.marketing_media_assets where status = 'pending_upload'`);
    await until(() => Date.now() - cutAt > 1700, { what: 'the cut window to pass' });
    await page.click('[data-mm-retry]');
    await waitQueueIdle(page);
    const reserves = log.requests.slice(retrySince).filter((entry) => entry.action === 'reserve');
    const menuRows = assetsNamed('cocktail-menu.png');
    check('retry: same reservation replayed, upload completes, one new row only', reserves.length === 2 && menuRows.length === 2 && menuRows.every((row) => row.status === 'ready') && pendingBefore === 1 && sqlJson(`select count(*) from atlas_private.marketing_media_assets where status = 'pending_upload'`) === 0, { reserves: reserves.length, rows: menuRows.map((row) => row.status), pendingBefore });

    // ---------- attach one video to a scheduled post and one photo to a published one ----------
    const reelId = assetsNamed('reel-vp9.mp4')[0].id;
    const webpId = assetsNamed('happy-hour.webp')[0].id;
    sql(`insert into atlas_private.marketing_content_items (id, title, content_type, status, platforms) values
      ('5e940000-0000-4000-8000-0000000c0001', 'Friday reel', 'post', 'scheduled', array['instagram']),
      ('5e940000-0000-4000-8000-0000000c0002', 'Opening night', 'post', 'published', array['instagram'])`);
    sql(`insert into atlas_private.marketing_content_media (content_id, asset_id, position, added_by) values ('5e940000-0000-4000-8000-0000000c0001', '${reelId}', 0, '5e940000-0000-4000-8000-00000000a002')`);
    sql(`insert into atlas_private.marketing_content_media (content_id, asset_id, position, added_by) values ('5e940000-0000-4000-8000-0000000c0002', '${webpId}', 0, '5e940000-0000-4000-8000-00000000a002')`);
    sql(`insert into atlas_private.marketing_media_publication_uses (asset_id, content_id, platform, fetch_method, outcome) values ('${webpId}', '5e940000-0000-4000-8000-0000000c0002', 'instagram', 'signed_url', 'published')`);

    // ---------- reload ----------
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true', null, { timeout: 30000 });
    await openMedia(page);
    await waitTilesLoaded(page);
    const reloaded = await tiles(page);
    check('reload: Media tab has no red banner, 7 tiles, every thumbnail loads', (await bannerText(page)) === null && reloaded.length === 7 && reloaded.filter((tile) => tile.img).every((tile) => tile.loaded), { banner: await bannerText(page), tiles: reloaded.length, notLoaded: reloaded.filter((tile) => !tile.loaded).map((tile) => tile.name) });
    await page.screenshot({ path: path.join(SHOTS, 'media-desktop.png') });

    // ---------- search and filters ----------
    await page.fill('.mk-media [data-mm-search]', 'happy');
    await until(async () => (await tiles(page)).length === 1, { timeout: 10000, what: 'search results' }).catch(() => {});
    check('search "happy" -> one tile', (await tiles(page)).length === 1 && /happy-hour/.test((await tiles(page))[0]?.name || ''), await tiles(page));
    await page.fill('.mk-media [data-mm-search]', '');
    await until(async () => (await tiles(page)).length === 7, { timeout: 10000, what: 'search cleared' }).catch(() => {});
    const filterCount = async (key) => {
      await page.click(`.mk-media [data-mm-filter="${key}"]`);
      await page.waitForFunction((k) => document.querySelector(`.mk-media [data-mm-filter="${k}"]`)?.getAttribute('aria-pressed') === 'true' && !document.querySelector('.mk-media [data-mm-body] [aria-busy="true"]'), key);
      return tiles(page);
    };
    const photos = await filterCount('image');
    const videos = await filterCount('video');
    const used = await filterCount('used');
    const unused = await filterCount('unused');
    check('Photos filter: 4 photos', photos.length === 4, photos.map((tile) => tile.name));
    check('Videos filter: 3 videos', videos.length === 3, videos.map((tile) => tile.name));
    check('Used filter: the scheduled reel and the published photo', used.length === 2 && used.some((tile) => tile.id === reelId) && used.some((tile) => tile.id === webpId), used.map((tile) => tile.name));
    check('Unused filter: the other 5', unused.length === 5 && !unused.some((tile) => tile.id === reelId), unused.map((tile) => tile.name));
    await filterCount('all');

    // ---------- collections: select two, add to a new collection ----------
    await page.click('.mk-media [data-mm-select]');
    const [first, second] = (await tiles(page)).filter((tile) => /bar-counter|cocktail/.test(tile.name));
    await page.click(`.mk-media [data-mm-asset="${first.id}"]`);
    await page.click(`.mk-media [data-mm-asset="${second.id}"]`);
    await page.click('.mk-media [data-mm-bulk-collection]');
    await page.waitForSelector('#mm-new-collection-name');
    await page.fill('#mm-new-collection-name', 'Autumn menu');
    await page.click('[data-modal-panel] button[type="submit"]');
    await until(() => sqlJson(`select count(*) from atlas_private.marketing_media_collection_items i join atlas_private.marketing_media_collections c on c.id = i.collection_id where c.name = 'Autumn menu'`) === 2, { timeout: 10000, what: 'collection saved' }).catch(() => {});
    await page.click('.mk-media [data-mm-select]');
    const collectionTiles = await (async () => { await filterCount('collections'); return page.$$eval('.mk-media [data-mm-collection]', (nodes) => nodes.map((node) => node.getAttribute('aria-label'))); })();
    check('Collections: "Autumn menu, collection of 2 items"', collectionTiles.length === 1 && /Autumn menu, collection of 2 items/.test(collectionTiles[0]), collectionTiles);
    await filterCount('all');

    // ---------- preview ----------
    await page.click(`.mk-media [data-mm-asset="${webpId}"]`);
    await page.waitForSelector('#mm-asset-sheet [data-mm-focal-img]', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('#mm-asset-sheet [data-mm-focal-img]')?.naturalWidth > 0, null, { timeout: 15000 }).catch(() => {});
    const preview = await page.evaluate(() => { const img = document.querySelector('#mm-asset-sheet [data-mm-focal-img]'); return { w: img?.naturalWidth, h: img?.naturalHeight, desc: document.querySelector('#mm-asset-sheet [data-mm-desc]')?.textContent }; });
    check('photo preview renders the master (1080×1350) from a signed link', preview.w === 1080 && preview.h === 1350, preview);
    const protectedPhoto = await page.evaluate(() => { const button = document.querySelector('#mm-asset-sheet [data-mm-delete]'); return { disabled: button?.disabled, why: document.querySelector('#mm-delete-why')?.textContent }; });
    check('published photo: Delete disabled with the reason', protectedPhoto.disabled === true && /It has been published/.test(protectedPhoto.why || ''), protectedPhoto);
    await page.click('#mm-asset-sheet [data-modal-close]');
    await page.click(`.mk-media [data-mm-asset="${reelId}"]`);
    await page.waitForSelector('#mm-asset-sheet [data-mm-video]', { timeout: 15000 });
    await page.waitForFunction(() => (document.querySelector('#mm-asset-sheet [data-mm-video]')?.readyState ?? 0) >= 1, null, { timeout: 15000 }).catch(() => {});
    const videoPreview = await page.evaluate(() => { const video = document.querySelector('#mm-asset-sheet [data-mm-video]'); return { ready: video?.readyState, w: video?.videoWidth, h: video?.videoHeight, duration: video?.duration }; });
    check('video preview plays metadata from a signed link (1080×1920, 4 s)', videoPreview.ready >= 1 && videoPreview.w === 1080 && videoPreview.h === 1920 && Math.round(videoPreview.duration) === 4, videoPreview);
    const protectedReel = await page.evaluate(() => { const button = document.querySelector('#mm-asset-sheet [data-mm-delete]'); return { disabled: button?.disabled, why: document.querySelector('#mm-delete-why')?.textContent }; });
    check('scheduled reel: Delete disabled with the reason', protectedReel.disabled === true && /waiting, scheduled or published/.test(protectedReel.why || ''), protectedReel);
    await page.click('#mm-asset-sheet [data-modal-close]');
    // A stale screen (the block appears after it was opened): the server still refuses.
    const barId = assetsNamed('bar-counter.jpg')[0].id;
    await page.click(`.mk-media [data-mm-asset="${barId}"]`);
    await page.waitForSelector('#mm-asset-sheet [data-mm-delete]:not([disabled])', { timeout: 15000 });
    sql(`insert into atlas_private.marketing_content_media (content_id, asset_id, position, added_by) values ('5e940000-0000-4000-8000-0000000c0001', '${barId}', 1, '5e940000-0000-4000-8000-00000000a002')`);
    const staleBlock = sqlJson(`select atlas_private.marketing_media_delete_block('${barId}')`);
    await page.evaluate(() => { const region = document.getElementById('atlas-toast-region'); if (region) region.textContent = ''; });
    await page.click('#mm-asset-sheet [data-mm-delete]');
    await page.getByRole('button', { name: /^Delete photo$/ }).click();
    const toastText = await until(() => page.evaluate(() => document.getElementById('atlas-toast-region')?.textContent || ''), { timeout: 8000, what: 'toast' }).catch(() => '');
    check('delete refused server-side for media that became scheduled (toast, still ready)', staleBlock?.reason === 'in_use' && /used in a post that is waiting, scheduled or published/.test(toastText) && assetsNamed('bar-counter.jpg')[0].status === 'ready', toastText);
    sql(`delete from atlas_private.marketing_content_media where asset_id = '${barId}'`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => document.querySelectorAll('#mm-asset-sheet [data-modal-close]').forEach((button) => button.click()));

    // ---------- delete unused ----------
    await openMedia(page);
    await page.click(`.mk-media [data-mm-asset="${barId}"]`);
    await page.waitForSelector('#mm-asset-sheet [data-mm-delete]:not([disabled])', { timeout: 15000 });
    await page.click('#mm-asset-sheet [data-mm-delete]');
    await page.getByRole('button', { name: /^Delete photo$/ }).click();
    await until(() => assetsNamed('bar-counter.jpg')[0]?.status === 'deleted', { timeout: 10000, what: 'soft delete' }).catch(() => {});
    await page.waitForFunction((id) => !document.querySelector(`.mk-media [data-mm-asset="${id}"]`), barId, { timeout: 10000 }).catch(() => {});
    check('delete unused photo: soft-deleted and gone from the grid', assetsNamed('bar-counter.jpg')[0]?.status === 'deleted' && !(await page.$(`.mk-media [data-mm-asset="${barId}"]`)));

    // ---------- media service unreachable (not deployed) ----------
    await control('function-off', '?name=atlas-marketing-media');
    await page.click('.mk-media [data-mm-filter="image"]');
    await page.waitForFunction(() => document.querySelector('.mk-media [data-mm-body] .atlas-alert--danger'), null, { timeout: 20000 }).catch(() => {});
    const offline = await bannerText(page);
    const failedCalls = log.failed.filter((entry) => entry.path === '/functions/v1/atlas-marketing-media');
    check('gateway 404 without CORS (undeployed): network error in the browser; banner says Media could not be reached (not "check the connection")', /Atlas couldn’t reach Media\. Nothing was changed\. Try again in a moment\./.test(offline || '') && !/Check the connection/.test(offline || '') && failedCalls.length > 0, { banner: offline, failures: failedCalls.slice(-2) });
    writeFileSync(path.join(WORK, 'unreachable-banner.txt'), String(offline));
    await page.screenshot({ path: path.join(SHOTS, 'media-unreachable.png') });
    await upload(page, ['bar-counter.jpg']);
    await until(async () => (await queueRows(page)).some((row) => row.state === 'failed'), { what: 'the upload to fail while Media is unreachable' });
    const downRow = (await queueRows(page)).find((row) => row.state === 'failed');
    check('upload while unreachable: "couldn’t reach Media" with Retry, nothing reserved', /Atlas couldn’t reach Media, so this didn’t upload\. Retry it in a moment\./.test(downRow?.text || '') && assetsNamed('bar-counter.jpg').length === 1, downRow?.text);
    await control('function-on', '?name=atlas-marketing-media');
    await page.click('[data-mm-retry]');
    await waitQueueIdle(page);
    check('Retry once the service is back: uploaded and ready', assetsNamed('bar-counter.jpg').some((row) => row.status === 'ready'));
    await page.click('.mk-media [data-mm-reload]').catch(() => {});
    await page.waitForFunction(() => !document.querySelector('.mk-media [data-mm-body] .atlas-alert--danger') && document.querySelectorAll('.mk-media [data-mm-body] [data-mm-asset]').length > 0, null, { timeout: 20000 }).catch(() => {});
    check('Try again after the service is back: grid returns', (await bannerText(page)) === null && (await tiles(page)).length > 0);

    // ---------- secrets and console ----------
    check('no browser request carried the service key', !log.requests.some((entry) => entry.serviceKey));
    const stored = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
    check('no service key or storage path in localStorage', !stored.includes(SERVICE) && !/venues\/main\/\d{4}/.test(stored.replace(/atlas\.mm\.tus\.[^"]*/g, '')));
    const mediaConsole = log.console.filter((text) => !/Failed to load resource|net::ERR|CORS policy|atlas-(?!marketing-media)[a-z-]+/.test(text));
    check('no page errors; no unexpected console errors', log.pageErrors.length === 0 && mediaConsole.length === 0, { pageErrors: log.pageErrors, console: mediaConsole.slice(0, 5) });
    await context.close();

    // ---------- phone ----------
    const phone = await newSession(browser, { viewport: { width: 390, height: 844 }, isMobile: true });
    await openMedia(phone.page);
    await waitTilesLoaded(phone.page);
    const layout = await phone.page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth, tiles: document.querySelectorAll('.mk-media [data-mm-asset]').length, upload: Boolean(document.querySelector('.mk-media [data-mm-upload]')?.getBoundingClientRect().width) }));
    check('phone 390: no horizontal scroll, grid and Upload visible, no banner', layout.scrollWidth <= layout.width && layout.tiles >= 5 && layout.upload && (await bannerText(phone.page)) === null, layout);
    await upload(phone.page, ['happy-hour.webp']);
    await waitQueueIdle(phone.page);
    check('phone 390: upload a WebP -> ready with publish copy', assetsNamed('happy-hour.webp').some((row) => row.status === 'ready' && row.variants.includes('publish:ready') && row.id !== webpId));
    await phone.page.screenshot({ path: path.join(SHOTS, 'media-phone.png') });
    await phone.context.close();
  } finally {
    await browser.close();
  }
  const failed = results.filter((entry) => !entry.ok);
  console.log(JSON.stringify({ s94_media_browser_e2e: failed.length ? 'failed' : 'passed', passed: results.length - failed.length, failed: failed.length, failures: failed.map((entry) => entry.name) }));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
