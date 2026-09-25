// S89 (review P2-7): every Atlas AI record route resolves, through the real
// AtlasShell.parseRoute, to a registered page, and every parameter it carries
// is read by that page's module, so a link opens the right record instead of
// only the right screen. Legacy hashes (#dashboard, #suppliers?section=…) are
// not emitted by the Tool Gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { routeFor } from '../../supabase/functions/_shared/ai-tools/result.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const JS = 'apps/web/assets/js';

function loadShell() {
  const context = {
    console, Date, JSON, Promise, Map, Set, Array, Object, String, Number, Boolean, Error, Symbol, Infinity, NaN, setTimeout, clearTimeout,
    location: { hash: '', pathname: '/', search: '', href: 'https://atlas.test/' },
    history: { replaceState() {}, pushState() {} },
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {}, dispatchEvent() { return true; }, reportError() {},
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    Element: class {},
    document: {
      addEventListener() {}, querySelectorAll: () => [], getElementById: () => null,
      createElement: () => ({ setAttribute() {}, addEventListener() {}, dataset: {}, style: {} }),
      body: { dataset: {}, appendChild() {} }, head: { appendChild() {} },
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read(`${JS}/atlas-shell.js`), context);
  return context.AtlasShell;
}

// The module(s) that render each internal view and read its route params.
const VIEW_MODULES = {
  dashboard: ['apps/web/assets/js/home.js'],
  inventory: [`${JS}/atlas-inventory.js`, `${JS}/stock-count-workspace.js`],
  movements: [`${JS}/atlas-inventory.js`],
  waste: [`${JS}/atlas-inventory.js`],
  data: [`${JS}/data-workspace.js`],
  recipes: [`${JS}/recipes.js`],
  suppliers: [`${JS}/atlas-purchasing.js`],
  reports: [`${JS}/reports-workspace.js`],
  operations: [`${JS}/operations.js`],
  shifts: [`${JS}/shifts-workspace.js`],
  'team-profiles': [`${JS}/team-profiles.source.js`],
  team: [`${JS}/team-messages.js`],
  knowledge: [`${JS}/knowledge-workspace.js`],
  settings: [`${JS}/settings-workspace.js`],
  ai: [`${JS}/atlas-ai.js`],
  marketing: [`${JS}/marketing-workspace.js`],
};

const reads = (source, key) => new RegExp(`params\\??\\.${key}\\b|params\\[['"]${key}['"]\\]`).test(source);

// Every route type the Tool Gateway knows (the ROUTES table in result.mjs).
const RESULT = read('supabase/functions/_shared/ai-tools/result.mjs');
const TYPES = [...RESULT.slice(RESULT.indexOf('const ROUTES = {'), RESULT.indexOf('};', RESULT.indexOf('const ROUTES = {')))
  .matchAll(/^\s{2}([a-z_]+):/gm)].map((match) => match[1]);

test('the route table is complete', () => {
  assert.ok(TYPES.length >= 25, `found ${TYPES.length} route types`);
  for (const type of ['inventory_item', 'movement', 'shift', 'shift_week', 'brain_recommendation', 'marketing_recommendation', 'integration', 'routine', 'purchase_order']) {
    assert.ok(TYPES.includes(type), type);
  }
});

test('every record route opens a real page and every parameter is read by it', () => {
  const shell = loadShell();
  const failures = [];
  for (const type of TYPES) {
    for (const id of ['rec-1', null]) {
      const route = routeFor(type, id);
      if (!route) { failures.push(`${type}(${id}) has no route`); continue; }
      const parsed = shell.parseRoute(route);
      const modules = VIEW_MODULES[parsed.view];
      if (!modules) { failures.push(`${type}(${id}) → ${route} opens unknown view ${parsed.view}`); continue; }
      const source = modules.map(read).join('\n');
      for (const key of Object.keys(parsed.params)) {
        if (!reads(source, key)) failures.push(`${type}(${id}) → ${route}: ${parsed.view} never reads "${key}"`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('record ids land in the parameter the page reads', () => {
  const shell = loadShell();
  const cases = {
    inventory_item: ['inventory', { item: 'rec-1' }],
    movement: ['movements', { movement: 'rec-1' }],
    stock_count: ['inventory', { section: 'stock-count', session: 'rec-1' }],
    par_levels: ['data', { section: 'pars', item: 'rec-1' }],
    data_review: ['data', { section: 'issues', issue: 'rec-1' }],
    recipe: ['recipes', { recipe: 'rec-1' }],
    supplier: ['suppliers', { section: 'suppliers', supplier: 'rec-1' }],
    purchase_order: ['suppliers', { section: 'orders', order: 'rec-1' }],
    routine: ['operations', { section: 'rec-1' }],
    shift_week: ['shifts', { week: 'rec-1' }],
    profile: ['team-profiles', { profile: 'rec-1' }],
    team_channel: ['team', { conversation: 'rec-1' }],
    knowledge_article: ['knowledge', { article: 'rec-1' }],
    brain_recommendation: ['ai', { section: 'decisions', recommendation: 'rec-1' }],
    marketing_recommendation: ['marketing', { recommendation: 'rec-1' }],
    integration: ['settings', { section: 'integrations', provider: 'rec-1' }],
  };
  for (const [type, [view, params]] of Object.entries(cases)) {
    const parsed = shell.parseRoute(routeFor(type, 'rec-1'));
    assert.equal(parsed.view, view, type);
    assert.deepEqual({ ...parsed.params }, params, type);
  }
  // Purchasing with no id opens the Orders tab (the former #suppliers?section=purchase-orders opened Suppliers).
  const orders = shell.parseRoute(routeFor('purchase_order'));
  assert.equal(orders.view, 'suppliers');
  assert.ok(!orders.params.section || orders.params.section === 'orders');
});

test('the Tool Gateway emits no legacy or hand-built hash routes', () => {
  const dir = path.join(ROOT, 'supabase/functions/_shared/ai-tools');
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.mjs') && name !== 'result.mjs')) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(source, /["'`]#(?:dashboard|suppliers|brain|movements|imports|business|system|sprint3-review)\b/, `${file} emits a legacy route`);
    assert.doesNotMatch(source, /section=purchase-orders|[?&]routine=/, `${file} emits a legacy query`);
  }
});
