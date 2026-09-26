#!/usr/bin/env node
// Renders the small Atlas AI robot images (apps/web/assets/atlas-bot/)
// from the same 3D scene as the live robot (assets/atlas-bot/atlas-mascot-scene.js),
// so the badge and the interactive robot are one model. Needs Playwright with
// Chromium (WebGL through SwiftShader is enough):
//
//   node scripts/build_atlas_mascot.mjs && node scripts/render_atlas_bot_badges.mjs
//
// Output, each one sprite of three frames side by side (open, blink, happy)
// on a transparent background, shown by .atlas-bot (atlas-components.css),
// which blinks and smiles by moving the background between frames:
//   atlas-bot.png        160 px frames, the head (badges above 24 px)
//   atlas-bot-small.png   96 px frames for badges of 24 px or less: a tighter
//                         crop on the face, a matte visor with no highlight
//                         and larger, brighter eyes (look 'small'), so the face
//                         still reads at 18-20 px instead of a dark blob.
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

const SPRITES = [
  { file: 'atlas-bot.png', size: 160, framing: 'badge', look: 'normal' },
  { file: 'atlas-bot-small.png', size: 96, framing: 'badge-small', look: 'small' }
];
const FRAMES = { open: { happy: 0 }, blink: { happy: 0, blink: 0.12 }, happy: { happy: 1 } };
const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent">
<script type="module">
  import { createMascotScene } from '/assets/atlas-bot/atlas-mascot-scene.js';
  window.render = ({ size, framing, look }, frames) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    document.body.append(canvas);
    const scene = createMascotScene(canvas, { reducedMotion: true, framing, look });
    scene.resize(size, size, 1);
    const urls = frames.map((overrides) => { scene.renderStatic(overrides); scene.renderStatic(overrides); return canvas.toDataURL('image/png'); });
    scene.dispose();
    canvas.remove();
    return urls;
  };
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
  for (const sprite of SPRITES) {
    const frames = await tab.evaluate(([options, overrides]) => window.render(options, overrides), [sprite, Object.values(FRAMES)]);
    // Stitch the frames into one sprite in the page (no image library needed).
    const png = await tab.evaluate(async ({ urls, size }) => {
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
    }, { urls: frames, size: sprite.size });
    writeFileSync(path.join(OUT, sprite.file), Buffer.from(png.split(',')[1], 'base64'));
    console.log(`${sprite.file} (${Object.keys(FRAMES).join(', ')}, ${sprite.size} px)`);
  }
} finally {
  await browser.close();
  server.close();
}
