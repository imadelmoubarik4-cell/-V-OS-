// Knowledge (#knowledge, spec §7.11, §8.6) in the real shell: library, server
// search with a truthful fallback, the reading page, required reading, staff
// boundaries, manager authoring and phones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, requestsTo, settle, until, USERS } from './harness.mjs';
import { knowledgeBackend, peopleFunctions, NOW } from './people-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function open({ user = USERS.admin, hash = '#knowledge', viewport, backend = knowledgeBackend({ user }), contextOptions = {} } = {}) {
  const app = await launchAtlas({ user, hash, viewport, contextOptions, fixedTime: new Date(NOW), fixtures: { functions: peopleFunctions({ 'atlas-knowledge': backend.handler }) } });
  await app.page.waitForSelector('.kn-list, .kn-article, .atlas-empty, .atlas-alert--danger', { timeout: 12000 });
  await settle(app.page);
  return { ...app, backend };
}

test('staff library: required reading first, categories, no drafts', { skip }, async () => {
  const { page, record, close } = await open({ user: USERS.bartender });
  try {
    assert.equal(await page.textContent('#knowledge-view .page-head__sub'), '3 articles · 1 required for you');
    const tabs = await page.$$eval('.kn-tabs a', (nodes) => nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(tabs, ['Library', 'Required reading 1', 'Training']);
    assert.match(await page.textContent('#kn-due-title + .kn-list'), /Closing the bar[\s\S]*Required · not read/);
    assert.doesNotMatch(await page.textContent('#knowledge-view'), /Wine service|Draft/);
    await page.click('[data-knowledge-category="service"]');
    assert.deepEqual(await page.$$eval('.kn-list .atlas-row__title', (nodes) => nodes.map((node) => node.textContent)), ['Handling a complaint']);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('search asks the server and shows matched snippets; a failing search falls back honestly', { skip }, async () => {
  {
    const { page, record, close } = await open({ user: USERS.bartender });
    try {
      await page.fill('[data-knowledge-search]', 'cash');
      await page.waitForSelector('.kn-count');
      await until(() => requestsTo(record, 'atlas-knowledge', 'search').length, { message: 'the Knowledge search request' });
      const call = requestsTo(record, 'atlas-knowledge', 'search').at(-1);
      assert.match(call.search, /q=cash/);
      await page.fill('[data-knowledge-search]', 'complaint');
      await page.waitForFunction(() => document.querySelector('.kn-list mark')?.textContent === 'complaint');
      assert.match(await page.textContent('.kn-count'), /1 result/);
      await page.fill('[data-knowledge-search]', 'zzzz');
      await page.waitForSelector('[data-knowledge-ask-search]');
      assert.match(await page.textContent('.atlas-empty'), /No articles match “zzzz”/);
    } finally { await close(); }
  }
  {
    const { page, close } = await open({ user: USERS.bartender, backend: knowledgeBackend({ user: USERS.bartender, searchStatus: 503 }) });
    try {
      await page.fill('[data-knowledge-search]', 'allergens');
      await page.waitForSelector('.kn-note');
      assert.match(await page.textContent('.kn-results'), /Full-text search is unavailable right now[\s\S]*Allergens at the bar/);
    } finally { await close(); }
  }
});

test('reading page: 720 column, checklists, Mark as read acknowledges the version', { skip }, async () => {
  const { page, record, close } = await open({ user: USERS.bartender, hash: '#knowledge/k-closing' });
  try {
    await page.waitForSelector('.kn-article__title');
    assert.equal(await page.textContent('h1.kn-article__title'), 'Closing the bar');
    assert.match(await page.textContent('.kn-article__meta'), /Opening & closing · Procedure · Updated Tue 22 Sep · 1 min read · Version 2/);
    const width = await page.$eval('.kn-reading', (node) => node.getBoundingClientRect().width);
    assert.ok(width <= 720.5, `reading column ${width}`);
    assert.equal(await page.$$eval('.kn-checks input[type="checkbox"]', (nodes) => nodes.length), 3);
    await until(() => requestsTo(record, 'atlas-knowledge', 'mark-read').length, { message: 'mark-read' });
    await settle(page);
    assert.equal(requestsTo(record, 'atlas-knowledge', 'mark-read').length, 1, 'opening records a read');
    await page.click('[data-knowledge-acknowledge]');
    await page.waitForSelector('.kn-done');
    const ack = requestsTo(record, 'atlas-knowledge', 'acknowledge')[0].body;
    assert.deepEqual([ack.article_id, ack.version_id], ['k-closing', 'k-closing-v']);
    assert.match(await page.textContent('.kn-article__foot'), /You’ve read version 2\./);
    assert.equal(await page.$('[data-knowledge-edit]'), null, 'staff cannot edit');
    const detail = requestsTo(record, 'atlas-knowledge', 'detail')[0];
    assert.doesNotMatch(detail.search, /prefer_draft/, 'staff never ask for drafts');
  } finally { await close(); }
});

test('manager: drafts are marked, sources and history show, the editor saves a private draft', { skip }, async () => {
  const { page, record, close } = await open({ hash: '#knowledge/k-draft' });
  try {
    await page.waitForSelector('.kn-article__title');
    assert.match(await page.textContent('.kn-article'), /Private draft[\s\S]*Only managers see this/);
    assert.equal(await page.isVisible('[data-knowledge-publish]'), true);
    assert.match(requestsTo(record, 'atlas-knowledge', 'detail')[0].search, /prefer_draft=true/);
    await page.click('[data-knowledge-edit]');
    await page.waitForSelector('#kn-editor-form');
    await page.fill('#kn-title', 'Wine service basics');
    await page.click('#kn-editor [type="submit"]');
    await page.waitForSelector('#kn-editor', { state: 'detached' });
    const saved = requestsTo(record, 'atlas-knowledge', 'save-draft')[0].body;
    assert.equal(saved.title, 'Wine service basics');
    assert.deepEqual(saved.target_roles, ['bartender']);
    await page.click('[data-knowledge-publish]');
    await page.waitForSelector('#kn-confirm');
    assert.match(await page.textContent('#kn-confirm'), /Existing acknowledgements remain attached to the previous version/);
  } finally { await close(); }
});

test('manager-only tabs: Sources and Activity routes; staff get a permission state', { skip }, async () => {
  {
    const { page, close } = await open({ hash: '#knowledge/sources' });
    try {
      assert.equal(await page.getAttribute('[data-knowledge-tab="sources"]', 'aria-current'), 'page');
      assert.match(await page.textContent('.kn-body'), /Google Drive[\s\S]*Not connected/);
    } finally { await close(); }
  }
  {
    const { page, close } = await open({ user: USERS.bartender, hash: '#knowledge/activity' });
    try {
      assert.match(await page.textContent('.kn-body'), /This part of Knowledge is for managers/);
    } finally { await close(); }
  }
});

test('the API returning 503 shows a plain error and Try again works', { skip }, async () => {
  const backend = knowledgeBackend({ status: 503 });
  const { page, close } = await open({ backend });
  try {
    const alert = await page.textContent('.atlas-alert--danger');
    assert.match(alert, /Knowledge couldn’t be loaded\./);
    assert.doesNotMatch(alert, /503|Knowledge service/);
    backend.status = 200;
    await page.click('[data-knowledge-refresh]');
    await page.waitForSelector('.kn-list');
  } finally { await close(); }
});

test('phone: the article has a sticky Mark as read bar; no sideways scroll; back returns to the library', { skip }, async () => {
  const { page, close } = await open({ user: USERS.bartender, hash: '#knowledge/k-closing', viewport: { width: 390, height: 844 }, contextOptions: { hasTouch: true, isMobile: true } });
  try {
    await page.waitForSelector('.kn-bar [data-knowledge-acknowledge]');
    const bar = await page.$eval('.kn-bar', (node) => { const rect = node.getBoundingClientRect(); return { bottom: rect.bottom, height: window.innerHeight, button: node.querySelector('.atlas-btn').getBoundingClientRect().height }; });
    assert.ok(Math.abs(bar.bottom - bar.height) < 2, 'the bar sits at the bottom');
    assert.ok(bar.button >= 44);
    assert.equal(await page.isVisible('.atlas-tabbar'), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.click('#atlas-topbar-back');
    await page.waitForSelector('.kn-list');
    assert.equal(await page.isVisible('.atlas-tabbar'), true);
  } finally { await close(); }
});
