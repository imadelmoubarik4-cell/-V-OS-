// Team (#team, #team/<profileId>, spec §7.10) in the real shell: directory,
// profile sheet (a page on phones), role-shaped details and error states.
// Messages identity (S87) is covered in messages.browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, requestsTo, settle, until, USERS } from './harness.mjs';
import { teamFunctions, peopleFunctions, NOW } from './people-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function open({ user = USERS.admin, hash = '#team', viewport, status = 200, contextOptions = {}, mfa = null, photoOrphans = 0 } = {}) {
  const fixtures = { functions: peopleFunctions(teamFunctions({ user, status, photoOrphans })) };
  if (mfa) fixtures.mfa = mfa;
  const app = await launchAtlas({ user, hash, viewport, contextOptions, fixedTime: new Date(NOW), fixtures });
  await app.page.waitForSelector('.team-table, .team-list, .atlas-alert--danger, .team-detail', { timeout: 12000 });
  await settle(app.page);
  return app;
}

// A verified authenticator so the admin can clear the fail-closed step-up before
// a permanent deletion; fixtures.mfa.verify defaults to success.
const VERIFIED_TOTP = { factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified', friendly_name: 'Authenticator' }] };

test('admin directory: table with role, today’s shift, training and contact state', { skip }, async () => {
  const { page, record, close } = await open();
  try {
    assert.equal(await page.textContent('#team-profiles-view .page-head__title'), 'Team');
    assert.match(await page.textContent('#team-profiles-view .page-head__sub'), /^4 people · 1 with training due$/);
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

const GUNNAR = 'c0ffee00-0000-4000-8000-000000000003';

test('an administrator sees Remove + Delete on another member but not on their own row', { skip }, async () => {
  const { page, close } = await open({ hash: `#team/${GUNNAR}` });
  try {
    await page.waitForSelector('#team-profile-sheet .team-detail__name');
    assert.equal(await page.$(`#team-profile-sheet [data-team-member-remove="${GUNNAR}"]`) !== null, true);
    assert.equal(await page.$(`#team-profile-sheet [data-team-member-delete="${GUNNAR}"]`) !== null, true);
    assert.match(await page.textContent('#team-profile-sheet .team-danger'), /Remove from team[\s\S]*Delete permanently/);
    // Own row: neither control (you can't remove or delete yourself).
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => location.hash === '#team');
    await page.click(`[data-team-profile-open="${USERS.admin.id}"]`);
    await page.waitForSelector('#team-profile-sheet .team-detail__name');
    assert.equal(await page.$('#team-profile-sheet [data-team-member-remove]'), null, 'no self-remove');
    assert.equal(await page.$('#team-profile-sheet [data-team-member-delete]'), null, 'no self-delete');
  } finally { await close(); }
});

test('Remove from team archives the member (reversible) and keeps their records', { skip }, async () => {
  const { page, record, close } = await open({ hash: `#team/${GUNNAR}` });
  try {
    await page.waitForSelector(`#team-profile-sheet [data-team-member-remove="${GUNNAR}"]`);
    await page.click(`#team-profile-sheet [data-team-member-remove="${GUNNAR}"]`);
    await page.waitForSelector('#team-confirm');
    assert.match(await page.textContent('#team-confirm'), /Remove Gunnar Karlsson from the team\?[\s\S]*add them back/);
    await page.click('#team-confirm [type="submit"]');
    await until(() => requestsTo(record, 'atlas-team-profiles', 'remove-from-team').length >= 1, { message: 'the remove request' });
    const req = requestsTo(record, 'atlas-team-profiles', 'remove-from-team')[0];
    assert.equal(req.body.profile_id, GUNNAR);
    await settle(page);
    // The sheet closes; the member drops out of the default (active) view but is
    // kept — under the Inactive filter they are still there, marked Inactive.
    await page.waitForFunction(() => location.hash === '#team');
    assert.equal(await page.$(`.team-table tbody tr[data-team-profile-select="${GUNNAR}"]`), null, 'gone from the active list');
    await page.click('[data-team-profiles-filter="inactive"]');
    await page.waitForSelector(`tr[data-team-profile-select="${GUNNAR}"]`);
    assert.match(await page.textContent(`tr[data-team-profile-select="${GUNNAR}"]`), /Inactive/);
    assert.equal(requestsTo(record, 'atlas-team-profiles', 'delete-member').length, 0, 'remove never deletes');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('Delete permanently needs the exact typed name + a fresh authenticator code, then erases the member', { skip }, async () => {
  const { page, record, close } = await open({ hash: `#team/${GUNNAR}`, mfa: VERIFIED_TOTP });
  try {
    await page.waitForSelector(`#team-profile-sheet [data-team-member-delete="${GUNNAR}"]`);
    await page.click(`#team-profile-sheet [data-team-member-delete="${GUNNAR}"]`);
    await page.waitForSelector('#team-delete-member');
    // A preview was fetched and the modal tells the truth: shifts are kept.
    await until(() => requestsTo(record, 'atlas-team-profiles', 'delete-preview').length >= 1, { message: 'the preview' });
    const text = await page.textContent('#team-delete-member');
    assert.match(text, /Deleted for good[\s\S]*Alcedo sign-in/);
    assert.match(text, /Kept \(required records\)[\s\S]*2 shifts they already worked/);
    // Wrong name: the delete is refused and nothing is sent (no step-up either).
    await page.fill('#team-delete-confirm', 'Gunnar');
    await page.click('#team-delete-member [type="submit"]');
    await settle(page);
    assert.match(await page.textContent('#team-delete-member [data-atlas-dialog-error]'), /name doesn’t match/);
    assert.equal(requestsTo(record, 'atlas-team-profiles', 'delete-member').length, 0, 'no delete on a bad name');
    // Exact name → a fresh authenticator code is required before the delete runs.
    await page.fill('#team-delete-confirm', 'Gunnar Karlsson');
    await page.click('#team-delete-member [type="submit"]');
    await page.waitForSelector('#team-delete-stepup-input');
    assert.equal(requestsTo(record, 'atlas-team-profiles', 'delete-member').length, 0, 'no delete before the code');
    await page.fill('#team-delete-stepup-input', '123456');
    await page.click('#team-delete-stepup [type="submit"]');
    await until(() => requestsTo(record, 'atlas-team-profiles', 'delete-member').length >= 1, { message: 'the delete request' });
    const del = requestsTo(record, 'atlas-team-profiles', 'delete-member')[0];
    assert.equal(del.body.profile_id, GUNNAR);
    assert.equal(del.body.confirm_name, 'Gunnar Karlsson');
    await settle(page);
    await page.waitForFunction(() => location.hash === '#team');
    assert.equal(await page.$(`tr[data-team-profile-select="${GUNNAR}"]`), null, 'the member no longer appears');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('an administrator can finish leftover photo cleanup from the Team banner', { skip }, async () => {
  const { page, record, close } = await open({ photoOrphans: 2 });
  try {
    await page.waitForSelector('[data-team-cleanup-photos]');
    assert.match(await page.textContent('.team-danger, .atlas-alert--warning'), /2 leftover profile photos to remove/);
    await page.click('[data-team-cleanup-photos]');
    await until(() => requestsTo(record, 'atlas-team-profiles', 'cleanup-photo-orphans').length >= 1, { message: 'the cleanup request' });
    await settle(page);
    // The banner clears once the orphans are gone.
    assert.equal(await page.$('[data-team-cleanup-photos]'), null, 'banner gone after cleanup');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('a bartender never sees the photo-cleanup banner', { skip }, async () => {
  const { page, close } = await open({ user: USERS.bartender, photoOrphans: 3 });
  try {
    await page.waitForSelector('.team-table, .team-list');
    assert.equal(await page.$('[data-team-cleanup-photos]'), null, 'no cleanup banner for non-admins');
  } finally { await close(); }
});

test('Delete permanently fails closed when the admin has no verified authenticator', { skip }, async () => {
  const { page, record, close } = await open({ hash: `#team/${GUNNAR}` }); // no mfa factor seeded
  try {
    await page.waitForSelector(`#team-profile-sheet [data-team-member-delete="${GUNNAR}"]`);
    await page.click(`#team-profile-sheet [data-team-member-delete="${GUNNAR}"]`);
    await page.waitForSelector('#team-delete-member');
    await page.fill('#team-delete-confirm', 'Gunnar Karlsson');
    await page.click('#team-delete-member [type="submit"]');
    await settle(page);
    assert.match(await page.textContent('#team-delete-member [data-atlas-dialog-error]'), /authenticator app/);
    assert.equal(requestsTo(record, 'atlas-team-profiles', 'delete-member').length, 0, 'no deletion without a verified factor');
  } finally { await close(); }
});
