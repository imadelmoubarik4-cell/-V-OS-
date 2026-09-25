// S88 redesign shell (docs/design/Atlas_Experience_Redesign.md §3.3, §4): the
// sidebar, rail, top bar, phone tab bar and More sheet, command palette,
// notifications panel, account menu, toasts and the page-level checks of the
// review checklist (no horizontal scroll, 44 px targets, visible focus, zoom).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, USERS } from './harness.mjs';
import { emptyFunctions, settingsWorkspace } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const balance = (id, quantity) => ({ inventory_item_id: id, verified_quantity: quantity, freshness_state: 'current', verified_at: new Date(Date.now() - 86400000).toISOString(), expires_at: new Date(Date.now() + 864000000).toISOString() });
const fixtures = {
  tables: {
    inventory_items: [
      { id: 'campari', name: 'Campari', category: 'Liqueurs', unit: 'bottles', par_level: 4, supplier: 'Globus', active: true, cost_price: 3900 },
      { id: 'gin', name: 'Gin', category: 'Gin', unit: 'bottles', par_level: 2, supplier: 'Globus', active: true, cost_price: 5000 }
    ],
    recipes: [{ id: 'spritz', name: 'Campari Spritz', active: true, yield_quantity: 1, recipe_ingredients: [] }],
    suppliers: [{ id: 's1', name: 'Globus', email: 'orders@globus.example' }]
  },
  functions: { ...emptyFunctions(), 'atlas-stock-counts': { counts: { verified_balances: [balance('campari', 1), balance('gin', 3)] } } }
};
const WIDTHS = [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [430, 932], [390, 844]];

const launch = (options = {}) => launchAtlas({ fixtures, ...options });

const visibleSidebar = (page) => page.evaluate(() => [...document.querySelectorAll('.atlas-sidebar .nav-item[data-nav-id]')]
  .filter((node) => node.getClientRects().length > 0).map((node) => node.dataset.navId));
const groupLabels = (page) => page.evaluate(() => [...document.querySelectorAll('.atlas-sidebar .nav-label')]
  .filter((node) => node.getClientRects().length > 0).map((node) => node.textContent.trim()));

test('sidebar: spec groups and role visibility (admin sees 13 + Settings, bartender exactly 9)', { skip }, async () => {
  for (const [user, expected, labels] of [
    [USERS.admin, ['home', 'ai', 'messages', 'operations', 'inventory', 'recipes', 'purchasing', 'shifts', 'team', 'knowledge', 'reports', 'marketing', 'data', 'settings'], ['Venue', 'People', 'Business']],
    [USERS.bartender, ['home', 'ai', 'messages', 'operations', 'inventory', 'recipes', 'shifts', 'team', 'knowledge'], ['Venue', 'People']]
  ]) {
    const { page, record, close } = await launch({ user });
    try {
      assert.deepEqual(await visibleSidebar(page), expected, user.role);
      assert.deepEqual(await groupLabels(page), labels, `${user.role}: no empty group`);
      // The active item is neutral (white surface, no blue), aria-current on one link.
      const active = await page.evaluate(() => {
        const node = document.querySelector('.atlas-sidebar .nav-item[aria-current="page"]');
        const style = getComputedStyle(node);
        return { id: node.dataset.navId, bg: style.backgroundColor, color: style.color, count: document.querySelectorAll('.atlas-sidebar [aria-current="page"]').length };
      });
      assert.deepEqual([active.id, active.bg, active.count], ['home', 'rgb(255, 255, 255)', 1]);
      assert.equal(active.color, 'rgb(11, 15, 20)');
      // Landmarks: one Main navigation visible, banner top bar, main content.
      assert.equal(await page.evaluate(() => document.querySelector('.atlas-sidebar nav.atlas-nav').getAttribute('aria-label')), 'Main');
      assert.equal(await page.evaluate(() => document.querySelector('main#atlas-main') !== null && document.querySelector('header.atlas-topbar') !== null), true);
      // No Service Mode, no floating +, bell is a real control.
      assert.equal(await page.$('#service-mode-btn, .fab-wrap, #fab-btn, #global-search'), null);
      assert.deepEqual(record.pageErrors, []);
    } finally { await close(); }
  }
});

test('rail at 1024 and 768: 64 px icons with tooltips; toggle opens the full sidebar as an overlay', { skip }, async () => {
  for (const [width, height] of [[1024, 768], [768, 1024]]) {
    const { page, record, close } = await launch({ viewport: { width, height } });
    try {
      const rail = await page.evaluate(() => ({
        width: document.getElementById('atlas-sidebar').getBoundingClientRect().width,
        labels: [...document.querySelectorAll('.atlas-sidebar .nav-item-label')].filter((node) => node.getClientRects().length > 0).length,
        omni: document.getElementById('atlas-omni').getBoundingClientRect().width
      }));
      assert.equal(Math.round(rail.width), 64, `${width}: rail width`);
      assert.equal(rail.labels, 0, `${width}: labels hidden in the rail`);
      assert.equal(Math.round(rail.omni), width < 1024 ? 280 : 360);
      await page.hover('.atlas-sidebar .nav-item[data-nav-id="recipes"]');
      await page.waitForSelector('#atlas-tooltip:not([hidden])');
      assert.equal(await page.textContent('#atlas-tooltip'), 'Recipes');
      await page.click('#atlas-sidebar-toggle');
      const overlay = await page.evaluate(() => ({ width: document.getElementById('atlas-sidebar').getBoundingClientRect().width, scrim: !document.getElementById('atlas-sidebar-scrim').hidden, expanded: document.getElementById('atlas-sidebar-toggle').getAttribute('aria-expanded') }));
      assert.deepEqual(overlay, { width: 240, scrim: true, expanded: 'true' });
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.body.classList.contains('atlas-sidebar-open')), false);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'atlas-sidebar-toggle', 'focus returns to the toggle');
      assert.deepEqual(record.pageErrors, []);
    } finally { await close(); }
  }
});

test('at 1440 the sidebar collapses to the rail and the choice survives a reload', { skip }, async () => {
  const { page, close } = await launch();
  try {
    assert.equal(Math.round(await page.evaluate(() => document.getElementById('atlas-sidebar').getBoundingClientRect().width)), 240);
    await page.click('#atlas-sidebar-toggle');
    assert.equal(Math.round(await page.evaluate(() => document.getElementById('atlas-sidebar').getBoundingClientRect().width)), 64);
    assert.equal(await page.getAttribute('#atlas-sidebar-toggle', 'aria-label'), 'Expand sidebar');
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true');
    assert.equal(Math.round(await page.evaluate(() => document.getElementById('atlas-sidebar').getBoundingClientRect().width)), 64);
  } finally { await close(); }
});

test('phone (390 and 430): top bar title, 5-slot tab bar, More sheet with the rest per role', { skip }, async () => {
  for (const [user, width, more] of [
    [USERS.admin, 390, ['messages', 'operations', 'purchasing', 'shifts', 'team', 'knowledge', 'reports', 'marketing', 'data', 'settings']],
    [USERS.bartender, 430, ['messages', 'operations', 'shifts', 'team', 'knowledge', 'settings']]
  ]) {
    const { page, record, close } = await launch({ user, viewport: { width, height: 900 } });
    try {
      const chrome = await page.evaluate(() => ({
        sidebar: document.getElementById('atlas-sidebar').getClientRects().length,
        title: document.getElementById('atlas-page-title').textContent,
        titleVisible: document.getElementById('atlas-page-title').getClientRects().length > 0,
        tabs: [...document.querySelectorAll('.atlas-tabbar__item > span:first-of-type')].map((node) => node.textContent.trim()),
        current: document.querySelector('.atlas-tabbar [aria-current="page"]')?.dataset.navId,
        topbar: Math.round(document.getElementById('atlas-topbar').getBoundingClientRect().height),
        tabbar: Math.round(document.getElementById('atlas-tabbar').getBoundingClientRect().height)
      }));
      assert.deepEqual(chrome, { sidebar: 0, title: 'Home', titleVisible: true, tabs: ['Home', 'Inventory', 'Atlas', 'Recipes', 'More'], current: 'home', topbar: 52, tabbar: 56 });
      await page.click('.atlas-tabbar__item[data-nav-id="inventory"]');
      await page.waitForFunction(() => document.body.dataset.atlasView === 'inventory');
      assert.equal(await page.textContent('#atlas-page-title'), 'Inventory');
      await page.click('#atlas-more-btn');
      await page.waitForSelector('#atlas-more .atlas-more', { state: 'visible' });
      assert.deepEqual(await page.$$eval('#atlas-more .atlas-more__row[data-nav-id]', (rows) => rows.map((row) => row.dataset.navId)), more);
      assert.equal(await page.getAttribute('#atlas-more-btn', 'aria-expanded'), 'true');
      await page.click('#atlas-more .atlas-more__row[data-nav-id="shifts"]');
      await page.waitForFunction(() => document.body.dataset.atlasView === 'shifts');
      assert.equal(await page.$eval('#atlas-more', (node) => node.hidden), true, 'opening a row closes the sheet');
      assert.equal(await page.evaluate(() => document.querySelector('.atlas-tabbar [aria-current="page"]')?.dataset.navId), 'more');
      // A detail screen owns the phone top bar: back chevron, title, its own action.
      await page.evaluate(() => window.AtlasChrome.setTopBar({ title: 'Campari', back: '#inventory', actions: [{ icon: 'ellipsis', label: 'More actions', run: () => { window.__topbarAction = true; } }], own: true }));
      const own = await page.evaluate(() => ({
        title: document.getElementById('atlas-page-title').textContent,
        back: document.getElementById('atlas-topbar-back').getBoundingClientRect().width,
        search: document.getElementById('atlas-phone-search').getClientRects().length
      }));
      assert.deepEqual(own, { title: 'Campari', back: 44, search: 0 });
      await page.click('[data-topbar-action="0"]');
      assert.equal(await page.evaluate(() => window.__topbarAction), true);
      await page.click('#atlas-topbar-back');
      await page.waitForFunction(() => document.body.dataset.atlasView === 'inventory');
      assert.deepEqual(await page.evaluate(() => [document.getElementById('atlas-page-title').textContent, document.getElementById('atlas-topbar-back').hidden]), ['Inventory', true], 'navigation resets the top bar');
      assert.deepEqual(record.pageErrors, []);
    } finally { await close(); }
  }
});

test('palette: ⌘K / Ctrl K / "/" open it; arrows, Tab and Enter run an action; focus returns', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await page.evaluate(() => window.AtlasShell.navigate('#inventory'));
    await page.waitForFunction(() => document.body.dataset.atlasView === 'inventory');
    await page.waitForTimeout(300);
    for (const shortcut of ['Meta+k', 'Control+k', '/']) {
      // "/" opens the palette only when focus is not in a field.
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press(shortcut);
      await page.waitForSelector('#atlas-palette:not([hidden])');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'atlas-palette-input', shortcut);
      await page.keyboard.press('Escape');
      await page.waitForSelector('#atlas-palette', { state: 'hidden' });
    }
    await page.keyboard.press('Meta+k');
    const empty = await page.evaluate(() => ({
      ctx: document.querySelector('.atlas-palette__ctx').textContent,
      sections: [...document.querySelectorAll('.atlas-palette__label-row')].map((node) => node.textContent),
      suggested: [...document.querySelectorAll('.atlas-palette__group')][0]?.innerText,
      role: document.getElementById('atlas-palette-input').getAttribute('role'),
      controls: document.getElementById('atlas-palette-input').getAttribute('aria-controls'),
      dialog: document.querySelector('.atlas-palette').getAttribute('role')
    }));
    assert.equal(empty.ctx, 'Inventory', 'the context tag names the page');
    assert.equal(empty.sections[0], 'Suggested');
    assert.match(empty.suggested, /Add item[\s\S]*Start stock count/, 'Inventory suggestions');
    assert.deepEqual([empty.role, empty.controls, empty.dialog], ['combobox', 'atlas-palette-list', 'dialog']);
    // Backspace on an empty input removes the context tag.
    await page.keyboard.press('Backspace');
    assert.equal(await page.$eval('.atlas-palette__ctx', (node) => node.hidden), true);
    await page.keyboard.type('camp');
    await page.waitForTimeout(200);
    const typed = await page.evaluate(() => ({
      sections: [...document.querySelectorAll('.atlas-palette__label-row')].map((node) => node.textContent),
      rows: [...document.querySelectorAll('.atlas-palette__item')].map((node) => node.querySelector('.atlas-palette__label').textContent),
      active: document.getElementById('atlas-palette-input').getAttribute('aria-activedescendant')
    }));
    assert.deepEqual(typed.sections.slice(0, 2), ['Items', 'Recipes']);
    assert.equal(typed.sections.at(-1), 'Ask Atlas', 'Ask Atlas is last for a non-question');
    assert.ok(typed.rows.includes('Count Campari'), 'record-aware action');
    assert.ok(typed.rows.includes('Add Campari to an order'));
    assert.equal(typed.active, 'atlas-palette-option-0');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getAttribute('#atlas-palette-input', 'aria-activedescendant'), 'atlas-palette-option-1');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.getAttribute('#atlas-palette-input', 'aria-activedescendant'), `atlas-palette-option-${typed.rows.length - 1}`, 'arrows wrap');
    // Tab jumps to the first row of the next section (focus stays in the input).
    await page.keyboard.press('Tab');
    assert.equal(await page.getAttribute('#atlas-palette-input', 'aria-activedescendant'), 'atlas-palette-option-0');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'atlas-palette-input');
    assert.equal(await page.evaluate(() => document.querySelector('.atlas-palette__item.is-active .atlas-palette__label').textContent), 'Campari Spritz');
    // Run an action: "Count Campari" opens the stock count route.
    await page.fill('#atlas-palette-input', 'count campari');
    await page.waitForTimeout(200);
    const index = await page.evaluate(() => [...document.querySelectorAll('.atlas-palette__item')].findIndex((node) => node.textContent.includes('Count Campari')));
    for (let i = 0; i < index; i += 1) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash === '#inventory/counts');
    assert.equal(await page.$eval('#atlas-palette', (node) => node.hidden), true);
    // The + button opens Actions with an empty input.
    await page.click('#atlas-quick-actions');
    const actions = await page.evaluate(() => ({ value: document.getElementById('atlas-palette-input').value, active: document.querySelector('.atlas-palette__item.is-active')?.classList.contains('atlas-palette__item--action') }));
    assert.deepEqual(actions, { value: '', active: true });
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'atlas-quick-actions', 'focus returns to the trigger');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('palette: Ask Atlas routes to #ai/new with the query; questions put it first; recent records', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await page.click('#atlas-omni');
    await page.keyboard.type('what should I order?');
    await page.waitForTimeout(200);
    const first = await page.evaluate(() => ({ section: document.querySelector('.atlas-palette__label-row').textContent, active: document.querySelector('.atlas-palette__item.is-active .atlas-palette__label').textContent.trim() }));
    assert.deepEqual(first, { section: 'Ask Atlas', active: 'Ask Atlas “what should I order?”' });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash.startsWith('#ai/new?'));
    assert.match(await page.evaluate(() => location.hash), /^#ai\/new\?q=what%20should%20I%20order%3F&from=home$/);
    // ⌘↵ asks Atlas with whatever is typed.
    await page.click('#atlas-omni');
    await page.keyboard.type('gin');
    await page.keyboard.press('Meta+Enter');
    await page.waitForFunction(() => location.hash.startsWith('#ai/new?q=gin'));
    // Opening a record remembers it for the empty palette.
    await page.click('#atlas-omni');
    await page.keyboard.type('campari');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.dataset.atlasView === 'inventory');
    await page.evaluate(() => window.AtlasShell.navigate('#settings'));
    await page.click('#atlas-omni');
    const recent = await page.evaluate(() => [...document.querySelectorAll('.atlas-palette__group')].find((group) => group.textContent.startsWith('Recent'))?.innerText || '');
    assert.match(recent, /Campari/);
  } finally { await close(); }
});

test('notifications: popover on desktop, needs-action filter, mark read, full screen #notifications on phones', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await page.evaluate(() => {
      window.AtlasShell.notify.push({ id: 'order-1', type: 'order', severity: 'warning', icon: 'truck', title: 'Globus order is waiting for your approval', detail: '6 lines', time: Date.now() - 5 * 60000, action: { label: 'Review order', route: '#purchasing/orders' } });
      window.AtlasShell.notify.push({ id: 'info-1', title: 'Import finished', detail: 'Price list', time: Date.now() - 60 * 60000, needsAction: false });
    });
    await page.waitForFunction(() => !document.querySelector('#atlas-notifications-btn .dot').hidden);
    // Home's attention rows are notification items too (spec §4.9): Campari is
    // 1 of 4, so "Campari is below par" joins the two pushed items.
    assert.match(await page.getAttribute('#atlas-notifications-btn', 'aria-label'), /Notifications, 3 unread/);
    await page.click('#atlas-notifications-btn');
    await page.waitForSelector('#atlas-notifications .atlas-notify', { state: 'visible' });
    const panel = await page.evaluate(() => {
      const box = document.querySelector('.atlas-notify').getBoundingClientRect();
      const bell = document.getElementById('atlas-notifications-btn').getBoundingClientRect();
      return { width: Math.round(box.width), below: box.top >= bell.bottom, rows: [...document.querySelectorAll('.atlas-notify__item-title')].map((node) => node.textContent), count: document.querySelector('.atlas-notify__count').textContent };
    });
    assert.deepEqual({ ...panel, rows: [...panel.rows].sort() }, { width: 400, below: true, rows: ['Unread: Campari is below par', 'Unread: Globus order is waiting for your approval', 'Unread: Import finished'], count: '· 3 unread' });
    await page.click('[data-notify-filter="needs-action"]');
    assert.equal(await page.$$eval('.atlas-notify__item', (rows) => rows.length), 2);
    await page.click('[data-notify-filter="all"]');
    await page.click('[data-notify-more]');
    await page.click('[data-notify-action="read-all"]');
    assert.equal(await page.$$eval('.atlas-notify__item.is-unread', (rows) => rows.length), 0);
    assert.equal(await page.evaluate(() => document.querySelector('#atlas-notifications-btn .dot').hidden), true);
    // The row's action opens its route and closes the panel.
    await page.click('[data-notify-run="order-1"]');
    await page.waitForFunction(() => document.body.dataset.atlasView === 'suppliers');
    assert.equal(await page.$eval('#atlas-notifications', (node) => node.hidden), true);
    // Phone: full screen, the #notifications route, back chevron.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.AtlasShell.navigate('#home'));
    await page.click('#atlas-notifications-btn');
    await page.waitForFunction(() => location.hash === '#notifications');
    const phone = await page.evaluate(() => { const box = document.querySelector('.atlas-notify').getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; });
    assert.deepEqual(phone, [390, 844]);
    await page.click('.atlas-notify__back');
    await page.waitForFunction(() => location.hash === '#home');
    assert.equal(await page.$eval('#atlas-notifications', (node) => node.hidden), true);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('account menu: keyboard navigation, profile link, Escape returns focus, sign out', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    await page.focus('#atlas-account-btn');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#atlas-account-menu', { state: 'visible' });
    const menu = await page.evaluate(() => ({
      head: document.querySelector('.atlas-account-menu__head').innerText.replace(/\s+/g, ' ').trim(),
      items: [...document.querySelectorAll('#atlas-account-menu [role="menuitem"]')].map((node) => node.textContent.trim()),
      focused: document.activeElement?.textContent.trim(),
      expanded: document.getElementById('atlas-account-btn').getAttribute('aria-expanded')
    }));
    assert.equal(menu.head, 'IE Imad El Moubarik owner@example.test Administrator');
    assert.deepEqual(menu.items, ['Your profile', 'Preferences', 'Notification settings', 'Keyboard shortcuts', 'Sign out']);
    assert.deepEqual([menu.focused, menu.expanded], ['Your profile', 'true']);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), 'Preferences');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), 'Sign out');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'atlas-account-btn');
    await page.click('#atlas-account-btn');
    await page.click('[data-menu-action="profile"]');
    await page.waitForFunction((id) => location.hash === `#team/${id}`, USERS.admin.id);
    await page.click('#atlas-account-btn');
    await Promise.all([page.waitForEvent('load'), page.click('[data-menu-action="sign-out"]')]);
    assert.ok(record.requests.some((entry) => entry.path.startsWith('/auth/v1/logout')), 'sign out reached Auth');
  } finally { await close(); }
});

test('no horizontal page scroll at the six widths, for admin and bartender', { skip }, async () => {
  for (const user of [USERS.admin, USERS.bartender]) {
    for (const [width, height] of WIDTHS) {
      const { page, close } = await launch({ user, viewport: { width, height } });
      try {
        for (const route of ['#home', '#inventory', '#recipes']) {
          await page.evaluate((target) => window.AtlasShell.navigate(target), route);
          await page.waitForTimeout(150);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 0, `${user.role} ${width} ${route}: page scrolls sideways by ${overflow}px`);
        }
      } finally { await close(); }
    }
  }
});

test('phone: every shell control is at least 44 px; zoom is allowed; focus is visible; skip link', { skip }, async () => {
  const { page, close } = await launch({ viewport: { width: 390, height: 844 } });
  try {
    const meta = await page.getAttribute('meta[name="viewport"]', 'content');
    assert.doesNotMatch(meta, /maximum-scale|user-scalable\s*=\s*no/);
    // .atlas-notify__action is tracked by the todo test below (design-system request).
    const small = async () => page.evaluate(() => [...document.querySelectorAll('.atlas-topbar button, .atlas-tabbar__item, #atlas-more .atlas-more__row, #atlas-more .atlas-more__account, .atlas-palette__close, .atlas-palette__item, .atlas-notify button:not(.atlas-notify__action)')]
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => ({ id: node.id || node.className, h: node.getBoundingClientRect().height, w: node.getBoundingClientRect().width }))
      .filter((box) => box.h < 44 || box.w < 44));
    assert.deepEqual(await small(), [], 'top bar and tab bar');
    await page.click('#atlas-more-btn');
    assert.deepEqual(await small(), [], 'More sheet');
    await page.keyboard.press('Escape');
    await page.click('#atlas-phone-search');
    assert.deepEqual(await small(), [], 'palette');
    await page.click('.atlas-palette__close');
    await page.click('#atlas-notifications-btn');
    assert.deepEqual(await small(), [], 'notifications');
    await page.click('.atlas-notify__back');
    // Desktop keyboard: the skip link is the first stop and focus is a 2 px accent outline.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'atlas-skip-link');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'atlas-main');
    await page.focus('.atlas-sidebar .nav-item[data-nav-id="recipes"]');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => { const style = getComputedStyle(document.activeElement); return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`; });
    assert.equal(ring, 'solid 2px rgb(59, 130, 246)');
  } finally { await close(); }
});

test('phone: notification row actions are at least 44 px', {
  skip,
  todo: 'design-system request (S88 Team A): .atlas-notify__action is atlas-btn--sm, 32 px tall on phones (atlas-shell.css)'
}, async () => {
  const { page, close } = await launch({ viewport: { width: 390, height: 844 } });
  try {
    await page.click('#atlas-notifications-btn');
    await page.waitForSelector('.atlas-notify__action');
    const heights = await page.$$eval('.atlas-notify__action', (nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    assert.ok(heights.every((height) => height >= 44), `row actions are ${heights.join(', ')} px tall`);
  } finally { await close(); }
});

test('toasts: one at a time, role=status, above the tab bar on phones', { skip }, async () => {
  const { page, close } = await launch({ viewport: { width: 390, height: 844 } });
  try {
    await page.evaluate(() => { window.AtlasShell.toast('First'); window.AtlasShell.toast('Order created', { action: { label: 'View', run: () => window.AtlasShell.navigate('#purchasing') } }); });
    const toast = await page.evaluate(() => {
      const region = document.getElementById('atlas-toast-region');
      const tabbar = document.getElementById('atlas-tabbar').getBoundingClientRect();
      return { role: region.getAttribute('role'), count: region.querySelectorAll('.atlas-toast').length, text: region.textContent, above: region.getBoundingClientRect().bottom <= tabbar.top };
    });
    assert.deepEqual(toast, { role: 'status', count: 1, text: 'Order createdView', above: true });
  } finally { await close(); }
});

test('brand line reads the venue from Settings, shows "Atlas" alone without one; Reports Ask Atlas is in the header', { skip }, async () => {
  const venue = settingsWorkspace();
  venue.sections.find((section) => section.section_key === 'venue').value.city = 'Reykjavík';
  const withVenue = await launch({ fixtures: { ...fixtures, functions: { ...fixtures.functions, 'atlas-settings': { workspace: venue } } } });
  try {
    await withVenue.page.waitForFunction(() => !document.getElementById('atlas-brand-venue').hidden);
    assert.equal(await withVenue.page.textContent('#atlas-brand-venue'), 'VÁ Bar · Reykjavík');
    await withVenue.page.evaluate(() => window.AtlasShell.navigate('#reports'));
    await withVenue.page.waitForSelector('.reports-head [data-reports-ask]');
    assert.notEqual(await withVenue.page.$eval('.reports-head [data-reports-ask]', (node) => getComputedStyle(node).position), 'fixed', 'Ask Atlas sits in the header, not floating');
  } finally { await withVenue.close(); }
  const without = await launch();
  try {
    await without.page.waitForTimeout(300);
    assert.equal(await without.page.$eval('#atlas-brand-venue', (node) => node.hidden), true);
    // Brand v1.0: the supplied horizontal lockup, never typed text.
    const lockup = await without.page.$eval('.atlas-brand__lockup', (img) => ({ alt: img.alt, src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0, width: img.getBoundingClientRect().width }));
    assert.deepEqual({ ...lockup, width: undefined }, { alt: 'Atlas', src: 'assets/brand/Atlas_Primary_Horizontal_Midnight.svg', loaded: true, width: undefined });
    assert.ok(lockup.width >= 96, `lockup ${lockup.width}px is below the 96 px minimum`);
    assert.equal(await without.page.textContent('.atlas-brand__link'), '');
  } finally { await without.close(); }
});

test('"/" types into fields instead of opening the palette; Tab stays inside open overlays', { skip }, async () => {
  const { page, close } = await launch();
  try {
    await page.evaluate(() => window.AtlasShell.navigate('#inventory'));
    await page.focus('#inventory-search');
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => window.AtlasPalette.isOpen()), false);
    assert.equal(await page.inputValue('#inventory-search'), '/');
    // Focus trap: Tab from the palette input never leaves the dialog.
    await page.click('#atlas-omni');
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.getElementById('atlas-palette').contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    // The More sheet (phone) traps focus too, and Escape returns focus to More.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#atlas-more-btn');
    for (let i = 0; i < 20; i += 1) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#atlas-more .atlas-more').contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'atlas-more-btn');
  } finally { await close(); }
});

test('AtlasShell.menu is idempotent: re-binding on every render never duplicates handlers', { skip }, async () => {
  const { page, record, close } = await launch();
  try {
    const result = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = '<button type="button" id="t-trigger">Row actions</button><div class="atlas-menu" id="t-menu"><button type="button" class="atlas-menu__item">Edit</button></div>';
      document.body.append(host);
      const trigger = document.getElementById('t-trigger');
      const menu = document.getElementById('t-menu');
      let selected = 0;
      let lastOption = '';
      const handles = [];
      // A list re-rendered five times binds the same trigger and menu five times.
      for (let i = 0; i < 5; i += 1) handles.push(window.AtlasShell.menu(trigger, menu, { onSelect: () => { selected += 1; lastOption = `render-${i}`; } }));
      const sameHandle = handles.every((handle) => handle === handles[0]);
      trigger.click();
      const openAfterOneClick = !menu.hidden;
      menu.querySelector('.atlas-menu__item').click();
      const afterSelect = { selected, lastOption, closed: menu.hidden };
      // Re-rendered menu element for the same trigger: the old one is unbound.
      const fresh = document.createElement('div');
      fresh.className = 'atlas-menu';
      fresh.innerHTML = '<button type="button" class="atlas-menu__item">Delete</button>';
      host.append(fresh);
      let freshSelected = 0;
      const second = window.AtlasShell.menu(trigger, fresh, { onSelect: () => { freshSelected += 1; } });
      menu.hidden = false;
      menu.querySelector('.atlas-menu__item').click();
      const staleIgnored = selected === 1;
      trigger.click();
      fresh.querySelector('.atlas-menu__item').click();
      second.dispose();
      trigger.click();
      const disposed = fresh.hidden;
      host.remove();
      return { sameHandle, openAfterOneClick, afterSelect, staleIgnored, freshSelected, newHandle: second !== handles[0], disposed };
    });
    assert.deepEqual(result, {
      sameHandle: true,
      openAfterOneClick: true,
      afterSelect: { selected: 1, lastOption: 'render-4', closed: true },
      staleIgnored: true,
      freshSelected: 1,
      newHandle: true,
      disposed: true
    });
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});
