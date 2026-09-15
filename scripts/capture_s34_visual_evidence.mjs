import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const modules = [
  'home',
  'operations',
  'inventory',
  'stock',
  'recipes',
  'purchasing',
  'messages',
  'team',
  'shifts',
  'knowledge',
  'brain',
  'settings'
];

const modes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
];

const fixturePath = resolve('tests/fixtures/s34-visual-review.html');
const outputDirectory = resolve(
  process.env.S34_EVIDENCE_DIR || 'artifacts/s34-visual-evidence'
);
const screenshotDirectory = resolve(outputDirectory, 'screenshots');

const forbiddenEvidence = [
  /\bimad\b/i,
  /@v[aá]bar\.is/i,
  /@xn--vbar-5na\.is/i,
  /\.supabase\.co/i,
  /\.chatgpt\.site/i
];

const fixtureSource = await readFile(fixturePath, 'utf8');
for (const pattern of forbiddenEvidence) {
  if (pattern.test(fixtureSource)) {
    throw new Error(`Fixture failed the synthetic-data gate: ${pattern}`);
  }
}

await mkdir(screenshotDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });
const captures = [];

try {
  for (const mode of modes) {
    const context = await browser.newContext({
      viewport: { width: mode.width, height: mode.height },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      serviceWorkers: 'block'
    });

    await context.route('**/*', async (route) => {
      const protocol = new URL(route.request().url()).protocol;
      if (protocol === 'file:' || protocol === 'data:') {
        await route.continue();
        return;
      }
      await route.abort('blockedbyclient');
    });

    const page = await context.newPage();
    for (const moduleName of modules) {
      const fixtureUrl = pathToFileURL(fixturePath);
      fixtureUrl.searchParams.set('module', moduleName);
      fixtureUrl.searchParams.set('mode', mode.name);
      await page.goto(fixtureUrl.href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);

      const renderedText = await page.locator('body').innerText();
      for (const pattern of forbiddenEvidence) {
        if (pattern.test(renderedText)) {
          throw new Error(`${moduleName}/${mode.name} failed the synthetic-data gate: ${pattern}`);
        }
      }

      const layout = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight
      }));
      if (layout.scrollWidth > mode.width) {
        throw new Error(
          `${moduleName}/${mode.name} has horizontal overflow: ${layout.scrollWidth}px > ${mode.width}px`
        );
      }

      const filename = `${String(captures.length + 1).padStart(2, '0')}-${moduleName}-${mode.name}.png`;
      const relativePath = `screenshots/${filename}`;
      const bytes = await page.screenshot({
        path: resolve(outputDirectory, relativePath),
        animations: 'disabled',
        caret: 'hide',
        fullPage: false
      });

      captures.push({
        module: moduleName,
        mode: mode.name,
        viewport: { width: mode.width, height: mode.height },
        layout,
        path: relativePath,
        sha256: createHash('sha256').update(bytes).digest('hex')
      });
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const manifest = {
  schema_version: 1,
  evidence: 'Atlas S34 synthetic after-state visual contract',
  source_fixture: 'tests/fixtures/s34-visual-review.html',
  commit: process.env.GITHUB_SHA || 'local',
  hosted_changes: false,
  production_changes: false,
  remote_requests_allowed: false,
  modules,
  modes,
  capture_count: captures.length,
  captures
};

await writeFile(
  resolve(outputDirectory, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8'
);

const galleryCards = captures.map((capture) => `
  <figure>
    <img src="${capture.path}" width="${capture.viewport.width}" height="${capture.viewport.height}" alt="${capture.module} ${capture.mode} synthetic S34 evidence">
    <figcaption>${capture.module} · ${capture.mode} · ${capture.viewport.width} × ${capture.viewport.height}</figcaption>
  </figure>`).join('');

await writeFile(resolve(outputDirectory, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Atlas S34 synthetic visual evidence</title>
  <style>
    :root{font-family:system-ui,sans-serif;color:#18201d;background:#eef3f8}
    body{margin:0;padding:24px}h1{margin:0 0 8px}.notice{margin:0 0 24px;color:#52616d}
    main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px}
    figure{margin:0;padding:12px;background:white;border:1px solid #d7e0e8;border-radius:16px}
    img{display:block;width:100%;height:auto;border:1px solid #d7e0e8}
    figcaption{padding:10px 2px 2px;font-weight:700;text-transform:capitalize}
  </style>
</head>
<body>
  <h1>Atlas S34 synthetic visual evidence</h1>
  <p class="notice">Local fixture only · no hosted services · no production data · commit ${manifest.commit}</p>
  <main>${galleryCards}
  </main>
</body>
</html>
`, 'utf8');

console.log(`Captured ${captures.length} synthetic S34 screenshots in ${outputDirectory}`);
