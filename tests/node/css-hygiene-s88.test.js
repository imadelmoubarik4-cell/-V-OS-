// S88 CSS hygiene ratchet and the final design-system structure.
//
// These counts describe the stylesheets that reach the Atlas page. They may
// only go down: when a change lowers one, lower its ceiling in
// tests/node/css-hygiene-s88.baseline.json in the same commit. After the S88
// consolidation the ceilings are the end state (docs/design/
// Atlas_Design_System.md §0, §13): no legacy layer, no legacy fragments, no
// inline or injected style, no cross-file duplicate selector, no text under
// 11 px, and !important only in atlas-base.css for [hidden], reduced motion
// and role gating.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import test from 'node:test';

const WEB = 'apps/web';
const CSS = path.join(WEB, 'assets/css');
const loadCeilings = () => JSON.parse(readFileSync('tests/node/css-hygiene-s88.baseline.json', 'utf8')).ceilings;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

// Every CSS source that can reach index.html: stylesheet files (the
// team-profiles source copy is represented by its shipped .gz bundle), inline
// <style> blocks in index.html and CSS strings injected by runtime scripts.
export function cssSources() {
  const sources = [];
  for (const file of walk(CSS).sort()) {
    if (file.endsWith('team-profiles.source.css')) continue;
    if (file.endsWith('.css')) sources.push({ name: path.relative(CSS, file), text: readFileSync(file, 'utf8'), file: true });
    else if (file.endsWith('.css.gz')) sources.push({ name: path.relative(CSS, file), text: gunzipSync(readFileSync(file)).toString('utf8'), file: true });
  }
  const index = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  [...index.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].forEach((match, i) => sources.push({ name: `index.html<style>#${i + 1}`, text: match[1], file: false }));
  // A script's <style> string no longer reaches the page once index.html links a
  // stylesheet with the same element id (the scripts skip injection then).
  const staticIds = new Set([...index.matchAll(/<link[^>]*\sid="([^"]+)"/g)].map((match) => match[1]));
  for (const file of walk(path.join(WEB, 'assets/js')).filter((name) => name.endsWith('.js')).sort()) {
    const text = readFileSync(file, 'utf8');
    const ids = [...text.matchAll(/(?:style\.id\s*=\s*|_STYLE_ID\s*=\s*|getElementById\()'([^']+)'/g)].map((match) => match[1]);
    if (ids.some((id) => staticIds.has(id))) continue;
    [...text.matchAll(/style\.textContent\s*=\s*(`[^`]*`|'[^']*')/g)].forEach((match, i) => sources.push({ name: `${path.basename(file)}<style>#${i + 1}`, text: match[1].slice(1, -1), file: false, js: true }));
  }
  return sources;
}

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

// Style rules as { selector, media, body } (enough for hygiene counting).
function rules(text) {
  const out = [];
  const src = stripComments(text);
  const walkBlock = (start, end, media) => {
    let i = start;
    while (i < end) {
      const open = src.indexOf('{', i);
      if (open < 0 || open >= end) break;
      const semi = src.indexOf(';', i);
      if (semi >= 0 && semi < open && src.slice(i, semi).trim().startsWith('@')) { i = semi + 1; continue; }
      let depth = 1; let j = open + 1;
      for (; j < end && depth; j += 1) { if (src[j] === '{') depth += 1; else if (src[j] === '}') depth -= 1; }
      const prelude = src.slice(i, open).replace(/^[\s;}]+/, '').trim();
      if (/^@(media|supports|layer|container)/.test(prelude)) walkBlock(open + 1, j - 1, /^@layer/.test(prelude) ? media : `${media}${prelude.replace(/\s+/g, ' ')};`);
      else if (!prelude.startsWith('@')) out.push({ selector: prelude.replace(/\s+/g, ' '), media, body: src.slice(open + 1, j - 1) });
      i = j;
    }
  };
  walkBlock(0, src.length, '');
  return out;
}

function splitSelectors(selector) {
  const out = []; let depth = 0; let buf = '';
  for (const c of selector) {
    if (c === '(' || c === '[') depth += 1;
    if (c === ')' || c === ']') depth -= 1;
    if (c === ',' && depth === 0) { out.push(buf); buf = ''; } else buf += c;
  }
  out.push(buf);
  return out.map((s) => s.trim().replace(/\s*([>+~])\s*/g, '$1')).filter(Boolean);
}

export function metrics() {
  const sources = cssSources();
  let important = 0; let smallFonts = 0;
  const owners = new Map();
  for (const source of sources) {
    const text = stripComments(source.text);
    important += (text.match(/!\s*important/gi) || []).length;
    for (const match of text.matchAll(/font-size\s*:\s*([\d.]+)px/gi)) if (Number(match[1]) < 11) smallFonts += 1;
    for (const match of text.matchAll(/(?:^|[;{\s])font\s*:[^;}]*?(?:^|\s)([\d.]+)px/gi)) if (Number(match[1]) < 11) smallFonts += 1;
    for (const rule of rules(source.text)) {
      for (const selector of splitSelectors(rule.selector)) {
        const key = `${rule.media}|${selector}`;
        if (!owners.has(key)) owners.set(key, new Set());
        // The legacy/<source>--<module>.css fragments of one retired stylesheet
        // count as that one file: the S88 split itself adds no duplicates.
        owners.get(key).add(source.name.replace(/^legacy\/(.+)--[^/]+\.css$/, 'legacy/$1'));
      }
    }
  }
  const crossFileDuplicates = [...owners.values()].filter((set) => set.size > 1).length;
  const files = sources.filter((source) => source.file);
  return {
    important,
    crossFileDuplicateSelectors: crossFileDuplicates,
    subElevenPxFontSizes: smallFonts,
    // All stylesheet files, legacy fragments included: the design system adds
    // atlas-base.css and atlas-components.css while it retires fragments.
    stylesheetFiles: files.length,
    legacyFragmentFiles: files.filter((source) => source.name.startsWith('legacy/')).length,
    inlineAndInjectedStyleBlocks: sources.filter((source) => !source.file).length
  };
}

test('CSS hygiene counts never go up (S88 ratchet)', () => {
  const current = metrics();
  for (const [name, ceiling] of Object.entries(loadCeilings())) {
    assert.ok(name in current, `unknown metric ${name}`);
    assert.ok(current[name] <= ceiling, `${name} rose to ${current[name]} (ceiling ${ceiling}). Lower it instead; see tests/node/css-hygiene-s88.baseline.json.`);
  }
});

test('cascade layers are declared first and every stylesheet is layered', () => {
  const index = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const links = [...index.matchAll(/<link rel="stylesheet" href="(assets\/css\/[^"?]+)/g)].map((match) => match[1]);
  assert.equal(links[0], 'assets/css/atlas-tokens.css', 'atlas-tokens.css declares the layer order and must be the first Atlas stylesheet');
  const tokens = readFileSync(path.join(CSS, 'atlas-tokens.css'), 'utf8');
  // S88 retired atlas.legacy: four layers, in this order.
  assert.match(stripComments(tokens), /^\s*@layer atlas\.tokens, atlas\.base, atlas\.components, atlas\.modules;/);
  assert.doesNotMatch(index, /<style\b/, 'index.html has no inline style block');
  assert.doesNotMatch(index, /assets\/css\/legacy\//, 'index.html links no legacy fragment');
  assert.ok(!existsSync(path.join(CSS, 'legacy')), 'apps/web/assets/css/legacy/ is gone');
  // Unlayered CSS beats every layer; nothing may ship outside a layer.
  for (const source of cssSources().filter((entry) => !entry.js)) {
    const text = stripComments(source.text).trim();
    if (source.name === 'atlas-tokens.css') continue;
    assert.doesNotMatch(text, /atlas\.legacy/, `${source.name} names the retired legacy layer`);
    assert.match(text, /^@layer atlas\.(base|components|modules)\s*\{[\s\S]*\}$/, `${source.name} must be one @layer block`);
  }
  // The design system owns base and components; every other sheet is a module.
  const owners = { 'atlas-base.css': 'base', 'atlas-components.css': 'components', 'atlas-shell.css': 'components' };
  for (const source of cssSources().filter((entry) => entry.file && entry.name !== 'atlas-tokens.css')) {
    const layer = stripComments(source.text).match(/@layer atlas\.(\w+)/)[1];
    assert.equal(layer, owners[source.name] || 'modules', `${source.name} is in atlas.${layer}`);
  }
});

test('custom properties on :root are defined only in atlas-tokens.css', () => {
  const defined = (text) => new Set([...stripComments(text).matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
  const tokens = defined(readFileSync(path.join(CSS, 'atlas-tokens.css'), 'utf8'));
  for (const source of cssSources()) {
    if (source.name === 'atlas-tokens.css') continue;
    for (const rule of rules(source.text)) {
      if (!splitSelectors(rule.selector).some((selector) => selector.startsWith(':root') || selector === 'html')) continue;
      const clash = [...defined(rule.body)].filter((name) => tokens.has(name));
      assert.deepEqual(clash, [], `${source.name} redefines token(s) on ${rule.selector}`);
    }
  }
});

test('!important appears only in atlas-base.css for [hidden], reduced motion and role gating', () => {
  for (const source of cssSources()) {
    const found = rules(source.text).filter((rule) => /!\s*important/i.test(rule.body));
    if (source.name !== 'atlas-base.css') { assert.deepEqual(found.map((rule) => rule.selector), [], `${source.name} uses !important`); continue; }
    for (const rule of found) {
      const allowed = rule.selector === '[hidden]'
        || rule.selector.startsWith('body:not(.atlas-commercial-manager)')
        || (/prefers-reduced-motion/.test(rule.media) && rule.selector === '*, *::before, *::after')
        || rule.selector.startsWith('html.atlas-reduce-motion *');
      assert.ok(allowed, `atlas-base.css: !important on ${rule.selector}`);
    }
  }
});

test('the ratchet ceilings are tight', () => {
  // A ceiling that is higher than today's count lets a regression back in
  // unnoticed. Lower the ceiling whenever a count drops.
  const current = metrics();
  for (const [name, ceiling] of Object.entries(loadCeilings())) {
    assert.equal(ceiling, current[name], `${name} is now ${current[name]}; set its ceiling to ${current[name]}`);
  }
});

