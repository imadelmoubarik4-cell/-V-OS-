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
    assert.equal(list[2].name, 'Gunnar Karlsson', 'the roster display name');
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
    assert.equal(byId.m2.photo, null, "Sara's photo is never used for someone else");
    // S93: the viewer's own messages carry their real name and avatar (initials without a photo).
    assert.equal(byId.m2.avatar, 'IE');
    assert.equal(byId.m2.name, 'Imad El Moubarik');
    // An address is never turned into a name (S87), not even its local part.
    assert.equal(byId.x1.name, 'Former team member');
    assert.match(byId.x1.role, /no longer active/);
    assert.ok(list.every((row) => !String(row.name || '').includes('@') && !/Gudmundsson/.test(row.name || '')));
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

// ---------- S93: sender identity (production: "Team member" everywhere, no photo on own messages) ----------

const ADMIN_PHOTO = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#2f6f5e"/></svg>').toString('base64');

async function identityRows(page) {
  return page.$$eval('[data-team-message]', (nodes) => {
    const log = document.querySelector('[data-msg-log]');
    const style = getComputedStyle(log);
    const left = log.getBoundingClientRect().left + parseFloat(style.paddingLeft);
    const right = log.getBoundingClientRect().right - parseFloat(style.paddingRight);
    return nodes.map((node) => {
      const body = node.querySelector('.msg-item__body').getBoundingClientRect();
      const avatar = node.querySelector('.msg-avatar');
      const box = avatar?.getBoundingClientRect();
      const time = node.querySelector('.msg-item__time');
      return {
        id: node.dataset.teamMessage,
        own: node.classList.contains('is-own'),
        grouped: node.classList.contains('is-grouped'),
        name: node.querySelector('.msg-item__name')?.textContent.trim() || null,
        photo: avatar?.querySelector('img')?.getAttribute('src') || null,
        initials: avatar && !avatar.querySelector('img') ? avatar.textContent.trim() : null,
        icon: Boolean(avatar?.querySelector('svg, i[data-lucide]')),
        avatarVisible: Boolean(box && box.width > 0 && box.height > 0),
        avatarSide: box ? (box.left >= body.right - 1 ? 'right' : box.right <= body.left + 1 ? 'left' : 'overlap') : null,
        fromLeft: body.left - left,
        fromRight: right - body.right,
        time: time?.textContent.trim() || '',
        datetime: time?.getAttribute('datetime') || ''
      };
    });
  });
}

for (const [label, viewport, contextOptions] of [
  ['desktop 1440', { width: 1440, height: 900 }, {}],
  ['phone 390 touch', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }]
]) {
  test(`S93 ${label}: real names and photos on own and others' messages, initials otherwise, own right / others left`, { skip }, async () => {
    const photos = [{ profile_id: USERS.admin.id, signed_url: ADMIN_PHOTO, version: 1 }];
    const { page, record, close } = await open({ viewport, contextOptions, photos });
    try {
      await page.waitForSelector('[data-team-message="m2"] .msg-avatar img');
      const rows = Object.fromEntries((await identityRows(page)).map((row) => [row.id, row]));
      // Own (the admin viewer): real name, own photo, on the right with the avatar to its right.
      assert.equal(rows.m2.own, true);
      assert.equal(rows.m2.name, 'Imad El Moubarik');
      assert.equal(rows.m2.photo, ADMIN_PHOTO);
      assert.equal(rows.m2.avatarVisible, true);
      assert.equal(rows.m2.avatarSide, 'right');
      assert.ok(rows.m2.fromRight <= 48, `own bubble next to the right-hand avatar (${rows.m2.fromRight})`);
      assert.ok(rows.m2.fromLeft > 40, `own bubble away from the left (${rows.m2.fromLeft})`);
      assert.equal(await page.$eval('[data-team-message="m2"] .msg-item__meta', (node) => node.textContent.includes('(you)')), true, 'assistive tech hears it is yours');
      // Others: their real names, initials without a photo, on the left with the avatar to the left.
      for (const [id, name, initials] of [['m1', 'Sara Jónsdóttir', 'SJ'], ['m3', 'Gunnar Karlsson', 'GK']]) {
        assert.equal(rows[id].own, false);
        assert.equal(rows[id].name, name);
        assert.equal(rows[id].photo, null);
        assert.equal(rows[id].initials, initials);
        assert.equal(rows[id].avatarSide, 'left');
        assert.ok(rows[id].fromLeft <= 48, `${id}: next to the left-hand avatar (${rows[id].fromLeft})`);
        assert.ok(rows[id].fromRight >= 24, `${id}: away from the right (${rows[id].fromRight})`);
      }
      // Grouping still collapses the repeat; timestamps are the venue-clock ones.
      assert.equal(rows.m4.grouped, true);
      assert.equal(rows.m4.name, null);
      for (const row of Object.values(rows).filter((entry) => !entry.grouped)) {
        assert.ok(row.time, `${row.id}: has a time`);
        assert.match(row.datetime, /^\d{4}-\d{2}-\d{2}T/);
      }
      assert.match(rows.m1.time, /Sep/, 'yesterday shows a date');
      assert.match(rows.m3.time, /^\d{2}:\d{2}$/, 'today shows only the time');
      assert.ok(Object.values(rows).every((row) => !String(row.name || '').includes('@')));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll');
      assert.deepEqual(record.pageErrors, []);
    } finally { await close(); }
  });

  test(`S93 ${label}: the conversation list preview names the live sender; unread badge and time unchanged`, { skip }, async () => {
    const backend = messagesBackend();
    // A stored neutral label (display_name was empty when it was sent) resolves to the live roster name.
    backend.threads.general.at(-1).sender_label = 'Team member';
    const { page, close } = await open({ backend, viewport, contextOptions, hash: '#messages', ready: '.msg-channel' });
    try {
      await page.waitForSelector('.msg-channel[data-team-channel="general"]');
      const general = await page.$eval('.msg-channel[data-team-channel="general"]', (node) => ({
        preview: node.querySelector('.msg-channel__preview').textContent.trim(),
        time: node.querySelector('.msg-channel__time')?.textContent.trim() || '',
        datetime: node.querySelector('.msg-channel__time')?.getAttribute('datetime') || '',
        badge: node.querySelector('.atlas-badge')?.textContent.trim() || null,
        label: node.getAttribute('aria-label')
      }));
      assert.equal(general.preview, 'Gunnar Karlsson: I put a note on it.');
      assert.match(general.time, /^\d{2}:\d{2}$/);
      assert.match(general.datetime, /^\d{4}-\d{2}-\d{2}T/);
      if (viewport.width < 768) {
        // Phones open on the list: nothing is read yet, the badge shows.
        assert.equal(general.badge, '2');
        assert.equal(general.label, 'General, 2 unread');
      }
      const empty = await page.$eval('.msg-channel[data-team-channel="marketing"] .msg-channel__preview', (node) => node.textContent.trim());
      assert.match(empty, /Content ideas/, 'a channel without messages keeps its description');
      const feed = await page.evaluate(() => window.AtlasTeamMessages.unread().conversations.map((row) => [row.id, row.lastMessage?.sender]));
      if (viewport.width < 768) assert.deepEqual(feed, [['general', 'Gunnar Karlsson']]);
    } finally { await close(); }
  });
}

test('S93 production shape: a neutral roster label never hides a real name; a nameless member gets a person icon, never "TM"', { skip }, async () => {
  const backend = messagesBackend();
  const NONAME = 'c0ffee00-0000-4000-8000-000000000004';
  // Gunnar's profile has no display name yet (the gateway says "Team member");
  // the gateway's sender_name / the stored name still carry his real name.
  backend.members = [...MEMBERS.slice(0, 2), { ...MEMBERS[2], label: 'Team member' }, { id: NONAME, label: 'Team member', role: 'bartender' }];
  backend.threads.general[2].sender_label = 'Team member';
  backend.threads.general[2].sender_name = 'Gunnar Karlsson';
  backend.threads.general[3].sender_label = 'Gunnar Karlsson';
  backend.threads.general.push({ id: 'n1', sender_id: NONAME, sender_label: 'Team member', sender_name: 'Team member', sender_role: 'bartender', body: 'Hi all', message_type: 'user', created_at: NOW, read_by: [], read_by_count: 0 });
  const { page, close } = await open({ backend });
  try {
    const rows = Object.fromEntries((await identityRows(page)).map((row) => [row.id, row]));
    assert.equal(rows.m3.name, 'Gunnar Karlsson', "the gateway's sender_name beats the neutral roster label");
    assert.equal(rows.m3.initials, 'GK');
    assert.equal(rows.n1.name, 'Team member');
    assert.equal(rows.n1.icon, true, 'a person icon');
    assert.equal(rows.n1.initials, '', 'no "TM" initials');
    assert.doesNotMatch(await page.$eval('[data-team-message="n1"] .msg-item__role', (node) => node.textContent), /no longer active/);
  } finally { await close(); }
});

test('S93 hydration: photos that arrive after the thread swap in place; a broken photo URL falls back to initials and asks for fresh URLs', { skip }, async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let photoCalls = 0;
  let broken = false;
  const photosHandler = async () => {
    photoCalls += 1;
    await gate;
    const url = broken ? '/missing-profile-photo.png' : ADMIN_PHOTO;
    return { photos: [{ profile_id: USERS.bartender.id, signed_url: url, version: photoCalls }, { profile_id: USERS.admin.id, signed_url: url, version: photoCalls }], staff: { id: USERS.admin.id, can_manage_team: true } };
  };
  const app = await launchAtlas({
    user: USERS.admin, hash: '#messages/general', fixedTime: new Date(NOW),
    fixtures: { functions: peopleFunctions({ 'atlas-team-messages': messagesBackend().handler, 'atlas-team-profile-photos': photosHandler }) }
  });
  const { page, close } = app;
  try {
    // The photo request is held open, so the page never "settles" here.
    await page.waitForSelector('[data-team-message="m2"] .msg-avatar');
    let rows = Object.fromEntries((await identityRows(page)).map((row) => [row.id, row]));
    assert.equal(rows.m1.initials, 'SJ', 'initials while photos load');
    assert.equal(rows.m2.initials, 'IE');
    await page.$eval('[data-team-message="m1"]', (node) => { node.dataset.sameNode = 'yes'; });
    release();
    await page.waitForSelector('[data-team-message="m1"] .msg-avatar img');
    await page.waitForSelector('[data-team-message="m2"] .msg-avatar img');
    assert.equal(await page.$eval('[data-team-message="m1"]', (node) => node.dataset.sameNode), 'yes', 'only the avatars changed');
    // The signed URLs expire (or go missing): the image fails, initials return, fresh URLs are asked for.
    broken = true;
    const before = photoCalls;
    await page.evaluate(() => window.AtlasTeamProfilePhotos.refresh());
    await page.waitForFunction(() => document.querySelector('[data-team-message="m1"] .msg-avatar')?.textContent.trim() === 'SJ', null, { timeout: 8000 });
    rows = Object.fromEntries((await identityRows(page)).map((row) => [row.id, row]));
    assert.equal(rows.m1.photo, null);
    assert.equal(rows.m2.initials, 'IE');
    // refresh() once, then the failed image asks for fresh URLs once more.
    await until(() => photoCalls >= before + 2, { message: 'fresh photo URLs after the failure' });
  } finally { await close(); }
});

test('S93 Messages asks for the photo snapshot when it never loaded', { skip }, async () => {
  let calls = 0;
  let fail = true;
  const photosHandler = async () => {
    calls += 1;
    if (fail) return { __status: 503, body: { error: 'unavailable' } };
    return { photos: [{ profile_id: USERS.bartender.id, signed_url: ADMIN_PHOTO, version: 1 }], staff: { id: USERS.admin.id, can_manage_team: true } };
  };
  const { page, close } = await launchAtlas({
    user: USERS.admin, hash: '#home', fixedTime: new Date(NOW),
    fixtures: { functions: peopleFunctions({ 'atlas-team-messages': messagesBackend().handler, 'atlas-team-profile-photos': photosHandler }) }
  });
  try {
    await until(() => calls >= 1, { message: 'the sign-in photo load' });
    await settle(page);
    fail = false;
    await page.evaluate(() => window.AtlasShell.navigate('#messages/general'));
    await page.waitForSelector('[data-team-message="m1"] .msg-avatar img', { timeout: 8000 });
    assert.ok(calls >= 2, 'opening Messages retried the photo snapshot');
  } finally { await close(); }
});
