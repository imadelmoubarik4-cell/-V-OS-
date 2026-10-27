// Audit L32 and L41: Settings shows the venue Language read-only (it has no
// runtime) and saves it unchanged; Data, while file reading is off (production
// ships IMPORT_WORKER_API empty), says "Store a file" and promises no Review
// or Import step for a file that was only stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, openView, settle, SUPABASE, until, USERS } from './harness.mjs';
import { emptyFunctions, settingsBackend } from './fixtures.mjs';
import { teamCBackend, NOW } from './teamc-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

test('Settings › Venue shows Language read-only, like Currency, and saves the stored value unchanged', { skip }, async () => {
  const backend = settingsBackend();
  backend.workspace.sections.find((row) => row.section_key === 'venue').value.primary_language = 'is';
  const { page, record, close } = await launchAtlas({ fixtures: { functions: { ...emptyFunctions(), 'atlas-settings': backend.handler } } });
  try {
    await openView(page, 'settings');
    await page.evaluate(() => window.AtlasShell.navigate('#settings/venue'));
    await page.waitForSelector('[data-settings-section-form="venue"]');
    await settle(page);
    const form = '[data-settings-section-form="venue"]';
    assert.equal(await page.locator(`${form} [name="primary_language"]`).count(), 0, 'no editable Language control');
    const facts = await page.$$eval(`${form} .settings-facts > div`, (rows) => rows.map((row) => [row.querySelector('dt').textContent.trim(), row.querySelector('dd').textContent.trim()]));
    const language = facts.find(([label]) => label === 'Language');
    assert.ok(language, `Language is listed with the fixed facts: ${JSON.stringify(facts)}`);
    assert.match(language[1], /^English, fixed for now/);
    assert.match(language[1], /Íslenska/, 'a stored choice stays visible');
    assert.ok(facts.some(([label, value]) => label === 'Currency' && value === 'ISK, fixed'));

    await page.fill(`${form} [name="city"]`, 'Reykjavík');
    await page.click(`${form} button[type="submit"]`);
    await until(() => backend.calls.some((entry) => entry.action === 'save-section'), { message: 'venue save' });
    const saved = backend.calls.find((entry) => entry.action === 'save-section').body.value;
    assert.equal(saved.city, 'Reykjavík');
    assert.equal(saved.primary_language, 'is', 'the stored language goes back unchanged');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

const STORED = '7d3c1f10-0000-4000-8000-000000000299';

async function openData({ configOverrides } = {}) {
  const backend = teamCBackend({ user: USERS.admin });
  const stored = { id: STORED, file_name: 'Bar stock October.csv', file_extension: 'csv', file_size: 2048, entity_scope: 'inventory', status: 'uploaded', current_stage: 'uploaded', record_counts: {}, created_at: NOW, updated_at: NOW, storage_bucket: 'atlas-imports', storage_path: 'a/e.csv', created_by: USERS.admin.id };
  const original = backend.fixtures.tables.import_batches;
  backend.fixtures.tables.import_batches = (entry) => [stored, ...(typeof original === 'function' ? original(entry) : original)];
  const app = await launchAtlas({ user: USERS.admin, fixtures: backend.fixtures, fixedTime: Date.parse(NOW), configOverrides });
  await navigateTo(app.page, '#data');
  await app.page.waitForSelector('#data-view tbody tr');
  return app;
}

test('Data with file reading off: "Store a file", a notice, and no Review or Import for a stored file', { skip }, async () => {
  const { page, record, close } = await openData();
  try {
    const headAction = await page.textContent('#data-view .page-head [data-data-upload]');
    assert.match(headAction, /Store a file/);
    assert.doesNotMatch(headAction, /Import a file/);
    assert.match(await page.textContent('#data-view .data-body'), /File reading is off\./);
    assert.doesNotMatch(await page.textContent('#data-view .atlas-table-foot'), /until you review it/);

    await navigateTo(page, `#data/import/${STORED}`);
    await page.waitForSelector('#data-view .data-import-detail');
    const detail = await page.textContent('#data-view .data-import-detail');
    assert.equal(await page.locator('#data-view .data-import-detail .atlas-steps').count(), 0, 'no Upload · Review · Import steps');
    assert.match(detail, /File reading is off, so Alcedo won.t read or import this file/);
    const actions = await page.$$eval('#data-view [data-data-batch-action]', (nodes) => nodes.map((node) => node.dataset.dataBatchAction));
    for (const action of ['review', 'stage', 'promote', 'cancel']) assert.ok(!actions.includes(action), `no ${action} action: ${actions}`);
    assert.ok(actions.includes('delete') && actions.includes('source'), `the file can still be downloaded or deleted: ${actions}`);

    await page.click('#data-view .page-head [data-data-upload]');
    await page.waitForSelector('#data-upload-modal.is-open');
    assert.equal((await page.textContent('#data-upload-title')).trim(), 'Store a file');
    assert.match(await page.textContent('#data-upload-modal .data-upload-note'), /isn.t read or imported/);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('Data with file reading on keeps the import flow', { skip }, async () => {
  const { page, close } = await openData({ configOverrides: { IMPORT_WORKER_API: `${SUPABASE}/functions/v1/atlas-import-worker` } });
  try {
    assert.match(await page.textContent('#data-view .page-head [data-data-upload]'), /Import a file/);
    assert.doesNotMatch(await page.textContent('#data-view .data-body'), /File reading is off/);
    await navigateTo(page, `#data/import/${STORED}`);
    await page.waitForSelector('#data-view .data-import-detail .atlas-steps');
    const actions = await page.$$eval('#data-view [data-data-batch-action]', (nodes) => nodes.map((node) => node.dataset.dataBatchAction));
    assert.ok(actions.includes('stage'), `a CSV inventory file can be read: ${actions}`);
  } finally { await close(); }
});
