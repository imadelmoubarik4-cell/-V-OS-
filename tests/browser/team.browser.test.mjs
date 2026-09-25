// Team (#team, #team/<profileId>, spec §7.10) in the real shell: directory,
// profile sheet (a page on phones), role-shaped details and error states.
// Messages identity (S87) is covered in messages.browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, requestsTo, USERS } from './harness.mjs';
import { teamFunctions, peopleFunctions, NOW } from './people-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function open({ user = USERS.admin, hash = '#team', viewport, status = 200, contextOptions = {} } = {}) {
  const app = await launchAtlas({ user, hash, viewport, contextOptions, fixedTime: new Date(NOW), fixtures: { functions: peopleFunctions(teamFunctions({ user, status })) } });
  await app.page.waitForSelector('.team-table, .team-list, .atlas-alert--danger, .team-detail', { timeout: 12000 });
  await app.page.waitForTimeout(300);
  return app;
}

test('admin directory: table with role, today’s shift, training and contact state', { skip }, async () => {
  const { page, record, close } = await open();
  try {
    assert.equal(await page.textContent('.page-head__title'), 'Team');
    assert.match(await page.textContent('.page-head__sub'), /^4 people · 1 with training due$/);
    const headers = await page.$$eval('.team-table th:not(.col-actions)', (nodes) => nodes.map((node) => node.textContent.trim()).filter(Boolean));
    assert.deepEqual(headers, ['Person', 'Role', 'On shift today', 'Training', 'Emergency contact']);
    const sara = await page.$eval(`tr[data-team-profile-select="${USERS.bartender.id}"]`, (row) => row.innerText.replace(/\s+/g, ' ').trim());
    assert.match(sara, /Sara Jónsdóttir Bartender · sara\.bartender@example\.test Bartender 16:00–00:00 2 of 3 Due Missing/);
    assert.match(await page.textContent('tr[data-team-profile-select="p-jon"]'), /Schedule only/);
    // Filters: Training due.
    await page.click('[data-team-chip="training"]');
    assert.deepEqual(await page.$$eval('.team-table tbody tr', (nodes) => nodes.map((node) => node.dataset.teamProfileSelect)), [USERS.bartender.id]);
    assert.equal(requestsTo(record, 'atlas-team-profiles', 'snapshot').length, 1);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('bartender directory: no emails, no emergency column, own profile editable', { skip }, async () => {
  const { page, close } = await open({ user: USERS.bartender });
  try {
    const headers = await page.$$eval('.team-table th:not(.col-actions)', (nodes) => nodes.map((node) => node.textContent.trim()).filter(Boolean));
    assert.deepEqual(headers, ['Person', 'Role', 'On shift today']);
    assert.doesNotMatch(await page.textContent('.team-table'), /@example\.test/);
    assert.equal(await page.$('[data-team-profile-add-member]'), null);
    await page.click(`[data-team-profile-open="${USERS.admin.id}"]`);
    await page.waitForSelector('#team-profile-sheet .team-detail');
    const other = await page.textContent('#team-profile-sheet');
    assert.doesNotMatch(other, /Emergency contact|Lina El Moubarik|Manager note|Access/);
    assert.match(other, /\+354 555 0101/, 'a phone shared with the team is shown');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => location.hash === '#team');
    await page.click(`[data-team-profile-open="${USERS.bartender.id}"]`);
    await page.waitForSelector('#team-profile-sheet [data-team-profile-edit]');
    assert.match(await page.textContent('#team-profile-sheet'), /Emergency contact[\s\S]*Add someone we can call/);
    assert.match(await page.textContent('#team-profile-sheet'), /Open required reading/);
  } finally { await close(); }
});

test('#team/<id> opens the profile sheet; emergency contacts stay masked until Show', { skip }, async () => {
  const gunnar = 'c0ffee00-0000-4000-8000-000000000003';
  const { page, close } = await open({ hash: `#team/${gunnar}` });
  try {
    await page.waitForSelector('#team-profile-sheet .team-detail__name');
    assert.equal(await page.textContent('#team-profile-sheet .team-detail__name'), 'Gunnar Karlsson');
    assert.doesNotMatch(await page.textContent('#team-profile-sheet'), /Anna Karlsdóttir/);
    // Focus starts at the top of the sheet, not inside the Access form.
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('atlas-sheet__close')), true);
    await page.click('[data-team-reveal]');
    await page.waitForFunction(() => document.querySelector('#team-profile-sheet').textContent.includes('Anna Karlsdóttir'));
    assert.match(await page.textContent('#team-profile-sheet'), /Onboarding[\s\S]*3 of 3 required/);
    assert.match(await page.textContent('#team-profile-sheet'), /Access[\s\S]*Save access/);
  } finally { await close(); }
});

test('phone: rows with avatar, role and today’s shift; the profile is a page with back', { skip }, async () => {
  const { page, close } = await open({ user: USERS.bartender, viewport: { width: 390, height: 844 }, contextOptions: { hasTouch: true, isMobile: true } });
  try {
    await page.waitForSelector('.team-list__row');
    const first = await page.$eval('.team-list__row', (row) => ({ text: row.innerText.replace(/\s+/g, ' ').trim(), height: row.getBoundingClientRect().height }));
    assert.match(first.text, /Imad El Moubarik Administrator · today 17:00–23:00/);
    assert.ok(first.height >= 44);
    await page.click(`.team-list__row[data-team-profile-open="${USERS.bartender.id}"]`);
    await page.waitForSelector('.team--detail .team-detail__name');
    assert.equal(await page.$('#team-profile-sheet'), null, 'no sheet on phones');
    assert.equal(await page.isVisible('#atlas-topbar-back'), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.click('#atlas-topbar-back');
    await page.waitForSelector('.team-list__row');
  } finally { await close(); }
});

test('the API returning 503 shows a plain error and Try again works', { skip }, async () => {
  const { page, close } = await open({ status: 503 });
  try {
    const alert = await page.textContent('.atlas-alert--danger');
    assert.match(alert, /The team couldn’t be loaded\./);
    assert.doesNotMatch(alert, /503|rpc|Profiles are temporarily/);
    assert.equal(await page.$('[data-team-profiles-refresh]') !== null, true);
  } finally { await close(); }
});
