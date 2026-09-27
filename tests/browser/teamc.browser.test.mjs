// S88 Team C pages: Recipes (spec §7.7, §8.3), Reports (§7.12), Marketing
// (§7.13) and Data (§7.14) — main jobs, empty/error/permission states, admin
// vs bartender, phone 390 (no horizontal scroll, 44 px targets) and keyboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, requestsTo, settle, until, USERS } from './harness.mjs';
import { teamCBackend, IDS, NOW, marketingWorkspace } from './teamc-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const PHONE = { width: 390, height: 844 };

async function launch({ user = USERS.admin, hash = '', viewport, overrides, timezoneId, contextOptions } = {}) {
  const backend = teamCBackend({ user, overrides });
  const session = await launchAtlas({ user, fixtures: backend.fixtures, hash, viewport, timezoneId, contextOptions, fixedTime: Date.parse(NOW) });
  // Record Ask Atlas hand-offs without opening a conversation.
  await session.page.evaluate(() => {
    window.__asked = [];
    if (window.AtlasAI) window.AtlasAI.askAbout = (record) => { window.__asked.push(record); return true; };
  });
  return { ...session, backend };
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

// ---------- Recipes ----------

test('Recipes: library tiles show canonical availability and the limiting ingredient', { skip }, async () => {
  const { page, record, close } = await launch({ hash: '#recipes' });
  try {
    await page.waitForSelector('#recipes-view .recipe-tile');
    const tiles = await page.$$eval('#recipes-view .recipe-tile', (nodes) => nodes.map((node) => ({
      name: node.querySelector('.recipe-tile__name').textContent,
      pill: node.querySelector('.atlas-pill').textContent,
      line: node.querySelector('.recipe-tile__line')?.textContent || ''
    })));
    const negroni = tiles.find((tile) => tile.name === 'Negroni');
    assert.deepEqual(negroni, { name: 'Negroni', pill: 'Unavailable', line: 'Campari: out of stock' });
    assert.ok(!tiles.some((tile) => tile.name === 'Old special'), 'drafts are not in All');
    assert.equal(await page.textContent('#recipes-view .page-head__sub'), '4 recipes · 1 unavailable tonight');
    // Segments and search.
    await page.click('[data-recipe-status="unavailable"]');
    assert.deepEqual(await page.$$eval('#recipes-view .recipe-tile__name', (nodes) => nodes.map((node) => node.textContent)), ['Negroni']);
    await page.click('[data-recipe-status="all"]');
    await page.fill('#recipe-search', 'prosecco');
    assert.deepEqual(await page.$$eval('#recipes-view .recipe-tile__name', (nodes) => nodes.map((node) => node.textContent)), ['Aperol spritz'], 'search looks at ingredients');
    await page.fill('#recipe-search', 'zzz');
    await page.waitForSelector('#recipes-view [data-recipe-clear]');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('Recipes: detail explains blockers, shows cost only to managers, and hands off to Atlas AI', { skip }, async () => {
  const { page, close } = await launch({ hash: `#recipes/${IDS.espresso}` });
  try {
    await page.waitForSelector('#recipe-detail-modal.is-open .recipe-build');
    const text = await page.textContent('#recipe-detail-modal');
    assert.match(text, /Why availability is unknown/);
    assert.match(text, /Espresso beans: no verified stock count/);
    assert.match(text, /Cost and price/);
    assert.match(text, /Realised margin needs sales data/);
    await page.click('#recipe-detail-modal [data-recipe-ask]');
    assert.deepEqual(await page.evaluate(() => window.__asked), [{ type: 'recipe', id: IDS.espresso, label: 'Espresso martini' }]);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => location.hash === '#recipes');
  } finally { await close(); }
  const staff = await launch({ user: USERS.bartender, hash: `#recipes/${IDS.negroni}` });
  try {
    await staff.page.waitForSelector('#recipe-detail-modal.is-open .recipe-build');
    const text = await staff.page.textContent('#recipe-detail-modal');
    assert.doesNotMatch(text, /Cost and price|kr|Margin/);
    assert.equal(await staff.page.$('#recipe-detail-modal a[href$="/edit"]'), null, 'no editor for staff');
    assert.equal(await staff.page.$('#recipes-view [data-recipe-new]'), null, 'no New recipe for staff');
    await staff.page.evaluate(() => window.AtlasShell.navigate('#recipes'));
    await staff.page.click('#recipes-view [data-recipe-view="list"]');
    assert.doesNotMatch(await staff.page.textContent('#recipes-view thead'), /Cost|Price|Margin/);
  } finally { await staff.close(); }
});

test('Recipes: the editor route opens a sheet with sticky save; saving sends the canonical RPC', { skip }, async () => {
  let saved = null;
  const { page, close } = await launch({ hash: `#recipes/${IDS.gt}/edit`, overrides: { rpc: { atlas_save_recipe: (body) => { saved = body; return IDS.gt; } } } });
  try {
    await page.waitForSelector('#recipe-overlay.is-open #recipe-form');
    assert.equal(await page.inputValue('#recipe-name'), 'Gin and tonic');
    assert.equal(await page.$$eval('#ingredient-list .atlas-row', (rows) => rows.length), 2);
    // Reorder, then save.
    await page.click('#ingredient-list [data-move-ingredient="1"][data-direction="-1"]');
    assert.equal(await page.textContent('#ingredient-list .atlas-row:first-child .atlas-row__title'), 'Fever-Tree Tonic');
    const foot = await page.$eval('#recipe-overlay .atlas-sheet__foot', (node) => getComputedStyle(node).position !== 'absolute' && node.getBoundingClientRect().bottom <= window.innerHeight);
    assert.ok(foot, 'the save bar stays in view');
    await page.click('#recipe-overlay [type="submit"]');
    await page.waitForFunction(() => location.hash.endsWith('/00000000-0000-4000-8000-000000000102'));
    assert.equal(saved.p_recipe_id, IDS.gt);
    assert.deepEqual(saved.p_ingredients.map((entry) => entry.item_name), ['Fever-Tree Tonic', 'Tanqueray London Dry']);
  } finally { await close(); }
});

test('Recipes on a phone: compact tiles without photos, full-screen detail with the top bar, no horizontal scroll', { skip }, async () => {
  const { page, record, close } = await launch({ hash: '#recipes', viewport: PHONE, contextOptions: { hasTouch: true, isMobile: true } });
  try {
    await page.waitForSelector('#recipes-view .recipe-tile');
    // S90 (review P2-3): no recipe has a photo, so the library is one column
    // of compact tiles with the category glyph, no grey placeholder blocks.
    const columns = await page.$eval('#recipes-view .recipe-grid', (node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    assert.equal(columns, 1);
    assert.equal(await page.$('#recipes-view .recipe-tile__placeholder, #recipes-view .recipe-tile--plain .recipe-tile__media'), null);
    const tallest = await page.$$eval('#recipes-view .recipe-tile', (nodes) => Math.max(...nodes.map((node) => node.getBoundingClientRect().height)));
    // S91a: the category row is shown on phones again (name, category, reason).
    assert.ok(tallest <= 88, `a tile without a photo is compact (${tallest} px)`);
    assert.equal(await page.$$eval('#recipes-view .recipe-tile[data-recipe-id] .recipe-tile__category', (nodes) => nodes.every((node) => node.getBoundingClientRect().width > 0)), true, 'the category shows under the name');
    assert.ok(await noHorizontalScroll(page));
    const small = await page.$$eval('#recipes-view .atlas-segmented button, #recipes-view .recipe-tile', (nodes) => nodes.filter((node) => node.getBoundingClientRect().height < 44 && node.offsetParent).length);
    assert.equal(small, 0, 'touch targets are at least 44 px');
    await page.click(`#recipes-view .recipe-tile[data-recipe-id="${IDS.negroni}"]`);
    await page.waitForSelector('#recipes-view .recipe-screen');
    assert.equal(await page.textContent('#atlas-page-title'), 'Negroni');
    const build = await page.$eval('#recipes-view .recipe-build__row', (node) => getComputedStyle(node).fontSize);
    assert.equal(build, '17px', 'the build list reads at the bar');
    assert.ok(await noHorizontalScroll(page));
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- Reports ----------

test('Reports: Overview shows the Business Intelligence figures truthfully and asks with report context', { skip }, async () => {
  const { page, record, close } = await launch({ hash: '#reports' });
  try {
    await page.waitForSelector('#reports-view .reports-stats');
    const stats = await page.$$eval('#reports-view .reports-stats .atlas-stat', (nodes) => nodes.map((node) => [node.querySelector('.atlas-stat__label').textContent, node.querySelector('.atlas-stat__value').textContent]));
    assert.deepEqual(stats.map(([label]) => label), ['Inventory value', 'Purchasing spend', 'Waste', 'Recipe margin']);
    assert.equal(stats[0][1], '—', 'inventory value is unknown while items are not counted');
    assert.equal(stats[1][1], '412.300 kr');
    const text = await page.textContent('#reports-view');
    assert.match(text, /Not connected — no point-of-sale system/);
    assert.match(text, /Globus is 73 % of spend this period/);
    assert.match(text, /Data completeness/);
    await page.click('#reports-view [data-reports-ask]');
    const asked = await page.evaluate(() => window.__asked[0]);
    assert.equal(asked.type, 'report');
    assert.match(asked.id, /^overview:\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/);
    assert.equal(requestsTo(record, 'atlas-reports', 'ask').length, 0, 'the report ask endpoint is not called');
  } finally { await close(); }
});

test('Reports: a whole month compares with the whole previous month (compareRange)', { skip }, async () => {
  const { page, record, close } = await launch({ hash: '#reports/stock' });
  try {
    await page.waitForSelector('#reports-view [data-reports-preset]');
    await page.selectOption('#reports-view [data-reports-preset]', 'last_month');
    await page.waitForFunction(() => !document.querySelector('#reports-view .reports-page')?.classList.contains('is-refreshing'));
    const last = requestsTo(record, 'atlas-reports', 'snapshot').at(-1);
    const params = new URLSearchParams(last.search);
    assert.equal(params.get('section'), 'inventory');
    assert.deepEqual([params.get('start_date'), params.get('end_date')], ['2026-08-01', '2026-08-31']);
    assert.deepEqual([params.get('comparison'), params.get('comparison_start_date'), params.get('comparison_end_date')], ['custom', '2026-07-01', '2026-07-31']);
    const snapshots = requestsTo(record, 'atlas-reports', 'snapshot').length;
    await page.selectOption('#reports-view [data-reports-preset]', 'last_30_days');
    await until(() => requestsTo(record, 'atlas-reports', 'snapshot').length > snapshots, { message: 'the new Reports snapshot' });
    const rolling = new URLSearchParams(requestsTo(record, 'atlas-reports', 'snapshot').at(-1).search);
    assert.deepEqual([rolling.get('start_date'), rolling.get('end_date'), rolling.get('comparison_start_date'), rolling.get('comparison_end_date')],
      ['2026-08-26', '2026-09-24', '2026-07-27', '2026-08-25'], 'a 30-day period compares with the 30 days before it');
  } finally { await close(); }
});

test('Reports: a failed load says what failed and retries; staff see the permission state', { skip }, async () => {
  let fail = true;
  const { page, close } = await launch({ hash: '#reports', overrides: { functions: { 'atlas-reports': () => (fail ? { __status: 503, body: { error: 'relation "x" does not exist' } } : { workspace: { sections: [], reports: {}, generated_at: NOW } }) } } });
  try {
    await page.waitForSelector('#reports-view .atlas-alert--danger');
    const alert = await page.textContent('#reports-view .atlas-alert--danger');
    assert.match(alert, /Reports couldn.t be loaded\./);
    assert.doesNotMatch(alert, /relation|does not exist/);
    fail = false;
    await page.click('#reports-view [data-reports-retry]');
    await page.waitForSelector('#reports-view .reports-stats');
  } finally { await close(); }
  const staff = await launch({ user: USERS.bartender });
  try {
    // Sign-in sends a hidden destination to Home; a later direct link shows the permission state.
    await staff.page.evaluate(() => { location.hash = '#reports'; });
    await staff.page.waitForSelector('#reports-view .atlas-empty');
    assert.match(await staff.page.textContent('#reports-view .atlas-empty'), /Reports are for managers/);
  } finally { await staff.close(); }
});

// ---------- Marketing ----------

test('Marketing: overview lists what is coming up and waiting; drafts store venue time from any browser zone', { skip }, async () => {
  const { page, record, close } = await launch({ hash: '#marketing', timezoneId: 'America/New_York' });
  try {
    await page.waitForSelector('#marketing-view .atlas-list');
    const text = await page.textContent('#marketing-view');
    // S94: the caption follows publishing capability (nothing connected here).
    assert.match(text, /Atlas can't publish yet, so you post by hand and mark it here\./);
    assert.match(text, /Coming up/);
    assert.match(text, /Friday quiz night reel/);
    assert.match(text, /Sat 26 Sep, 17:00/, 'times show in venue time, not the browser zone');
    assert.match(text, /Suggestion/);
    // S94: the composer is a routed page (#marketing/new).
    await page.click('#marketing-view [data-mk-new]');
    await page.waitForSelector('[data-mk-composer] #mk-title');
    await page.fill('#mk-title', 'Autumn menu teaser');
    await page.fill('#mk-when', '2026-10-01T18:00');
    await page.fill('#mk-caption', 'Six new drinks from Thursday.');
    await page.waitForFunction(() => /Posts Thu 1 Oct at 18:00/.test(document.querySelector('[data-mk-when-echo]')?.textContent || ''));
    await page.click('[data-mk-composer] [data-mk-save]');
    await until(() => requestsTo(record, 'atlas-marketing-workspace', 'create-content').length, { message: 'create-content' });
    await settle(page);
    const create = requestsTo(record, 'atlas-marketing-workspace', 'create-content').at(-1);
    assert.equal(create.body.scheduled_for, '2026-10-01T18:00:00.000Z', 'Reykjavík wall time, whatever the browser zone');
    assert.equal(create.body.reminder_at, null);
  } finally { await close(); }
});

test('Marketing: approving from the sheet; staff see the permission state; phone has no horizontal scroll', { skip }, async () => {
  // S94: Instagram needs a photo or video before approval; c1 carries one here.
  const withMedia = () => { const payload = marketingWorkspace(); payload.workspace.content_items[0].media = [{ asset_id: '00000000-0000-4000-8000-000000000950', kind: 'video', mime_type: 'video/mp4', width: 1080, height: 1920, duration_ms: 20000, byte_size: 5000000, position: 0, role: 'cover', platform: null, thumb_url: null }]; return payload; };
  const { page, record, close } = await launch({ hash: '#marketing', overrides: { functions: { 'atlas-marketing-workspace': withMedia } } });
  try {
    await page.waitForSelector('#marketing-view [data-mk-open="c1"]');
    await page.click('#marketing-view .atlas-row__action[data-mk-open="c1"]');
    await page.waitForSelector('[data-mk-composer] [data-mk-decide="approved"]');
    await page.click('[data-mk-composer] [data-mk-decide="changes_requested"]');
    assert.match(await page.textContent('[data-mk-composer] [data-mk-error]'), /Add a note/);
    await page.click('[data-mk-composer] [data-mk-decide="approved"]');
    await until(() => requestsTo(record, 'atlas-marketing-workspace', 'decide-approval').some((entry) => entry.body?.decision === 'approved'), { message: 'the approval' });
    assert.equal(requestsTo(record, 'atlas-marketing-workspace', 'decide-approval').at(-1).body.decision, 'approved');
  } finally { await close(); }
  const staff = await launch({ user: USERS.bartender });
  try {
    // Sign-in sends a hidden destination to Home; a later direct link shows the permission state.
    await staff.page.evaluate(() => { location.hash = '#marketing'; });
    await staff.page.waitForSelector('#marketing-view .atlas-empty');
    assert.match(await staff.page.textContent('#marketing-view'), /Marketing is for managers/);
  } finally { await staff.close(); }
  const phone = await launch({ hash: '#marketing/calendar', viewport: PHONE });
  try {
    await phone.page.waitForSelector('#marketing-view .mk-agenda');
    assert.ok(await noHorizontalScroll(phone.page));
  } finally { await phone.close(); }
});

// ---------- Data ----------

test('Data: imports list puts files needing attention first; an import shows its steps and plain-language failure', { skip }, async () => {
  const { page, record, close } = await launch({ hash: '#data' });
  try {
    await page.waitForSelector('#data-view tbody tr');
    const files = await page.$$eval('#data-view tbody tr .cell-primary', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(files.slice(0, 2).sort(), ['Globus invoice September.pdf', 'Stock count back bar.csv']);
    assert.equal(files[2], 'Supplier price list.xlsx');
    assert.match(await page.textContent('#data-view .page-head__sub'), /2 imports need attention · 9 record issues · 3 waiting for approval/);
    await page.click('#data-view a.cell-primary[href$="000000000201"]');
    await page.waitForSelector('#data-view .atlas-steps');
    const detail = await page.textContent('#data-view .data-import-detail');
    assert.match(detail, /Atlas couldn.t read this file\./);
    assert.match(detail, /Your live records were not changed\./);
    assert.doesNotMatch(detail, /pdf parse error/, 'no raw error text');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('Data: issues list every non-empty code with a Fix action to the canonical editor', { skip }, async () => {
  const { page, close } = await launch({ hash: '#data/issues' });
  try {
    await page.waitForSelector('#data-view [data-data-issue]');
    const chips = await page.$$eval('#data-view [data-data-issue]', (nodes) => nodes.map((node) => node.dataset.dataIssue));
    // S90: requests waiting for approval link to their own tab instead of a chip.
    assert.deepEqual(chips, ['inventory.supplier_text_unlinked', 'inventory.missing_cost', 'inventory.package_missing', 'inventory.missing_par', 'recipe.missing_price', 'inventory.possible_duplicate', 'inventory.category_unmapped']);
    assert.match(await page.textContent('#data-view'), /3 changes are waiting for a decision in Waiting for approval\./);
    assert.ok(await page.$('#data-view a[href="#data/approvals"]'));
    await page.waitForSelector('#data-view tbody a[href^="#inventory/item/"]');
    await page.click('#data-view [data-data-issue="recipe.missing_price"]');
    await page.waitForSelector(`#data-view tbody a[href="#recipes/${IDS.espresso}/edit"]`);
    await page.click('#data-view [data-data-issue="inventory.missing_par"]');
    await page.waitForSelector(`#data-view tbody a[href="#data/pars?item=${IDS.lime}"]`);
    await page.click('#data-view [data-data-issue="inventory.possible_duplicate"]');
    await page.waitForSelector('#data-view [data-data-resolve-duplicate]');
    await page.click('#data-view [data-data-resolve-duplicate]');
    await page.waitForSelector('#data-duplicate-modal.is-open');
    for (const mode of ['retire_into', 'not_duplicates', 'different_pack']) assert.ok(await page.$(`#data-duplicate-modal input[value="${mode}"]`), mode);
  } finally { await close(); }
});

test('Data: par levels suggest only after days of cover are typed and save only on "Save n changes"', { skip }, async () => {
  const { page, backend, close } = await launch({ hash: '#data/pars' });
  try {
    await page.waitForSelector('#data-view .data-par-table tbody tr');
    assert.equal(await page.$('#data-view [data-data-par-use]'), null, 'no suggestion before days of cover');
    await page.fill('#data-cover-days', '14');
    await page.click('#data-view [data-data-cover-form] [type="submit"]');
    await page.waitForSelector('#data-view [data-data-par-use]');
    assert.equal(backend.calls.rpc.filter((call) => call.name === 'atlas_apply_par_levels').length, 0, 'nothing saved yet');
    await page.click(`#data-view [data-data-par-use="${IDS.campari}"]`);
    await page.fill(`#data-view [data-data-par-input="${IDS.tonic}"]`, '80');
    await page.waitForSelector('#data-view [data-data-par-save]:not([disabled])');
    assert.match(await page.textContent('#data-view [data-data-par-save]'), /Save 2 changes/);
    await page.click('#data-view [data-data-par-save]');
    await until(() => backend.calls.rpc.some((entry) => entry.name === 'atlas_apply_par_levels'), { message: 'atlas_apply_par_levels' });
    await settle(page);
    const call = backend.calls.rpc.find((entry) => entry.name === 'atlas_apply_par_levels');
    const byItem = Object.fromEntries(call.body.p_changes.map((change) => [change.item_id, change]));
    assert.equal(byItem[IDS.campari].par_level, 20);
    assert.equal(byItem[IDS.campari].expected_par_level, 4);
    assert.equal(byItem[IDS.campari].suggestion.shown, true);
    assert.equal(byItem[IDS.tonic].par_level, 80);
  } finally { await close(); }
});

test('Data: a par conflict writes nothing and lists what changed', { skip }, async () => {
  const conflict = { status: 'conflict', request_id: 'x', replayed: false, changed: [], unchanged: [], conflicts: [{ item_id: IDS.gin, name: 'Tanqueray London Dry', expected_par_level: 6, current_par_level: 8 }] };
  const { page, close } = await launch({ hash: '#data/pars', overrides: { rpc: { atlas_apply_par_levels: conflict } } });
  try {
    await page.waitForSelector(`#data-view [data-data-par-input="${IDS.gin}"]`);
    await page.fill(`#data-view [data-data-par-input="${IDS.gin}"]`, '10');
    await page.click('#data-view [data-data-par-save]');
    await page.waitForSelector('#data-view .atlas-alert--warning');
    const text = await page.textContent('#data-view .atlas-alert--warning');
    assert.match(text, /Nothing was saved/);
    assert.match(text, /Tanqueray London Dry: you started from 6, it is now 8/);
    assert.equal(await page.inputValue(`#data-view [data-data-par-input="${IDS.gin}"]`), '10', 'the typed value is kept for review');
  } finally { await close(); }
});

test('Data: approvals decide with the request version, show the record, and feed Home and the nav badge', { skip }, async () => {
  const { page, record, close } = await launch({ hash: '#data/approvals' });
  try {
    await page.waitForSelector('#data-view [data-data-request]');
    assert.equal(await page.textContent('.atlas-sidebar [data-nav-badge="data"]'), '3');
    const rows = await page.evaluate(() => window.AtlasShell.home.rows({ role: 'admin' }).filter((row) => row.source === 'data'));
    assert.equal(rows[0].title, '3 catalogue changes are waiting for your approval');
    assert.equal(rows[0].action.route, '#data/approvals');
    await page.click(`#data-view [data-data-request="${IDS.requestNew}"]`);
    await page.waitForSelector('#data-request-modal.is-open');
    const sheet = await page.textContent('#data-request-modal');
    assert.match(sheet, /Similar items/);
    assert.match(sheet, /Monin Vanilla Syrup/);
    assert.match(sheet, /Requested/);
    await page.click('#data-request-modal [data-data-request-decide="approve"]');
    await until(() => requestsTo(record, 'atlas-item-master', 'catalog-decide').length, { message: 'catalog-decide' });
    await settle(page);
    const decide = requestsTo(record, 'atlas-item-master', 'catalog-decide').at(-1);
    assert.equal(decide.body.id, IDS.requestNew);
    assert.equal(decide.body.expected_version, 2);
    assert.equal(decide.body.decision, 'approve');
    // Backfill only proposes.
    await page.click('#data-view [data-data-backfill]');
    await page.click('#data-confirm-modal [data-data-confirm]');
    await until(() => requestsTo(record, 'atlas-item-master', 'catalog-backfill').length, { message: 'catalog-backfill' });
    await settle(page);
    assert.equal(requestsTo(record, 'atlas-item-master', 'catalog-backfill').length, 1);
  } finally { await close(); }
  const staff = await launch({ user: USERS.bartender });
  try {
    // Sign-in sends a hidden destination to Home; a later direct link shows the permission state.
    await staff.page.evaluate(() => { location.hash = '#data'; });
    await staff.page.waitForSelector('#data-view .atlas-empty');
    assert.match(await staff.page.textContent('#data-view'), /Data is for managers/);
    assert.equal(await staff.page.evaluate(() => window.AtlasShell.home.rows({ role: 'bartender' }).filter((row) => row.source === 'data').length), 0);
  } finally { await staff.close(); }
});

test('Data: summary failure shows an alert with a retry; tabs are keyboard links; phone has no horizontal scroll', { skip }, async () => {
  const { page, close } = await launch({ hash: '#data/issues', overrides: { rpc: { atlas_data_review_summary: { __status: 503, body: { message: 'boom' } } } } });
  try {
    await page.waitForSelector('#data-view .atlas-alert--danger');
    assert.match(await page.textContent('#data-view .atlas-alert--danger'), /Record issues couldn.t be loaded\./);
    await page.focus('#data-view .atlas-tabs a[href="#data/pars"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash === '#data/pars');
  } finally { await close(); }
  const phone = await launch({ hash: '#data/pars', viewport: PHONE });
  try {
    await phone.page.waitForSelector('#data-view .data-par-table');
    assert.ok(await noHorizontalScroll(phone.page));
  } finally { await phone.close(); }
});
