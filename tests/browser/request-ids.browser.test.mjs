// Audit L15 (Inventory and Data parts): one request id per dialog. A retry after a lost
// answer (504) sends the same request_id, so the server replays the change
// instead of applying it twice; a changed request gets a new id, because the
// server replays by id alone. Frozen clock, no fixed sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, until, USERS } from './harness.mjs';
import { IDS, inventoryWorld, itemMasterBackend } from './inventory-fixtures.mjs';
import { teamCBackend, NOW } from './teamc-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function launch({ lose = 1 } = {}) {
  const backend = itemMasterBackend();
  let remaining = lose;
  const handler = (entry) => {
    const result = backend.handler(entry);
    const action = entry.action || entry.body?.action;
    if (action === 'catalog-request' && remaining > 0) { remaining -= 1; return { __status: 504, body: { error_code: 'unavailable' } }; }
    return result;
  };
  const world = inventoryWorld({ itemMaster: handler });
  const app = await launchAtlas({ user: USERS.admin, fixtures: world.fixtures });
  const requests = () => backend.calls.filter((call) => call.action === 'catalog-request').map((call) => call.body);
  return { ...app, requests };
}

test('L15: Edit details keeps its request id across a retry and changes it when the change changes', { skip }, async () => {
  const { page, requests, close } = await launch();
  try {
    await navigateTo(page, `#inventory/item/${IDS.campari}`);
    await page.click('[data-inv-edit]');
    await page.waitForSelector('#inv-edit-form');
    await page.fill('#inv-e-brand', 'Campari Milano');
    await page.click('[data-inv-submit]');
    await page.waitForFunction(() => /weren’t saved/.test(document.querySelector('#inv-edit-form [data-inv-form-alert]')?.textContent || ''));
    await page.click('[data-inv-submit]');
    await until(() => requests().length === 2, { message: 'the retry' });
    const [first, retry] = requests();
    assert.equal(first.kind, 'metadata_correction');
    assert.ok(first.request_id);
    assert.equal(retry.request_id, first.request_id, 'the retry replays the same change');
    await page.waitForSelector('#inv-edit-form', { state: 'detached' });

    // A new dialog is a new request.
    await page.click('[data-inv-edit]');
    await page.waitForSelector('#inv-edit-form');
    await page.fill('#inv-e-brand', 'Campari Milano');
    await page.click('[data-inv-submit]');
    await until(() => requests().length === 3, { message: 'a new dialog' });
    assert.notEqual(requests()[2].request_id, first.request_id);
  } finally { await close(); }
});

test('L15: a retry after editing the change sends a new request id', { skip }, async () => {
  const { page, requests, close } = await launch();
  try {
    await navigateTo(page, `#inventory/item/${IDS.campari}`);
    await page.click('[data-inv-edit]');
    await page.waitForSelector('#inv-edit-form');
    await page.fill('#inv-e-brand', 'Campari Milano');
    await page.click('[data-inv-submit]');
    await page.waitForFunction(() => /weren’t saved/.test(document.querySelector('#inv-edit-form [data-inv-form-alert]')?.textContent || ''));
    await page.fill('#inv-e-brand', 'Campari Bitter');
    await page.click('[data-inv-submit]');
    await until(() => requests().length === 2, { message: 'the second attempt' });
    const [first, second] = requests();
    assert.notEqual(second.request_id, first.request_id);
    assert.equal(second.payload.values.brand, 'Campari Bitter');
  } finally { await close(); }
});

test('L15: a duplicate decision retried after a lost answer keeps its request id', { skip }, async () => {
  const requests = [];
  let lose = 1;
  const backend = teamCBackend({ user: USERS.admin, overrides: { functions: {
    'atlas-item-master': (entry) => {
      if (entry.body?.action !== 'catalog-request') return {};
      requests.push(entry.body);
      if (lose > 0) { lose -= 1; return { __status: 504, body: { error_code: 'unavailable' } }; }
      return { request: { id: 'req-1', kind: entry.body.kind, status: 'applied', version: 2 }, stock_changed: false };
    }
  } } });
  const { page, close } = await launchAtlas({ user: USERS.admin, fixtures: backend.fixtures, hash: '#data/issues?issue=inventory.possible_duplicate', fixedTime: Date.parse(NOW) });
  try {
    await page.waitForSelector('[data-data-resolve-duplicate]');
    await page.click('[data-data-resolve-duplicate]');
    await page.waitForSelector('[data-data-dup-save]');
    await page.click('[data-data-dup-save]');
    await page.waitForSelector('[data-data-dup-error]:not([hidden])');
    await page.click('[data-data-dup-save]');
    await until(() => requests.length === 2, { message: 'the retry' });
    assert.equal(requests[0].kind, 'duplicate_resolution');
    assert.ok(requests[0].request_id);
    assert.equal(requests[1].request_id, requests[0].request_id, 'the retry replays the same decision');
  } finally { await close(); }
});
