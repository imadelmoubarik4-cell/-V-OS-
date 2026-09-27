// Atlas Flavor Intelligence in the browser: the Flavor Map (#recipes/flavor),
// Create with Atlas (ideas → draft preview → Approve/Discard) and the
// bartender's browse-only view. The page talks to the real atlas-ai handler
// and flavour engine running in Node (tests/browser/flavor-fixtures.mjs), so
// every payload has the engine's real shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { harnessAvailable, launchAtlas, settle, USERS } from './harness.mjs';
import { flavorBackend, flavorCalls } from './flavor-fixtures.mjs';
import { request as aiRequest, USERS as AI_USERS } from '../node/helpers/atlas-ai-harness.mjs';
import { IDS } from '../ai-evals/fixtures/world.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const PHONE = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const TOUCH = { hasTouch: true, isMobile: true };
// Screenshots for visual review when ATLAS_FLAVOR_SHOTS names a directory.
const SHOTS = process.env.ATLAS_FLAVOR_SHOTS || '';

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

function launch(backend, options = {}) {
  return launchAtlas({ ...options, fixtures: backend.fixtures(options.extra || {}) });
}

async function openMap(page) {
  await page.waitForSelector('.flavor-map__node', { timeout: 15000 });
  await settle(page);
}

async function noHorizontalScroll(page, label) {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(scroll <= width, `${label}: page scrolls sideways (${scroll} > ${width})`);
}

const hashIs = (page, pattern) => page.waitForFunction((source) => new RegExp(source).test(location.hash), pattern.source);

test('Flavor Map at 1440×900: deep link, ring ⇔ list, pair detail, stock states and reload', { skip }, async () => {
  const backend = flavorBackend();
  // Campari verified at zero: the red bitter aperitivo is "not in stock".
  backend.world.data.balances.find((row) => row.inventory_item_id === IDS.item.campari).verified_quantity = 0;
  const { page, close, record } = await launch(backend, { hash: '#recipes/flavor/london-dry-gin' });
  try {
    await openMap(page);
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'recipes');
    assert.equal(await page.getAttribute('.atlas-nav .nav-item[data-nav-id="recipes"]', 'aria-current'), 'page', 'Recipes is highlighted');
    assert.equal(await page.textContent('.flavor-map__center-name'), 'London dry gin');
    const ring = await page.$$eval('.flavor-map__node', (nodes) => nodes.map((node) => node.dataset.flavorCenter));
    const list = await page.$$eval('[data-flavor-select]', (rows) => rows.map((row) => row.dataset.flavorSelect));
    assert.ok(ring.length >= 6);
    assert.deepEqual(list, ring, 'the list is the ring’s accessible equivalent');
    // Thin links: one per partner, width follows strength.
    assert.equal(await page.locator('.flavor-map__link').count(), ring.length);
    // Detail of the strongest pair by default.
    assert.match(await page.textContent('#flavor-detail-title'), /London dry gin \+ Lemon/);
    const detail = await page.textContent('#flavor-detail');
    assert.match(detail, /Culinary/);
    assert.doesNotMatch(detail, /Scientific/, 'culinary knowledge is never called scientific');
    assert.match(detail, /Confidence/);
    assert.match(detail, /Beefeater Gin · 5 bottle verified/);
    // Selecting another pair from the list: Atlas-learned evidence (Negroni) stays separately labelled.
    await page.click('[data-flavor-select="red-bitter-aperitivo"]');
    const negroni = await page.textContent('#flavor-detail');
    assert.match(negroni, /Culinary/);
    assert.match(negroni, /Atlas-learned/);
    assert.match(await page.textContent('#flavor-detail .flavor-detail__section:nth-of-type(2)'), /Negroni/, 'existing recipe usage');
    assert.match(negroni, /Not in stock/, 'verified zero reads as not in stock');
    assert.equal(await page.getAttribute('.flavor-map__node[data-flavor-center="red-bitter-aperitivo"]', 'data-stock'), 'out');
    assert.equal(await page.getAttribute('.flavor-map__node[data-flavor-center="basil"]', 'data-stock'), 'not_stocked');
    // Filters come from filters_available; the map has both evidence types.
    const map = flavorCalls(backend, 'flavor-map').at(-1);
    assert.ok(map, 'the map was read from flavor-map');
    assert.deepEqual(await page.$$eval('[data-flavor-evidence]', (chips) => chips.map((chip) => chip.dataset.flavorEvidence)), ['culinary', 'atlas_learned']);
    assert.equal(await page.locator('[data-flavor-use]').count(), 6, 'All plus the five uses the server offers');
    await shot(page, 'flavor-desktop-1440x900');
    await noHorizontalScroll(page, '1440×900');
    // In stock only: the server filters.
    await page.click('.flavor-map__filters [data-flavor-instock]');
    await page.waitForFunction(() => !document.querySelector('.flavor-map.is-loading') && document.querySelector('.flavor-map__filters [data-flavor-instock]')?.getAttribute('aria-pressed') === 'true');
    await settle(page);
    assert.match(flavorCalls(backend, 'flavor-map').at(-1).search, /in_stock_only=true/);
    const stocks = await page.$$eval('.flavor-map__node', (nodes) => nodes.map((node) => node.dataset.stock));
    assert.ok(stocks.length && stocks.every((stock) => stock === 'available'), stocks.join(','));
    // Reload keeps the deep link.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true', null, { timeout: 15000 });
    await openMap(page);
    assert.equal(await page.evaluate(() => location.hash), '#recipes/flavor/london-dry-gin');
    assert.equal(await page.textContent('.flavor-map__center-name'), 'London dry gin');
    assert.deepEqual(record.pageErrors, []);
    assert.deepEqual(backend.writes(), [], 'browsing writes nothing');
  } finally { await close(); }
});

test('Flavor Map: #recipes/flavor opens the default centre; unknown and possible-match stock; filters the server lacks are hidden', { skip }, async () => {
  const backend = flavorBackend();
  const { page, close } = await launch(backend, { hash: '#recipes/flavor', user: USERS.bartender });
  try {
    await openMap(page);
    assert.match(await page.evaluate(() => location.hash), /^#recipes\/flavor\/[a-z-]+$/, 'the address names the centre');
    // Strawberry: only a needs-review link (Cranberry Juice) → unknown, a possible match.
    await page.fill('#flavor-search', 'strawberry');
    await page.waitForSelector('.flavor-map__result[data-flavor-center="strawberry"]');
    await page.press('#flavor-search', 'Enter');
    await hashIs(page, /^#recipes\/flavor\/strawberry$/);
    await page.waitForFunction(() => document.querySelector('.flavor-map__center-name')?.textContent === 'Strawberry');
    await settle(page);
    assert.equal(await page.getAttribute('.flavor-map__center', 'data-stock'), 'unknown');
    const detail = await page.textContent('#flavor-detail');
    assert.match(detail, /Stock unknown/);
    assert.match(detail, /Unknown is not zero/);
    assert.match(detail, /Possible match: Cranberry Juice/);
    assert.match(detail, /needs review, not counted as stock/);
    // Only culinary evidence here: no evidence chips at all.
    assert.equal(await page.locator('[data-flavor-evidence]').count(), 0);
    // Filters the map route never takes are never shown.
    const filterText = await page.textContent('.flavor-map__filters');
    assert.doesNotMatch(filterText, /Use soon|High margin|Low complexity|New ideas/);
  } finally { await close(); }
});

test('Flavor Map keyboard: arrows walk the ring, Enter and Space re-centre and focus follows', { skip }, async () => {
  const backend = flavorBackend();
  const { page, close } = await launch(backend, { hash: '#recipes/flavor/london-dry-gin' });
  try {
    await openMap(page);
    await page.focus('.flavor-map__node[data-ring-index="0"]');
    await page.keyboard.press('ArrowRight');
    const second = await page.evaluate(() => document.activeElement?.dataset.ringIndex);
    assert.equal(second, '1');
    const target = await page.evaluate(() => document.activeElement.dataset.flavorCenter);
    await page.keyboard.press('Enter');
    await hashIs(page, new RegExp(`^#recipes/flavor/${target}$`));
    await page.waitForFunction((slug) => document.querySelector('.flavor-map__center-name') && !document.querySelector('.flavor-map.is-loading') && location.hash.endsWith(slug), target);
    await settle(page);
    const focused = await page.evaluate(() => ({ cls: document.activeElement?.className || '', slug: document.activeElement?.dataset?.flavorCenter }));
    assert.match(focused.cls, /flavor-map__node/, 'focus stays on the ring');
    assert.equal(focused.slug, 'london-dry-gin', 'the pair just left is selected and focused');
    assert.match(await page.textContent('#flavor-detail-title'), /\+ London dry gin/);
    await page.keyboard.press('Space');
    await hashIs(page, /^#recipes\/flavor\/london-dry-gin$/);
    await settle(page);
    // Tab reaches the list rows (the accessible fallback) as buttons.
    assert.equal(await page.evaluate(() => document.querySelector('[data-flavor-select]').tagName), 'BUTTON');
  } finally { await close(); }
});

test('Flavor Map honours reduced motion: no node animation', { skip }, async () => {
  const backend = flavorBackend();
  const { page, close } = await launch(backend, { hash: '#recipes/flavor/london-dry-gin', contextOptions: { reducedMotion: 'reduce' } });
  try {
    await openMap(page);
    const animation = await page.$eval('.flavor-map__node', (node) => getComputedStyle(node).animationName);
    assert.equal(animation, 'none');
    assert.equal(await page.evaluate(() => document.getAnimations().filter((entry) => entry.playState === 'running').length), 0);
  } finally { await close(); }
});

test('Flavor Map on a phone (390×844): list first, 44 px targets, no sideways scroll', { skip }, async () => {
  const backend = flavorBackend();
  const { page, close } = await launch(backend, { hash: '#recipes/flavor/london-dry-gin', viewport: PHONE, contextOptions: TOUCH });
  try {
    await openMap(page);
    const tops = await page.evaluate(() => ['.flavor-map__list', '.flavor-detail', '.flavor-map__stage'].map((selector) => document.querySelector(selector).getBoundingClientRect().top));
    assert.ok(tops[0] < tops[1] && tops[1] < tops[2], `list, detail, ring: ${tops.join(', ')}`);
    const small = await page.$$eval('.flavor-map__node, .flavor-map__row-main, .flavor-map__row-centre, .flavor-detail__actions .atlas-btn, .flavor-map__filters .atlas-chip', (elements) => elements
      .map((element) => ({ text: element.textContent.trim() || element.getAttribute('aria-label'), box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width < 44 || box.height < 44)
      .map(({ text, box }) => `${text} ${Math.round(box.width)}×${Math.round(box.height)}`));
    assert.deepEqual(small, [], 'every target is at least 44 px');
    await page.tap('[data-flavor-select="tonic-water"]');
    await page.waitForFunction(() => /\+ Tonic water/.test(document.getElementById('flavor-detail-title')?.textContent || ''));
    const ringInside = await page.$$eval('.flavor-map__node', (nodes) => nodes.every((node) => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth; }));
    assert.ok(ringInside, 'ring labels stay on screen');
    await noHorizontalScroll(page, '390×844');
    await shot(page, 'flavor-phone-390x844');
  } finally { await close(); }
});

test('Flavor Map in short landscape (844×390): usable ring and detail, no sideways scroll', { skip }, async () => {
  const backend = flavorBackend();
  const { page, close } = await launch(backend, { hash: '#recipes/flavor/london-dry-gin', viewport: LANDSCAPE, contextOptions: TOUCH });
  try {
    await openMap(page);
    await noHorizontalScroll(page, '844×390');
    const [ring, detail] = await page.evaluate(() => ['.flavor-map__ring', '.flavor-detail'].map((selector) => { const box = document.querySelector(selector).getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; }));
    assert.ok(ring.width >= 280, `ring is usable (${ring.width})`);
    assert.ok(detail.left >= ring.right, 'the detail sits beside the ring');
    await page.tap('.flavor-map__node[data-flavor-center="lime"]');
    await hashIs(page, /^#recipes\/flavor\/lime$/);
    await page.waitForFunction(() => document.querySelector('.flavor-map__center-name')?.textContent === 'Lime');
    await settle(page);
    await noHorizontalScroll(page, '844×390 after re-centre');
    await shot(page, 'flavor-landscape-844x390');
  } finally { await close(); }
});

test('bartender browses only: no Create with Atlas, no costs, no draft, substitutes are read-only', { skip }, async () => {
  const backend = flavorBackend();
  const { page, close } = await launch(backend, { hash: '#recipes', user: USERS.bartender });
  try {
    await page.waitForSelector('[data-recipe-flavor-map]');
    assert.equal(await page.locator('[data-recipe-create-atlas]').count(), 0);
    await page.click('[data-recipe-flavor-map]');
    await hashIs(page, /^#recipes\/flavor/);
    await openMap(page);
    assert.equal(await page.locator('[data-flavor-open-create], [data-flavor-create]').count(), 0, 'no create actions');
    assert.doesNotMatch(await page.textContent('#recipes-view'), /\bkr\b|margin|cost/i);
    await page.click('#flavor-detail [data-flavor-substitutes]');
    await page.waitForSelector('#flavor-create .flavor-sub__row, #flavor-create .atlas-empty');
    const sheet = await page.textContent('#flavor-create');
    assert.match(sheet, /Substitutes for/);
    assert.doesNotMatch(sheet, /\bkr\b|Prepare draft|Approve/);
    assert.equal(await page.locator('#flavor-create [data-create-back]').count(), 0, 'no way into the create steps');
    // Opening Create directly still gives staff only the map.
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.AtlasFlavorMap.openCreate());
    await settle(page);
    assert.equal(await page.locator('#flavor-create [data-create-option]').count(), 0);
    assert.equal(flavorCalls(backend, 'flavor-compose').length, 0);
    assert.equal(flavorCalls(backend, 'flavor-candidates').length, 0);
    assert.deepEqual(backend.writes(), []);
  } finally { await close(); }
});

async function prepareFirstDraft(page) {
  await page.waitForSelector('[data-recipe-create-atlas]');
  await page.click('[data-recipe-create-atlas]');
  await page.waitForSelector('#flavor-create [data-create-option="stock"]');
  assert.deepEqual(await page.$$eval('#flavor-create [data-create-option]', (options) => options.map((option) => option.dataset.createOption)), ['stock', 'pair', 'substitute', 'map']);
  await page.click('[data-create-option="stock"]');
  await page.waitForSelector('[data-brief-stock][aria-checked="true"]');
  await page.click('[data-create-ideas]');
  await page.waitForSelector('.flavor-idea');
  await page.click('[data-create-compose="0"]');
  await page.waitForSelector('.flavor-draft');
  await settle(page);
}

test('Create with Atlas: ideas with every score → draft preview → Approve saves an inactive recipe and opens it', { skip }, async () => {
  const backend = flavorBackend();
  const { page, close, record } = await launch(backend, { hash: '#recipes' });
  try {
    await page.waitForSelector('[data-recipe-create-atlas]');
    await page.click('[data-recipe-create-atlas]');
    await page.click('[data-create-option="stock"]');
    await page.waitForSelector('[data-brief-stock][aria-checked="true"]');
    await page.click('[data-create-ideas]');
    await page.waitForSelector('.flavor-idea');
    const request = flavorCalls(backend, 'flavor-candidates').at(-1).body;
    assert.equal(request.no_new_purchases, true, 'no new purchases by default');
    assert.equal(request.type, 'cocktail');
    const card = await page.textContent('.flavor-idea');
    for (const label of ['Compatibility', 'Balance', 'From stock', 'Serves possible', 'Steps', 'New to the menu', 'Economics', 'Cost per serve', 'Verified in stock']) assert.match(card, new RegExp(label), label);
    await shot(page, 'flavor-ideas-desktop');
    await page.click('[data-create-compose="0"]');
    await page.waitForSelector('.flavor-draft');
    const draft = await page.textContent('.flavor-draft');
    assert.match(draft, /Saved as an inactive draft recipe — not on the menu/);
    assert.match(draft, /Signature cocktail/, 'the draft type reads as its Recipes category');
    assert.match(draft, /kr per serve \(estimated\)/, 'the manager sees the estimated cost');
    const name = (await page.textContent('#flavor-draft-title')).trim();
    assert.deepEqual(backend.writes(), [], 'nothing is saved before Approve');
    await shot(page, 'flavor-draft-preview-desktop');
    await page.click('[data-create-approve]');
    await hashIs(page, /^#recipes\/[0-9a-f-]{36}$/);
    const write = backend.writes().find((entry) => entry.name === 'atlas_save_recipe');
    assert.ok(write, 'saved through atlas_save_recipe');
    assert.equal(write.args.p_recipe_id, null, 'a new recipe');
    assert.equal(write.args.p_recipe.active, false);
    assert.equal(write.args.p_recipe.show_on_menu, false);
    const approval = flavorCalls(backend, 'execute-action').at(-1);
    assert.ok(approval.body.action_id, 'approved through execute-action with the proposal id');
    await page.waitForFunction((title) => document.getElementById('recipe-detail-title')?.textContent === title, name);
    assert.match(await page.textContent('#atlas-toast-region'), /saved\. It is inactive and not on the menu/);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('Create with Atlas: Discard rejects the proposal and saves nothing', { skip }, async () => {
  const backend = flavorBackend();
  const { page, close } = await launch(backend, { hash: '#recipes' });
  try {
    await prepareFirstDraft(page);
    await page.click('[data-create-discard]');
    await page.waitForSelector('.flavor-idea');
    assert.equal(flavorCalls(backend, 'reject-action').length, 1);
    assert.equal(flavorCalls(backend, 'execute-action').length, 0);
    assert.deepEqual(backend.writes(), []);
    assert.match(await page.textContent('#atlas-toast-region'), /Nothing was saved/);
    // Closing the sheet with a prepared draft also rejects it.
    await page.click('[data-create-compose="0"]');
    await page.waitForSelector('.flavor-draft');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('flavor-create'));
    await settle(page);
    assert.equal(flavorCalls(backend, 'reject-action').length, 2);
    assert.deepEqual(backend.writes(), []);
  } finally { await close(); }
});

test('Create with Atlas: a name taken meanwhile → rename, prepare again, approve', { skip }, async () => {
  const backend = flavorBackend();
  const { page, close } = await launch(backend, { hash: '#recipes', viewport: PHONE, contextOptions: TOUCH });
  try {
    await prepareFirstDraft(page);
    await shot(page, 'flavor-draft-preview-phone');
    await noHorizontalScroll(page, 'draft preview on a phone');
    // Someone saves the same idea first (same name).
    const candidate = flavorCalls(backend, 'flavor-compose').at(-1).body.candidate;
    const other = await (await backend.harness.handle(aiRequest('flavor-compose', { body: { candidate }, user: AI_USERS.manager }))).json();
    const done = await (await backend.harness.handle(aiRequest('execute-action', { body: { action_id: other.proposal.id }, user: AI_USERS.manager }))).json();
    assert.equal(done.ok, true);
    await page.click('[data-create-approve]');
    await page.waitForSelector('#flavor-draft-name-error');
    assert.match(await page.textContent('#flavor-draft-name-error'), /already exists, so nothing was saved/);
    assert.equal(await page.getAttribute('[data-create-approve]', 'disabled'), '');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'flavor-draft-name');
    assert.equal(backend.writes().length, 1, 'only the other save');
    await page.fill('#flavor-draft-name', 'Garden Test Highball');
    await page.click('[data-create-rename]');
    await page.waitForFunction(() => document.getElementById('flavor-draft-title')?.textContent === 'Garden Test Highball');
    assert.equal(flavorCalls(backend, 'flavor-compose').at(-1).body.name, 'Garden Test Highball');
    await page.click('[data-create-approve]');
    await hashIs(page, /^#recipes\/[0-9a-f-]{36}$/);
    const saved = backend.writes().at(-1);
    assert.equal(saved.args.p_recipe.name, 'Garden Test Highball');
    assert.equal(saved.args.p_recipe.active, false);
  } finally { await close(); }
});

test('Create with Atlas: stale idea (409) refreshes ideas; 429 and 503 read as fixed copy', { skip }, async () => {
  let composeStatus = 409;
  let ideasStatus = null;
  const backend = flavorBackend({
    overrides: {
      'flavor-compose': () => (composeStatus ? { __status: composeStatus, body: { error_code: composeStatus === 409 ? 'conflict' : 'unavailable', message: 'raw server text' } } : undefined),
      'flavor-candidates': () => (ideasStatus ? { __status: ideasStatus, body: { error_code: 'rate_limited', message: 'raw server text' } } : undefined),
      'flavor-map': (entry) => (/ingredient=vodka/.test(entry.search) ? { __status: 503, body: { error_code: 'unavailable', message: 'raw server text' } } : undefined)
    }
  });
  const { page, close } = await launch(backend, { hash: '#recipes' });
  try {
    await page.waitForSelector('[data-recipe-create-atlas]');
    await page.click('[data-recipe-create-atlas]');
    await page.click('[data-create-option="stock"]');
    await page.click('[data-create-ideas]');
    await page.waitForSelector('.flavor-idea');
    const before = flavorCalls(backend, 'flavor-candidates').length;
    await page.click('[data-create-compose="0"]');
    await page.waitForFunction((count) => document.querySelector('#flavor-create .atlas-alert--warning') && document.querySelectorAll('.flavor-idea').length > 0, before);
    assert.equal(flavorCalls(backend, 'flavor-candidates').length, before + 1, 'ideas were refreshed');
    assert.match(await page.textContent('#flavor-create'), /no longer possible from verified stock/);
    ideasStatus = 429;
    await page.click('[data-create-edit-brief]');
    await page.click('[data-create-ideas]');
    await page.waitForSelector('#flavor-create .atlas-alert--warning');
    const text = await page.textContent('#flavor-create');
    assert.match(text, /Too many flavour requests in a minute/);
    assert.doesNotMatch(text, /raw server text/);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.AtlasShell.navigate('#recipes/flavor/vodka'));
    await page.waitForSelector('[data-flavor-retry]');
    assert.match(await page.textContent('#recipes-view'), /flavour library isn’t available right now/);
    assert.doesNotMatch(await page.textContent('#recipes-view'), /raw server text/);
    assert.deepEqual(backend.writes(), []);
  } finally { await close(); }
});

test('Find substitutions from the map and Create recipe with this seeds both ingredients', { skip }, async () => {
  const backend = flavorBackend();
  const { page, close } = await launch(backend, { hash: '#recipes/flavor/london-dry-gin' });
  try {
    await openMap(page);
    await page.click('#flavor-detail [data-flavor-substitutes]');
    await page.waitForSelector('.flavor-sub__row');
    const sheet = await page.textContent('#flavor-create');
    assert.match(sheet, /Substitutes for Lemon/);
    assert.match(sheet, /Recorded substitute|Similar flavour profile/);
    assert.match(flavorCalls(backend, 'flavor-substitutes').at(-1).search, /ingredient=lemon/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('flavor-create'));
    await page.click('#flavor-detail [data-flavor-create]');
    await page.waitForSelector('[data-brief-unseed="london-dry-gin"]');
    assert.equal(await page.locator('[data-brief-unseed="lemon"]').count(), 1);
    await page.click('[data-create-ideas]');
    await page.waitForSelector('.flavor-idea, #flavor-create .atlas-empty');
    assert.deepEqual(flavorCalls(backend, 'flavor-candidates').at(-1).body.seed, ['london-dry-gin', 'lemon']);
    await noHorizontalScroll(page, 'ideas sheet');
  } finally { await close(); }
});
