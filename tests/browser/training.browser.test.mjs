// Atlas Training (S98) in a real browser: the manager authoring flow (draft →
// video upload → publish), staff visibility and role gating, the lesson player
// (start, video, chapter seek, SOP, completion), the manager completion report,
// and version immutability at the UI level (publishing v2 supersedes v1 without
// touching v1's media, version or retained completions).
//
// Drives the frontend through its documented data-* hooks and asserts what the
// UI sent through the stateful atlas-training mock (trainingBackend `calls`) and
// what the backend now holds. Every test keeps record.pageErrors empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, navigateTo, settle, until, USERS } from './harness.mjs';
import { trainingWorld, VIDEO_WEBM } from './training-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function launch({ user = USERS.admin, lessons = [], viewport, hash = '' } = {}) {
  const world = trainingWorld({ lessons });
  const app = await launchAtlas({ user, fixtures: world.fixtures, viewport, hash });
  return { ...app, world, training: world.training, storage: world.storage };
}

// ---------- 1. manager authoring: draft, video upload, publish ----------

test('a manager authors a draft, uploads a video and publishes it', { skip }, async () => {
  const { page, record, training, storage, close } = await launch();
  try {
    await navigateTo(page, '#knowledge/training');
    await page.waitForSelector('[data-training-new]');

    // Open the authoring sheet and fill the basics.
    await page.click('[data-training-new]');
    await page.waitForSelector('[data-training-editor-form]');
    await page.fill('#tr-title', 'Pouring the perfect pint');
    await page.selectOption('#tr-category', 'cat-bar');
    await page.check('[data-training-role="bartender"]');
    await page.click('[data-training-required]'); // required toggle on
    // One chapter (0:00 + title) and one procedure step in the default rows.
    await page.fill('[data-training-chapter-row] [name="chapter_time"]', '0:00');
    await page.fill('[data-training-chapter-row] [name="chapter_title"]', 'Intro');
    await page.fill('[data-training-step-row] [name="step_label"]', 'Chill the glass');
    await page.fill('#tr-content', '# Steps\n\n1. Chill the glass\n2. Pour at 45 degrees');

    await page.click('[data-training-save-draft]');
    await until(() => training.callsFor('save-draft').length > 0, { message: 'save-draft' });
    // Saving routes to the new draft's lesson page (manager edit controls show).
    await page.waitForSelector('[data-training-edit]');

    const saved = training.callsFor('save-draft')[0];
    assert.equal(saved.body.title, 'Pouring the perfect pint');
    assert.equal(saved.body.category_id, 'cat-bar');
    assert.deepEqual(saved.body.target_roles, ['bartender']);
    assert.equal(saved.body.required, true);
    assert.equal(saved.body.chapters.length, 1);
    assert.equal(saved.body.chapters[0].start_seconds, 0);
    assert.equal(saved.body.steps.length, 1);
    const newArticleId = training.articles.keys().next().value; // the only article
    assert.ok(newArticleId, 'a draft article now exists');

    // Reopen the editor to add the video, then upload a file (the input is
    // hidden by design, so wait for it to attach rather than become visible).
    await page.click('[data-training-edit]');
    await page.waitForSelector('[data-training-upload-panel]');
    await page.waitForSelector('[data-training-file]', { state: 'attached' });
    await page.setInputFiles('[data-training-file]', { name: 'pour.webm', mimeType: 'video/webm', buffer: VIDEO_WEBM });

    // reserve → PUT to Storage → finalize → attach, then the panel reaches Ready.
    await until(() => training.callsFor('attach-media').length > 0, { message: 'attach-media' });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-training-upload-state]');
      return el && /Ready/i.test(el.textContent);
    }, null, { timeout: 10000 });

    assert.equal(training.callsFor('reserve-media').length, 1, 'reserve-media called once');
    assert.equal(training.callsFor('finalize-media').length, 1, 'finalize-media called once');
    assert.equal(training.callsFor('attach-media').length, 1, 'attach-media called once');
    assert.equal(training.callsFor('reserve-media')[0].body.mime_type, 'video/webm');
    assert.equal(training.callsFor('attach-media')[0].body.article_id, newArticleId);
    assert.ok(storage.uploads.length >= 1 && storage.uploads[0].path.includes('/object/upload/sign/atlas-training-videos/'), 'the file went to the signed Storage URL');

    // Publish from the editor (confirm dialog → publish).
    await page.click('[data-training-publish-editor]');
    await page.waitForSelector('.atlas-dialog button[type="submit"]');
    await page.click('.atlas-dialog button[type="submit"]');
    await until(() => training.callsFor('publish').length > 0, { message: 'publish' });

    assert.equal(training.callsFor('publish')[0].body.article_id, newArticleId);
    assert.equal(training.article(newArticleId).status, 'published');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- 2. staff visibility & role gating ----------

test('a bartender sees a required lesson but not manager-only or draft lessons', { skip }, async () => {
  const lessons = [
    { id: 'lesson-pour', title: 'Pouring pints', status: 'published', required: true, target_roles: ['bartender'], content: '# Pour', steps: ['Chill'] },
    { id: 'lesson-cashup', title: 'Manager cash-up', status: 'published', required: true, target_roles: ['manager'], content: '# Cash-up' },
    { id: 'lesson-wip', title: 'Work in progress', status: 'draft', target_roles: ['bartender'], content: '# WIP' }
  ];
  const { page, record, close } = await launch({ user: USERS.bartender, lessons });
  try {
    await navigateTo(page, '#knowledge/training');
    await page.waitForSelector('[data-training-section="required"]');

    assert.ok(await page.$('[data-training-section="required"] [data-training-card="lesson-pour"]'), 'the bartender lesson is Required');
    assert.equal(await page.$('[data-training-card="lesson-cashup"]'), null, 'a manager-only lesson is hidden');
    assert.equal(await page.$('[data-training-card="lesson-wip"]'), null, 'a draft-only lesson is hidden');
    assert.equal(await page.$('[data-training-new]'), null, 'staff get no New training button');
    assert.equal(await page.$('[data-training-section="manage"]'), null, 'staff get no manage section');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- 3. staff lesson player ----------

test('a bartender plays a lesson: start, video, chapter seek, SOP and completion', { skip }, async () => {
  const lessons = [
    {
      id: 'lesson-pour', title: 'Pouring pints', status: 'published', required: true, target_roles: ['bartender'],
      content: '# Written procedure\n\n1. Chill the glass\n2. Pour at 45 degrees',
      video: { upload_status: 'stored', duration_seconds: 3, original_filename: 'pour.webm' },
      chapters: [{ start_seconds: 0, title: 'Intro' }, { start_seconds: 1, title: 'The pour' }],
      steps: ['Chill the glass', 'Pour at 45 degrees']
    }
  ];
  const { page, record, training, close } = await launch({ user: USERS.bartender, lessons });
  try {
    await navigateTo(page, '#knowledge/training/lesson-pour');
    await page.waitForSelector('[data-training-video]');
    await until(() => training.callsFor('start').length > 0, { message: 'start' });

    // The written SOP renders (through the markdown renderer, never raw HTML).
    assert.match(await page.textContent('.tr-prose'), /Chill the glass/);

    // The video hydrates from the Blob object URL, then a chapter click seeks.
    await page.waitForFunction(() => { const v = document.querySelector('[data-training-video]'); return v && v.readyState >= 1; }, null, { timeout: 10000 });
    await page.click('[data-training-chapter="1"]');
    await page.waitForFunction(() => { const v = document.querySelector('[data-training-video]'); return v && v.currentTime > 0; }, null, { timeout: 5000 });

    // Complete the training.
    await page.click('[data-training-complete]');
    await until(() => training.callsFor('complete').length > 0, { message: 'complete' });
    await page.waitForSelector('[data-training-completed]');
    assert.match(await page.textContent('[data-training-completed]'), /Completed/);

    // The backend recorded the completion for this user + published version.
    const versionId = training.article('lesson-pour').current_version_id;
    assert.equal(training.progress.get(`${USERS.bartender.id}:${versionId}`)?.completion_state, 'completed');
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- 4. manager completion report ----------

test('a manager opens the completion report and sees assigned/completed/outstanding', { skip }, async () => {
  const lessons = [
    { id: 'lesson-pour', title: 'Pouring pints', status: 'published', required: true, target_roles: ['bartender'], content: '# Pour', completedBy: [USERS.bartender.id] }
  ];
  const { page, record, training, close } = await launch({ user: USERS.admin, lessons });
  try {
    await navigateTo(page, '#knowledge/training');
    await page.waitForSelector('[data-training-report="lesson-pour"]');
    await page.click('[data-training-report="lesson-pour"]');
    await page.waitForSelector('[data-training-report-body] .tr-stat');
    await until(() => training.callsFor('report').length > 0, { message: 'report' });

    // Two bartenders assigned; one (Sara) completed → 2 / 1 / 1.
    const stats = await page.$$eval('[data-training-report-body] .tr-stat .tr-stat__num', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(stats, ['2', '1', '1']);
    assert.match(await page.textContent('[data-training-report-body]'), /Sara/);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});

// ---------- 5. version immutability at the UI level ----------

test('publishing v2 supersedes v1 as current while v1 media, version and completion stay unchanged', { skip }, async () => {
  const lessons = [
    {
      id: 'lesson-pour', title: 'Pouring pints v1', status: 'published', required: true, target_roles: ['bartender'],
      content: '# V1 procedure', completedBy: [USERS.bartender.id],
      video: { upload_status: 'stored', duration_seconds: 3, original_filename: 'v1.webm' },
      draft: { title: 'Pouring pints v2', content: '# V2 procedure', chapters: [{ start_seconds: 0, title: 'Intro v2' }], steps: ['New closing step'] }
    }
  ];
  const { page, record, training, close } = await launch({ user: USERS.admin, lessons });
  try {
    const v1Id = training.article('lesson-pour').current_version_id;
    const v1Before = { ...training.version(v1Id) };
    const v1MediaId = training.version(v1Id).media_asset_id;
    const v1MediaBefore = { ...training.media.get(v1MediaId) };

    // Land on Training first so the manager's permissions load; the lesson view
    // then requests the draft (prefer_draft=1) and shows its Publish control.
    await navigateTo(page, '#knowledge/training');
    await page.waitForSelector('[data-training-section="manage"]');
    await navigateTo(page, '#knowledge/training/lesson-pour');
    await page.waitForSelector('[data-training-publish]');
    await page.click('[data-training-publish]');
    await page.waitForSelector('.atlas-dialog button[type="submit"]');
    await page.click('.atlas-dialog button[type="submit"]');
    await until(() => training.callsFor('publish').length > 0, { message: 'publish' });
    await settle(page);

    const article = training.article('lesson-pour');
    const v2Id = article.current_version_id;
    assert.notEqual(v2Id, v1Id, 'current version advanced to v2');
    assert.equal(training.version(v2Id).version_number, 2);
    assert.equal(training.version(v2Id).state, 'published');

    // v1 is superseded but otherwise untouched: content, media pointer, media asset.
    const v1After = training.version(v1Id);
    assert.equal(v1After.state, 'superseded');
    assert.equal(v1After.content, v1Before.content, 'v1 content is unchanged');
    assert.equal(v1After.version_number, v1Before.version_number);
    assert.equal(v1After.media_asset_id, v1MediaId, 'v1 still points at its own media');
    assert.deepEqual(training.media.get(v1MediaId), v1MediaBefore, 'v1 media asset is byte-for-byte unchanged');

    // v1's completion by the bartender is retained (immutable per version).
    assert.equal(training.progress.get(`${USERS.bartender.id}:${v1Id}`)?.completion_state, 'completed');

    // The report and snapshot now reflect v2 as current; nobody has completed v2.
    const report = training.report('lesson-pour', USERS.admin);
    assert.equal(report.current_version_id, v2Id, 'report tracks v2 as current');
    assert.equal(report.completed, 0, 'no completions counted against v2 yet');
    const row = training.snapshotFor(USERS.admin).lessons.find((l) => l.article_id === 'lesson-pour');
    assert.equal(row.version_id, v2Id);
    assert.equal(row.version_number, 2);
    assert.deepEqual(record.pageErrors, []);
  } finally { await close(); }
});
