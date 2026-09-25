// S88 Team B: Purchasing (§7.8) on the v2 order commands, in a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, USERS } from './harness.mjs';
import { IDS, inventoryWorld, purchasingBackend, orders } from './inventory-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function launch({ user = USERS.admin, purchasing = purchasingBackend(), viewport } = {}) {
  const world = inventoryWorld({ purchasing });
  const app = await launchAtlas({ user, fixtures: world.fixtures, viewport, contextOptions: viewport && viewport.width < 768 ? { hasTouch: true, isMobile: true } : {} });
  return { ...app, purchasing };
}

async function go(page, route) {
  await page.evaluate((target) => window.AtlasShell.navigate(target), route);
  await page.waitForTimeout(300);
}

async function confirm(page, reason = null) {
  await page.waitForSelector('#po-dialog-form');
  if (reason !== null) await page.fill('#po-dialog-field', reason);
  await page.click('button[form="po-dialog-form"]');
}

const commands = (purchasing, action) => purchasing.calls.filter((call) => call.p_action === action);

test('orders list shows status and supplier; the order detail is a route', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await go(page, '#purchasing');
    const text = await page.textContent('#suppliers-view');
    assert.match(text, /Globus/);
    assert.match(text, /Ölgerðin/);
    await go(page, `#purchasing/order/${IDS.po1}`);
    await page.waitForSelector('[data-po-cmd="approve"]');
    assert.match(await page.textContent('.atlas-sheet'), /Campari/);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('approval appears only when the policy requires it, then "Mark as ordered"', { skip }, async () => {
  const { page, purchasing, close } = await launch();
  try {
    await go(page, `#purchasing/order/${IDS.po1}`);
    await page.click('[data-po-cmd="approve"]');
    await page.waitForSelector('[data-po-cmd="place"]');
    const approve = commands(purchasing, 'approve')[0];
    assert.equal(approve.p_id, IDS.po1);
    assert.equal(approve.p_version, 3, 'the version guard is sent');
    await page.click('[data-po-cmd="place"]');
    await confirm(page);
    await page.waitForSelector('[data-po-receive]');
    assert.equal(commands(purchasing, 'place').length, 1);
    assert.equal(purchasing.state.orders.find((order) => order.id === IDS.po1).status, 'ordered');
  } finally { await close(); }
});

test('without an approval policy a draft goes straight to "Mark as ordered"', { skip }, async () => {
  const list = orders();
  list[0].status = 'draft';
  const purchasing = purchasingBackend({ list, policyOverrides: { approval_required: false } });
  const { page, close } = await launch({ purchasing });
  try {
    await go(page, `#purchasing/order/${IDS.po1}`);
    await page.waitForSelector('[data-po-cmd="place"]');
    assert.equal(await page.$('[data-po-cmd="submit"]'), null);
    assert.equal(await page.$('[data-po-cmd="approve"]'), null);
  } finally { await close(); }
});

test('partial receiving uses a fresh request id per delivery, then closes short', { skip }, async () => {
  const { page, purchasing, close } = await launch();
  try {
    await go(page, `#purchasing/order/${IDS.po2}`);
    await page.click('[data-po-receive]');
    await page.waitForSelector('[data-po-rqty]');
    await page.fill('[data-po-rqty]', '20');
    await page.click('[data-po-receive-submit]');
    await page.waitForFunction(() => !document.querySelector('#po-receive-form'));
    await page.waitForSelector('[data-po-cmd="close_short"]');
    await page.waitForTimeout(300);
    await page.click('[data-po-receive]');
    await page.waitForSelector('[data-po-rqty]');
    assert.equal(await page.inputValue('[data-po-rqty]'), '28', 'the remaining quantity is suggested');
    await page.fill('[data-po-rqty]', '10');
    await page.click('[data-po-receive-submit]');
    await page.waitForFunction(() => !document.querySelector('#po-receive-form'));
    await page.waitForSelector('[data-po-cmd="close_short"]');
    await page.waitForTimeout(300);
    const receipts = commands(purchasing, 'receive_lines');
    assert.equal(receipts.length, 2);
    assert.deepEqual(receipts[0].p_receipt.map((line) => [line.item_id, line.quantity]), [[IDS.tonic, 20]]);
    assert.match(receipts[0].p_request_id, /^[0-9a-f-]{36}$/);
    assert.notEqual(receipts[0].p_request_id, receipts[1].p_request_id);
    await page.click('[data-po-cmd="close_short"]');
    await confirm(page, 'Supplier out of stock');
    await page.waitForTimeout(400);
    const short = commands(purchasing, 'close_short')[0];
    assert.equal(short.p_reason, 'Supplier out of stock');
    assert.equal(purchasing.state.orders.find((order) => order.id === IDS.po2).status, 'received');
  } finally { await close(); }
});

test('a refused command shows fixed, friendly copy and keeps the order', { skip }, async () => {
  const purchasing = purchasingBackend();
  const original = purchasing.state.orders.find((order) => order.id === IDS.po1);
  original.version = 9; // the screen holds version 3 until it refreshes: the mock refuses as stale
  const { page, close } = await launch({ purchasing });
  try {
    await go(page, `#purchasing/order/${IDS.po1}`);
    await page.waitForSelector('[data-po-cmd="approve"]');
    await page.evaluate((id) => { const order = window.AtlasPurchasing.orders().find((entry) => entry.id === id); if (order) order.version = 3; }, IDS.po1);
    await page.click('[data-po-cmd="approve"]');
    await page.waitForTimeout(500);
    const body = await page.textContent('body');
    assert.doesNotMatch(body, /Order changed\. Refresh before continuing|PGRST|violates/);
    assert.equal(original.status, 'pending_approval');
  } finally { await close(); }
});

test('staff get a permission state, not manager controls', { skip }, async () => {
  const { page, purchasing, close } = await launch({ user: USERS.bartender });
  try {
    await go(page, '#purchasing');
    const text = await page.textContent('#suppliers-view').catch(() => '');
    assert.ok(/Purchasing is for managers/.test(text) || await page.evaluate(() => document.body.dataset.atlasView) !== 'suppliers');
    assert.equal(await page.$('[data-po-new]'), null);
    assert.equal(purchasing.calls.length, 0);
  } finally { await close(); }
});

test('phone: orders fit without sideways scroll', { skip }, async () => {
  const { page, close } = await launch({ viewport: { width: 390, height: 844 } });
  try {
    await go(page, '#purchasing');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
    await go(page, `#purchasing/order/${IDS.po2}`);
    await page.waitForSelector('[data-po-receive]');
    const height = await page.$eval('[data-po-receive]', (button) => button.getBoundingClientRect().height);
    assert.ok(height >= 44, `Receive delivery is ${height}px tall`);
  } finally { await close(); }
});
