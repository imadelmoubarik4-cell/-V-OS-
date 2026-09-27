// Atlas Flavor Intelligence: the deterministic engine (flavor-graph.mjs),
// the flavor.* tools and recipes.compose_draft, the recipe.draft proposal
// kind, stock grounding (only verified current stock is ever available),
// staff redaction and the owner's scenarios at tool level.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool, executeProposal, validateCommand, PROPOSAL_KINDS, getTool } from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { clearFlavorSnapshotCache, createServices } from '../../supabase/functions/_shared/ai-tools/services.mjs';
import * as F from '../../supabase/functions/_shared/ai-tools/flavor-graph.mjs';
import { projectStock } from '../../supabase/functions/_shared/atlas-domain.mjs';
import { buildStockReport } from '../../supabase/functions/_shared/stock-provenance.mjs';
import { allKeys, createBackend, ENV, makeCtx, actorFor } from './helpers/ai-tools-fixtures.js';
import {
  createFlavorBackend, flavorBalanceRows, flavorInventoryRows, flavorRecipeRows, flavorSnapshot, INGREDIENT_IDS, ITEM_IDS, NOW, recipeSaveRpc,
} from './helpers/flavor-fixtures.js';

const COST_KEYS = ['cost', 'cost_per_serve', 'margin_at_price', 'cost_per_serving', 'margin_percent', 'line_costs', 'costing', 'estimated_total', 'cost_price'];
// Items that must never be offered as stock.
const NEVER_AVAILABLE = [ITEM_IDS.oatMilk, ITEM_IDS.chocolate, ITEM_IDS.pineappleJuice, ITEM_IDS.disaronno, ITEM_IDS.tropicalMix, ITEM_IDS.limes, ITEM_IDS.rosso, ITEM_IDS.straws];

function world(options = {}) {
  clearFlavorSnapshotCache();
  return createFlavorBackend(options);
}

async function run(role, name, args, backend = world()) {
  const { ctx, audits } = makeCtx(role, { backend });
  const result = await runTool(name, args, ctx);
  return { result, audits, backend };
}

function engine({ balances = flavorBalanceRows(), inventory = flavorInventoryRows(), snapshot = flavorSnapshot() } = {}) {
  const index = F.indexSnapshot(snapshot);
  const items = projectStock(inventory, balances, [], NOW);
  const report = buildStockReport(inventory, balances, {}, NOW, []);
  const stock = F.stockByIngredient(index, items, { reportRows: report.evidence_rows });
  return { index, items, stock, recipes: flavorRecipeRows(), report };
}

const CANDIDATE_ARGS = { type: null, seed: null, exclude_families: null, exclude_ingredients: null, no_new_purchases: null, goal: null, limit: null };

function allCandidateItemIds(result) {
  return result.data.candidates.flatMap((candidate) => candidate.lines.map((line) => line.item_id));
}

// ---------------------------------------------------------------------------
// Engine: index, search, stock
// ---------------------------------------------------------------------------

test('indexSnapshot keeps valid rows only and treats edges as undirected', () => {
  const snapshot = flavorSnapshot();
  snapshot.edges.push({ id: 'bad-1', a_id: INGREDIENT_IDS.lemon, b_id: INGREDIENT_IDS.lemon, relation: 'complement', strength: 1, evidence_type: 'culinary', explanation: 'self' });
  snapshot.edges.push({ id: 'bad-2', a_id: INGREDIENT_IDS.lemon, b_id: INGREDIENT_IDS.mint, relation: 'complement', strength: 1, evidence_type: 'rumour', explanation: 'unknown evidence type' });
  snapshot.links.push({ inventory_item_id: ITEM_IDS.straws, ingredient_id: INGREDIENT_IDS.mint, status: 'rejected', preparation_id: null });
  const index = F.indexSnapshot(snapshot);
  assert.equal(index.ingredients.length, 30);
  assert.ok(!index.edges.some((edge) => edge.id.startsWith('bad-')));
  assert.ok(!index.links.some((link) => link.status === 'rejected'));
  const gin = INGREDIENT_IDS['london-dry-gin'];
  const lemon = INGREDIENT_IDS.lemon;
  assert.ok(F.bestEdge(index, gin, lemon));
  assert.ok(F.bestEdge(index, lemon, gin), 'edges work in both directions');
});

test('search resolves names, aliases (Icelandic too) and misspellings; resolution never guesses', () => {
  const { index } = engine();
  assert.equal(F.searchIngredients(index, 'rabarbari')[0].ingredient.slug, 'rhubarb');
  assert.equal(F.searchIngredients(index, 'passionfruit')[0].ingredient.slug, 'passion-fruit');
  assert.equal(F.searchIngredients(index, 'pasion fruit')[0].ingredient.slug, 'passion-fruit', 'one typo is tolerated');
  assert.equal(F.searchIngredients(index, 'Campari')[0].ingredient.slug, 'red-bitter-aperitivo');
  assert.equal(F.resolveIngredient(index, 'cognac').ingredient.slug, 'cognac');
  const ambiguous = F.resolveIngredient(index, 'liqueur');
  assert.equal(ambiguous.status, 'ambiguous');
  assert.ok(ambiguous.candidates.length >= 3);
  assert.equal(F.resolveIngredient(index, 'unobtainium').status, 'none');
});

test('stock by ingredient: only confirmed links with a verified current count above zero are available', () => {
  const { stock, items } = engine();
  const status = (slug) => F.stockFor(stock, INGREDIENT_IDS[slug]);
  assert.equal(status('london-dry-gin').status, 'available');
  assert.equal(status('london-dry-gin').items[0].verified_quantity, 4, 'verified 4, never the raw 9');
  assert.equal(status('lime').status, 'out', 'verified zero is out, not unknown');
  assert.equal(status('oat-milk').status, 'unknown', 'no baseline → unknown');
  assert.equal(status('oat-milk').items[0].verified_quantity, null, 'raw quantity 12 never becomes stock');
  assert.equal(status('oat-milk').items[0].freshness, 'unverified');
  assert.equal(status('pineapple').status, 'unknown');
  assert.equal(status('pineapple').items[0].freshness, 'stale', 'expired count is stale, not stock');
  assert.equal(status('amaretto').status, 'unknown');
  assert.equal(status('coffee-liqueur').status, 'available', 'owner-confirmed count is current evidence');
  const passion = status('passion-fruit');
  assert.equal(passion.status, 'unknown');
  assert.deepEqual(passion.items, [], 'a needs_review link is never a stock item');
  assert.equal(passion.possible_matches[0].name, 'Tropical Purée Mix');
  assert.equal(passion.possible_matches[0].available, false, 'even with a verified count the possible match is not available');
  assert.equal(status('basil').status, 'not_stocked');
  assert.ok(![...stock.values()].some((entry) => entry.items.some((item) => item.item_id === ITEM_IDS.straws)), 'unmapped items never appear');
  // Raw, unprojected rows (quantity > 0, no verified evidence) are never available.
  const raw = F.stockByIngredient(F.indexSnapshot(flavorSnapshot()), flavorInventoryRows());
  assert.ok(![...raw.values()].some((entry) => entry.status === 'available'));
  assert.ok(items.length > 20);
});

test('the availability predicate is the inventory.current_stock rule (buildStockReport quantity_status current)', () => {
  const { items, report } = engine();
  const rows = new Map(report.evidence_rows.map((row) => [row.id, row]));
  for (const item of items) {
    const row = rows.get(item.id);
    const reportAvailable = row?.quantity_status === 'current' && row.quantity > 0;
    assert.equal(F.isVerifiedAvailable(item), reportAvailable, item.name);
  }
});

// ---------------------------------------------------------------------------
// Engine: pairings, learned co-occurrence, substitutes
// ---------------------------------------------------------------------------

test('atlas_learned edges come from active recipes only, labelled separately from culinary edges', () => {
  const { index, recipes } = engine();
  const learned = F.learnedEdges(index, recipes).edges;
  const pair = (a, b) => learned.find((edge) => [edge.a_id, edge.b_id].sort().join() === [INGREDIENT_IDS[a], INGREDIENT_IDS[b]].sort().join());
  const ginLemon = pair('london-dry-gin', 'lemon');
  assert.equal(ginLemon.evidence_type, 'atlas_learned');
  assert.deepEqual(ginLemon.recipes.map((recipe) => recipe.name), ["Bee's Knees"]);
  assert.ok(pair('red-bitter-aperitivo', 'sweet-vermouth'), 'Negroni pairs');
  assert.ok(!learned.some((edge) => edge.recipes.some((recipe) => recipe.name.includes('old draft'))), 'inactive recipes are not evidence');
  const result = F.pairings(index, 'london-dry-gin', { recipes });
  const lemon = result.neighbours.find((neighbour) => neighbour.ingredient.slug === 'lemon');
  assert.deepEqual(lemon.evidence.map((entry) => entry.evidence_type).sort(), ['atlas_learned', 'culinary']);
  assert.equal(lemon.evidence_type, 'culinary', 'the strongest link leads');
  for (const neighbour of result.neighbours) {
    assert.deepEqual(Object.keys(neighbour.dims).sort(), ['aroma', 'strength', 'taste', 'texture']);
    assert.ok(['recorded', 'profile'].includes(neighbour.dims_basis.aroma));
    assert.notEqual(neighbour.evidence_type, 'scientific');
  }
});

test('pairing filters: in_stock_only, use and evidence', () => {
  const { index, stock, recipes } = engine();
  const inStock = F.pairings(index, 'rhubarb', { stock, recipes, filters: { in_stock_only: true } });
  assert.ok(inStock.neighbours.length > 3);
  assert.ok(inStock.neighbours.every((neighbour) => neighbour.stock_status === 'available'));
  assert.ok(!inStock.neighbours.some((neighbour) => neighbour.ingredient.slug === 'strawberry'), 'not stocked');
  const coffee = F.pairings(index, 'vanilla', { stock, filters: { use: 'coffee' } });
  assert.ok(coffee.neighbours.every((neighbour) => neighbour.ingredient.uses.includes('coffee')));
  const learnedOnly = F.pairings(index, 'london-dry-gin', { recipes, filters: { evidence: ['atlas_learned'] } });
  assert.ok(learnedOnly.neighbours.length && learnedOnly.neighbours.every((neighbour) => neighbour.evidence.every((entry) => entry.evidence_type === 'atlas_learned')));
});

test('substitutes: recorded substitutes first with differences, adjustments and stock', () => {
  const { index, stock } = engine();
  const result = F.substitutes(index, 'passion-fruit', { stock });
  assert.deepEqual(result.substitutes.slice(0, 2).map((row) => row.ingredient.slug), ['mango', 'pineapple']);
  const mango = result.substitutes[0];
  assert.equal(mango.basis, 'recorded');
  assert.equal(mango.stock_status, 'available');
  assert.ok(mango.differences.includes('sweeter') && mango.differences.includes('less sour'));
  assert.ok(mango.adjustments.some((hint) => /citrus/.test(hint)));
  assert.equal(result.substitutes[1].stock_status, 'unknown', 'stale pineapple juice is not in stock');
  const inStockOnly = F.substitutes(index, 'passion-fruit', { stock, in_stock_only: true });
  assert.deepEqual(inStockOnly.substitutes.map((row) => row.ingredient.slug), ['mango']);
});

// ---------------------------------------------------------------------------
// Engine: candidates and compose (grounding)
// ---------------------------------------------------------------------------

test('candidates only use verified items that cover a serve, expose every dimension and no opaque score', () => {
  const { index, stock, items, recipes } = engine();
  const itemIds = new Set(flavorInventoryRows().map((item) => item.id));
  for (const type of ['cocktail', 'mocktail', 'coffee']) {
    const result = F.candidates(index, { stock, items, recipes, type, limit: 10, includeEconomics: true });
    assert.ok(result.candidates.length > 0, type);
    for (const candidate of result.candidates) {
      assert.deepEqual(Object.keys(candidate.scores).sort(), ['economics', 'flavor', 'inventory', 'menu', 'operations']);
      assert.deepEqual(Object.keys(candidate.scores.flavor).sort(), ['balance', 'compatibility', 'texture']);
      assert.deepEqual(Object.keys(candidate.scores.inventory).sort(), ['coverage', 'low_stock_risk', 'use_soon']);
      assert.deepEqual(Object.keys(candidate.scores.economics).sort(), ['cost_per_serve', 'margin_at_price', 'missing', 'price_support']);
      assert.deepEqual(Object.keys(candidate.scores.operations).sort(), ['batching', 'equipment', 'ingredient_count', 'steps']);
      assert.deepEqual(Object.keys(candidate.scores.menu).sort(), ['closest_recipe', 'novelty', 'similarity']);
      assert.ok(candidate.rank.weights && typeof candidate.rank.key === 'number', 'the ordering key comes with its weights');
      for (const line of candidate.lines) {
        assert.ok(itemIds.has(line.item_id), `${candidate.name}: ${line.item_name} is a real item`);
        assert.equal(line.to_buy, false);
        assert.ok(!NEVER_AVAILABLE.includes(line.item_id), `${candidate.name} uses ${line.item_name}`);
        const item = items.find((entry) => entry.id === line.item_id);
        assert.ok(F.isVerifiedAvailable(item));
      }
      assert.equal(candidate.scores.inventory.coverage, 1);
    }
  }
});

test('mocktail and alcohol-free coffee ideas contain no alcohol', () => {
  const { index, stock, items, recipes } = engine();
  const result = F.candidates(index, { stock, items, recipes, type: 'mocktail', limit: 10 });
  for (const candidate of result._full) {
    const draft = F.compose(index, candidate, { items, recipes });
    assert.equal(draft.balance.abv_est, 0, candidate.name);
    assert.equal(draft.checks.find((check) => check.key === 'alcohol_free').ok, true);
  }
});

test('compose: deterministic, realistic spec, never exceeds verified stock for one serve', () => {
  const { index, stock, items, recipes } = engine();
  const result = F.candidates(index, { stock, items, recipes, type: 'cocktail', seed: [INGREDIENT_IDS['london-dry-gin']], limit: 5, includeEconomics: true });
  const first = F.compose(index, result._full[0], { items, recipes, includeEconomics: true });
  const again = F.compose(index, F.candidates(index, { stock, items, recipes, type: 'cocktail', seed: [INGREDIENT_IDS['london-dry-gin']], limit: 5, includeEconomics: true })._full[0], { items, recipes, includeEconomics: true });
  assert.deepEqual(first, again, 'same inputs, same draft');
  assert.ok(first.name && first.glass && first.method.length >= 3);
  assert.deepEqual(first.yield, { quantity: 1, unit: 'serving' });
  assert.ok(first.balance.dilution_pct > 0 && first.balance.abv_est > 0 && first.balance.final_volume_ml > first.balance.volume_ml);
  assert.ok(first.checks.every((check) => check.ok), JSON.stringify(first.checks));
  assert.ok(Number.isFinite(first.costing.cost_per_serve));
  // One line per item (recipe_ingredients is unique per item): a garnish from the juiced fruit is merged.
  for (const candidate of result._full) {
    const draft = F.compose(index, candidate, { items, recipes, includeEconomics: true });
    assert.equal(new Set(draft.lines.map((line) => line.item_id)).size, draft.lines.length, draft.name);
    assert.equal(draft.costing.line_costs.length, draft.lines.length);
  }
  // Cognac verified at 0.07 bottle (49 ml): a 50 ml sour is impossible, a 45 ml highball is not.
  const balances = flavorBalanceRows().map((row) => (row.inventory_item_id === ITEM_IDS.hennessy ? { ...row, verified_quantity: 0.07 } : row));
  const low = engine({ balances });
  const cognac = F.candidates(low.index, { stock: low.stock, items: low.items, recipes: low.recipes, type: 'cocktail', seed: [INGREDIENT_IDS.cognac], limit: 10 });
  assert.ok(cognac.candidates.length > 0);
  for (const candidate of cognac.candidates) {
    const line = candidate.lines.find((entry) => entry.item_id === ITEM_IDS.hennessy);
    assert.ok(line.quantity <= 49, `${candidate.name}: ${line.quantity} ml of 49 ml verified`);
  }
});

test('a garnish cut from the fruit that is also juiced becomes one recipe line', () => {
  const { index, stock, items, recipes } = engine({ balances: flavorBalanceRows().filter((row) => row.inventory_item_id !== ITEM_IDS.lemonJuice) });
  const result = F.candidates(index, { stock, items, recipes, type: 'cocktail', seed: [INGREDIENT_IDS['london-dry-gin']], limit: 5, includeEconomics: true });
  const merged = result._full.map((candidate) => F.compose(index, candidate, { items, recipes, includeEconomics: true }))
    .find((draft) => draft.lines.some((line) => line.role === 'sour, garnish'));
  assert.ok(merged, 'a sour garnished with the juiced lemons');
  const lemons = merged.lines.find((line) => line.item_id === ITEM_IDS.lemons);
  assert.equal(lemons.unit, 'each');
  assert.equal(new Set(merged.lines.map((line) => line.item_id)).size, merged.lines.length);
  const lineTotal = merged.costing.line_costs.reduce((sum, line) => sum + line.cost, 0);
  assert.ok(Math.abs(lineTotal - merged.costing.cost_per_serve) <= 2);
});

test('honest gaps: whole produce and items without a package size are explained, never guessed', () => {
  const inventory = [
    ...flavorInventoryRows().filter((item) => ![ITEM_IDS.rhubarbSyrup, ITEM_IDS.mangoPuree].includes(item.id)),
    { id: ITEM_IDS.rhubarbSyrup, name: 'Fresh Rhubarb Stalks', category: 'Produce', unit: 'kg', size_ml: null, cost_price: 900, par_level: null, quantity: 2, active: true, source_updated_at: '2026-09-01', updated_at: '2026-09-01T10:00:00Z' },
    { id: ITEM_IDS.mangoPuree, name: 'Mango Purée', category: 'Syrups', unit: 'units', size_ml: null, cost_price: 1300, par_level: null, quantity: 2, active: true, source_updated_at: '2026-09-01', updated_at: '2026-09-01T10:00:00Z' },
  ];
  const snapshot = flavorSnapshot();
  snapshot.links = snapshot.links.map((link) => (link.inventory_item_id === ITEM_IDS.rhubarbSyrup ? { ...link, preparation_id: null } : link));
  const { index, stock, items, recipes } = engine({ inventory, snapshot });
  assert.equal(F.stockFor(stock, INGREDIENT_IDS.rhubarb).status, 'available', 'fresh rhubarb is verified stock');
  const result = F.candidates(index, { stock, items, recipes, seed: [INGREDIENT_IDS.rhubarb], limit: 5 });
  assert.deepEqual(result.candidates, [], 'raw stalks by weight never fill a liquid role');
  assert.equal(result.unused_seeds[0].slug, 'rhubarb');
  assert.match(result.unused_seeds[0].reason, /whole produce.*syrup or cordial first/);
  assert.ok(result.unmeasurable.some((item) => item.name === 'Mango Purée' && item.unit === 'units'));
  const mango = F.candidates(index, { stock, items, recipes, seed: [INGREDIENT_IDS.mango], limit: 5 });
  assert.match(mango.unused_seeds[0].reason, /package size is not set/);
});

test('to_buy lines appear only when new purchases are allowed, clearly marked and without an item id', () => {
  const { index, stock, items, recipes } = engine();
  const strict = F.candidates(index, { stock, items, recipes, seed: [INGREDIENT_IDS['passion-fruit']], limit: 5 });
  assert.equal(strict.candidates.length, 0);
  assert.equal(strict.unmet_seeds[0].slug, 'passion-fruit');
  assert.match(strict.unmet_seeds[0].reason, /needs review/);
  const open = F.candidates(index, { stock, items, recipes, seed: [INGREDIENT_IDS['passion-fruit']], noNewPurchases: false, limit: 5 });
  assert.ok(open.candidates.length > 0);
  for (const candidate of open.candidates) {
    const buy = candidate.lines.filter((line) => line.to_buy);
    assert.ok(buy.length >= 1, candidate.name);
    assert.ok(buy.every((line) => line.item_id === null));
    assert.ok(candidate.to_buy.includes('Passion fruit'));
  }
  const draft = F.compose(index, open._full[0], { items, recipes });
  assert.equal(draft.checks.find((check) => check.key === 'verified_stock').ok, false);
});

test('candidate keys are re-validated against current stock and links (forged or stale keys are refused)', () => {
  const { index, stock, items, recipes } = engine();
  const [candidate] = F.candidates(index, { stock, items, recipes, type: 'cocktail', limit: 1 }).candidates;
  assert.equal(F.candidateFromKey(index, candidate.key, { stock, items, recipes }).key, candidate.key);
  // The same key after the item lost its verified count.
  const firstItem = candidate.lines[0].item_id;
  const later = engine({ balances: flavorBalanceRows().filter((row) => row.inventory_item_id !== firstItem) });
  assert.throws(() => F.candidateFromKey(later.index, candidate.key, { stock: later.stock, items: later.items, recipes }), (error) => error.code === 'conflict');
  // A forged key: paper straws as gin, the needs-review purée as passion fruit, an unknown template.
  const forged = `v1|highball|base=london-dry-gin~-@${ITEM_IDS.straws}|top=soda-water~-@${ITEM_IDS.soda}`;
  assert.throws(() => F.candidateFromKey(index, forged, { stock, items, recipes }), (error) => error.code === 'conflict');
  const review = `v1|zero_sour|fruit=passion-fruit~puree@${ITEM_IDS.tropicalMix}|sour=lemon~juice@${ITEM_IDS.lemonJuice}|sweet=sugar-syrup~-@${ITEM_IDS.sugarSyrup}`;
  assert.throws(() => F.candidateFromKey(index, review, { stock, items, recipes }), (error) => error.code === 'conflict');
  assert.throws(() => F.candidateFromKey(index, 'v1|tiki|base=cognac~-@buy', { stock, items, recipes }), (error) => error.code === 'invalid_arguments');
  assert.throws(() => F.candidateFromKey(index, `v1|highball|base=cognac~-@buy|top=soda-water~-@${ITEM_IDS.soda}`, { stock, items, recipes }), (error) => error.code === 'conflict', 'to buy needs no_new_purchases false');
});

test('candidate keys must have the engine\'s shape: each role once, one garnish of the template\'s families, and a strong enough pairing', () => {
  const { index, stock, items, recipes } = engine();
  // Every key the engine offers still rebuilds (all drink types, all goals).
  for (const type of ['cocktail', 'mocktail', 'coffee']) {
    for (const goal of ['balanced', 'use_stock', 'novel', 'simple']) {
      for (const candidate of F.candidates(index, { stock, items, recipes, type, goal, limit: 20 }).candidates.filter((entry) => entry.composable)) {
        assert.equal(F.candidateFromKey(index, candidate.key, { stock, items, recipes }).key, candidate.key, candidate.key);
      }
    }
  }
  const invalid = (key) => assert.throws(() => F.candidateFromKey(index, key, { stock, items, recipes }), (error) => error.code === 'invalid_arguments', key);
  // Three spirits and two sweeteners in one Collins (review finding M1).
  invalid(`v1|collins|base=london-dry-gin~-@${ITEM_IDS.tanqueray}|base=cognac~-@${ITEM_IDS.hennessy}|base=vodka~-@${ITEM_IDS.absolut}|sour=lemon~juice@${ITEM_IDS.lemonJuice}|sweet=sugar-syrup~-@${ITEM_IDS.sugarSyrup}|sweet=elderflower-liqueur~-@${ITEM_IDS.stGermain}|top=soda-water~-@${ITEM_IDS.soda}`);
  // Two garnishes.
  invalid(`v1|highball|base=london-dry-gin~-@${ITEM_IDS.tanqueray}|top=soda-water~-@${ITEM_IDS.soda}|garnish=mint~-@${ITEM_IDS.mint}|garnish=lemon~-@${ITEM_IDS.lemons}`);
});

// ---------------------------------------------------------------------------
// Tools through the gateway
// ---------------------------------------------------------------------------

test('registry: flavour tools are read tools for every role; composing is a manager draft of kind recipe.draft', () => {
  for (const name of ['flavor.search_ingredients', 'flavor.ingredient_profile', 'flavor.pairings', 'flavor.pairings_from_stock', 'flavor.substitutes', 'flavor.candidates', 'flavor.explain_pair', 'flavor.use_soon']) {
    const tool = getTool(name);
    assert.equal(tool.level, 'read', name);
    assert.deepEqual([...tool.roles], ['admin', 'manager', 'bartender', 'viewer']);
    assert.equal(tool.specialist, 'recipes');
  }
  const compose = getTool('recipes.compose_draft');
  assert.equal(compose.level, 'draft');
  assert.deepEqual([...compose.roles], ['admin', 'manager']);
  assert.equal(compose.proposalKind, 'recipe.draft');
  assert.deepEqual(PROPOSAL_KINDS['recipe.draft'], { roles: ['admin', 'manager'], executable: true, subject: 'recipe' });
});

test('flavour tools report stock only from verified evidence, with one audit per call', async () => {
  const { result, audits } = await run('bartender', 'flavor.search_ingredients', { query: 'passionfruit', use: null, limit: null });
  assert.equal(result.ok, true);
  assert.equal(result.data.results[0].stock_status, 'unknown');
  assert.ok(result.evidence.some((entry) => entry.kind === 'interpretation' && /needs review/.test(entry.value)));
  assert.ok(!result.evidence.some((entry) => entry.kind === 'fact'), 'a possible match is never a fact');
  assert.equal(result.unknown.count, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_role, 'bartender');
});

test('the snapshot is cached for five minutes per project and the role gate still applies', async () => {
  const backend = world();
  await run('manager', 'flavor.use_soon', { limit: null }, backend);
  await run('bartender', 'flavor.search_ingredients', { query: 'gin', use: null, limit: null }, backend);
  assert.equal(backend.calls.filter((call) => call.name === 'atlas_flavor_snapshot').length, 1);
  const inactive = makeCtx('viewer', { backend, actor: actorFor('viewer', { active: false }) }).ctx;
  const denied = await runTool('flavor.search_ingredients', { query: 'gin', use: null, limit: null }, inactive);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'forbidden');
  const services = createServices({ fetch: backend.fetch, env: ENV, actor: actorFor('viewer', { active: false }), now: NOW });
  await assert.rejects(services.flavorSnapshot(), (error) => error.status === 403);
});

test('an unavailable flavour library fails plainly and never guesses', async () => {
  const backend = world({ snapshotError: { __status: 404, message: 'rpc atlas_flavor_snapshot missing' } });
  const { result } = await run('manager', 'flavor.pairings', { ingredient: 'gin', preparation: null, use: null, in_stock_only: null, evidence: null, limit: null }, backend);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unavailable');
  assert.match(result.error.message, /flavour library is not available/);
});

test('ambiguous ingredient names ask which one', async () => {
  const { result } = await run('manager', 'flavor.pairings', { ingredient: 'liqueur', preparation: null, use: null, in_stock_only: null, evidence: null, limit: null });
  assert.equal(result.ok, true);
  assert.equal(result.data.needs_clarification[0].status, 'ambiguous');
  assert.match(result.summary, /Ask which one/);
});

test('explain_pair separates recorded evidence from calculated overlap', async () => {
  const recorded = (await run('viewer', 'flavor.explain_pair', { a: 'gin', b: 'tonic' })).result;
  assert.equal(recorded.data.recorded, true);
  assert.ok(recorded.evidence.some((entry) => entry.kind === 'interpretation' && /Pairing \(culinary\)/.test(entry.label)));
  const none = (await run('viewer', 'flavor.explain_pair', { a: 'gin', b: 'mango' })).result;
  assert.equal(none.data.recorded, false);
  assert.match(none.summary, /No recorded pairing/);
  assert.ok(none.evidence.some((entry) => entry.kind === 'missing'));
  assert.ok(none.evidence.some((entry) => entry.kind === 'calculation' && /Aroma overlap/.test(entry.label)));
  assert.ok(!JSON.stringify(none).includes('scientific'));
});

test('staff never receive cost or margin from ideas, pairings or profiles', async () => {
  for (const role of ['bartender', 'viewer']) {
    const backend = world();
    const ideas = (await run(role, 'flavor.candidates', { ...CANDIDATE_ARGS, type: 'cocktail', goal: 'high_margin', limit: 5 }, backend)).result;
    assert.equal(ideas.ok, true);
    assert.equal(ideas.data.goal, 'balanced', 'margin ranking needs manager data');
    assert.match(ideas.summary, /for managers/);
    const keys = allKeys({ data: ideas.data, evidence: ideas.evidence });
    for (const key of COST_KEYS) assert.ok(!keys.has(key), `${role}: ${key}`);
    assert.ok(ideas.data.candidates.every((candidate) => candidate.scores.economics === null));
    assert.doesNotMatch(JSON.stringify(ideas.evidence), /\d kr\b|margin|cost/i);
    const profile = (await run(role, 'flavor.ingredient_profile', { ingredient: 'gin' }, backend)).result;
    assert.ok(!allKeys(profile.data).has('cost_price'));
  }
  const manager = (await run('manager', 'flavor.candidates', { ...CANDIDATE_ARGS, type: 'cocktail', goal: 'high_margin', limit: 3 })).result;
  assert.equal(manager.data.goal, 'high_margin');
  assert.ok(manager.data.candidates.every((candidate) => Number.isFinite(candidate.scores.economics.cost_per_serve)));
  assert.ok(manager.evidence.some((entry) => entry.kind === 'calculation' && /cost per serve/.test(entry.label)));
});

test('compose_draft: managers only; the proposal saves a new inactive recipe from real items', async () => {
  const backend = world();
  const ideas = (await run('manager', 'flavor.candidates', { ...CANDIDATE_ARGS, type: 'cocktail', seed: ['cognac'], limit: 3 }, backend)).result;
  const key = ideas.data.candidates[0].compose_request.candidate_key;
  for (const role of ['bartender', 'viewer']) {
    const denied = (await run(role, 'recipes.compose_draft', { candidate_key: key, type: null, no_new_purchases: null, name: null }, backend)).result;
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'forbidden');
  }
  const { result, audits } = await run('manager', 'recipes.compose_draft', { candidate_key: key, type: null, no_new_purchases: null, name: null }, backend);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(audits[0].proposal_kind, 'recipe.draft');
  const proposal = result.proposal;
  assert.equal(proposal.kind, 'recipe.draft');
  assert.deepEqual(proposal.required_roles, ['admin', 'manager']);
  assert.equal(proposal.command.recipe.active, false);
  assert.equal(proposal.command.recipe.show_on_menu, false);
  assert.equal(proposal.command.recipe.menu_price, null);
  const inventoryIds = new Set(flavorInventoryRows().map((item) => item.id));
  for (const line of proposal.command.ingredients) {
    assert.ok(inventoryIds.has(line.item_id), `${line.item_name} is an Atlas item`);
    assert.ok(!NEVER_AVAILABLE.includes(line.item_id));
  }
  assert.match(proposal.preview.will_change[0], /Recipes › Drafts \(inactive\)/);
  assert.ok(proposal.preview.will_not_change.some((text) => /not on the menu/.test(text)));
  assert.ok(proposal.preview.will_not_change.some((text) => /Stock, items, costs, suppliers and purchasing do not change/.test(text)));
  assert.match(proposal.preview.totals.estimated_total_label, /kr per serve/);
  assert.ok(Math.abs(proposal.preview.totals.estimated_total - result.data.costing.cost_per_serve) <= 2, 'the card total is the draft cost (line rounding only)');
  assert.ok(result.evidence.some((entry) => entry.kind === 'fact' && /Current stock of Hennessy/.test(entry.label)));
  assert.deepEqual(backend.writes, [], 'nothing is written before approval');
  assert.ok(!backend.calls.some((call) => call.name === 'atlas_save_recipe'));
});

test('recipe.draft execution: approver JWT, forced inactive, record link, name conflicts and roles', async () => {
  const backend = world();
  const ideas = (await run('manager', 'flavor.candidates', { ...CANDIDATE_ARGS, type: 'mocktail', limit: 1 }, backend)).result;
  const drafted = (await run('manager', 'recipes.compose_draft', { candidate_key: ideas.data.candidates[0].compose_request.candidate_key, type: null, no_new_purchases: null, name: null }, backend)).result;
  const command = structuredClone(drafted.proposal.command);
  command.recipe.active = true; // a tampered store still saves an inactive draft
  command.recipe.show_on_menu = true;
  const denied = await executeProposal('recipe.draft', command, makeCtx('bartender', { backend }).ctx);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'forbidden');
  const saved = await executeProposal('recipe.draft', command, makeCtx('manager', { backend }).ctx);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const write = backend.writes.find((entry) => entry.name === 'atlas_save_recipe');
  assert.equal(write.args.p_recipe_id, null, 'always a new recipe');
  assert.equal(write.args.p_recipe.active, false);
  assert.equal(write.args.p_recipe.show_on_menu, false);
  const rpcCall = backend.calls.find((call) => call.name === 'atlas_save_recipe');
  assert.equal(rpcCall.kind, 'userRpc');
  assert.equal(rpcCall.role, 'manager', 'runs with the approver JWT');
  assert.equal(saved.result.records[0].type, 'recipe');
  assert.equal(saved.result.records[0].route, `#recipes/${saved.result.data.recipe_id}`);
  // The same name again: refused with a clear message.
  const again = await executeProposal('recipe.draft', command, makeCtx('manager', { backend }).ctx);
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'name_taken');
  assert.match(again.error.message, /already exists/);
  // The database unique constraint path (23505 → 409) maps the same way.
  const constraint = createBackend({ recipes: [], userRpcs: { atlas_save_recipe: () => ({ __status: 409, code: '23505', message: 'duplicate key value violates unique constraint "recipes_name_key"' }) } });
  const raced = await executeProposal('recipe.draft', command, makeCtx('manager', { backend: constraint }).ctx);
  assert.equal(raced.error.code, 'name_taken');
});

test('recipe.draft commands are strictly validated', () => {
  const base = {
    client_request_id: '00000000-0000-4000-9000-000000000001',
    recipe: { name: 'X', type: 'signature-cocktail', glassware: null, garnish: null, method: '1. Stir.', notes: null, yield_quantity: 1, yield_unit: 'serving', menu_price: null, active: false, show_on_menu: false },
    ingredients: [{ item_id: ITEM_IDS.tanqueray, item_name: 'Tanqueray Gin', quantity: 50, unit: 'ml', role: 'base', to_buy: false }],
    source: { candidate_key: 'v1|x', engine_version: '1.0.0', snapshot_version: null },
  };
  assert.equal(validateCommand('recipe.draft', base).ok, true);
  const toBuyWithId = structuredClone(base);
  toBuyWithId.ingredients[0].to_buy = true;
  assert.match(validateCommand('recipe.draft', toBuyWithId).errors.join(), /must not carry an item id/);
  const stockedWithoutId = structuredClone(base);
  stockedWithoutId.ingredients[0].item_id = null;
  assert.match(validateCommand('recipe.draft', stockedWithoutId).errors.join(), /needs an Atlas item id/);
  const repeated = structuredClone(base);
  repeated.ingredients.push({ ...base.ingredients[0] });
  assert.match(validateCommand('recipe.draft', repeated).errors.join(), /repeats an ingredient/);
  const padded = { ...structuredClone(base), recipe_id: ITEM_IDS.tanqueray };
  assert.match(validateCommand('recipe.draft', padded).errors.join(), /not an accepted argument/);
  const onMenu = structuredClone(base);
  onMenu.recipe.type = 'Food';
  assert.equal(validateCommand('recipe.draft', onMenu).ok, false);
});

// ---------------------------------------------------------------------------
// The owner's scenarios (tool level)
// ---------------------------------------------------------------------------

test('scenario: "What can I make with rhubarb?"', async () => {
  const { result } = await run('manager', 'flavor.candidates', { ...CANDIDATE_ARGS, seed: ['rhubarb'], limit: 5 });
  assert.equal(result.ok, true);
  assert.ok(result.data.candidates.length >= 2);
  for (const candidate of result.data.candidates) {
    assert.ok(candidate.ingredients.some((part) => part.slug === 'rhubarb'), candidate.name);
    assert.ok(candidate.lines.some((line) => line.item_id === ITEM_IDS.rhubarbSyrup), 'the verified house rhubarb syrup');
  }
  assert.match(result.summary, /Rhubarb/);
  assert.match(result.summary, /from verified current stock only/);
  assert.ok(result.evidence.some((entry) => entry.kind === 'interpretation' && /rhubarb|Rhubarb/.test(entry.value)));
});

test('scenario: "Use only ingredients we currently have"', async () => {
  const { result } = await run('manager', 'flavor.candidates', { ...CANDIDATE_ARGS, no_new_purchases: true, limit: 8 });
  assert.equal(result.ok, true);
  const ids = allCandidateItemIds(result);
  assert.ok(ids.length > 0);
  assert.ok(ids.every((id) => id && !NEVER_AVAILABLE.includes(id)));
  assert.ok(result.data.candidates.every((candidate) => candidate.to_buy.length === 0 && candidate.scores.inventory.coverage === 1));
  const pairs = (await run('manager', 'flavor.pairings_from_stock', { ingredient: null, use: null, limit: 40 })).result;
  const unavailable = ['oat-milk', 'dark-chocolate', 'pineapple', 'amaretto', 'passion-fruit', 'lime', 'sweet-vermouth', 'basil', 'strawberry'];
  assert.ok(pairs.data.pairs.every((pair) => !unavailable.includes(pair.a.slug) && !unavailable.includes(pair.b.slug)));
});

test('scenario: "Give me three cocktail ideas with no new purchases"', async () => {
  const { result } = await run('manager', 'flavor.candidates', { ...CANDIDATE_ARGS, type: 'cocktail', no_new_purchases: true, limit: 3 });
  assert.equal(result.data.candidates.length, 3);
  assert.ok(result.data.candidates.every((candidate) => candidate.type === 'cocktail' && candidate.to_buy.length === 0));
  assert.equal(new Set(result.data.candidates.map((candidate) => candidate.name)).size, 3, 'three different ideas');
  assert.ok(result.data.candidates.every((candidate) => candidate.compose_request.no_new_purchases === true));
});

test('scenario: "What can replace passion fruit?"', async () => {
  const { result } = await run('manager', 'flavor.substitutes', { ingredient: 'passion fruit', in_stock_only: null, limit: null });
  assert.equal(result.ok, true);
  assert.equal(result.data.substitutes[0].ingredient.slug, 'mango');
  assert.equal(result.data.substitutes[0].in_stock, true);
  assert.match(result.summary, /Passion fruit is stock unknown/);
  assert.match(result.summary, /Tropical Purée Mix needs review; not counted/);
  assert.match(result.summary, /Mango \(in stock; sweeter, less sour\)/);
  assert.ok(result.evidence.some((entry) => entry.kind === 'fact' && entry.label === 'Current stock of Mango Purée'));
  assert.ok(result.evidence.some((entry) => entry.kind === 'missing' && entry.label === 'Current stock of Pineapple Juice'));
});

test('scenario: "Create something using cognac but no citrus"', async () => {
  const { result } = await run('manager', 'flavor.candidates', { ...CANDIDATE_ARGS, seed: ['cognac'], exclude_families: ['citrus'], limit: 5 });
  assert.equal(result.ok, true);
  assert.ok(result.data.candidates.length >= 2);
  for (const candidate of result.data.candidates) {
    assert.ok(candidate.ingredients.some((part) => part.slug === 'cognac'));
    assert.ok(!candidate.ingredients.some((part) => ['lemon', 'lime', 'orange-liqueur'].includes(part.slug)), `${candidate.name} has citrus`);
    assert.ok(!candidate.lines.some((line) => [ITEM_IDS.lemons, ITEM_IDS.lemonJuice, ITEM_IDS.cointreau].includes(line.item_id)));
  }
  const draft = (await run('manager', 'recipes.compose_draft', { candidate_key: result.data.candidates[0].compose_request.candidate_key, type: null, no_new_purchases: null, name: null })).result;
  assert.equal(draft.ok, true);
  assert.doesNotMatch(draft.proposal.command.recipe.method + draft.proposal.command.recipe.garnish, /lemon|lime|orange/i);
});

test('scenario: "Create a low-cost cocktail with strong margin"', async () => {
  const { result } = await run('manager', 'flavor.candidates', { ...CANDIDATE_ARGS, type: 'cocktail', goal: 'high_margin', limit: 3 });
  assert.equal(result.data.goal, 'high_margin');
  const margins = result.data.candidates.map((candidate) => candidate.scores.economics.margin_at_price);
  assert.ok(margins.every((margin) => Number.isFinite(margin) && margin > 60), JSON.stringify(margins));
  const basis = result.data.candidates[0].scores.economics.price_support;
  assert.equal(basis.reference_price, 2900, "median of 2400, 2800, 2900, 3100, 3200");
  assert.match(basis.basis, /median menu price of 5 active cocktail recipes/);
  const cheap = (await run('manager', 'flavor.candidates', { ...CANDIDATE_ARGS, type: 'cocktail', goal: 'low_cost', limit: 10 })).result;
  const costs = cheap.data.candidates.map((candidate) => candidate.scores.economics.cost_per_serve);
  assert.ok(costs.every(Number.isFinite));
  assert.ok(costs[0] <= Math.max(...costs));
  const draft = (await run('manager', 'recipes.compose_draft', { candidate_key: result.data.candidates[0].compose_request.candidate_key, type: null, no_new_purchases: null, name: null })).result;
  assert.ok(draft.evidence.some((entry) => entry.kind === 'calculation' && /theoretical margin/.test(entry.label)));
  assert.equal(draft.proposal.command.recipe.menu_price, null, 'Atlas never sets a price');
});

test('scenario: "What can we make from ingredients we should use soon?" is answered honestly', async () => {
  const { result } = await run('manager', 'flavor.use_soon', { limit: null });
  assert.equal(result.ok, true);
  assert.equal(result.data.freshness_supported, false);
  assert.match(result.summary, /does not record expiry, opening dates or shelf life/);
  assert.ok(result.evidence.some((entry) => entry.kind === 'missing' && /Expiry/.test(entry.label)));
  assert.deepEqual(result.data.overstock.map((row) => row.item_name), ['Fever-Tree Indian Tonic 200 ml'], 'only verified count ≥ 2 × par');
  assert.deepEqual(result.data.seed_ingredients, ['tonic-water']);
  assert.ok(result.unknown.count > 0, 'items without par are disclosed');
  const ideas = (await run('manager', 'flavor.candidates', { ...CANDIDATE_ARGS, seed: result.data.seed_ingredients, limit: 3 })).result;
  assert.ok(ideas.data.candidates.length > 0);
  assert.ok(ideas.data.candidates.every((candidate) => candidate.scores.inventory.use_soon.overstock_lines >= 1));
});

test('owner rule: once a verified count expires with no owner-confirmed quantity the item is unknown, never zero and never available', () => {
  // The same rows, read after every fixture count has expired (2026-09-29T10:00Z).
  const later = '2026-09-30T12:00:00Z';
  const inventory = flavorInventoryRows();
  const balances = flavorBalanceRows();
  const index = F.indexSnapshot(flavorSnapshot());
  const items = projectStock(inventory, balances, [], later);
  const report = buildStockReport(inventory, balances, {}, later, []);
  const stock = F.stockByIngredient(index, items, { reportRows: report.evidence_rows });
  const status = (slug) => F.stockFor(stock, INGREDIENT_IDS[slug]);
  for (const slug of ['london-dry-gin', 'cognac', 'rhubarb', 'lime', 'mango']) {
    const entry = status(slug);
    assert.equal(entry.status, 'unknown', `${slug}: an expired count is unknown`);
    for (const item of entry.items) {
      assert.equal(item.verified_quantity, null, `${slug}: no quantity is carried past expiry (not the raw one, not zero)`);
      assert.equal(F.isVerifiedAvailable(items.find((row) => row.id === item.item_id)), false);
    }
  }
  assert.equal(status('coffee-liqueur').status, 'available', 'a valid owner-confirmed quantity is still current evidence');
  const available = items.filter((item) => F.isVerifiedAvailable(item)).map((item) => item.id);
  assert.deepEqual(available, [ITEM_IDS.kahlua], 'only the owner-confirmed item remains available');
});

test('drafts are saved with an existing Recipes category slug and a name within 120 characters', () => {
  const { index, stock, items, recipes } = engine();
  const expected = { cocktail: 'signature-cocktail', mocktail: 'mocktail', coffee: 'coffee' };
  for (const type of Object.keys(expected)) {
    const [candidate] = F.candidates(index, { stock, items, recipes, type, limit: 5 })._full.filter((entry) => entry.composable !== false);
    if (!candidate) continue;
    assert.equal(F.compose(index, candidate, { items, recipes }).type, expected[type], type);
    assert.ok(PROPOSAL_KINDS['recipe.draft'], 'recipe.draft kind exists');
  }
  const [candidate] = F.candidates(index, { stock, items, recipes, type: 'cocktail', limit: 1 })._full;
  const long = 'A'.repeat(120);
  const first = F.compose(index, candidate, { items, recipes, name: long });
  assert.equal(first.name, long);
  const renamed = F.compose(index, candidate, { items, recipes: [...recipes, { name: long }], name: long });
  assert.ok(renamed.name.length <= 120, 'the suffix never pushes the name past 120 characters');
  assert.match(renamed.name, / No\. 2$/);
});
