// S87 Shifts: the Month view add-shift path (a historical defect) and an
// overnight shift, exercised through the shipped weekly + Month modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, openView, requestsTo } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const people = [{ id: 'p-sara', display_name: 'Sara Jónsdóttir', active: true, login_enabled: true }, { id: 'p-jon', display_name: 'Jón Gunnarsson', active: true, login_enabled: false }];

function shiftsBackend() {
  const saved = [];
  const handler = (entry) => {
    const permissions = { can_manage_schedule: true };
    if (entry.method === 'POST' && entry.action === 'save-shift') {
      saved.push(entry.body);
      const monthStart = `${entry.body.starts_local.slice(0, 7)}-01`;
      return { workspace: { month: { month_start: monthStart, status: 'draft' }, people, permissions, shifts: saved.map((body, index) => ({ id: `s${index}`, ...body })) }, staff: { can_manage_schedule: true } };
    }
    if (entry.action === 'month-snapshot') {
      const monthStart = new URLSearchParams(entry.search).get('month_start');
      return { workspace: { month: { month_start: monthStart, status: 'draft' }, people, permissions, shifts: [] }, staff: { can_manage_schedule: true } };
    }
    return { workspace: { week: { status: 'draft' }, people, permissions, shifts: [], availability: [], time_off: [], responses: [] }, staff: { can_manage_schedule: true } };
  };
  return { handler, saved };
}

async function openMonth(viewport) {
  const backend = shiftsBackend();
  const app = await launchAtlas({ viewport, fixtures: { functions: { ...emptyFunctions(), 'atlas-shifts': backend.handler } } });
  await openView(app.page, 'shifts');
  await app.page.click('[data-shifts-tab="month"]');
  await app.page.waitForSelector('[data-shifts-month-add-day]');
  return { ...app, backend };
}

test('Month view: tapping a day add control opens the editor for that date and saves', { skip }, async () => {
  const { page, record, backend, close } = await openMonth();
  try {
    const date = await page.$eval('.shift-month-add-day[data-shifts-month-add-day], button.shift-month-empty[data-shifts-month-add-day]', (node) => node.dataset.shiftsMonthAddDay);
    await page.click(`[data-shifts-month-add-day="${date}"]`);
    await page.waitForSelector('.shift-month-modal form[data-shifts-month-shift-form]');
    assert.equal((await page.inputValue('.shift-month-modal [name="starts_local"]')).slice(0, 10), date, 'editor opens on the tapped date');
    await page.selectOption('.shift-month-modal [name="person_id"]', 'p-jon');
    await page.click('.shift-month-modal button[type="submit"]');
    await page.waitForTimeout(500);
    assert.equal(backend.saved.length, 1);
    assert.equal(backend.saved[0].person_id, 'p-jon');
    assert.equal(backend.saved[0].starts_local.slice(0, 10), date);
    assert.equal(requestsTo(record, 'atlas-shifts', 'save-shift').length, 1, 'one click saves once');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('Month view: an overnight shift is accepted and an end before start is refused', { skip }, async () => {
  const { page, backend, close } = await openMonth();
  try {
    const date = await page.$eval('[data-shifts-month-add-day]', (node) => node.dataset.shiftsMonthAddDay);
    const next = new Date(`${date}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    const nextDate = next.toISOString().slice(0, 10);
    await page.click(`[data-shifts-month-add-day="${date}"]`);
    await page.waitForSelector('.shift-month-modal form');
    await page.fill('.shift-month-modal [name="starts_local"]', `${date}T20:00`);
    await page.fill('.shift-month-modal [name="ends_local"]', `${date}T19:00`);
    await page.click('.shift-month-modal button[type="submit"]');
    await page.waitForTimeout(300);
    assert.equal(backend.saved.length, 0);
    assert.match(await page.textContent('[data-shifts-month-panel]'), /Shift end must be after shift start/);
    await page.fill('.shift-month-modal [name="ends_local"]', `${nextDate}T02:00`);
    await page.click('.shift-month-modal button[type="submit"]');
    await page.waitForTimeout(500);
    assert.equal(backend.saved.length, 1);
    assert.equal(backend.saved[0].ends_local.slice(0, 10), nextDate);
  } finally { await close(); }
});

test('Month view on a phone: the add control and the editor fit the screen', { skip }, async () => {
  const { page, backend, close } = await openMonth({ width: 390, height: 844 });
  try {
    const date = await page.$eval('[data-shifts-month-add-day]', (node) => node.dataset.shiftsMonthAddDay);
    await page.click(`[data-shifts-month-add-day="${date}"]`);
    await page.waitForSelector('.shift-month-modal form');
    const box = await page.$eval('.shift-month-modal section', (node) => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: window.innerWidth }; });
    assert.ok(box.left >= 0 && box.right <= box.width, `editor fits: ${JSON.stringify(box)}`);
    await page.click('.shift-month-modal button[type="submit"]');
    await page.waitForTimeout(500);
    assert.equal(backend.saved.length, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal page scroll');
  } finally { await close(); }
});
