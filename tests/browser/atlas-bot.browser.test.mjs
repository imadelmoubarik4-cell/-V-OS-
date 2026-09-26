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
    await until(async () => (await info(page))?.scene?.moment === null, { timeout: 15000, message: 'greeting ends' });
    // It looks toward the pointer: down at a pointer below it, up at one above
    // (a positive head pitch tips the face down).
    const centre = box.x + box.width / 2;
    await page.mouse.move(centre, 890, { steps: 3 });
    await until(async () => (await info(page))?.scene?.headPitch > 0.1, { message: 'looks down at a pointer below' });
    await page.mouse.move(centre, 5, { steps: 3 });
    await until(async () => (await info(page))?.scene?.headPitch < -0.1, { message: 'looks up at a pointer above' });
    await page.mouse.move(1400, box.y + box.height * 0.35, { steps: 3 });
    await until(async () => (await info(page))?.scene?.headYaw > 0.1, { message: 'looks right at a pointer to the right' });
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
    assert.match(nav.url, /assets\/atlas-bot\/atlas-bot-small\.png\?v=20261003-bot3/);
    assert.deepEqual([nav.width, nav.height], [288, 96], 'three 96 px frames');
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
    await until(async () => (await info(page))?.scene?.moment === null, { timeout: 15000, message: 'greeting ends' });
    await page.locator('#ai-view .atlas-bot-live__canvas').tap();
    await until(async () => (await info(page))?.scene?.moment === 'react', { message: 'tap reacts' });
    await page.screenshot({ path: process.env.ATLAS_BOT_SHOTS ? `${process.env.ATLAS_BOT_SHOTS}/ai-empty-390.png` : undefined });
  } finally { await close(); }
});

for (const [label, viewport, mobile] of [
  ['tablet portrait 768×1024', { width: 768, height: 1024 }, true],
  ['tablet landscape 1024×768', { width: 1024, height: 768 }, true],
  ['phone landscape 844×390', { width: 844, height: 390 }, true],
  ['laptop 1280×720', { width: 1280, height: 720 }, false],
]) {
  test(`responsive ${label}: the robot fits, overlaps neither the greeting, the suggestions nor the composer, and nothing scrolls sideways`, { skip }, async () => {
    const { page, close } = await openAi({ viewport, contextOptions: mobile ? { hasTouch: true, isMobile: true } : {} });
    try {
      await page.waitForSelector('#ai-view .ai-empty .atlas-bot-live', { timeout: 15000 });
      await settle(page);
      if (process.env.ATLAS_BOT_SHOTS) await page.screenshot({ path: `${process.env.ATLAS_BOT_SHOTS}/ai-empty-${viewport.width}x${viewport.height}.png` });
      const box = async (selector) => page.locator(selector).first().boundingBox();
      // The workspace fits the window: the page itself does not scroll and the
      // conversation header is on screen.
      assert.equal(await page.evaluate(() => Math.round(document.scrollingElement.scrollTop)), 0, 'the page did not scroll');
      assert.ok(await page.evaluate(() => document.querySelector('#ai-view .ai-layout').getBoundingClientRect().bottom <= innerHeight + 1), 'the Atlas AI workspace fits the window');
      const bot = await box('#ai-view .ai-empty .atlas-bot-live');
      const greeting = await box('#ai-view .ai-empty__greeting');
      const chips = await box('#ai-view .ai-empty__chips');
      const composer = await box('#ai-view [data-ai-composer]');
      assert.ok(bot && bot.width >= 96 && bot.width <= 200, `robot size ${bot?.width}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
      assert.ok(bot.x >= 0 && bot.x + bot.width <= viewport.width, 'robot inside the viewport horizontally');
      // At the top of the conversation area the whole robot is visible (nothing clipped above the fold).
      const area = await box('#ai-view .ai-scroll');
      assert.ok(bot.y >= area.y - 1, `robot top is not clipped (${bot.y} vs ${area.y})`);
      assert.ok(bot.y + bot.height <= greeting.y + 1, 'robot above the greeting');
      assert.ok(greeting.y + greeting.height <= chips.y + 1, 'greeting above the suggestions');
      // The composer never covers the empty state: it sits below the conversation area,
      // and the last suggestion can be scrolled into view above it.
      assert.ok(area.y + area.height <= composer.y + 1, 'conversation area ends above the composer');
      await page.locator('#ai-view .ai-empty__chips [data-ai-suggest]').last().scrollIntoViewIfNeeded();
      const lastChip = await page.locator('#ai-view .ai-empty__chips [data-ai-suggest]').last().boundingBox();
      assert.ok(lastChip.y + lastChip.height <= composer.y + 1, 'the last suggestion is reachable above the composer');
      const tabbar = await page.locator('#atlas-tabbar').boundingBox().catch(() => null);
      if (tabbar && tabbar.height > 0) assert.ok(composer.y + composer.height <= tabbar.y + 1, 'composer clears the tab bar');
      assert.ok(composer.y + composer.height <= viewport.height + 1, 'composer is not clipped');
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
    await until(async () => (await info(page))?.scene?.moment === null, { timeout: 15000, message: 'greeting ends' });
    await page.evaluate(() => window.AtlasBot.setIdleTimeout(300));
    await until(async () => { const now = await info(page); return now.running === false && now.paused === true; }, { message: 'paused while idle' });
    const still = (await info(page)).scene.frames;
    await frames(page, 10);
    assert.equal((await info(page)).scene.frames, still, 'no frames while paused');
    await page.mouse.move(300, 300);
    await page.mouse.move(700, 400, { steps: 3 });
    await until(async () => (await info(page)).running === true, { message: 'pointer resumes' });
    await until(async () => (await info(page)).paused === true, { message: 'pauses again' });
    await page.evaluate(() => window.AtlasBot.setState('ai-empty', 'thinking'));
    await until(async () => (await info(page)).running === true, { message: 'state resumes' });
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));
    assert.equal((await info(page)).running, true, 'a busy state keeps drawing');
    await page.evaluate(() => window.AtlasBot.setState('ai-empty', 'idle'));
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
