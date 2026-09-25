// S90 workflow integrity (engineering acceptance P2-1, P2-2, P2-7, P2-8 and
// the P3 input checks), in a real browser against the mocked backend. The
// acceptance probe scratch scripts (suggest-dup.mjs) are kept here as
// permanent regression tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, until, USERS } from './harness.mjs';
import { IDS, inventoryWorld, purchasingBackend, countBackend, movements as baseMovements, iso } from './inventory-fixtures.mjs';
import { emptyFunctions, settingsBackend } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const MANAGER = { id: '7d3c1f10-0000-4000-8000-000000000004', email: 'mgr@example.test', display_name: 'Þórdís Ævarsdóttir', role: 'manager', active: true };

// A stateful adjust_inventory_v2 mock with the server's replay rule: one
// movement per request id; `outcomes` scripts what the page hears back.
function stockBackend(outcomes = []) {
  const ledger = new Map();
  const calls = [];
  const handler = (body) => {
    calls.push(body);
    const outcome = outcomes.shift() || 'ok';
    if (outcome === 'refuse') return { __status: 400, body: { code: '22023', message: 'Item not found or resulting quantity would be negative' } };
    if (outcome === 'lost') return { __status: 503, body: { message: 'upstream connect error' } };
    let row = ledger.get(body.p_request_id);
    if (!row) {
      row = { id: `f0f0f0f0-0000-4000-8000-00000000000${ledger.size + 1}`, item_id: body.p_item_id, movement_type: body.p_movement_type, quantity_change: body.p_quantity_change, unit_cost: body.p_unit_cost, note: body.p_note, created_at: iso(0) };
      ledger.set(body.p_request_id, row);
    }
    // 'timeout': the server committed, the answer never arrived.
    if (outcome === 'timeout') return { __status: 504, body: { message: 'upstream request timeout' } };
    return row;
  };
  return { handler, ledger, calls };
}

async function launch({ user = USERS.admin, purchasing = purchasingBackend(), stock = stockBackend(), counts, tables = {}, profiles } = {}) {
  const world = inventoryWorld({ purchasing, tables, rpc: { adjust_inventory_v2: stock.handler }, ...(counts ? { counts } : {}) });
  const fixtures = { ...world.fixtures, ...(profiles ? { profiles } : {}) };
  const app = await launchAtlas({ user, fixtures });
  return { ...app, purchasing, stock, world };
}

const creates = (purchasing) => purchasing.calls.filter((call) => call.p_action === 'create');
const draftsBySupplier = (purchasing) => purchasing.state.orders.filter((order) => order.status === 'draft')
  .reduce((map, order) => ({ ...map, [order.supplier_id]: (map[order.supplier_id] || 0) + 1 }), {});

async function openSuggestions(page) {
  await navigateTo(page, '#purchasing');
  await page.click('[data-po-suggestions]');
  await page.waitForSelector('#po-suggest-form');
  await settle(page);
}

// ---------------------------------------------------------------------------
// P2-1: retrying "Suggested order" never duplicates a supplier's draft
// ---------------------------------------------------------------------------
test('P2-1: a failed supplier is retried alone with the same order id; one draft per supplier', { skip }, async () => {
  const purchasing = purchasingBackend();
  const create = purchasing.rpc.atlas_purchase_order_command_v2;
  let failMata = 1;
  const attempts = [];
  purchasing.rpc.atlas_purchase_order_command_v2 = (body) => {
    if (body.p_action === 'create') attempts.push(body);
    if (body.p_action === 'create' && body.p_supplier_id === IDS.mata && failMata-- > 0) return { __status: 503, body: { message: 'upstream timeout' } };
    return create(body);
  };
  const { page, record, close } = await launch({ purchasing });
  try {
    await openSuggestions(page);
    assert.match(await page.textContent('[data-po-create-many]'), /Create 2 orders/);
    await page.click('[data-po-create-many]');
    await page.waitForSelector('#po-suggest-form [data-po-alert] .atlas-alert--danger');
    assert.match(await page.textContent('#po-suggest-form [data-po-alert]'), /1 created, 1 didn’t go through/);
    assert.equal(await page.$eval(`#po-suggest-form [data-po-group] legend`, (node) => node.closest('fieldset').disabled), true, 'the created Globus group is locked');
    assert.match(await page.textContent('[data-po-create-many]'), /Create 1 order/);
    const firstMata = attempts.find((call) => call.p_supplier_id === IDS.mata);

    await page.click('[data-po-create-many]');
    await page.waitForSelector('#po-suggest-form', { state: 'detached' });
    const calls = attempts;
    assert.deepEqual(calls.map((call) => call.p_supplier_id), [IDS.globus, IDS.mata, IDS.mata], 'only the failed supplier is sent again');
    assert.equal(calls[2].p_id, firstMata.p_id, 'the retry reuses the order id');
    assert.deepEqual(draftsBySupplier(purchasing), { [IDS.globus]: 1, [IDS.mata]: 1 });
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('P2-1: a create that committed but timed out is retried with the same id after the sheet is reopened', { skip }, async () => {
  const purchasing = purchasingBackend();
  const create = purchasing.rpc.atlas_purchase_order_command_v2;
  let timeoutMata = 1;
  purchasing.rpc.atlas_purchase_order_command_v2 = (body) => {
    const result = create(body);
    if (body.p_action === 'create' && body.p_supplier_id === IDS.mata && timeoutMata-- > 0) return { __status: 504, body: { message: 'upstream request timeout' } };
    return result;
  };
  const { page, close } = await launch({ purchasing });
  try {
    await openSuggestions(page);
    await page.click('[data-po-create-many]');
    await page.waitForSelector('#po-suggest-form [data-po-alert] .atlas-alert--danger');
    const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('atlas.purchasing.suggested-order-ids.v1') || '{}'));
    const mataId = creates(purchasing).find((call) => call.p_supplier_id === IDS.mata).p_id;
    assert.deepEqual(Object.values(stored), [mataId], 'the unconfirmed id is kept for a retry after a reload');
    // Close and reopen: the page still believes Mata failed; the stored id is reused.
    await page.click('.atlas-sheet__close');
    await page.waitForSelector('#po-suggest-form', { state: 'detached' });
    // The page never heard that the Mata draft committed.
    assert.equal(await page.evaluate((id) => window.AtlasPurchasing.orders().some((order) => order.id === id), mataId), false);
    await page.click('[data-po-suggestions]');
    await page.waitForSelector('#po-suggest-form');
    await page.click('[data-po-create-many]');
    await page.waitForSelector('#po-suggest-form', { state: 'detached' });
    const mataCalls = creates(purchasing).filter((call) => call.p_supplier_id === IDS.mata);
    assert.equal(mataCalls.length, 2);
    assert.equal(mataCalls[1].p_id, mataId);
    assert.deepEqual(draftsBySupplier(purchasing), { [IDS.globus]: 1, [IDS.mata]: 1 });
    assert.equal(await page.evaluate(() => sessionStorage.getItem('atlas.purchasing.suggested-order-ids.v1')), null, 'the id is forgotten once the draft is confirmed');
  } finally { await close(); }
});

test('P3: a blank suggested quantity is a visible field error, not a silent revert', { skip }, async () => {
  const { page, purchasing, close } = await launch();
  try {
    await openSuggestions(page);
    await page.fill(`[data-po-suggest-qty="${IDS.limes}"]`, '');
    await page.click('[data-po-create-many]');
    await page.waitForSelector('#po-suggest-error');
    assert.match(await page.textContent('#po-suggest-error'), /Enter a quantity above 0 for Limes, or untick it\./);
    assert.equal(await page.getAttribute(`[data-po-suggest-qty="${IDS.limes}"]`, 'aria-invalid'), 'true');
    assert.equal(creates(purchasing).length, 0, 'nothing is created');
    await page.fill(`[data-po-suggest-qty="${IDS.limes}"]`, '30');
    await page.click('[data-po-create-many]');
    await page.waitForSelector('#po-suggest-form', { state: 'detached' });
    assert.equal(creates(purchasing).find((call) => call.p_supplier_id === IDS.mata).p_lines[0].quantity, 30);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// P2-7: items already on a draft / pending / approved order are not suggested
// ---------------------------------------------------------------------------
test('P2-7: items on an order waiting for approval are listed, not suggested again', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await openSuggestions(page);
    const form = await page.textContent('#po-suggest-form');
    assert.match(form, /Not suggested again: Campari \(on an order waiting for approval\), Aperol \(on an order waiting for approval\), Fever-Tree Tonic \(on order\)\./);
    const suggested = await page.$$eval('[data-po-include]', (nodes) => nodes.map((node) => node.value));
    assert.ok(!suggested.includes(IDS.campari) && !suggested.includes(IDS.aperol));
    assert.ok(suggested.includes(IDS.tanq) && suggested.includes(IDS.limes));
    assert.match(await page.textContent('.po-suggest'), /Not suggested again: Campari/);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// P2-2: waste and deliveries without an order are idempotent and honest
// ---------------------------------------------------------------------------
async function fillWaste(page) {
  await navigateTo(page, '#inventory/waste');
  await page.click('[data-inv-waste]');
  await page.waitForSelector('#inv-waste-form');
  await page.selectOption('#inv-w-item', IDS.tanq);
  await page.fill('#inv-w-qty', '1');
  await page.selectOption('#inv-w-reason', 'breakage');
  await page.fill('#inv-w-note', 'Dropped behind the bar');
}

test('P2-2: waste that committed but timed out is confirmed by a retry with the same request id, recorded once', { skip }, async () => {
  const stock = stockBackend(['timeout', 'ok']);
  const { page, close } = await launch({ stock });
  try {
    await fillWaste(page);
    await page.click('button[form="inv-waste-form"]');
    await page.waitForSelector('#inv-waste-form [data-inv-form-alert] .atlas-alert');
    const alert = await page.textContent('#inv-waste-form [data-inv-form-alert]');
    assert.match(alert, /We couldn’t confirm the save\. Check Movements before trying again\./);
    assert.doesNotMatch(alert, /Stock is unchanged/);
    assert.ok(await page.$('#inv-waste-form [data-inv-form-alert] a[href="#inventory/movements"]'));
    await page.click('button[form="inv-waste-form"]');
    await page.waitForSelector('#inv-waste-form', { state: 'detached' });
    assert.equal(stock.calls.length, 2);
    assert.equal(stock.calls[1].p_request_id, stock.calls[0].p_request_id);
    assert.equal(stock.ledger.size, 1, 'one waste movement');
    assert.deepEqual([stock.calls[0].p_movement_type, stock.calls[0].p_quantity_change], ['waste', -1]);
  } finally { await close(); }
});

test('P2-2: a refused waste says why and that nothing was recorded; a lost request is never "unchanged"', { skip }, async () => {
  const stock = stockBackend(['refuse', 'lost']);
  const { page, close } = await launch({ stock });
  try {
    await fillWaste(page);
    await page.click('button[form="inv-waste-form"]');
    await page.waitForSelector('#inv-waste-form [data-inv-form-alert] .atlas-alert--danger');
    assert.match(await page.textContent('#inv-waste-form [data-inv-form-alert]'), /stock record for this item is lower than that quantity, so nothing was recorded/);
    await page.click('button[form="inv-waste-form"]');
    await page.waitForFunction(() => /couldn’t confirm the save/.test(document.querySelector('#inv-waste-form [data-inv-form-alert]')?.textContent || ''));
    assert.equal(stock.ledger.size, 0);
  } finally { await close(); }
});

test('P2-2: a delivery without an order validates cost and discount, and a retry after a timeout receives once', { skip }, async () => {
  const stock = stockBackend(['timeout', 'ok']);
  const { page, close } = await launch({ stock });
  try {
    await navigateTo(page, '#purchasing');
    await page.evaluate(() => window.AtlasPurchasing.receive());
    await page.waitForSelector('#po-restock-form', { state: 'attached' });
    await page.click('.po-noorder summary');
    await page.selectOption('#po-rs-item', IDS.limes);
    await page.fill('#po-rs-qty', '40');
    await page.fill('#po-rs-cost', '60');
    await page.fill('#po-rs-discount', '150');
    await page.click('#po-restock-form button[type="submit"]');
    await page.waitForSelector('#po-restock-form [aria-invalid="true"]');
    assert.match(await page.textContent('#po-restock-form [data-po-alert]'), /Enter a discount between 0 and 100 %\./);
    assert.equal(stock.calls.length, 0);
    await page.fill('#po-rs-discount', '10');
    await page.click('#po-restock-form button[type="submit"]');
    await page.waitForFunction(() => /couldn’t confirm the save/.test(document.querySelector('#po-restock-form [data-po-alert]')?.textContent || ''));
    assert.doesNotMatch(await page.textContent('#po-restock-form [data-po-alert]'), /Stock is unchanged/);
    await page.click('#po-restock-form button[type="submit"]');
    await page.waitForSelector('#po-restock-form', { state: 'detached' });
    assert.equal(stock.calls.length, 2);
    assert.equal(stock.calls[1].p_request_id, stock.calls[0].p_request_id);
    assert.equal(stock.ledger.size, 1, 'one delivery movement');
    assert.deepEqual([stock.calls[0].p_movement_type, stock.calls[0].p_quantity_change, stock.calls[0].p_unit_cost], ['restock', 40, 54]);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// P2-8: "Verify anyway" lists what changed after each line was counted
// ---------------------------------------------------------------------------
test('P2-8: Verify anyway names the delivery received after an item was counted and keeps it', { skip }, async () => {
  const counts = countBackend({ status: 'submitted' });
  counts.lines[0].counted_at = iso(-0.05); // Campari counted about an hour ago
  counts.lines[1].counted_at = iso(-0.05); // Tanqueray too
  const handler = (entry) => {
    if (entry.action === 'verify' && entry.body?.acknowledge_conflicts !== true) {
      counts.calls.push(entry);
      return { __status: 409, body: { error: 'The production source changed for 1 counted item(s). Review and acknowledge the conflicts before verification' } };
    }
    return counts.handler(entry);
  };
  const delivery = { id: 'm9', item_id: IDS.campari, item_name: 'Campari', movement_type: 'restock', quantity_change: 6, note: 'Delivery', created_at: iso(-0.02) };
  const earlier = { id: 'm8', item_id: IDS.tanq, item_name: 'Tanqueray London Dry', movement_type: 'restock', quantity_change: 6, note: 'Before the count', created_at: iso(-0.08) };
  const list = [...baseMovements, delivery, earlier];
  const { page, close } = await launch({ counts: { ...counts, handler }, tables: { inventory_movements: list, inventory_movement_catalog: list } });
  try {
    await navigateTo(page, `#inventory/counts/${IDS.session}`);
    await page.click('[data-count-verify]');
    await page.waitForSelector('#sc-dialog-form');
    await page.click('button[form="sc-dialog-form"]');
    await page.waitForSelector('[data-sc-dialog-list]');
    const dialog = await page.textContent('#sc-dialog-form');
    assert.match(dialog, /anything recorded after that is added on top, so nothing is erased/);
    const rows = await page.$$eval('[data-sc-dialog-list] li', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(rows, ['Campari: +6 bottles recorded after it was counted']);
    await page.click('button[form="sc-dialog-form"]');
    await until(() => counts.calls.some((call) => call.action === 'verify' && call.body?.acknowledge_conflicts === true), { message: 'the acknowledged verify' });
    await settle(page);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// P3: opening hours conflicts are caught in the editor
// ---------------------------------------------------------------------------
test('P3: overlapping, zero-length and backwards opening hours are caught inline before any request', { skip }, async () => {
  const backend = settingsBackend();
  const { page, close } = await launchAtlas({ fixtures: { functions: { ...emptyFunctions(), 'atlas-settings': backend.handler } } });
  try {
    await navigateTo(page, '#settings/hours');
    await page.waitForSelector('[data-settings-hours-form]');
    const row = (day) => `.settings-hours-row[data-weekday="${day}"]`;
    const submit = () => page.click('[data-settings-hours-form] button[type="submit"]');
    const note = () => page.textContent('[data-settings-hours-conflict]');
    // Friday 16:00 → 16:00 without Next day: zero length.
    await page.check(`${row(5)} [name="is_open"]`);
    await page.fill(`${row(5)} [name="open_time"]`, '16:00');
    await page.fill(`${row(5)} [name="close_time"]`, '16:00');
    await submit();
    await page.waitForSelector('[data-settings-hours-conflict]');
    assert.match(await note(), /Friday opens and closes at the same time/);
    assert.equal(await page.getAttribute(`${row(5)} [name="close_time"]`, 'aria-invalid'), 'true');
    // 02:00 without Next day closes before it opens.
    await page.fill(`${row(5)} [name="close_time"]`, '02:00');
    await submit();
    await page.waitForFunction(() => /Friday closes before it opens/.test(document.querySelector('[data-settings-hours-conflict]')?.textContent || ''));
    // Next day, but Saturday opens at 01:00: overlap.
    await page.check(`${row(5)} [name="close_next_day"]`);
    await page.check(`${row(6)} [name="is_open"]`);
    await page.fill(`${row(6)} [name="open_time"]`, '01:00');
    await page.fill(`${row(6)} [name="close_time"]`, '23:00');
    await submit();
    await page.waitForFunction(() => /Friday closes at 02:00 after midnight, but Saturday opens at 01:00/.test(document.querySelector('[data-settings-hours-conflict]')?.textContent || ''));
    assert.equal(backend.calls.filter((entry) => entry.action === 'save-hours').length, 0);
    // Fixed: saves, and the conflict note goes away.
    await page.fill(`${row(6)} [name="open_time"]`, '16:00');
    await submit();
    await until(() => backend.calls.some((entry) => entry.action === 'save-hours'), { message: 'save-hours' });
    assert.equal(await page.$('[data-settings-hours-conflict]'), null);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// P3: Approve follows the approval policy
// ---------------------------------------------------------------------------
test('P3: a manager sees why they cannot approve when the policy needs an administrator; an admin can approve', { skip }, async () => {
  for (const [user, canApprove] of [[MANAGER, false], [USERS.admin, true]]) {
    const purchasing = purchasingBackend({ policyOverrides: { approval_approver_role: 'admin' } });
    const { page, close } = await launch({ user, purchasing, profiles: [USERS.admin, USERS.bartender, MANAGER] });
    try {
      await navigateTo(page, `#purchasing/order/${IDS.po1}`);
      await page.waitForSelector('[data-po-cmd="reject"]');
      if (canApprove) {
        assert.ok(await page.$('[data-po-cmd="approve"]'), 'admin sees Approve');
      } else {
        assert.equal(await page.$('[data-po-cmd="approve"]'), null, 'no Approve for a manager');
        assert.match(await page.textContent('[data-po-approve-blocked]'), /Only an administrator can approve this order\./);
      }
    } finally { await close(); }
  }
});
