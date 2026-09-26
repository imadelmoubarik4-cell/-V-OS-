// The Atlas AI robot (atlas-bot.js): the interactive 3D robot on Atlas AI and
// the robot badge wherever the assistant is the symbol. The Atlas logo stays
// the brand mark. Runs the shipped scene bundle in Chromium (WebGL through
// SwiftShader) against the mocked atlas-ai.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, settle, until, USERS } from './harness.mjs';
import { aiFixtures, AI_FIXTURE_NOW } from './atlas-ai-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

async function openAi({ viewport, contextOptions, initScript, hash = '#ai/new', backend = {} } = {}) {
  const { fixtures, backend: state } = aiFixtures(backend);
  const launched = await launchAtlas({
    user: USERS.admin, fixtures, hash, viewport, contextOptions, initScript,
    fixedTime: AI_FIXTURE_NOW, storage: { 'atlas.ai.voice.explained.v1': 'yes' }
  });
  try {
    await launched.page.waitForFunction(() => document.body.dataset.atlasView === 'ai' && document.querySelector('#ai-view [data-ai-composer]'));
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
    assert.ok(await drawn(page) > 0.08, 'the robot is drawn in the canvas');
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
    await until(async () => (await info(page))?.scene?.moment === null, { timeout: 6000, message: 'greeting ends' });
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
    await page.waitForTimeout(400);
    const first = await info(page);
    await page.waitForTimeout(600);
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
    assert.match(nav.url, /assets\/atlas-bot\/atlas-bot\.png\?v=/);
    assert.deepEqual([nav.width, nav.height], [480, 160], 'three 160 px frames');
    assert.deepEqual(nav.box, [20, 20]);
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
    const bot = await page.locator('#ai-view .ai-empty .atlas-bot-live').boundingBox();
    assert.deepEqual([Math.round(bot.width), Math.round(bot.height)], [136, 136]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    const tabbar = await page.locator('#atlas-tabbar').boundingBox();
    const composer = await page.locator('#ai-view [data-ai-composer]').boundingBox();
    assert.ok(bot.y + bot.height <= composer.y, 'robot sits above the composer');
    assert.ok(composer.y + composer.height <= tabbar.y + 1, 'composer clears the tab bar');
    await until(async () => (await info(page))?.scene?.moment === null, { timeout: 6000, message: 'greeting ends' });
    await page.locator('#ai-view .atlas-bot-live__canvas').tap();
    await until(async () => (await info(page))?.scene?.moment === 'react', { message: 'tap reacts' });
    await page.screenshot({ path: process.env.ATLAS_BOT_SHOTS ? `${process.env.ATLAS_BOT_SHOTS}/ai-empty-390.png` : undefined });
  } finally { await close(); }
});
