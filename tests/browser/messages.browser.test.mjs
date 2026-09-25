// Messages (#messages, spec §7.3, §8.5) in the real shell: list + thread,
// identity (S87), sending with a failed-send retry, unread, roles and phones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, requestsTo, settle, until, USERS } from './harness.mjs';
import { messagesBackend, peopleFunctions, MEMBERS, NOW } from './people-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function open({ user = USERS.admin, hash = '#messages/general', backend = messagesBackend({ user }), viewport, photos = [], contextOptions = {}, ready = '[data-team-message], .msg-log__empty, .atlas-alert--danger' } = {}) {
  const app = await launchAtlas({
    user, hash, viewport, contextOptions, fixedTime: new Date(NOW),
    fixtures: { functions: peopleFunctions({ 'atlas-team-messages': backend.handler, 'atlas-team-profile-photos': { photos, staff: { id: user.id, can_manage_team: true } } }) }
  });
  if (ready) await app.page.waitForSelector(ready, { timeout: 10000 });
  await settle(app.page);
  return { ...app, backend };
}

async function rows(page) {
  return page.$$eval('[data-team-message]', (nodes) => nodes.map((node) => ({
    id: node.dataset.teamMessage,
    name: node.querySelector('.msg-item__name')?.textContent.trim() || null,
    role: node.querySelector('.msg-item__role')?.textContent.trim() || null,
    avatar: node.querySelector('.msg-avatar')?.textContent.trim() || null,
    photo: node.querySelector('.msg-avatar img')?.getAttribute('src') || null,
    grouped: node.classList.contains('is-grouped'),
    system: node.classList.contains('is-system')
  })));
}

test('thread: current names from sender_id, never an email; grouping, dividers and the New marker', { skip }, async () => {
  const { page, record, close } = await open();
  try {
    const list = await rows(page);
    assert.deepEqual(list.map((row) => row.id), ['m1', 'm2', 'm3', 'm4']);
    assert.equal(list[0].name, 'Sara Jónsdóttir', 'the roster name replaces the stored email label');
    assert.equal(list[2].name, 'Gunnar Karlsson', 'an email-only profile becomes a readable name');
    assert.ok(list.every((row) => !String(row.name || '').includes('@')));
    assert.equal(list[3].grouped, true, 'same sender within five minutes collapses avatar and name');
    const dividers = await page.$$eval('.msg-divider', (nodes) => nodes.map((node) => node.textContent.trim()));
    assert.deepEqual(dividers, ['Yesterday', 'Today', 'New']);
    assert.equal(await page.getAttribute('[data-msg-log]', 'role'), 'log');
    // Opening the channel marks it read once.
    await until(() => requestsTo(record, 'atlas-team-messages', 'mark-read').length, { message: 'mark-read' });
    await settle(page);
    assert.equal(requestsTo(record, 'atlas-team-messages', 'mark-read').length, 1);
    assert.match(await page.textContent('.msg-link'), /Campari/);
    assert.equal(await page.getAttribute('.msg-link', 'href'), '#inventory/item/campari');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('photos come from the sender id; former members fall back safely; system messages stay distinct', { skip }, async () => {
  const backend = messagesBackend();
  backend.threads.general.push(
    { id: 'x1', sender_id: 'aaaaaaaa-0000-4000-8000-00000000dead', sender_label: 'jon.gudmundsson@example.test', sender_role: 'bartender', body: 'Old message', message_type: 'user', created_at: NOW },
    { id: 'x2', sender_id: null, sender_label: '', sender_role: null, body: 'Unknown sender', message_type: 'user', created_at: NOW },
    { id: 'x3', sender_id: null, sender_label: 'Atlas', message_type: 'system', body: 'Schedule published', created_at: NOW }
  );
  const { page, close } = await open({ backend, photos: [{ profile_id: USERS.bartender.id, signed_url: PHOTO, version: 2 }] });
  try {
    const list = await rows(page);
    const byId = Object.fromEntries(list.map((row) => [row.id, row]));
    assert.equal(byId.m1.photo, PHOTO, "Sara's own photo");
    assert.equal(byId.m2.photo, null, "the viewer's photo is never used for someone else");
    // S91a: the viewer's own messages sit on the right without an avatar.
    assert.equal(byId.m2.avatar, null);
    assert.equal(byId.m2.name, 'You');
    assert.equal(byId.x1.name, 'Jon Gudmundsson');
    assert.match(byId.x1.role, /no longer active/);
    assert.equal(byId.x2.name, 'Former team member');
    assert.equal(byId.x3.system, true);
    assert.match(byId.x3.role, /System update/);
  } finally { await close(); }
});

test('sending: Enter sends, the message appears; a failed send stays with Retry', { skip }, async () => {
  const backend = messagesBackend();
  const { page, close } = await open({ backend });
  try {
    await page.fill('[data-team-draft]', 'Ice delivered.');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.msg-item__text')].some((node) => node.textContent === 'Ice delivered.'));
    assert.equal(backend.sent.length, 1);
    assert.match(backend.sent[0].client_request_id, /^[0-9a-f-]{36}$/);
    assert.equal(await page.inputValue('[data-team-draft]'), '', 'the composer clears');

    backend.sendStatus = 503;
    await page.fill('[data-team-draft]', 'Second message');
    await page.click('.msg-compose__send');
    await page.waitForSelector('[data-msg-failed]');
    assert.match(await page.textContent('[data-msg-failed]'), /Second message[\s\S]*Not sent/);
    const failedId = await page.getAttribute('[data-msg-failed]', 'data-msg-failed');
    backend.sendStatus = 200;
    await page.click('[data-msg-retry]');
    await page.waitForSelector('[data-msg-failed]', { state: 'detached' });
    assert.equal(backend.sent.at(-1).client_request_id, failedId, 'the retry reuses the request id');
    assert.equal(backend.sent.at(-1).body, 'Second message');
  } finally { await close(); }
});

test('linking a record: staff get no recommendations; managers do; staff never see a recommendation title', { skip }, async () => {
  {
    const { page, close } = await open({ user: USERS.bartender, hash: '#messages/general' });
    try {
      await page.click('[data-team-toggle-attachment]');
      await page.waitForSelector('#msg-link [data-team-select-target]');
      const types = await page.$$eval('[data-msg-link-type]', (nodes) => nodes.map((node) => node.textContent.trim()));
      assert.deepEqual(types, ['Item', 'Checklist', 'Shift']);
      await page.click('[data-team-select-target="campari"]');
      await page.click('[data-msg-link-attach]');
      assert.match(await page.textContent('.msg-compose__context'), /Campari/);
      await page.fill('[data-team-draft]', 'We are low');
      await page.keyboard.press('Enter');
      await settle(page);
      await page.goto(page.url().replace(/#.*$/, '#messages/announcements'));
      await page.waitForSelector('[data-team-message="a2"]');
      assert.match(await page.textContent('[data-team-message="a2"] .msg-link'), /Atlas recommendation · managers only/);
      assert.doesNotMatch(await page.textContent('#team-view'), /Globus contract/);
      assert.match(await page.textContent('.msg-composer__locked'), /Only managers can post in Announcements/);
    } finally { await close(); }
  }
  {
    const { page, close } = await open({ user: USERS.admin, hash: '#messages/announcements' });
    try {
      assert.match(await page.textContent('[data-team-message="a2"] .msg-link'), /Renegotiate the Globus contract/);
      assert.equal(await page.getAttribute('[data-team-message="a1"] .msg-link', 'href'), '#knowledge/k-closing');
      await page.click('[data-team-toggle-attachment]');
      await page.waitForSelector('[data-msg-link-type="brain_recommendation"]');
    } finally { await close(); }
  }
});

test('handover template posts the three sections to Shift handover', { skip }, async () => {
  const backend = messagesBackend();
  const { page, close } = await open({ backend, hash: '#messages/shift-handover' });
  try {
    await page.click('[data-msg-handover]');
    await page.waitForSelector('#msg-handover-form');
    await page.fill('#msg-ho-happened', 'Busy night');
    await page.fill('#msg-ho-next', 'Restock limes');
    await page.click('#msg-handover [type="submit"]');
    await until(() => backend.sent.length, { message: 'the handover message' });
    await settle(page);
    assert.equal(backend.sent.length, 1);
    assert.equal(backend.sent[0].channel_key, 'shift-handover');
    assert.equal(backend.sent[0].body, 'What happened\nBusy night\n\nFor the next shift\nRestock limes');
  } finally { await close(); }
});

test('the API returning 503 shows a plain error with a working Try again, no raw text', { skip }, async () => {
  const backend = messagesBackend({ status: 503 });
  const { page, record, close } = await open({ backend });
  try {
    const alert = await page.textContent('.atlas-alert--danger');
    assert.match(alert, /Messages couldn’t be loaded\./);
    assert.doesNotMatch(alert, /team-message service|rpc|503/i);
    const before = requestsTo(record, 'atlas-team-messages', 'snapshot').length;
    backend.status = 200;
    await page.click('[data-team-refresh]');
    await page.waitForSelector('[data-team-message]');
    assert.ok(requestsTo(record, 'atlas-team-messages', 'snapshot').length > before);
  } finally { await close(); }
});

test('an empty channel invites the first message', { skip }, async () => {
  const { page, close } = await open({ backend: messagesBackend({ empty: true }) });
  try {
    assert.match(await page.textContent('.msg-log__empty'), /No messages yet[\s\S]*Say hello to the team\./);
  } finally { await close(); }
});

test('phone: list screen → channel screen with back, tab bar hidden, sticky composer, 44 px targets', { skip }, async () => {
  const { page, close } = await open({ hash: '#messages', viewport: { width: 390, height: 844 }, contextOptions: { hasTouch: true, isMobile: true }, ready: '.msg-channel' });
  try {
    await page.waitForSelector('.msg-channel');
    assert.equal(await page.getAttribute('.msg', 'data-msg-view'), 'list');
    assert.equal(await page.isVisible('.msg-thread'), false);
    await page.click('.msg-channel[data-team-channel="general"]');
    await page.waitForFunction(() => document.querySelector('.msg')?.dataset.msgView === 'thread' && location.hash === '#messages/general');
    await page.waitForSelector('[data-team-message]');
    assert.equal(await page.isVisible('#atlas-topbar-back'), true);
    assert.equal(await page.textContent('#atlas-page-title'), 'General');
    assert.equal(await page.isVisible('.atlas-tabbar'), false, 'tab bar hidden inside a channel');
    const composer = await page.$eval('.msg-composer', (node) => { const rect = node.getBoundingClientRect(); return { bottom: rect.bottom, height: window.innerHeight }; });
    assert.ok(composer.bottom <= composer.height + 1, 'composer is on screen');
    const small = await page.$$eval('.msg-compose button, .msg-channel, .msg-item__more', (nodes) => nodes.filter((node) => node.offsetParent).map((node) => node.getBoundingClientRect()).filter((rect) => rect.height < 43.5).length);
    assert.equal(small, 0, 'touch targets are at least 44 px');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.click('#atlas-topbar-back');
    await page.waitForFunction(() => location.hash === '#messages' && document.querySelector('.msg')?.dataset.msgView === 'list');
  } finally { await close(); }
});

test('unread counts reach the shell badge and the per-conversation read API', { skip }, async () => {
  const { page, close } = await open({ hash: '#home', ready: null });
  try {
    await page.waitForFunction(() => window.AtlasTeamUnreadBadge?.count?.() === 2, null, { timeout: 12000 });
    const conversations = await page.evaluate(() => window.AtlasTeamUnreadBadge.conversations());
    assert.deepEqual(conversations.map((row) => [row.id, row.unread, row.route]), [['general', 2, '#messages/general']]);
    await page.waitForFunction(() => document.querySelector('.atlas-sidebar .nav-item[data-nav-id="messages"]')?.getAttribute('aria-label') === 'Messages, 2 unread', null, { timeout: 6000 });
    await page.evaluate(() => window.AtlasShell.navigate('#messages/general'));
    await page.waitForFunction(() => window.AtlasTeamMessages.unreadCount() === 0);
    await page.waitForFunction(() => document.querySelector('.atlas-sidebar .nav-item[data-nav-id="messages"]')?.getAttribute('aria-label') === 'Messages', null, { timeout: 6000 });
    assert.equal(MEMBERS.length, 3);
  } finally { await close(); }
});
