#!/usr/bin/env node
// Builds the Atlas manuals from Markdown:
//
//   Atlas_User_Guide.md        -> Atlas_User_Guide_Print.html  + Atlas_User_Guide.pdf
//   Atlas_Quick_Start_Guide.md -> Atlas_Quick_Start_Guide.html + Atlas_Quick_Start_Guide.pdf
//
// Usage (from the repository root):
//   node docs/manual/tools/build_manual.mjs                 both guides, HTML + PDF
//   node docs/manual/tools/build_manual.mjs --html-only     HTML only (no browser needed)
//   node docs/manual/tools/build_manual.mjs --only quick    one guide (user | quick)
//   node docs/manual/tools/build_manual.mjs --showcase --out <dir> [--assets <dir>]
//                                                           component showcase (tools/showcase.md)
//   node docs/manual/tools/build_manual.mjs --src <file.md> --out <dir>
//                                                           any other source (draft chapters, tests)
//   --assets <dir>   extra folder searched for images the manual root does not have
//   --no-fonts       do not fetch the web fonts (use the fallback font stack)
//
// PDFs are printed by Playwright's Chromium (page.pdf, A4, backgrounds on).
// Playwright is loaded like tests/browser/harness.mjs does: ATLAS_PLAYWRIGHT,
// the repo's node_modules, a global install. Run browser builds one at a time
// on shared machines: flock <lockfile> node ...
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRenderer } from './lib/render.mjs';
import { escapeHtml } from './lib/markdown.mjs';
import { namedDestinations } from './lib/pdf-dests.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MANUAL = path.resolve(here, '..');
const REPO = path.resolve(MANUAL, '../..');

// Same families and weights index.html loads (plus Plex Sans italic for emphasis).
const FONT_URL = 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap';

export const GUIDES = {
  user: { src: 'Atlas_User_Guide.md', html: 'Atlas_User_Guide_Print.html', pdf: 'Atlas_User_Guide.pdf', kind: 'user' },
  quick: { src: 'Atlas_Quick_Start_Guide.md', html: 'Atlas_Quick_Start_Guide.html', pdf: 'Atlas_Quick_Start_Guide.pdf', kind: 'quick' }
};

function cssString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

/** Wraps a rendered body in a complete, standalone HTML document. */
export function htmlDocument({ body, frontmatter: fm, outDir, kind, fonts = true }) {
  const css = path.relative(outDir, path.join(MANUAL, 'theme/manual.css')).split(path.sep).join('/');
  const title = fm['doc-title'] || ['Atlas', fm.title].filter(Boolean).join(' ');
  const footer = fm.footer || fm.version || '';
  const chapterStart = fm['chapter-start'] === 'right' ? 'right' : 'page';
  return `<!doctype html>
<html lang="${escapeHtml(fm.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${fm.description ? `<meta name="description" content="${escapeHtml(fm.description)}">\n` : ''}${fonts ? `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONT_URL}">
` : ''}<link rel="stylesheet" href="${escapeHtml(css)}">
<style>
@page { @bottom-left { content: ${cssString(footer)}; } }
@page cover { @bottom-left { content: none; } }
@page blank { @bottom-left { content: none; } }
.m-chapter { break-before: ${chapterStart}; }
</style>
</head>
<body class="m-doc m-doc--${escapeHtml(kind)}" data-chapter-start="${chapterStart}">
${body}
</body>
</html>
`;
}

export function renderGuide({ src, outDir, kind, assetRoots = [], fonts = true }) {
  const renderer = createRenderer({ root: MANUAL, outDir, assetRoots });
  const source = readFileSync(src, 'utf8');
  const doc = renderer.renderDocument(source, { file: src });
  return { html: htmlDocument({ ...doc, outDir, kind, fonts }), headings: doc.headings, warnings: doc.warnings, frontmatter: doc.frontmatter };
}

export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const candidates = [process.env.ATLAS_PLAYWRIGHT, path.join(REPO, 'node_modules/playwright'), 'playwright',
    path.join(path.dirname(process.execPath), '../lib/node_modules/playwright')].filter(Boolean);
  for (const candidate of candidates) {
    try { return req(candidate); } catch { /* next */ }
  }
  return null;
}

async function printPdf(browser, htmlPath, pdfPath, { fonts }) {
  const context = await browser.newContext();
  if (fonts) {
    // Fetch the web fonts through Playwright (Node's TLS and CA settings, the
    // browser context's proxy) and hand them to the page.
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route) => {
      try { await route.fulfill({ response: await route.fetch() }); } catch { await route.abort(); }
    });
  }
  const page = await context.newPage();
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    if (fonts) {
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }
    await page.evaluate(() => document.fonts.ready);
    const fontsOk = await page.evaluate(() => document.fonts.check('16px "IBM Plex Sans"') && [...document.fonts].some((f) => f.family.includes('IBM Plex Sans') && f.status === 'loaded'));
    // wait for every image (screenshots are local files)
    await page.evaluate(() => Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })))));
    const options = { format: 'A4', printBackground: true, preferCSSPageSize: true, outline: true, tagged: true };
    // Where did each heading land? Chromium writes a named destination for
    // every in-page link target, so a probe of invisible links to every
    // heading is added for measuring prints only.
    const measure = async () => {
      await page.evaluate(() => {
        const nav = document.createElement('nav');
        nav.id = 'm-probe';
        nav.setAttribute('aria-hidden', 'true');
        nav.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;overflow:hidden;font-size:1px;color:transparent';
        for (const el of document.querySelectorAll('h1[id], h2[id], h3[id]')) {
          const a = document.createElement('a');
          a.href = `#${el.id}`;
          a.textContent = '.';
          nav.append(a);
        }
        document.body.prepend(nav);
      });
      const { dests } = namedDestinations(await page.pdf(options));
      await page.evaluate(() => document.getElementById('m-probe')?.remove());
      return dests;
    };
    let dests = await measure();

    // Chapters on right-hand pages (front matter `chapter-start: right`).
    // Chromium treats break-before: right as a plain page break, so insert a
    // blank, footer-less page before every chapter that would land on an even
    // page. A chapter already starts a new page, so each blank page shifts the
    // rest by exactly one: one measuring pass is enough.
    if (await page.evaluate(() => document.body.dataset.chapterStart === 'right')) {
      const chapters = await page.evaluate(() => [...document.querySelectorAll('.m-chapter')].map((s) => s.querySelector('h1[id]')?.id || null));
      let shift = 0;
      const blanks = [];
      chapters.forEach((id, k) => {
        const at = id && dests.get(id);
        if (at && (at + shift) % 2 === 0) { blanks.push(k); shift++; }
      });
      if (blanks.length) {
        await page.evaluate((list) => {
          const sections = [...document.querySelectorAll('.m-chapter')];
          for (const k of list) {
            const blank = document.createElement('div');
            blank.className = 'm-blankpage';
            blank.setAttribute('aria-hidden', 'true');
            sections[k].before(blank);
          }
        }, blanks);
        dests = await measure();
      }
    }

    // Table of contents: write the page numbers in, measure again, repeat
    // until stable (the numbers rarely change the TOC's own length).
    const tocIds = await page.evaluate(() => [...document.querySelectorAll('[data-toc-page]')].map((el) => el.dataset.tocPage));
    const pages = {};
    for (let pass = 0; tocIds.length && pass < 3; pass++) {
      const next = Object.fromEntries(tocIds.map((id) => [id, dests.get(id) ?? '']));
      if (JSON.stringify(next) === JSON.stringify(pages)) break;
      Object.assign(pages, next);
      await page.evaluate((map) => {
        for (const el of document.querySelectorAll('[data-toc-page]')) el.textContent = map[el.dataset.tocPage] ?? '';
      }, pages);
      dests = await measure();
    }
    const buffer = await page.pdf(options);
    writeFileSync(pdfPath, buffer);
    const { pageCount } = namedDestinations(buffer);
    // the built HTML keeps page numbers and blank pages, so it prints the same
    const html = `<!doctype html>\n${await page.evaluate(() => document.documentElement.outerHTML)}\n`;
    return { pages, pageCount, fontsOk, html };
  } finally {
    await context.close();
  }
}

function parseArgs(argv) {
  const args = { htmlOnly: false, only: null, showcase: false, src: null, out: null, assets: [], fonts: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--html-only') args.htmlOnly = true;
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--showcase') args.showcase = true;
    else if (a === '--src') args.src = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--assets') args.assets.push(path.resolve(argv[++i]));
    else if (a === '--no-fonts') args.fonts = false;
    else if (a === '--help' || a === '-h') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 21).join('\n')); process.exit(0); }
    else throw new Error(`Unknown argument ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let jobs;
  if (args.src) {
    const base = path.basename(args.src, path.extname(args.src));
    const outDir = args.out || path.dirname(args.src);
    jobs = [{ src: args.src, html: path.join(outDir, `${base}.html`), pdf: path.join(outDir, `${base}.pdf`), kind: 'user' }];
  } else if (args.showcase) {
    if (!args.out) throw new Error('--showcase needs --out <dir> (keep build output out of docs/manual)');
    jobs = [{ src: path.join(here, 'showcase.md'), html: path.join(args.out, 'showcase.html'), pdf: path.join(args.out, 'showcase.pdf'), kind: 'user' }];
  } else {
    const outDir = args.out || MANUAL;
    jobs = Object.entries(GUIDES)
      .filter(([key]) => !args.only || key === args.only)
      .map(([, g]) => ({ src: path.join(MANUAL, g.src), html: path.join(outDir, g.html), pdf: path.join(outDir, g.pdf), kind: g.kind }));
  }

  let browser = null;
  let exitCode = 0;
  try {
    for (const job of jobs) {
      if (!existsSync(job.src)) { console.warn(`skip: ${path.relative(REPO, job.src)} does not exist yet`); continue; }
      const outDir = path.dirname(job.html);
      mkdirSync(outDir, { recursive: true });
      const { html, warnings } = renderGuide({ src: job.src, outDir, kind: job.kind, assetRoots: args.assets, fonts: args.fonts });
      writeFileSync(job.html, html);
      for (const w of warnings) console.warn(`warning (${path.basename(job.src)}): ${w}`);
      console.log(`html: ${path.relative(process.cwd(), job.html)}`);
      if (args.htmlOnly) continue;

      if (!browser) {
        const playwright = loadPlaywright();
        if (!playwright) throw new Error('Playwright not found (set ATLAS_PLAYWRIGHT or install playwright); use --html-only to skip PDFs.');
        const proxy = args.fonts && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
        browser = await playwright.chromium.launch({ proxy });
      }
      const { pageCount, fontsOk, html: printed } = await printPdf(browser, job.html, job.pdf, { fonts: args.fonts });
      if (args.fonts && !fontsOk) console.warn('warning: web fonts did not load; the PDF uses the fallback font stack');
      writeFileSync(job.html, printed);
      console.log(`pdf:  ${path.relative(process.cwd(), job.pdf)} (${pageCount} pages)`);
    }
  } catch (err) {
    console.error(err.message || err);
    exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
  process.exitCode = exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
