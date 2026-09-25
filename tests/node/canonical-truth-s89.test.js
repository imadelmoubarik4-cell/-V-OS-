// S89: one canonical business truth across Home, Inventory, Reports and
// Atlas AI. The shipped browser modules run unmodified in node:vm; the server
// Reports builder (stock-provenance buildStockReport), the domain layer
// (atlas-domain) and the real Atlas AI tools run natively, all on the same
// rows. Every surface must give the same numbers.
//
// The fixture is the S88 architecture review probe (Gin at zero with a par,
// Vodka under par, Syrup at zero with no par and cost 0, Lime not counted,
// Tonic above par without a cost, inactive Ice as a recipe reference).
//
// Canonical rules (apps/web/assets/js/atlas-stock-truth.js, ported to
// supabase/functions/_shared/stock-provenance.mjs, re-exported by atlas-domain):
//   stockStatus: unknown > out (known, quantity <= 0) > below_par (par > 0,
//     quantity < par) > no_par > ok. Out and below par are counted separately;
//     needs ordering = out + below par.
//   hasCost: cost_price > 0; anything else is "missing cost".
//   inventoryValue: null unless every active item is counted and costed;
//     known_value is the lower bound.
//   reference ingredients (inactive or 'untracked') cost 0 with the evidence
//     "No cost (reference ingredient)".
//   purchase spend: costed purchase receipts (restock and receipt synonyms,
//     positive quantity; total_cost, else unit_cost x quantity); never waste.
//   order estimates: null (uncosted) for an item without a usable cost.
//   money: "3.900 kr" everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
  MOVEMENT_ROW_LIMIT,
  REFERENCE_COST_REASON,
  formatKr,
  inventoryValue,
  needsOrdering,
  orderExposure,
  orderSuggestions,
  projectStock,
  purchaseReceiptAmount,
  purchaseSpend,
  recipeCost,
  recipeStatus,
  stockCounts,
  stockStatus,
} from '../../supabase/functions/_shared/atlas-domain.mjs';
import { applyStockTrustToWorkspace, buildRecipeReport, buildStockReport } from '../../supabase/functions/_shared/stock-provenance.mjs';
import { runTool } from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { createBackend, makeCtx, NOW } from './helpers/ai-tools-fixtures.js';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const DAY = 864e5;
const iso = (days) => new Date(NOW + days * DAY).toISOString();
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const plain = (value) => JSON.parse(JSON.stringify(value));

const ITEMS = [
  { id: u(1), name: 'Gin', category: 'Spirits', unit: 'bottle', size_ml: 700, par_level: 4, cost_price: 5000, active: true, supplier: 'Vin' },
  { id: u(2), name: 'Vodka', category: 'Spirits', unit: 'bottle', size_ml: 700, par_level: 4, cost_price: 4000, active: true, supplier: 'Vin' },
  { id: u(3), name: 'Syrup', category: 'Mixers', unit: 'bottle', size_ml: 1000, par_level: null, cost_price: 0, active: true, supplier: 'Vin' },
  { id: u(4), name: 'Lime', category: 'Fruit', unit: 'each', par_level: 10, cost_price: 50, active: true, supplier: 'Globus' },
  { id: u(5), name: 'Ice', category: 'Other', unit: 'each', par_level: null, cost_price: null, active: false },
  { id: u(6), name: 'Tonic', category: 'Mixers', unit: 'can', par_level: 6, cost_price: null, active: true, supplier: 'Globus' },
];
const balance = (id, quantity) => ({ inventory_item_id: id, verified_quantity: quantity, freshness_state: 'current', verified_at: iso(-1), expires_at: iso(6) });
const BALANCES = [balance(u(1), 0), balance(u(2), 2), balance(u(3), 0), balance(u(6), 10)];
const RECIPES = [{
  id: u(201), name: 'Gin tonic', active: true, yield_quantity: 1, menu_price: 2500,
  recipe_ingredients: [
    { id: u(211), recipe_id: u(201), item_id: u(2), item_name: 'Vodka', quantity: 50, unit: 'ml' },
    { id: u(212), recipe_id: u(201), item_id: u(5), item_name: 'Ice', quantity: 2, unit: 'each' },
  ],
}];
const MOVEMENTS = [
  { id: u(901), item_id: u(1), item_name: 'Gin', movement_type: 'restock', quantity_change: 2, unit_cost: 5000, total_cost: 10000, supplier_id: null, created_at: iso(-2) },
  { id: u(902), item_id: u(2), item_name: 'Vodka', movement_type: 'purchase', quantity_change: 1, unit_cost: 5000, total_cost: null, supplier_id: null, created_at: iso(-2) },
  { id: u(903), item_id: u(4), item_name: 'Lime', movement_type: 'waste', quantity_change: -40, unit_cost: 50, total_cost: 2000, supplier_id: null, created_at: iso(-2) },
  { id: u(904), item_id: u(4), item_name: 'Lime', movement_type: 'adjustment', quantity_change: 5, unit_cost: 600, total_cost: 3000, supplier_id: null, created_at: iso(-2) },
  { id: u(905), item_id: u(6), item_name: 'Tonic', movement_type: 'restock', quantity_change: 12, unit_cost: null, total_cost: null, supplier_id: null, created_at: iso(-2) },
];

function browser({ items = [], recipes = [], movements = null } = {}) {
  const noop = () => {};
  const context = {
    Date, Number, Math, Map, Set, String, Array, Object, JSON, RegExp, console, items, recipes,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { readyState: 'loading', addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    addEventListener: noop, setTimeout: noop,
  };
  context.window = context;
  if (movements) context.AtlasData = { movements: () => movements };
  vm.createContext(context);
  for (const file of ['atlas-stock-truth.js', 'atlas-calculations.js', 'recipes.js', 'operations.js', 'reports-overview.js']) {
    vm.runInContext(read(`apps/web/assets/js/${file}`), context, { filename: file });
  }
  // Home's shipped stockFacts.
  const home = read('apps/web/assets/js/home.js');
  const body = home.slice(home.indexOf('  function stockFacts()'), home.indexOf('  function recipeFacts()'));
  context.stockFacts = vm.runInContext(`(function () { const items = () => window.items; function number(v, f = 0) { const p = Number(v); return Number.isFinite(p) ? p : f; } ${body}; return stockFacts; })()`, context);
  // Inventory's shipped status pill.
  const inventory = read('apps/web/assets/js/atlas-inventory.js');
  const pill = inventory.slice(inventory.indexOf('  function stockStatus(item) {'), inventory.indexOf('  function statusPill('));
  const ratio = inventory.match(/const ALMOST_OUT_RATIO = ([0-9.]+);/)?.[1];
  assert.ok(ratio, 'atlas-inventory.js still defines ALMOST_OUT_RATIO');
  context.inventoryStatus = vm.runInContext(`(function () { const ALMOST_OUT_RATIO = ${ratio}; const truth = () => window.AtlasStockTruth; function num(v) { if (v === null || v === undefined || v === '') return null; const p = Number(v); return Number.isFinite(p) ? p : null; } ${pill}; return stockStatus; })()`, context);
  return context;
}

function fixture() {
  const truth = browser().AtlasStockTruth;
  const projected = truth.project(ITEMS, BALANCES, [], NOW);
  const context = browser({ items: projected, recipes: RECIPES });
  const backend = () => createBackend({ inventory: ITEMS, balances: BALANCES, movements: MOVEMENTS, recipes: RECIPES, purchaseOrders: [] });
  return { context, projected, server: projectStock(ITEMS, BALANCES, [], NOW), backend };
}

test('one stock status rule, same answer from the browser and the server for every item', () => {
  const { context, projected, server } = fixture();
  const statuses = Object.fromEntries(server.map((item) => [item.name, stockStatus(item)]));
  assert.deepEqual(statuses, { Gin: 'out', Vodka: 'below_par', Syrup: 'out', Lime: 'unknown', Ice: 'unknown', Tonic: 'ok' });
  for (const [index, item] of projected.entries()) {
    assert.equal(context.AtlasStockTruth.stockStatus(item), stockStatus(server[index]), item.name);
    assert.equal(context.AtlasStockTruth.needsOrdering(item), needsOrdering(server[index]), item.name);
  }
  assert.deepEqual(plain(context.AtlasStockTruth.stockCounts(projected)), stockCounts(server));
  assert.deepEqual(stockCounts(server), { active: 5, known: 4, unknown: 1, out: 2, below_par: 1, no_par: 0, ok: 1, needs_ordering: 3 });
  // Precedence edge cases: at par is ok, no par above zero is no_par, a
  // negative verified quantity is out, an empty string is unknown.
  const known = (quantity, par) => ({ freshness_state: 'current', verified_quantity: quantity, quantity, par_level: par });
  for (const [item, want] of [[known(4, 4), 'ok'], [known(3, null), 'no_par'], [known(3, 0), 'no_par'], [known(-1, 4), 'out'], [known(0, null), 'out'], [known('', 4), 'unknown'], [{ freshness_state: 'unknown', verified_quantity: null, par_level: 4 }, 'unknown']]) {
    assert.equal(stockStatus(item), want, JSON.stringify(item));
    assert.equal(browser().AtlasStockTruth.stockStatus(item), want, JSON.stringify(item));
  }
});

test('below par and out agree across Home, Inventory, Reports and Atlas AI', async () => {
  const { context, projected, backend } = fixture();
  const home = context.stockFacts();
  const inventoryKeys = projected.filter((item) => item.active !== false).map((item) => context.inventoryStatus(item).key);
  const inventoryBelow = inventoryKeys.filter((key) => key === 'below_par' || key === 'almost_out').length;
  const inventoryOut = inventoryKeys.filter((key) => key === 'out').length;
  const report = buildStockReport(ITEMS, BALANCES, {}, NOW, []);
  const workspace = applyStockTrustToWorkspace({ kpis: [{ key: 'stock_alerts' }], reports: {} }, report, null);
  const ai = await runTool('inventory.below_par', { category: null, limit: null }, makeCtx('manager', { backend: backend() }).ctx);
  assert.equal(ai.ok, true);

  const surfaces = {
    home: [home.below.length, home.out.length, home.unknown],
    inventory: [inventoryBelow, inventoryOut, inventoryKeys.filter((key) => key === 'not_counted').length],
    reports: [report.summary.below_par, report.summary.out_of_stock, report.summary.needs_current_count],
    ai: [ai.data.counts.below_par, ai.data.counts.out_of_stock, ai.data.counts.active_items - ai.data.counts.current_items],
  };
  for (const [surface, counts] of Object.entries(surfaces)) assert.deepEqual(counts, [1, 2, 1], surface);
  assert.deepEqual(home.below.map((item) => item.name), ['Vodka']);
  assert.deepEqual(home.out.map((item) => item.name).sort(), ['Gin', 'Syrup']);
  assert.deepEqual(ai.data.out_of_stock.map((row) => row.name).sort(), ['Gin', 'Syrup']);
  assert.deepEqual(ai.data.below_par.map((row) => row.name), ['Vodka']);
  // Needs ordering = out + below par, everywhere.
  assert.equal(report.summary.needs_ordering, 3);
  assert.equal(ai.data.counts.needs_ordering, 3);
  assert.equal(workspace.kpis[0].value, 3, 'Reports stock alerts = out + below par');
  assert.equal(context.AtlasOperations.orderSuggestions().length, 3);
  // The Inventory "Below par" chip filters on the canonical status.
  assert.match(read('apps/web/assets/js/atlas-inventory.js'), /state\.status === 'below-par' && truth\(\)\?\.stockStatus\?\.\(item\) !== 'below_par'/);
});

test('stock value and missing cost have one meaning on every surface', async () => {
  const { context, projected, server, backend } = fixture();
  const overview = plain(context.AtlasReportsOverview.inventoryValueParts());
  const browserValue = plain(context.AtlasStockTruth.inventoryValue(projected));
  const domain = inventoryValue(server);
  const report = buildStockReport(ITEMS, BALANCES, {}, NOW, []).summary;
  const ai = await runTool('reports.inventory_value', { category: null }, makeCtx('manager', { backend: backend() }).ctx);

  const expected = { value: null, complete: false, known_value: 8000, active_items: 5, unknown_items: 1, missing_cost_items: 2 };
  assert.deepEqual(domain, expected);
  assert.deepEqual(browserValue, expected);
  assert.deepEqual(overview, { value: null, knownValue: 8000, uncounted: 1, uncosted: 2, items: 5 });
  assert.ok(Number.isNaN(context.AtlasReportsOverview.inventoryValue()));
  assert.deepEqual([report.estimated_value, report.known_value, report.needs_current_count, report.missing_cost], [null, 8000, 1, 2]);
  assert.deepEqual([ai.data.value, ai.data.known_value, ai.data.unknown_items, ai.data.missing_cost_items], [null, 8000, 1, 2]);
  assert.match(ai.summary, /at least 8\.000 kr/);
  // Cost 0 (Syrup) and null (Tonic) are both missing cost.
  const workspace = applyStockTrustToWorkspace({ kpis: [{ key: 'inventory_value' }], reports: {} }, buildStockReport(ITEMS, BALANCES, {}, NOW, []), null);
  assert.deepEqual([workspace.kpis[0].value, workspace.kpis[0].lower_bound, workspace.kpis[0].status], [null, 8000, 'partial']);
});

test('order exposure counts items without a cost instead of adding 0 kr', async () => {
  const { context, server, backend } = fixture();
  const browserExposure = plain(context.AtlasReportsOverview.orderExposure());
  const domainExposure = orderExposure(orderSuggestions(server));
  assert.deepEqual(domainExposure, { items: 3, estimate: 64000, uncosted: 1 });
  assert.deepEqual(browserExposure, domainExposure);
  const syrup = orderSuggestions(server).find((entry) => entry.name === 'Syrup');
  assert.equal(syrup.estimatedCost, null, 'out with no cost: no estimate, never 0 kr');
  const ai = await runTool('purchasing.suggest', { supplier_id: null, include_ordered: null }, makeCtx('manager', { backend: backend() }).ctx);
  assert.equal(ai.data.estimated_total, 64000);
  assert.equal(ai.data.uncosted_items, 1);
  assert.match(ai.summary, /64\.000 kr plus 1 without a cost/);
  assert.ok(ai.evidence.some((entry) => entry.kind === 'missing' && entry.label === 'Cost of Syrup'));
});

test('a reference ingredient (Ice) costs 0 and never makes the recipe cost unknown', async () => {
  const { context, projected, server, backend } = fixture();
  const recipe = RECIPES[0];
  const expectedPerServing = (4000 / 700) * 50;
  const page = context.AtlasCalculations.recipeMetrics(recipe, projected);
  const domain = recipeCost(recipe, server);
  assert.ok(Math.abs(page.financials.perServing - expectedPerServing) < 1e-9);
  assert.equal(page.financials.incomplete, 0);
  assert.equal(page.financials.complete, true);
  assert.deepEqual(plain(domain), plain(page.financials));
  const ice = page.rows.find((row) => row.item?.name === 'Ice');
  assert.equal(ice.cost, 0);
  assert.equal(ice.costReason, REFERENCE_COST_REASON);
  assert.equal(REFERENCE_COST_REASON, 'No cost (reference ingredient)');
  // Status is unchanged by the reference: Vodka is below par → attention.
  assert.equal(recipeStatus(recipe, server).key, context.AtlasRecipes.recipeStatus(recipe).key);
  assert.equal(recipeStatus(recipe, server).key, 'attention');
  // Reports › Overview costing, the Reports recipe report and Atlas AI agree.
  const costing = plain(context.AtlasReportsOverview.recipeCosting());
  assert.equal(costing.complete, 1);
  assert.ok(Math.abs(costing.averageCostPerServe - expectedPerServing) < 1e-9);
  const stock = buildStockReport(ITEMS, BALANCES, {}, NOW, []);
  const row = buildRecipeReport(RECIPES.map(({ recipe_ingredients, ...rest }) => rest), recipe.recipe_ingredients, ITEMS, stock).rows[0];
  assert.ok(Math.abs(row.estimated_cost_per_serving - expectedPerServing) < 1e-9);
  assert.equal(row.missing_costs, 0);
  const ai = await runTool('recipes.cost', { recipe_id: recipe.id, recipe_query: null }, makeCtx('manager', { backend: backend() }).ctx);
  assert.equal(ai.ok, true);
  assert.match(ai.summary, /Gin tonic costs 286 kr per serving/);
  assert.ok(ai.evidence.some((entry) => entry.label === 'Cost of Ice' && entry.value.includes('0 kr')), JSON.stringify(ai.evidence));
});

test('purchasing spend is costed purchase receipts on every surface; waste is not spend', async () => {
  const { backend } = fixture();
  assert.deepEqual(MOVEMENTS.map((movement) => purchaseReceiptAmount(movement)), [10000, 5000, undefined, undefined, null]);
  const domain = purchaseSpend(MOVEMENTS);
  assert.deepEqual(domain, { total: 15000, receipts: 3, costed: 2, uncosted: 1 });
  const context = browser({ movements: MOVEMENTS });
  assert.deepEqual(plain(context.AtlasStockTruth.purchaseSpend(MOVEMENTS)), domain);
  assert.equal(context.AtlasReportsOverview.spend(null, null), 15000);
  const ai = await runTool('reports.spend', { days: 30 }, makeCtx('manager', { backend: backend() }).ctx);
  assert.equal(ai.data.total, 15000);
  assert.equal(ai.data.uncosted_receipts, 1);
  assert.match(ai.summary, /^15\.000 kr of costed stock receipts/);
  // The Reports SQL uses the same rule (scripts/verify_s89_report_truth_preview.sql).
  const sql = read('supabase/migrations/20260928090000_s89_canonical_report_truth.sql');
  assert.match(sql, /in \('restock','purchase','delivery','receive','receipt'\) and coalesce\(movement\.quantity_change,0\)>0/);
  assert.match(sql, /case when coalesce\(movement\.total_cost,0\)>0 then movement\.total_cost when coalesce\(movement\.unit_cost,0\)>0 then movement\.unit_cost\*movement\.quantity_change else null end/);
});

test('money is "3.900 kr" in the browser fallback, the server and Atlas AI', () => {
  const context = browser();
  for (const value of [0, 3900, 1234567.6, -2500]) {
    assert.equal(context.AtlasCalculations.formatIsk(value), formatKr(value));
  }
  assert.equal(formatKr(3900), '3.900 kr');
  assert.equal(formatKr(null), 'unknown');
  const clock = read('apps/web/assets/js/atlas-venue-clock.js');
  assert.match(clock, /replace\(\/\\B\(\?=\(\\d\{3\}\)\+\(\?!\\d\)\)\/g, '\.'\)/);
  assert.doesNotMatch(read('supabase/functions/_shared/ai-tools/result.mjs'), /toLocaleString\("en-US"\)\} ISK/);
  assert.doesNotMatch(read('supabase/functions/atlas-reports/index.ts'), /toLocaleString\("en-US"\)\} ISK/);
});

test('movement row caps are one number on the browser and the server', () => {
  const context = browser();
  assert.equal(context.AtlasStockTruth.MOVEMENT_ROW_LIMIT, MOVEMENT_ROW_LIMIT);
  assert.equal(MOVEMENT_ROW_LIMIT, 5000);
  assert.match(read('apps/web/index.html'), /window\.AtlasStockTruth\?\.MOVEMENT_ROW_LIMIT/);
  assert.match(read('apps/web/index.html'), /\.range\(from, Math\.min\(from \+ pageSize, limit\) - 1\)/);
  assert.match(read('supabase/functions/_shared/ai-tools/services.mjs'), /restPages\("inventory_movements"/);
  assert.match(read('supabase/functions/atlas-reports/index.ts'), /productionMovements\(\s*context,/);
});

test('server business dates and zones come from the venue clock', () => {
  const reports = read('supabase/functions/atlas-reports/index.ts');
  assert.match(reports, /branchRpc\("atlas_settings_venue_clock"/);
  assert.doesNotMatch(reports, /const TIMEZONE = /);
  const chat = read('supabase/functions/atlas-ai/chat.mjs');
  assert.match(chat, /safeRpc\(services, "atlas_settings_venue_clock"/);
  assert.doesNotMatch(read('supabase/functions/atlas-ai/config.mjs'), /ATLAS_VENUE_TIMEZONE"\)/);
  assert.doesNotMatch(read('supabase/functions/_shared/ai-tools/tools-inventory.mjs'), /toISOString\(\)\.slice\(0, 10\)/);
  const sql = read('supabase/migrations/20260928090000_s89_canonical_report_truth.sql');
  assert.match(sql, /venue_zone text := atlas_private\.venue_timezone\(\);/);
  assert.doesNotMatch(sql.replace(/venue_zone='Atlantic\/Reykjavik'/, ''), /at time zone 'Atlantic\/Reykjavik'/);
});
