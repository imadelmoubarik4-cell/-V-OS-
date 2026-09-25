// Shifts (#shifts, spec §7.9, §8.4) in the real shell: the week grid, the
// month calendar in the same module, new-shift defaults from saved opening
// hours (never a literal default), overnight shifts, publishing, staff flows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, requestsTo, settle, until, USERS } from './harness.mjs';
import { shiftsBackend, clockBackend, peopleFunctions, NOW, WEEK } from './people-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function open({ user = USERS.admin, hash = '#shifts', viewport, backend = shiftsBackend({ user }), clock = clockBackend(), contextOptions = {} } = {}) {
  const app = await launchAtlas({ user, hash, viewport, contextOptions, fixedTime: new Date(NOW), fixtures: { functions: peopleFunctions({ 'atlas-shifts': backend.handler, 'atlas-settings': clock.handler }) } });
  await app.page.waitForSelector('.shifts-grid, .shifts-days, .shifts-month, .atlas-empty, .atlas-alert--danger, .shifts-avail, .shifts-list', { timeout: 12000 });
  await settle(app.page);
  return { ...app, backend };
}

test('manager week: grid with people and days, today marked, summary line and unpublished shifts', { skip }, async () => {
  const { page, record, close } = await open();
  try {
    assert.equal(await page.textContent('#shifts-view .page-head__title'), 'Shifts');
    assert.equal(await page.textContent('[data-shifts-summary]'), '21–27 September · 10 shifts · 77.5 h · 2 awaiting confirmation');
    const days = await page.$$eval('.shifts-grid__day', (nodes) => nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(days.slice(0, 2), ['Mon 21', 'Tue 22']);
    assert.equal(await page.getAttribute('.shifts-grid__day.is-today', 'aria-current'), 'date');
    assert.match(await page.textContent('.shifts-grid__day.is-today'), /Thu 24/);
    assert.equal(await page.$$eval('.shifts-grid .shift-chip.is-unpublished', (nodes) => nodes.length), 1);
    assert.match(await page.textContent('.shifts-toolbar'), /Published · changes not published/);
    assert.match(await page.textContent('.shifts-publish'), /Publish week[\s\S]*1 shift changed since publishing/);
    assert.equal(await page.isEnabled('[data-shifts-publish]'), true);
    // Who is on today and tomorrow (venue business date).
    assert.match(await page.textContent('.shifts-now'), /Today Thu 24 Sep[\s\S]*Sara 16:00–00:00[\s\S]*Tomorrow Fri 25 Sep/);
    // A conflict is explained, not colour-only.
    assert.match(await page.getAttribute('.shift-chip.has-warning', 'aria-label'), /Marked unavailable on this day|Change requested/);
    assert.deepEqual(record.pageErrors, []);
    // Shifts asks once; Home's own summary (home.js) may ask for the same week once.
    assert.ok(requestsTo(record, 'atlas-shifts', 'snapshot').length <= 2);
  } finally { await close(); }
});

test('a new shift starts at the day’s saved opening time; overnight ends the next day', { skip }, async () => {
  const { page, backend, close } = await open();
  try {
    await page.click('.shifts-toolbar [data-shifts-add]');
    await page.waitForSelector('#shifts-editor-form');
    assert.equal(await page.inputValue('#shift-date'), '2026-09-24');
    assert.equal(await page.inputValue('#shift-start'), '16:00', 'from saved business hours (Thursday opens 16:00)');
    assert.equal(await page.inputValue('#shift-end'), '', 'no invented end time');
    await page.selectOption('#shift-person', 'p-jon');
    await page.fill('#shift-end', '02:00');
    assert.equal(await page.isVisible('[data-shifts-next-day]'), true);
    await page.click('#shifts-editor [type="submit"]');
    await page.waitForSelector('#shifts-editor', { state: 'detached' });
    assert.equal(backend.saved.length, 1);
    assert.deepEqual({ person: backend.saved[0].person_id, start: backend.saved[0].starts_local, end: backend.saved[0].ends_local, week: backend.saved[0].week_start },
      { person: 'p-jon', start: '2026-09-24T16:00', end: '2026-09-25T02:00', week: WEEK });
  } finally { await close(); }
});

test('without saved hours the start is empty and says why; an invalid draft is kept', { skip }, async () => {
  const { page, backend, close } = await open({ clock: clockBackend({ open: false }) });
  try {
    await page.click('.shifts-toolbar [data-shifts-add]');
    await page.waitForSelector('#shifts-editor-form');
    assert.equal(await page.inputValue('#shift-start'), '');
    assert.match(await page.textContent('[data-shifts-start-note]'), /Business hours are not set — enter a start time\./);
    await page.selectOption('#shift-person', 'p-sara');
    await page.fill('#shift-start', '18:00');
    await page.fill('#shift-end', '18:00');
    await page.click('#shifts-editor [type="submit"]');
    assert.equal(await page.isVisible('[data-error-for="time"]'), true);
    assert.equal(backend.saved.length, 0, 'nothing is sent');
    assert.equal(await page.inputValue('#shift-person'), 'p-sara', 'the draft stays for correction');
  } finally { await close(); }
});

test('month: Monday-first calendar, a day sheet, adding from the month and publishing the month', { skip }, async () => {
  const { page, backend, record, close } = await open({ hash: '#shifts/month' });
  try {
    await page.waitForSelector('.shifts-month__cell');
    const weekdays = await page.$$eval('.shifts-month__weekdays span', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(weekdays, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    assert.equal(await page.getAttribute('[data-shifts-mode="month"]', 'aria-pressed'), 'true');
    assert.match(await page.getAttribute('[data-shifts-day="2026-09-24"]', 'aria-label'), /Thursday 24 September, 3 shifts/);
    await page.click('[data-shifts-day="2026-09-24"]');
    await page.waitForSelector('#shifts-day');
    assert.match(await page.textContent('#shifts-day'), /Thursday 24 September[\s\S]*3 shifts · Open 16:00–01:00/);
    await page.click('#shifts-day [data-shifts-add]');
    await page.waitForSelector('#shifts-editor-form');
    assert.equal(await page.inputValue('#shift-date'), '2026-09-24');
    await page.selectOption('#shift-person', 'p-gunnar');
    await page.fill('#shift-end', '23:00');
    await page.click('#shifts-editor [type="submit"]');
    await page.waitForSelector('#shifts-editor', { state: 'detached' });
    assert.equal(backend.saved.length, 1);
    assert.ok(requestsTo(record, 'atlas-shifts', 'save-shift')[0].body.current_month, 'saved against the month view');
    await page.click('[data-shifts-publish]');
    await page.waitForSelector('#shifts-confirm');
    assert.match(await page.textContent('#shifts-confirm'), /Publish September 2026\?/);
    await page.click('#shifts-confirm [type="submit"]');
    await until(() => requestsTo(record, 'atlas-shifts', 'publish-month').length, { message: 'publish-month' });
    await settle(page);
    assert.equal(requestsTo(record, 'atlas-shifts', 'publish-month').length, 1);
    assert.equal(await page.isEnabled('[data-shifts-publish]'), false, 'nothing left to publish');
    assert.match(await page.textContent('.shifts-publish'), /No changes to publish/);
  } finally { await close(); }
});

test('staff: my shifts from today with Confirm and Request change; manager tabs are hidden', { skip }, async () => {
  const { page, backend, record, close } = await open({ user: USERS.bartender });
  try {
    const tabs = await page.$$eval('.shifts-tabs a', (nodes) => nodes.map((node) => node.textContent.trim()));
    assert.deepEqual(tabs, ['Schedule', 'Availability', 'Time off']);
    assert.match(await page.textContent('[data-shifts-summary]'), /4 shifts for you · 2 to confirm/);
    const days = await page.$$eval('.shifts-day__title', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(days, ['Thursday 24 September', 'Friday 25 September']);
    assert.equal(await page.$('.shift-chip.is-unpublished'), null, 'staff never see drafts');
    await page.click('[data-shift-id="s4"] [data-shifts-respond="confirmed"]');
    await until(() => requestsTo(record, 'atlas-shifts', 'respond').length >= 1, { message: 'the first response' });
    await settle(page);
    assert.equal(requestsTo(record, 'atlas-shifts', 'respond')[0].body.response, 'confirmed');
    await page.click('[data-shift-id="s7"] [data-shifts-respond="change_requested"]');
    await page.waitForSelector('#shifts-confirm');
    await page.click('#shifts-confirm [type="submit"]');
    assert.equal(await page.isVisible('[data-shifts-confirm-error]'), true, 'a note is required');
    await page.fill('#shifts-confirm-input', 'Can I start at 19:00?');
    await page.click('#shifts-confirm [type="submit"]');
    await until(() => requestsTo(record, 'atlas-shifts', 'respond').length >= 2, { message: 'the change request' });
    await settle(page);
    assert.equal(requestsTo(record, 'atlas-shifts', 'respond')[1].body.note, 'Can I start at 19:00?');
    await page.goto(page.url().replace(/#.*$/, '#shifts/confirmations'));
    await page.waitForSelector('.atlas-empty');
    assert.match(await page.textContent('.shifts-body'), /This part of Shifts is for managers/);
    assert.ok(backend.calls.length > 0);
  } finally { await close(); }
});

test('staff: request time off and save availability', { skip }, async () => {
  const { page, record, close } = await open({ user: USERS.bartender, hash: '#shifts/time-off' });
  try {
    await page.click('[data-shifts-time-off-new]');
    await page.waitForSelector('#shifts-time-off-form');
    await page.fill('#to-start', '2026-10-10');
    await page.fill('#to-end', '2026-10-09');
    await page.click('#shifts-time-off [type="submit"]');
    assert.equal(await page.isVisible('[data-to-error]'), true);
    await page.fill('#to-end', '2026-10-11');
    await page.click('#shifts-time-off [type="submit"]');
    await page.waitForSelector('#shifts-time-off', { state: 'detached' });
    const request = requestsTo(record, 'atlas-shifts', 'request-time-off')[0].body;
    assert.deepEqual([request.person_id, request.starts_on, request.ends_on], ['p-sara', '2026-10-10', '2026-10-11']);
    await page.evaluate(() => window.AtlasShell.navigate('#shifts/availability'));
    await page.waitForSelector('.shifts-avail');
    const monday = '[data-shifts-availability-form][data-weekday="1"]';
    assert.equal(await page.getAttribute(`${monday} [role="switch"]`, 'aria-checked'), 'false', 'Monday is marked unavailable');
    await page.click(`${monday} [role="switch"]`);
    await page.fill(`${monday} [name="available_from"]`, '18:00');
    await page.click(`${monday} .shifts-avail__save`);
    await until(() => requestsTo(record, 'atlas-shifts', 'save-availability').length, { message: 'save-availability' });
    await settle(page);
    const saved = requestsTo(record, 'atlas-shifts', 'save-availability')[0].body;
    assert.deepEqual([saved.weekday, saved.unavailable, saved.available_from], [1, false, '18:00']);
  } finally { await close(); }
});

test('empty week offers Copy last week; the API failing shows the last data or a plain error', { skip }, async () => {
  {
    const { page, close } = await open({ backend: shiftsBackend({ empty: true }) });
    try {
      assert.match(await page.textContent('.atlas-empty'), /No shifts this week[\s\S]*Copy last week[\s\S]*Add shift/);
    } finally { await close(); }
  }
  {
    const backend = shiftsBackend({ status: 503 });
    const { page, record, close } = await open({ backend });
    try {
      const alert = await page.textContent('.atlas-alert--danger');
      assert.match(alert, /Shifts couldn’t be loaded\./);
      assert.doesNotMatch(alert, /503|Shifts service/);
      backend.status = 200;
      await page.click('[data-shifts-retry]');
      await page.waitForSelector('.shifts-grid');
      assert.ok(requestsTo(record, 'atlas-shifts', 'snapshot').length >= 2, 'Try again asks the server again');
    } finally { await close(); }
  }
});

test('phone: day list, add from the top bar, no sideways scroll, 44 px targets', { skip }, async () => {
  for (const user of [USERS.admin, USERS.bartender]) {
    const { page, close } = await open({ user, viewport: { width: 390, height: 844 }, contextOptions: { hasTouch: true, isMobile: true } });
    try {
      await page.waitForSelector('.shifts-days');
      assert.equal(await page.$('.shifts-grid'), null);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${user.role}: no horizontal scroll`);
      const small = await page.$$eval('.shifts button, .shifts a.atlas-btn', (nodes) => nodes.filter((node) => node.offsetParent && !node.closest('.atlas-tabs')).map((node) => node.getBoundingClientRect().height).filter((height) => height < 43.5).length);
      assert.equal(small, 0, `${user.role}: 44 px targets`);
      if (user === USERS.admin) {
        await page.click('#atlas-topbar-actions [data-topbar-action="0"]');
        await page.waitForSelector('#shifts-editor-form');
      }
    } finally { await close(); }
  }
});
