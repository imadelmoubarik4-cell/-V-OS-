// Regression (S98): the Knowledge → Training tab must enter the standalone
// registered `training` view (served by atlas-training), not keep the `knowledge`
// view active (which would call atlas-knowledge). The canonical URL stays
// `#knowledge/training`, so tab-click and direct navigation resolve identically.
// Guards against the defect where knowledge-workspace intercepted the Training tab
// with AtlasShell.show('knowledge', { section: 'training' }).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, settle, until, USERS } from './harness.mjs';
import { knowledgeBackend, peopleFunctions, NOW } from './people-fixtures.mjs';
import { trainingBackend } from './training-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

// Boot the real shell at the Knowledge library with BOTH gateways mocked, so the
// Knowledge tab bar renders (atlas-knowledge) and a Training tab click can resolve
// into the standalone training view (atlas-training).
async function openKnowledge({ user = USERS.admin } = {}) {
  const kn = knowledgeBackend({ user });
  const tr = trainingBackend({ lessons: [] });
  const fixtures = { functions: peopleFunctions({ 'atlas-knowledge': kn.handler, 'atlas-training': tr.handler }) };
  const app = await launchAtlas({ user, hash: '#knowledge', fixedTime: new Date(NOW), fixtures });
  await app.page.waitForSelector('.kn-tabs a[data-knowledge-tab="training"]', { timeout: 12000 });
  await settle(app.page);
  return { ...app, kn, tr };
}

const currentView = (page) => page.evaluate(() => window.AtlasShell?.current?.());
const currentHash = (page) => page.evaluate(() => window.location.hash);

test('clicking the Knowledge → Training tab enters the standalone training view at #knowledge/training', { skip }, async () => {
  const { page, record, close } = await openKnowledge({ user: USERS.admin });
  try {
    // Precondition: we are in the knowledge view on the library route.
    assert.equal(await currentView(page), 'knowledge', 'starts in the knowledge view');

    await page.click('.kn-tabs a[data-knowledge-tab="training"]');

    // (1)+(2) the shell leaves the knowledge view and enters the registered
    // training view; (3) the canonical URL is exactly #knowledge/training.
    await until(async () => (await currentView(page)) === 'training', { message: 'the shell switches to the training view' });
    assert.equal(await currentView(page), 'training', 'the training view is active, not knowledge');
    assert.equal(await currentHash(page), '#knowledge/training', 'the canonical URL stays #knowledge/training');
    await page.waitForSelector('[data-training-new]', { timeout: 8000 }); // the training view actually rendered

    // The training view is self-contained: no atlas-knowledge traffic was needed
    // to render it (the Knowledge snapshot loaded once for the tab bar; the tab
    // click itself must not depend on it).
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

test('tab navigation matches direct navigation to #knowledge/training', { skip }, async () => {
  // Direct navigation is the reference behavior; the tab click must match it.
  const kn = knowledgeBackend({ user: USERS.admin });
  const tr = trainingBackend({ lessons: [] });
  const fixtures = { functions: peopleFunctions({ 'atlas-knowledge': kn.handler, 'atlas-training': tr.handler }) };
  const app = await launchAtlas({ user: USERS.admin, hash: '#knowledge/training', fixedTime: new Date(NOW), fixtures });
  try {
    await app.page.waitForSelector('[data-training-new]', { timeout: 12000 });
    assert.equal(await currentView(app.page), 'training', 'direct navigation resolves to the training view');
    assert.equal(await currentHash(app.page), '#knowledge/training');
    assert.deepEqual(app.record.pageErrors, []);
  } finally { await app.close(); }
});

test('the other Knowledge tabs still resolve within the knowledge view (unchanged)', { skip }, async () => {
  const { page, record, close } = await openKnowledge({ user: USERS.admin });
  try {
    for (const [key, hash] of [
      ['required', '#knowledge/required'],
      ['sources', '#knowledge/sources'],
      ['activity', '#knowledge/activity'],
      ['library', '#knowledge'],
    ]) {
      await page.click(`.kn-tabs a[data-knowledge-tab="${key}"]`);
      await until(async () => (await currentHash(page)) === hash, { message: `route ${hash}` });
      assert.equal(await currentView(page), 'knowledge', `${key} stays in the knowledge view`);
      assert.equal(await currentHash(page), hash, `${key} routes to ${hash}`);
    }
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});
