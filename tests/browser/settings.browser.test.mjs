// Settings (S88 Team A: section nav, per-form save bars, Atlas AI settings,
// integrations) + Notifications, exercised in Chromium against the real
// settings-workspace.js / notifications.js with mocked backends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, openView, ORIGIN, requestsTo, settle, until, USERS } from './harness.mjs';
import { emptyFunctions, settingsBackend } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function openSettings(options = {}) {
  const backend = settingsBackend(options);
  const app = await launchAtlas({ ...options, fixtures: { ...(options.profiles ? { profiles: options.profiles } : {}), functions: { ...emptyFunctions(), 'atlas-settings': backend.handler, ...(options.functions || {}) } } });
  await openView(app.page, 'settings');
  await app.page.waitForSelector('.settings-layout [data-settings-content]');
  return { ...app, backend };
}

async function section(page, key) {
  await page.evaluate((hash) => window.AtlasShell.navigate(hash), `#settings/${key}`);
  await page.waitForSelector(`.settings-nav__link[href="#settings/${key}"][aria-current="page"]`);
  await settle(page);
}

test('Settings lists its sections in a nav and opens each by route', { skip }, async () => {
  const { page, record, close } = await openSettings();
  try {
    const links = await page.$$eval('.settings-nav__link', (nodes) => nodes.map((node) => node.getAttribute('href')));
    for (const key of ['venue', 'hours', 'team-access', 'notifications', 'rules', 'integrations', 'security', 'system', 'preferences', 'activity']) {
      assert.ok(links.includes(`#settings/${key}`), `${key} is listed`);
    }
    await section(page, 'security');
    assert.match(await page.textContent('#settings-section-title'), /Security/);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('the save bar appears only after a change, and Discard restores the saved value', { skip }, async () => {
  const { page, backend, close } = await openSettings();
  try {
    await section(page, 'rules');
    const bar = '[data-settings-section-form="inventory"] [data-settings-savebar]';
    assert.equal(await page.$eval(bar, (node) => node.hidden), true, 'no save bar before a change');
    await page.fill('[data-settings-section-form="inventory"] [name="variance_tolerance_percent"]', '7');
    assert.equal(await page.$eval(bar, (node) => node.hidden), false);
    assert.match(await page.textContent(bar), /Unsaved changes/);
    await page.click(`${bar} [data-settings-discard]`);
    await settle(page);
    assert.equal(await page.inputValue('[data-settings-section-form="inventory"] [name="variance_tolerance_percent"]'), '5');
    assert.equal(backend.calls.filter((entry) => entry.method === 'POST').length, 0);
  } finally { await close(); }
});

test('saving one Settings form never relabels or disables another form', { skip }, async () => {
  const { page, close } = await openSettings({ delayMs: 900 });
  try {
    await section(page, 'rules');
    await page.fill('[data-settings-section-form="inventory"] [name="variance_tolerance_percent"]', '6');
    await page.click('[data-settings-section-form="inventory"] button[type="submit"]');
    // Inspect while the (900 ms) save is still in flight.
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-settings-section-form="inventory"] button[type="submit"]');
      return button && (button.disabled || /Saving/.test(button.textContent));
    });
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
    await section(page, 'rules');
    await page.fill('[data-settings-section-form="temperature"] [name="escalation_minutes"]', '45');
    await page.fill('[data-settings-section-form="inventory"] [name="variance_tolerance_percent"]', '6');
    await page.click('[data-settings-section-form="inventory"] button[type="submit"]');
    await page.waitForSelector('[data-settings-section-form="inventory"] .settings-form-feedback.is-success');
    assert.equal(await page.inputValue('[data-settings-section-form="temperature"] [name="escalation_minutes"]'), '45');
    assert.equal(await page.$eval('[data-settings-section-form="temperature"] [data-settings-savebar]', (node) => node.hidden), false, 'still marked unsaved');
  } finally { await close(); }
});

test('a background refresh does not overwrite unsaved edits', { skip }, async () => {
  const { page, record, close } = await openSettings();
  try {
    await section(page, 'venue');
    await page.fill('[data-settings-section-form="venue"] [name="city"]', 'Reykjavík');
    const before = requestsTo(record, 'atlas-settings', 'snapshot').length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await settle(page);
    assert.equal(requestsTo(record, 'atlas-settings', 'snapshot').length, before, 'no silent reload while a form is dirty');
    assert.equal(await page.inputValue('[data-settings-section-form="venue"] [name="city"]'), 'Reykjavík');
  } finally { await close(); }
});

test('business hours render seven days when none are saved and save as HH:MM', { skip }, async () => {
  const { page, backend, close } = await openSettings();
  try {
    await section(page, 'hours');
    assert.equal(await page.$$eval('.settings-hours-row', (rows) => rows.length), 7);
    assert.match(await page.textContent('[data-settings-hours-form]'), /No opening hours are saved yet/);
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
    await page.fill('.settings-hours-row[data-weekday="5"] [name="close_time"]', '02:00');
    await page.click('[data-settings-hours-form] button[type="submit"]');
    await until(() => backend.calls.filter((entry) => entry.action === 'save-hours').length >= 2, { message: 'the second save-hours' });
    const second = backend.calls.filter((entry) => entry.action === 'save-hours').at(-1).body.hours[5];
    assert.equal(second.open_time, '16:00');
    assert.equal(second.close_time, '02:00');
  } finally { await close(); }
});

test('an open day without times is caught before any request', { skip }, async () => {
  const { page, backend, close } = await openSettings();
  try {
    await section(page, 'hours');
    await page.check('.settings-hours-row[data-weekday="1"] [name="is_open"]');
    await page.click('[data-settings-hours-form] button[type="submit"]');
    await page.waitForSelector('[data-settings-hours-form] .settings-form-feedback.is-error');
    assert.match(await page.textContent('[data-settings-hours-form] .settings-form-feedback'), /Monday is marked open/);
    assert.equal(backend.calls.filter((entry) => entry.action === 'save-hours').length, 0);
  } finally { await close(); }
});

test('a time zone the server rejects is explained under the field', { skip }, async () => {
  const backend = settingsBackend();
  const handler = async (entry) => {
    if (entry.method === 'POST' && entry.action === 'save-section' && entry.body.section_key === 'venue' && entry.body.value.timezone === 'Mars/Olympus') {
      return { __status: 400, body: { error: 'Unknown time zone Mars/Olympus' } };
    }
    return backend.handler(entry);
  };
  const app = await launchAtlas({ fixtures: { functions: { ...emptyFunctions(), 'atlas-settings': handler } } });
  try {
    await openView(app.page, 'settings');
    await section(app.page, 'hours');
    await app.page.fill('[data-settings-timezone-form] [name="timezone"]', 'Mars/Olympus');
    await app.page.click('[data-settings-timezone-form] button[type="submit"]');
    await app.page.waitForSelector('#settings-timezone-error');
    const text = await app.page.textContent('#settings-timezone-error');
    assert.match(text, /“Mars\/Olympus” isn’t a time zone Atlas recognises/);
    assert.doesNotMatch(await app.page.textContent('[data-settings-timezone-form]'), /Unknown time zone/, 'server text is never shown');
    assert.equal(await app.page.getAttribute('[data-settings-timezone-form] [name="timezone"]', 'aria-invalid'), 'true');
  } finally { await app.close(); }
});

test('Security shows enforced protections only and has no dead toggles', { skip }, async () => {
  const { page, close } = await openSettings();
  try {
    await section(page, 'security');
    assert.equal(await page.$$eval('.settings-security input, .settings-security form', (nodes) => nodes.length), 0);
    const text = await page.textContent('.settings-security');
    assert.match(text, /Two-factor authentication/);
    assert.match(text, /Not enforced yet/);
  } finally { await close(); }
});

test('preferences save only implemented values and apply them at the next sign-in', { skip }, async () => {
  const { page, backend, close } = await openSettings();
  try {
    await section(page, 'preferences');
    const selects = await page.$$eval('[data-settings-preferences-form] select', (nodes) => nodes.map((node) => node.name));
    assert.deepEqual(selects, ['start_view'], 'theme, density, language and timezone are not offered as working controls');
    assert.equal(await page.$('[data-settings-preferences-form] option[value="brain"]'), null, 'the retired Brain page is not a start page');
    await page.selectOption('[data-settings-preferences-form] [name="start_view"]', 'shifts');
    await page.check('[data-settings-preferences-form] [name="reduce_motion"]');
    await page.click('[data-settings-preferences-form] button[type="submit"]');
    await page.waitForSelector('[data-settings-preferences-form] .settings-form-feedback.is-success');
    const body = backend.calls.find((entry) => entry.action === 'save-preferences').body;
    assert.equal(body.start_view, 'shifts');
    assert.equal(body.reduce_motion, true);
    assert.equal(body.browser_notifications, false, 'mirrors the real device state');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('atlas-reduce-motion')), true);

    // The address bar follows the open section, and a #view link wins over the
    // start view, so the next sign-in opens the bare app URL.
    assert.match(page.url(), /#settings\/preferences$/);
    await page.goto(page.url().split('#')[0], { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true');
    await page.waitForFunction(() => document.body.dataset.atlasView === 'shifts');
    await settle(page);
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'shifts');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('atlas-reduce-motion')), true);
  } finally { await close(); }
});

test('a bartender sees only personal sections, and a manager-only link opens their first section', { skip }, async () => {
  const { page, close } = await openSettings({ user: USERS.bartender });
  try {
    const links = await page.$$eval('.settings-nav__link', (nodes) => nodes.map((node) => node.getAttribute('href')));
    for (const key of ['team-access', 'rules', 'integrations', 'system', 'security']) {
      assert.ok(!links.includes(`#settings/${key}`), `${key} is not offered to a bartender`);
    }
    await navigateTo(page, '#settings/system');
    assert.equal(await page.$('[data-settings-system-host]'), null, 'System health stays with administrators');
  } finally { await close(); }
});

test('a #view link opens that destination at sign-in', { skip }, async () => {
  // S88 route table: Messages (internal view 'team') opens at #messages.
  const { page, close } = await launchAtlas({ hash: '#messages', fixtures: { functions: emptyFunctions() } });
  try {
    assert.equal(await page.evaluate(() => document.body.dataset.atlasView), 'team');
  } finally { await close(); }
});

// ---------- Atlas AI settings (GET/POST atlas-ai?action=settings) ----------

function aiBackend({ canEdit = true } = {}) {
  const calls = [];
  const settings = { enabled: true, media_retention_days: 30, audio_retention: 'delete_after_transcription', daily_turn_limit_per_user: 200, voice_sessions_per_day: 20, voice_minutes_per_day: 60, max_concurrent_voice_sessions: 1, upload_bytes_per_day: 262144000, upload_files_per_day: 100, updated_at: '2026-09-20T10:00:00Z', can_edit: canEdit, configured: true };
  const handler = (entry) => {
    calls.push(entry);
    if (entry.action === 'settings' && entry.method === 'POST') { Object.assign(settings, entry.body.patch); return settings; }
    if (entry.action === 'settings') return settings;
    if (entry.action === 'preferences') return { reply_length: 'normal', speak_answers: false, voice_enabled: true, language: 'auto', stored: false };
    return {};
  };
  return { handler, calls, settings };
}

test('Atlas AI settings render from the server response and save only the changed field', { skip }, async () => {
  const ai = aiBackend();
  const { page, close } = await openSettings({ functions: { 'atlas-ai': ai.handler } });
  try {
    await section(page, 'ai');
    await page.waitForSelector('[data-settings-ai-form]');
    for (const name of ['voice_sessions_per_day', 'voice_minutes_per_day', 'max_concurrent_voice_sessions', 'upload_files_per_day', 'upload_bytes_per_day']) {
      assert.ok(await page.$(`[data-settings-ai-form] [name="${name}"]`), `${name} is shown`);
    }
    assert.equal(await page.inputValue('[data-settings-ai-form] [name="upload_bytes_per_day"]'), '250', 'bytes are shown as MB');
    await page.fill('[data-settings-ai-form] [name="voice_minutes_per_day"]', '90');
    await page.click('[data-settings-ai-form] button[type="submit"]');
    await page.waitForSelector('[data-settings-ai-form] .settings-form-feedback.is-success');
    const post = ai.calls.find((entry) => entry.method === 'POST' && entry.action === 'settings');
    assert.deepEqual(post.body, { patch: { voice_minutes_per_day: 90 } });
  } finally { await close(); }
});

test('Atlas AI settings hide fields the server does not send and are read-only without can_edit', { skip }, async () => {
  const ai = aiBackend({ canEdit: false });
  delete ai.settings.voice_sessions_per_day;
  const { page, close } = await openSettings({ functions: { 'atlas-ai': ai.handler } });
  try {
    await section(page, 'ai');
    await page.waitForSelector('[data-settings-ai-form]');
    assert.equal(await page.$('[data-settings-ai-form] [name="voice_sessions_per_day"]'), null);
    assert.equal(await page.$eval('[data-settings-ai-form] [name="voice_minutes_per_day"]', (node) => node.disabled), true);
    assert.equal(await page.$('[data-settings-ai-form] [data-settings-savebar]'), null);
  } finally { await close(); }
});

// ---------- Notifications ----------

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
  await section(app.page, 'notifications');
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
    await page.waitForSelector('.settings-device-notifications .settings-form-feedback.is-error');
    assert.equal(await page.evaluate(() => window.__unsubscribed), 1, 'orphaned device subscription removed');
    assert.equal(await page.$('[data-settings-push-disable]'), null, 'never shows ON');
  } finally { await close(); }
});

test('a server without a push key reports "Not set up" and offers no switch', { skip }, async () => {
  const { page, close } = await openNotifications((entry) => (entry.action === 'configuration' ? { public_key: null, delivery_enabled: false, enabled: false } : {}));
  try {
    // The device status is checked asynchronously ("Not checked yet" first).
    await page.waitForFunction(() => !/Not checked yet/.test(document.querySelector('.settings-device-notifications')?.textContent || ''));
    assert.match(await page.textContent('.settings-device-notifications'), /Not set up/);
    assert.equal(await page.$('[data-settings-push-enable]'), null);
  } finally { await close(); }
});

test('blocked permission is reported as blocked, not as off', { skip }, async () => {
  const { page, close } = await openNotifications((entry) => (entry.action === 'configuration' ? { public_key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', enabled: false } : {}), 'denied');
  try {
    await page.click('[data-settings-push-enable]');
    await page.waitForFunction(() => /Blocked/.test(document.querySelector('.settings-device-notifications')?.textContent || ''));
    assert.match(await page.textContent('.settings-device-notifications'), /Blocked/);
  } finally { await close(); }
});

// ---------- Integrations (atlas-integrations, S88 contract) ----------

const PROVIDERS = [
  { provider_key: 'instagram', label: 'Instagram', auth_kind: 'oauth2', connection_state: 'ready', configured: true, can_connect: true, can_save_api_key: false, can_test: false, can_disconnect: false },
  { provider_key: 'tiktok', label: 'TikTok', auth_kind: 'oauth2', connection_state: 'not_configured', configured: false, can_connect: false, can_test: false, can_disconnect: false, available_message: 'Not set up yet.', enables: 'Shows your TikTok account in Atlas.', missing_requirements: ['the integration encryption key', 'a TikTok for Developers client key'] }
];
// What atlas-integrations adds for an administrator only (S91): secret names,
// never values.
const ADMIN_SETUP = { tiktok: { summary: 'TikTok for Developers app with Login Kit, approved app review, registered redirect URI.', requirements: [{ name: 'ATLAS_INTEGRATION_KEK_V1', label: 'the integration encryption key' }, { name: 'ATLAS_TIKTOK_CLIENT_KEY', label: 'a TikTok for Developers client key' }] } };

const MANAGER = { id: '7d3c1f10-0000-4000-8000-000000000004', email: 'mgr@example.test', display_name: 'Þórdís Ævarsdóttir', role: 'manager', active: true };

function integrationsBackend(start, { role = 'admin' } = {}) {
  const calls = [];
  const handler = (entry) => {
    calls.push(entry);
    if (entry.action === 'status') {
      const admin = role === 'admin';
      return { providers: PROVIDERS.map((provider) => ({ ...provider, setup_details: admin ? ADMIN_SETUP[provider.provider_key] ?? null : null })), policy: {}, staff: { role } };
    }
    if (entry.action === 'start') return start(entry);
    return { __status: 409, body: { error: 'raw server text', error_code: 'not_configured' } };
  };
  return { handler, calls };
}

test('integrations that cannot connect say "Not set up yet" and what they enable; setup details are for administrators', { skip }, async () => {
  const integrations = integrationsBackend(() => ({}));
  const { page, close } = await openSettings({ user: USERS.admin, functions: { 'atlas-integrations': integrations.handler } });
  try {
    await section(page, 'integrations');
    await page.waitForSelector('[data-provider-card="tiktok"]');
    const card = await page.textContent('[data-provider-card="tiktok"]');
    assert.match(card, /Not set up yet/);
    assert.match(card, /Shows your TikTok account in Atlas\./);
    assert.doesNotMatch(card, /Not available yet — requires/);
    // The technical list is behind a closed "Setup details" disclosure.
    const details = page.locator('[data-provider-card="tiktok"] [data-provider-setup]');
    assert.equal(await details.count(), 1);
    assert.equal(await details.evaluate((node) => node.open), false, 'closed until the administrator opens it');
    assert.equal(await page.textContent('[data-provider-card="tiktok"] [data-provider-setup] summary'), 'Setup details');
    await page.click('[data-provider-card="tiktok"] [data-provider-setup] summary');
    const setup = await details.textContent();
    assert.match(setup, /ATLAS_TIKTOK_CLIENT_KEY/);
    assert.match(setup, /Their values are never shown here/);
    assert.equal(await page.$$eval('[data-provider-card="tiktok"] button', (nodes) => nodes.length), 0, 'no Connect button without a real flow');
  } finally { await close(); }
});

test('a manager sees owner copy only: no setup details and no secret names', { skip }, async () => {
  const integrations = integrationsBackend(() => ({}), { role: 'manager' });
  const { page, close } = await openSettings({ user: MANAGER, profiles: [USERS.admin, USERS.bartender, MANAGER], functions: { 'atlas-integrations': integrations.handler } });
  try {
    await section(page, 'integrations');
    await page.waitForSelector('[data-provider-card="tiktok"]');
    const card = await page.textContent('[data-provider-card="tiktok"]');
    assert.match(card, /Not set up yet/);
    assert.match(card, /Shows your TikTok account in Atlas\./);
    assert.equal(await page.locator('[data-provider-setup]').count(), 0);
    assert.doesNotMatch(await page.textContent('#settings-view, .settings-layout'), /ATLAS_|encryption key|function secret|requires/);
  } finally { await close(); }
});

test('when the integrations service itself is missing the page says "Not set up yet" in owner words', { skip }, async () => {
  const missing = () => ({ __status: 503, body: { error: 'Integrations are not set up yet.', error_code: 'not_configured' } });
  const { page, close } = await openSettings({ functions: { 'atlas-integrations': missing } });
  try {
    await section(page, 'integrations');
    await page.waitForSelector('.settings-layout .atlas-empty');
    const text = await page.textContent('.settings-layout [data-settings-content]');
    assert.match(text, /Not set up yet/);
    assert.match(text, /An administrator can set them up\./);
    assert.doesNotMatch(text, /Not available yet|connection service|server|ATLAS_/);
  } finally { await close(); }
});

test('Connect goes to the provider authorize_url exactly and the callback is handled once', { skip }, async () => {
  const authorize = `${ORIGIN}/index.html?integration=instagram&result=connected#settings/integrations`;
  const integrations = integrationsBackend(() => ({ authorize_url: authorize, expires_at: '2026-09-24T16:42:00Z' }));
  const { page, close } = await openSettings({ functions: { 'atlas-integrations': integrations.handler } });
  try {
    await section(page, 'integrations');
    await page.waitForSelector('[data-provider-card="instagram"] [data-integration-action="start"]');
    const navigation = page.waitForNavigation({ url: (url) => url.search.includes('integration=instagram') });
    await page.click('[data-provider-card="instagram"] [data-integration-action="start"]');
    await navigation;
    const start = integrations.calls.find((entry) => entry.action === 'start');
    assert.equal(start.method, 'POST');
    assert.equal(start.body.provider_key, 'instagram');
    assert.equal(start.body.return_path, '#settings/integrations');
    await page.waitForFunction(() => document.body.dataset.atlasReady === 'true');
    await page.waitForSelector('[data-integration-notice]');
    assert.match(await page.textContent('[data-integration-notice]'), /Instagram is connected/);
    assert.equal(new URL(page.url()).search, '', 'the callback parameters are removed from the address bar');
    assert.match(page.url(), /#settings\/integrations$/);
  } finally { await close(); }
});

test('a failed callback shows the friendly reason for its error code, never server text', { skip }, async () => {
  const integrations = integrationsBackend(() => ({}));
  const backend = settingsBackend();
  const app = await launchAtlas({
    hash: '?integration=instagram&result=failed&reason=browser_mismatch#settings/integrations',
    fixtures: { functions: { ...emptyFunctions(), 'atlas-settings': backend.handler, 'atlas-integrations': integrations.handler } }
  });
  try {
    await app.page.waitForSelector('[data-integration-notice]');
    assert.match(await app.page.textContent('[data-integration-notice]'), /started in another browser/);
    assert.equal(new URL(app.page.url()).search, '');
  } finally { await app.close(); }
});

test('a refused Connect explains the error code on the card', { skip }, async () => {
  const integrations = integrationsBackend(() => ({ __status: 409, body: { error: 'raw server text', error_code: 'not_configured' } }));
  const { page, close } = await openSettings({ functions: { 'atlas-integrations': integrations.handler } });
  try {
    await section(page, 'integrations');
    await page.waitForSelector('[data-provider-card="instagram"] [data-integration-action="start"]');
    await page.click('[data-provider-card="instagram"] [data-integration-action="start"]');
    await page.waitForSelector('[data-provider-card="instagram"] .settings-form-feedback.is-error');
    const text = await page.textContent('[data-provider-card="instagram"]');
    assert.match(text, /Instagram isn’t set up yet\. An administrator can set it up\./);
    assert.doesNotMatch(text, /raw server text/);
  } finally { await close(); }
});
