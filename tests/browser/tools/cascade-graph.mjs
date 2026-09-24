#!/usr/bin/env node
// Atlas cascade conflict graph (S88 design-system consolidation).
//
// Computed styles only prove what the captured states look like. Moving CSS
// rules between files or into cascade layers is safe only if no two rules that
// can style the same element property change precedence. This tool records,
// for every captured state, which pairs of style rules both match the same
// element (or ::before/::after) and declare the same longhand property, with
// the specificity each rule matched with and whether the values differ.
// State pseudo-classes (:hover, :focus, :focus-visible, :focus-within,
// :active) are treated as matching, so hover/focus rules are covered too.
//
// Output is JSON: { sheets: [...], rules: [...], pairs: [...] } where a rule
// is identified by its sheet key and its index in the sheet's flattened style
// rule list (depth-first through @media/@supports/@layer/@import).
//
//   node tests/browser/tools/cascade-graph.mjs --out graph.json [--roles ..] [--widths ..]
//
// check-layers.mjs (next to this file) evaluates a proposed rearrangement
// against the graph.
import { writeFileSync } from 'node:fs';
import { launchAtlas, openView, USERS } from '../harness.mjs';
import { captureFixtures, FROZEN_NOW } from './capture-fixtures.mjs';
import { DEFAULT_VIEWS, STATES } from './style-snapshot.mjs';

const HEIGHTS = { 1440: 900, 1024: 768, 768: 1024, 390: 844 };

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[argv[i].slice(2)] = true;
    else { args[argv[i].slice(2)] = next; i += 1; }
  }
  return args;
}

// In-page collector. State lives on window.__atlasCascade between calls.
function collect() {
  const STATE_PSEUDO = /:(hover|focus-visible|focus-within|focus|active)(?![\w-])/g;
  const PSEUDO_ELEMENT = /::?(before|after)(?![\w-])|::[\w-]+(\([^)]*\))?/g;
  const store = window.__atlasCascade || (window.__atlasCascade = { rules: null, pairs: new Map(), targets: 0 });

  function splitTop(text, sep = ',') {
    const out = []; let depth = 0; let buf = ''; let quote = null;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (quote) { buf += c; if (c === '\\') { buf += text[i + 1] || ''; i += 1; } else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; buf += c; continue; }
      if (c === '(' || c === '[') depth += 1;
      if (c === ')' || c === ']') depth -= 1;
      if (c === sep && depth === 0) { out.push(buf.trim()); buf = ''; } else buf += c;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  // Selectors level 4 specificity of one complex selector.
  function specificity(selector) {
    let a = 0; let b = 0; let c = 0; let i = 0; const s = selector;
    const readName = () => { const m = /^-?[_a-zA-Z -￿\\][\w -￿\\-]*/.exec(s.slice(i)); if (!m) return ''; i += m[0].length; return m[0]; };
    const readParens = () => { let depth = 0; const start = i; for (; i < s.length; i += 1) { if (s[i] === '(') depth += 1; else if (s[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break; } } } return s.slice(start + 1, i - 1); };
    const maxOf = (list) => splitTop(list).map(specificity).reduce((best, x) => (compare(x, best) > 0 ? x : best), [0, 0, 0]);
    while (i < s.length) {
      const ch = s[i];
      if (ch === '#') { i += 1; readName(); a += 1; }
      else if (ch === '.') { i += 1; readName(); b += 1; }
      else if (ch === '[') { let depth = 0; for (; i < s.length; i += 1) { if (s[i] === '[') depth += 1; else if (s[i] === ']') { depth -= 1; if (!depth) { i += 1; break; } } } b += 1; }
      else if (ch === ':') {
        if (s[i + 1] === ':') { i += 2; readName(); if (s[i] === '(') readParens(); c += 1; continue; }
        i += 1; const name = readName().toLowerCase();
        if (['before', 'after', 'first-line', 'first-letter'].includes(name)) { c += 1; continue; }
        if (s[i] === '(') {
          const inner = readParens();
          if (name === 'where') continue;
          if (['is', 'not', 'has', 'matches', '-webkit-any'].includes(name)) { const x = maxOf(inner); a += x[0]; b += x[1]; c += x[2]; continue; }
          if (['nth-child', 'nth-last-child'].includes(name) && / of /i.test(inner)) { const x = maxOf(inner.split(/ of /i)[1]); a += x[0]; b += x[1] + 1; c += x[2]; continue; }
          b += 1; continue;
        }
        b += 1;
      } else if (ch === '*') { i += 1; }
      else if (/[\s>+~,]/.test(ch)) { i += 1; }
      else if (ch === '\\' || /[_a-zA-Z-]/.test(ch)) { readName(); c += 1; }
      else i += 1;
    }
    return [a, b, c];
  }
  function compare(x, y) { return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]); }

  // Remove state pseudo-classes outside :not()/:has() so the rule matches as if
  // the state were active; strip pseudo-elements and report which one.
  function relax(selector) {
    let pseudo = '';
    const m = selector.match(/::?(before|after)\b|::(placeholder|marker|selection|backdrop|-webkit-[\w-]+|file-selector-button)\b/);
    if (m) pseudo = `::${m[1] || m[2]}`;
    let out = ''; let depth = 0; let i = 0; const negStack = [];
    while (i < selector.length) {
      const rest = selector.slice(i);
      const fn = /^:(not|has)\(/.exec(rest);
      if (fn) { negStack.push(depth + 1); out += fn[0]; depth += 1; i += fn[0].length; continue; }
      if (selector[i] === '(') { depth += 1; out += '('; i += 1; continue; }
      if (selector[i] === ')') { if (negStack.at(-1) === depth) negStack.pop(); depth -= 1; out += ')'; i += 1; continue; }
      const st = /^:(hover|focus-visible|focus-within|focus|active)(?![\w-])/.exec(rest);
      if (st && !negStack.length) { out += ':is(*)'; i += st[0].length; continue; }
      const pe = /^::?(before|after)(?![\w-])|^::(placeholder|marker|selection|backdrop|-webkit-[\w-]+|file-selector-button)(?![\w-])/.exec(rest);
      if (pe) { i += pe[0].length; continue; }
      out += selector[i]; i += 1;
    }
    return { relaxed: out.trim() || '*', pseudo };
  }

  function flatten() {
    const rules = []; const sheets = [];
    const keyOf = (sheet, parentKey) => {
      const node = sheet.ownerNode;
      if (sheet.href) return (parentKey ? `${parentKey}>@import:` : '') + sheet.href.replace(location.origin + '/', '');
      if (node?.id) return `style#${node.id}`;
      const data = node?.dataset ? Object.keys(node.dataset).join(',') : '';
      return data ? `style[${data}]` : 'style:inline';
    };
    const walk = (list, sheetKey, ctx) => {
      for (const rule of list) {
        if (rule instanceof CSSImportRule) {
          if (rule.styleSheet) {
            const key = keyOf(rule.styleSheet, sheetKey);
            sheets.push(key);
            walk(rule.styleSheet.cssRules, key, { ...ctx, layer: rule.layerName != null ? [...ctx.layer, rule.layerName] : ctx.layer });
          }
        } else if (rule instanceof CSSStyleRule) {
          const decls = {};
          for (let i = 0; i < rule.style.length; i += 1) {
            const prop = rule.style[i];
            decls[prop] = [rule.style.getPropertyValue(prop), rule.style.getPropertyPriority(prop) === 'important' ? 1 : 0];
          }
          rules.push({ sheet: sheetKey, index: ctx.counter[sheetKey]++, selector: rule.selectorText, media: ctx.media.join(' and '), supports: ctx.supports.join(' and '), layer: ctx.layer.join('.'), decls, rule });
        } else if (rule instanceof CSSMediaRule) {
          walk(rule.cssRules, sheetKey, { ...ctx, media: [...ctx.media, rule.conditionText || rule.media.mediaText] });
        } else if (rule instanceof CSSSupportsRule) {
          walk(rule.cssRules, sheetKey, { ...ctx, supports: [...ctx.supports, rule.conditionText] });
        } else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) {
          walk(rule.cssRules, sheetKey, { ...ctx, layer: [...ctx.layer, rule.name || `anon${Math.random()}`] });
        } else if (typeof CSSLayerStatementRule !== 'undefined' && rule instanceof CSSLayerStatementRule) {
          ctx.layerOrder.push(...rule.nameList);
        } else if (rule instanceof CSSKeyframesRule) {
          rules.push({ sheet: sheetKey, index: ctx.counter[sheetKey]++, selector: `@keyframes ${rule.name}`, media: ctx.media.join(' and '), supports: '', layer: ctx.layer.join('.'), decls: {}, keyframes: rule.name });
        }
      }
    };
    const layerOrder = [];
    const counter = new Proxy({}, { get: (t, k) => (t[k] ?? 0), set: (t, k, v) => { t[k] = v; return true; } });
    for (const sheet of document.styleSheets) {
      let list; try { list = sheet.cssRules; } catch { continue; }
      const key = keyOf(sheet);
      sheets.push(key);
      walk(list, key, { media: [], supports: [], layer: [], layerOrder, counter });
    }
    return { rules, sheets, layerOrder };
  }

  // Re-flatten on every call: runtime modules keep adding stylesheets.
  {
    const flat = flatten();
    store.rules = flat.rules; store.sheets = flat.sheets; store.layerOrder = flat.layerOrder;
    store.info = store.info || new Map();
    store.rules.forEach((rule, id) => {
      rule.id = id;
      rule.key = `${rule.sheet}#${rule.index}`;
      rule.members = rule.keyframes ? [] : splitTop(rule.selector).map((member) => ({ member, spec: specificity(member), ...relax(member) }));
      if (!store.info.has(rule.key)) {
        const { sheet, index, selector, media, supports, layer, decls, keyframes } = rule;
        store.info.set(rule.key, { key: rule.key, sheet, index, selector, media, supports, layer, keyframes, decls });
      }
    });
  }
  // Match every rule against the current DOM.
  const byTarget = new Map();
  for (const rule of store.rules) {
    if (!rule.members.length || !Object.keys(rule.decls).length) continue;
    for (const m of rule.members) {
      let nodes;
      try { nodes = document.querySelectorAll(m.relaxed); } catch { continue; }
      for (const node of nodes) {
        let entry = byTarget.get(node);
        if (!entry) { entry = new Map(); byTarget.set(node, entry); }
        const key = m.pseudo;
        let list = entry.get(key);
        if (!list) { list = new Map(); entry.set(key, list); }
        const prev = list.get(rule.id);
        if (!prev || compare(m.spec, prev) > 0) list.set(rule.id, m.spec);
      }
    }
  }
  let targets = 0;
  for (const entry of byTarget.values()) {
    for (const list of entry.values()) {
      targets += 1;
      const byProp = new Map();
      for (const [id, spec] of list) {
        for (const prop of Object.keys(store.rules[id].decls)) {
          let arr = byProp.get(prop); if (!arr) { arr = []; byProp.set(prop, arr); } arr.push([id, spec]);
        }
      }
      for (const [prop, arr] of byProp) {
        if (arr.length < 2) continue;
        arr.sort((x, y) => x[0] - y[0]);
        for (let i = 0; i < arr.length; i += 1) {
          for (let j = i + 1; j < arr.length; j += 1) {
            const [ai, as] = arr[i]; const [bi, bs] = arr[j];
            const da = store.rules[ai].decls[prop]; const db = store.rules[bi].decls[prop];
            if (da[1] !== db[1]) continue; // different importance never flips
            const same = da[0] !== '' && da[0] === db[0];
            const ka = store.rules[ai].key; const kb = store.rules[bi].key;
            const key = `${ka}|${kb}|${da[1]}|${as.join(',')}|${bs.join(',')}`;
            const prev = store.pairs.get(key);
            if (!prev) store.pairs.set(key, { a: ka, b: kb, imp: da[1], sa: as, sb: bs, diff: same ? 0 : 1, prop: same ? null : prop, props: 1 });
            else { prev.props += 1; if (!same && !prev.diff) { prev.diff = 1; prev.prop = prop; } }
          }
        }
      }
    }
  }
  store.targets += targets;
  return { rules: store.rules.length, pairs: store.pairs.size, targets };
}

function dump() {
  const store = window.__atlasCascade;
  return {
    sheets: store.sheets,
    layerOrder: store.layerOrder,
    order: store.rules.map((rule) => rule.key),
    rules: [...store.info.values()],
    pairs: [...store.pairs.values()]
  };
}

async function settle(page, ms = 900) {
  await page.waitForTimeout(ms);
}

export async function buildGraph({ roles = ['admin', 'bartender'], widths = [1440, 1024, 768, 390], log = console.log } = {}) {
  const graphs = [];
  for (const role of roles) {
    for (const width of widths) {
      const user = USERS[role];
      const app = await launchAtlas({ user, viewport: { width, height: HEIGHTS[width] || 900 }, fixtures: captureFixtures(user), initScript: `(() => { const R = Date; const o = performance.now(); const f = ${FROZEN_NOW}; const n = () => f + (performance.now() - o); class D extends R { constructor(...a) { if (a.length === 0) super(n()); else super(...a); } static now() { return Math.floor(n()); } } D.UTC = R.UTC; D.parse = R.parse; window.Date = D; })();` });
      const { page } = app;
      try {
        await settle(page, 2500);
        const targets = DEFAULT_VIEWS.map((view) => [view, view, null]).concat(STATES);
        for (const [label, view, action] of targets) {
          await page.keyboard.press('Escape').catch(() => {});
          await openView(page, 'dashboard');
          await openView(page, view);
          await settle(page);
          if (action) { try { await action(page); } catch { /* state not reachable for this role */ } await settle(page); }
          const r = await page.evaluate(collect);
          log(`${role}-${width}-${label}: rules=${r.rules} pairs=${r.pairs}`);
        }
        graphs.push(await page.evaluate(dump));
      } finally { await app.close(); }
    }
  }
  return graphs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const graphs = await buildGraph({
    roles: String(args.roles || 'admin,bartender').split(','),
    widths: String(args.widths || '1440,1024,768,390').split(',').map(Number)
  });
  writeFileSync(args.out || 'cascade-graph.json', JSON.stringify(graphs));
}
