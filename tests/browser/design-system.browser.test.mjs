// S88 design-system consolidation in the real app: the shell writes shorter
// routes, shared dialogs (AtlasModal.confirm/prompt/form), touch sizes,
// notifications filter preselect, the sidebar Messages badge, AtlasAI
// openDecision and the retired legacy layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, USERS } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';
import { aiFixtures, AI_FIXTURE_NOW } from './atlas-ai-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const fixtures = { tables: { inventory_items: [], recipes: [], suppliers: [], recipe_categories: [] }, functions: emptyFunctions() };
const launch = (options = {}) => launchAtlas({ fixtures, ...options });

test('the shell rewrites the address for a shorter route and knows Knowledge sources/activity', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await page.evaluate(() => window.AtlasShell.navigate('#purchasing/deliveries'));
    await page.waitForFunction(() => location.hash === '#purchasing/deliveries');
    await page.evaluate(() => window.AtlasShell.show('suppliers', {}));
    assert.equal(await page.evaluate(() => location.hash), '#purchasing', 'fewer route parts still rewrite the address');
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#purchasing/deliveries');
    const routes = await page.evaluate(() => ['#knowledge/sources', '#knowledge/activity', '#knowledge/k-1'].map((hash) => window.AtlasShell.parseRoute(hash).params));
    assert.deepEqual(routes, [{ section: 'sources' }, { section: 'activity' }, { article: 'k-1' }]);
    assert.equal(await page.evaluate(() => window.AtlasShell.href('knowledge', { section: 'activity' })), '#knowledge/activity');
  } finally { await close(); }
});

test('AtlasModal.confirm / prompt / form: labelled, focus-managed, promise results', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await page.evaluate(() => {
      const trigger = document.createElement('button');
      trigger.id = 'ds-trigger';
      trigger.textContent = 'Open';
      document.querySelector('#atlas-main').prepend(trigger);
      trigger.focus();
      window.__confirm = window.AtlasModal.confirm({ id: 'ds-confirm', title: 'Remove <b>this</b>?', body: 'It is kept in the history.', confirmLabel: 'Remove', danger: true });
    });
    await page.waitForSelector('#ds-confirm.is-open');
    const dialog = await page.evaluate(() => {
      const panel = document.querySelector('#ds-confirm [data-modal-panel]');
      return { role: panel.getAttribute('role'), modal: panel.getAttribute('aria-modal'), label: document.getElementById(panel.getAttribute('aria-labelledby'))?.textContent, danger: panel.querySelector('[type="submit"]').className, inert: document.getElementById('app-screen').inert };
    });
    assert.deepEqual(dialog, { role: 'dialog', modal: 'true', label: 'Remove <b>this</b>?', danger: 'atlas-btn atlas-btn--danger-solid', inert: true });
    await page.click('#ds-confirm [type="submit"]');
    assert.equal(await page.evaluate(() => window.__confirm), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'ds-trigger', 'focus returns to the trigger');
    assert.equal(await page.$('#ds-confirm'), null, 'the layer is removed');

    await page.evaluate(() => { window.__prompt = window.AtlasModal.prompt({ id: 'ds-prompt', title: 'Skip it?', label: 'Reason', required: true, confirmLabel: 'Skip' }); });
    await page.waitForFunction(() => document.activeElement?.id === 'ds-prompt-input');
    await page.click('#ds-prompt [type="submit"]');
    assert.equal(await page.isVisible('#ds-prompt [data-atlas-dialog-error]'), true, 'a required value is asked for');
    assert.equal(await page.getAttribute('#ds-prompt-input', 'aria-invalid'), 'true');
    await page.fill('#ds-prompt-input', '  Closed early ');
    await page.click('#ds-prompt [type="submit"]');
    assert.equal(await page.evaluate(() => window.__prompt), 'Closed early');

    await page.evaluate(() => { window.__dismissed = window.AtlasModal.prompt({ title: 'Note', label: 'Note' }); });
    await page.waitForSelector('[data-atlas-modal].is-open');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__dismissed), null, 'Esc dismisses with null');

    await page.evaluate(() => {
      let tries = 0;
      window.__form = window.AtlasModal.form({ id: 'ds-form', title: 'Log', body: '<div class="atlas-field"><label for="ds-v">Value</label><input class="atlas-input" id="ds-v" name="v"></div>', submitLabel: 'Save', onSubmit: async (form) => { tries += 1; return tries === 1 ? 'Enter a value.' : (window.__saved = form.v.value, null); } });
      window.__formHandle = Boolean(window.__form.form && window.__form.root && window.__form.close);
    });
    assert.equal(await page.evaluate(() => window.__formHandle), true, 'form() also hands back { root, form, close }');
    await page.click('#ds-form [type="submit"]');
    await page.waitForSelector('#ds-form [data-atlas-dialog-error]:not([hidden])');
    assert.equal(await page.textContent('#ds-form [data-atlas-dialog-error]'), 'Enter a value.');
    await page.fill('#ds-v', '4.5');
    await page.click('#ds-form [type="submit"]');
    assert.equal(await page.evaluate(() => window.__form), true);
    assert.equal(await page.evaluate(() => window.__saved), '4.5');
  } finally { await close(); }
});

test('touch: shared small buttons, chips, segmented controls and notification actions are 44 px', { skip }, async () => {
  const { page, close } = await launch({ viewport: { width: 390, height: 844 }, contextOptions: { hasTouch: true, isMobile: true } });
  try {
    const sizes = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = '<button class="atlas-btn atlas-btn--secondary atlas-btn--sm">Small</button><button class="atlas-chip">Chip</button><div class="atlas-segmented"><button aria-pressed="true">Week</button><button>Month</button></div><button class="atlas-icon-btn atlas-icon-btn--sm" aria-label="More">x</button>';
      document.querySelector('#atlas-main').prepend(host);
      return [...host.querySelectorAll('button')].map((node) => Math.round(node.getBoundingClientRect().height));
    });
    assert.ok(sizes.every((height) => height >= 44), `heights ${sizes.join(', ')}`);
    await page.click('#atlas-notifications-btn');
    await page.waitForSelector('.atlas-notify');
    const actions = await page.$$eval('.atlas-notify__action', (nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    assert.ok(actions.every((height) => height >= 44), `notification actions ${actions.join(', ')}`);
  } finally { await close(); }
});

test('notify.open({ filter }) preselects Needs action; #notifications?filter=needs-action too', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await page.evaluate(() => window.AtlasShell.notify.open({ filter: 'needs-action' }));
    await page.waitForSelector('.atlas-notify');
    assert.equal(await page.getAttribute('[data-notify-filter="needs-action"]', 'aria-checked'), 'true');
    await page.evaluate(() => window.AtlasShell.notify.close());
    await page.evaluate(() => window.AtlasShell.notify.open({ filter: 'all' }));
    assert.equal(await page.getAttribute('[data-notify-filter="all"]', 'aria-checked'), 'true');
    await page.evaluate(() => window.AtlasShell.notify.close());
    await page.evaluate(() => window.AtlasShell.navigate('#notifications?filter=needs-action'));
    assert.equal(await page.getAttribute('[data-notify-filter="needs-action"]', 'aria-checked'), 'true');
  } finally { await close(); }
});

test('the sidebar Messages link carries the unread badge from AtlasTeamUnreadBadge', { skip }, async () => {
  const { page, close } = await launch();
  try {
    const selector = '.atlas-sidebar .nav-item[data-nav-id="messages"] [data-nav-badge="messages"]';
    assert.equal(await page.isVisible(selector), false, 'no badge at zero');
    await page.evaluate(() => {
      window.AtlasTeamUnreadBadge = { ...(window.AtlasTeamUnreadBadge || {}), count: () => 3 };
      window.AtlasShell.emit('messages:unread', { total: 3, conversations: [] });
    });
    assert.equal(await page.textContent(selector), '3');
    assert.equal(await page.isVisible(selector), true);
    assert.equal(await page.getAttribute('.atlas-sidebar .nav-item[data-nav-id="messages"]', 'aria-label'), 'Messages, 3 unread');
  } finally { await close(); }
});

test('AtlasAI.openDecision selects the recommendation in #ai/decisions and opens it', { skip }, async () => {
  const { fixtures: aiWorld } = aiFixtures({});
  const { page, close } = await launchAtlas({ fixtures: aiWorld, fixedTime: AI_FIXTURE_NOW, hash: '#home', storage: { 'atlas.ai.voice.explained.v1': 'yes' } });
  try {
    await page.waitForFunction(() => typeof window.AtlasAI?.openDecision === 'function');
    await page.evaluate(() => window.AtlasAI.openDecision('r-1'));
    await page.waitForFunction(() => location.hash === '#ai/decisions?recommendation=r-1');
    await page.waitForSelector('.ai-layer.ai-sheet');
    await page.waitForSelector('[data-ai-dec-open="r-1"].is-selected[aria-current="true"]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => location.hash === '#ai/decisions');
    assert.equal(await page.$('[data-ai-dec-open="r-1"].is-selected'), null);
    // Messages links and the palette route the same way.
    assert.equal(await page.evaluate(() => window.AtlasAI.recordRoute({ type: 'brain_recommendation', id: 'r-9' })), '#ai/decisions?recommendation=r-9');
  } finally { await close(); }
});

test('no legacy layer reaches the page: four cascade layers, no inline style, cards without shadow or lift', { skip }, async () => {
  const { page, close } = await launch({ user: USERS.admin });
  try {
    const result = await page.evaluate(() => {
      const layers = new Set();
      const walk = (rules) => { for (const rule of rules) { if (rule instanceof CSSLayerBlockRule || rule instanceof CSSLayerStatementRule) (rule.nameList || [rule.name]).forEach((name) => layers.add(name)); if (rule.cssRules) walk(rule.cssRules); } };
      for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { /* cross-origin */ } }
      const card = document.createElement('div');
      card.className = 'atlas-card';
      document.querySelector('#atlas-main').prepend(card);
      const style = getComputedStyle(card);
      return { layers: [...layers].sort(), inline: document.querySelectorAll('style').length, shadow: style.boxShadow, transition: style.transitionProperty };
    });
    assert.deepEqual(result.layers, ['atlas.base', 'atlas.components', 'atlas.modules', 'atlas.tokens']);
    assert.equal(result.inline, 0);
    assert.equal(result.shadow, 'none');
    assert.doesNotMatch(result.transition, /transform/);
  } finally { await close(); }
});
