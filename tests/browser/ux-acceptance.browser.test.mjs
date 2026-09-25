// Design/UX acceptance (2026-09-25 review) — the shared, cross-page contracts:
//   P1-6  the page header keeps a readable title column at every width;
//   P1-7  after sign-in the requested page opens at once with its header,
//         skeletons, the right navigation item and the loading line, before
//         the shell data (or a slow stock endpoint) answers;
//   P1-8  every visible interactive element on the key phone screens has a
//         44 px hit area on a coarse pointer (pseudo-element hit areas count);
//   and the sign-in, recovery, routing and 24-hour time-field fixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, ORIGIN, USERS } from './harness.mjs';
import { uxWorld, INV, TC } from './ux-world-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const PHONE = { viewport: { width: 390, height: 844 }, contextOptions: { hasTouch: true, isMobile: true } };

// A backend that answers only when the test releases it (no fixed sleeps).
function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}
function holdTables(world, held) {
  for (const key of Object.keys(world.tables)) {
    const rows = world.tables[key];
    world.tables[key] = async (...args) => { await held.promise; return typeof rows === 'function' ? rows(...args) : rows; };
  }
  return world;
}

// ---------- P1-6 page header ----------

const headerState = (page) => page.evaluate(() => [...document.querySelectorAll('.page-head')].filter((head) => head.getClientRects().length && head.offsetParent).map((head) => {
  const box = head.getBoundingClientRect();
  const text = head.querySelector('.page-head__text').getBoundingClientRect();
  const sub = head.querySelector('.page-head__sub');
  const lines = sub ? Math.round(sub.getBoundingClientRect().height / (parseFloat(getComputedStyle(sub).lineHeight) || 20)) : 0;
  const outside = [...head.querySelectorAll('.page-head__actions *')].some((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1); });
  // Empty space under the text block (a flex basis read as a height in the phone column).
  const bottoms = [...head.querySelector('.page-head__text').children].map((node) => node.getBoundingClientRect()).filter((r) => r.height > 1).map((r) => r.bottom);
  const slack = bottoms.length ? Math.round(text.bottom - Math.max(...bottoms)) : 0;
  return { title: head.querySelector('.page-head__title')?.textContent.trim(), head: Math.round(box.width), text: Math.round(text.width), slack, lines, clipped: sub ? sub.scrollWidth > sub.clientWidth + 1 : false, outside };
}));

test('P1-6: page headers keep a 280 px title column; actions wrap below instead of squeezing it', { skip }, async () => {
  const routes = { C: ['#reports/overview', '#recipes', '#marketing', '#data'], P: ['#shifts', '#shifts/month', '#knowledge', '#team'], INV: ['#inventory', '#purchasing'], A: ['#operations', '#settings'] };
  for (const width of [1024, 768, 390]) {
    for (const [group, list] of Object.entries(routes)) {
      const phone = width < 768;
      const { page, record, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group }), viewport: { width, height: 900 }, contextOptions: phone ? { hasTouch: true, isMobile: true } : {} });
      try {
        for (const route of list) {
          await navigateTo(page, route);
          for (const head of await headerState(page)) {
            const where = `${route} at ${width}: ${JSON.stringify(head)}`;
            assert.ok(head.text >= Math.min(280, head.head) - 1, `title column squeezed, ${where}`);
            assert.equal(head.clipped, false, `subtitle clipped, ${where}`);
            assert.equal(head.outside, false, `header action outside the header, ${where}`);
            assert.ok(head.slack <= 2, `empty space under the header text, ${where}`);
            if (width >= 768) assert.ok(head.lines <= 2, `subtitle wraps to ${head.lines} lines, ${where}`);
          }
        }
        assert.deepEqual(record.pageErrors, []);
      } finally { await close(); }
    }
  }
});

test('P2: every page header starts at the shell gutter (no module page padding)', { skip }, async () => {
  for (const [width, group, routes] of [[1440, 'C', ['#recipes', '#reports/overview', '#marketing', '#data']], [1440, 'INV', ['#inventory']], [390, 'C', ['#recipes', '#marketing']], [390, 'INV', ['#inventory']]]) {
    const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group }), viewport: { width, height: 900 }, contextOptions: width < 768 ? { hasTouch: true, isMobile: true } : {} });
    try {
      for (const route of routes) {
        await navigateTo(page, route);
        const gap = await page.evaluate(() => {
          const content = document.querySelector('.atlas-content').getBoundingClientRect();
          const head = [...document.querySelectorAll('.page-head')].find((node) => node.getClientRects().length).getBoundingClientRect();
          const gutter = parseFloat(getComputedStyle(document.querySelector('.atlas-content')).paddingLeft);
          return { left: Math.round(head.left - content.left - gutter), top: Math.round(head.top - content.top - parseFloat(getComputedStyle(document.querySelector('.atlas-content')).paddingTop)) };
        });
        assert.deepEqual(gap, { left: 0, top: 0 }, `${route} at ${width}`);
      }
    } finally { await close(); }
  }
});

// ---------- P1-7 loading ----------

async function openHeld(route, { user = USERS.admin, group = 'INV', hold = 'tables', ...options } = {}) {
  const held = gate();
  const world = uxWorld(user, { group });
  if (hold === 'tables') holdTables(world, held);
  else {
    const answer = world.functions[hold];
    world.functions[hold] = async (...args) => { await held.promise; return typeof answer === 'function' ? answer(...args) : answer; };
  }
  // Records, in page time, when the app appears and when its first page
  // header with skeletons is on screen (a rAF poll; no test sleeps).
  const initScript = () => {
    window.__firstPaint = {};
    const poll = () => {
      const app = document.getElementById('app-screen');
      const now = performance.now();
      if (app && app.style.display === 'block' && !window.__firstPaint.app) window.__firstPaint.app = now;
      if (window.__firstPaint.app && !window.__firstPaint.page && document.querySelector('#atlas-main .page-head__title, #atlas-main .home-greeting, #atlas-main h1') && document.querySelector('#atlas-main .atlas-skel')) window.__firstPaint.page = now;
      if (!window.__firstPaint.page) requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  };
  const app = await launchAtlas({ user, fixtures: world, hash: route, waitReady: false, initScript, ...options });
  await app.page.waitForFunction(() => window.__firstPaint?.page, null, { timeout: 8000 });
  return { ...app, held };
}

const loadingState = (page) => page.evaluate(() => {
  const visible = (node) => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
  const main = document.getElementById('atlas-main');
  return {
    view: document.body.dataset.atlasView,
    ready: document.body.dataset.atlasReady || null,
    nav: [...document.querySelectorAll('.atlas-sidebar .nav-item[aria-current="page"], .atlas-tabbar [aria-current="page"]')].filter(visible).map((node) => node.dataset.navId),
    title: [...main.querySelectorAll('.page-head__title')].filter((node) => node.closest('[id$="-view"]')?.style.display !== 'none').map((node) => node.textContent.trim())[0] || null,
    skeletons: [...main.querySelectorAll('.atlas-skel')].filter((node) => node.closest('[id$="-view"]')?.style.display !== 'none').length,
    line: visible(document.getElementById('atlas-loading-line')),
    busy: main.getAttribute('aria-busy'),
    text: main.innerText,
    delay: window.__firstPaint.page - window.__firstPaint.app
  };
});

test('P1-7: a slow backend shows the requested page header, skeletons and nav item within 300 ms', { skip }, async () => {
  for (const [route, group, view, nav, title, user, phone] of [
    ['#inventory', 'INV', 'inventory', 'inventory', 'Inventory', USERS.admin, false],
    ['#inventory/movements', 'INV', 'movements', 'inventory', 'Inventory', USERS.admin, false],
    ['#recipes', 'C', 'recipes', 'recipes', 'Recipes', USERS.admin, false],
    ['#purchasing', 'INV', 'suppliers', 'purchasing', 'Purchasing', USERS.admin, false],
    ['#home', 'A', 'dashboard', 'home', null, USERS.admin, false],
    ['#inventory', 'INV', 'inventory', 'inventory', 'Inventory', USERS.bartender, true]
  ]) {
    const { page, record, close, held } = await openHeld(route, { group, user, ...(phone ? PHONE : {}) });
    try {
      const state = await loadingState(page);
      const where = `${route} (${user.role}${phone ? ', phone' : ''})`;
      assert.ok(state.delay < 300, `${where}: page header and skeletons took ${Math.round(state.delay)} ms`);
      assert.equal(state.view, view, where);
      assert.equal(state.ready, null, `${where}: the data must still be held`);
      assert.deepEqual(state.nav, [nav], `${where}: navigation highlight`);
      if (title) assert.equal(state.title, title, where);
      assert.ok(state.skeletons > 0, `${where}: skeletons`);
      assert.equal(state.line, true, `${where}: loading line under the top bar`);
      assert.equal(state.busy, 'true', where);
      // No guessed numbers or empty-state claims while nothing has loaded.
      assert.doesNotMatch(state.text, /\b0 (active )?items\b|No items yet|No movements yet|0 movements/, where);
      held.release();
      await page.waitForFunction(() => document.body.dataset.atlasReady === 'true');
      await settle(page);
      const after = await loadingState(page);
      assert.equal(after.line, false, `${where}: loading line gone`);
      assert.equal(after.busy, 'false', where);
      assert.equal(after.view, view, `${where}: still on the requested page`);
      if (route === '#inventory') assert.match(after.text, /Campari/, `${where}: rows after the data arrives`);
      assert.deepEqual(record.pageErrors, [], where);
    } finally { held.release(); await close(); }
  }
});

test('P1-7 / eng P2-4: a slow stock endpoint never leaves Home blank', { skip }, async () => {
  const { page, close, held } = await openHeld('#home', { group: 'A', hold: 'atlas-stock-counts', ...PHONE });
  try {
    const state = await loadingState(page);
    assert.equal(state.view, 'dashboard');
    assert.ok(state.delay < 300);
    assert.ok(state.skeletons > 0);
    assert.match(state.text, /Needs attention/);
    held.release();
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true');
  } finally { held.release(); await close(); }
});

// ---------- P1-8 touch targets ----------

// Every visible interactive element (whole page, not only the viewport): its
// box, an absolutely positioned ::before/::after hit area, or the label that
// wraps a checkbox or radio must reach 44 px tall (and 24 px wide).
const smallTargets = (page) => page.evaluate(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && !el.closest('[hidden], [inert], [aria-hidden="true"]');
  };
  const selector = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=option], [role=menuitem], [role=checkbox], [role=radio]';
  return [...document.querySelectorAll(selector)].filter(visible).map((el) => {
    const r = el.getBoundingClientRect();
    let h = r.height; let w = r.width;
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content === 'none' || ps.position !== 'absolute') continue;
      h = Math.max(h, parseFloat(ps.height) || 0); w = Math.max(w, parseFloat(ps.width) || 0);
    }
    const label = el.matches('input[type=checkbox], input[type=radio], input[type=file]') ? (el.closest('label') || (el.id && document.querySelector(`label[for="${el.id}"]`))) : null;
    if (label) { const lr = label.getBoundingClientRect(); h = Math.max(h, lr.height); w = Math.max(w, lr.width); }
    const name = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 30)}"`;
    return { name, h: Math.round(h), w: Math.round(w) };
  }).filter((target) => target.h < 44 || target.w < 24).map((target) => `${target.w}x${target.h} ${target.name}`);
});

test('P1-8: every interactive element on the key phone screens has a 44 px touch target', { skip }, async () => {
  const screens = {
    A: ['#home', '#settings/venue', '#settings/hours', '#settings/preferences', '#operations'],
    INV: ['#inventory', `#inventory/item/${INV.campari}`, `#inventory/counts/${INV.session}`, '#purchasing', `#purchasing/order/${INV.po1}`],
    C: ['#recipes', `#recipes/${TC.negroni}`, '#marketing'],
    P: ['#messages/general', '#knowledge/k-closing', '#knowledge', '#shifts']
  };
  const failures = [];
  for (const user of [USERS.admin, USERS.bartender]) {
    for (const [group, routes] of Object.entries(screens)) {
      const { page, close } = await launchAtlas({ user, fixtures: uxWorld(user, { group }), ...PHONE });
      try {
        assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
        for (const route of routes) {
          await navigateTo(page, route);
          if (await page.evaluate(() => document.body.dataset.atlasView) === 'dashboard' && route !== '#home') continue; // a manager page the role can't open
          for (const small of await smallTargets(page)) failures.push(`${user.role} ${route}: ${small}`);
        }
        if (group === 'INV' && user.role === 'admin') {
          // Receiving a delivery (the phone stepper).
          await navigateTo(page, `#purchasing/order/${INV.po2}`);
          await page.click('[data-po-receive]');
          await page.waitForSelector('[data-po-rqty]');
          await settle(page);
          for (const small of await smallTargets(page)) failures.push(`admin receive: ${small}`);
        }
      } finally { await close(); }
    }
  }
  assert.deepEqual(failures, []);
});

test('P1-8: sign-in, invitation and recovery links are 44 px touch targets', { skip }, async () => {
  const { page, close } = await launchAtlas({ signedIn: false, waitReady: false, ...PHONE });
  try {
    await page.waitForFunction(() => document.documentElement.dataset.atlasSignin === 'shown');
    assert.deepEqual(await smallTargets(page), []);
    for (const file of ['invitation.html', 'recovery.html']) {
      await page.goto(`${ORIGIN}/${file}`);
      await page.waitForSelector('.atlas-auth__link a');
      assert.deepEqual(await smallTargets(page), [], file);
    }
  } finally { await close(); }
});

// ---------- sign-in, recovery, inactive profile ----------

test('P2: sign-in shows inline field errors (no browser bubble) linked with aria-describedby', { skip }, async () => {
  const { page, record, close } = await launchAtlas({ signedIn: false, waitReady: false, ...PHONE });
  try {
    await page.waitForFunction(() => document.documentElement.dataset.atlasSignin === 'shown');
    assert.equal(await page.getAttribute('#login-form', 'novalidate'), '');
    await page.click('#login-btn');
    await page.waitForSelector('#email-error:not([hidden])');
    const state = await page.evaluate(() => ({
      email: document.getElementById('email-error').textContent,
      password: document.getElementById('password-error').textContent,
      invalid: ['email', 'password'].map((id) => document.getElementById(id).getAttribute('aria-invalid')),
      described: document.getElementById('email').getAttribute('aria-describedby'),
      focus: document.activeElement.id,
      valid: document.getElementById('email').validationMessage === '' || document.getElementById('login-form').noValidate
    }));
    assert.deepEqual(state, { email: 'Enter your email.', password: 'Enter your password.', invalid: ['true', 'true'], described: 'email-error login-error', focus: 'email', valid: true });
    await page.fill('#email', 'not-an-email');
    await page.fill('#password', 'x');
    await page.click('#login-btn');
    assert.equal(await page.textContent('#email-error'), 'Enter an email address like name@example.com.');
    assert.equal(await page.isHidden('#password-error'), true);
    assert.equal(record.requests.some((entry) => entry.path.includes('/auth/v1/token')), false, 'nothing is sent while a field is invalid');
  } finally { await close(); }
});

test('P2: recovery that cannot connect has no spinner and offers Reload page', { skip }, async () => {
  const { page, context, close } = await launchAtlas({ signedIn: false, waitReady: false, ...PHONE });
  try {
    await context.route('**/assets/js/rehearsal-boundary.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'window.AtlasRehearsalBoundary = { validate() { throw new Error("offline"); } };' }));
    await page.goto(`${ORIGIN}/recovery.html`);
    await page.waitForSelector('#recovery-reload:not([hidden])');
    const button = await page.evaluate(() => { const node = document.querySelector('#request-recovery button'); return { disabled: node.disabled, loading: node.classList.contains('is-loading') }; });
    assert.deepEqual(button, { disabled: true, loading: false });
    assert.match(await page.textContent('#status'), /couldn't connect/);
  } finally { await close(); }
});

test('eng P2-3: a saved session for a deactivated profile shows the access message, not a connection error', { skip }, async () => {
  const inactive = { ...USERS.bartender, active: false };
  const { page, close } = await launchAtlas({ user: inactive, fixtures: { profiles: [inactive] }, waitReady: 'none' });
  try {
    await page.waitForSelector('#login-error:not([hidden])');
    assert.match(await page.textContent('#login-error'), /not an active VÁ staff profile/);
    assert.equal(await page.textContent('#login-btn'), 'Sign in');
    assert.equal(await page.evaluate(() => document.getElementById('app-screen').style.display), 'none');
  } finally { await close(); }
});

// ---------- routing ----------

test('eng P3: legacy aliases rewrite to the canonical address; unknown routes show Page not found', { skip }, async () => {
  const { page, record, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group: 'C' }), hash: '#business' });
  try {
    await page.waitForFunction(() => location.hash === '#reports/overview');
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'reports');
    const length = await page.evaluate(() => history.length);
    await page.evaluate(() => { location.hash = '#dashboard'; });
    await page.waitForFunction(() => location.hash === '#home');
    assert.equal(await page.evaluate(() => history.length), length + 1, 'the alias is replaced, not stacked');
    await page.evaluate(() => { location.hash = '#bogus'; });
    await page.waitForFunction(() => document.body.dataset.atlasView === 'not-found');
    assert.equal(await page.textContent('#not-found-view .page-head__title'), 'Page not found');
    assert.equal(await page.isVisible('#dashboard-view'), false, 'the previous page is gone');
    assert.equal(await page.evaluate(() => location.hash), '#bogus');
    await page.click('#not-found-view a[href="#home"]');
    await page.waitForFunction(() => document.body.dataset.atlasView === 'dashboard');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
  const direct = await launchAtlas({ fixtures: uxWorld(USERS.admin), hash: '#nope/at/all' });
  try {
    assert.equal(await direct.page.evaluate(() => document.body.dataset.atlasView), 'not-found');
  } finally { await direct.close(); }
});

test('eng P3: Escape on an item sheet opened from a link does not leave a history entry that reopens it', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group: 'INV' }), hash: `#inventory/item/${INV.campari}` });
  try {
    await page.waitForSelector('.inv-detail');
    const length = await page.evaluate(() => history.length);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => location.hash === '#inventory');
    assert.equal(await page.evaluate(() => history.length), length);
  } finally { await close(); }
});

test('eng P3: the palette offers manager-only destinations only to roles that can open them', { skip }, async () => {
  for (const [user, waste, access] of [[USERS.bartender, false, false], [USERS.admin, true, true]]) {
    const { page, close } = await launchAtlas({ user, fixtures: uxWorld(user) });
    try {
      const labels = await page.evaluate(() => [...window.AtlasSearch.destinations('waste'), ...window.AtlasSearch.destinations('access')].map((entry) => entry.title));
      assert.equal(labels.includes('Inventory › Waste'), waste, `${user.role}: ${labels}`);
      assert.equal(labels.includes('Settings › Team access'), access, `${user.role}: ${labels}`);
    } finally { await close(); }
  }
});

test('P2: a question in the palette lists the record it is about under Ask Atlas', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group: 'INV' }) });
  try {
    await page.click('#atlas-omni');
    await page.fill('#atlas-palette-input', 'how many limes do we have?');
    await page.waitForFunction(() => document.querySelectorAll('#atlas-palette-list [role="option"]').length > 1);
    const rows = await page.$$eval('#atlas-palette-list [role="option"]', (nodes) => nodes.map((node) => node.textContent.trim().replace(/\s+/g, ' ')));
    assert.match(rows[0], /Ask Atlas/);
    assert.ok(rows.slice(1).some((row) => /Limes/.test(row)), rows.join(' | '));
  } finally { await close(); }
});

// ---------- native date and time pickers ----------
// Owner direction: dates and times use the platform pickers (accessible,
// phone-friendly); the value stays ISO and Atlas' own text stays 24 h.

test('P2: opening hours use native time pickers with whole-minute steps; a closed day cannot be edited', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin), contextOptions: { locale: 'en-US' } });
  try {
    await navigateTo(page, '#settings/hours');
    await page.waitForSelector('.settings-hours-row');
    const fields = await page.$$eval('.settings-hours-row [name="open_time"], .settings-hours-row [name="close_time"]', (nodes) => nodes.map((node) => ({ type: node.type, step: node.step, value: node.value, disabled: node.disabled, open: node.closest('tr').querySelector('[name="is_open"]').checked })));
    assert.ok(fields.length >= 14);
    for (const field of fields) {
      assert.equal(field.type, 'time');
      assert.equal(field.step, '60');
      if (field.value) assert.match(field.value, /^([01]\d|2[0-3]):[0-5]\d$/, 'the value is HH:MM (24 h) whatever the device locale shows');
      assert.equal(field.disabled, !field.open, 'a closed day’s times are unavailable');
    }
    const row = '.settings-hours-row[data-weekday="3"]';
    await page.fill(`${row} [name="open_time"]`, '09:30');
    await page.press(`${row} [name="open_time"]`, 'Tab');
    assert.equal(await page.inputValue(`${row} [name="open_time"]`), '09:30');
    assert.notEqual(await page.getAttribute(`${row} [name="open_time"]`, 'aria-invalid'), 'true');
    await page.uncheck(`${row} [name="is_open"]`);
    assert.equal(await page.isDisabled(`${row} [name="open_time"]`), true);
  } finally { await close(); }
});

test('P2: notification titles get two lines before they clamp', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin), viewport: { width: 390, height: 844 } });
  try {
    await page.evaluate(() => window.AtlasShell.notify.push({ id: 'long', severity: 'warning', title: 'Opening checklist is 4 of 12 done and the bar opens in fifteen minutes', detail: 'Operations' }));
    await page.click('#atlas-notifications-btn');
    await page.waitForSelector('.atlas-notify__item-title');
    const title = await page.evaluate(() => { const node = [...document.querySelectorAll('.atlas-notify__item-title')].find((el) => /fifteen/.test(el.textContent)); const style = getComputedStyle(node); return { clamp: style.webkitLineClamp, lines: Math.round(node.getBoundingClientRect().height / parseFloat(style.lineHeight)) }; });
    assert.equal(title.clamp, '2');
    assert.equal(title.lines, 2);
  } finally { await close(); }
});

test('P3: date fields are native pickers with ISO values, min/max limits and inline validation', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group: 'INV' }), contextOptions: { locale: 'en-US' } });
  try {
    await navigateTo(page, '#purchasing');
    await page.getByRole('button', { name: /new order/i }).filter({ visible: true }).first().click();
    await page.waitForSelector('#po-date');
    const field = await page.evaluate(() => { const input = document.getElementById('po-date'); return { type: input.type, min: input.min, today: window.AtlasVenueClock.today() }; });
    assert.equal(field.type, 'date');
    assert.equal(field.min, field.today, 'no expected delivery before the venue date');
    const later = await page.evaluate((key) => window.AtlasVenueClock.addDays(key, 6), field.today);
    await page.fill('#po-date', later);
    await page.press('#po-date', 'Tab');
    assert.equal(await page.inputValue('#po-date'), later, 'the value is YYYY-MM-DD in an en-US browser');
    assert.notEqual(await page.getAttribute('#po-date', 'aria-invalid'), 'true');
    const earlier = await page.evaluate((key) => window.AtlasVenueClock.addDays(key, -3), field.today);
    await page.fill('#po-date', earlier);
    await page.press('#po-date', 'Tab');
    assert.equal(await page.getAttribute('#po-date', 'aria-invalid'), 'true');
    const message = await page.evaluate(() => {
      const input = document.getElementById('po-date');
      const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/);
      const node = ids.map((id) => document.getElementById(id)).find((el) => el?.matches('[data-atlas-input-error]'));
      return node && !node.hidden ? node.textContent : null;
    });
    assert.match(message || '', /^Choose \w{3} \d{1,2} \w{3}.* or later\.$/, 'the inline message names the earliest date in Atlas wording');
    await page.fill('#po-date', later);
    await page.press('#po-date', 'Tab');
    assert.notEqual(await page.getAttribute('#po-date', 'aria-invalid'), 'true', 'fixing the value clears the message');
    assert.equal(await page.evaluate(() => document.querySelector('#po-date-native-error')?.hidden), true);
  } finally { await close(); }
});

test('P2: toasts carry a tone; permission toasts are info, not a success check', { skip }, async () => {
  const { page, close } = await launchAtlas({ user: USERS.bartender, fixtures: uxWorld(USERS.bartender, { group: 'INV' }) });
  try {
    await page.evaluate(() => window.AtlasShell.actions.run('inventory.item.add', { role: 'bartender' }).catch(() => null));
    await page.waitForSelector('.atlas-toast');
    assert.equal(await page.evaluate(() => document.querySelector('.atlas-toast').classList.contains('atlas-toast--info')), true);
  } finally { await close(); }
});
