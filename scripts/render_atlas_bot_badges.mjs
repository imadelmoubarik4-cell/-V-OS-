#!/usr/bin/env node
// Renders the small Atlas AI robot images (apps/web/assets/atlas-bot/)
// from the same 3D scene as the live robot (assets/atlas-bot/atlas-mascot-scene.js),
// so the badge and the interactive robot are one model. Needs Playwright with
// Chromium (WebGL through SwiftShader is enough):
//
//   node scripts/build_atlas_mascot.mjs && node scripts/render_atlas_bot_badges.mjs
//
// Output: atlas-bot.png, one sprite of three 160 px frames side by side
// (open, blink, happy) on a transparent background, shown at 16-64 px by
// .atlas-bot (atlas-components.css), which blinks and smiles by moving the
// background between frames.
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'apps/web');
const OUT = path.join(WEB, 'assets/atlas-bot');
const require = createRequire(import.meta.url);
const candidates = [process.env.ATLAS_PLAYWRIGHT, 'playwright', path.join(path.dirname(process.execPath), '../lib/node_modules/playwright')].filter(Boolean);
let playwright = null;
for (const candidate of candidates) { try { playwright = require(candidate); break; } catch { /* next */ } }
if (!playwright) throw new Error('Playwright is required (npm i --no-save playwright, or set ATLAS_PLAYWRIGHT)');

const SIZE = 160;
const FRAMES = { open: { happy: 0 }, blink: { happy: 0, blink: 0.12 }, happy: { happy: 1 } };
const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent"><canvas id="c" width="${SIZE}" height="${SIZE}" style="width:${SIZE}px;height:${SIZE}px"></canvas>
<script type="module">
  import { createMascotScene } from '/assets/atlas-bot/atlas-mascot-scene.js';
  const scene = createMascotScene(document.getElementById('c'), { reducedMotion: true, framing: 'badge' });
  scene.resize(${SIZE}, ${SIZE}, 1);
  window.frame = (overrides) => { scene.renderStatic(overrides); scene.renderStatic(overrides); return document.getElementById('c').toDataURL('image/png'); };
  window.ready = true;
</script>`;
const server = createServer((request, response) => {
  if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end(page); return; }
  const file = path.join(WEB, decodeURIComponent(request.url.split('?')[0]));
  if (!file.startsWith(WEB)) { response.statusCode = 403; response.end(); return; }
  try { response.setHeader('content-type', 'text/javascript'); response.end(readFileSync(file)); } catch { response.statusCode = 404; response.end(); }
}).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const browser = await playwright.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const tab = await browser.newPage();
  await tab.goto(`http://127.0.0.1:${server.address().port}/`);
  await tab.waitForFunction(() => window.ready === true);
  mkdirSync(OUT, { recursive: true });
  const frames = [];
  for (const overrides of Object.values(FRAMES)) frames.push(await tab.evaluate((value) => window.frame(value), overrides));
  // Stitch the frames into one sprite in the page (no image library needed).
  const sprite = await tab.evaluate(async ({ urls, size }) => {
    const canvas = document.createElement('canvas');
    canvas.width = size * urls.length;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    for (const [index, url] of urls.entries()) {
      const image = new Image();
      image.src = url;
      await image.decode();
      ctx.drawImage(image, index * size, 0);
    }
    return canvas.toDataURL('image/png');
  }, { urls: frames, size: SIZE });
  writeFileSync(path.join(OUT, 'atlas-bot.png'), Buffer.from(sprite.split(',')[1], 'base64'));
  console.log(`atlas-bot.png (${Object.keys(FRAMES).join(', ')})`);
} finally {
  await browser.close();
  server.close();
}
