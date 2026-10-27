// Audit l10n-numbers (M16, M17, L30, L31, L34): Icelandic numbers typed into
// Purchasing and Inventory, the Excel (Icelandic) CSV export, and search that
// ignores accents and þ/ð/æ, in a real browser on the shipped modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harnessAvailable, launchAtlas, navigateTo, settle, until, USERS } from './harness.mjs';
import { IDS, balances, inventoryWorld, itemMasterBackend, items } from './inventory-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function launch({ tables = {}, itemMaster = null } = {}) {
  const world = inventoryWorld({ tables, ...(itemMaster ? { itemMaster: itemMaster.handler } : {}) });
  const app = await launchAtlas({ user: USERS.admin, fixtures: world.fixtures });
  return { ...app, world };
}

const commands = (world, action) => world.purchasing.calls.filter((call) => call.p_action === action);

test('M16: an empty unit cost blocks the order; "4.500" kr is 4500 and "1,5" is 1.5', { skip }, async () => {
  const { page, world, close } = await launch();
  try {
    await navigateTo(page, '#purchasing/orders');
    await page.click('[data-po-new]');
    await page.waitForSelector('#po-order-form');
    await page.selectOption('#po-supplier', IDS.globus);
    await page.selectOption('#po-order-form [data-po-line-item]', IDS.campari);
    // The item's cost is prefilled; a manager clears it (or a phone keyboard
    // sends text a number field drops). It must not be saved as 0 kr.
    await page.fill('#po-order-form [data-po-line-cost]', '');
    await page.fill('#po-order-form [data-po-line-qty]', '1,5');
    await page.click('[data-po-save]');
    await page.waitForFunction(() => /Enter a unit cost of 0 or more on every line/.test(document.querySelector('#po-order-form [data-po-alert]')?.textContent || ''));
    assert.equal(await page.getAttribute('#po-order-form [data-po-line-cost]', 'aria-invalid'), 'true');
    await settle(page);
    assert.equal(commands(world, 'create').length, 0, 'nothing is sent');

    await page.fill('#po-order-form [data-po-line-cost]', '4.500');
    assert.match(await page.textContent('[data-po-total]'), /Total 6\.750 kr/, '1.5 × 4500');
    await page.click('[data-po-save]');
    await until(() => commands(world, 'create').length, { message: 'create' });
    assert.deepEqual(commands(world, 'create')[0].p_lines, [{ item_id: IDS.campari, quantity: 1.5, unit_cost: 4500 }]);
  } finally { await close(); }
});

test('L30: "1,250" received is asked about, never saved as 1.25; "1,5" is 1.5', { skip }, async () => {
  const { page, world, close } = await launch();
  try {
    await navigateTo(page, `#purchasing/order/${IDS.po2}`);
    await page.click('[data-po-receive]');
    await page.waitForSelector('[data-po-rqty]');
    assert.equal(await page.inputValue('[data-po-rqty]'), '48', 'the remaining quantity is prefilled without grouping');
    await page.fill('[data-po-rqty]', '1,250');
    await page.click('[data-po-receive-submit]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-po-alert]')].some((node) => /could mean 1250 or 1\.25/.test(node.textContent)));
    await settle(page);
    assert.equal(commands(world, 'receive_lines').length, 0);
    await page.fill('[data-po-rqty]', '1,5');
    await page.click('[data-po-receive-submit]');
    await until(() => commands(world, 'receive_lines').length, { message: 'receive_lines' });
    assert.deepEqual(commands(world, 'receive_lines')[0].p_receipt, [{ item_id: IDS.tonic, quantity: 1.5 }]);
  } finally { await close(); }
});

// Review: a three-decimal quantity ('1.125' kg) must stay enterable. The
// question suggests an answer that is not itself ambiguous, and a figure the
// stepper wrote is Alcedo's own decimal, never questioned.
test('L30: "1.125" is asked about once and "1.1250" (as suggested) saves 1.125; a stepper result is never questioned', { skip }, async () => {
  const { page, world, close } = await launch();
  try {
    await navigateTo(page, `#purchasing/order/${IDS.po2}`);
    await page.click('[data-po-receive]');
    await page.waitForSelector('[data-po-rqty]');
    await page.fill('[data-po-rqty]', '1.125');
    await page.click('[data-po-receive-submit]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-po-alert]')].some((node) => /could mean 1125 or 1\.125\. Type 1125 or 1\.1250\./.test(node.textContent)));
    await settle(page);
    assert.equal(commands(world, 'receive_lines').length, 0);
    await page.fill('[data-po-rqty]', '1.1250');
    await page.click('[data-po-receive-submit]');
    await until(() => commands(world, 'receive_lines').length, { message: 'receive_lines' });
    assert.deepEqual(commands(world, 'receive_lines')[0].p_receipt, [{ item_id: IDS.tonic, quantity: 1.125 }]);
  } finally { await close(); }

  const second = await launch();
  try {
    await navigateTo(second.page, `#purchasing/order/${IDS.po2}`);
    await second.page.click('[data-po-receive]');
    await second.page.waitForSelector('[data-po-rqty]');
    await second.page.fill('[data-po-rqty]', '1,125');
    await second.page.click('[data-po-rqty] ~ [data-po-step="1"]');
    assert.equal(await second.page.inputValue('[data-po-rqty]'), '2.125');
    await second.page.click('[data-po-receive-submit]');
    await until(() => commands(second.world, 'receive_lines').length, { message: 'receive_lines after the stepper' });
    assert.deepEqual(commands(second.world, 'receive_lines')[0].p_receipt, [{ item_id: IDS.tonic, quantity: 2.125 }]);
  } finally { await second.close(); }
});

// Audit L30 (stock-count part): the count card shows "Last verified 1250",
// never "1,250"; a typed "1,250" is asked about instead of saved as 1.25;
// "1,5" is 1.5. Audit L31: the count's item search ignores accents.
test('L30: a stock count shows 1250 without grouping and asks about a typed "1,250"; L31: its search ignores accents', { skip }, async () => {
  const aperol = balances.find((entry) => entry.inventory_item_id === IDS.aperol);
  const before = aperol.verified_quantity;
  aperol.verified_quantity = 1250;
  const { page, world, close } = await launch();
  try {
    await navigateTo(page, `#inventory/counts/${IDS.session}`);
    await page.waitForSelector('[data-count-qty]');
    assert.match(await page.textContent('.sc-card__name'), /Aperol/);
    assert.match(await page.textContent('.sc-card__last'), /Last verified 1250 on/);
    const saves = () => world.counts.calls.filter((call) => call.action === 'save-line');
    await page.fill('[data-count-qty]', '1,250');
    await page.click('[data-count-save]');
    await page.waitForFunction(() => /could mean 1250 or 1\.25\. Type 1250 or 1\.25\./.test(document.querySelector('[data-count-alert]')?.textContent || ''));
    assert.equal(await page.getAttribute('[data-count-qty]', 'aria-invalid'), 'true');
    await settle(page);
    assert.equal(saves().length, 0, 'nothing is saved');
    await page.fill('[data-count-qty]', '1,5');
    await page.click('[data-count-save]');
    await until(() => saves().length, { message: 'save-line' });
    assert.equal(saves()[0].body.observed_input_quantity, 1.5);

    await page.click('[data-count-show-all]');
    await page.waitForSelector('[data-count-all-search]');
    await page.click('[data-count-all-filter="all"]');
    await page.fill('[data-count-all-search]', 'apérol');
    await page.waitForFunction(() => [...document.querySelectorAll('.sc-all .atlas-row__title')].map((node) => node.textContent).join('|') === 'Aperol');
  } finally { aperol.verified_quantity = before; await close(); }
});

test('M16: Add item reads "4.500" kr as 4500 and asks about a par of "1.250"', { skip }, async () => {
  const itemMaster = itemMasterBackend();
  const { page, close } = await launch({ itemMaster });
  try {
    await navigateTo(page, '#inventory');
    await page.click('[data-inv-add]');
    await page.waitForSelector('[data-inv-item-form]');
    await page.fill('#inv-f-name', 'Brennivín');
    await page.fill('#inv-f-cost_price', '4.500');
    await page.fill('#inv-f-par_level', '1.250');
    await page.click('[data-inv-submit]');
    await page.waitForSelector('#inv-f-par_level[aria-invalid="true"]');
    assert.match(await page.textContent('[data-inv-item-form]'), /could mean 1250 or 1\.25/);
    assert.equal(itemMaster.calls.filter((call) => call.action === 'create-item').length, 0);
    await page.fill('#inv-f-par_level', '6');
    await page.click('[data-inv-submit]');
    await until(() => itemMaster.calls.filter((call) => call.action === 'create-item').length, { message: 'create-item' });
    const values = itemMaster.calls.find((call) => call.action === 'create-item').body.values;
    assert.equal(values.cost_price, 4500);
    assert.equal(values.par_level, 6);
  } finally { await close(); }
});

test('M17: the Excel (Icelandic) inventory export has a BOM, ";", decimal commas, CRLF and ISO count dates', { skip }, async () => {
  const priced = items.map((item) => (item.id === IDS.campari ? { ...item, cost_price: 4500.5 } : item));
  const { page, close } = await launch({ tables: { inventory_items: priced } });
  try {
    await navigateTo(page, '#inventory');
    await page.waitForSelector('#inventory-view tbody tr[data-inv-row]');
    await page.click('[data-inv-menu-trigger="tools"]');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-inv-menu="tools"] [data-value="export-icelandic"]')]);
    assert.match(download.suggestedFilename(), /^atlas-inventory-\d{4}-\d{2}-\d{2} \(Excel\)\.csv$/);
    const csv = await readFile(await download.path(), 'utf8');
    assert.equal(csv.charCodeAt(0), 0xfeff, 'UTF-8 BOM, so Excel shows Ölgerðin, not Ã–lgerÃ°in');
    assert.ok(csv.endsWith('\r\n') && !/[^\r]\n/.test(csv), 'CRLF line endings');
    const rows = csv.slice(1).trimEnd().split('\r\n').map((line) => line.split(';'));
    assert.deepEqual(rows[0], ['"Item"', '"Category"', '"Supplier"', '"On hand"', '"Unit"', '"Par"', '"Status"', '"Unit cost"', '"Counted"']);
    const campari = rows.find((row) => row[0] === '"Campari"');
    assert.equal(campari[7], '4500,5', 'a number cell with a decimal comma');
    assert.equal(campari[5], '4', 'par is a number, not text');
    assert.ok(rows.some((row) => row[2] === '"Ölgerðin"'));
    const counted = rows.slice(1).map((row) => row[8].replace(/"/g, ''));
    assert.ok(counted.some((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)), `a counted item has an ISO date: ${counted}`);
    for (const value of counted) assert.ok(value === 'Not counted' || /^\d{4}-\d{2}-\d{2}$/.test(value), value);
  } finally { await close(); }
});

test('L31: search ignores accents and þ/ð/æ in Inventory, Purchasing and the palette provider', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await navigateTo(page, '#inventory');
    await page.fill('[data-inv-search]', 'olgerdin');
    await page.waitForFunction(() => document.querySelectorAll('#inventory-view tbody tr[data-inv-row]').length === 1);
    assert.match(await page.textContent('#inventory-view tbody tr[data-inv-row]'), /Fever-Tree Tonic/);
    const suppliers = await page.evaluate(() => window.AtlasSearch.records('olgerdin').filter((row) => row.type === 'supplier').map((row) => row.title));
    assert.deepEqual(suppliers, ['Ölgerðin']);
    assert.equal(await page.evaluate(() => window.AtlasFormat.fold('Þristur')), 'thristur');
  } finally { await close(); }
});
