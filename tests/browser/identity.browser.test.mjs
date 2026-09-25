// S87 identity rule in the running shell: a signed-in person is their profile
// display name; without one Atlas says "Team member" and greets without a name.
// The email address, or a name guessed from it, is never shown.
// Also: Atlas API failures read as fixed copy, never the server's text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, USERS } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const NAMELESS = { ...USERS.bartender, display_name: null };

async function openAccountMenu(page) {
  await page.click('#atlas-account-btn');
  await page.waitForSelector('#atlas-account-menu', { state: 'visible' });
  return page.evaluate(() => document.querySelector('.atlas-account-menu__head').innerText.replace(/\s+/g, ' ').trim());
}

test('a profile without a display name never shows the email or a name made from it', { skip }, async () => {
  const { page, record, close } = await launchAtlas({ user: NAMELESS, fixtures: { profiles: [USERS.admin, NAMELESS], functions: emptyFunctions() } });
  try {
    assert.equal(await page.textContent('#profile-name'), 'Team member');
    assert.equal(await page.evaluate(() => window.atlasGreetingName), '');
    const head = await openAccountMenu(page);
    assert.match(head, /Team member/);
    const visible = await page.evaluate(() => document.body.innerText);
    for (const leak of [/sara\.bartender@example\.test/i, /sara\.bartender/i, /Sara Bartender/, /@example\.test/]) {
      assert.doesNotMatch(visible, leak, `the page shows ${leak}`);
    }
    assert.doesNotMatch(await page.evaluate(() => document.body.innerHTML), /sara\.bartender@example\.test/, 'not even hidden in the markup');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('a profile with a display name is shown by that name only', { skip }, async () => {
  const { page, close } = await launchAtlas({ user: USERS.bartender, fixtures: { functions: emptyFunctions() } });
  try {
    assert.equal(await page.textContent('#profile-name'), 'Sara Jónsdóttir');
    assert.equal(await page.evaluate(() => window.atlasGreetingName), 'Sara');
    const head = await openAccountMenu(page);
    assert.match(head, /Sara Jónsdóttir/);
    assert.doesNotMatch(head, /@/);
  } finally { await close(); }
});

test('AtlasIdentity and AtlasApi: fixed copy by status and code, never server text', { skip }, async () => {
  const functions = {
    ...emptyFunctions(),
    'atlas-notifications': () => ({ __status: 400, body: { error: 'column push_subscriptions.p256dh does not exist', code: '42703' } }),
    'atlas-team-profile-photos': () => ({ __status: 500, body: { error: 'relation "atlas_private.profile_photos" does not exist' } }),
    'atlas-knowledge': () => ({ __status: 401, body: { error: 'JWT expired' } }),
  };
  const { page, close } = await launchAtlas({ user: USERS.admin, fixtures: { functions } });
  try {
    const result = await page.evaluate(async () => {
      const cfg = window.VABAR_CONFIG;
      const failures = [];
      for (const [url, action] of [[cfg.NOTIFICATIONS_API, 'configuration'], [cfg.TEAM_PROFILE_PHOTOS_API, 'snapshot']]) {
        try { await window.AtlasApi.request(url, { params: { action } }); failures.push('resolved'); } catch (error) {
          failures.push({ kind: error.kind, status: error.status, message: error.message });
        }
      }
      let authEvent = false;
      window.addEventListener('atlas:auth-required', () => { authEvent = true; }, { once: true });
      const expired = await window.AtlasApi.request(cfg.KNOWLEDGE_API, { params: { action: 'snapshot' } }).catch((error) => [error.kind, error.message]);
      const unconfigured = await window.AtlasApi.request('', {}).catch((error) => error.kind);
      return {
        failures,
        unconfigured,
        expired,
        labels: [
          window.AtlasIdentity.label({ display_name: null, email: 'x@example.test' }),
          window.AtlasIdentity.label({ display_name: 'a@b.test' }),
          window.AtlasIdentity.label({ display_name: '  Ada   Lovelace ' }),
        ],
        kinds: [401, 403, 404, 409, 413, 429, 400, 503, 500].map((status) => window.AtlasApi.kindFor(status, null)),
        authEvent,
      };
    });
    assert.deepEqual(result.failures, [
      { kind: 'invalid', status: 400, message: 'Atlas couldn’t accept that. Check the details and try again.' },
      { kind: 'failed', status: 500, message: 'Something went wrong. Nothing was changed. Try again.' },
    ]);
    for (const failure of result.failures) assert.doesNotMatch(failure.message, /column|relation|does not exist|atlas_private/);
    assert.equal(result.unconfigured, 'not_configured');
    assert.deepEqual(result.expired, ['auth', 'Your session has ended. Sign in again, then try again.']);
    assert.equal(result.authEvent, true, 'a 401 asks the shell to offer sign-in');
    assert.deepEqual(result.labels, ['Team member', 'Team member', 'Ada Lovelace']);
    assert.deepEqual(result.kinds, ['auth', 'forbidden', 'not_found', 'conflict', 'too_large', 'rate_limited', 'invalid', 'unavailable', 'failed']);
  } finally { await close(); }
});
