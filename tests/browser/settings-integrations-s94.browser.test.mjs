// S94B Settings › Integrations: publishing states (contract §4), Allow
// publishing, the Page / account / location picker sheet, the
// administrator-only platform review control, recent activity, and the
// manager / bartender views, at 1440 and 390. atlas-integrations is mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, openView, settle, until, USERS } from './harness.mjs';
import { emptyFunctions, settingsBackend } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const MANAGER = { id: '7d3c1f10-0000-4000-8000-000000000004', email: 'mgr@example.test', display_name: 'Þórdís Ævarsdóttir', role: 'manager', active: true };
const PHONE = { width: 390, height: 844 };

function publishing(kind, overrides = {}) {
  return {
    supported: true, permission_state: 'granted', review_state: 'unknown', resource_kind: kind, resource: null, resource_count: 0,
    ready: false, reason: null, direct_post: kind === 'tiktok_account' ? false : null, scopes_for_publishing: [],
    can_allow_publishing: false, can_choose_resource: true, can_set_review_state: false, ...overrides
  };
}

function provider(key, label, connectionState, extra = {}) {
  const connected = !['not_configured', 'ready'].includes(connectionState);
  return {
    provider_key: key, label, auth_kind: 'oauth2', connection_state: connectionState, configured: connectionState !== 'not_configured',
    can_connect: connectionState !== 'not_configured', can_save_api_key: false, can_test: connected, can_disconnect: connected,
    enables: `Lets Atlas publish approved posts to ${label}.`, account_label: connected ? 'VÁ Bar' : null,
    last_verified_at: connected ? '2026-09-24T12:00:00Z' : null, recent_events: [], setup_details: null, publishing: null, ...extra
  };
}

// Every state the card must distinguish.
function providers(role) {
  const admin = role === 'admin';
  return [
    provider('facebook', 'Facebook Page', 'connected', { publishing: publishing('facebook_page', { permission_state: 'missing', reason: 'publishing_permission_missing', can_allow_publishing: true, can_set_review_state: admin }) }),
    provider('instagram', 'Instagram', 'connected', {
      publishing: publishing('instagram_account', { reason: 'no_resource_selected', can_set_review_state: admin }),
      recent_events: [{ event_type: 'resource_listed', actor_label: 'Þórdís', created_at: '2026-09-24T11:00:00Z' }, { event_type: 'verified', actor_label: 'Þórdís', created_at: '2026-09-24T10:00:00Z' }]
    }),
    provider('tiktok', 'TikTok', 'connected', { publishing: publishing('tiktok_account', { ready: true, resource: { kind: 'tiktok_account', id: 'open-1', label: 'VÁ Bar' }, resource_count: 1, can_set_review_state: admin }) }),
    provider('google-business-profile', 'Google Business Profile', 'connected', { publishing: publishing('gbp_location', { permission_state: 'pending', review_state: 'required', reason: 'review_required', resource: { kind: 'gbp_location', id: 'accounts/1/locations/10', label: 'VÁ Bar' }, can_set_review_state: admin }) }),
    provider('google-drive', 'Google Drive', 'verification_failed', { last_error: 'Google Drive account check failed (HTTP 401)' }),
    provider('tripadvisor', 'Tripadvisor', 'needs_reauthorization', { auth_kind: 'api_key' })
  ];
}

const PAGES = [
  { resource_kind: 'instagram_account', resource_id: '17841400000000111', parent_resource_id: '111', label: '@vabar.reykjavik', selected: false, selectable: true, unavailable_reason: null, details: { page_name: 'VÁ Bar' } },
  { resource_kind: 'instagram_account', resource_id: '17841400000000222', parent_resource_id: '222', label: '@va.events', selected: false, selectable: true, unavailable_reason: null, details: { page_name: 'VÁ Events' } },
  { resource_kind: 'instagram_account', resource_id: '17841400000000333', parent_resource_id: '333', label: '@old.page', selected: false, selectable: false, unavailable_reason: 'no_create_content', details: { page_name: 'Old Page' } }
];

function integrationsBackend(role = 'admin', { resources = PAGES } = {}) {
  const calls = [];
  let list = providers(role);
  const handler = (entry) => {
    calls.push(entry);
    if (entry.action === 'status') return { providers: list, policy: {}, staff: { role } };
    if (entry.action === 'start') return { authorize_url: `https://abc.supabase.co/functions/v1/atlas-integrations/authorize/${entry.body.provider_key}?state=x`, purpose: entry.body.purpose || 'connect' };
    if (entry.action === 'list-resources') {
      const current = list.find((p) => p.provider_key === entry.body.provider_key);
      return { provider: current, resource_kind: current.publishing.resource_kind, resources, notes: { pages_without_instagram: 1 } };
    }
    if (entry.action === 'select-resource') {
      const chosen = resources.find((r) => r.resource_id === entry.body.resource_id);
      list = list.map((p) => (p.provider_key === entry.body.provider_key
        ? { ...p, publishing: { ...p.publishing, ready: true, reason: null, resource: { kind: chosen.resource_kind, id: chosen.resource_id, label: chosen.label } } }
        : p));
      return { provider: list.find((p) => p.provider_key === entry.body.provider_key), selected: { kind: chosen.resource_kind, id: chosen.resource_id, label: chosen.label } };
    }
    if (entry.action === 'set-review-state') {
      if (role !== 'admin') return { __status: 403, body: { error: 'x', error_code: 'forbidden' } };
      list = list.map((p) => (p.provider_key === entry.body.provider_key ? { ...p, publishing: { ...p.publishing, review_state: entry.body.review_state } } : p));
      return { provider: list.find((p) => p.provider_key === entry.body.provider_key) };
    }
    return { __status: 404, body: { error: 'unknown', error_code: 'not_found' } };
  };
  return { handler, calls };
}

async function openIntegrations({ user = USERS.admin, role = 'admin', viewport, backend = integrationsBackend(role), contextOptions } = {}) {
  const settings = settingsBackend({ user });
  const app = await launchAtlas({
    user, viewport, contextOptions,
    fixtures: { profiles: [USERS.admin, USERS.bartender, MANAGER], functions: { ...emptyFunctions(), 'atlas-settings': settings.handler, 'atlas-integrations': backend.handler } }
  });
  try {
    await openView(app.page, 'settings');
    // On a phone Settings opens on its section list (the content is hidden).
    await app.page.waitForSelector('.settings-layout [data-settings-content]', { state: 'attached' });
    await app.page.evaluate(() => window.AtlasShell.navigate('#settings/integrations'));
    await app.page.waitForSelector('[data-provider-card="facebook"]');
    await settle(app.page);
  } catch (error) {
    await app.close();
    throw error;
  }
  return { ...app, backend };
}

const card = (page, key) => page.textContent(`[data-provider-card="${key}"]`);
const pillText = (page, key) => page.textContent(`[data-provider-card="${key}"] .settings-provider__head .atlas-pill`);

test('each card shows the pill, status line and next step for its state', { skip }, async () => {
  const { page, record, close } = await openIntegrations();
  try {
    assert.equal(await pillText(page, 'facebook'), 'Publishing permission missing');
    assert.match(await card(page, 'facebook'), /posting wasn’t allowed/);
    assert.equal(await page.locator('[data-provider-card="facebook"] [data-integration-action="allow-publishing"]').count(), 1);
    assert.equal(await pillText(page, 'instagram'), 'No account chosen');
    assert.equal(await page.textContent('[data-provider-card="instagram"] [data-integration-action="choose-resource"]'), 'Choose account');
    assert.equal(await pillText(page, 'tiktok'), 'Publishing allowed');
    assert.match(await card(page, 'tiktok'), /TikTok inbox as drafts until TikTok approves Atlas/);
    assert.equal(await pillText(page, 'google-business-profile'), 'App review required');
    assert.match(await card(page, 'google-business-profile'), /post them by hand until then/);
    assert.equal(await pillText(page, 'google-drive'), 'Verification failed');
    assert.match(await card(page, 'google-drive'), /The last check failed/);
    assert.equal(await pillText(page, 'tripadvisor'), 'Needs reconnecting', 'verification failed and needs reconnecting are different pills');
    // Capability list and recent activity.
    assert.match(await page.textContent('[data-provider-card="tiktok"] .settings-provider__can'), /Posts go to VÁ Bar/);
    assert.match(await page.textContent('[data-provider-card="facebook"] .settings-provider__can'), /not allowed yet/);
    await page.click('[data-provider-card="instagram"] .settings-provider__events > summary');
    assert.match(await page.textContent('[data-provider-card="instagram"] .settings-provider__events'), /Accounts listed · Þórdís/);
    assert.match(await page.textContent('.settings-layout [data-settings-content]'), /Atlas only publishes posts someone approved/);
    assert.doesNotMatch(await page.textContent('.settings-layout [data-settings-content]'), /token|secret|ATLAS_/i);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('Allow publishing restarts consent with purpose publishing', { skip }, async () => {
  const { page, backend, close } = await openIntegrations();
  try {
    const navigation = page.waitForRequest((request) => request.url().includes('/authorize/facebook'));
    await page.route('https://abc.supabase.co/functions/v1/atlas-integrations/authorize/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>provider</p>' }));
    await page.click('[data-provider-card="facebook"] [data-integration-action="allow-publishing"]');
    await navigation;
    const start = backend.calls.find((entry) => entry.action === 'start');
    assert.equal(start.method, 'POST');
    assert.deepEqual(start.body, { provider_key: 'facebook', return_path: '#settings/integrations', purpose: 'publishing' });
  } finally { await close(); }
});

test('the picker lists the accounts without choosing one, explains the unusable one and saves the choice', { skip }, async () => {
  const { page, backend, record, close } = await openIntegrations();
  try {
    await page.click('[data-provider-card="instagram"] [data-integration-action="choose-resource"]');
    await page.waitForSelector('#settings-resource-picker [data-picker-options]');
    assert.equal(await page.textContent('#settings-resource-picker .atlas-sheet__title'), 'Choose the Instagram account');
    assert.equal(await page.locator('#settings-resource-picker input[name="settings-resource"]:checked').count(), 0, 'nothing pre-selected');
    assert.equal(await page.locator('#settings-resource-picker [data-picker-use]').isDisabled(), true);
    const disabled = page.locator('#settings-resource-picker input[value="17841400000000333"]');
    assert.equal(await disabled.isDisabled(), true);
    assert.match(await page.textContent('#settings-resource-picker'), /You can’t post for this Page/);
    assert.match(await page.textContent('#settings-resource-picker'), /Linked to the VÁ Events Page/);
    await page.check('#settings-resource-picker input[value="17841400000000222"]');
    await page.click('#settings-resource-picker [data-picker-use]');
    await until(() => backend.calls.some((entry) => entry.action === 'select-resource'));
    const select = backend.calls.find((entry) => entry.action === 'select-resource');
    assert.deepEqual(select.body, { provider_key: 'instagram', resource_kind: 'instagram_account', resource_id: '17841400000000222' });
    await page.waitForSelector('#settings-resource-picker', { state: 'detached' });
    await until(async () => (await pillText(page, 'instagram')) === 'Publishing allowed');
    assert.match(await card(page, 'instagram'), /Posts go to @va\.events on Instagram/);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('an empty list says why and offers Reconnect', { skip }, async () => {
  const backend = integrationsBackend('admin', { resources: [] });
  const { page, close } = await openIntegrations({ backend });
  try {
    await page.click('[data-provider-card="instagram"] [data-integration-action="choose-resource"]');
    await page.waitForSelector('#settings-resource-picker [data-picker-empty]');
    assert.match(await page.textContent('#settings-resource-picker'), /No Instagram account found/);
    assert.match(await page.textContent('#settings-resource-picker'), /None of your Pages has a linked Instagram professional account/);
    assert.equal(await page.locator('#settings-resource-picker [data-picker-reconnect]').count(), 1);
  } finally { await close(); }
});

test('administrators record the platform review state; managers see no control', { skip }, async () => {
  const admin = await openIntegrations();
  try {
    const control = '[data-provider-card="tiktok"] [data-integration-review]';
    assert.equal(await admin.page.locator(control).count(), 1);
    await admin.page.click(`${control} > summary`);
    await admin.page.selectOption(`${control} [data-integration-review-select]`, 'approved');
    await admin.page.click(`${control} [data-integration-review-save]`);
    await until(() => admin.backend.calls.some((entry) => entry.action === 'set-review-state'));
    const call = admin.backend.calls.find((entry) => entry.action === 'set-review-state');
    assert.deepEqual(call.body, { provider_key: 'tiktok', review_state: 'approved' });
    await admin.page.waitForSelector('[data-provider-card="tiktok"] .settings-form-feedback.is-success');
    assert.match(await admin.page.textContent(`${control} > summary`), /Approved/);
  } finally { await admin.close(); }

  const manager = await openIntegrations({ user: MANAGER, role: 'manager' });
  try {
    assert.equal(await manager.page.locator('[data-integration-review]').count(), 0, 'no review control for a manager');
    assert.equal(await manager.page.locator('[data-provider-card="instagram"] [data-integration-action="choose-resource"]').count(), 1, 'managers can choose the account');
    assert.equal(await manager.page.locator('[data-provider-card="facebook"] [data-integration-action="allow-publishing"]').count(), 1);
  } finally { await manager.close(); }
});

test('bartenders never see Integrations and no integrations request is made', { skip }, async () => {
  const backend = integrationsBackend('bartender');
  const settings = settingsBackend({ user: USERS.bartender });
  const app = await launchAtlas({ user: USERS.bartender, fixtures: { functions: { ...emptyFunctions(), 'atlas-settings': settings.handler, 'atlas-integrations': backend.handler } } });
  try {
    await openView(app.page, 'settings');
    await app.page.waitForSelector('.settings-layout [data-settings-content]', { state: 'attached' });
    await app.page.evaluate(() => window.AtlasShell.navigate('#settings/integrations'));
    await settle(app.page);
    assert.equal(await app.page.locator('[data-provider-card]').count(), 0);
    assert.equal(backend.calls.length, 0);
  } finally { await app.close(); }
});

test('phone 390: cards and the picker sheet fit without horizontal scroll', { skip }, async () => {
  const { page, close } = await openIntegrations({ viewport: PHONE, contextOptions: { hasTouch: true, isMobile: true } });
  try {
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.ok(await fits(), 'integrations list fits');
    const allow = await page.locator('[data-provider-card="facebook"] [data-integration-action="allow-publishing"]').boundingBox();
    assert.ok(allow.height >= 43, `Allow publishing is a touch target (${allow.height})`);
    await page.click('[data-provider-card="instagram"] [data-integration-action="choose-resource"]');
    await page.waitForSelector('#settings-resource-picker [data-picker-options]');
    assert.ok(await fits(), 'picker fits');
    const option = await page.locator('#settings-resource-picker .settings-picker__option').first().boundingBox();
    assert.ok(option.height >= 44, 'options are 44 px rows');
    const sheet = await page.locator('#settings-resource-picker .atlas-sheet').boundingBox();
    assert.ok(sheet.width <= PHONE.width + 1);
  } finally { await close(); }
});
