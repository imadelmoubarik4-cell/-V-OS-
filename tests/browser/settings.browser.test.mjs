// S87 Settings + Notifications regressions, exercised in Chromium against the
// real settings-workspace.js / notifications.js with a mocked backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, openView, requestsTo } from './harness.mjs';
import { emptyFunctions, settingsBackend } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function openSettings(options = {}) {
  const backend = settingsBackend(options);
  const app = await launchAtlas({ ...options, fixtures: { functions: { ...emptyFunctions(), 'atlas-settings': backend.handler, ...(options.functions || {}) } } });
  await openView(app.page, 'settings');
  await app.page.waitForSelector('.settings-shell .settings-tabs');
  return { ...app, backend };
}

async function tab(page, name) {
  await page.click(`[data-settings-tab="${name}"]`);
  await page.waitForTimeout(150);
}

test('saving one Settings form never relabels or disables another form', { skip }, async () => {
  const { page, close } = await openSettings({ delayMs: 900 });
  try {
    await tab(page, 'operations');
    await page.click('[data-settings-section-form="inventory"] button[type="submit"]');
    await page.waitForTimeout(150);
    const buttons = await page.$$eval('form[data-settings-section-form] button[type="submit"]', (nodes) => nodes.map((node) => ({
      form: node.closest('form').dataset.settingsSectionForm, text: node.textContent.trim(), disabled: node.disabled
    })));
    const busy = buttons.filter((entry) => entry.disabled || /Saving/.test(entry.text));
    assert.deepEqual(busy.map((entry) => entry.form), ['inventory']);
    await page.waitForSelector('[data-settings-section-form="inventory"] .settings-form-feedback.is-success');
    assert.equal(await page.$$eval('.settings-form-feedback', (nodes) => nodes.length), 1, 'feedback appears only on the saved form');
  } finally { await close(); }
});

test('unsaved edits in one form survive saving another form', { skip }, async () => {
  const { page, close } = await openSettings({ delayMs: 300 });
  try {
    await tab(page, 'operations');
    await page.fill('[data-settings-section-form="temperature"] [name="escalation_minutes"]', '45');
    await page.click('[data-settings-section-form="inventory"] button[type="submit"]');
    await page.waitForSelector('[data-settings-section-form="inventory"] .settings-form-feedback.is-success');
    assert.equal(await page.inputValue('[data-settings-section-form="temperature"] [name="escalation_minutes"]'), '45');
  } finally { await close(); }
});

test('a background refresh does not overwrite unsaved edits', { skip }, async () => {
  const { page, record, close } = await openSettings();
  try {
    await tab(page, 'general');
    await page.fill('[data-settings-section-form="venue"] [name="city"]', 'Reykjavík');
    const before = requestsTo(record, 'atlas-settings', 'snapshot').length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(400);
    assert.equal(requestsTo(record, 'atlas-settings', 'snapshot').length, before, 'no silent reload while a form is dirty');
    assert.equal(await page.inputValue('[data-settings-section-form="venue"] [name="city"]'), 'Reykjavík');
  } finally { await close(); }
});

test('business hours render seven days when none are saved and save as HH:MM', { skip }, async () => {
  const { page, backend, close } = await openSettings();
  try {
    await tab(page, 'general');
    assert.equal(await page.$$eval('.settings-hours-row', (rows) => rows.length), 7);
    await page.check('.settings-hours-row[data-weekday="5"] [name="is_open"]');
    await page.fill('.settings-hours-row[data-weekday="5"] [name="open_time"]', '16:00');
    await page.fill('.settings-hours-row[data-weekday="5"] [name="close_time"]', '01:00');
    await page.check('.settings-hours-row[data-weekday="5"] [name="close_next_day"]');
    await page.click('[data-settings-hours-form] button[type="submit"]');
    await page.waitForSelector('[data-settings-hours-form] .settings-form-feedback.is-success');
    const saved = backend.calls.find((entry) => entry.action === 'save-hours').body.hours;
    assert.equal(saved.length, 7);
    assert.deepEqual(saved[5], {
      weekday: 5, day_label: 'Friday', is_open: true, open_time: '16:00', close_time: '01:00', close_next_day: true,
      kitchen_close_time: null, kitchen_close_next_day: false, last_order_time: null, last_order_next_day: false
    });
    // Saved rows come back as HH:MM:SS; saving again must still send HH:MM.
    await page.click('[data-settings-hours-form] button[type="submit"]');
    await page.waitForTimeout(300);
    const second = backend.calls.filter((entry) => entry.action === 'save-hours').at(-1).body.hours[5];
    assert.equal(second.open_time, '16:00');
  } finally { await close(); }
});

test('an open day without times is caught before any request', { skip }, async () => {
  const { page, backend, close } = await openSettings();
  try {
    await tab(page, 'general');
    await page.check('.settings-hours-row[data-weekday="1"] [name="is_open"]');
    await page.click('[data-settings-hours-form] button[type="submit"]');
    await page.waitForSelector('[data-settings-hours-form] .settings-form-feedback.is-error');
    assert.match(await page.textContent('[data-settings-hours-form] .settings-form-feedback'), /Monday is marked open/);
    assert.equal(backend.calls.filter((entry) => entry.action === 'save-hours').length, 0);
  } finally { await close(); }
});

test('Security shows enforced protections only and has no dead toggles', { skip }, async () => {
  const { page, close } = await openSettings();
  try {
    await tab(page, 'security');
    assert.equal(await page.$$eval('.settings-security input, .settings-security form', (nodes) => nodes.length), 0);
    const text = await page.textContent('.settings-security');
    assert.match(text, /Two-factor authentication/);
    assert.match(text, /Not enforced yet/);
  } finally { await close(); }
});

test('preferences save only implemented values and apply them at the next sign-in', { skip }, async () => {
  const { page, backend, close } = await openSettings();
  try {
    await tab(page, 'preferences');
    const selects = await page.$$eval('[data-settings-preferences-form] select', (nodes) => nodes.map((node) => node.name));
    assert.deepEqual(selects, ['start_view'], 'theme, density, language and timezone are not offered as working controls');
    await page.selectOption('[data-settings-preferences-form] [name="start_view"]', 'shifts');
    await page.click('[data-settings-preferences-form] label:has([name="reduce_motion"]) strong');
    await page.click('[data-settings-preferences-form] button[type="submit"]');
    await page.waitForSelector('[data-settings-preferences-form] .settings-form-feedback.is-success');
    const body = backend.calls.find((entry) => entry.action === 'save-preferences').body;
    assert.equal(body.start_view, 'shifts');
    assert.equal(body.reduce_motion, true);
    assert.equal(body.browser_notifications, false, 'mirrors the real device state');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('atlas-reduce-motion')), true);

    // S88: the address bar now follows the open view (#settings), and a #view
    // link wins over the start view, so the next sign-in opens the bare app URL.
    assert.match(page.url(), /#settings$/);
    await page.goto(page.url().split('#')[0], { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true');
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'shifts');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('atlas-reduce-motion')), true);
  } finally { await close(); }
});

test('a #view link opens that destination at sign-in', { skip }, async () => {
  // S88 route table: Messages (internal view 'team') opens at #messages.
  const { page, close } = await launchAtlas({ hash: '#messages', fixtures: { functions: emptyFunctions() } });
  try {
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'team');
  } finally { await close(); }
});

// Simulated browser push stack. `mode` controls the permission result.
function pushStub(mode) {
  return `(() => {
    let subscription = null;
    const make = () => ({ endpoint: 'https://push.example.test/device-1', toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; }, async unsubscribe() { subscription = null; window.__unsubscribed = (window.__unsubscribed || 0) + 1; return true; } });
    const pushManager = { async getSubscription() { return subscription; }, async subscribe() { subscription = make(); return subscription; } };
    window.PushManager = function PushManager() {};
    window.Notification = { permission: 'default', async requestPermission() { this.permission = '${mode}'; return '${mode}'; } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { async register() { return { pushManager }; } } });
  })();`;
}

async function openNotifications(notifications, mode = 'granted') {
  const app = await openSettings({ initScript: pushStub(mode), functions: { 'atlas-notifications': notifications } });
  await tab(app.page, 'notifications');
  await app.page.waitForTimeout(300);
  return app;
}

test('ON is shown only after the server stores the subscription', { skip }, async () => {
  let stored = false;
  const { page, record, close } = await openNotifications((entry) => {
    if (entry.action === 'configuration') return { public_key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', delivery_enabled: false, enabled: stored, subscription_count: stored ? 1 : 0 };
    if (entry.action === 'subscribe') { stored = true; return { status: 'enabled' }; }
    return {};
  });
  try {
    assert.match(await page.textContent('.settings-device-notifications'), /Off/);
    await page.click('[data-settings-push-enable]');
    await page.waitForSelector('[data-settings-push-disable]');
    const text = await page.textContent('.settings-device-notifications');
    assert.match(text, /This device is subscribed/);
    assert.match(text, /not switched on alert delivery yet/, 'server delivery gate is surfaced');
    assert.equal(requestsTo(record, 'atlas-notifications', 'subscribe').length, 1);
    await page.click('[data-settings-push-disable]');
    await page.waitForSelector('[data-settings-push-enable]');
    assert.equal(requestsTo(record, 'atlas-notifications', 'unsubscribe').length, 1);
  } finally { await close(); }
});

test('a failed server subscribe leaves the device unsubscribed and says so', { skip }, async () => {
  const { page, close } = await openNotifications((entry) => {
    if (entry.action === 'configuration') return { public_key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', delivery_enabled: true, enabled: false };
    if (entry.action === 'subscribe') return { __status: 500, body: { error: 'The private notification store is unavailable.' } };
    return {};
  });
  try {
    await page.click('[data-settings-push-enable]');
    await page.waitForSelector('[data-settings-notifications-feedback], .settings-device-notifications .settings-form-feedback.is-error');
    assert.equal(await page.evaluate(() => window.__unsubscribed), 1, 'orphaned device subscription removed');
    assert.equal(await page.$('[data-settings-push-disable]'), null, 'never shows ON');
    assert.match(await page.textContent('.settings-device-notifications'), /notification store is unavailable/);
  } finally { await close(); }
});

test('a server without a push key reports "Not set up" and offers no switch', { skip }, async () => {
  const { page, close } = await openNotifications((entry) => (entry.action === 'configuration' ? { public_key: null, delivery_enabled: false, enabled: false } : {}));
  try {
    assert.match(await page.textContent('.settings-device-notifications'), /Not set up/);
    assert.equal(await page.$('[data-settings-push-enable]'), null);
  } finally { await close(); }
});

test('blocked permission is reported as blocked, not as off', { skip }, async () => {
  const { page, close } = await openNotifications((entry) => (entry.action === 'configuration' ? { public_key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', enabled: false } : {}), 'denied');
  try {
    await page.click('[data-settings-push-enable]');
    await page.waitForTimeout(300);
    assert.match(await page.textContent('.settings-device-notifications'), /Blocked/);
  } finally { await close(); }
});

test('integrations without a connection flow say so and list what they need', { skip }, async () => {
  const integrations = [{ provider_key: 'instagram', label: 'Instagram', category: 'social', status: 'not_connected', authorization_state: 'not_connected', requirements: { oauth: true, meta_app_review: true, professional_account: true } }];
  const backend = settingsBackend();
  backend.workspace.integrations = integrations;
  const app = await launchAtlas({ fixtures: { functions: { ...emptyFunctions(), 'atlas-settings': backend.handler } } });
  try {
    await openView(app.page, 'settings');
    await app.page.waitForSelector('.settings-shell .settings-tabs');
    await tab(app.page, 'integrations');
    const card = await app.page.textContent('.settings-integration-card');
    assert.match(card, /Not available yet/);
    assert.match(card, /no connection flow for Instagram/);
    assert.match(card, /Meta app review/);
    assert.equal(await app.page.$$eval('.settings-integration-card button, .settings-integration-card a', (nodes) => nodes.length), 0, 'no Connect button without a real flow');
  } finally { await app.close(); }
});
