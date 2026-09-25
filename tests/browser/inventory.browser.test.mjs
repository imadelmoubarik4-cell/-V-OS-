// S88 Team B: Inventory (§7.5), Add item through create-item, activation,
// stock count (§7.6) and the Visual Inventory capture flows, in a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, until, USERS } from './harness.mjs';
import { IDS, inventoryWorld, itemMasterBackend, recognitionBackend, detection, items, fakeCameraScript } from './inventory-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const PHONE = { width: 390, height: 844 };

async function launch({ user = USERS.admin, viewport, itemMaster = itemMasterBackend(), recognition, hash = '' } = {}) {
  const world = inventoryWorld({ itemMaster: itemMaster.handler, ...(recognition ? { recognition } : {}) });
  const phone = viewport && viewport.width < 768;
  const app = await launchAtlas({ user, fixtures: world.fixtures, viewport, hash, initScript: fakeCameraScript, contextOptions: phone ? { hasTouch: true, isMobile: true } : {} });
  return { ...app, world, itemMaster };
}

async function go(page, route) {
  await navigateTo(page, route);
}

const rowNames = (page) => page.$$eval('#inventory-view tbody tr[data-inv-row] .cell-primary', (cells) => cells.map((cell) => cell.textContent));
const directItemWrites = (record) => record.requests.filter((entry) => entry.path.endsWith('/rest/v1/inventory_items') && entry.method !== 'GET');

test('Inventory lists active items with verified stock and honest unknowns', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await go(page, '#inventory');
    const names = await rowNames(page);
    assert.equal(names.length, items.filter((item) => item.active).length, 'inactive items are hidden by default');
    assert.ok(!names.includes('Old Tom Gin'));
    // Demerara has no verified count: no placeholder number, it says so.
    const sugar = await page.$eval(`tr[data-inv-row="${IDS.sugar}"]`, (row) => row.textContent);
    assert.match(sugar, /Not counted/);
    assert.doesNotMatch(sugar, /\b0 kg\b/);
    const limes = await page.$eval(`tr[data-inv-row="${IDS.limes}"]`, (row) => row.textContent);
    assert.match(limes, /Out/);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('Below par is a shareable filter chip that clears back to every item', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await page.evaluate(() => window.AtlasInventory.showBelowPar());
    await page.waitForFunction(() => /#inventory\?filter=below-par/.test(location.hash));
    await settle(page);
    assert.match(await page.evaluate(() => location.hash), /#inventory\?filter=below-par/);
    const names = await rowNames(page);
    // S89 canonical status: Limes (verified 0) is out, not below par; the
    // "Out or almost out" chip lists it.
    assert.ok(names.includes('Campari') && !names.includes('Limes'));
    assert.ok(!names.includes('Giffard Vanille Syrup'), 'items at or above par are not listed');
    assert.ok(!names.includes('Demerara Sugar Cube'), 'unknown stock is never reported as below par');
    await page.click('[data-inv-clear="status"]');
    await page.waitForFunction(() => location.hash === '#inventory');
    await settle(page);
    assert.equal((await rowNames(page)).length, items.filter((item) => item.active).length);
    assert.equal(await page.evaluate(() => location.hash), '#inventory');
  } finally { await close(); }
});

test('the category filter follows the owner model; wine offers exactly four types', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await go(page, '#inventory');
    const types = await page.evaluate(() => ['Red wine', 'Rosé', 'Prosecco', 'Wine'].map((category) => window.AtlasInventory.inventorySubcategory({ category, name: 'House' })));
    assert.deepEqual(types, ['Red', 'Rosé', 'Sparkling', 'White']);
    assert.equal(await page.evaluate(() => window.AtlasInventory.inventoryGroup({ category: 'Mixer', name: 'Ginger Beer' })), 'mixers');
    await page.click('[data-inv-menu-trigger="category"]');
    await page.click('[data-inv-menu="category"] [data-value="spirits"]');
    await settle(page);
    const names = await rowNames(page);
    assert.ok(names.includes('Tanqueray London Dry') && !names.includes('Limes'));
  } finally { await close(); }
});

test('Deactivate checks dependencies and goes through set_item_active, never a table write', { skip }, async () => {
  const { page, record, itemMaster, close } = await launch();
  try {
    await go(page, '#inventory');
    await page.click(`[data-inv-row-menu="${IDS.campari}"]`);
    await page.click('[data-row-action="deactivate"]');
    await page.waitForSelector('[data-activation-confirm]:not([disabled])');
    await page.fill('#inv-activation-reason', 'No longer stocked');
    await page.click('[data-activation-confirm]');
    await page.waitForFunction(() => !document.querySelector('[data-activation-confirm]'));
    const deps = itemMaster.calls.find((call) => call.action === 'item_dependencies');
    assert.equal(deps.method, 'GET');
    assert.match(deps.search, new RegExp(`item_id=${IDS.campari}`));
    const write = itemMaster.calls.find((call) => call.action === 'set_item_active');
    assert.equal(write.body.item_id, IDS.campari);
    assert.equal(write.body.active, false);
    assert.equal(write.body.reason, 'No longer stocked');
    assert.ok(write.body.expected_updated_at, 'the stale-write guard is sent');
    assert.deepEqual(directItemWrites(record), []);
  } finally { await close(); }
});

test('a blocked deactivation explains why and cannot be confirmed', { skip }, async () => {
  const { page, itemMaster, close } = await launch({ itemMaster: itemMasterBackend({ blockers: ['open_purchase_order'] }) });
  try {
    await go(page, '#inventory');
    await page.click(`[data-inv-row-menu="${IDS.tonic}"]`);
    await page.click('[data-row-action="deactivate"]');
    await page.waitForSelector('.atlas-dialog .atlas-alert--danger');
    assert.match(await page.textContent('.atlas-dialog .atlas-alert--danger'), /can’t be deactivated yet/);
    assert.equal(await page.$eval('[data-activation-confirm]', (button) => button.disabled), true);
    assert.equal(itemMaster.calls.filter((call) => call.action === 'set_item_active').length, 0);
  } finally { await close(); }
});

test('Add item uses create-item; a possible duplicate needs "Create anyway" with a reason', { skip }, async () => {
  const itemMaster = itemMasterBackend({ duplicate: 'suspected' });
  const { page, record, close } = await launch({ itemMaster });
  try {
    await go(page, '#inventory');
    await page.click('[data-inv-add]');
    await page.waitForSelector('[data-inv-item-form]');
    await page.fill('#inv-f-name', 'Demerara Raw Sugar');
    await page.click('[data-inv-submit]');
    await page.waitForSelector('[data-inv-duplicates] [data-use-existing]');
    assert.match(await page.textContent('[data-inv-duplicates]'), /Demerara Sugar Cube/);
    assert.equal(await page.textContent('[data-inv-submit]'), 'Create anyway');
    assert.equal(await page.$eval('[data-inv-submit]', (button) => button.disabled), true, 'a reason is required first');
    await page.fill(`[data-ack-reason="${IDS.sugar}"]`, 'Raw sugar, not cubes');
    assert.equal(await page.$eval('[data-inv-submit]', (button) => button.disabled), false);
    await page.click('[data-inv-submit]');
    await page.waitForFunction(() => !document.querySelector('[data-inv-item-form]'));
    const creates = itemMaster.calls.filter((call) => call.action === 'create-item');
    assert.equal(creates.length, 2);
    assert.equal(creates[0].body.values.name, 'Demerara Raw Sugar');
    assert.equal(creates[0].body.duplicate_ack, undefined);
    assert.deepEqual(creates[1].body.duplicate_ack, { acknowledged: [{ item_id: IDS.sugar, reason: 'Raw sugar, not cubes' }] });
    assert.equal(creates[0].body.request_id, creates[1].body.request_id, 'the retry keeps its idempotency key');
    assert.deepEqual(directItemWrites(record), [], 'no browser insert into inventory_items');
  } finally { await close(); }
});

test('a code conflict cannot be overridden; "Use existing item" opens that item', { skip }, async () => {
  const { page, close } = await launch({ itemMaster: itemMasterBackend({ duplicate: 'code' }) });
  try {
    await page.evaluate(() => window.AtlasInventory.openAddItem());
    await page.waitForSelector('[data-inv-item-form]');
    await page.fill('#inv-f-name', 'Demerara Raw Sugar');
    await page.click('[data-inv-submit]');
    await page.waitForSelector('[data-inv-duplicates] [data-use-existing]');
    assert.equal(await page.$eval('[data-inv-submit]', (button) => button.disabled), true);
    assert.equal(await page.textContent('[data-inv-submit]'), 'Can’t create');
    await page.click('[data-inv-duplicates] [data-use-existing]');
    await page.waitForFunction((id) => location.hash === `#inventory/item/${id}`, IDS.sugar);
  } finally { await close(); }
});

test('staff see stock without costs, suppliers or manager controls', { skip }, async () => {
  const { page, close } = await launch({ user: USERS.bartender });
  try {
    await go(page, '#inventory');
    assert.equal(await page.$('[data-inv-select]'), null, 'no bulk selection');
    assert.equal(await page.$('[data-inv-add]'), null, 'no Add item');
    const headers = await page.$$eval('#inventory-view thead th', (cells) => cells.map((cell) => cell.textContent.trim()));
    assert.ok(!headers.includes('Supplier') && !headers.includes('Unit cost'));
    await go(page, '#inventory/waste');
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'inventory', 'waste is manager-only');
  } finally { await close(); }
});

test('item detail opens with Enter and closes with Escape, returning focus', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await go(page, '#inventory');
    await page.focus(`a[data-inv-open="${IDS.aperol}"]`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.inv-detail');
    assert.equal(await page.evaluate(() => location.hash), `#inventory/item/${IDS.aperol}`);
    assert.match(await page.textContent('.inv-detail'), /Aperol Spritz/, 'recipes using the item are listed');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.inv-detail'));
    await settle(page);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.invOpen), IDS.aperol);
  } finally { await close(); }
});

test('phone: list rows, no sideways scroll and 44 px targets', { skip }, async () => {
  const { page, close } = await launch({ viewport: PHONE });
  try {
    await go(page, '#inventory');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
    const heights = await page.$$eval('#inventory-view .atlas-table-list__row', (rows) => rows.map((row) => row.getBoundingClientRect().height));
    assert.ok(heights.length > 0 && heights.every((height) => height >= 44), `row heights ${heights}`);
    const search = await page.$eval('[data-inv-search]', (input) => input.getBoundingClientRect().height);
    assert.ok(search >= 44, `search is ${search}px`);
  } finally { await close(); }
});

test('count flow: phone-first card saves through save-line and hides the tab bar', { skip }, async () => {
  const { page, world, close } = await launch({ viewport: PHONE });
  try {
    await go(page, `#inventory/counts/${IDS.session}`);
    await page.waitForSelector('[data-count-qty]');
    assert.equal(await page.evaluate(() => document.body.classList.contains('stock-count-active')), true);
    assert.equal(await page.evaluate(() => { const bar = document.getElementById('atlas-tabbar'); return !bar || bar.hidden || getComputedStyle(bar).display === 'none'; }), true);
    await page.fill('[data-count-qty]', '1.5');
    await page.click('[data-count-save]');
    await until(() => world.counts.calls.some((call) => call.action === 'save-line'), { message: 'save-line' });
    await settle(page);
    const save = world.counts.calls.find((call) => call.action === 'save-line');
    assert.equal(save.body.line_id, 'a1111111-0000-4000-8000-000000000003', 'the first pending line (Aperol)');
    assert.equal(save.body.observed_input_quantity, 1.5);
    assert.equal(save.body.count_method, 'manual');
    assert.equal(save.body.line_status, 'counted');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
    // Leaving the count shows the tab bar again.
    await go(page, '#inventory');
    assert.equal(await page.evaluate(() => document.body.classList.contains('stock-count-active')), false);
  } finally { await close(); }
});

test('count scan: a Sure match is pre-selected, saved with recognition evidence, and rapid scan continues', { skip }, async () => {
  const recognition = recognitionBackend({ result: () => ({ detections: [detection({ band: 'high', itemId: IDS.aperol })] }) });
  const { page, world, close } = await launch({ viewport: PHONE, recognition });
  try {
    await go(page, `#inventory/counts/${IDS.session}`);
    await page.click('[data-count-scan]');
    await page.waitForSelector('.atlas-capture');
    await page.evaluate(() => window.__fakeBarcodes.push('8000070099999'));
    await page.waitForSelector('[data-capture-result="count"]');
    const identify = recognition.calls.find((call) => call.action === 'identify');
    assert.equal(identify.body.client_barcodes[0].raw, '8000070099999', 'codes alone use the JSON fast path');
    // "How sure Atlas is" is a 44 px touch target through the shared
    // disclosure-summary hit area (coarse pointer), not a page-local size:
    // every point of the 44 px band around it opens the disclosure.
    const disclosure = await page.$eval('[data-capture-result="count"] .atlas-capture-more > summary', (summary) => {
      const box = summary.getBoundingClientRect();
      const hit = getComputedStyle(summary, '::after');
      const cx = box.left + Math.min(box.width / 2, 40);
      const cy = box.top + box.height / 2;
      const probes = [-21, -15, 0, 15, 21].map((dy) => { const node = document.elementFromPoint(cx, cy + dy); return Boolean(node && (node === summary || summary.contains(node))); });
      return { text: summary.textContent.trim(), height: Math.round(box.height), hitHeight: parseFloat(hit.height), probes };
    });
    assert.equal(disclosure.text, 'How sure Atlas is');
    assert.ok(disclosure.hitHeight >= 44, `hit area ${disclosure.hitHeight}px (visual ${disclosure.height}px)`);
    assert.deepEqual(disclosure.probes, [true, true, true, true, true], 'the whole 44 px band reaches the summary');
    await page.tap('[data-capture-result="count"] .atlas-capture-more > summary');
    assert.equal(await page.$eval('[data-capture-result="count"] .atlas-capture-more', (node) => node.open), true);
    await page.fill('[data-capture-result="count"] [data-count-qty]', '1.7');
    await page.click('[data-save-next]');
    await page.waitForFunction(() => !document.querySelector('[data-capture-result="count"]'));
    const outcome = recognition.calls.find((call) => call.action === 'outcome');
    assert.equal(outcome.body.chosen_item_id, IDS.aperol);
    const save = world.counts.calls.find((call) => call.action === 'save-line');
    assert.equal(save.body.observed_input_quantity, 1.7);
    assert.equal(save.body.count_method, 'barcode');
    assert.ok(save.body.evidence?.recognition?.outcome_id, 'the confirmed outcome is the evidence');
    assert.ok(await page.$('.atlas-capture'), 'the camera stays open for the next item');
  } finally { await close(); }
});

test('count scan: a Check match is never pre-selected; the counter chooses', { skip }, async () => {
  const candidates = [
    { rank: 1, item_id: IDS.giffard, item: items[6], score: 0.78, percent: 78, evidence: [{ signal: 'brand', polarity: 'for', text: 'brand detected' }], flags: { in_session: true } },
    { rank: 2, item_id: IDS.aperol, item: items[3], score: 0.61, percent: 61, evidence: [], flags: {} }
  ];
  const recognition = recognitionBackend({ result: () => ({ detections: [detection({ band: 'medium', candidates })] }) });
  const { page, world, close } = await launch({ viewport: PHONE, recognition });
  try {
    await go(page, `#inventory/counts/${IDS.session}`);
    await page.click('[data-count-scan]');
    await page.waitForSelector('.atlas-capture');
    await page.evaluate(() => window.__fakeBarcodes.push('1234567890128'));
    await page.waitForSelector('[data-capture-choose]');
    assert.equal(await page.$('[data-capture-result="count"]'), null, 'no count sheet before a choice');
    assert.equal(world.counts.calls.filter((call) => call.action === 'save-line').length, 0);
    await page.click('[data-capture-choose]');
    await page.waitForSelector('[data-capture-result="count"]');
  } finally { await close(); }
});

test('identify an unknown item leads to a new-product draft with possible matches first', { skip }, async () => {
  const recognition = recognitionBackend({ result: () => ({ detections: [detection({ band: 'low' })] }) });
  const { page, close } = await launch({ recognition });
  try {
    await go(page, '#inventory');
    await page.evaluate(() => window.AtlasInventory.openIdentify());
    await page.waitForSelector('.atlas-capture');
    await page.evaluate(() => window.__fakeBarcodes.push('0000000000000'));
    await page.waitForSelector('[data-capture-result="unknown"]');
    await page.click('[data-unknown="draft"]');
    await page.waitForFunction(() => /Demerara Sugar Cube/.test(document.querySelector('.atlas-capture')?.textContent || ''));
    assert.ok(recognition.calls.some((call) => call.action === 'duplicates'));
  } finally { await close(); }
});

test('add product by camera fills a draft only from confident readings', { skip }, async () => {
  const read = { brand: { value: null, confidence: 0 }, product_name: { value: 'Demerara Raw Sugar', confidence: 94 }, subcategory: { value: 'Bar Ingredients', confidence: 88 }, packaging_type: { value: 'bag', confidence: 92 }, unit_size: { quantity: 1, unit: 'kg', text: '1 kg', confidence: 95 } };
  const recognition = recognitionBackend({ result: () => ({ detections: [detection({ band: 'medium', itemId: IDS.sugar, read })] }) });
  const { page, itemMaster, close } = await launch({ recognition });
  try {
    await page.evaluate(() => window.AtlasInventory.openAddProductByCamera());
    await page.waitForSelector('.atlas-capture');
    await settle(page);
    await page.click('[data-capture-shutter]');
    await page.waitForSelector('[data-capture-result="add_product"]');
    const identify = recognition.calls.find((call) => call.action === 'identify');
    assert.equal(typeof identify.body, 'string', 'a photo goes as multipart');
    await page.click('[data-capture-result="add_product"] [data-review]');
    await page.waitForSelector('[data-inv-item-form]');
    assert.equal(await page.inputValue('#inv-f-name'), 'Demerara Raw Sugar');
    assert.equal(itemMaster.calls.filter((call) => call.action === 'create-item').length, 0, 'nothing is created until the manager adds it');
  } finally { await close(); }
});
