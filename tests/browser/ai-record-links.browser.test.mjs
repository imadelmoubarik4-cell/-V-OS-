// S89 (review P2-7): Atlas AI record links open the record, not only the page.
// Each route is the Tool Gateway's own (supabase/functions/_shared/ai-tools/result.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, USERS } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';
import { inventoryWorld } from './inventory-fixtures.mjs';
import { aiFixtures, AI_FIXTURE_NOW } from './atlas-ai-fixtures.mjs';
import { teamCBackend, NOW } from './teamc-fixtures.mjs';
import { routeFor } from '../../supabase/functions/_shared/ai-tools/result.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function go(page, route) {
  await page.evaluate((target) => window.AtlasShell.navigate(target), route);
  await page.waitForTimeout(300);
}

test('a movement link shows that movement in the ledger', { skip }, async () => {
  const world = inventoryWorld();
  const { page, record, close } = await launchAtlas({ user: USERS.admin, fixtures: world.fixtures });
  try {
    const route = routeFor('movement', 'm2');
    assert.equal(route, '#inventory/movements?movement=m2');
    await go(page, route);
    await page.waitForSelector('[data-movement-id="m2"][aria-current="true"]', { state: 'attached' });
    assert.equal(await page.$$eval('[aria-current="true"][data-movement-id]', (nodes) => [...new Set(nodes.map((node) => node.dataset.movementId))].join(',')), 'm2');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('a decision link opens that decision', { skip }, async () => {
  const { fixtures } = aiFixtures();
  const { page, record, close } = await launchAtlas({ user: USERS.admin, fixtures, hash: '#ai/new', fixedTime: AI_FIXTURE_NOW });
  try {
    await go(page, routeFor('brain_recommendation', 'r-1'));
    await page.waitForSelector('.ai-sheet', { state: 'visible' });
    const detailCalls = record.requests.filter((entry) => entry.path.endsWith('/atlas-phase3-brain') && entry.action === 'detail');
    assert.ok(detailCalls.length >= 1, 'the decision detail was requested');
    assert.ok(detailCalls.some((entry) => new URLSearchParams(entry.search).get('id') === 'r-1'), 'for r-1');
  } finally { await close(); }
});

test('an integration link shows that provider', { skip }, async () => {
  const providers = [
    { provider_key: 'instagram', label: 'Instagram', auth_kind: 'oauth2', connection_state: 'ready', configured: true, can_connect: true },
    { provider_key: 'tiktok', label: 'TikTok', auth_kind: 'oauth2', connection_state: 'not_configured', configured: false, available_message: 'Not available yet.' },
  ];
  const functions = {
    ...emptyFunctions(),
    'atlas-integrations': (entry) => (entry.action === 'status' ? { providers, policy: {}, staff: { role: 'admin' } } : { __status: 409, body: { error_code: 'not_configured' } }),
  };
  const { page, close } = await launchAtlas({ user: USERS.admin, fixtures: { functions } });
  try {
    await go(page, routeFor('integration', 'tiktok'));
    await page.waitForSelector('[data-provider-card="tiktok"][aria-current="true"]', { state: 'attached' });
    assert.equal(await page.getAttribute('[data-provider-card="instagram"]', 'aria-current'), null);
  } finally { await close(); }
});

test('a marketing suggestion link shows that suggestion on Overview', { skip }, async () => {
  const backend = teamCBackend({ user: USERS.admin });
  const { page, close } = await launchAtlas({ user: USERS.admin, fixtures: backend.fixtures, fixedTime: Date.parse(NOW) });
  try {
    await go(page, `${routeFor('marketing')}/posts`);
    await go(page, routeFor('marketing_recommendation', 'rec1'));
    await page.waitForSelector('#marketing-view [data-mk-suggestion="rec1"][aria-current="true"]', { state: 'attached' });
    assert.equal(await page.$eval('#marketing-view .atlas-tabs [aria-current="page"]', (node) => node.textContent.trim()), 'Overview');
  } finally { await close(); }
});
