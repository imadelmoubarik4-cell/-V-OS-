// The Atlas AI robot (atlas-bot.js): the interactive 3D robot on Atlas AI and
// the robot badge wherever the assistant is the symbol. The Atlas logo stays
// the brand mark. Runs the shipped scene bundle in Chromium (WebGL through
// SwiftShader) against the mocked atlas-ai.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, settle, until, USERS } from './harness.mjs';
import { aiFixtures, AI_FIXTURE_NOW } from './atlas-ai-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

// animate: this harness draws WebGL in software (SwiftShader), where the robot
// keeps still frames; the tests turn animation on to exercise it.
async function openAi({ viewport, contextOptions, initScript, hash = '#ai/new', backend = {}, animate = true } = {}) {
  const { fixtures, backend: state } = aiFixtures(backend);
  const launched = await launchAtlas({
    user: USERS.admin, fixtures, hash, viewport, contextOptions, initScript,
    fixedTime: AI_FIXTURE_NOW, storage: { 'atlas.ai.voice.explained.v1': 'yes' }
  });
  try {
    await launched.page.waitForFunction(() => document.body.dataset.atlasView === 'ai' && document.querySelector('#ai-view [data-ai-composer]'));
    if (animate) await launched.page.evaluate(() => window.AtlasBot?.animateInSoftware(true));
    await settle(launched.page);
  } catch (error) {
    await launched.close();
    throw error;
  }
  return { ...launched, backend: state };
}

const info = (page, key = 'ai-empty') => page.evaluate((name) => window.AtlasBot?.info(name), key);
// Share of drawn (non-transparent) pixels in the robot canvas.
const drawn = (page) => page.evaluate(() => {
  const canvas = document.querySelector('.atlas-bot-live__canvas');
  if (!canvas) return 0;
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
  let lit = 0;
  for (let index = 3; index < data.length; index += 4) if (data[index] > 0) lit += 1;
  return lit / (data.length / 4);
});
// The lowest drawn row of the robot canvas (alpha above a faint threshold,
// so the contact shadow counts), in CSS px from the canvas top; 0 when the
// copy caught a cleared frame.
const drawnBottom = (page) => page.evaluate(() => {
  const canvas = document.querySelector('.ai-empty .atlas-bot-live__canvas');
  if (!canvas) return 0;
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
  let lit = 0;
  for (let index = 3; index < data.length; index += 4) if (data[index] > 0) lit += 1;
  if (lit / (data.length / 4) < 0.08) return 0;
  for (let y = copy.height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < copy.width; x += 1) if (data[(y * copy.width + x) * 4 + 3] > 6) return (y + 1) / (canvas.width / canvas.getBoundingClientRect().width);
  }
  return 0;
});
const spriteLoaded = (page, selector) => page.evaluate(async (css) => {
  const node = document.querySelector(css);
  if (!node) return { found: false };
  const style = getComputedStyle(node);
  const url = style.backgroundImage.match(/url\("?([^")]+)"?\)/)?.[1];
  if (!url) return { found: true, url: null };
  const image = new Image();
  image.src = url;
  try { await image.decode(); } catch { return { found: true, url, width: 0 }; }
  const box = node.getBoundingClientRect();
  return { found: true, url, width: image.naturalWidth, height: image.naturalHeight, box: [Math.round(box.width), Math.round(box.height)] };
}, selector);

test('Atlas AI: the live 3D robot draws, greets once, follows the pointer and reacts to a tap', { skip }, async () => {
  const { page, close } = await openAi({ viewport: { width: 1440, height: 900 } });
  try {
    await page.waitForSelector('#ai-view .ai-empty .atlas-bot-live.is-live', { timeout: 15000 });
    await until(async () => (await info(page))?.scene?.frames > 3, { message: 'robot frames' });
    const first = await info(page);
    assert.equal(first.live, true);
    assert.equal(first.failed, false);
    assert.equal(first.scene.greetings, 1, 'greets once when it first shows');
    assert.ok(first.scene.triangles > 5000 && first.scene.triangles < 200000, `triangle budget: ${first.scene.triangles}`);
    // The WebGL canvas does not keep its last frame, so a copy taken after the
    // browser cleared it reads empty: retry until a drawn frame is copied.
    await until(async () => await drawn(page) > 0.08, { message: 'the robot is drawn in the canvas' });
    const box = await page.locator('.ai-empty .atlas-bot-live').boundingBox();
    assert.deepEqual([Math.round(box.width), Math.round(box.height)], [176, 176]);
    // The robot replaces the Atlas mark that used to head the greeting; the logo in the sidebar is untouched.
    assert.equal(await page.$eval('#ai-view .ai-empty', (node) => getComputedStyle(node, '::before').content), 'none');
    // The official logo is untouched.
    assert.equal(await page.locator('.atlas-sidebar .atlas-brand img, .atlas-sidebar .atlas-brand svg').count() > 0, true);
    // Pointer: it keeps drawing while the pointer moves; a tap plays "react".
    await page.mouse.move(200, 200);
    await page.mouse.move(1200, 700, { steps: 5 });
    assert.equal((await info(page)).running, true);
    // The greeting is not cut short; a tap after it plays "react".
    await until(async () => (await info(page))?.scene?.moment === null, { timeout: 45000, message: 'greeting ends' });
    // It looks toward the pointer: down at a pointer below it, up at one above
    // (a positive head pitch tips the face down).
    const centre = box.x + box.width / 2;
    await page.mouse.move(centre, 890, { steps: 3 });
    await until(async () => (await info(page))?.scene?.headPitch > 0.1, { message: 'looks down at a pointer below' });
    await page.mouse.move(centre, 5, { steps: 3 });
    await until(async () => (await info(page))?.scene?.headPitch < -0.1, { message: 'looks up at a pointer above' });
    await page.mouse.move(1400, box.y + box.height * 0.35, { steps: 3 });
    await until(async () => (await info(page))?.scene?.headYaw > 0.1, { message: 'looks right at a pointer to the right' });
    await page.mouse.move(5, box.y + box.height * 0.35, { steps: 3 });
    await until(async () => (await info(page))?.scene?.headYaw < -0.1, { message: 'looks left at a pointer to the left' });
    // The robot and the greeting are one unit: the drawn robot (its feet and
    // shadow) ends a few pixels above the greeting, never on it.
    const greeting = await page.locator('#ai-view .ai-empty__greeting').boundingBox();
    const feet = await until(() => drawnBottom(page), { message: 'the robot is drawn' });
    const gap = greeting.y - (box.y + feet);
    assert.ok(gap >= 0 && gap <= 22, `robot to greeting gap ${gap}`);
    await page.locator('.ai-empty .atlas-bot-live__canvas').click();
    await until(async () => (await info(page))?.scene?.moment === 'react', { message: 'react moment' });
    // Leaving Atlas AI stops drawing; coming back resumes without a new greeting or context.
    await page.evaluate(() => window.AtlasShell.navigate('#home'));
    await until(async () => (await info(page))?.running === false, { message: 'stops off screen' });
    await page.evaluate(() => window.AtlasShell.navigate('#ai/new'));
    await until(async () => (await info(page))?.running === true, { message: 'resumes' });
    assert.equal((await info(page)).scene.greetings, 1, 'no second greeting');
    assert.equal(await page.locator('canvas.atlas-bot-live__canvas').count(), 1, 'one canvas, reused');
    await page.screenshot({ path: process.env.ATLAS_BOT_SHOTS ? `${process.env.ATLAS_BOT_SHOTS}/ai-empty-1440.png` : undefined });
  } finally { await close(); }
});

test('Atlas AI: while an answer streams the robot label thinks, then settles', { skip }, async () => {
  const { page, close } = await openAi();
  try {
    await page.fill('#ai-view [data-ai-input]', 'Do we have enough Campari for tonight?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#ai-view .msg-ai .msg-ai__who .atlas-bot');
    await until(() => page.evaluate(() => document.querySelector('#ai-view .msg-ai:last-of-type .msg-ai__who .atlas-bot')?.dataset.state === 'idle'), { message: 'label settles after the answer' });
    assert.equal(await page.locator('#ai-view .msg-ai .ai-mark').count(), 0, 'the sparkles mark is gone');
    assert.equal(await page.locator('#ai-view .ai-empty').count(), 0);
    if (process.env.ATLAS_BOT_SHOTS) await page.screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/ai-conversation-1440.png` });
  } finally { await close(); }
});

test('reduced motion: one still frame, no animation loop, badges do not animate', { skip }, async () => {
  const { page, close } = await openAi({ contextOptions: { reducedMotion: 'reduce' } });
  try {
    await page.waitForSelector('#ai-view .atlas-bot-live.is-live', { timeout: 15000 });
    await until(async () => (await info(page))?.scene?.frames >= 1, { message: 'a still frame' });
    // The still frame for the mount is drawn on the next animation frame; then nothing is pending.
    await until(async () => (await info(page))?.running === false, { message: 'no frame pending' });
    await page.evaluate(() => new Promise((resolve) => { let count = 0; const tick = () => (++count >= 10 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
    const first = await info(page);
    // Ten more browser frames: the robot draws none of them.
    await page.evaluate(() => new Promise((resolve) => { let count = 0; const tick = () => (++count >= 10 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
    const later = await info(page);
    assert.equal(later.running, false, 'no animation loop');
    assert.equal(later.scene.frames, first.scene.frames, 'no frames drawn while idle');
    assert.equal(await page.locator('#ai-view .atlas-bot-live__poster').isVisible(), false, 'the still 3D frame replaces the poster');
    const animation = await page.$eval('.atlas-nav .nav-item--ai .atlas-bot', (node) => getComputedStyle(node).animationIterationCount);
    assert.equal(animation, '1', 'badge blink stops (reduced motion rule)');
  } finally { await close(); }
});

test('no WebGL: the robot badge stays as the poster; nothing breaks', { skip }, async () => {
  const initScript = () => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
      if (String(type).startsWith('webgl')) return null;
      return original.call(this, type, ...rest);
    };
  };
  const { page, close, record } = await openAi({ initScript });
  try {
    await page.waitForSelector('#ai-view .atlas-bot-live.is-static');
    assert.equal(await page.locator('#ai-view .atlas-bot-live .atlas-bot-live__poster').isVisible(), true);
    assert.equal(await page.locator('#ai-view canvas.atlas-bot-live__canvas').count(), 0);
    assert.equal(await page.evaluate(() => window.AtlasBot.info('ai-empty')), null);
    assert.deepEqual(record?.pageErrors || [], []);
  } finally { await close(); }
});

test('badges: sidebar, palette Ask Atlas and the robot sprite; the Atlas logo stays the brand mark', { skip }, async () => {
  const { fixtures } = aiFixtures();
  const { page, close } = await launchAtlas({ user: USERS.admin, fixtures, hash: '#home', fixedTime: AI_FIXTURE_NOW });
  try {
    const nav = await spriteLoaded(page, '.atlas-nav .nav-item--ai .atlas-bot');
    assert.equal(nav.found, true);
    // 20 px: the small sprite (tighter face, matte visor, larger eyes).
    assert.match(nav.url, /assets\/atlas-bot\/atlas-bot-small\.png\?v=20261004-bot5/);
    assert.deepEqual([nav.width, nav.height], [384, 96], 'four 96 px frames');
    assert.deepEqual(nav.box, [20, 20]);
    if (process.env.ATLAS_BOT_SHOTS) await page.locator('.atlas-nav .nav-group[data-nav-group="main"]').screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/nav-badge-1440.png` });
    assert.equal(await page.locator('.atlas-nav .nav-item--ai [data-lucide="sparkles"], .atlas-nav .nav-item--ai .lucide-sparkles').count(), 0);
    // Hover smiles (the happy frame).
    await page.hover('.atlas-nav .nav-item--ai');
    assert.equal(await page.$eval('.atlas-nav .nav-item--ai .atlas-bot', (node) => getComputedStyle(node).backgroundPositionX), '100%');
    // Ctrl K: the Ask Atlas row carries the robot.
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.atlas-palette');
    await page.keyboard.type('campari');
    await until(() => page.evaluate(() => [...document.querySelectorAll('.atlas-palette [role="option"]')].some((row) => /Ask Atlas/.test(row.textContent) && row.querySelector('.atlas-bot'))), { message: 'Ask Atlas row with the robot' });
    if (process.env.ATLAS_BOT_SHOTS) await page.screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/palette-ask-1440.png` });
    // The brand mark is still the kit logo.
    const brand = await page.$eval('.atlas-sidebar .atlas-brand', (node) => node.innerHTML);
    assert.doesNotMatch(brand, /atlas-bot/);
  } finally { await close(); }
});

test('phone 390: tab bar robot, a smaller live robot, no sideways scroll, nothing overlaps the tab bar', { skip }, async () => {
  const { page, close } = await openAi({ viewport: { width: 390, height: 844 }, contextOptions: { hasTouch: true, isMobile: true } });
  try {
    await page.waitForSelector('#ai-view .atlas-bot-live.is-live', { timeout: 15000 });
    const tab = await spriteLoaded(page, '.atlas-tabbar__item--ai .atlas-bot');
    assert.deepEqual(tab.box, [24, 24]);
    assert.match(tab.url, /atlas-bot-small\.png/, '24 px: the small sprite');
    if (process.env.ATLAS_BOT_SHOTS) await page.locator('#atlas-tabbar').screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/tabbar-390.png` });
    const bot = await page.locator('#ai-view .ai-empty .atlas-bot-live').boundingBox();
    assert.deepEqual([Math.round(bot.width), Math.round(bot.height)], [136, 136]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    const tabbar = await page.locator('#atlas-tabbar').boundingBox();
    const composer = await page.locator('#ai-view [data-ai-composer]').boundingBox();
    assert.ok(bot.y + bot.height <= composer.y, 'robot sits above the composer');
    assert.ok(composer.y + composer.height <= tabbar.y + 1, 'composer clears the tab bar');
    await until(async () => (await info(page))?.scene?.moment === null, { timeout: 45000, message: 'greeting ends' });
    await page.locator('#ai-view .atlas-bot-live__canvas').tap();
    await until(async () => (await info(page))?.scene?.moment === 'react', { message: 'tap reacts' });
    await page.screenshot({ path: process.env.ATLAS_BOT_SHOTS ? `${process.env.ATLAS_BOT_SHOTS}/ai-empty-390.png` : undefined });
  } finally { await close(); }
});

for (const [label, viewport, mobile, size] of [
  ['desktop 1920×1080', { width: 1920, height: 1080 }, false, 176],
  ['desktop 1440×900', { width: 1440, height: 900 }, false, 176],
  ['laptop 1366×768', { width: 1366, height: 768 }, false, 176],
  ['tablet portrait 768×1024', { width: 768, height: 1024 }, true, 176],
  ['tablet landscape 1024×768', { width: 1024, height: 768 }, true, 176],
  ['phone portrait 390×844', { width: 390, height: 844 }, true, 136],
  ['narrow phone 360×640', { width: 360, height: 640 }, true, 136],
  ['phone landscape 844×390', { width: 844, height: 390 }, true, 96],
  ['laptop 1280×720', { width: 1280, height: 720 }, false, 176],
]) {
  test(`responsive ${label}: the robot fits, overlaps neither the greeting, the suggestions nor the composer, and nothing scrolls sideways`, { skip }, async () => {
    // Layout only: the robot's poster has the live robot's size, so the scene is
    // not drawn (software WebGL would only slow the page down).
    const { page, close } = await openAi({ viewport, contextOptions: mobile ? { hasTouch: true, isMobile: true } : {}, animate: false });
    try {
      await page.waitForSelector('#ai-view .ai-empty .atlas-bot-live', { timeout: 15000 });
      await settle(page);
      if (process.env.ATLAS_BOT_SHOTS) await page.screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/ai-empty-${viewport.width}x${viewport.height}.png` });
      const box = async (selector) => page.locator(selector).first().boundingBox();
      // Phone portrait (< 768 px wide, taller than a short screen): the page
      // scrolls under a composer fixed above the tab bar (by design); elsewhere
      // the workspace fits the window.
      const phone = viewport.width < 768 && viewport.height > 560;
      // The workspace fits the window: the page itself does not scroll and the
      // conversation header is on screen.
      assert.equal(await page.evaluate(() => Math.round(document.scrollingElement.scrollTop)), 0, 'the page did not scroll');
      if (!phone) assert.ok(await page.evaluate(() => document.querySelector('#ai-view .ai-layout').getBoundingClientRect().bottom <= innerHeight + 1), 'the Atlas AI workspace fits the window');
      const bot = await box('#ai-view .ai-empty .atlas-bot-live');
      const greeting = await box('#ai-view .ai-empty__greeting');
      const chips = await box('#ai-view .ai-empty__chips');
      const composer = await box('#ai-view [data-ai-composer]');
      assert.ok(bot && bot.width >= 96 && bot.width <= 200, `robot size ${bot?.width}`);
      // The approved scale: 176 px on desktop and tablet, 136 on a phone, 96 on a short screen.
      assert.deepEqual([Math.round(bot.width), Math.round(bot.height)], [size, size], 'the approved robot size');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
      assert.ok(bot.x >= 0 && bot.x + bot.width <= viewport.width, 'robot inside the viewport horizontally');
      // At the top of the conversation area the whole robot is visible (nothing clipped above the fold).
      const area = await box('#ai-view .ai-scroll');
      assert.ok(bot.y >= area.y - 1, `robot top is not clipped (${bot.y} vs ${area.y})`);
      // The robot and the greeting read as one unit: the drawn robot (here its
      // poster; the live robot is checked by pixels in the 1440 test) ends just
      // above the greeting, never on it. Only the transparent band below the
      // robot's feet may tuck under the greeting's line box.
      const poster = await box('#ai-view .ai-empty .atlas-bot-live__poster');
      const gap = greeting.y - (poster.y + poster.height);
      assert.ok(gap >= 0 && gap <= 22, `drawn robot to greeting gap ${gap}`);
      assert.ok(bot.y + bot.height - greeting.y <= bot.height * 0.1, 'only the empty band under the feet tucks under the greeting');
      assert.ok(bot.y + bot.height <= greeting.y + greeting.height / 2, 'robot above the greeting');
      assert.ok(greeting.y + greeting.height <= chips.y + 1, 'greeting above the suggestions');
      // The composer never covers the empty state: it sits below the conversation area,
      // and the last suggestion can be scrolled into view above it.
      if (phone) {
        // Opened, the robot, the greeting and the first suggestion show above the fixed composer.
        const first = await box('#ai-view .ai-empty__chips [data-ai-suggest]');
        assert.ok(bot.y >= 0 && first.y + first.height <= composer.y + 1, 'robot, greeting and suggestions visible above the composer');
        assert.equal(await page.$eval('#ai-view [data-ai-composer-wrap]', (node) => getComputedStyle(node).position), 'fixed');
      } else assert.ok(area.y + area.height <= composer.y + 1, 'conversation area ends above the composer');
      if (phone) await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
      else await page.locator('#ai-view .ai-empty__chips [data-ai-suggest]').last().scrollIntoViewIfNeeded();
      const composerNow = await box('#ai-view [data-ai-composer]');
      const lastChip = await page.locator('#ai-view .ai-empty__chips [data-ai-suggest]').last().boundingBox();
      assert.ok(lastChip.y + lastChip.height <= composerNow.y + 1, 'the last suggestion is reachable above the composer');
      const tabbar = await page.locator('#atlas-tabbar').boundingBox().catch(() => null);
      if (tabbar && tabbar.height > 0) assert.ok(composer.y + composer.height <= tabbar.y + 1, 'composer clears the tab bar');
      assert.ok(composer.y + composer.height <= viewport.height + 1, 'composer is not clipped');
      // Asleep: its ZZZ stays inside the robot's own box, clear of the greeting.
      await page.locator('#ai-view .ai-scroll').evaluate((node) => { node.scrollTop = 0; });
      await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
      await page.evaluate(() => window.AtlasBot.robot.set('sleeping'));
      const z = await page.evaluate(() => { const rects = [...document.querySelectorAll('#ai-view .ai-empty .atlas-bot-z > i')].map((node) => node.getBoundingClientRect()); const x = Math.min(...rects.map((rect) => rect.left)); const y = Math.min(...rects.map((rect) => rect.top)); return { x, y, width: Math.max(...rects.map((rect) => rect.right)) - x, height: Math.max(...rects.map((rect) => rect.bottom)) - y }; });
      const host = await box('#ai-view .ai-empty .atlas-bot-live');
      const heading = await box('#ai-view .ai-empty__greeting');
      assert.ok(z && z.x >= host.x && z.x + z.width <= host.x + host.width && z.y >= host.y && z.y + z.height <= host.y + host.height, 'ZZZ inside the robot box');
      assert.ok(z.y + z.height <= heading.y, 'ZZZ clear of the greeting');
      if (process.env.ATLAS_BOT_SHOTS) await page.screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/ai-empty-sleeping-${viewport.width}x${viewport.height}.png` });
    } finally { await close(); }
  });
}

const frames = (page, count = 3) => page.evaluate((n) => new Promise((resolve) => { let seen = 0; const tick = () => (++seen >= n ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), count);

test('WebGL context lost: the poster shows and drawing stops; restored: the robot comes back', { skip }, async () => {
  const { page, close, record } = await openAi({ viewport: { width: 1440, height: 900 } });
  try {
    await page.waitForSelector('#ai-view .ai-empty .atlas-bot-live.is-live', { timeout: 15000 });
    await until(async () => (await info(page))?.scene?.frames > 2, { message: 'robot frames' });
    await page.evaluate(() => {
      const canvas = document.querySelector('.atlas-bot-live__canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      window.loseContextForTest = gl.getExtension('WEBGL_lose_context');
      window.loseContextForTest.loseContext();
    });
    await page.waitForSelector('#ai-view .atlas-bot-live.is-static:not(.is-live)');
    await until(async () => (await info(page))?.lost === true, { message: 'lost' });
    assert.equal((await info(page)).running, false, 'no drawing on a lost context');
    assert.equal(await page.locator('#ai-view .atlas-bot-live__poster').isVisible(), true, 'the poster shows');
    assert.equal(await page.locator('#ai-view .atlas-bot-live__canvas').isVisible(), false);
    // A re-render while lost keeps the poster.
    await page.evaluate(() => {
      const slot = document.querySelector('#ai-view .ai-empty__bot');
      slot.innerHTML = window.AtlasBot.liveHtml({ key: 'ai-empty', framing: 'full', size: 176 });
      window.AtlasBot.upgrade(slot);
    });
    assert.equal(await page.locator('#ai-view .atlas-bot-live.is-static').count(), 1);
    await page.evaluate(() => window.loseContextForTest.restoreContext());
    await page.waitForSelector('#ai-view .atlas-bot-live.is-live:not(.is-static)', { timeout: 15000 });
    await until(async () => { const now = await info(page); return now?.lost === false && now.scene?.frames > 1; }, { message: 'drawing again' });
    await until(async () => (await drawn(page)) > 0.08, { timeout: 8000, message: 'the robot is drawn again after the restore' });
    assert.equal(await page.locator('canvas.atlas-bot-live__canvas').count(), 1);
    assert.deepEqual(record?.pageErrors || [], []);
  } finally { await close(); }
});

test('many rapid re-renders reuse one WebGL context and draw at most once per frame; a robot destroyed while loading opens none', { skip }, async () => {
  const initScript = () => {
    window.webglContextCalls = [];
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
      if (String(type).startsWith('webgl') || type === 'experimental-webgl') window.webglContextCalls.push(type);
      return original.call(this, type, ...rest);
    };
  };
  const { page, close, record } = await openAi({ viewport: { width: 1440, height: 900 }, initScript });
  try {
    await page.waitForSelector('#ai-view .ai-empty .atlas-bot-live.is-live', { timeout: 15000 });
    await until(async () => (await info(page))?.scene?.frames > 2, { message: 'robot frames' });
    const base = await page.evaluate(() => window.webglContextCalls.length);
    // The GPU probe (webgl2, webgl: both refused here, WebGL is in software),
    // the software probe (webgl2) and the robot's own context.
    assert.ok(base <= 4, `probes and one robot context (${base} getContext calls)`);
    // 60 re-renders in one task (as live voice does on every transcript
    // update) and 20 robots destroyed before their scene loaded.
    const result = await page.evaluate(() => {
      const slot = document.querySelector('#ai-view .ai-empty__bot');
      const before = window.AtlasBot.info('ai-empty').scene.frames;
      for (let index = 0; index < 60; index += 1) {
        slot.innerHTML = window.AtlasBot.liveHtml({ key: 'ai-empty', framing: 'full', size: 176 });
        window.AtlasBot.upgrade(slot);
      }
      const after = window.AtlasBot.info('ai-empty').scene.frames;
      for (let index = 0; index < 20; index += 1) {
        const holder = document.createElement('div');
        holder.innerHTML = window.AtlasBot.liveHtml({ key: `gone-${index}`, framing: 'bust', size: 60 });
        document.body.append(holder);
        window.AtlasBot.upgrade(holder);
        window.AtlasBot.destroy(`gone-${index}`);
        holder.remove();
      }
      return { before, after };
    });
    assert.equal(result.after, result.before, 're-renders draw nothing synchronously');
    await frames(page, 5);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)));
    assert.equal(await page.evaluate(() => window.webglContextCalls.length), base, 'no new WebGL context');
    assert.equal(await page.locator('canvas.atlas-bot-live__canvas').count(), 1, 'one canvas, reused');
    assert.equal(await page.evaluate(() => window.AtlasBot.info('gone-0')), null);
    assert.equal((await info(page)).live, true);
    // Pointer moves only schedule a frame: 50 in one task draw nothing then.
    const moved = await page.evaluate(() => {
      const before = window.AtlasBot.info('ai-empty').scene.frames;
      for (let index = 0; index < 50; index += 1) window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100 + index * 10, clientY: 300 }));
      return window.AtlasBot.info('ai-empty').scene.frames - before;
    });
    assert.equal(moved, 0);
    assert.deepEqual(record?.pageErrors || [], []);
  } finally { await close(); }
});

test('reduced motion switched on while the robot runs: the scene is told, drawing and pointer tracking stop; off again: it resumes', { skip }, async () => {
  const { page, close } = await openAi({ viewport: { width: 1440, height: 900 } });
  try {
    await page.waitForSelector('#ai-view .atlas-bot-live.is-live', { timeout: 15000 });
    await until(async () => (await info(page))?.running === true, { message: 'running' });
    for (const [on, off] of [
      [() => page.emulateMedia({ reducedMotion: 'reduce' }), () => page.emulateMedia({ reducedMotion: 'no-preference' })],
      [() => page.evaluate(() => document.documentElement.classList.add('atlas-reduce-motion')), () => page.evaluate(() => document.documentElement.classList.remove('atlas-reduce-motion'))]
    ]) {
      await on();
      await until(async () => { const now = await info(page); return now.reducedMotion === true && now.running === false; }, { message: 'reduced motion taken live' });
      await frames(page, 3);
      const still = (await info(page)).scene.frames;
      await page.mouse.move(100, 100);
      await page.mouse.move(1300, 800, { steps: 12 });
      await frames(page, 10);
      assert.equal((await info(page)).scene.frames, still, 'pointer moves draw nothing under reduced motion');
      assert.equal((await info(page)).running, false);
      await off();
      await until(async () => { const now = await info(page); return now.reducedMotion === false && now.running === true; }, { message: 'motion resumes' });
    }
    // The badge's hover tilt honours the system setting too.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.hover('.atlas-nav .nav-item--ai');
    assert.equal(await page.$eval('.atlas-nav .nav-item--ai .atlas-bot', (node) => getComputedStyle(node).transform), 'none');
  } finally { await close(); }
});

test('calm idle pauses the render loop; a pointer move, a state change or a moment resumes it', { skip }, async () => {
  const { page, close } = await openAi({ viewport: { width: 1440, height: 900 } });
  try {
    await page.waitForSelector('#ai-view .atlas-bot-live.is-live', { timeout: 15000 });
    await until(async () => (await info(page))?.scene?.moment === null, { timeout: 45000, message: 'greeting ends' });
    await page.evaluate(() => window.AtlasBot.setIdleTimeout(300));
    await until(async () => { const now = await info(page); return now.running === false && now.paused === true; }, { message: 'paused while idle' });
    const still = (await info(page)).scene.frames;
    await frames(page, 10);
    assert.equal((await info(page)).scene.frames, still, 'no frames while paused');
    await page.mouse.move(300, 300);
    await page.mouse.move(700, 400, { steps: 3 });
    await until(async () => (await info(page)).running === true, { message: 'pointer resumes' });
    await until(async () => (await info(page)).paused === true, { message: 'pauses again' });
    // The welcome robot follows the assistant's state (AtlasBot.robot), so its
    // state changes through the controller: a surface-level setState would be
    // replaced by the controller's next change (the pointer above woke it, and
    // its awake spell ends by itself, on a slow runner inside this window).
    await page.evaluate(() => window.AtlasBot.robot.set('thinking'));
    await until(async () => (await info(page)).running === true, { message: 'state resumes' });
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));
    assert.equal((await info(page)).state, 'thinking');
    assert.equal((await info(page)).running, true, 'a busy state keeps drawing');
    await page.evaluate(() => window.AtlasBot.robot.set('idle'));
    await until(async () => (await info(page)).paused === true, { message: 'idle pauses' });
    await page.evaluate(() => window.AtlasBot.play('ai-empty', 'success'));
    await until(async () => (await info(page)).running === true, { message: 'moment resumes' });
  } finally { await close(); }
});

test('the robot canvas follows its host size', { skip }, async () => {
  const { page, close } = await openAi({ viewport: { width: 1440, height: 900 } });
  try {
    await page.waitForSelector('#ai-view .atlas-bot-live.is-live', { timeout: 15000 });
    const width = () => page.$eval('.atlas-bot-live__canvas', (canvas) => canvas.width / devicePixelRatio);
    await until(async () => (await width()) === 176, { message: 'initial size' });
    await page.$eval('#ai-view .ai-empty .atlas-bot-live', (host) => { host.style.width = '120px'; host.style.height = '120px'; });
    await until(async () => (await width()) === 120, { message: 'canvas resized with its host' });
    await until(async () => (await drawn(page)) > 0.08, { message: 'drawn at the new size' });
  } finally { await close(); }
});

test('WebGL in software (no GPU): the poster stays, no scene is built, and it can still be turned on', { skip }, async () => {
  const initScript = () => {
    window.webglContextCalls = [];
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
      if (String(type).startsWith('webgl')) window.webglContextCalls.push(type);
      return original.call(this, type, ...rest);
    };
  };
  const { page, close, record } = await openAi({ viewport: { width: 1440, height: 900 }, animate: false, initScript });
  try {
    await page.waitForSelector('#ai-view .atlas-bot-live.is-static');
    assert.equal(await page.evaluate(() => window.AtlasBot.software()), true, 'SwiftShader reports a major performance caveat');
    assert.equal(await page.locator('#ai-view .atlas-bot-live__poster').isVisible(), true, 'the robot badge is the poster');
    assert.equal(await page.locator('#ai-view canvas.atlas-bot-live__canvas').count(), 0);
    assert.equal(await info(page), null);
    assert.deepEqual(await page.evaluate(() => window.webglContextCalls), ['webgl2', 'webgl', 'webgl2'], 'only the two probes, once');
    // The badges are unaffected.
    assert.equal(await page.locator('.atlas-nav .nav-item--ai .atlas-bot--small').count(), 1);
    await page.evaluate(() => window.AtlasBot.animateInSoftware(true));
    await page.waitForSelector('#ai-view .atlas-bot-live.is-live', { timeout: 15000 });
    assert.deepEqual(record?.pageErrors || [], []);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------
// The one state controller (AtlasBot.robot): states, sleep and wake, timers.
// ---------------------------------------------------------------------------

const robotInfo = (page) => page.evaluate(() => window.AtlasBot.robot.info());
const setRobot = (page, state) => page.evaluate((name) => window.AtlasBot.robot.set(name), state);
// Precondition only: the ~3 s greeting runs in scene time, which a starved CI
// runner (software WebGL) advances slowly.
const greeted = (page) => until(async () => (await info(page))?.scene?.moment === null, { timeout: 45000, message: 'greeting ends' });
// What every following surface shows: the welcome robot, its poster, the
// sidebar and tab bar robots.
const shown = (page) => page.evaluate(() => ({
  host: document.querySelector('#ai-view .ai-empty .atlas-bot-live')?.dataset.state,
  poster: document.querySelector('#ai-view .ai-empty .atlas-bot-live__poster')?.dataset.state,
  nav: document.querySelector('.atlas-nav .nav-item--ai .atlas-bot')?.dataset.state,
  tab: document.querySelector('.atlas-tabbar__item--ai .atlas-bot')?.dataset.state
}));
// Any clearly red colour in a computed style value.
const reds = (value) => [...String(value).matchAll(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/g)].filter(([, r, g, b]) => Number(r) > Number(g) + 40 && Number(r) > Number(b) + 40).map(([match]) => match);
const hexRed = (hex) => { const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)); return r > g + 40 && r > b + 40; };

test('every state is reachable through the one controller and shows the same on the welcome robot, its scene and the sidebar robot; never red', { skip }, async () => {
  const { page, close, record } = await openAi({ viewport: { width: 1440, height: 900 } });
  try {
    await page.waitForSelector('#ai-view .ai-empty .atlas-bot-live.is-live', { timeout: 15000 });
    await greeted(page);
    // Transient awake would otherwise return to idle while it is checked.
    await page.evaluate(() => window.AtlasBot.robot.setDelays({ awake: 60000 }));
    const poses = {
      awake: (scene) => scene.base === 'awake' && scene.pose.eyeLight > 1.12 && scene.pose.glow > 1.25 && scene.eyes === 'open',
      sleeping: (scene) => scene.base === 'sleeping' && scene.eyes === 'closed' && scene.pose.glow < 0.6 && scene.headPitch > 0.1 && scene.frameInterval >= 100,
      listening: (scene) => scene.base === 'listening' && scene.pose.chest > 1 && scene.eyes === 'open',
      thinking: (scene) => scene.base === 'thinking' && scene.pose.eyeUp > 0.5 && scene.headRoll > 0.08,
      answering: (scene) => scene.base === 'answering' && scene.headPitch > 0.05 && scene.headYaw < -0.05,
      attention: (scene) => scene.base === 'attention' && scene.pose.glow > 1.45 && scene.headRoll > 0.08,
      error: (scene) => scene.base === 'error' && scene.pose.eyeLight < 0.7 && scene.pose.glow < 0.6 && scene.headPitch > 0.1,
      idle: (scene) => scene.base === 'idle' && scene.eyes !== 'closed' && Math.abs(scene.pose.eyeLight - 1) < 0.03 && Math.abs(scene.pose.glow - 1) < 0.1
    };
    const seen = {};
    for (const [state, pose] of Object.entries(poses)) {
      assert.equal(await setRobot(page, state), state);
      await until(async () => pose((await info(page)).scene), { timeout: 12000, message: `${state}: the scene takes the pose` });
      const now = await info(page);
      assert.equal(now.state, state, `${state}: the welcome robot follows`);
      assert.deepEqual(await shown(page), { host: state, poster: state, nav: state, tab: state }, `${state}: every following surface shows it`);
      assert.equal(hexRed(now.scene.eyeColor), false, `${state}: eyes ${now.scene.eyeColor} are not red`);
      seen[state] = { eyeLight: now.scene.pose.eyeLight, glow: now.scene.pose.glow };
      const badge = await page.$eval('.atlas-nav .nav-item--ai .atlas-bot', (node) => { const style = getComputedStyle(node); return `${style.boxShadow} ${style.filter} ${style.backgroundColor} ${style.color}`; });
      assert.deepEqual(reds(badge), [], `${state}: the sidebar robot has no red`);
      if (process.env.ATLAS_BOT_SHOTS) await page.locator('#ai-view .ai-empty').screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/state-${state}-1440.png` });
    }
    // Distinct looks: error dims, attention and awake brighten.
    assert.ok(seen.error.eyeLight < seen.idle.eyeLight && seen.attention.glow > seen.awake.glow && seen.awake.eyeLight > seen.idle.eyeLight);
    // Success: a moment, then idle by itself.
    await page.evaluate(() => window.AtlasBot.robot.setDelays({ success: 900 }));
    await setRobot(page, 'success');
    assert.equal((await shown(page)).nav, 'success');
    assert.equal(await page.$eval('.atlas-nav .nav-item--ai .atlas-bot', (node) => getComputedStyle(node).backgroundPositionX), '100%', 'the smile frame');
    await until(async () => (await info(page)).scene.moment === 'success', { message: 'success moment' });
    await until(async () => (await robotInfo(page)).state === 'idle', { message: 'success returns to idle' });
    assert.deepEqual(await shown(page), { host: 'idle', poster: 'idle', nav: 'idle', tab: 'idle' });
    // Old name: speaking is answering.
    assert.equal(await setRobot(page, 'speaking'), 'answering');
    // One live robot, one canvas throughout.
    assert.equal(await page.locator('canvas.atlas-bot-live__canvas').count(), 1);
    assert.deepEqual(record?.pageErrors || [], []);
  } finally { await close(); }
});

test('idle falls asleep (test hook): eyes close, Z → ZZ → ZZZ → fade in the robot corner and the sidebar; hover wakes it at once and the Z is gone', { skip }, async () => {
  const { page, close } = await openAi({ viewport: { width: 1440, height: 900 } });
  try {
    await page.waitForSelector('#ai-view .ai-empty .atlas-bot-live.is-live', { timeout: 15000 });
    await greeted(page);
    assert.equal((await robotInfo(page)).active, true, 'Atlas AI is open');
    await page.evaluate(() => window.AtlasBot.robot.setDelays({ active: 700 }));
    await until(async () => (await robotInfo(page)).state === 'sleeping', { message: 'falls asleep' });
    assert.equal((await robotInfo(page)).timers, 0, 'no timer runs while it sleeps');
    await until(async () => (await info(page)).scene.eyes === 'closed', { timeout: 10000, message: 'eyes close' });
    await until(async () => (await info(page)).scene.pose.glow < 0.6, { timeout: 10000, message: 'glow lowers' });
    // The live robot's Z: three letters, each on its own CSS animation (no JS timer).
    const sequence = await page.evaluate(() => {
      const letters = [...document.querySelectorAll('#ai-view .ai-empty .atlas-bot-z > i')];
      const animations = letters.map((letter) => letter.getAnimations()[0]);
      const names = animations.map((animation) => animation?.animationName);
      const at = (ms) => { animations.forEach((animation) => { animation.pause(); animation.currentTime = ms; }); return letters.map((letter) => Number(getComputedStyle(letter).opacity) > 0.3); };
      const result = { names, display: getComputedStyle(letters[0].parentElement).display, hidden: letters[0].parentElement.getAttribute('aria-hidden'), steps: [at(600), at(1800), at(3000), at(5200)] };
      animations.forEach((animation) => animation.play());
      return result;
    });
    assert.deepEqual(sequence.names, ['atlas-bot-z1', 'atlas-bot-z2', 'atlas-bot-z3']);
    assert.equal(sequence.display, 'block');
    assert.equal(sequence.hidden, 'true');
    assert.deepEqual(sequence.steps, [[true, false, false], [true, true, false], [true, true, true], [false, false, false]], 'Z, ZZ, ZZZ, then a fade and a pause');
    // The Z stays inside the robot's own box.
    const [hostBox, ...letterBoxes] = await page.evaluate(() => [document.querySelector('#ai-view .ai-empty .atlas-bot-live'), ...document.querySelectorAll('#ai-view .ai-empty .atlas-bot-z > i')].map((node) => node.getBoundingClientRect().toJSON()));
    for (const zBox of letterBoxes) assert.ok(zBox.left >= hostBox.left && zBox.right <= hostBox.right && zBox.top >= hostBox.top && zBox.bottom <= hostBox.bottom, 'every Z inside the robot box');
    // The sidebar robot: the sleep frame and a tiny ZZZ revealed one letter at a time.
    const mini = await page.evaluate(() => {
      const badge = document.querySelector('.atlas-nav .nav-item--ai .atlas-bot');
      const after = getComputedStyle(badge, '::after');
      const animations = document.getAnimations().filter((animation) => animation.effect?.target === badge && animation.effect?.pseudoElement === '::after');
      // How many Zs show: the letter plus its visible text-shadow copies.
      const at = (ms) => { animations.forEach((animation) => { animation.pause(); animation.currentTime = ms; }); const style = getComputedStyle(badge, '::after'); return { zs: 1 + [...style.textShadow.matchAll(/rgba?\(([^)]*)\)/g)].filter(([, parts]) => { const values = parts.split(',').map(Number); return (values[3] ?? 1) > 0.3; }).length, opacity: Number(style.opacity) }; };
      const result = { content: after.content, names: animations.map((animation) => animation.animationName).sort(), frame: getComputedStyle(badge).backgroundPositionX, steps: [at(600), at(1800), at(3000), at(5200)] };
      animations.forEach((animation) => animation.play());
      return result;
    });
    assert.equal(mini.content, '"Z"');
    assert.deepEqual(mini.names, ['atlas-bot-z-fade', 'atlas-bot-z-reveal']);
    assert.equal(mini.frame, '66.667%', 'the sleep frame (eyes closed)');
    assert.deepEqual(mini.steps.map((step) => step.zs), [1, 2, 3, 3], 'Z, ZZ, ZZZ');
    assert.ok(mini.steps[2].opacity > 0.5 && mini.steps[3].opacity < 0.05, 'visible, then faded');
    if (process.env.ATLAS_BOT_SHOTS) {
      await page.evaluate(() => document.getAnimations().forEach((animation) => { if (/atlas-bot-z/.test(animation.animationName)) { animation.pause(); animation.currentTime = 3000; } }));
      await page.locator('#ai-view .ai-empty').screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/sleep-zzz-1440.png` });
      await page.locator('.atlas-nav .nav-group[data-nav-group="main"]').screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/nav-sleeping-1440.png` });
      await page.evaluate(() => document.getAnimations().forEach((animation) => { if (/atlas-bot-z/.test(animation.animationName)) animation.play(); }));
    }
    // Hover wakes it immediately: the Z is gone in the same moment.
    await page.hover('#ai-view .ai-empty .atlas-bot-live');
    const woken = await page.evaluate(() => ({
      state: window.AtlasBot.robot.state,
      z: getComputedStyle(document.querySelector('#ai-view .ai-empty .atlas-bot-z')).display,
      mini: getComputedStyle(document.querySelector('.atlas-nav .nav-item--ai .atlas-bot'), '::after').content
    }));
    assert.deepEqual(woken, { state: 'awake', z: 'none', mini: 'none' });
    await until(async () => (await info(page)).scene.eyes === 'open', { message: 'eyes open' });
    assert.equal((await robotInfo(page)).timers, 1, 'one timer: awake returns to idle, then the quiet spell');
    if (process.env.ATLAS_BOT_SHOTS) await page.locator('.atlas-nav .nav-group[data-nav-group="main"]').screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/nav-awake-1440.png` });
  } finally { await close(); }
});

test('wake triggers: tap, sidebar hover, composer focus, typing, a new conversation and an AI task each wake a sleeping robot at once', { skip }, async () => {
  const { page, close } = await openAi({ viewport: { width: 1440, height: 900 } });
  try {
    await page.waitForSelector('#ai-view .ai-empty .atlas-bot-live.is-live', { timeout: 15000 });
    await greeted(page);
    const asleep = async () => { await page.evaluate(() => document.activeElement?.blur?.()); await page.mouse.move(1430, 890); await setRobot(page, 'sleeping'); assert.equal((await robotInfo(page)).state, 'sleeping'); };
    const awake = async (label) => { const now = await robotInfo(page); assert.notEqual(now.state, 'sleeping', `${label} wakes the robot`); return now; };
    await asleep();
    await page.locator('#ai-view .ai-empty .atlas-bot-live__canvas').click();
    assert.equal((await awake('a tap')).state, 'awake');
    await until(async () => (await info(page)).scene.moment === 'react', { message: 'the tap reacts' });
    await asleep();
    await page.hover('.atlas-nav .nav-item--ai');
    assert.equal((await awake('hovering the sidebar robot')).state, 'awake');
    await asleep();
    await page.focus('#ai-view [data-ai-input]');
    assert.equal((await awake('composer focus')).state, 'awake');
    await setRobot(page, 'sleeping');
    const before = (await robotInfo(page)).history.length;
    await page.keyboard.type('Camp');
    assert.equal((await awake('typing')).state, 'awake');
    assert.equal((await robotInfo(page)).history.length, before + 1, 'typing wakes it once, not per key');
    await page.fill('#ai-view [data-ai-input]', '');
    await asleep();
    await page.click('#ai-view [data-ai-new]');
    assert.equal((await awake('a new conversation')).state, 'awake');
    // (The new conversation focuses the composer on the next frame.)
    await frames(page, 3);
    // An AI task: thinking, then answering once however many pieces stream in.
    await asleep();
    const start = (await robotInfo(page)).history.length;
    await page.click('#ai-view .ai-empty__chips [data-ai-suggest="0"]');
    await page.waitForSelector('#ai-view .msg-ai');
    await until(async () => { const now = await robotInfo(page); return !['thinking', 'answering'].includes(now.state); }, { message: 'the answer finishes' });
    const path = (await robotInfo(page)).history.slice(start).map((step) => step.to);
    assert.equal(path[0], 'thinking', `an AI task starts thinking (${path})`);
    assert.equal(path.filter((state) => state === 'answering').length, 1, `answering is one continuous state (${path})`);
    assert.equal(path.at(-1), 'attention', `a proposal waiting for approval asks for attention (${path})`);
    // The finished answer's label is still; only a streaming label follows.
    assert.equal(await page.$eval('#ai-view .msg-ai:last-of-type .msg-ai__who .atlas-bot', (node) => [node.dataset.state, node.hasAttribute('data-atlas-bot-follow')].join()), 'idle,false');
    assert.ok((await robotInfo(page)).timers <= 1);
  } finally { await close(); }
});

test('answering never restarts: repeated updates keep one state (same start, same scene timing)', { skip }, async () => {
  const { page, close } = await openAi({ viewport: { width: 1440, height: 900 } });
  try {
    await page.waitForSelector('#ai-view .ai-empty .atlas-bot-live.is-live', { timeout: 15000 });
    await greeted(page);
    await setRobot(page, 'thinking');
    await setRobot(page, 'answering');
    await until(async () => (await info(page)).scene.base === 'answering', { message: 'answering' });
    const first = await info(page);
    for (let piece = 0; piece < 30; piece += 1) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => { window.AtlasBot.robot.set('answering'); resolve(); })));
    }
    const later = await info(page);
    assert.equal(later.robot.since, first.robot.since, 'the state did not restart');
    assert.equal(later.scene.baseSince, first.scene.baseSince, 'the scene kept its timing');
    assert.ok(later.scene.frames > first.scene.frames, 'it kept moving');

  } finally { await close(); }
});

test('reduced motion: a sleeping robot is still (closed eyes, one still Z, no loops) and every state keeps its own look', { skip }, async () => {
  const { page, close } = await openAi({ viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
  try {
    await page.waitForSelector('#ai-view .atlas-bot-live.is-live', { timeout: 15000 });
    await setRobot(page, 'sleeping');
    await until(async () => { const now = await info(page); return now.scene.eyes === 'closed' && now.running === false; }, { message: 'a still sleeping frame' });
    const still = await page.evaluate(() => {
      const robots = [...document.querySelectorAll('.atlas-bot, .atlas-bot-z > i')];
      const loops = document.getAnimations().filter((animation) => animation.playState === 'running' && robots.includes(animation.effect?.target) && animation.effect.getComputedTiming().endTime === Infinity);
      const letters = [...document.querySelectorAll('#ai-view .ai-empty .atlas-bot-z > i')].map((letter) => Number(getComputedStyle(letter).opacity) > 0.3);
      const badge = document.querySelector('.atlas-nav .nav-item--ai .atlas-bot');
      const shadows = [...getComputedStyle(badge, '::after').textShadow.matchAll(/rgba?\(([^)]*)\)/g)].filter(([, parts]) => (parts.split(',').map(Number)[3] ?? 1) > 0.3).length;
      return { loops: loops.length, letters, mini: getComputedStyle(badge, '::after').content, shadows, frame: getComputedStyle(badge).backgroundPositionX };
    });
    assert.equal(still.loops, 0, 'no running robot animation');
    assert.deepEqual(still.letters, [true, false, false], 'one still Z');
    assert.equal(still.mini, '"Z"');
    assert.equal(still.shadows, 0, 'the sidebar shows one still Z');
    assert.equal(still.frame, '66.667%', 'eyes closed');
    const frames = (await info(page)).scene.frames;
    for (const state of ['listening', 'thinking', 'answering', 'attention', 'error', 'idle']) {
      await setRobot(page, state);
      await until(async () => (await info(page)).scene.base === ({ idle: 'idle' }[state] || state), { message: state });
      assert.equal((await shown(page)).nav, state, `${state} still shows on the sidebar robot`);
    }
    await until(async () => (await info(page)).running === false, { message: 'no loop' });
    assert.ok((await info(page)).scene.frames > frames, 'each change draws one still frame');
  } finally { await close(); }
});

// The small robot under reduced motion (the system setting or Atlas's own):
// no movement, and still every state looks different, so none is shown by
// animation alone.
for (const [label, contextOptions, own] of [['system setting', { reducedMotion: 'reduce' }, false], ['Atlas setting', {}, true]]) {
  test(`reduced motion (${label}): the small robot shows every state still, each with a look of its own`, { skip }, async () => {
    const { fixtures } = aiFixtures();
    const { page, close } = await launchAtlas({ user: USERS.admin, fixtures, hash: '#home', viewport: { width: 1440, height: 900 }, contextOptions, fixedTime: AI_FIXTURE_NOW });
    try {
      if (own) await page.evaluate(() => document.documentElement.classList.add('atlas-reduce-motion'));
      await page.mouse.move(1400, 600);
      const looks = {};
      for (const state of ['idle', 'awake', 'sleeping', 'listening', 'thinking', 'answering', 'success', 'attention', 'error']) {
        await setRobot(page, state);
        await frames(page, 2);
        const look = await page.$eval('.atlas-nav .nav-item--ai .atlas-bot', (node) => {
          const style = getComputedStyle(node);
          const moving = node.getAnimations().filter((animation) => animation.playState === 'running').map((animation) => animation.animationName || animation.transitionProperty).join(',');
          return { state: node.dataset.state, moving, animation: style.animationName, look: [style.backgroundPosition, style.filter, style.opacity, style.boxShadow, style.transform].join(' | ') };
        });
        assert.equal(look.state, state);
        assert.equal(look.animation, 'none', `${state}: no animation declared`);
        assert.equal(look.moving, '', `${state}: no movement`);
        looks[state] = look.look;
      }
      const seen = new Map();
      for (const [state, look] of Object.entries(looks)) {
        assert.ok(!seen.has(look), `${state} looks the same as ${seen.get(look)}`);
        seen.set(look, state);
      }
    } finally { await close(); }
  });
}

// Under reduced motion only a change draws a (still) frame, and that frame may
// stay on screen for a long while: it must show the state, never the pose of
// a moment (a greeting wave, a success smile) that is over or was cut short.
test('reduced motion: the still frame after a moment shows the state (an error right after a success is dimmed, not smiling; the greeting wave ends)', { skip }, async () => {
  const { page, close } = await openAi({ viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
  // Sets the state and waits for the still frame it draws.
  const drawnAs = async (state) => {
    const before = (await info(page)).scene.frames;
    await setRobot(page, state);
    await until(async () => { const now = await info(page); return now.scene.frames > before && now.running === false; }, { message: `${state}: a still frame` });
    return (await info(page)).scene;
  };
  try {
    await page.waitForSelector('#ai-view .atlas-bot-live.is-live', { timeout: 15000 });
    await until(async () => (await info(page))?.scene?.greetings === 1, { message: 'greeted' });
    // The still greeting lasts 1.2 s (on the page's clock); nothing is drawn
    // after it until a change.
    const greetedAt = await page.evaluate(() => performance.now());
    await until(() => page.evaluate((at) => performance.now() - at > 1300, greetedAt), { message: 'the still greeting is over' });
    let scene = await drawnAs('listening');
    assert.equal(scene.moment, null, 'the greeting is over');
    assert.equal(scene.eyes, 'open', 'listening: open eyes, not the greeting smile');
    // A success, then (before its smile would end) an error.
    scene = await drawnAs('success');
    assert.equal(scene.eyes, 'happy', 'success smiles');
    scene = await drawnAs('error');
    assert.equal(scene.moment, null, 'the success smile ends with the new state');
    assert.equal(scene.eyes, 'open', 'error: no smile');
    assert.ok(scene.pose.eyeLight < 0.8 && scene.pose.glow < 0.8, `error is dimmed (${scene.pose.eyeLight}, ${scene.pose.glow})`);
    // A success that ends by itself: the still idle frame drawn then has no smile.
    await drawnAs('success');
    const before = (await info(page)).scene.frames;
    await until(async () => (await robotInfo(page)).state === 'idle', { timeout: 5000, message: 'success returns to idle' });
    await until(async () => { const now = await info(page); return now.scene.frames > before && now.running === false; }, { message: 'idle: a still frame' });
    scene = (await info(page)).scene;
    assert.equal(scene.moment, null);
    assert.equal(scene.eyes, 'open', 'idle after success: the smile is over');
  } finally { await close(); }
});

test('hidden tab and off screen: drawing and the timer stop; they resume cleanly', { skip }, async () => {
  const { page, close } = await openAi({ viewport: { width: 1440, height: 900 } });
  try {
    await page.waitForSelector('#ai-view .ai-empty .atlas-bot-live.is-live', { timeout: 15000 });
    await setRobot(page, 'thinking');
    await until(async () => (await info(page)).running === true, { message: 'running' });
    await setRobot(page, 'idle');
    assert.equal((await robotInfo(page)).timers, 1);
    const visibility = (hidden) => page.evaluate((value) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    await visibility(true);
    await until(async () => (await info(page)).running === false, { message: 'hidden stops drawing' });
    assert.equal((await robotInfo(page)).timers, 0, 'no timer while hidden');
    const frames = (await info(page)).scene.frames;
    await page.evaluate(() => new Promise((resolve) => { let count = 0; const tick = () => (++count >= 8 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
    assert.equal((await info(page)).scene.frames, frames, 'no frames while hidden');
    await visibility(false);
    await until(async () => (await info(page)).running === true, { message: 'shows again: drawing resumes' });
    assert.equal((await robotInfo(page)).timers, 1, 'one timer again');
    // Off screen (scrolled or moved away): drawing stops; back: it resumes.
    await page.$eval('#ai-view .ai-empty .atlas-bot-live', (host) => { host.style.transform = 'translateY(-4000px)'; });
    await until(async () => { const now = await info(page); return now.visible === false && now.running === false; }, { message: 'off screen stops' });
    await page.$eval('#ai-view .ai-empty .atlas-bot-live', (host) => { host.style.transform = ''; });
    await until(async () => { const now = await info(page); return now.visible === true && now.running === true; }, { message: 'on screen resumes' });
  } finally { await close(); }
});

test('no duplicates: navigation, open/close, new conversations, focus/blur, hidden/shown and resizing keep one timer, one scene, one context, one set of listeners', { skip }, async () => {
  const initScript = () => {
    window.webglContextCalls = 0;
    window.pointerListeners = 0;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
      if (String(type).startsWith('webgl')) window.webglContextCalls += 1;
      return original.call(this, type, ...rest);
    };
    const add = window.addEventListener;
    const remove = window.removeEventListener;
    window.addEventListener = function addEventListener(type, ...rest) { if (type === 'pointermove') window.pointerListeners += 1; return add.call(this, type, ...rest); };
    window.removeEventListener = function removeEventListener(type, ...rest) { if (type === 'pointermove') window.pointerListeners -= 1; return remove.call(this, type, ...rest); };
  };
  const { page, close, record } = await openAi({ viewport: { width: 1440, height: 900 }, initScript });
  try {
    await page.waitForSelector('#ai-view .ai-empty .atlas-bot-live.is-live', { timeout: 15000 });
    await until(async () => (await info(page))?.scene?.frames > 2, { message: 'robot frames' });
    const base = await page.evaluate(() => ({ contexts: window.webglContextCalls, pointers: window.pointerListeners }));
    const visibility = (hidden) => page.evaluate((value) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    for (let round = 0; round < 4; round += 1) {
      await page.evaluate(() => window.AtlasShell.navigate('#home'));
      await page.waitForFunction(() => document.body.dataset.atlasView !== 'ai');
      assert.ok((await robotInfo(page)).timers <= 1);
      await page.evaluate(() => window.AtlasShell.navigate('#ai/new'));
      await page.waitForSelector('#ai-view .ai-empty .atlas-bot-live');
      await page.click('#ai-view [data-ai-new]');
      await page.focus('#ai-view [data-ai-input]');
      await page.keyboard.type('x');
      await page.evaluate(() => document.activeElement.blur());
      await page.fill('#ai-view [data-ai-input]', '');
      await visibility(true);
      assert.equal((await robotInfo(page)).timers, 0);
      await visibility(false);
      await page.setViewportSize(round % 2 ? { width: 1440, height: 900 } : { width: 1366, height: 768 });
      assert.ok((await robotInfo(page)).timers <= 1, `round ${round}: one timer at most`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await setRobot(page, 'idle');
    await until(async () => (await info(page))?.running === true, { message: 'drawing again' });
    const after = await robotInfo(page);
    assert.equal(after.timers, 1, 'exactly one timer (the quiet spell)');
    assert.equal(after.liveRobots, 1, 'one live robot');
    assert.equal(await page.locator('canvas.atlas-bot-live__canvas').count(), 1, 'one canvas');
    assert.equal(await page.locator('#ai-view .atlas-bot-z').count(), 1, 'one Z element');
    assert.deepEqual(await page.evaluate(() => ({ contexts: window.webglContextCalls, pointers: window.pointerListeners })), base, 'no new WebGL context, no new pointer listener');
    assert.equal((await info(page)).scene.greetings, 1, 'no second greeting');
    assert.deepEqual(record?.pageErrors || [], []);
  } finally { await close(); }
});

// The sleeping Z of a small badge is a pseudo-element: its box is computed
// from its style (position and size), widened by its two text-shadow copies
// (the second and third Z) and its rise.
const miniZ = (page, selector) => page.evaluate((css) => {
  const badge = document.querySelector(css);
  const style = getComputedStyle(badge, '::after');
  if (style.content === 'none') return null;
  const box = badge.getBoundingClientRect();
  const width = parseFloat(style.width);
  const height = parseFloat(style.height);
  const left = box.left + parseFloat(style.left);
  const bottom = box.bottom - parseFloat(style.bottom);
  const offsets = [[0, 0], ...[...style.textShadow.matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)].map(([, x, y]) => [Number(x), Number(y)])];
  const xs = offsets.flatMap(([x]) => [left + x, left + x + width]);
  const ys = offsets.flatMap(([, y]) => [bottom + y - height - 2, bottom + y]);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}, selector);
const textRect = (page, selector) => page.evaluate((css) => {
  const node = document.querySelector(css);
  if (!node || !node.getClientRects().length) return null;
  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  return rect.width ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
}, selector);
const boxOf = (page, selector) => page.evaluate((css) => { const node = document.querySelector(css); if (!node || !node.getClientRects().length) return null; const rect = node.getBoundingClientRect(); return rect.width ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null; }, selector);
const overlaps = (a, b) => Boolean(a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom);

for (const [label, viewport, mobile, badge, item, others] of [
  ['expanded sidebar 1440', { width: 1440, height: 900 }, false, '.atlas-nav .nav-item--ai .atlas-bot', '.atlas-nav .nav-item--ai', ['.atlas-nav .nav-item--ai .nav-item-label', '.atlas-nav .nav-item[data-nav-id="home"] .nav-item-label', '.atlas-nav .nav-item[data-nav-id="messages"] .nav-item-label']],
  ['collapsed sidebar (rail) 1024', { width: 1024, height: 768 }, false, '.atlas-nav .nav-item--ai .atlas-bot', '.atlas-nav .nav-item--ai', []],
  ['phone tab bar 390', { width: 390, height: 844 }, true, '.atlas-tabbar__item--ai .atlas-bot', '.atlas-tabbar__item--ai', ['.atlas-tabbar__item--ai > span:not(.atlas-bot)', '.atlas-tabbar__item[data-nav-id="inventory"] > span', '.atlas-tabbar__item[data-nav-id="recipes"] > span']],
  ['narrow phone tab bar 360', { width: 360, height: 640 }, true, '.atlas-tabbar__item--ai .atlas-bot', '.atlas-tabbar__item--ai', ['.atlas-tabbar__item--ai > span:not(.atlas-bot)', '.atlas-tabbar__item[data-nav-id="inventory"] > span', '.atlas-tabbar__item[data-nav-id="recipes"] > span']],
]) {
  test(`the small robot sleeps in the ${label}: its ZZZ stays in the item and never touches a label, an unread badge or the bar's edge`, { skip }, async () => {
    const { fixtures } = aiFixtures();
    const { page, close } = await launchAtlas({ user: USERS.admin, fixtures, hash: '#home', viewport, contextOptions: mobile ? { hasTouch: true, isMobile: true } : {}, fixedTime: AI_FIXTURE_NOW });
    try {
      // Unread badges showing (Messages in the sidebar, More in the tab bar).
      await page.evaluate(() => document.querySelectorAll('[data-nav-badge]').forEach((node) => { node.hidden = false; node.textContent = '12'; }));
      await page.mouse.move(viewport.width - 2, viewport.height / 2);
      await setRobot(page, 'sleeping');
      assert.equal(await page.$eval(badge, (node) => node.dataset.state), 'sleeping');
      // ZZZ fully shown (the widest moment).
      await page.evaluate(() => document.getAnimations().forEach((animation) => { if (/atlas-bot-z/.test(animation.animationName)) { animation.pause(); animation.currentTime = 3000; } }));
      const z = await miniZ(page, badge);
      assert.ok(z, 'the Z shows');
      const home = await boxOf(page, item);
      assert.ok(z.left >= home.left - 0.5 && z.right <= home.right + 0.5, `Z inside its item horizontally (${JSON.stringify(z)} in ${JSON.stringify(home)})`);
      for (const other of [...others, '[data-nav-badge="messages"]', '[data-nav-badge="more"]', '.atlas-brand']) {
        assert.equal(overlaps(z, await textRect(page, other) || await boxOf(page, other)), false, `Z clear of ${other}`);
      }
      if (mobile) {
        const bar = await boxOf(page, '#atlas-tabbar');
        assert.ok(z.top >= bar.top && z.bottom <= bar.bottom, 'Z inside the tab bar');
      } else {
        const sidebar = await boxOf(page, '.atlas-sidebar');
        assert.ok(z.right <= sidebar.right && z.left >= sidebar.left, 'Z inside the sidebar');
      }
      if (process.env.ATLAS_BOT_SHOTS) {
        const shot = mobile ? '#atlas-tabbar' : '.atlas-nav .nav-group[data-nav-group="main"]';
        await page.locator(shot).screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/mini-sleeping-${viewport.width}x${viewport.height}.png` });
      }
      // Hovering (or tapping) the item wakes it: the Z is gone at once.
      await page.evaluate(() => document.getAnimations().forEach((animation) => animation.play()));
      if (mobile) await page.tap(item); else await page.hover(item);
      assert.notEqual(await page.$eval(badge, (node) => node.dataset.state), 'sleeping');
      assert.equal(await miniZ(page, badge), null, 'no Z once awake');
      if (process.env.ATLAS_BOT_SHOTS && !mobile) await page.locator('.atlas-nav .nav-group[data-nav-group="main"]').screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/mini-awake-${viewport.width}x${viewport.height}.png` });
    } finally { await close(); }
  });
}

test('Daily Briefing: the robot thinks while the briefing is prepared, then rests; badges keep their animation phase when drawn again', { skip }, async () => {
  const { fixtures } = aiFixtures();
  const { page, close } = await launchAtlas({ user: USERS.admin, fixtures, hash: '#home', fixedTime: AI_FIXTURE_NOW });
  try {
    await page.waitForSelector('.home-briefing .home-briefing__head .atlas-bot');
    assert.equal(await page.$eval('.home-briefing__head .atlas-bot', (node) => node.dataset.state), 'idle', 'ready: idle');
    // Before the shell's data, the venue clock and the checklists are there,
    // Home prepares the briefing: the robot thinks (and the text says so).
    const seen = await page.evaluate(async () => {
      const saved = { clock: window.AtlasVenueClock, operations: window.AtlasOperations, loaded: window.AtlasShell.dataLoadedAt };
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const read = () => { const head = document.querySelector('.home-briefing .home-briefing__head .atlas-bot'); return { state: head?.dataset.state, text: document.querySelector('.home-briefing .home-briefing__text')?.textContent.trim(), animations: head ? head.getAnimations().map((animation) => animation.animationName).sort() : [] }; };
      delete window.AtlasVenueClock;
      delete window.AtlasOperations;
      window.AtlasShell.dataLoadedAt = () => 0;
      window.AtlasShell.navigate('#inventory');
      await frame();
      window.AtlasShell.navigate('#home');
      await frame();
      const preparing = read();
      window.AtlasVenueClock = saved.clock;
      window.AtlasOperations = saved.operations;
      window.AtlasShell.dataLoadedAt = saved.loaded;
      return { preparing };
    });
    assert.equal(seen.preparing.text, 'Preparing today’s briefing…');
    assert.equal(seen.preparing.state, 'thinking', 'thinking while the briefing is prepared');
    assert.ok(seen.preparing.animations.includes('atlas-bot-think'), 'the thinking movement');
    await page.evaluate(() => { window.AtlasShell.navigate('#inventory'); window.AtlasShell.navigate('#home'); });
    await until(() => page.evaluate(() => document.querySelector('.home-briefing .home-briefing__head .atlas-bot')?.dataset.state === 'idle' && !/Preparing/.test(document.querySelector('.home-briefing .home-briefing__text')?.textContent || '')), { message: 'ready: the robot rests' });
    if (process.env.ATLAS_BOT_SHOTS) await page.locator('.home-briefing').screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/briefing-1440.png` });
    // Badges run on the page clock: one drawn now and one drawn later (a label
    // drawn again by a stream update) are in the same phase, never restarted.
    const phase = await page.evaluate(async () => {
      const make = () => { const holder = document.createElement('div'); holder.innerHTML = window.AtlasBot.html({ size: 24, state: 'answering' }); document.body.append(holder); return holder.firstElementChild; };
      const a = make();
      // Half a glow cycle later: a restarted animation would be half a cycle off.
      await new Promise((resolve) => setTimeout(resolve, 1300));
      const b = make();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const glow = (node) => node.getAnimations().find((animation) => animation.animationName === 'atlas-bot-glow');
      const progress = (node) => glow(node).effect.getComputedTiming().progress;
      return [progress(a), progress(b)];
    });
    assert.ok(Math.abs(phase[0] - phase[1]) < 0.08, `same phase: ${phase}`);
  } finally { await close(); }
});
