// Design/UX acceptance, round 2 — regressions from the shared remediation:
//   N-1  on a touch device the active tab's indicator sits under the label
//        (the 44 px hit-area ::after no longer merges with it);
//   N-2  step labels are one line each and never split mid-word;
//   N-3  Data › Import review phone rows keep their side padding;
//   N-4  a partly received order has no sideways scroll on the phone;
//   N-5  the toast action (Undo) is a 44 px touch target;
//   and the P2 follow-ups (toast above a sticky action bar, hours validation
//   in view, one inventory value in Reports, plurals, table headers).
// Mocked backend, frozen harness clock, no sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, USERS } from './harness.mjs';
import { uxWorld, INV } from './ux-world-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const PHONE = { viewport: { width: 390, height: 844 }, contextOptions: { hasTouch: true, isMobile: true } };
const DESK = { viewport: { width: 1440, height: 900 } };

// ---------- N-1 tab indicator ----------

// The active tab's ::after box (from its resolved style and transform) and
// the box of the label text.
const activeTab = (page, scope) => page.evaluate((root) => {
  const tab = [...document.querySelectorAll(`${root} .atlas-tabs > [aria-current="page"]`)].find((node) => node.getClientRects().length);
  if (!tab) return null;
  const box = tab.getBoundingClientRect();
  const style = getComputedStyle(tab, '::after');
  const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform);
  const text = [...tab.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  const range = document.createRange();
  range.selectNodeContents(text);
  const label = range.getBoundingClientRect();
  return {
    name: text.textContent.trim(),
    tab: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height },
    indicator: { top: box.top + parseFloat(style.top) + matrix.m42, left: box.left + parseFloat(style.left) + matrix.m41, width: parseFloat(style.width), height: parseFloat(style.height) },
    label: { top: label.top, bottom: label.bottom },
    lines: range.getClientRects().length
  };
}, scope);

test('N-1: on a touch phone the active tab indicator is a 2 px line under the label, across the tab', { skip }, async () => {
  for (const [group, routes] of [['INV', ['#inventory', '#purchasing']], ['C', ['#data', '#reports/overview']], ['P', ['#shifts', '#knowledge']], ['A', ['#operations']]]) {
    const { page, record, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group }), ...PHONE });
    try {
      assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
      for (const route of routes) {
        await navigateTo(page, route);
        const state = await activeTab(page, '#atlas-main');
        assert.ok(state, `${route}: an active tab`);
        const where = `${route} "${state.name}": ${JSON.stringify(state)}`;
        assert.equal(state.indicator.height, 2, where);
        assert.ok(state.indicator.top >= state.label.bottom, `the indicator is below the label text, ${where}`);
        assert.ok(Math.abs(state.indicator.top + 2 - (state.tab.bottom + 1)) <= 1, `the indicator sits on the tab strip's bottom edge, ${where}`);
        assert.ok(Math.abs(state.indicator.left - state.tab.left) <= 1 && state.indicator.width <= state.tab.right - state.tab.left + 1, `the indicator spans the tab, ${where}`);
        assert.ok(state.tab.height >= 44, `the tab is a 44 px target, ${where}`);
      }
      assert.deepEqual(record.pageErrors, []);
    } finally { await close(); }
  }
});

test('N-1: text links keep their 44 px touch hit area; tab and segmented items get none', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group: 'C' }), ...PHONE });
  try {
    await navigateTo(page, '#data');
    const state = await page.evaluate(() => {
      const after = (node) => { const style = getComputedStyle(node, '::after'); return style.content === 'none' ? null : { height: parseFloat(style.height), position: style.position }; };
      const tab = document.querySelector('#data-view .atlas-tabs > a:not([aria-current])');
      const segment = document.querySelector('#data-view .atlas-segmented > *');
      const probe = document.createElement('a');
      probe.href = '#home';
      probe.textContent = 'a text link';
      document.querySelector('#data-view').append(probe);
      const link = after(probe);
      probe.remove();
      return { tab: after(tab), segment: segment ? after(segment) : null, link };
    });
    assert.equal(state.tab, null, 'a tab has no hit-area pseudo-element');
    assert.equal(state.segment, null, 'a segmented item has no hit-area pseudo-element');
    assert.deepEqual(state.link, { height: 44, position: 'absolute' }, 'a plain text link still gets the 44 px hit area');
  } finally { await close(); }
});

// ---------- N-2 steps and headers ----------

// Every visible step label: its text on one line, the item on one row.
const stepLabels = (page) => page.evaluate(() => [...document.querySelectorAll('.atlas-steps > li:not(.sep)')].filter((li) => li.getClientRects().length).map((li) => {
  const text = [...li.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  const range = document.createRange();
  range.selectNodeContents(text);
  const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  const list = li.parentElement.getBoundingClientRect();
  const box = li.getBoundingClientRect();
  return { label: text.textContent.trim(), lines, height: Math.round(box.height), inside: box.left >= list.left - 1 && box.right <= list.right + 1 };
}));

test('N-2: Data import steps at 390 on touch are one line each and never split', { skip }, async () => {
  const { page, record, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group: 'C' }), ...PHONE });
  try {
    await navigateTo(page, '#data');
    const href = await page.$eval('#data-view a.cell-primary[href$="000000000201"]', (node) => node.getAttribute('href'));
    await navigateTo(page, href);
    await page.waitForSelector('#data-view .atlas-steps');
    const steps = await stepLabels(page);
    assert.ok(steps.length >= 3, JSON.stringify(steps));
    for (const step of steps) {
      assert.equal(step.lines, 1, `"${step.label}" is on one line: ${JSON.stringify(steps)}`);
      assert.ok(step.height <= 24, `"${step.label}" is one row: ${JSON.stringify(steps)}`);
      assert.equal(step.inside, true, `"${step.label}" is inside the stepper`);
    }
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('N-2: the order sheet stepper never splits a word; where a full row does not fit it shows the compact form', { skip }, async () => {
  for (const [label, options] of [['1440', DESK], ['1024', { viewport: { width: 1024, height: 800 } }], ['390', PHONE]]) {
    const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group: 'INV' }), ...options });
    try {
      for (const order of [INV.po1, INV.po2]) {
        await navigateTo(page, `#purchasing/order/${order}`);
        await page.waitForSelector('.po-steps-compact');
        await settle(page);
        for (const step of await stepLabels(page)) assert.equal(step.lines, 1, `${label} ${order}: "${step.label}" split`);
        const state = await page.evaluate(() => {
          const full = document.querySelector('.po-steps');
          const compact = document.querySelector('.po-steps-compact');
          const shown = (node) => node.getClientRects().length > 0;
          return { full: shown(full), compact: shown(compact), text: compact.textContent.trim(), fits: full.scrollWidth <= full.clientWidth + 1 };
        });
        assert.notEqual(state.full, state.compact, `${label}: exactly one stepper form is shown`);
        if (state.full) assert.equal(state.fits, true, `${label}: the full stepper fits its row`);
        else assert.match(state.text, /^Step \d of \d · \S/, label);
      }
    } finally { await close(); }
  }
});

test('N-2: the Opening hours table headers never break inside a word', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin), ...DESK });
  try {
    await navigateTo(page, '#settings/hours');
    await page.waitForSelector('.settings-hours thead th');
    const headers = await page.$$eval('.settings-hours thead th', (nodes) => nodes.map((th) => {
      const range = document.createRange();
      range.selectNodeContents(th);
      const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      return { text: th.textContent.trim(), lines, words: th.textContent.trim().split(/\s+/).length };
    }));
    for (const header of headers) assert.ok(header.lines <= header.words, `"${header.text}" breaks inside a word: ${JSON.stringify(headers)}`);
    assert.equal(headers.find((header) => header.text === 'Open').lines, 1);
  } finally { await close(); }
});

// ---------- N-3 Data list padding ----------

test('N-3: Data › Import review rows on the phone keep at least 12 px of side padding', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group: 'C' }), ...PHONE });
  try {
    await navigateTo(page, '#data/import-review');
    await page.waitForSelector('#data-view .atlas-table-list__row');
    const rows = await page.$$eval('#data-view .atlas-table-list__row', (nodes) => nodes.filter((node) => node.getClientRects().length).map((row) => {
      const box = row.getBoundingClientRect();
      const title = row.querySelector('.atlas-table-list__title').getBoundingClientRect();
      const value = row.querySelector('.atlas-table-list__value > *')?.getBoundingClientRect() || box;
      const style = getComputedStyle(row);
      return { tag: row.tagName, paddingLeft: parseFloat(style.paddingLeft), paddingRight: parseFloat(style.paddingRight), textLeft: Math.round(title.left - box.left), endRight: Math.round(box.right - value.right), border: style.borderBottomWidth, viewport: innerWidth, right: Math.round(box.right) };
    }));
    assert.ok(rows.length >= 3, JSON.stringify(rows));
    for (const row of rows) {
      assert.equal(row.tag, 'BUTTON');
      assert.ok(row.paddingLeft >= 12 && row.paddingRight >= 12, JSON.stringify(row));
      assert.ok(row.textLeft >= 12, `the title starts inside the padding: ${JSON.stringify(row)}`);
      assert.ok(row.endRight >= 12, `the status pill ends inside the padding: ${JSON.stringify(row)}`);
      assert.equal(row.border, '1px', 'the row keeps its hairline');
      assert.ok(row.right <= row.viewport, JSON.stringify(row));
    }
  } finally { await close(); }
});

// ---------- N-4 partly received order ----------

async function partlyReceive(page) {
  await navigateTo(page, `#purchasing/order/${INV.po2}`);
  await page.click('[data-po-receive]');
  await page.waitForSelector('[data-po-rqty]');
  await page.fill('[data-po-rqty]', '20');
  await page.click('[data-po-receive-submit]');
  await page.waitForFunction(() => !document.querySelector('#po-receive-form'));
  await page.waitForSelector('[data-po-cmd="close_short"]');
  await settle(page);
}

test('N-4: a partly received order sheet on the phone has no horizontal overflow and lists its lines as rows', { skip }, async () => {
  const { page, record, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group: 'INV' }), ...PHONE });
  try {
    await partlyReceive(page);
    const state = await page.evaluate(() => {
      const sheet = [...document.querySelectorAll('.atlas-sheet')].find((node) => node.getClientRects().length && node.querySelector('[data-po-cmd="close_short"]'));
      const body = sheet.querySelector('.atlas-sheet__body');
      const rows = [...sheet.querySelectorAll('.po-lines-list .atlas-table-list__row')].filter((node) => node.getClientRects().length);
      const outside = [...body.querySelectorAll('*')].filter((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 0.5; }).map((node) => node.className || node.tagName);
      const foot = [...sheet.querySelectorAll('.atlas-sheet__foot .atlas-btn')].map((button) => ({ label: button.textContent.trim(), fits: button.scrollWidth <= button.clientWidth + 1 }));
      return {
        scrollWidth: body.scrollWidth, clientWidth: body.clientWidth,
        table: sheet.querySelector('.atlas-sheet__body .atlas-table-wrap').getClientRects().length,
        rows: rows.map((row) => row.textContent.replace(/\s+/g, ' ').trim()),
        outside, foot
      };
    });
    assert.ok(state.scrollWidth <= state.clientWidth, `sheet body ${state.scrollWidth} > ${state.clientWidth}`);
    assert.deepEqual(state.outside, [], 'nothing past the right edge');
    assert.equal(state.table, 0, 'the lines table is replaced by rows on the phone');
    assert.equal(state.rows.length, 1);
    assert.match(state.rows[0], /Fever-Tree Tonic/);
    assert.match(state.rows[0], /received 20 \(28 left\)/);
    assert.match(state.rows[0], /9\.120 kr/);
    for (const button of state.foot) assert.equal(button.fits, true, `"${button.label}" fits its button`);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- N-5 / N-11 toast ----------

async function saveCount(page) {
  await navigateTo(page, `#inventory/counts/${INV.session}`);
  await page.waitForSelector('[data-count-qty]');
  await page.fill('[data-count-qty]', '1.5');
  await page.click('[data-count-save]');
  await page.waitForSelector('.atlas-toast__action');
}

test('N-5: the toast Undo is a 44 px touch target on the phone', { skip }, async () => {
  for (const user of [USERS.admin, USERS.bartender]) {
    const { page, close } = await launchAtlas({ user, fixtures: uxWorld(user, { group: 'INV' }), ...PHONE });
    try {
      await saveCount(page);
      // Pause the toast (as hovering does) and measure in the same task, so a
      // slow run can't let it time out between the wait and the measurement.
      const state = await (await page.waitForFunction(() => {
        const node = document.querySelector('.atlas-toast:not(.is-leaving)');
        const button = node && node.querySelector('.atlas-toast__action');
        if (!button) return null;
        node.dispatchEvent(new MouseEvent('mouseenter'));
        const action = button.getBoundingClientRect();
        const toast = node.getBoundingClientRect();
        return { width: action.width, height: action.height, inside: action.top >= toast.top - 0.5 && action.bottom <= toast.bottom + 0.5 };
      })).jsonValue();
      assert.ok(state.height >= 44 && state.width >= 44, `${user.role}: ${JSON.stringify(state)}`);
      assert.equal(state.inside, true, 'the target stays inside the toast');
    } finally { await close(); }
  }
});

test('N-11: the toast never covers the sticky Save and next bar', { skip }, async () => {
  for (const options of [DESK, PHONE]) {
    const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group: 'INV' }), ...options });
    try {
      await saveCount(page);
      const state = await page.evaluate(() => {
        const toast = document.querySelector('.atlas-toast').getBoundingClientRect();
        const bar = document.querySelector('[data-atlas-sticky-actions]').getBoundingClientRect();
        return { toastBottom: toast.bottom, barTop: bar.top };
      });
      assert.ok(state.toastBottom <= state.barTop, `${options.viewport.width}: ${JSON.stringify(state)}`);
    } finally { await close(); }
  }
});

// ---------- P2 follow-ups ----------

test('N-8: an open day without times is marked invalid in place, focused and its message is in view', { skip }, async () => {
  for (const options of [DESK, PHONE]) {
    const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin), ...options });
    try {
      await navigateTo(page, '#settings/hours');
      await page.waitForSelector('.settings-hours-row');
      const row = '.settings-hours-row[data-weekday="2"]';
      await page.fill(`${row} [name="open_time"]`, '');
      await page.locator('[data-settings-hours-form] button[type="submit"]').click();
      await page.waitForSelector('[data-settings-hours-conflict]');
      const state = await page.evaluate((selector) => {
        const input = document.querySelector(`${selector} [name="open_time"]`);
        const note = document.querySelector('[data-settings-hours-conflict]');
        const box = note.getBoundingClientRect();
        const bar = document.querySelector('[data-settings-hours-form] .settings-savebar')?.getBoundingClientRect();
        const top = document.querySelector('.atlas-topbar')?.getBoundingClientRect();
        return {
          focused: document.activeElement === input,
          invalid: input.getAttribute('aria-invalid'),
          described: (input.getAttribute('aria-describedby') || '').split(/\s+/).includes(note.id),
          value: input.value,
          text: note.textContent.trim(),
          visible: box.top >= (top && top.height ? top.bottom : 0) - 1 && box.bottom <= (bar && bar.height ? Math.min(innerHeight, bar.top) : innerHeight) + 1
        };
      }, row);
      const where = `${options.viewport.width}: ${JSON.stringify(state)}`;
      assert.equal(state.focused, true, where);
      assert.equal(state.invalid, 'true', where);
      assert.equal(state.described, true, where);
      assert.equal(state.value, '', 'the typed hours stay (no re-render)');
      assert.match(state.text, /^Tuesday is marked open/);
      assert.equal(state.visible, true, `the message is in view, ${where}`);
    } finally { await close(); }
  }
});

test('N-9: Reports shows one inventory value (Overview and Stock) and labour totals are not contradicted', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group: 'C' }), ...DESK });
  try {
    const statFor = (label) => page.evaluate((name) => {
      const stat = [...document.querySelectorAll('#reports-view .atlas-stat')].find((node) => node.querySelector('.atlas-stat__label')?.textContent.trim() === name);
      return stat ? [...stat.querySelectorAll('.atlas-stat__value, .atlas-stat__detail')].map((node) => node.textContent.trim()).join(' | ') : null;
    }, label);
    await navigateTo(page, '#reports/overview');
    await page.waitForSelector('#reports-view .atlas-stat');
    const overview = await statFor('Inventory value');
    await navigateTo(page, '#reports/stock');
    await page.waitForSelector('#reports-view .atlas-stat');
    const stock = await statFor('Stock value');
    assert.ok(overview, 'overview inventory value');
    assert.equal(stock, overview, 'the Stock tab shows the same figure as the Overview');
    const parts = await page.evaluate(() => window.AtlasReportsOverview.inventoryValueParts());
    const categories = await page.evaluate(() => window.AtlasReportsOverview.inventoryValueByCategory());
    assert.equal(Math.round(categories.reduce((sum, row) => sum + row.value, 0)), Math.round(parts.knownValue), 'the category chart adds up to the same lower bound');
    const units = await page.$$eval('#reports-view .atlas-stat', (nodes) => nodes.map((node) => node.querySelector('.atlas-stat__value')?.textContent.trim()));
    for (const unit of units) assert.doesNotMatch(unit || '', /^1\s?(items|recipes|shifts)$/, `plural: ${units}`);
    await navigateTo(page, '#reports/labour');
    await page.waitForSelector('#reports-view .atlas-stat');
    const text = await page.textContent('#reports-view');
    if (/Shifts\s*[1-9]/.test(text)) assert.doesNotMatch(text, /No records for this period/);
  } finally { await close(); }
});

test('N-6 / N-7: Scan delivery keeps its label inside the button; order and supplier counts are pluralised', { skip }, async () => {
  const { page, close } = await launchAtlas({ fixtures: uxWorld(USERS.admin, { group: 'INV' }), ...PHONE });
  try {
    await navigateTo(page, '#purchasing');
    await page.waitForSelector('#suppliers-view .atlas-table-list__meta');
    const metas = await page.$$eval('#suppliers-view .atlas-table-list__meta', (nodes) => nodes.map((node) => node.textContent));
    assert.ok(metas.some((meta) => /\b1 line\b/.test(meta)), metas.join(' | '));
    for (const meta of metas) assert.doesNotMatch(meta, /\b1 (lines|items)\b/);
    await navigateTo(page, '#purchasing/suppliers');
    await page.waitForSelector('#suppliers-view .atlas-table-list__meta');
    for (const meta of await page.$$eval('#suppliers-view .atlas-table-list__meta', (nodes) => nodes.map((node) => node.textContent))) assert.doesNotMatch(meta, /\b1 items\b/);
    await navigateTo(page, `#purchasing/order/${INV.po2}`);
    await page.click('[data-po-receive]');
    await page.waitForSelector('[data-po-scan]');
    await settle(page);
    const scan = await page.$eval('[data-po-scan]', (button) => ({ fits: button.scrollWidth <= button.clientWidth + 1, text: button.textContent.trim() }));
    assert.deepEqual(scan, { fits: true, text: 'Scan delivery' });
  } finally { await close(); }
});
