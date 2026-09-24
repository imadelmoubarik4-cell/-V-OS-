#!/usr/bin/env node
// Atlas computed-style and screenshot capture (S88 design-system consolidation).
//
// Captures, for each role x viewport x view (plus a few open states), the
// computed style of every element in the document (all longhand properties,
// plus ::before/::after of rendered elements) and a viewport screenshot. A
// later run can be diffed against a stored baseline to prove that a CSS
// refactor changed nothing (or exactly what it changed).
//
// Not a CI test (it does not end in .browser.test.mjs). Run it with the same
// environment as the browser tests:
//
//   ATLAS_BROWSER_LIBS=... ATLAS_PLAYWRIGHT=... \
//     node tests/browser/tools/style-snapshot.mjs capture --out /tmp/css-before
//   node tests/browser/tools/style-snapshot.mjs diff /tmp/css-before /tmp/css-after
//
// Options for capture:
//   --out DIR            output directory (required)
//   --roles admin,bartender
//   --widths 1440,1024,768,390
//   --views dashboard,inventory,...   (default: every nav view the role can open)
//   --no-screens         skip screenshots
//   --cascade            also record, per element, the matched rules' layer order
//                        signature (used by cascade-check.mjs)
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { launchAtlas, openView, USERS } from '../harness.mjs';
import { captureFixtures, FROZEN_NOW } from './capture-fixtures.mjs';

const HEIGHTS = { 1440: 900, 1024: 768, 768: 1024, 390: 844 };
export const DEFAULT_VIEWS = [
  'dashboard', 'operations', 'inventory', 'movements', 'waste', 'recipes', 'suppliers', 'imports', 'team',
  'team-profiles', 'shifts', 'knowledge', 'brain', 'business', 'reports', 'marketing', 'system', 'settings', 'sprint3-review'
];

// Extra open states: [label, view, action(page)].
export const STATES = [
  ['shifts-month', 'shifts', async (page) => { await page.click('#shifts-view [data-shifts-tab="month"]', { timeout: 3000 }); }],
  ['recipe-detail', 'recipes', async (page) => {
    await page.evaluate(() => document.querySelector('#recipes-view [data-recipe-id], #recipes-view [data-recipe-select]')?.click());
  }],
  ['knowledge-new', 'knowledge', async (page) => { await page.evaluate(() => document.querySelector('#knowledge-view [data-knowledge-new]')?.click()); }],
  ['scanner', 'inventory', async (page) => { await page.evaluate(() => window.AtlasInventoryScanner?.open?.()); }],
  ['stock-count', 'inventory', async (page) => { await page.evaluate(() => window.AtlasStockCounts?.open?.()); }],
  ['item-master', 'inventory', async (page) => { await page.evaluate(() => window.AtlasItemMaster?.open?.()); }],
  ['palette-open', 'dashboard', async (page) => { await page.evaluate(() => window.AtlasPalette?.open()); }]
];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value.startsWith('--')) {
      const key = value.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i += 1; }
    } else args._.push(value);
  }
  return args;
}

// Freeze the page clock at a fixed instant (it still advances with real time,
// so timers and relative comparisons keep working).
function clockScript(fixed) {
  return `(() => {
    const RealDate = Date; const origin = performance.now(); const fixed = ${fixed};
    const now = () => fixed + (performance.now() - origin);
    class AtlasFrozenDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(now()); else super(...args); }
      static now() { return Math.floor(now()); }
    }
    AtlasFrozenDate.UTC = RealDate.UTC; AtlasFrozenDate.parse = RealDate.parse;
    window.Date = AtlasFrozenDate;
  })();`;
}

// Runs in the page: settle animations, then serialise computed styles.
function pageSnapshot() {
  for (const animation of document.getAnimations()) {
    try { animation.finish(); } catch { try { animation.cancel(); } catch { /* ignore */ } }
  }
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'BASE']);
  const table = new Map();
  const values = [];
  const intern = (value) => {
    let index = table.get(value);
    if (index === undefined) { index = values.length; values.push(value); table.set(value, index); }
    return index;
  };
  const probe = getComputedStyle(document.documentElement);
  const props = [];
  for (let i = 0; i < probe.length; i += 1) props.push(probe[i]);
  props.sort();
  const keyOf = (element) => {
    const parts = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) part += `#${node.id}`;
      else {
        const classes = [...node.classList].sort().join('.');
        if (classes) part += `.${classes}`;
        let index = 1;
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
          if (sibling.tagName === node.tagName) index += 1;
        }
        part += `:${index}`;
      }
      parts.unshift(part);
      if (node.id && node !== element) break;
    }
    return parts.join('>');
  };
  const elements = {};
  const seen = new Map();
  const all = document.documentElement.querySelectorAll('*');
  const list = [document.documentElement, ...all];
  let rendered = 0;
  for (const element of list) {
    if (SKIP.has(element.tagName) || element.closest('head, svg')) continue;
    let key = keyOf(element);
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count > 1) key += `~${count}`;
    const isRendered = element.getClientRects().length > 0;
    if (isRendered) rendered += 1;
    const style = getComputedStyle(element);
    elements[key] = [isRendered ? 1 : 0, ...props.map((prop) => intern(style.getPropertyValue(prop)))];
    if (isRendered) {
      for (const pseudo of ['::before', '::after']) {
        const pseudoStyle = getComputedStyle(element, pseudo);
        const content = pseudoStyle.getPropertyValue('content');
        if (!content || content === 'none' || content === 'normal') continue;
        elements[`${key}${pseudo}`] = [1, ...props.map((prop) => intern(pseudoStyle.getPropertyValue(prop)))];
      }
    }
  }
  const sheets = [...document.styleSheets].map((sheet) => {
    const node = sheet.ownerNode;
    if (sheet.href) return sheet.href.replace(location.origin + '/', '');
    if (node?.id) return `style#${node.id}`;
    const data = node?.dataset ? Object.keys(node.dataset).join(',') : '';
    return data ? `style[${data}]` : 'style';
  });
  return {
    view: document.body.dataset.atlasView || '',
    rendered,
    sheets,
    props,
    values,
    elements
  };
}

async function settle(page, ms = 900) {
  await page.waitForTimeout(ms);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function navViews(page) {
  return page.evaluate(() => [...document.querySelectorAll('.atlas-nav .nav-item[data-view]')]
    .filter((node) => node.getClientRects().length > 0 && !node.hidden)
    .map((node) => node.dataset.view));
}

async function capture(args) {
  const out = path.resolve(args.out);
  mkdirSync(out, { recursive: true });
  const roles = String(args.roles || 'admin,bartender').split(',');
  const widths = String(args.widths || '1440,1024,768,390').split(',').map(Number);
  const wanted = args.views ? String(args.views).split(',') : null;
  const screens = !args['no-screens'];
  const index = { created: new Date().toISOString(), roles, widths, entries: [] };
  for (const role of roles) {
    for (const width of widths) {
      const user = USERS[role];
      const app = await launchAtlas({
        user,
        viewport: { width, height: HEIGHTS[width] || 900 },
        fixtures: captureFixtures(user),
        initScript: clockScript(FROZEN_NOW)
      });
      const { page, record } = app;
      try {
        await settle(page, 2500);
        const available = await navViews(page);
        // Sub-views (movements, waste, imports) have no nav item; keep any view
        // the shell actually activates for this role.
        const views = [];
        for (const view of wanted || DEFAULT_VIEWS) {
          if (view === 'dashboard' || available.includes(view)) { views.push(view); continue; }
          await openView(page, view);
          if (await page.evaluate((target) => document.body.dataset.atlasView === target, view)) views.push(view);
        }
        const targets = views.map((view) => [view, view, null]);
        for (const [label, view, action] of STATES) if (views.includes(view) && (!wanted || wanted.includes(label) || wanted.includes(view))) targets.push([label, view, action]);
        for (const [label, view, action] of targets) {
          await page.keyboard.press('Escape').catch(() => {});
          await openView(page, 'dashboard');
          await openView(page, view);
          await settle(page);
          if (action) {
            try { await action(page); } catch (error) { console.warn(`  ${label}: ${error.message.split('\n')[0]}`); }
            await settle(page);
          }
          await page.mouse.move(0, HEIGHTS[width] - 1);
          const snapshot = await page.evaluate(pageSnapshot);
          const name = `${role}-${width}-${label}`;
          const json = Buffer.from(JSON.stringify({ role, width, label, ...snapshot }));
          writeFileSync(path.join(out, `${name}.json.gz`), gzipSync(json));
          let shot = null;
          if (screens) {
            const png = await page.screenshot({ fullPage: false, animations: 'disabled', caret: 'hide' });
            writeFileSync(path.join(out, `${name}.png`), png);
            shot = createHash('sha256').update(png).digest('hex');
          }
          index.entries.push({ name, role, width, label, view: snapshot.view, rendered: snapshot.rendered, elements: Object.keys(snapshot.elements).length, sheets: snapshot.sheets, screenshot_sha256: shot });
          console.log(`${name}: view=${snapshot.view} elements=${Object.keys(snapshot.elements).length} rendered=${snapshot.rendered}`);
        }
        index[`errors-${role}-${width}`] = record.pageErrors.slice(0, 20);
      } finally { await app.close(); }
    }
  }
  writeFileSync(path.join(out, `index-${roles.join('+')}-${widths.join('+')}.json`), JSON.stringify(index, null, 1));
}

function load(file) {
  return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
}

export function diffSnapshots(beforeDir, afterDir, { ignore = [], limit = 40 } = {}) {
  const files = readdirSync(beforeDir).filter((file) => file.endsWith('.json.gz')).sort();
  const report = { files: 0, identical: 0, changed: [], missing: [] };
  const ignored = new Set(ignore);
  for (const file of files) {
    const other = path.join(afterDir, file);
    if (!existsSync(other)) { report.missing.push(file); continue; }
    report.files += 1;
    const a = load(path.join(beforeDir, file));
    const b = load(other);
    const bIndex = new Map(b.props.map((prop, i) => [prop, i]));
    const columns = a.props.map((prop, i) => [prop, i, bIndex.get(prop)]).filter(([prop]) => !ignored.has(prop));
    const changes = [];
    let propertyChanges = 0; let onlyBefore = 0; let onlyAfter = 0;
    for (const [key, rowA] of Object.entries(a.elements)) {
      const rowB = b.elements[key];
      if (!rowB) { onlyBefore += 1; if (rowA[0] && changes.length < limit) changes.push({ key, missing: 'after' }); continue; }
      for (const [prop, ia, ib] of columns) {
        const before = a.values[rowA[ia + 1]];
        const after = ib === undefined ? undefined : b.values[rowB[ib + 1]];
        if (before !== after) { propertyChanges += 1; if (changes.length < limit) changes.push({ key, prop, before, after, rendered: rowA[0] === 1 }); }
      }
    }
    for (const [key, rowB] of Object.entries(b.elements)) if (!(key in a.elements)) { onlyAfter += 1; if (rowB[0] && changes.length < limit) changes.push({ key, missing: 'before' }); }
    if (!propertyChanges && !onlyBefore && !onlyAfter) report.identical += 1;
    else report.changed.push({ file, onlyBefore, onlyAfter, propertyChanges, sample: changes });
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, ...rest] = args._;
  if (command === 'capture') {
    if (!args.out) throw new Error('capture needs --out DIR');
    await capture(args);
  } else if (command === 'diff') {
    const [before, after] = rest;
    const report = diffSnapshots(before, after, { ignore: args.ignore ? String(args.ignore).split(',') : [], limit: Number(args.limit || 40) });
    const text = JSON.stringify(report, null, 1);
    if (args.report) writeFileSync(args.report, text);
    console.log(`${report.files} snapshots compared, ${report.identical} identical, ${report.changed.length} changed, ${report.missing.length} missing`);
    for (const entry of report.changed) {
      console.log(`- ${entry.file}: ${entry.propertyChanges} property changes, ${entry.onlyBefore} elements only before, ${entry.onlyAfter} only after`);
      for (const change of entry.sample.slice(0, Number(args.show || 8))) console.log(`    ${JSON.stringify(change)}`);
    }
    process.exitCode = report.changed.length || report.missing.length ? 1 : 0;
  } else {
    console.log('usage: style-snapshot.mjs capture --out DIR [--roles r] [--widths w] [--views v] [--no-screens]\n       style-snapshot.mjs diff BEFORE AFTER [--ignore prop,prop] [--report file.json]');
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
