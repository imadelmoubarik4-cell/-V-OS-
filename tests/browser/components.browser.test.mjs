// Atlas design system: the component gallery (tests/browser/tools/
// component-gallery.html) rendered from the real atlas-tokens, atlas-base and
// atlas-components stylesheets. Checks the sizes, focus ring, contrast and
// text-size floor the spec sets (docs/design/Atlas_Experience_Redesign.md §5,
// §6) at 1440 (fine pointer) and 390 (coarse pointer), and saves a screenshot
// of each (ATLAS_SCREENSHOT_DIR, or the OS temp directory).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harnessAvailable, loadPlaywright, ROOT, settle } from './harness.mjs';

const ORIGIN = 'http://atlas-gallery.test';
const GALLERY = `${ORIGIN}/tests/browser/tools/component-gallery.html`;
const SHOTS = process.env.ATLAS_SCREENSHOT_DIR || path.join(os.tmpdir(), 'atlas-component-gallery');
const skip = harnessAvailable() ? false : 'browser harness dependencies are unavailable';

function lucidePath() {
  const bases = [process.env.ATLAS_BROWSER_LIBS, path.join(ROOT, 'node_modules')].filter(Boolean);
  return bases.map((base) => path.join(base, 'lucide/dist/umd/lucide.min.js')).find((file) => existsSync(file));
}

async function openGallery({ width, height, mobile }) {
  const playwright = loadPlaywright();
  const browser = await playwright.chromium.launch({ executablePath: process.env.ATLAS_CHROMIUM || undefined });
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  const errors = [];
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }));
  await context.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 404, body: '' }));
  await context.route('https://unpkg.com/**', (route) => {
    const lucide = lucidePath();
    return lucide ? route.fulfill({ contentType: 'text/javascript', body: readFileSync(lucide) }) : route.fulfill({ status: 404, body: '' });
  });
  await context.route(`${ORIGIN}/**`, (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    const allowed = [path.join(ROOT, 'apps/web/assets/'), path.join(ROOT, 'tests/browser/tools/')].some((dir) => file.startsWith(dir));
    if (!allowed || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
    return route.fulfill({ contentType: type, body: readFileSync(file) });
  });
  const page = await context.newPage();
  if (mobile) {
    // Make (pointer: coarse) match, as on a phone.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('response', (response) => { if (response.url().startsWith(ORIGIN) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(GALLERY, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts?.ready);
  // Wait for the skeleton reveal (a 150 ms CSS animation delay) and entrance
  // animations to finish.
  await settle(page);
  return { browser, page, errors };
}

// Runs in the page: element sizes, contrast of text against its effective
// background (alpha-composited up the ancestor chain) and the smallest text.
function measure() {
  const parse = (value) => {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1
  });
  const luminance = ({ r, g, b }) => {
    const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const backgroundOf = (element) => {
    const layers = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
    }
    return layers.reverse().reduce((acc, layer) => over(layer, acc), { r: 255, g: 255, b: 255, a: 1 });
  };
  const contrast = (element) => {
    const style = getComputedStyle(element);
    const bg = backgroundOf(element);
    const fg = over(parse(style.color), bg);
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const box = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { h: Math.round(rect.height), w: Math.round(rect.width), fontSize: parseFloat(style.fontSize), radius: style.borderTopLeftRadius };
  };
  const sizes = {};
  for (const [name, selector] of Object.entries({
    btnSm: '[data-test="btn-sm"]', btnMd: '[data-test="btn-md"]', btnLg: '[data-test="btn-lg"]', btnPrimary: '[data-test="btn-primary"]',
    iconBtn: '[data-test="icon-btn"]', input: '[data-test="input"]', select: '[data-test="select"]', chip: '.atlas-toolbar .atlas-chip',
    segment: '[data-test="segment"]', tab: '.atlas-tabs a', pill: '[data-test="pill-positive"]', badge: '[data-test="badge"]',
    toggle: '[data-test="toggle"]', toast: '[data-test="toast"]', card: '.gallery > .atlas-card', row: '.atlas-row', th: '.atlas-table th',
    td: '.atlas-table td', menuItem: '.atlas-menu__item', title: '.page-head__title'
  })) sizes[name] = box(selector);

  const pairs = {};
  for (const [name, selector] of Object.entries({
    btnPrimary: '[data-test="btn-primary"]', btnSecondary: '[data-test="btn-secondary"]', btnGhost: '[data-test="btn-ghost"]',
    btnDanger: '[data-test="btn-danger"]', btnDangerSolid: '[data-test="btn-danger-solid"]',
    pillPositive: '[data-test="pill-positive"]', pillWarning: '[data-test="pill-warning"]', pillDanger: '[data-test="pill-danger"]',
    pillInfo: '[data-test="pill-info"]', pillNeutral: '[data-test="pill-neutral"]', badge: '[data-test="badge"]',
    chipActive: '.atlas-chip.is-active', chip: '.atlas-toolbar .atlas-chip:not(.is-active)', tab: '.atlas-tabs a:not([aria-current])',
    subtitle: '.page-head__sub', help: '.atlas-field .help', error: '.atlas-field .error', th: '.atlas-table th',
    cellSub: '.atlas-table .cell-sub', selectedRow: '.atlas-table tr.is-selected .cell-primary', rowMeta: '.atlas-row__meta',
    alertDangerBody: '[data-test="alert-danger"] .atlas-alert__body', alertWarningBody: '[data-test="alert-warning"] .atlas-alert__body',
    alertInfoBody: '[data-test="alert-info"] .atlas-alert__body', emptyText: '.atlas-empty__text', toastText: '.atlas-toast__text',
    toastAction: '.atlas-toast__action', kpiDetail: '.atlas-stat__detail', statLabel: '.atlas-stat__label', link: '.atlas-section__link',
    uploadHelp: '.atlas-upload__help', segmentOff: '.atlas-segmented button[aria-pressed="false"]', menuDanger: '.atlas-menu__item--danger'
  })) {
    const element = document.querySelector(selector);
    pairs[name] = element ? contrast(element) : null;
  }

  // Smallest rendered text.
  let smallest = { size: Infinity, text: '' };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const element = node.parentElement;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!rect.width || style.visibility === 'hidden' || style.display === 'none' || element.closest('.sr-only, [aria-hidden="true"]')) continue;
    if (parseFloat(style.color.split(',')[3] ?? '1') === 0 || style.color === 'transparent') continue;
    const size = parseFloat(style.fontSize);
    if (size < smallest.size) smallest = { size, text: node.textContent.trim().slice(0, 40) };
  }
  return {
    sizes,
    pairs,
    smallest,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    coarse: matchMedia('(pointer: coarse)').matches,
    tokens: {
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      legacyAccent: getComputedStyle(document.documentElement).getPropertyValue('--atlas-accent').trim()
    }
  };
}

function assertContrast(pairs) {
  for (const [name, ratio] of Object.entries(pairs)) {
    assert.ok(ratio !== null, `${name} is rendered`);
    assert.ok(ratio >= 4.5, `${name} text contrast ${ratio}:1 is below AA 4.5:1`);
  }
}

test('component gallery at 1440 (fine pointer): sizes, focus ring, contrast, 12 px floor', { skip }, async () => {
  const { browser, page, errors } = await openGallery({ width: 1440, height: 900, mobile: false });
  try {
    mkdirSync(SHOTS, { recursive: true });
    const result = await page.evaluate(measure);
    await page.screenshot({ path: path.join(SHOTS, 'components-1440.png'), fullPage: true });
    assert.deepEqual(errors, []);
    assert.equal(result.coarse, false);
    assert.equal(result.tokens.accent, '#2563eb');
    assert.equal(result.sizes.btnSm.h, 32);
    assert.equal(result.sizes.btnMd.h, 36);
    assert.equal(result.sizes.btnPrimary.h, 36);
    assert.equal(result.sizes.btnLg.h, 44);
    assert.equal(result.sizes.iconBtn.h, 36);
    assert.equal(result.sizes.input.h, 36);
    assert.equal(result.sizes.select.h, 36);
    assert.equal(result.sizes.chip.h, 30);
    assert.equal(result.sizes.segment.h, 28);
    assert.equal(result.sizes.tab.h, 40);
    assert.equal(result.sizes.pill.h, 22);
    assert.equal(result.sizes.badge.h, 18);
    assert.equal(result.sizes.toggle.h, 20);
    assert.equal(result.sizes.toggle.w, 36);
    assert.ok(result.sizes.toast.h >= 44);
    assert.equal(result.sizes.th.h, 36);
    assert.equal(result.sizes.td.h, 48);
    assert.ok(result.sizes.row.h >= 60);
    assert.equal(result.sizes.menuItem.h, 36);
    assert.equal(result.sizes.card.radius, '12px');
    assert.equal(result.sizes.btnMd.radius, '8px');
    assert.equal(result.sizes.input.radius, '8px');
    assert.equal(result.sizes.title.fontSize, 24);
    assertContrast(result.pairs);
    assert.ok(result.smallest.size >= 12, `text below 12 px: ${JSON.stringify(result.smallest)}`);
    assert.ok(result.scrollWidth <= result.innerWidth, 'no horizontal page scroll');

    // Keyboard focus: 2 px accent outline with a 2 px offset.
    await page.focus('[data-test="btn-secondary"]');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor, offset: style.outlineOffset, test: document.activeElement.dataset.test };
    });
    assert.deepEqual(ring, { width: '2px', style: 'solid', color: 'rgb(59, 130, 246)', offset: '2px', test: 'btn-secondary' });
    // Inputs show the accent border and a 3 px ring instead of an outline.
    await page.focus('[data-test="input"]');
    await settle(page);
    const inputFocus = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { border: style.borderTopColor, shadow: style.boxShadow };
    });
    assert.equal(inputFocus.border, 'rgb(59, 130, 246)');
    assert.match(inputFocus.shadow, /rgba\(59, 130, 246, 0\.2\) 0px 0px 0px 3px/);
  } finally {
    await browser.close();
  }
});

test('component gallery at 390 (coarse pointer): 44 px touch targets, phone layout, contrast', { skip }, async () => {
  const { browser, page, errors } = await openGallery({ width: 390, height: 844, mobile: true });
  try {
    mkdirSync(SHOTS, { recursive: true });
    const result = await page.evaluate(measure);
    await page.screenshot({ path: path.join(SHOTS, 'components-390.png'), fullPage: true });
    assert.deepEqual(errors, []);
    assert.equal(result.coarse, true);
    // S88 consolidation: every shared control is 44 px on touch (no module overrides).
    assert.equal(result.sizes.btnSm.h, 44);
    assert.equal(result.sizes.btnMd.h, 44);
    assert.equal(result.sizes.btnLg.h, 44);
    assert.equal(result.sizes.iconBtn.h, 44);
    assert.equal(result.sizes.input.h, 44);
    assert.equal(result.sizes.input.fontSize, 16, 'inputs use 16 px on touch so iOS does not zoom');
    assert.equal(result.sizes.select.h, 44);
    assert.equal(result.sizes.chip.h, 44);
    assert.equal(result.sizes.segment.h, 44);
    assert.equal(result.sizes.menuItem.h, 44);
    assertContrast(Object.fromEntries(Object.entries(result.pairs).filter(([name]) => !['th', 'cellSub', 'selectedRow'].includes(name))));
    assert.ok(result.smallest.size >= 12, `text below 12 px: ${JSON.stringify(result.smallest)}`);
    assert.ok(result.scrollWidth <= result.innerWidth, `no horizontal page scroll (${result.scrollWidth} > ${result.innerWidth})`);
    // The table becomes a row list on phones; the page title moves to the top bar.
    const phone = await page.evaluate(() => ({
      table: getComputedStyle(document.querySelector('.atlas-table-wrap--responsive')).display,
      list: getComputedStyle(document.querySelector('.atlas-table-list')).display,
      titleWidth: document.querySelector('.page-head__title').getBoundingClientRect().width,
      sheetRadius: getComputedStyle(document.querySelector('.atlas-sheet')).borderBottomLeftRadius
    }));
    assert.deepEqual(phone, { table: 'none', list: 'block', titleWidth: 1, sheetRadius: '0px' });
  } finally {
    await browser.close();
  }
});
