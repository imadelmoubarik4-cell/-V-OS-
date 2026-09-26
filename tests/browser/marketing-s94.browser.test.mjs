// S94 Marketing publishing: the full operator workflow in the browser with a
// mocked, stateful atlas-marketing-workspace gateway (no provider, no worker).
// New post → Add media (library + collection order) → channels → overrides →
// previews → checks (block / warn) → schedule (Reykjavík time) → submit →
// approve → calendar month → Publish now → History per channel → Retry the
// failed channel only → cancel a future post; edit after approval asks to
// re-approve; TikTok and Google controls; roles; other browser zones; phone.
//
// window.AtlasMarketingMedia is a small test double installed before config.js
// (so the lazy loader skips the real module); its API is contract §3:
// mount, pick, upload, thumbUrl. The platform rules are the real generated
// marketing-platform-rules.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { harnessAvailable, launchAtlas, requestsTo, settle, until, USERS, HARNESS_NOW } from './harness.mjs';
import { teamCBackend } from './teamc-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const PHONE = { width: 390, height: 844 };
const MANAGER = { id: '7d3c1f10-0000-4000-8000-000000000004', email: 'mgr@example.test', display_name: 'Þórdís Ævarsdóttir', role: 'manager', active: true };
const SHOTS = process.env.ATLAS_S94_SHOTS || '';
const T0 = Date.parse(HARNESS_NOW);
const at = (hours) => new Date(T0 + hours * 3600000).toISOString();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const svg = (fill, label) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="150" viewBox="0 0 120 150"><rect width="120" height="150" fill="${fill}"/><text x="60" y="84" font-family="sans-serif" font-size="22" fill="white" text-anchor="middle">${label}</text></svg>`)}`;

const ASSETS = {
  photoA: { asset_id: uuid(501), kind: 'image', mime_type: 'image/jpeg', width: 1080, height: 1350, byte_size: 420000, thumb_url: svg('#b45309', 'A'), title: 'espresso-martini.jpg' },
  videoB: { asset_id: uuid(502), kind: 'video', mime_type: 'video/mp4', width: 1080, height: 1920, byte_size: 9000000, duration_ms: 24000, thumb_url: svg('#1d4ed8', 'B'), title: 'quiz-night.mp4' },
  photoC: { asset_id: uuid(503), kind: 'image', mime_type: 'image/jpeg', width: 1080, height: 1080, byte_size: 380000, thumb_url: svg('#047857', 'C'), title: 'autumn-menu.jpg' },
  photoD: { asset_id: uuid(504), kind: 'image', mime_type: 'image/jpeg', width: 1080, height: 1080, byte_size: 380000, thumb_url: svg('#7c3aed', 'D'), title: 'bar-top.jpg' }
};
const COLLECTION = uuid(601);

const READY_TARGETS = [
  { provider_key: 'instagram', connection_state: 'connected', publishing_permission_state: 'granted', publishing_review_state: 'approved', ready: true, reason: null, resource: { kind: 'instagram_account', id: '1784', label: 'vabar.reykjavik' }, target_kinds: ['ig_feed', 'ig_carousel', 'ig_reel'] },
  { provider_key: 'facebook', connection_state: 'connected', publishing_permission_state: 'granted', publishing_review_state: 'approved', ready: true, reason: null, resource: { kind: 'facebook_page', id: '1001', label: 'VÁ Bar' }, target_kinds: ['fb_page_post', 'fb_page_photo', 'fb_page_video', 'fb_reel'] },
  { provider_key: 'tiktok', connection_state: 'connected', publishing_permission_state: 'granted', publishing_review_state: 'approved', ready: true, reason: null, resource: { kind: 'tiktok_account', id: 'tt1', label: '@vabar.rvk' }, target_kinds: ['tiktok_inbox_video', 'tiktok_video'] },
  { provider_key: 'google-business-profile', connection_state: 'not_connected', publishing_permission_state: 'not_requested', publishing_review_state: 'unknown', ready: false, reason: 'not_connected', resource: null, target_kinds: [] }
];

const KIND = { instagram: (media) => (media.length > 1 ? 'ig_carousel' : media[0]?.kind === 'video' ? 'ig_reel' : 'ig_feed'), facebook: (media) => (!media.length ? 'fb_page_post' : media.some((m) => m.kind === 'video') ? 'fb_page_video' : 'fb_page_photo'), tiktok: () => 'tiktok_inbox_video', 'google-business-profile': () => 'gbp_local_post' };

// A stateful gateway double: enough of contract §6 to drive the workflow.
function marketingGateway({ role = 'admin', automatic = true, targets = READY_TARGETS, creator = null, failOnPublish = ['facebook'] } = {}) {
  let sequence = 900;
  const items = new Map();
  const add = (item) => items.set(item.id, { version: 1, platform_options: {}, media: [], deliveries: [], approval_history: [], can_edit: true, can_approve: true, created_by_label: 'Imad El Moubarik', priority: 'normal', ...item });
  add({ id: 'future', title: 'Sunday brunch post', content_type: 'post', status: 'scheduled', platforms: ['instagram'], scheduled_for: '2026-09-27T11:00:00.000Z', caption_draft: 'Brunch from 11.', media: [{ ...ASSETS.photoD, position: 0, role: 'cover', platform: null }], deliveries: [{ id: uuid(801), provider_key: 'instagram', target_kind: 'ig_feed', status: 'queued', due_at: '2026-09-27T11:00:00.000Z' }], publication_state: 'queued', version: 4 });
  add({ id: 'approved', title: 'Happy hour carousel', content_type: 'post', status: 'approved', platforms: ['instagram'], scheduled_for: null, caption_draft: 'Happy hour 16–18.', media: [{ ...ASSETS.photoC, position: 0, role: 'cover', platform: null }, { ...ASSETS.photoD, position: 1, role: 'item', platform: null }], publication_state: 'ready_not_sent', version: 2, approval_history: [{ decision: 'approved', actor_label: 'Imad El Moubarik', created_at: at(-3) }] });
  const calls = [];
  const staff = { id: 'x', role, can_create: true, can_approve: ['admin', 'manager'].includes(role), can_mark_published: true, can_publish: ['admin', 'manager'].includes(role), can_manage_media: true };
  const workspace = () => ({
    venue_date: '2026-09-24',
    content_items: [...items.values()].map((item) => structuredClone(item)),
    campaigns: [{ id: 'k1', name: 'Autumn menu launch', campaign_type: 'seasonal', status: 'active', platforms: ['instagram'], start_date: '2026-09-28', end_date: '2026-10-12' }],
    recommendations: [], history: [], connections: [],
    publish_targets: structuredClone(targets),
    automatic_publishing_enabled: automatic,
    attention: {}
  });
  const reply = (result = {}) => ({ result, workspace: workspace(), staff, members: [] });
  const stale = () => ({ __status: 409, body: { error: 'This post changed while you were working. It has been reloaded; check it and try again.', error_code: 'stale_request' } });
  const mediaFrom = (list = []) => list.map((entry, position) => {
    const asset = Object.values(ASSETS).find((a) => a.asset_id === entry.asset_id);
    return { ...asset, position, role: position === 0 ? 'cover' : 'item', platform: null, collection_id: entry.collection_id || null };
  });
  const handler = (entry) => {
    calls.push(entry);
    const body = entry.body || {};
    const params = new URLSearchParams(entry.search || '');
    const MANAGER_ONLY = new Set(['publish-now', 'retry-delivery', 'cancel-delivery', 'mark-delivery-posted', 'cancel-content', 'reschedule-content', 'duplicate-content', 'set-content-media', 'decide-approval', 'history', 'tiktok-creator-info', 'publish-targets']);
    if (MANAGER_ONLY.has(entry.action) && !['admin', 'manager'].includes(role)) return { __status: 403, body: { error: 'This action is limited to managers and administrators.', error_code: 'forbidden' } };
    switch (entry.action) {
      case 'snapshot': return { workspace: workspace(), staff, members: [] };
      case 'tiktok-creator-info': return { creator_info: creator || { available: true, username: 'vabar.rvk', nickname: 'VÁ Bar', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600 } };
      case 'history': {
        const item = items.get(params.get('content_id'));
        return { history: { content: { id: item.id, title: item.title, status: item.status }, deliveries: item.deliveries.map((d) => ({ ...d, attempt_count: 1, max_attempts: 6, attempts: [{ attempt_no: 1, claim_kind: 'publish', outcome: d.status === 'published' ? 'published' : 'failed', started_at: at(0), steps: [{ step: 'create_post' }] }], last_error_message: d.status === 'needs_attention' ? 'Facebook rejected the photo.' : null })), approvals: item.approval_history, revisions: [], events: [] } };
      }
      case 'create-content': {
        const id = uuid(sequence += 1);
        add({ id, title: body.title, content_type: body.content_type, status: 'draft', platforms: body.platforms || [], caption_draft: body.caption_draft, scheduled_for: body.scheduled_for, reminder_at: body.reminder_at, campaign_id: body.campaign_id, platform_options: body.platform_options || {}, media: mediaFrom(body.media) });
        return reply({ id, content_id: id, duplicate: false, content: { id, version: 1 } });
      }
      case 'update-content': {
        const item = items.get(body.content_id);
        if (body.version != null && body.version !== item.version) return stale();
        const material = ['approved', 'scheduled'].includes(item.status);
        for (const key of ['title', 'campaign_id', 'platforms', 'caption_draft', 'scheduled_for', 'reminder_at', 'platform_options']) if (key in body) item[key] = body[key];
        item.version += 1;
        if (material) { item.status = 'draft'; item.deliveries = item.deliveries.map((d) => ({ ...d, status: 'cancelled' })); item.publication_state = 'none'; }
        return reply({ content: { id: item.id, version: item.version }, approval_invalidated: material });
      }
      case 'set-content-media': { const item = items.get(body.content_id); item.media = mediaFrom(body.items); item.version += 1; return reply({ ok: true }); }
      case 'submit-approval': { const item = items.get(body.content_id); item.status = 'pending_approval'; item.approval_history.unshift({ decision: 'submitted', actor_label: 'Imad El Moubarik', note: body.note, created_at: at(0) }); return reply({ content: { id: item.id } }); }
      case 'decide-approval': {
        const item = items.get(body.content_id);
        item.approval_history.unshift({ decision: body.decision, actor_label: 'Imad El Moubarik', note: body.note, created_at: at(0) });
        if (body.decision === 'approved') {
          item.status = item.scheduled_for ? 'scheduled' : 'approved';
          item.deliveries = item.platforms.map((platform, i) => ({ id: uuid(700 + (sequence += 1) + i), provider_key: platform, target_kind: item.platform_options?.[platform]?.target_kind || KIND[platform](item.media), status: 'queued', due_at: item.scheduled_for }));
          item.publication_state = automatic ? 'queued' : 'ready_not_sent';
        } else item.status = body.decision;
        return reply({ content: { id: item.id } });
      }
      case 'publish-now': {
        if (!automatic) return { __status: 409, body: { error: 'Automatic publishing is off. An administrator can turn it on in Settings › Marketing.', error_code: 'automatic_publishing_disabled' } };
        const item = items.get(body.content_id);
        // The worker's result, as the next snapshot would show it.
        item.deliveries = item.deliveries.map((d) => (failOnPublish.includes(d.provider_key)
          ? { ...d, status: 'needs_attention', attention_reason: 'provider_rejected' }
          : { ...d, status: 'published', published_at: at(0), provider_permalink: `https://www.${d.provider_key}.com/p/${d.id.slice(-4)}` }));
        item.publication_state = item.deliveries.every((d) => d.status === 'published') ? 'published' : 'partial';
        return reply({ status: 'queued', wake: true, deliveries: item.deliveries });
      }
      case 'retry-delivery': {
        const item = [...items.values()].find((x) => x.deliveries.some((d) => d.id === body.delivery_id));
        item.deliveries = item.deliveries.map((d) => (d.id === body.delivery_id ? { ...d, status: 'queued', attention_reason: null } : d));
        return reply({ ok: true, action: 'retry' });
      }
      case 'cancel-content': { const item = items.get(body.content_id); item.status = 'cancelled'; item.deliveries = item.deliveries.map((d) => ({ ...d, status: 'cancelled' })); return reply({ content: { id: item.id } }); }
      case 'duplicate-content': { const source = items.get(body.content_id); const id = uuid(sequence += 1); add({ ...structuredClone(source), id, status: 'draft', deliveries: [], scheduled_for: null, publication_state: 'none', version: 1 }); return reply({ content: { id } }); }
      default: return reply({});
    }
  };
  return { handler, calls, items };
}

// Media library double (contract §3): pick answers from a queue the test sets.
function mediaDouble() {
  window.__mkPickQueue = [];
  window.__mkPicks = [];
  window.AtlasMarketingMedia = {
    mount(host) { host.innerHTML = '<div class="atlas-empty" data-test-media-library><h3 class="atlas-empty__title">Media library (test double)</h3></div>'; },
    pick(options) { window.__mkPicks.push(options); return Promise.resolve(window.__mkPickQueue.shift() || null); },
    upload(files) { return Promise.resolve([...files].map((file, i) => ({ asset_id: `00000000-0000-4000-8000-00000000077${i}`, kind: 'image', mime_type: 'image/jpeg', width: 1080, height: 1080, byte_size: file.size, thumb_url: null, title: file.name }))); },
    thumbUrl(asset) { return asset?.thumb_url || null; }
  };
}

async function launch({ user = USERS.admin, hash = '#marketing', viewport, timezoneId, gateway = marketingGateway({ role: user.role }) } = {}) {
  const backend = teamCBackend({ user, overrides: { functions: { 'atlas-marketing-workspace': gateway.handler } } });
  const session = await launchAtlas({ user, fixtures: { ...backend.fixtures, profiles: [USERS.admin, USERS.bartender, MANAGER] }, hash, viewport, timezoneId, fixedTime: T0, initScript: mediaDouble });
  return { ...session, gateway };
}

async function noSideScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

// Bottom action bar never covers content: at the end of the page the last
// form element sits above the bar, and the bar sits above the phone tab bar.
async function footerClear(page) {
  return page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const foot = document.querySelector('[data-mk-footer]');
    if (!foot) return { ok: true };
    const bar = foot.getBoundingClientRect();
    const tabbar = document.querySelector('.atlas-tabbar');
    const tab = tabbar && getComputedStyle(tabbar).display !== 'none' ? tabbar.getBoundingClientRect() : null;
    const form = document.querySelector('[data-mk-composer] .mk-composer');
    const content = form.getBoundingClientRect();
    return { ok: content.bottom <= bar.top + 1 && (!tab || bar.bottom <= tab.top + 1) && bar.bottom <= window.innerHeight + 1, bar: bar.top, content: content.bottom, tab: tab?.top ?? null };
  });
}

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

async function openNew(page) {
  await page.click('#marketing-view [data-mk-new]');
  await page.waitForSelector('[data-mk-composer] #mk-title');
}

async function addFromMenu(page, source, picked) {
  await page.evaluate((list) => { window.__mkPickQueue.push(list); }, picked);
  await page.click('#mk-add-media');
  await page.click(`[data-mk-media-source="${source}"]`);
  await page.waitForFunction((count) => document.querySelectorAll('.mk-strip__item').length >= count, picked.length);
}

const stripOrder = (page) => page.$$eval('.mk-strip__item img', (nodes) => nodes.map((img) => decodeURIComponent(img.getAttribute('src')).match(/>([A-D])</)?.[1]));
const checksText = (page) => page.textContent('[data-mk-checks]');

test('S94 operator workflow: compose with media, checks, schedule, submit, approve, calendar, publish now, history, retry, cancel', { skip }, async () => {
  const { page, record, gateway, close } = await launch({ timezoneId: 'America/New_York' });
  try {
    await page.waitForSelector('#marketing-view .page-head');
    const head = await page.textContent('#marketing-view');
    assert.match(head, /Atlas publishes approved posts to Instagram, Facebook and TikTok\. Google Business Profile is posted by hand\./);
    assert.deepEqual(await page.$$eval('#marketing-view .atlas-tabs a', (a) => a.map((x) => x.textContent.replace(/\d+/g, '').trim())), ['Overview', 'Calendar', 'Posts', 'Media', 'Campaigns', 'History']);
    await shot(page, 'desktop-overview');

    // New post: a routed page.
    await openNew(page);
    assert.match(await page.evaluate(() => location.hash), /^#marketing\/new/);
    await page.fill('#mk-title', 'Autumn menu launch');
    for (const channel of ['instagram', 'facebook']) await page.click(`[data-mk-channel="${channel}"]`);
    assert.equal(await page.$('[data-mk-google]'), null, 'Google options only when Google is selected');
    assert.equal(await page.$('[data-mk-tiktok]'), null, 'TikTok options only when TikTok is selected');

    // Add media: one photo from the library, then a collection in its order.
    await addFromMenu(page, 'library', [ASSETS.photoA]);
    await addFromMenu(page, 'collection', [{ ...ASSETS.videoB, collection_id: COLLECTION, collection_name: 'Autumn menu' }, { ...ASSETS.photoC, collection_id: COLLECTION, collection_name: 'Autumn menu' }]);
    const picks = await page.evaluate(() => window.__mkPicks);
    assert.equal(picks[0].allowCollections, false);
    assert.equal(picks[1].allowCollections, true);
    assert.deepEqual(await stripOrder(page), ['A', 'B', 'C']);
    // Reorder with the buttons: C one to the left.
    await page.click('[data-mk-media-index="2"] [data-mk-media-move="-1"]');
    assert.deepEqual(await stripOrder(page), ['A', 'C', 'B']);
    assert.match(await page.textContent('#mk-live'), /moved to position 2 of 3/);

    // Caption + a Facebook-only caption.
    await page.fill('#mk-caption', 'Six new autumn drinks from Thursday. #autumn #cocktails');
    await page.click('[data-mk-channel-section="facebook"] > summary');
    await page.click('[data-mk-override-toggle="facebook"]');
    await page.fill('#mk-override-facebook', 'Our autumn menu starts Thursday: six new drinks, same cosy bar.');
    assert.match(await page.textContent('[data-mk-channel-state="facebook"]'), /Custom caption/);

    // Checks: a video in an Instagram carousel is fine, Facebook can't mix photos and a video → blocking.
    await page.waitForFunction(() => /Facebook can post several photos or one video, not both/.test(document.querySelector('[data-mk-checks]').textContent));
    assert.match(await checksText(page), /Choose when it posts, or choose No time yet\./);
    assert.ok(await page.$eval('[data-mk-submit]', (b) => b.disabled), 'Submit is blocked while something must be fixed');
    // Clicking a check moves focus to the field it names.
    await page.click('[data-mk-check-field="when"]');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'mk-when');
    // Remove the video; schedule in Reykjavík time.
    await page.click('[data-mk-media-index="2"] [data-mk-media-remove]');
    await page.fill('#mk-when', '2026-10-01T18:00');
    await page.waitForFunction(() => !/to fix/.test(document.querySelector('[data-mk-checks]').textContent));
    assert.match(await page.textContent('[data-mk-when-echo]'), /Posts Thu 1 Oct at 18:00 Reykjavík time\. That's 14:00 your time \(New York\)\./);
    assert.ok(!(await page.$eval('[data-mk-submit]', (b) => b.disabled)));

    // Previews: Instagram carousel with the account, Facebook with its own caption.
    const ig = await page.textContent('[data-mk-previews]');
    assert.match(ig, /vabar\.reykjavik/);
    assert.equal(await page.$$eval('.mk-preview__dots span', (n) => n.length), 2);
    await page.click('[data-mk-preview-channel="facebook"]');
    assert.match(await page.textContent('[data-mk-previews]'), /Our autumn menu starts Thursday/);
    await shot(page, 'desktop-composer-new');

    // Submit for approval: one create with media order and options, then submit.
    await page.click('[data-mk-submit]');
    await until(() => requestsTo(record, 'atlas-marketing-workspace', 'submit-approval').length, { message: 'submit-approval' });
    const create = requestsTo(record, 'atlas-marketing-workspace', 'create-content').at(-1).body;
    assert.equal(create.scheduled_for, '2026-10-01T18:00:00.000Z', 'Reykjavík wall time, whatever the browser zone');
    assert.deepEqual(create.media.map((m) => m.asset_id), [ASSETS.photoA.asset_id, ASSETS.photoC.asset_id]);
    assert.equal(create.media[1].collection_id, COLLECTION, 'collection provenance kept');
    assert.equal(create.platform_options.facebook.caption, 'Our autumn menu starts Thursday: six new drinks, same cosy bar.');
    assert.equal(create.platform_options.instagram.caption, null);
    assert.equal(create.platform_options.instagram.target_kind, 'ig_carousel');
    const id = requestsTo(record, 'atlas-marketing-workspace', 'submit-approval').at(-1).body.content_id;
    assert.equal(id, create && [...gateway.items.keys()].at(-1));
    await page.waitForFunction((postId) => location.hash === `#marketing/post?id=${postId}`, id);

    // Approve (the admin is an approver): the label says what happens.
    await page.waitForSelector('[data-mk-decide="approved"]');
    assert.equal((await page.textContent('[data-mk-decide="approved"]')).trim(), 'Approve and schedule');
    assert.match(await page.textContent('[data-mk-composer]'), /sent this for approval/);
    await page.click('[data-mk-decide="approved"]');
    await until(() => requestsTo(record, 'atlas-marketing-workspace', 'decide-approval').length, { message: 'decide-approval' });
    await page.waitForSelector('[data-mk-publish-now]');

    // Calendar: October shows the post with its thumbnail, time and channel dots.
    await page.click('[data-mk-back]');
    await page.evaluate(() => window.AtlasShell.navigate('#marketing/calendar'));
    await page.waitForSelector('.mk-calendar');
    await page.click('[data-mk-month="1"]');
    await page.waitForFunction(() => /October/.test(document.querySelector('.mk-month')?.textContent || ''));
    const entry = await page.waitForSelector(`.mk-day__item[data-mk-open="${id}"]`);
    assert.match(await entry.textContent(), /18:00/);
    assert.ok(await entry.$('img'), 'thumbnail');
    assert.deepEqual(await entry.$$eval('.mk-chan', (n) => n.map((x) => [x.textContent, x.getAttribute('aria-label')])), [['I', 'Instagram: Scheduled 18:00'], ['F', 'Facebook: Scheduled 18:00']]);
    await shot(page, 'desktop-calendar-month');

    // Publish now: confirm names the channels; one path (the gateway action).
    await page.click(`.mk-day__item[data-mk-open="${id}"]`);
    await page.waitForSelector('[data-mk-publish-now]');
    await page.click('[data-mk-publish-now]');
    await page.waitForSelector('.atlas-dialog');
    assert.match(await page.textContent('.atlas-dialog'), /Publish to Instagram and Facebook now\?/);
    await page.click('.atlas-dialog button[type="submit"]');
    await until(() => requestsTo(record, 'atlas-marketing-workspace', 'publish-now').length, { message: 'publish-now' });
    await page.waitForSelector('[data-mk-retry-failed]');
    assert.match(await page.textContent('[data-mk-publishing]'), /Instagram Published/);

    // History: one row per channel; Retry only on the failed one.
    await page.evaluate((postId) => window.AtlasShell.navigate(`#marketing/history?post=${postId}`), id);
    await page.waitForSelector(`[data-mk-history-post="${id}"].is-linked-target`);
    const rows = await page.$$eval(`[data-mk-history-post="${id}"] [data-mk-delivery-row]`, (n) => n.map((row) => ({ channel: row.dataset.mkDeliveryRow, text: row.textContent.replace(/\s+/g, ' ').trim(), retry: Boolean(row.querySelector('[data-mk-retry-delivery]')) })));
    assert.deepEqual(rows.map((r) => [r.channel, r.retry]), [['instagram', false], ['facebook', true]]);
    assert.match(rows[0].text, /Instagram Published .*View on Instagram/);
    assert.match(rows[1].text, /Facebook didn't accept the post\. Edit the post, then retry\./);
    await shot(page, 'desktop-history');
    const fbDelivery = gateway.items.get(id).deliveries.find((d) => d.provider_key === 'facebook').id;
    await page.click(`[data-mk-history-post="${id}"] [data-mk-retry-delivery]`);
    await until(() => requestsTo(record, 'atlas-marketing-workspace', 'retry-delivery').length, { message: 'retry-delivery' });
    assert.deepEqual(requestsTo(record, 'atlas-marketing-workspace', 'retry-delivery').map((r) => r.body.delivery_id), [fbDelivery], 'only the failed channel');
    // Details sheet: attempts per channel from GET history.
    await page.click(`[data-mk-history-details="${id}"]`);
    await page.waitForSelector('#mk-history-sheet .mk-history-detail');
    assert.match(await page.textContent('#mk-history-sheet'), /Try 1/);
    await page.click('#mk-history-sheet [data-modal-close]');

    // Cancel a future post.
    await page.evaluate(() => window.AtlasShell.navigate('#marketing/post?id=future'));
    await page.waitForSelector('[data-mk-cancel-post]');
    await page.click('[data-mk-cancel-post]');
    await page.waitForSelector('.atlas-dialog');
    assert.match(await page.textContent('.atlas-dialog'), /Cancel this post\?/);
    await page.click('.atlas-dialog button[type="submit"]');
    await until(() => requestsTo(record, 'atlas-marketing-workspace', 'cancel-content').length, { message: 'cancel-content' });
    assert.equal(requestsTo(record, 'atlas-marketing-workspace', 'cancel-content')[0].body.content_id, 'future');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('S94 edit after approval asks first, sends the version and goes back to approval', { skip }, async () => {
  const { page, record, close } = await launch({ hash: '#marketing/post?id=approved' });
  try {
    await page.waitForSelector('[data-mk-edit]');
    assert.ok(await page.$eval('#mk-caption', (el) => el.disabled), 'approved posts are read-only until Edit');
    await page.click('[data-mk-edit]');
    await page.waitForSelector('.atlas-dialog');
    const dialog = await page.textContent('.atlas-dialog');
    assert.match(dialog, /Edit this approved post\?/);
    assert.match(dialog, /Any change sends it back for approval/);
    await page.click('.atlas-dialog button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('#mk-caption').disabled);
    await page.fill('#mk-caption', 'Happy hour 16–18, every weekday.');
    await page.click('[data-mk-save]');
    await until(() => requestsTo(record, 'atlas-marketing-workspace', 'update-content').length, { message: 'update-content' });
    const body = requestsTo(record, 'atlas-marketing-workspace', 'update-content')[0].body;
    assert.equal(body.version, 2);
    assert.equal(body.caption_draft, 'Happy hour 16–18, every weekday.');
    assert.ok(!('title' in body) && !('media' in body), 'only what changed is sent');
    await page.waitForSelector('[data-mk-submit]');
    assert.match(await page.textContent('#marketing-view .page-head__sub'), /Draft/);
  } finally { await close(); }
});

test('S94 TikTok controls: no default privacy, creator limits, commercial disclosure and consent', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await page.waitForSelector('#marketing-view [data-mk-new]');
    await openNew(page);
    await page.fill('#mk-title', 'Quiz night clip');
    await page.click('[data-mk-when-mode="none"]');
    await page.click('[data-mk-channel="tiktok"]');
    await addFromMenu(page, 'library', [ASSETS.videoB]);
    await until(() => requestsTo(record, 'atlas-marketing-workspace', 'tiktok-creator-info').length, { message: 'creator info' });
    await page.click('[data-mk-channel-section="tiktok"] > summary');
    await page.waitForSelector('[data-mk-tiktok] .mk-creator strong');
    assert.match(await page.textContent('[data-mk-tiktok]'), /Posting as @vabar\.rvk/);
    // Inbox upload by default; Direct Post when TikTok approved the app.
    assert.match(await page.textContent('[data-mk-tiktok]'), /sends the video to your TikTok inbox/);
    await page.click('[data-mk-format="tiktok"][data-mk-kind="tiktok_video"]');
    await page.waitForSelector('#mk-tt-privacy');
    assert.equal(await page.$eval('#mk-tt-privacy', (s) => s.value), '', 'no default privacy');
    assert.deepEqual(await page.$$eval('#mk-tt-privacy option:not([value=""])', (o) => o.map((x) => x.textContent)), ['Everyone', 'Friends', 'Only me']);
    assert.equal(await page.$eval('[data-mk-tt="allow_comment"]', (c) => c.checked), false, 'interactions start off');
    assert.equal(await page.$eval('[data-mk-tt="allow_duet"]', (c) => c.disabled), true, 'turned off by the creator');
    assert.match(await page.textContent('[data-mk-tiktok]'), /Turned off in your TikTok settings\./);
    await page.waitForFunction(() => /Choose who can see it on TikTok\./.test(document.querySelector('[data-mk-checks]').textContent));
    assert.match(await page.textContent('[data-mk-footer]'), /By posting, you agree to TikTok's Music Usage Confirmation\./);
    // Commercial content: on with neither → must fix; branded content → Only me unavailable, consent names the policy.
    await page.click('[data-mk-tt-commercial]');
    await page.waitForFunction(() => /Choose whether this promotes your brand, another brand, or both\./.test(document.querySelector('[data-mk-checks]').textContent));
    await page.check('[data-mk-tt="brand_content"]');
    await page.waitForFunction(() => document.querySelector('#mk-tt-privacy option[value="SELF_ONLY"]')?.disabled === true);
    await page.waitForFunction(() => /Branded Content Policy and Music Usage Confirmation/.test(document.querySelector('[data-mk-footer]').textContent));
    await page.selectOption('#mk-tt-privacy', 'MUTUAL_FOLLOW_FRIENDS');
    // Direct Post needs the consent ticked (the worker refuses it otherwise).
    await page.waitForFunction(() => /Confirm TikTok's Branded Content Policy and Music Usage Confirmation/.test(document.querySelector('[data-mk-checks]').textContent));
    await page.check('#mk-tt-consent');
    await page.waitForFunction(() => !/to fix/.test(document.querySelector('[data-mk-checks]').textContent));
    // Changing what TikTok receives asks again.
    await page.check('[data-mk-tt="allow_comment"]');
    await page.waitForFunction(() => document.querySelector('#mk-tt-consent')?.checked === false);
    await page.uncheck('[data-mk-tt="allow_comment"]');
    await page.check('#mk-tt-consent');
    await page.waitForFunction(() => !/to fix/.test(document.querySelector('[data-mk-checks]').textContent));
    await shot(page, 'desktop-composer-tiktok');
    await page.click('[data-mk-save]');
    await until(() => requestsTo(record, 'atlas-marketing-workspace', 'create-content').length, { message: 'create' });
    const tt = requestsTo(record, 'atlas-marketing-workspace', 'create-content')[0].body.platform_options.tiktok;
    assert.deepEqual(tt.tiktok, { privacy_level: 'MUTUAL_FOLLOW_FRIENDS', disable_comment: true, disable_duet: true, disable_stitch: true, brand_organic_toggle: false, brand_content_toggle: true, consent_confirmed_at: HARNESS_NOW });
    assert.equal(tt.target_kind, 'tiktok_video');
  } finally { await close(); }
});

test('S94 Google options appear only for Google and check events, buttons and phone numbers', { skip }, async () => {
  const targets = READY_TARGETS.map((t) => (t.provider_key === 'google-business-profile' ? { ...t, ready: true, reason: null, resource: { kind: 'gbp_location', id: 'l1', label: 'VÁ Bar, Laugavegur 1' }, target_kinds: ['gbp_local_post'] } : t));
  const { page, close } = await launch({ gateway: marketingGateway({ targets }) });
  try {
    await page.waitForSelector('#marketing-view [data-mk-new]');
    await openNew(page);
    await page.fill('#mk-title', 'Quiz night');
    assert.equal(await page.$('[data-mk-google]'), null);
    await page.click('[data-mk-channel="google-business-profile"]');
    await page.click('[data-mk-channel-section="google-business-profile"] > summary');
    await page.waitForSelector('[data-mk-google]');
    assert.match(await page.textContent('[data-mk-google]'), /Posting to VÁ Bar, Laugavegur 1\./);
    await page.fill('#mk-caption', 'Quiz night Thursday. Book on 555 1234.');
    await page.waitForFunction(() => /Google removes posts with a phone number in the text\. Use the Call now button instead\./.test(document.querySelector('[data-mk-checks]').textContent));
    await page.click('[data-mk-gbp-topic="EVENT"]');
    await page.waitForSelector('#mk-gbp-title');
    await page.waitForFunction(() => /Add when the event starts and ends\./.test(document.querySelector('[data-mk-checks]').textContent));
    await page.fill('#mk-gbp-title', 'Quiz night');
    await page.fill('#mk-gbp-start', '2026-10-01T20:00');
    await page.fill('#mk-gbp-end', '2026-10-01T19:00');
    await page.waitForFunction(() => /The event ends before it starts\./.test(document.querySelector('[data-mk-checks]').textContent));
    await page.selectOption('#mk-gbp-cta', 'BOOK');
    await page.waitForSelector('#mk-gbp-cta-url');
    await page.waitForFunction(() => /Add the link the button opens\./.test(document.querySelector('[data-mk-checks]').textContent));
    await page.click('[data-mk-channel="google-business-profile"]');
    await page.waitForFunction(() => !document.querySelector('[data-mk-google]'));
  } finally { await close(); }
});

test('S94 roles: bartender sees the lock; manager can approve and publish; automatic publishing off disables Publish now', { skip }, async () => {
  const staff = await launch({ user: USERS.bartender, hash: '' });
  try {
    await staff.page.evaluate(() => { location.hash = '#marketing/post?id=approved'; });
    await staff.page.waitForSelector('#marketing-view .atlas-empty');
    assert.match(await staff.page.textContent('#marketing-view'), /Marketing is for managers/);
    assert.equal(await staff.page.$('[data-mk-composer]'), null);
    assert.equal(requestsTo(staff.record, 'atlas-marketing-workspace').length, 0, 'no marketing data for bartenders');
  } finally { await staff.close(); }

  const manager = await launch({ user: MANAGER, hash: '#marketing/post?id=approved' });
  try {
    await manager.page.waitForSelector('[data-mk-publish-now]');
    assert.ok(!(await manager.page.$eval('[data-mk-publish-now]', (b) => b.disabled)));
    await manager.page.click('[data-mk-publish-now]');
    await manager.page.click('.atlas-dialog button[type="submit"]');
    await until(() => requestsTo(manager.record, 'atlas-marketing-workspace', 'publish-now').length, { message: 'manager publish-now' });
  } finally { await manager.close(); }

  const off = await launch({ hash: '#marketing/post?id=approved', gateway: marketingGateway({ automatic: false }) });
  try {
    await off.page.waitForSelector('[data-mk-publish-now]');
    assert.ok(await off.page.$eval('[data-mk-publish-now]', (b) => b.disabled), 'refused while automatic publishing is off');
    assert.match(await off.page.textContent('[data-mk-footer]'), /Automatic publishing is off, so Publish now isn't available\./);
    await off.page.evaluate(() => window.AtlasShell.navigate('#marketing'));
    await off.page.waitForSelector('.mk-caption');
    assert.match(await off.page.textContent('.mk-caption'), /Automatic publishing is off/);
  } finally { await off.close(); }
});

for (const [zone, expected] of [['America/New_York', /That's 14:00 your time \(New York\)\./], ['Asia/Tokyo', /That's Fri 2 Oct, 03:00 your time \(Tokyo\)\./]]) {
  test(`S94 Reykjavík time from a ${zone} browser`, { skip }, async () => {
    const { page, record, close } = await launch({ timezoneId: zone });
    try {
      await page.waitForSelector('#marketing-view [data-mk-new]');
      await openNew(page);
      await page.fill('#mk-title', 'Late post');
      await page.fill('#mk-when', '2026-10-01T18:00');
      await page.waitForFunction(() => /Reykjavík time/.test(document.querySelector('[data-mk-when-echo]').textContent));
      assert.match(await page.textContent('[data-mk-when-echo]'), /Posts Thu 1 Oct at 18:00 Reykjavík time\./);
      assert.match(await page.textContent('[data-mk-when-echo]'), expected);
      assert.match(await page.textContent('#mk-when-group'), /Post on \(Reykjavík time\)/);
      await page.click('[data-mk-save]');
      await until(() => requestsTo(record, 'atlas-marketing-workspace', 'create-content').length, { message: 'create' });
      assert.equal(requestsTo(record, 'atlas-marketing-workspace', 'create-content')[0].body.scheduled_for, '2026-10-01T18:00:00.000Z');
      // The calendar puts the Sunday brunch post (11:00 Reykjavík) on Sun 27 Sep, at 11:00.
      await page.click('[data-mk-back]');
      await page.evaluate(() => window.AtlasShell.navigate('#marketing/calendar'));
      const cell = await page.waitForSelector('.mk-day:has([data-mk-open="future"])');
      assert.match(await cell.getAttribute('aria-label'), /^Sun 27 Sep/);
      assert.match(await cell.textContent(), /11:00/);
    } finally { await close(); }
  });
}

test('S94 phone 390: every step fits, no sideways scroll, the action bar never covers content', { skip }, async () => {
  const { page, record, close } = await launch({ viewport: PHONE });
  try {
    await page.waitForSelector('#marketing-view .page-head');
    assert.ok(await noSideScroll(page), 'overview');
    await shot(page, 'phone-overview');
    await openNew(page);
    assert.ok(await noSideScroll(page), 'composer');
    await page.fill('#mk-title', 'Phone post');
    await page.click('[data-mk-channel="instagram"]');
    await addFromMenu(page, 'library', [ASSETS.photoA, ASSETS.photoC, ASSETS.photoD, { ...ASSETS.photoA, asset_id: uuid(505) }]);
    assert.ok(await noSideScroll(page), 'media strip scrolls inside its box');
    const clear = await footerClear(page);
    assert.ok(clear.ok, `action bar clear of content and tab bar ${JSON.stringify(clear)}`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'phone-composer-edit');
    await page.click('[data-mk-pane="preview"]');
    await page.waitForSelector('.mk-composer.is-pane-preview');
    assert.ok(await page.$eval('.mk-previews', (el) => el.getBoundingClientRect().height > 0));
    assert.ok(await noSideScroll(page), 'preview pane');
    await shot(page, 'phone-composer-preview');
    await page.click('[data-mk-pane="edit"]');
    await page.fill('#mk-when', '2026-10-01T18:00');
    await page.click('[data-mk-submit]');
    await until(() => requestsTo(record, 'atlas-marketing-workspace', 'submit-approval').length, { message: 'submit' });
    await page.waitForSelector('[data-mk-decide="approved"]');
    assert.ok(await noSideScroll(page), 'approval');
    await page.click('[data-mk-decide="approved"]');
    await page.waitForSelector('[data-mk-publish-now]');
    await page.click('[data-mk-publish-now]');
    const dialog = await page.waitForSelector('.atlas-dialog');
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= PHONE.width + 1 && box.y >= 0 && box.y + box.height <= PHONE.height + 1, 'the confirm dialog fits');
    await shot(page, 'phone-publish-confirm');
    await page.click('.atlas-dialog [data-modal-close]');
    await page.evaluate(() => window.AtlasShell.navigate('#marketing/calendar'));
    await page.waitForSelector('.mk-agenda');
    assert.ok(await page.$eval('.mk-agenda', (el) => el.getBoundingClientRect().height > 0), 'phone agenda');
    assert.equal(await page.$eval('.mk-calendar', (el) => getComputedStyle(el).display), 'none');
    assert.match(await page.textContent('.mk-agenda'), /Thu 24 Sep · Today/);
    assert.ok(await noSideScroll(page), 'agenda');
    await shot(page, 'phone-calendar-agenda');
    await page.evaluate(() => window.AtlasShell.navigate('#marketing/history'));
    await page.waitForSelector('#marketing-view .atlas-tabs [aria-current="page"]');
    const tab = await page.$eval('#marketing-view .atlas-tabs [aria-current="page"]', (a) => { const r = a.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    assert.ok(tab.left >= 0 && tab.right <= PHONE.width + 1, 'the active tab scrolls into view');
    assert.ok(await noSideScroll(page), 'history');
    await page.evaluate(() => window.AtlasShell.navigate('#marketing/media'));
    await page.waitForSelector('[data-test-media-library]');
    assert.ok(await noSideScroll(page), 'media');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('S94 desktop screenshots of history and the phone history', { skip: skip || !SHOTS }, async () => {
  const gateway = marketingGateway();
  gateway.items.get('future').deliveries = [{ id: uuid(801), provider_key: 'instagram', target_kind: 'ig_feed', status: 'published', published_at: at(-20), provider_permalink: 'https://www.instagram.com/p/x' }];
  gateway.items.get('future').publication_state = 'published';
  for (const viewport of [undefined, PHONE]) {
    const { page, close } = await launch({ viewport, gateway, hash: '#marketing/history' });
    try {
      await page.waitForSelector('.mk-history__post');
      await shot(page, viewport ? 'phone-history' : 'desktop-history-published');
    } finally { await close(); }
  }
});
